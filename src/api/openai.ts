/**
 * OpenAI-compatible surface.
 *
 * THE SHAPE OF THE CONTRACT, and why it is simpler than it looks. Every completion is one authenticated POST
 * to a configured endpoint. There is no proof-of-work challenge to solve, no session token that expires, and
 * no challenge solution that can only be used once — so there is no 428 "solve this first" dance, no
 * degradation ladder, and no reason for a caller to do anything but send a request.
 *
 * CONTINUITY IS THE CALLER'S JOB, ASSISTED BY `session_key`. An OpenAI-compatible endpoint is stateless: the
 * model only knows what is in the request. Passing `session_key` makes the Worker remember the conversation
 * for that key — it resends the stored history with every request and appends the reply afterwards — so a
 * caller only needs to remember its own identifier, exactly as a DeepSeek client once only needed a session id.
 */

import type { Env } from '../types';
import { writeCallLog } from '../db/store';
import { providerContext, completeExternalStream, failoverNote, type AttemptRecord } from '../providers/complete';
import type { ExternalMessage } from '../providers/openai-compat';
import { appendExchange, loadHistory, clearHistory } from '../providers/history';
import { resolveModel } from '../providers/config';
import { parseModes } from '../modes';
import { dayKey, sessionTimeZone } from '../qq/session';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string | unknown;
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /**
   * Ask the Worker to manage the conversation for this caller, keyed by this string.
   *
   * The Worker stores the message history for the key, resends it with every request, and appends the reply
   * afterwards — so a client only needs to remember its own identifier. A caller that sends its own full
   * history omits this and keeps control.
   */
  session_key?: string;
  /**
   * Keep this conversation's history across day boundaries.
   *
   * The daily reset exists so a chat does not carry yesterday's context forever. A thread someone is
   * deliberately building on is the opposite case, and pinning is how the console says so.
   */
  pinned?: boolean;
  /** Enable reasoning for this turn, where the provider supports it. */
  thinking?: boolean;
  /** Enable web search for this turn, where the provider supports it. */
  search?: boolean;
}

export type Origin = 'access_key' | 'qq' | 'workbench';

/** Flatten OpenAI's message array into one prompt string. Used for token accounting only. */
export function flattenMessages(messages: OpenAIMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (!text) continue;
    parts.push(text);
  }
  return parts.join('\n\n');
}

/** Rough token estimate. Providers report real usage only on non-stream responses, if at all. */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export interface HandlerDeps {
  env: Env;
  origin: Origin;
  originRef: string | null;
  /**
   * Skip writing a call_log row.
   *
   * Set by the QQ webhook, which records the whole event round trip itself. Without this, every QQ message
   * produced TWO rows — a bare `{"model":…,"messages":[…]}` row from here and the annotated one from the
   * webhook — which made the audit view look like each message was being delivered twice.
   */
  skipLog?: boolean;
  /** Overrides for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Map OpenAI's message array onto the provider-neutral shape, PRESERVING ROLES.
 *
 * This is deliberately not a flatten: some providers treat a system message as elevated instructions and the
 * same words inside a user turn as mere context. An unrecognised role is sent as `user`, which is the safe
 * reading — more likely a client extension than an instruction with elevated trust.
 */
export function toExternalMessages(messages: OpenAIMessage[]): ExternalMessage[] {
  const out: ExternalMessage[] = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (!text) continue;
    const role: ExternalMessage['role'] = m.role === 'system' || m.role === 'assistant' ? m.role : 'user';
    out.push({ role, content: text });
  }
  return out;
}

/**
 * Handle POST /v1/chat/completions.
 *
 * Logging is deliberately in a `finally`-style path so a failed call is still recorded: the audit view is most
 * useful exactly when something broke.
 */
