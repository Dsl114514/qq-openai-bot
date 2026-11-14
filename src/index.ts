/**
 * Worker entry point.
 *
 * Route map
 *   GET  /health                      liveness
 *   POST /v1/chat/completions         OpenAI-compatible surface
 *   GET  /v1/models                   what the configured provider serves
 *   POST /qq/webhook                  QQ official Agent-channel event callback
 *   GET  /admin                       audit view + workbench
 *
 * Every completion is ONE authenticated POST to whichever endpoint is configured in /admin — there is
 * no challenge protocol to satisfy, so there is no route group for solving one.
 */

import { Hono } from 'hono';
import type { Env } from './types';
import { ensureSchema } from './db/store';
import { loadHistory } from './providers/history';
import { getSession, dayKey, sessionTimeZone, WORKBENCH_SESSION_KEY } from './qq/session';
import { handleChatCompletion, type ChatCompletionRequest, type Origin } from './api/openai';
import { handleQQWebhook, qqBotInfo, probeGroupAccess, probeProductionAccess } from './qq/webhook';
import { checkAdminAuth, basicAuthChallenge } from './admin/ui';
import {
  handlePurge,
  handleSessionPurge,
  handleSessionReset,
  handleWorkbenchReset,
  handleSessionPin,
  handleInterjectionConfig,
  handleInterjectionTest,
  handleInterjectionClear,
} from './admin/handlers';
import { ensureAmbientSchema } from './qq/ambient';
import { apiListCalls, apiGetCall, apiListSessions, apiStatus, apiHistory, apiStats } from './admin/api';
import { exportCalls, exportSessions } from './admin/export';
import {
  apiGetSettings,
  apiSetGlobalSettings,
  apiSetGroupSettings,
  apiGetAccess,
  apiSetAccess,
  apiListTasks,
  apiSaveTask,
  apiDeleteTask,
  apiRunTask,
  apiMigrateTasks,
  apiGetProvider,
  apiSetProvider,
  apiProbeProvider,
  apiTestProvider,
  apiDiagnoseProvider,
} from './admin/settings-api';

const app = new Hono<{ Bindings: Env; ExecutionContext: ExecutionContext }>();

