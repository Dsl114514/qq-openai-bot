/**
 * Admin console API client.
 *
 * WHY A SEPARATE MODULE FROM THE COMPONENTS: every request here carries the Basic credentials that
 * got the user into `/admin`, and a fetch that forgets `credentials: 'same-origin'` silently returns
 * 401 — which is exactly the bug that broke the workbench's wasm load earlier (the browser does not
 * replay Basic auth unless the request opts in). Putting the fetch in one place means that flag is
 * set once and cannot be forgotten per call site.
 *
 * The credential check itself is server-side; nothing here trusts the client.
 */

/** A JSON request that always replays the admin credentials. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON body is reported below rather than thrown as a parse error */
  }
  if (!res.ok) {
    throw new Error(errorMessage(json, res.status));
  }
  return json as T;
}

/**
 * Pull a human-readable reason out of an error body.
 *
 * TWO SHAPES ARE CHECKED because the API uses both: OpenAI-style endpoints answer `{error:{message}}`, while the
 * settings handlers answer `{ok:false, detail}`. Reading only the first is what turned a failed connection probe
 * into a bare "HTTP 400" on screen — the diagnostic text was in `detail` and was never looked at. Falling back
 * to the status code keeps that as the last resort rather than the first answer.
 */
function errorMessage(json: unknown, status: number): string {
  if (json && typeof json === 'object') {
    const body = json as { error?: { message?: string }; detail?: string; message?: string };
    const candidate = body.error?.message ?? body.detail ?? body.message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return `HTTP ${status}`;
}

/**
 * A POST whose FAILURE IS A RESULT, not a transport error.
 *
 * Used by the diagnostics. The server already returns 200 for those, but this tolerates a non-2xx too: a 401
 * from the auth gate or a 400 from a future validation rule still carries a reason worth showing, and throwing
 * would replace it with a status code.
 */
async function postFormLenient<T>(path: string, fields: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text) as T & { detail?: string };
    if (!res.ok && !json.detail) return { ...json, detail: errorMessage(json, res.status) } as T;
    return json;
  } catch {
    return { detail: `HTTP ${res.status}` } as unknown as T;
  }
}

export const api = {
  /** Form-encoded POST, which is what the server's handlers parse. */
  postForm(path: string, fields: Record<string, string>): Promise<unknown> {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  },
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string) => request<T>(path, { method: 'POST' }),
};

// ─────────────────────────────────────────────────────────────── call records

export interface CallLogRow {
  id: number;
  created_at: number;
  origin: string;
  origin_ref: string | null;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  status: number;
  error: string | null;
}

export interface CallLogDetail extends CallLogRow {
  request_body: string;
  response_body: string | null;
}

export interface CallsResponse {
  rows: CallLogRow[];
  total: number;
}

export const listCalls = (params: {
  origin?: string;
  status?: string;
  search?: string;
  offset?: number;
  limit?: number;
}): Promise<CallsResponse> => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return api.get<CallsResponse>(`/admin/api/calls?${q.toString()}`);
};

export const getCall = (id: number): Promise<CallLogDetail> => api.get<CallLogDetail>(`/admin/api/call?id=${id}`);

// ─────────────────────────────────────────────────────────────────── sessions

export interface SessionRow {
  id: string;
  channel: string;
  pinned: boolean;
  sessionId: string;
  lastMessageId: string | null;
  day: string;
  updatedAt: number;
  current: boolean;
}

export interface SessionsResponse {
  rows: SessionRow[];
  day: string;
  timeZone: string;
  stats: { users: number; today: number };
}

export const listSessions = (): Promise<SessionsResponse> => api.get<SessionsResponse>('/admin/api/sessions');

// ──────────────────────────────────────────────────────────────────── status

export interface StatusResponse {
  ed25519: { preferred: string | null; detail: string[] };
  qq: {
    sandbox: boolean;
    apiHost: string;
    appId: string | null;
    identity: { status: number; body: unknown } | null;
    shareUrl: string | null;
    error: string | null;
  };
  groups: { openid: string; label: string }[];
  interjections: {
    group: string;
    config: { enabled: boolean; perDay: number; mode: string; at?: string; text?: string };
    sent: number;
    nextDueAt: number | null;
    ambient: number;
  }[];
}

export const getStatus = (): Promise<StatusResponse> => api.get<StatusResponse>('/admin/api/status');

// ──────────────────────────────────────────────────────────────── completions

export interface ChatChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  error?: { message?: string };
}

/**
 * Stream a completion, calling `onDelta` per token.
 *
 * The session is managed server-side via `session_key`, so this holds no conversation state — which
 * is what makes a page reload resume rather than restart.
 */
export async function streamCompletion(
  body: { session_key: string; messages: { role: string; content: string }[]; thinking?: boolean; search?: boolean },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the status-based message */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(payload) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message);
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) onDelta(piece);
      }
    }
  }
}

