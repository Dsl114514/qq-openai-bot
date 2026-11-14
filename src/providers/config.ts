/**
 * Which backend answers a completion, and how to reach it.
 *
 * WHY A LIST OF ENDPOINTS RATHER THAN ONE. A single configured endpoint makes the bot's availability exactly
 * as good as that endpoint's: one relay that rate-limits, one key that runs out of quota, one host that goes
 * down, and every message fails. Relays also differ in what they accept — some need an extra header, some
 * serve a different model set — so "which endpoint" is a per-deployment decision that has to be changeable
 * without editing code.
 *
 * So the config is an ORDERED LIST. The first enabled endpoint is tried first; the rest are fallbacks, tried
 * only when the earlier ones fail in a way that a different endpoint could fix.
 *
 * STORAGE, AND WHY THE KEYS ARE SEPARATE:
 *
 *   provider:kind          -> 'deepseek-web' | 'openai-compat'
 *   provider:endpoints     -> [{ id, label, baseUrl, model, enabled, headers }]
 *   provider:key:<id>      -> the API key for one endpoint
 *
 * Keys live in their own rows, NOT inside the endpoint objects. That makes "never serialise a key into a
 * response" a property of the storage layout rather than a rule someone has to remember: any code that reads
 * the endpoint list cannot accidentally include a key, because the list does not contain one.
 *
 * A single-endpoint deployment from an earlier version is migrated on read, so upgrading does not lose the
 * configured URL, model or key. See `migrateLegacyConfig`.
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

/** Only one provider kind remains. A stored 'deepseek-web' kind is coerced on read (see normalizeProvider). */
export type ProviderKind = 'openai-compat';

/** One reachable OpenAI-compatible endpoint. */
export interface ProviderEndpoint {
  /** Stable identity, used for the key row and for the console's edit/delete actions. */
  id: string;
  /** What the operator calls it, shown in the console and in errors. */
  label: string;
  /** API base, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** The model name sent to this endpoint. */
  model: string;
  enabled: boolean;
  /**
   * Extra headers to send, as `Name: value` lines.
   *
   * NEEDED IN PRACTICE, not a nicety: some relays require a `HTTP-Referer`/`X-Title` pair (OpenRouter), some
   * gate on a specific `User-Agent`, and some need an organisation header. Without this the only way to use
   * them is to change the code.
   */
  headers: Record<string, string>;
}

/** The whole provider configuration. */
export interface ProviderConfig {
  kind: ProviderKind;
  /** In order; the first enabled one that succeeds wins. */
  endpoints: ProviderEndpoint[];
  timeoutMs: number;
}

/** What a caller receives: the config with keys replaced by fingerprints. */
export interface ProviderView extends Omit<ProviderConfig, 'endpoints'> {
  endpoints: (ProviderEndpoint & {
    /** True when a key is available for this endpoint. */
    hasKey: boolean;
    /** A short label, so a key can be recognised without being displayed. */
    keyFingerprint: string | null;
    /** Where the key came from, so an operator knows which place to change. */
    keySource: 'D1' | 'Worker secret' | null;
    /** The URL a request will actually go to — the check that catches a missing `/v1`. */
    resolvedUrl: string;
  })[];
}

const KIND_KEY = 'provider:kind';
const ENDPOINTS_KEY = 'provider:endpoints';
const KEY_PREFIX = 'provider:key:';
/** The pre-endpoint-list rows, read once for migration. */
const LEGACY_CONFIG_KEY = 'provider:config';
const LEGACY_API_KEY_KEY = 'provider:apiKey';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const MAX_ENDPOINTS = 8;

/**
 * The default when nothing is configured.
 *
 * There is exactly one provider kind, so the default is simply "one placeholder endpoint". It carries no
 * credential, which makes the misconfigured state VISIBLE (calls answer 503 with "no endpoint / no key")
 * instead of silently picking a provider the operator never chose.
 */
export const DEFAULT_PROVIDER: ProviderConfig = {
  kind: 'openai-compat',
  endpoints: [
    {
      id: 'primary',
      label: '默认',
      baseUrl: DEFAULT_BASE_URL,
      model: 'gpt-4o-mini',
      enabled: true,
      headers: {},
    },
  ],
  timeoutMs: 30_000,
};