// Schema creation is idempotent and cheap, but doing it on every request would waste a
// round trip. A module-level promise means once per isolate.
//
// The failure path matters more than the success path: `??=` alone caches a REJECTED
// promise forever, so a single transient D1 error would make every later request in that
// isolate fail with a 500 — including /health. Clearing the slot on rejection lets the
// next request retry, which is what turns a blip into a retry instead of an outage.
let schemaReady: Promise<void> | null = null;
async function ready(env: Env): Promise<void> {
  schemaReady ??= ensureSchema(env.DB).then(() => ensureAmbientSchema(env.DB));
  try {
    await schemaReady;
  } catch (e) {
    console.error('ensureSchema failed; will retry on the next request', e);
    schemaReady = null;
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────── utilities

const jsonError = (message: string, status = 400, extra: Record<string, unknown> = {}) =>
  Response.json({ error: { message, ...extra } }, { status });

/**
 * Compare two secrets without leaking how far they match.
 *
 * The obvious `if (a.length !== b.length) return false` gives away the length and then
 * stops at the first differing character, so response time reveals both the length and
 * the matching prefix of the ACCESS_KEY. Instead this folds the length difference into
 * the accumulator and always walks the longer string, so the work done depends only on
 * the (public) maximum length.
 *
 * WebCrypto's timingSafeEqual would be ideal but is not exposed in Workers, so the
 * comparison is written out.
 */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  // Length mismatch is itself a failure, but it is mixed in rather than returned early.
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // Out-of-range indices read as 0, which keeps the loop trip count constant.
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

/**
 * CPU time consumed so far by this invocation, in milliseconds, or null when the runtime
 * does not expose it.
 *
 * MEASURED IN PRODUCTION: this returns `undefined` on the deployed Worker, so `cpuMs` is
 * null and every caller must tolerate that. It is still probed rather than assumed absent,
 * because it is the only precise clock available and it may be enabled later.
 */
function cpuMs(): number | null {
  const c = (performance as unknown as { cpuTime?: number }).cpuTime;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/**
 * Wall-clock milliseconds, and honestly labelled.
 *
 * MEASURED IN PRODUCTION: `performance.now()` is present but does not advance — a run of
 * 20,000 hashes reported a delta of exactly 0. The previous version of this function tested
 * `> 0` on a single reading, which a constant clock passes, and so it reported
 * `clockPrecise: true` while measuring nothing.
 *
 * `Date.now()` is therefore the only clock, and it advances in 1 ms steps. `precise` is
 * always false: with this runtime there is no precise clock, and claiming otherwise would
 * let a manufactured number be used to size chunks.
 */
function wallMs(): { ms: number; precise: false } {
  return { ms: Date.now(), precise: false };
}

// ───────────────────────────────────────────────────────────────────────── health

app.get('/health', (c) =>
  Response.json({
    ok: true,
    cpuTimeAvailable: cpuMs() !== null,
    now: Date.now(),
  }),
);

// ────────────────────────────────────────────────── OpenAI-compatible completions

/**
 * Credential gate for the OpenAI surface.
 *
 * MEASURED BYPASS THAT SHAPED THIS: an earlier version trusted `x-origin: workbench` as proof
 * of being the admin workbench. Verified against the deployed Worker —
 *
 *   curl -H 'x-origin: workbench' /v1/chat/completions   -> HTTP 428, straight through to upstream
 *   curl -H 'x-origin: workbench' /v1/models             -> HTTP 200
 *
 * — because a request header is attacker-controlled. There is no way to distinguish the
 * workbench from anyone else by a header the workbench itself sends.
 *
 * So the workbench now authenticates the same way everything else does. It already sits
 * behind HTTP Basic auth and its fetches carry those credentials, so the admin password is
 * accepted here as an alternative to the access key — and it is verified, not assumed.
 */
function authorize(c: {
  req: { header: (n: string) => string | undefined; raw: Request };
  env: Env;
}): { ok: true; origin: Origin } | { ok: false; response: Response } {
  const key = bearer(c.req.raw);
  if (key && c.env.ACCESS_KEY && safeEqual(key, c.env.ACCESS_KEY)) return { ok: true, origin: 'access_key' };
  // The workbench: proven by the admin password it already had to supply to load the page.
  if (checkAdminAuth(c.env, c.req.header('authorization') ?? null)) return { ok: true, origin: 'workbench' };
  return { ok: false, response: jsonError('missing or invalid access key', 401, { type: 'invalid_request_error' }) };
}

/**
 * Credential gate for the QQ diagnostic endpoints (`/qq/status`, `/qq/probe-group`).
 *
 * THE ANALOGOUS /pow/* GATE WAS ONCE MISSING AND THOSE ENDPOINTS WERE PUBLICLY REACHABLE —
 * verified against the deployed Worker, where an unauthenticated request got HTTP 200 and
 * burned the owner's request quota and CPU budget. Every diagnostic endpoint is therefore
 * gated BY CONSTRUCTION: the check lives here, in one place a new route can reuse, rather
 * than in each handler where forgetting one is silent.
 *
 * Two auth paths are accepted, matching /v1: the access key, or the admin password (which is
 * what the workbench has, since its fetches carry the Basic credentials but no access key).
 * Anything else is refused.
 */
function authorizeDiagnostic(c: {
  req: { header: (n: string) => string | undefined; raw: Request };
  env: Env;
}): Response | null {
  const key = bearer(c.req.raw);
  if (key && c.env.ACCESS_KEY && safeEqual(key, c.env.ACCESS_KEY)) return null;
  if (checkAdminAuth(c.env, c.req.header('authorization') ?? null)) return null;
  return jsonError(
    'missing or invalid credentials: send the access key as `Authorization: Bearer <ACCESS_KEY>`',
    401,
  );
}

app.post('/v1/chat/completions', async (c) => {
  await ready(c.env);
  const auth = authorize(c);
  if (!auth.ok) return auth.response;

  let body: ChatCompletionRequest;
  try {
    body = await c.req.json<ChatCompletionRequest>();
  } catch {
    return jsonError('body must be JSON', 400);
  }

  return handleChatCompletion(body, {
    env: c.env,
    origin: auth.origin,
    originRef: c.req.header('x-origin-ref') ?? null,
  });
});

app.get('/v1/models', async (c) => {
  await ready(c.env);
  const auth = authorize(c);
  if (!auth.ok) return auth.response;

  // Proxied from the configured provider rather than hardcoded: the model list is the provider's truth,
  // and a stale local copy would advertise models that no longer exist (or hide new ones). The response
  // is always HTTP 200 with the upstream status carried in the body — a discovery endpoint reporting a
  // finding is not itself a failed request, and returning 4xx here made the console swallow the text.
  const { providerContext } = await import('./providers/complete');
  const ctx = await providerContext(c.env);
  const first = ctx.endpoints.find((e) => e.enabled) ?? ctx.endpoints[0];
  if (!first) {
    return Response.json({ object: 'list', data: [] });
  }

  const { modelsUrl } = await import('./providers/config');
  try {
    const res = await fetch(modelsUrl(first.baseUrl.replace(/\/+$/, '')), {
      headers: { authorization: `Bearer ${first.apiKey}` },
      signal: AbortSignal.timeout(ctx.config.timeoutMs || 30_000),
    });
    const text = await res.text();
    let data: unknown = [];
    try {
      const json = JSON.parse(text) as { data?: unknown };
      data = Array.isArray(json.data) ? json.data : [{ id: text.slice(0, 120), object: 'model' }];
    } catch {
      data = [{ id: text.slice(0, 120), object: 'model', note: 'provider returned a non-JSON body' }];
    }
    return Response.json({
      object: 'list',
      endpoint: first.label,
      ...(res.ok ? {} : { upstreamStatus: res.status }),
      data,
    });
  } catch (e) {
    return Response.json({
      object: 'list',
      data: [],
      error: { message: `模型列表获取失败：${e instanceof Error ? e.message : String(e)}`, type: 'upstream_error' },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────── QQ bot

app.post('/qq/webhook', async (c) => {
  await ready(c.env);
  // The raw body must be read as text: the Ed25519 signature covers these exact bytes,
  // and re-serialising the parsed JSON changes them.
  const rawBody = await c.req.text();
  const result = await handleQQWebhook({
    env: c.env,
    rawBody,
    signature: c.req.header('x-signature-ed25519') ?? null,
    timestamp: c.req.header('x-signature-timestamp') ?? null,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  return Response.json(result.body as never, { status: result.status as never });
});

/**
 * Report which QQ API host this deployment talks to, and confirm the bot identity it holds.
 *
 * This exists because "messages are rejected" has two very different causes that look
 * identical in the audit log: the wrong host (a sandbox bot cannot post to production, and
 * the error does not mention the host) versus a bad recipient openid. Asking the Worker
 * itself, from Cloudflare's network, is the only place the answer is trustworthy — a local
 * probe goes through whatever proxy the developer's machine has.
 */
app.get('/qq/status', async (c) => {
  await ready(c.env);
  const denied = authorizeDiagnostic(c);
  if (denied) return denied;

  const info = await qqBotInfo(c.env);
  return Response.json({
    apiHost: info.apiHost,
    sandbox: info.sandbox,
    note: info.sandbox
      ? 'sends go to the SANDBOX host; a sandbox bot cannot message production users and vice versa'
      : 'sends go to the PRODUCTION host',
    appId: c.env.QQ_APP_ID || null,
    identity: info.identity,
    // The link that opens the bot card in the QQ client, which is where a user adds it.
    shareUrl: info.shareUrl,
    error: info.error,
  });
});

/**
 * Diagnose a 11292 by asking BOTH QQ API hosts about one group.
 *
 * The error "沙箱环境不能访问此资源" is identical for two opposite situations — the resource is a
 * production group, or the group was never registered as a sandbox group — and the fixes are
 * mutually exclusive. Only asking each host distinguishes them.
 *
 * Read-only unless `?send=1`, which additionally attempts a proactive message on both hosts
 * (and will therefore post a real message if it succeeds).
 */
app.get('/qq/probe-group', async (c) => {
  await ready(c.env);
  const denied = authorizeDiagnostic(c);
  if (denied) return denied;

  const groupOpenid = c.req.query('group_openid');
  if (!groupOpenid) return jsonError('provide ?group_openid=...');

  const probe = await probeGroupAccess(c.env, groupOpenid, {
    send: c.req.query('send') === '1',
    text: c.req.query('text'),
  });
  const production = c.req.query('production') === '1' ? await probeProductionAccess(c.env) : undefined;
  return Response.json({
    configuredHost: c.env.QQ_SANDBOX === 'true' ? 'sandbox' : 'production',
    ...probe,
    ...(production ? { production } : {}),
  });
});

/**
 * Serve the console's HTML shell from the static assets.
 *
 * The asset directory is `web/dist/admin` and Vite's base is `/admin/`, so the referenced URLs and the
 * stored paths agree: the shell is at `/admin/index.html` and the bundle at `/admin/assets/…`. An
 * earlier arrangement emitted to `web/dist` while the HTML referenced `/admin/assets/…`, so the
 * browser's bundle request fell through to the catch-all and received HTML — a MIME error that looks
 * nothing like a path problem.
 *
 * The shell is the same document for every console route because routing happens in the browser (a
 * hash router), so there is exactly one file to fetch. Going through the ASSETS binding keeps it
 * edge-cached and out of the Worker's CPU budget, which matters on a 10 ms allowance (ADR-0005).
 *
 * A missing build produces a readable explanation rather than a blank page, because a blank page reads
 * as "the app is broken" instead of "you have not run the build".
 */
async function serveConsoleShell(env: Env, request: Request): Promise<Response> {
  if (!env.ASSETS) {
    return new Response(
      '静态资源未绑定。请确认 wrangler.toml 的 assets 配置里有 `binding = "ASSETS"`（只有目录是不够的），并先运行 `npm run build:web`。',
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // THE ASSET WORKER REDIRECTS `/admin/index.html` -> `/admin/` (307), because its `html_handling`
  // normalises an explicit index.html to the directory form. MEASURED through the binding:
  //
  //   /index.html             -> 404
  //   /admin/index.html       -> 307 -> /admin/
  //   /admin/assets/…js       -> 200
  //
  // A lookup that treats any non-2xx as a failure therefore reports "not found" for a file that exists.
  // `redirect: 'follow'` resolves it transparently.
  const res = await env.ASSETS.fetch(new Request(new URL('/admin/index.html', request.url), { redirect: 'follow' }));

  if (!res.ok) {
    return new Response(
      `没有找到控制台页面（/admin/index.html 返回 ${res.status}）。请先运行 \`npm run build:web\`，并确认 assets.directory 指向 web/dist。`,
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // The shell must not be cached as immutable: a new deploy changes which hashed bundle it points at,
  // and a stale shell would reference a bundle that no longer exists.
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  // The content type comes from the asset worker; forcing text/html would break nothing here but would
  // hide a misconfigured asset if one ever resolved to a non-HTML file.
  return new Response(res.body, { status: 200, headers });
}

// ───────────────────────────────────────────────────────────────────────── admin

app.use('/admin/*', async (c, next) => {
  await ready(c.env);
  if (!checkAdminAuth(c.env, c.req.header('authorization') ?? null)) return basicAuthChallenge();
  await next();
});
app.use('/admin', async (c, next) => {
  await ready(c.env);
  if (!checkAdminAuth(c.env, c.req.header('authorization') ?? null)) return basicAuthChallenge();
  await next();
});

/**
 * The console shell.
 *
 * `run_worker_first` routes `/admin*` through here FIRST, so the auth gate above has already run by
 * the time this executes. That ordering is the security property: without it, the asset worker would
 * serve the shell to anyone who asked (see the note in wrangler.toml).
 *
 * The shell is fetched from the ASSETS binding rather than embedded in the Worker, so the HTML and its
 * hashed bundle are cached at the edge and cost no CPU to serve. A missing build is reported as a
 * readable error instead of a blank page — a blank page is indistinguishable from a broken app.
 */
app.get('/admin', async (c) => serveConsoleShell(c.env, c.req.raw));

// ── JSON API for the console ──
//
// These are registered BEFORE the catch-all below. Hono matches routes in registration order, so a
// catch-all declared first would swallow `/admin/api/*` and answer every API call with the HTML shell —
// which the browser would then fail to parse as JSON, reporting a confusing error.
app.get('/admin/api/calls', (c) => apiListCalls(c.env, new URL(c.req.url)));
app.get('/admin/api/call', (c) => apiGetCall(c.env, new URL(c.req.url)));
app.get('/admin/api/sessions', (c) => apiListSessions(c.env));
app.get('/admin/api/status', (c) => apiStatus(c.env));
app.get('/admin/api/history', (c) => apiHistory(c.env, new URL(c.req.url)));
app.get('/admin/api/stats', (c) => apiStats(c.env, new URL(c.req.url)));
app.get('/admin/api/settings', (c) => apiGetSettings(c.env));
app.get('/admin/api/access', (c) => apiGetAccess(c.env));
app.get('/admin/api/tasks', (c) => apiListTasks(c.env));
app.get('/admin/api/provider', (c) => apiGetProvider(c.env));

// Exports stream a file, so they are GETs with query parameters rather than POSTs with a body.
app.get('/admin/api/export/calls', (c) =>
  exportCalls(c.env, {
    format: new URL(c.req.url).searchParams.get('format') === 'csv' ? 'csv' : 'json',
    origin: new URL(c.req.url).searchParams.get('origin') ?? undefined,
    status: Number(new URL(c.req.url).searchParams.get('status')) || undefined,
  }),
);
app.get('/admin/api/export/sessions', (c) =>
  exportSessions(c.env, new URL(c.req.url).searchParams.get('format') === 'csv' ? 'csv' : 'json'),
);

// Mutations, all answered as JSON.
app.post('/admin/api/settings/global', (c) => apiSetGlobalSettings(c.env, c.req.raw));
app.post('/admin/api/settings/group', (c) => apiSetGroupSettings(c.env, c.req.raw));
app.post('/admin/api/access', (c) => apiSetAccess(c.env, c.req.raw));
app.post('/admin/api/tasks/save', (c) => apiSaveTask(c.env, c.req.raw));
app.post('/admin/api/tasks/delete', (c) => apiDeleteTask(c.env, c.req.raw));
app.post('/admin/api/tasks/run', (c) => apiRunTask(c.env, c.req.raw));
app.post('/admin/api/tasks/migrate', (c) => apiMigrateTasks(c.env));
app.post('/admin/api/provider', (c) => apiSetProvider(c.env, c.req.raw));
app.post('/admin/api/provider/probe', (c) => apiProbeProvider(c.env, c.req.raw));
app.post('/admin/api/provider/test', (c) => apiTestProvider(c.env, c.req.raw));
app.post('/admin/api/provider/diagnose', (c) => apiDiagnoseProvider(c.env, c.req.raw));

/**
 * The workbench's conversation state, so the page can show what the SERVER thinks it is.
 *
 * The browser deliberately holds nothing about the conversation, so without this an operator has
 * no way to confirm history exists short of observing that the bot remembers something.
 */
app.get('/admin/workbench/session', async (c) => {
  await ready(c.env);
  const [history, tz] = await Promise.all([loadHistory(c.env, WORKBENCH_SESSION_KEY), Promise.resolve(sessionTimeZone(c.env))]);
  const day = dayKey(Date.now(), tz);
  const messages = history.messages.length;
  return Response.json({
    sessionKey: WORKBENCH_SESSION_KEY,
    // A single history row serves the whole conversation, so "the identifier" is the key itself.
    sessionId: messages > 0 ? WORKBENCH_SESSION_KEY : null,
    lastMessageId: messages > 0 ? `${messages}` : null,
    messageCount: messages,
    day: history.day || null,
    today: day,
    timeZone: tz,
    current: messages > 0 && history.day === day,
    // Why, in words — the flags alone require the reader to know the daily-reset rule to interpret them.
    reason: messages === 0
      ? '还没有对话'
      : history.day !== day
        ? `对话属于 ${history.day}，跨天已过期`
        : `今天的对话，${messages} 条消息，会延续`,
  });
});
app.post('/admin/workbench/reset', (c) => handleWorkbenchReset(c.env));

app.post('/admin/purge', async (c) => handlePurge(c.env, await c.req.formData()));

app.post('/admin/purge', async (c) => handlePurge(c.env, await c.req.formData()));
app.post('/admin/qq/purge-sessions', async (c) => handleSessionPurge(c.env, await c.req.formData()));
app.post('/admin/qq/reset-session', async (c) => handleSessionReset(c.env, await c.req.formData()));
app.post('/admin/qq/pin-session', async (c) => handleSessionPin(c.env, await c.req.formData()));
app.post('/admin/qq/interject', async (c) => handleInterjectionConfig(c.env, await c.req.formData()));
app.post('/admin/qq/interject-test', async (c) => handleInterjectionTest(c.env, await c.req.formData()));
app.post('/admin/qq/interject-clear', async (c) => handleInterjectionClear(c.env, await c.req.formData()));

/**
 * An unknown API path is a JSON 404, never the HTML shell.
 *
 * WITHOUT THIS, a request to a mistyped or wrong-method API path falls through to the console catch-all and
 * receives HTML with status 200. A client then fails inside `JSON.parse` with a message about an unexpected
 * `<`, which names neither the path nor the real problem — and a status of 200 hides it from any monitoring.
 * Registered before the catch-all below.
 */
app.all('/admin/api/*', (c) =>
  c.json(
    {
      error: 'no such API endpoint',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      hint: 'This path may exist with a different HTTP method — the mutations are POSTs.',
    },
    404,
  ),
);

/**
 * Any other console path: serve the matching asset if there is one, else the shell.
 *
 * THE ASSET LOOKUP USES THE ORIGINAL PATH — no stripping. Measured directly through the binding:
 *
 *   /index.html                    -> 404
 *   /admin/index.html              -> 307 -> /admin/
 *   /admin/assets/index-*.js       -> 200  text/javascript
 *
 * so `env.ASSETS.fetch()` expects exactly what the browser asked for, and `/admin/index.html` is a
 * REDIRECT to the directory form rather than a file. An earlier attempt stripped the `/admin` prefix
 * and looked up `/assets/…`, which 404s — and that 404 was misread as "the asset is not deployed",
 * when in fact the deployed layout was right the whole time.
 *
 * WHY AN ASSET LOOKUP IS NEEDED AT ALL: `run_worker_first` sends every `/admin/*` request to the Worker,
 * so the Worker has to decide what is an asset and what is a client route — the asset worker no longer
 * gets a chance first. Returning the shell unconditionally made `/admin/assets/index-*.js` answer with
 * 731 bytes of HTML, so the browser received HTML where it expected JavaScript and the console failed to
 * boot with a MIME error that named neither the path nor the cause.
 */
app.get('/admin/:rest{.*}', async (c) => {
  if (!c.env.ASSETS) return serveConsoleShell(c.env, c.req.raw);

  // A 307 from the asset worker is a normalisation, not a failure, so it is followed rather than
  // reported. Any non-404 result is a real asset and is returned as-is.
  const asset = await c.env.ASSETS.fetch(new Request(c.req.raw, { redirect: 'follow' }));
  if (asset.status !== 404) return asset;

  // A miss means this was a client route such as `/admin/qq`, which exists only in the browser's hash
  // router — the shell is the right answer, so a bookmarked page keeps working.
  return serveConsoleShell(c.env, c.req.raw);
});

// ───────────────────────────────────────────────────────────── 404 with a route map

app.notFound((c) =>
  c.json(
    {
      error: 'not found',
      routes: [
        'GET  /health',
        'GET  /v1/models',
        'POST /v1/chat/completions',
        'POST /qq/webhook',
        'GET  /admin',
        'GET  /admin/call?id=N',
        'GET  /admin/status',
        'GET  /admin/workbench',
        'GET  /admin/qq',
        'GET  /qq/status',
      ],
    },
    404,
  ),
);

app.onError((err, c) => {
  console.error('unhandled', err);
  return jsonError(err instanceof Error ? err.message : String(err), 500, { unhandled: true });
});

export default app;

export { safeEqual, bearer };