/** A non-streaming completion, used when streaming is not wanted. */
export async function completion(body: {
  session_key: string;
  messages: { role: string; content: string }[];
}): Promise<{ text: string }> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return { text: json.choices?.[0]?.message?.content ?? '' };
}

// ────────────────────────────────────────────────────────── history & stats

export interface HistoryTurn {
  id: number;
  createdAt: number;
  status: number;
  latencyMs: number;
  scope: string;
  /** The user's text, extracted from whichever body shape the path produced. */
  user: string;
  reply: string;
  kind: 'chat' | 'task' | 'interjection' | 'command';
  stage: string | null;
  error: string | null;
}

export interface HistoryResponse {
  scopes: { id: string; n: number; newest: number }[];
  turns: HistoryTurn[];
  scope: string;
  limit: number;
}

export const getHistory = (scope: string, limit = 50): Promise<HistoryResponse> => {
  const q = new URLSearchParams();
  if (scope) q.set('scope', scope);
  q.set('limit', String(limit));
  return api.get<HistoryResponse>(`/admin/api/history?${q.toString()}`);
};

export interface StatsResponse {
  days: { day: string; total: number; errors: number; avgLatencyMs: number }[];
  total: number;
  byOrigin: { origin: string; n: number }[];
  byStatus: { status: number; n: number }[];
  latency: { p50: number; p95: number; max: number; avg: number };
  tokens: { prompt: number; completion: number };
  topUsers: { ref: string; n: number }[];
  from: number;
  to: number;
}

export const getStats = (days = 30): Promise<StatsResponse> => api.get<StatsResponse>(`/admin/api/stats?days=${days}`);

// ─────────────────────────────────────────────────────────────────── settings

export interface ModeDefaults {
  thinking: boolean;
  search: boolean;
}

export interface Settings {
  modes: ModeDefaults;
  persona: string;
  allowProactive: boolean;
  model: string;
}

export interface GroupSettings {
  group: string;
  override: Partial<Settings>;
  effective: Settings;
  overridden: boolean;
}

export interface KnownGroup {
  openid: string;
  label: string;
}

export interface SettingsResponse {
  global: Settings;
  groups: GroupSettings[];
  knownGroups: KnownGroup[];
}

export const getSettings = (): Promise<SettingsResponse> => api.get<SettingsResponse>('/admin/api/settings');

export const saveGlobalSettings = (fields: Record<string, string>): Promise<{ ok: boolean; detail: string }> =>
  api.postForm('/admin/api/settings/global', fields) as Promise<{ ok: boolean; detail: string }>;

export const saveGroupSettings = (fields: Record<string, string>): Promise<{ ok: boolean; detail: string }> =>
  api.postForm('/admin/api/settings/group', fields) as Promise<{ ok: boolean; detail: string }>;

// ──────────────────────────────────────────────────────────────── access rules

export interface AccessRules {
  users: string[];
  groups: string[];
  deniedUsers: string[];
  deniedGroups: string[];
  mode: 'open' | 'closed';
}

export const getAccess = (): Promise<{ rules: AccessRules; knownGroups: KnownGroup[] }> =>
  api.get('/admin/api/access');

export const saveAccess = (fields: Record<string, string>): Promise<{ ok: boolean; detail: string }> =>
  api.postForm('/admin/api/access', fields) as Promise<{ ok: boolean; detail: string }>;

// ────────────────────────────────────────────────────────────────────── tasks

export type TaskKind = 'daily' | 'weekly' | 'interval';
export type TaskContent = { kind: 'fixed'; text: string } | { kind: 'generated' };

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  group: string;
  kind: TaskKind;
  times: string[];
  weekdays: number[];
  everyMinutes: number;
  content: TaskContent;
  lastRunAt?: number;
}

export interface TasksResponse {
  tasks: ScheduledTask[];
  limits: {
    maxTasks: number;
    maxTimes: number;
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
    nameMax: number;
    textMax: number;
  };
  knownGroups: KnownGroup[];
}

export const getTasks = (): Promise<TasksResponse> => api.get<TasksResponse>('/admin/api/tasks');

export const saveTask = (fields: Record<string, string | string[]>): Promise<{ ok: boolean; detail: string }> => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    // A repeated key is how the multi-time and multi-weekday fields arrive server-side.
    if (Array.isArray(v)) for (const item of v) body.append(k, item);
    else body.set(k, v);
  }
  return fetch('/admin/api/tasks/save', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }).then(async (res) => {
    const json = (await res.json()) as { ok: boolean; detail: string };
    return json;
  });
};

export const deleteTask = (id: string): Promise<{ ok: boolean; detail: string }> =>
  api.postForm('/admin/api/tasks/delete', { id }) as Promise<{ ok: boolean; detail: string }>;

export const runTask = (id: string): Promise<{ ok: boolean; detail: string }> =>
  api.postForm('/admin/api/tasks/run', { id }) as Promise<{ ok: boolean; detail: string }>;

