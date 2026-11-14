/**
 * The provider dispatcher.
 *
 * WHY THIS IS SMALL: the DeepSeek path already has a complete, well-documented implementation in
 * `src/api/openai.ts` — thread management, the single-use challenge ladder, staged degradation. Duplicating
 * that here would create a second copy to keep in step, and the two would drift. So this module owns the
 * EXTERNAL provider (including its failover), and the DeepSeek path stays where it is.
 *
 * The decision every caller needs is `providerContext()`, which answers "does this deployment need a
 * proof-of-work solve and a session token, or an API key?" — because those are mutually exclusive
 * requirements, and getting the answer wrong makes the bot unusable in one of the two modes.
 */

import type { Env } from '../types';
import { getProviderConfig, resolveEndpoints, isExternalProvider, type ProviderConfig } from './config';
import {
  streamWithFailover,
  completeWithFailover,
  ProviderError,
  type AttemptRecord,
  type ExternalMessage,
  type EndpointWithKey,
} from './openai-compat';

export interface ProviderContext {
  config: ProviderConfig;
  /** True when completions go to an OpenAI-compatible endpoint. */
  external: boolean;
  /** The enabled endpoints with keys resolved. Empty for the DeepSeek path. */
  endpoints: EndpointWithKey[];
  /** The configured timeout, applied per attempt. */
  timeoutMs: number;
}

/**
 * Resolve the active provider once per request.
 *
 * Done once because every call site needs at least two of these values, and reading them separately would mean
 * several D1 round trips inside a single message.
 */
export async function providerContext(env: Env): Promise<ProviderContext> {
  const config = await getProviderConfig(env);
  const external = isExternalProvider(config);
  return {
    config,
    external,
    // Only read for the external path: the DeepSeek path addresses no endpoints.
    endpoints: external ? await resolveEndpoints(env) : [],
    timeoutMs: config.timeoutMs,
  };
}

export interface ExternalCompleteRequest {
  model: string;
  messages: ExternalMessage[];
  onDelta?: (text: string) => void;
  onAttempt?: (attempt: AttemptRecord) => void;
}

export interface ExternalResult {
  text: string;
  /** The label of the endpoint that answered, for the audit log. */
  endpointLabel: string;
  endpointModel: string;
  /** Every attempt in order, so a failover is recorded rather than invisible. */
  attempts: AttemptRecord[];
}

/**
 * Answer through the OpenAI-compatible provider, using the first endpoint that works.
 *
 * Returns the accumulated text. A stream that produced content and then failed returns the partial text rather
 * than throwing, because a partial answer the user can read beats nothing — and the caller's log records the
 * failure either way.
 */
export async function completeExternalStream(
  ctx: ProviderContext,
  request: ExternalCompleteRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalResult> {
  const result = await streamWithFailover(
    ctx.endpoints,
    { model: request.model, messages: request.messages },
    {
      fetchImpl,
      timeoutMs: ctx.timeoutMs,
      onDelta: request.onDelta,
      onAttempt: request.onAttempt,
    },
  );
  return {
    text: result.text,
    endpointLabel: result.endpoint.label,
    endpointModel: result.endpoint.model,
    attempts: result.attempts,
  };
}

/** Answer through the OpenAI-compatible provider without streaming. */
export async function completeExternalOnce(
  ctx: ProviderContext,
  request: { model: string; messages: ExternalMessage[] },
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalResult> {
  const result = await completeWithFailover(
    ctx.endpoints,
    { model: request.model, messages: request.messages },
    fetchImpl,
    ctx.timeoutMs,
  );
  return {
    text: result.text,
    endpointLabel: result.endpoint.label,
    endpointModel: result.endpoint.model,
    attempts: result.attempts,
  };
}

/**
 * A one-line summary of a failover, for the audit log.
 *
 * Null when the first endpoint answered, so ordinary rows are not cluttered with "1 attempt" — a note that
 * appears on every row stops being a signal.
 */
export function failoverNote(attempts: AttemptRecord[]): string | null {
  if (attempts.length <= 1) return null;
  const failed = attempts.slice(0, -1).map((a) => `${a.label}(${a.status ?? '失败'})`);
  const last = attempts[attempts.length - 1];
  return last.error
    ? `全部端点失败：${attempts.map((a) => `${a.label}(${a.status ?? '失败'})`).join(' → ')}`
    : `端点故障转移：${failed.join(' → ')} → ${last.label} 成功`;
}

export { ProviderError, isExternalProvider };
export type { ExternalMessage, AttemptRecord };
