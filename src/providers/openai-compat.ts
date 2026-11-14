/**
 * Calling an OpenAI-compatible endpoint, with failover across a list of them.
 *
 * WHY FAILOVER IS THE POINT: a relay that rate-limits, a key that runs out of quota, a host that is briefly
 * down — each of those makes a single-endpoint bot completely unavailable for the duration. With a second
 * endpoint configured, the same message succeeds, and the operator finds out from the audit log rather than
 * from users.
 *
 * WHICH FAILURES ARE WORTH RETRYING ELSEWHERE, and which are not:
 *
 *   worth it   401/403/429/5xx, timeouts, connection errors — the endpoint is unwilling or unable
 *   not worth  400/422 — the REQUEST is wrong, so every other endpoint will reject it identically
 *
 * Retrying a malformed request against every endpoint wastes the whole list's quota and turns one clear error
 * into N confusing ones. So the classification is deliberate, not "try everything".
 */

import type { ProviderEndpoint } from './config';
import { completionsUrl } from './config';

export interface ExternalMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ExternalCompletionRequest {
  model: string;
  messages: ExternalMessage[];
  /** Reasoning models accept this; ordinary ones ignore an unknown field rather than erroring. */
  temperature?: number;
  max_tokens?: number;
}

export interface ExternalDelta {
  text: string;
}

export type EndpointWithKey = ProviderEndpoint & { apiKey: string };

/** Default per-endpoint timeout, used when the caller does not supply one. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** A failure that carries enough context to be diagnosed without reading the source. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
    /**
     * True when a DIFFERENT endpoint might succeed where this one failed.
     *
     * The distinction is what stops a malformed request from being replayed against every endpoint: a 400 is
     * the request's fault and will fail identically everywhere, so retrying it wastes quota and produces a pile
     * of near-identical errors instead of one useful one.
     */
    readonly retryableElsewhere = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Turn a non-2xx response into an error that names the likely cause.
 *
 * THE BODY IS INCLUDED, TRUNCATED. Providers put the real reason in the body (`invalid_api_key`,
 * `model_not_found`, `insufficient_quota`) and their messages are far more specific than any mapping from the
 * status code. Discarding it is what makes a support question into a guessing game.
 */
function describeFailure(status: number, body: string, url: string): ProviderError {
  const snippet = body.slice(0, 400);

  // A REGION BLOCK ARRIVES AS 401/403 AND IS NOT A CREDENTIAL PROBLEM. MEASURED against OpenAI: a request from
  // an unsupported region is answered with 403 `unsupported_country_region_territory`. Mapping the status code
  // alone to "check your key" sends the operator to regenerate a key that was never the issue.
  if (/unsupported_country_region_territory|not available in your (country|region)|region.*not supported/i.test(body)) {
    return new ProviderError(
      `上游拒绝了这个地区（HTTP ${status}）。这不是密钥的问题 —— 该服务不支持从当前地区访问。原始响应：${snippet}`,
      status,
      snippet,
      true,
    );
  }

  if (status === 401 || status === 403) {
    return new ProviderError(
      `上游拒绝了 API Key（HTTP ${status}）。检查密钥是否正确、是否有余额、是否被允许访问该模型。原始响应：${snippet}`,
      status,
      snippet,
      true,
    );
  }

  if (status === 404) {
    return new ProviderError(
      `上游返回 404 —— 通常是 URL 或模型名不对，而不是密钥问题。当前请求的是 ${url}。` +
        `确认 Base URL 是否包含 /v1（例如 https://api.openai.com/v1），以及模型名在该服务上是否存在。原始响应：${snippet}`,
      status,
      snippet,
      // A model name is per-endpoint, so another endpoint may serve a different one — worth trying.
      true,
    );
  }

  if (status === 429) {
    // A 429 IS OFTEN TRANSIENT, and the two cases need opposite advice. MEASURED: `error code: 1015` from an
    // origin behind Cloudflare persisted for minutes while the same key worked from another network, which no
    // amount of retrying would have fixed. THIS IS THE CASE FAILOVER EXISTS FOR, and the message says so — an
    // operator reading "rate limited" with failover configured would otherwise wonder why nothing automatic
    // happened, when in fact the remaining endpoints were tried.
    return new ProviderError(
      `上游限流（HTTP ${status}）。该端点暂时不可用：若配置了其他端点会自动尝试，` +
        `若全部失败则需稍后重试或更换端点/服务商。原始响应：${snippet}`,
      status,
      snippet,
      true,
    );
  }

  if (status >= 500) {
    return new ProviderError(`上游服务错误（HTTP ${status}）。原始响应：${snippet}`, status, snippet, true);
  }

  // 400/422 and anything else: the REQUEST is at fault, so another endpoint would reject it the same way.
  return new ProviderError(
    `上游拒绝了请求（HTTP ${status}）。这通常是请求本身的问题（模型名、参数、内容长度），换端点不会有帮助。原始响应：${snippet}`,
    status,
    snippet,
    false,
  );
}