/**
 * Normalise an API base into a full completions URL.
 *
 * ACCEPTS EITHER FORM, because both are natural to type and the difference is invisible until the request
 * 404s:
 *
 *   https://api.openai.com/v1                    -> .../v1/chat/completions
 *   https://api.openai.com/v1/chat/completions   -> unchanged
 *
 * A trailing slash is stripped first, so `https://x/v1/` behaves like `https://x/v1`.
 */
export function completionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/** The models URL for a base, used by the connection test. */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  // A base that already names an endpoint cannot be trimmed to a models URL reliably, so it is used as-is
  // with the last segment swapped — which is what a relay with a custom path expects.
  if (/\/chat\/completions$/.test(base)) return base.replace(/\/chat\/completions$/, '/models');
  return `${base}/models`;
}

/** Parse `Name: value` lines into a header map. Blank lines and lines without a colon are ignored. */
export function parseHeaders(input: unknown): Record<string, string> {
  const lines = Array.isArray(input) ? input.map(String) : typeof input === 'string' ? input.split('\n') : [];
  const out: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    // Header names are case-insensitive and must not contain spaces; a bad one would make the whole request
    // fail with a message that does not name the field.
    if (!name || /[\s]/.test(name) || name.length > 100) continue;
    if (value.length > 1000) continue;
    out[name] = value;
  }
  return out;
}

/** Render a header map back into the editable `Name: value` form. */
export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/**
 * Stable, URL-safe id derived from the label.
 *
 * Deterministic so saving an endpoint twice UPDATES it rather than creating a duplicate — the console has no
 * separate id field for the operator to manage. A numeric suffix is added on collision by the caller.
 */
export function endpointId(label: string): string {
  const basis = label.trim().toLowerCase() || 'endpoint';
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `e${(h >>> 0).toString(36)}`;
}

/** Coerce one endpoint, keeping the fallback's values for anything invalid. */
function normalizeEndpoint(input: unknown, base?: ProviderEndpoint): ProviderEndpoint | null {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const label = (typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : base?.label ?? '未命名').slice(0, 60);
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim().slice(0, 300) : base?.baseUrl ?? '';
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim().slice(0, 120) : base?.model ?? '';

  // An endpoint with no URL cannot be requested at all. Dropping it is better than keeping a row that fails
  // on every message with a message about an empty URL.
  if (!baseUrl) return null;

  const id = typeof raw.id === 'string' && /^[a-z0-9]{1,16}$/.test(raw.id) ? raw.id : base?.id ?? endpointId(label);

  return {
    id,
    label,
    baseUrl,
    model: model || 'gpt-4o-mini',
    enabled: raw.enabled === undefined ? (base?.enabled ?? true) : raw.enabled !== false && raw.enabled !== 'false',
    headers: raw.headers !== undefined ? parseHeaders(raw.headers) : (base?.headers ?? {}),
  };
}

/**
 * Coerce anything into a usable config.
 *
 * Every value is checked rather than trusted, because these come from a form and are persisted: a bad value
 * stored today keeps breaking messages until someone notices, whereas a rejected one fails now, in front of
 * the person who typed it.
 */
export function normalizeProvider(input: unknown, base: ProviderConfig = DEFAULT_PROVIDER): ProviderConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  // A stored 'deepseek-web' kind is COERCED rather than rejected: settings rows written by the previous
  // system must keep loading (and keep their endpoints), while the protocol they named no longer exists.
  // Anything unrecognised falls back to the base kind, which is now the only kind.
  const kind: ProviderKind = 'openai-compat';

  const timeoutRaw = Number(raw.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(Math.max(Math.round(timeoutRaw), 1000), 120_000) : base.timeoutMs;

  let endpoints: ProviderEndpoint[];
  if (Array.isArray(raw.endpoints)) {
    endpoints = raw.endpoints
      .map((e) => normalizeEndpoint(e))
      .filter((e): e is ProviderEndpoint => e !== null)
      .slice(0, MAX_ENDPOINTS);
    // Ids must be unique: the key row is addressed by id, so a duplicate would silently share one key.
    const seen = new Set<string>();
    for (const e of endpoints) {
      while (seen.has(e.id)) e.id = `${e.id}${Math.floor(Math.random() * 36).toString(36)}`;
      seen.add(e.id);
    }
  } else {
    // A single-endpoint patch (the older shape, and what a partial update sends) edits the FIRST endpoint.
    const first = base.endpoints[0] ?? DEFAULT_PROVIDER.endpoints[0];
    const edited = normalizeEndpoint(
      {
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
        label: typeof raw.label === 'string' ? raw.label : undefined,
      },
      first,
    );
    endpoints = edited ? [edited, ...base.endpoints.slice(1)] : [...base.endpoints];
  }

  // An external provider with no endpoint is unusable, so a valid default is kept rather than an empty list
  // that fails on every message with a confusing error.
  if (endpoints.length === 0) endpoints = [DEFAULT_PROVIDER.endpoints[0]];

  return { kind, endpoints, timeoutMs };
}