export async function handleChatCompletion(
  request: ChatCompletionRequest,
  deps: HandlerDeps,
): Promise<Response> {
  const started = Date.now();
  const model = request.model || '';
  const messages = Array.isArray(request.messages) ? request.messages : [];

  // Mode directives are stripped from the text before the messages are built, so the model is never asked to
  // answer the word "/think".
  const directive = parseModes(typeof messages[0]?.content === 'string' ? messages[0].content : '', {});
  const effectiveMessages =
    directive.directives.length > 0 && typeof messages[0]?.content === 'string'
      ? [{ ...messages[0], content: directive.prompt }, ...messages.slice(1)]
      : messages;
  const prompt = flattenMessages(effectiveMessages);

  const providerCtx = await providerContext(deps.env);
  const endpointModel = providerCtx.endpoints[0]?.model ?? '';
  const effectiveModel = resolveModel(model, endpointModel);
  const loggedModel = `${providerCtx.config.kind}:${effectiveModel}`;

  // Failover bookkeeping, recorded on the row so a fallback is visible rather than silent.
  let attempts: AttemptRecord[] = [];
  let endpointLabel: string | null = null;

  const log = (status: number, response: unknown, error: string | null, extra?: { model?: string }) => {
    if (deps.skipLog) return Promise.resolve(null);
    // A failover is appended to the row's `error` column, which is the only free-text field and the one an
    // operator reads when asking "why was this slow / why did the model change". Without it a fallback is
    // completely invisible: the row looks like an ordinary success from a different model.
    const note = attempts.length > 0 ? failoverNote(attempts) : null;
    const combined = [error ?? null, note].filter(Boolean).join(' · ') || null;

    return writeCallLog(deps.env.DB, {
      origin: deps.origin,
      originRef: deps.originRef,
      model: extra?.model ?? (endpointLabel ? `${endpointLabel}:${effectiveModel}` : loggedModel),
      promptTokens: estimateTokens(prompt),
      completionTokens:
        response && typeof response === 'object' && 'usage' in response
          ? ((response as { usage: { completion_tokens: number } }).usage.completion_tokens ?? null)
          : null,
      latencyMs: Date.now() - started,
      status,
      error: combined,
      // The provider, the model, and every endpoint attempt are recorded alongside the original request, so
      // the row answers "where did this go, and what did it try" without reconstructing the settings later.
      requestBody: {
        ...request,
        provider: providerCtx.config.kind,
        resolvedModel: effectiveModel,
        ...(attempts.length > 0 ? { attempts } : {}),
      },
      responseBody: response,
    });
  };

  if (!prompt) {
    const body = { error: { message: 'messages must contain at least one non-empty content', type: 'invalid_request_error' } };
    await log(400, body, 'empty prompt');
    return Response.json(body, { status: 400 });
  }

  if (providerCtx.endpoints.length === 0) {
    // Distinguished from "no key" on purpose: an empty list means nothing was ever configured, while a listed
    // endpoint without a key means the URL is set and only the credential is missing. They need different fixes.
    const body = {
      error: {
        message:
          '没有配置可用的端点。请在 /admin 的设置页添加端点并填写 API Key，或设置 OPENAI_API_KEY secret。',
        type: 'configuration_error',
      },
    };
    await log(503, body, 'no provider endpoints');
    return Response.json(body, { status: 503 });
  }

  /**
   * Conversation history, when the caller asked the Worker to manage it.
   *
   * Loaded BEFORE the request is built so the provider receives the whole conversation, and extended AFTER so
   * the next call continues it. A caller that sends its own history omits `session_key` and is untouched.
   */
  const managed = Boolean(request.session_key);
  const tz = sessionTimeZone(deps.env);
  // A pinned conversation uses a CONSTANT day key, so the reset check below never trips. Storing the real day
  // and skipping the check would look equivalent until the code is read; a constant key makes "this never
  // resets" a property of the stored data.
  const today = request.pinned ? 'pinned' : dayKey(Date.now(), tz);
  let historyLoaded: { role: ExternalMessage['role']; content: string }[] = [];

  if (managed) {
    const history = await loadHistory(deps.env, request.session_key!);
    // A new day is a new conversation: yesterday's context would contradict the reset the session module just
    // performed, and the model answering "as if" yesterday happened would be worse than starting clean.
    if (history.day !== today) await clearHistory(deps.env, request.session_key!);
    else historyLoaded = history.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Answer through the configured provider, with failover across every enabled endpoint.
   *
   * This is the seam that keeps the streaming and non-streaming branches below identical, so neither has to
   * know which endpoint produced the text.
   */
  const answerOnce = async (onDelta: (text: string) => void) => {
    // The endpoint's own history is NOT resent when the caller manages the conversation itself: prepending
    // stored turns to a caller-provided history would duplicate them.
    const base = managed ? historyLoaded : [];
    const result = await completeExternalStream(
      providerCtx,
      {
        model: resolveModel(model, endpointModel),
        messages: [...base, ...toExternalMessages(effectiveMessages)],
        onDelta,
      },
      deps.fetchImpl ?? fetch,
    );
    attempts = result.attempts;
    endpointLabel = result.endpointLabel;
    return result.text;
  };

  // Streaming: pass deltas through as OpenAI chunks while accumulating for the log.
  if (request.stream) {
    const encoder = new TextEncoder();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let full = '';

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model: effectiveModel,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });

        try {
          send(chunk({ role: 'assistant', content: '' }));
          const text = await answerOnce((piece) => {
            if (piece) send(chunk({ content: piece }));
            full += piece;
          });
          if (managed) await appendExchange(deps.env, request.session_key!, today, prompt, text);
          send(chunk({}, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          await log(200, { streamed: true, text: full, endpoint: endpointLabel }, null);
        } catch (e) {
          // The headers are already sent, so the error has to travel in-band and the log is the only place a
          // structured record can live.
          const message = e instanceof Error ? e.message : String(e);
          try {
            send({ error: { message, type: 'upstream_error' } });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch {
            /* controller already closed */
          }
          controller.close();
          await log(502, { streamed: true, text: full, error: message }, message);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  try {
    const text = await answerOnce(() => {});

    if (!text.trim()) {
      const body = { error: { message: 'the model returned an empty reply', type: 'upstream_error' } };
      await log(502, body, 'empty reply');
      return Response.json(body, { status: 502 });
    }

    if (managed) await appendExchange(deps.env, request.session_key!, today, prompt, text);

    const body = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: effectiveModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(text),
        total_tokens: estimateTokens(prompt) + estimateTokens(text),
      },
      ...(endpointLabel ? { endpoint: endpointLabel } : {}),
    };
    await log(200, body, null);
    return Response.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const body = { error: { message, type: 'upstream_error' } };
    await log(502, body, message);
    return Response.json(body, { status: 502 });
  }
}

/** Forget one managed conversation — the conversation-level `/reset`. */
export async function clearManagedHistory(env: Env, sessionKey: string): Promise<void> {
  await clearHistory(env, sessionKey);
}