/** Build the request body, omitting fields the caller did not set rather than sending null. */
function buildBody(request: ExternalCompletionRequest, stream: boolean): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (stream) body.stream = true;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.max_tokens === 'number') body.max_tokens = request.max_tokens;
  return JSON.stringify(body);
}

/**
 * Assemble the headers.
 *
 * The operator's custom headers come FIRST, so the standard ones cannot be broken by a typo in the console —
 * a mistyped `content-type` would otherwise make every request fail in a way that looks like the provider's
 * fault.
 */
function buildHeaders(endpoint: EndpointWithKey, stream: boolean): Record<string, string> {
  return {
    ...endpoint.headers,
    authorization: `Bearer ${endpoint.apiKey}`,
    'content-type': 'application/json',
    ...(stream ? { accept: 'text/event-stream' } : {}),
  };
}

/**
 * Stream a completion from ONE endpoint.
 *
 * A generator so the caller can forward fragments as they arrive — which is what makes the bot feel responsive
 * rather than silent-then-dumped, and what lets the `/v1` endpoint pass a stream through.
 *
 * The frames are parsed leniently: a line that does not parse is SKIPPED rather than fatal, because some
 * providers emit keep-alive comments and a final `data: [DONE]` that a strict parser would reject.
 */
export async function* streamEndpoint(
  endpoint: EndpointWithKey,
  request: ExternalCompletionRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): AsyncGenerator<ExternalDelta> {
  const url = completionsUrl(endpoint.baseUrl);
  if (!url) throw new ProviderError('没有配置 Base URL，无法调用 OpenAI 兼容接口。', 500, 'baseUrl is empty', false);
  if (!endpoint.apiKey) {
    throw new ProviderError(`端点「${endpoint.label}」没有 API Key。`, 500, 'apiKey is empty', true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: buildHeaders(endpoint, true),
      body: buildBody(request, true),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    const message = e instanceof Error ? e.message : String(e);
    // An abort is a timeout, not a network failure, and saying so saves a long detour.
    const isAbort = e instanceof Error && e.name === 'AbortError';
    throw new ProviderError(
      isAbort ? `端点「${endpoint.label}」在 ${timeoutMs}ms 内没有响应。` : `无法连接端点「${endpoint.label}」：${message}`,
      504,
      message,
      true,
    );
  }

  if (!res.ok) {
    clearTimeout(timeout);
    throw describeFailure(res.status, await res.text().catch(() => ''), url);
  }

  if (!res.body) {
    clearTimeout(timeout);
    throw new ProviderError(`端点「${endpoint.label}」返回了空响应体。`, 502, 'no body', true);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: { index: number; length: number } | null;
      while ((sep = findFrameEnd(buffer)) !== null) {
        const frame = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let chunk: {
            choices?: { delta?: { content?: string | null } }[];
            error?: { message?: string };
          };
          try {
            chunk = JSON.parse(payload) as typeof chunk;
          } catch {
            continue; // a keep-alive comment or a partial frame; not worth failing the stream over
          }

          if (chunk.error?.message) {
            throw new ProviderError(`上游在流中报错：${chunk.error.message}`, 502, chunk.error.message, true);
          }

          const piece = chunk.choices?.[0]?.delta?.content;
          if (typeof piece === 'string' && piece) yield { text: piece };
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

/** Find the end of the first SSE frame, whichever line ending was used. Null when incomplete. */
function findFrameEnd(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export interface AttemptRecord {
  endpointId: string;
  label: string;
  /** Null when this endpoint produced text. */
  error: string | null;
  status: number | null;
  ms: number;
}

export interface FailoverResult {
  text: string;
  /** The endpoint that answered. */
  endpoint: EndpointWithKey;
  /** Every attempt in order — what makes a failover VISIBLE in the audit log rather than silent. */
  attempts: AttemptRecord[];
}

/**
 * Stream a completion, trying each endpoint in order until one produces text.
 *
 * AN EMPTY ANSWER DOES NOT TRIGGER FAILOVER. A 200 with no content is a working endpoint giving a contentless
 * reply, which is a real (if unhelpful) answer — failing over would silently substitute a DIFFERENT model's
 * opinion, and nobody could tell which model had spoken. Only outright failures move on.
 *
 * TEXT ALREADY STREAMED IS RETURNED. A partial answer beats discarding it, and the caller must not then also
 * try the next endpoint, or the user would see two answers concatenated.
 */
export async function streamWithFailover(
  endpoints: EndpointWithKey[],
  request: ExternalCompletionRequest,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    onDelta?: (text: string) => void;
    onAttempt?: (a: AttemptRecord) => void;
  } = {},
): Promise<FailoverResult> {
  if (endpoints.length === 0) {
    throw new ProviderError('没有可用的端点。请在控制台的「模型来源」里添加一个并填写 API Key。', 503, 'no endpoints', false);
  }

  const attempts: AttemptRecord[] = [];
  let lastError: ProviderError | null = null;

  for (const endpoint of endpoints) {
    const started = Date.now();
    let text = '';

    try {
      for await (const delta of streamEndpoint(endpoint, request, options.fetchImpl ?? fetch, options.timeoutMs)) {
        text += delta.text;
        options.onDelta?.(text);
      }
      const record: AttemptRecord = { endpointId: endpoint.id, label: endpoint.label, error: null, status: 200, ms: Date.now() - started };
      attempts.push(record);
      options.onAttempt?.(record);
      return { text, endpoint, attempts };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), 502, '', true);
      lastError = err;
      const record: AttemptRecord = { endpointId: endpoint.id, label: endpoint.label, error: err.message, status: err.status, ms: Date.now() - started };
      attempts.push(record);
      options.onAttempt?.(record);

      if (text) return { text, endpoint, attempts };

      // A request the provider considers malformed will be malformed everywhere, so the remaining endpoints are
      // not tried. Stopping here keeps one clear error instead of N confusing ones.
      if (!err.retryableElsewhere) throw err;
    }
  }

  // Every endpoint failed. The message names them all, because "it failed" without saying WHERE leaves the
  // operator to guess which of several configured endpoints is the problem.
  const summary = attempts.map((a) => `${a.label}: ${a.error}`).join(' | ');
  throw new ProviderError(`${endpoints.length} 个端点全部失败 —— ${summary}`, lastError?.status ?? 502, summary, false);
}

/**
 * A non-streaming completion from one endpoint.
 *
 * Separate from the streaming path rather than consuming the generator, because the response shape differs: a
 * non-streaming provider reply has `choices[0].message.content`, not deltas, and mapping one onto the other
 * would mean a request that asks for a stream and then discards the framing.
 */
export async function completeEndpoint(
  endpoint: EndpointWithKey,
  request: ExternalCompletionRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ text: string; model: string }> {
  const url = completionsUrl(endpoint.baseUrl);
  if (!url || !endpoint.apiKey) {
    throw new ProviderError(`端点「${endpoint.label}」配置不完整（缺 Base URL 或 API Key）。`, 500, 'incomplete config', true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: buildHeaders(endpoint, false),
      body: buildBody(request, false),
      signal: controller.signal,
    });

    if (!res.ok) throw describeFailure(res.status, await res.text().catch(() => ''), url);

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    return { text: json.choices?.[0]?.message?.content ?? '', model: json.model ?? request.model };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    const isAbort = e instanceof Error && e.name === 'AbortError';
    throw new ProviderError(
      isAbort ? `端点「${endpoint.label}」在 ${timeoutMs}ms 内没有响应。` : `无法连接端点「${endpoint.label}」：${message}`,
      504,
      message,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Non-streaming, with the same failover rules. */
export async function completeWithFailover(
  endpoints: EndpointWithKey[],
  request: ExternalCompletionRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FailoverResult> {
  if (endpoints.length === 0) {
    throw new ProviderError('没有可用的端点。请在控制台的「模型来源」里添加一个并填写 API Key。', 503, 'no endpoints', false);
  }

  const attempts: AttemptRecord[] = [];
  let lastError: ProviderError | null = null;

  for (const endpoint of endpoints) {
    const started = Date.now();
    try {
      const { text } = await completeEndpoint(endpoint, request, fetchImpl, timeoutMs);
      const record: AttemptRecord = { endpointId: endpoint.id, label: endpoint.label, error: null, status: 200, ms: Date.now() - started };
      attempts.push(record);
      return { text, endpoint, attempts };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), 502, '', true);
      lastError = err;
      attempts.push({ endpointId: endpoint.id, label: endpoint.label, error: err.message, status: err.status, ms: Date.now() - started });
      if (!err.retryableElsewhere) throw err;
    }
  }

  const summary = attempts.map((a) => `${a.label}: ${a.error}`).join(' | ');
  throw new ProviderError(`${endpoints.length} 个端点全部失败 —— ${summary}`, lastError?.status ?? 502, summary, false);
}

/**
 * A non-streaming completion against a bare config, kept for callers that hold only one endpoint.
 *
 * Retained because the existing tests and the `completeExternalOnce` helper are written against this shape,
 * and rewriting them to construct a fake endpoint list would add noise without adding coverage.
 */
export async function completeExternal(
  config: { baseUrl: string; model: string; apiKey: string; timeoutMs?: number },
  request: ExternalCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; model: string }> {
  return completeEndpoint(
    { id: 'single', label: 'single', baseUrl: config.baseUrl, model: config.model, enabled: true, headers: {}, apiKey: config.apiKey },
    request,
    fetchImpl,
    config.timeoutMs,
  );
}

/** Streaming against a bare config, for the same reason. */
export async function* streamExternalCompletion(
  config: { baseUrl: string; model: string; apiKey: string; timeoutMs?: number },
  request: ExternalCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<ExternalDelta> {
  yield* streamEndpoint(
    { id: 'single', label: 'single', baseUrl: config.baseUrl, model: config.model, enabled: true, headers: {}, apiKey: config.apiKey },
    request,
    fetchImpl,
    config.timeoutMs,
  );
}