// ─────────────────────────────────────────────────────────── persistence

async function readJson(env: Env, key: string): Promise<unknown> {
  const stored = await getState(env.DB, key);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    // A corrupt row is treated as absent: the defaults are usable, and refusing to answer because one settings
    // row is malformed would be a much worse failure.
    console.error(`provider row ${key} is not valid JSON; ignoring it`);
    return null;
  }
}

/**
 * Bring a pre-endpoint-list deployment forward.
 *
 * WHY THIS EXISTS: an earlier version stored one `provider:config` row and one `provider:apiKey` row. Reading
 * only the new keys would silently revert a configured deployment to the defaults — losing the URL, the model
 * and (worse) making the bot look like it had never been set up. The old rows are read once, folded into an
 * endpoint, and the key is copied to the new per-endpoint location.
 *
 * Idempotent: once the new rows exist, the legacy ones are never consulted again.
 */
async function migrateLegacyConfig(env: Env): Promise<void> {
  const existing = await getState(env.DB, ENDPOINTS_KEY);
  if (existing) return;

  const legacy = (await readJson(env, LEGACY_CONFIG_KEY)) as Record<string, unknown> | null;
  if (!legacy) return;

  const endpoint = normalizeEndpoint({
    label: '迁移的端点',
    baseUrl: legacy.baseUrl,
    model: legacy.model,
    enabled: true,
  });
  if (!endpoint) return;

  // The key is COPIED, not moved: the legacy row is left in place so a rollback still finds it.
  const legacyKey = await getState(env.DB, LEGACY_API_KEY_KEY);
  if (legacyKey && legacyKey.trim()) await setState(env.DB, `${KEY_PREFIX}${endpoint.id}`, legacyKey.trim());

  await setState(env.DB, ENDPOINTS_KEY, JSON.stringify([endpoint]));
  if (typeof legacy.kind === 'string') await setState(env.DB, KIND_KEY, legacy.kind);
  if (legacy.timeoutMs !== undefined) await setState(env.DB, 'provider:timeoutMs', String(legacy.timeoutMs));
}

/** Read the stored config, migrating a legacy single-endpoint row when it is the only thing present. */
export async function getProviderConfig(env: Env): Promise<ProviderConfig> {
  await migrateLegacyConfig(env);

  const [kindRaw, endpointsRaw, timeoutRaw] = await Promise.all([
    getState(env.DB, KIND_KEY),
    readJson(env, ENDPOINTS_KEY),
    getState(env.DB, 'provider:timeoutMs'),
  ]);

  const fromEnv: Record<string, unknown> = {
    ...(kindRaw ? { kind: kindRaw } : {}),
    ...(endpointsRaw ? { endpoints: endpointsRaw } : {}),
    ...(timeoutRaw ? { timeoutMs: Number(timeoutRaw) } : {}),
  };

  // Environment variables override the stored URL and model for the FIRST endpoint, which keeps the
  // documented `OPENAI_BASE_URL` / `OPENAI_MODEL` behaviour working for a deployment that sets them.
  const merged = { ...fromEnv };
  if (env.OPENAI_BASE_URL || env.OPENAI_MODEL) {
    const list = Array.isArray(merged.endpoints) ? [...(merged.endpoints as unknown[])] : [];
    const first = (list[0] ?? {}) as Record<string, unknown>;
    list[0] = {
      ...first,
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
      ...(env.OPENAI_MODEL ? { model: env.OPENAI_MODEL } : {}),
    };
    merged.endpoints = list;
    if (env.OPENAI_BASE_URL || env.OPENAI_MODEL) merged.kind = 'openai-compat';
  }

  return normalizeProvider(merged);
}