export const migrateTasks = (): Promise<{ ok: boolean; detail: string }> =>
  api.post('/admin/api/tasks/migrate') as Promise<{ ok: boolean; detail: string }>;

// ────────────────────────────────────────────────────────────────── provider

/** Only one kind remains; a stored 'deepseek-web' kind is coerced server-side on read. */
export type ProviderKind = 'openai-compat';

/** One reachable OpenAI-compatible endpoint, as the console sees it. */
export interface ProviderEndpointView {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** Extra headers, editable as `Name: value` lines. */
  headers: Record<string, string>;
  hasKey: boolean;
  keyFingerprint: string | null;
  keySource: 'D1' | 'Worker secret' | null;
  /** The URL a request will actually go to — the check that catches a missing `/v1`. */
  resolvedUrl: string;
}

export interface ProviderView {
  kind: ProviderKind;
  timeoutMs: number;
  /** In order; the first enabled one that works answers. */
  endpoints: ProviderEndpointView[];
}

export const getProvider = (): Promise<ProviderView> => api.get<ProviderView>('/admin/api/provider');

/**
 * Save the provider.
 *
 * `endpoints` is sent as JSON because it is a list of objects, and flattening it into form fields would invent a
 * naming scheme that is worse to read and easier to get wrong. Keys are sent under `key:<id>` so the server can
 * distinguish "leave it alone" (absent) from "remove it" (empty string).
 */
export const saveProvider = (fields: Record<string, string>): Promise<{ ok: boolean; detail: string; provider?: ProviderView }> =>
  api.postForm('/admin/api/provider', fields) as Promise<{ ok: boolean; detail: string; provider?: ProviderView }>;

export interface ProbeResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  models?: string[];
  modelFound?: boolean;
}

export interface DiagnosticResponse {
  ok: boolean;
  detail: string;
  results?: ProbeResult[];
}

/**
 * Ask the server to check the endpoints.
 *
 * Lenient on purpose: a probe whose FINDING is "unhealthy" is still a successful probe, and its text is the whole
 * point. Throwing would replace that text with a status code.
 */
export const probeProvider = (endpointId?: string): Promise<DiagnosticResponse> =>
  postFormLenient<DiagnosticResponse>('/admin/api/provider/probe', endpointId ? { endpointId } : {});

/**
 * Send a real one-token completion to verify the MODEL, not just the key.
 *
 * Separate from the probe because a valid key and a valid URL can still name a model the provider does not
 * serve — and that failure looks like the provider misbehaving rather than a typo.
 */
export const testProvider = (fields: { endpointId?: string; model?: string } = {}): Promise<DiagnosticResponse> =>
  postFormLenient<DiagnosticResponse>('/admin/api/provider/test', {
    ...(fields.endpointId ? { endpointId: fields.endpointId } : {}),
    ...(fields.model ? { model: fields.model } : {}),
  });

/**
 * Send ONE request in a chosen shape, to find out what a provider's gate keys on.
 *
 * One per call on purpose: a burst of shapes trips the very rate limit it is investigating, and the result then
 * reads as "only the first shape works" when it is really "bursts are limited".
 */
export interface DiagnoseResponse extends DiagnosticResponse {
  status?: number;
  ms?: number;
  /** True when the answer came back in a few milliseconds — the edge refusing, not the origin. */
  fastEdgeReject?: boolean;
}

export const diagnoseProvider = (fields: { endpointId?: string; shape?: string } = {}): Promise<DiagnoseResponse> =>
  postFormLenient<DiagnoseResponse>('/admin/api/provider/diagnose', {
    ...(fields.endpointId ? { endpointId: fields.endpointId } : {}),
    ...(fields.shape ? { shape: fields.shape } : {}),
  });

/** The shapes the diagnostician can send, in the order an operator should try them. */
export const DIAGNOSE_SHAPES = [
  { value: 'baseline', label: 'baseline —— 代码实际发送的形态' },
  { value: 'completion', label: 'POST 补全 —— 真实对话请求' },
  { value: 'browser', label: '浏览器 UA + Accept-Language' },
  { value: 'origin', label: '浏览器 UA + Origin/Referer' },
  { value: 'no-auth', label: '不带 Key —— 判断拦截在鉴权之前还是之后' },
  { value: 'root', label: '站点根路径 —— 判断是整域名还是只有 /v1' },
] as const;

// ────────────────────────────────────────────────────────────────── utilities

export const fmtTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export const fmtDuration = (ms: number): string => {
  if (ms <= 0) return '已过期';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
};

/** A status code's tone, for colouring. Kept here so every view agrees. */
export const statusTone = (status: number): 'good' | 'warn' | 'bad' | 'note' =>
  status >= 500 ? 'bad' : status >= 400 ? 'warn' : status >= 300 ? 'note' : 'good';