export async function setProviderConfig(env: Env, patch: unknown): Promise<ProviderConfig> {
  const current = await getProviderConfig(env);
  const next = normalizeProvider(patch, current);
  await setState(env.DB, KIND_KEY, next.kind);
  await setState(env.DB, ENDPOINTS_KEY, JSON.stringify(next.endpoints));
  await setState(env.DB, 'provider:timeoutMs', String(next.timeoutMs));
  return next;
}

// ─────────────────────────────────────────────────────────── keys

/**
 * The API key for one endpoint.
 *
 * Precedence: the per-endpoint D1 row, then the shared `OPENAI_API_KEY` secret. The shared secret is the
 * recommended home for a single-endpoint deployment — it is encrypted at rest and never enters the database —
 * while D1 is what makes MULTI-endpoint (and console editing) possible.
 */
export async function readApiKey(env: Env, endpointId: string): Promise<{ key: string; source: 'D1' | 'Worker secret' | null }> {
  const stored = await getState(env.DB, `${KEY_PREFIX}${endpointId}`);
  if (stored && stored.trim()) return { key: stored.trim(), source: 'D1' };

  // The legacy single key is accepted for the endpoint that migration produced, so an existing deployment
  // keeps working before anyone re-enters the key.
  const legacy = await getState(env.DB, LEGACY_API_KEY_KEY);
  if (legacy && legacy.trim() && endpointId === 'primary') return { key: legacy.trim(), source: 'D1' };

  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) return { key: env.OPENAI_API_KEY.trim(), source: 'Worker secret' };
  return { key: '', source: null };
}

export async function setApiKey(env: Env, endpointId: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    await env.DB.prepare('DELETE FROM app_state WHERE key = ?1').bind(`${KEY_PREFIX}${endpointId}`).run();
    return;
  }
  await setState(env.DB, `${KEY_PREFIX}${endpointId}`, trimmed);
}

/**
 * A short, non-reversible label for a key.
 *
 * SHA-256 truncated to 8 hex characters. The point is recognisability — an operator with two keys needs to
 * tell which one is installed — without revealing anything usable. A prefix of the key would be almost as
 * identifying and would expose real key material, which is why this hashes instead.
 */
export async function keyFingerprint(key: string): Promise<string> {
  if (!key) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The config plus key metadata. The keys themselves are never included. */
export async function getProviderView(env: Env): Promise<ProviderView> {
  const config = await getProviderConfig(env);
  const endpoints = await Promise.all(
    config.endpoints.map(async (e) => {
      const { key, source } = await readApiKey(env, e.id);
      return {
        ...e,
        hasKey: Boolean(key),
        keyFingerprint: key ? await keyFingerprint(key) : null,
        keySource: source,
        resolvedUrl: completionsUrl(e.baseUrl),
      };
    }),
  );
  return { kind: config.kind, timeoutMs: config.timeoutMs, endpoints };
}

/** Every enabled endpoint with its key resolved. For internal use — never hand this to a response. */
export async function resolveEndpoints(env: Env): Promise<(ProviderEndpoint & { apiKey: string })[]> {
  const config = await getProviderConfig(env);
  const out: (ProviderEndpoint & { apiKey: string })[] = [];
  for (const e of config.endpoints) {
    if (!e.enabled) continue;
    const { key } = await readApiKey(env, e.id);
    out.push({ ...e, apiKey: key });
  }
  return out;
}

/** True when completions should go to an OpenAI-compatible endpoint rather than DeepSeek's web API. */
export function isExternalProvider(config: { kind: ProviderKind }): boolean {
  return config.kind === 'openai-compat';
}

/**
 * Which model name to send.
 *
 * `deepseek-web` IS TREATED AS "NO OVERRIDE", not as a model name. It is the historical default stored in
 * every existing settings row, and the DeepSeek web API accepts it as a label. Passing it to an
 * OpenAI-compatible endpoint would be a guaranteed 404 — the kind of failure that looks like a broken key
 * rather than a stale default. So it falls through to the endpoint's own model.
 */
export function resolveModel(scopeModel: string | undefined, endpointModel: string): string {
  const m = (scopeModel ?? '').trim();
  if (!m || m === 'deepseek-web') return endpointModel;
  return m;
}
