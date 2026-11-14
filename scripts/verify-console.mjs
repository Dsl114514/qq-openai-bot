// Verify the Vue console: it loads, its API works, and — most importantly — the static assets do NOT
// bypass the admin auth gate.
//
// THAT LAST CHECK IS THE POINT. `run_worker_first` exists here for security, not speed: without it
// Cloudflare serves a matching asset before the Worker runs, so `/admin/` and its bundle would be
// readable by anyone. A passing check is therefore that an UNAUTHENTICATED request for the console, its
// bundle, or its API gets 401 — not 200.
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const ap = readFileSync('.dryrun/ap.txt', 'utf8').trim();
const basic = 'Basic ' + Buffer.from(`admin:${ap}`).toString('base64');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  if (!ok) failures++;
};

const get = (path, headers = {}) => fetch(BASE + path, { headers, redirect: 'manual' });

console.log('\n\x1b[1m1. Auth gate covers the static console\x1b[0m');
// The shell and the bundle are the two things an attacker would want: the bundle contains the API
// paths, and the shell is the entry point.
for (const path of ['/admin', '/admin/', '/admin/qq', '/admin/assets/index-BkWcd7qu.js', '/admin/assets/index-eze-IqCG.css']) {
  const res = await get(path);
  check(res.status === 401, `${path} without credentials is 401`, `got ${res.status}`);
}

console.log('\n\x1b[1m2. The console loads with credentials\x1b[0m');
const shell = await get('/admin', { authorization: basic });
const shellText = await shell.text();
check(shell.status === 200, '/admin returns the shell', `HTTP ${shell.status}`);
check(/<div id="app">/.test(shellText), 'the shell has the Vue mount point');
check(!/服务端渲染|server-rendered/i.test(shellText), 'no server-rendered HTML remains');
// The bundle URL is hashed, so it is extracted rather than hard-coded.
const bundlePath = (shellText.match(/src="([^"]*assets\/[^"]+\.js)"/) ?? [])[1];
check(Boolean(bundlePath), 'the shell references a hashed bundle', bundlePath ?? 'none found');

if (bundlePath) {
  const bundle = await get(bundlePath, { authorization: basic });
  check(bundle.status === 200, 'the bundle is fetchable with credentials', `HTTP ${bundle.status}`);
  const js = await bundle.text();
  // A sanity check that this is the real app and not an error page.
  check(js.length > 50_000, 'the bundle is the built app', `${js.length} bytes`);
  check(/session_key/.test(js), 'the bundle contains the console logic');
}

console.log('\n\x1b[1m3. Deep links serve the shell (hash routing)\x1b[0m');
// A bookmarked `/admin/qq` must return the app, not a 404.
const deep = await get('/admin/qq', { authorization: basic });
const deepText = await deep.text();
check(deep.status === 200, '/admin/qq serves the shell', `HTTP ${deep.status}`);
check(/<div id="app">/.test(deepText), 'the deep link returns the app shell');

console.log('\n\x1b[1m4. The JSON API answers with JSON, not HTML\x1b[0m');
// This is the route-ordering check: a catch-all registered too early would swallow these and return
// the HTML shell, which the browser then fails to parse as JSON.
for (const path of ['/admin/api/status', '/admin/api/sessions', '/admin/api/calls?limit=2']) {
  const res = await get(path, { authorization: basic });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const isJson = type.includes('json') && text.trimStart().startsWith('{');
  check(res.status === 200 && isJson, `${path} returns JSON`, `HTTP ${res.status} ${type}`);
  if (path === '/admin/api/status' && isJson) {
    const j = JSON.parse(text);
    check(typeof j.sessionToken?.source === 'string', '  status carries the token source', j.sessionToken?.source);
    check(Array.isArray(j.groups), '  status carries the group list', `${j.groups?.length ?? 0} groups`);
    check(Array.isArray(j.interjections), '  status carries the interjection list');
  }
  if (path === '/admin/api/sessions' && isJson) {
    const j = JSON.parse(text);
    check(Array.isArray(j.rows) && typeof j.day === 'string', '  sessions carries rows and the day');
  }
}

console.log('\n\x1b[1m5. The wasm route still serves bytes, not the shell\x1b[0m');
// The catch-all would have broken this too: the workbench needs the actual binary.
const wasm = await get('/admin/sha3_wasm_bg.wasm', { authorization: basic });
const bytes = Buffer.from(await wasm.arrayBuffer());
check(wasm.status === 200, 'the wasm route answers', `HTTP ${wasm.status}`);
check(bytes.subarray(0, 4).toString('hex') === '0061736d', 'it is a wasm binary', `${bytes.length} bytes`);
check(bytes.length === 26612, 'it is the official module size', `${bytes.length} bytes`);

console.log('\n\x1b[1m6. Mutations answer with JSON\x1b[0m');
const badGroup = await fetch(BASE + '/admin/qq/interject', {
  method: 'POST',
  headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ group: 'NOT_A_REAL_GROUP', perDay: '1', mode: 'random' }),
});
const badText = await badGroup.text();
let badJson = null;
try {
  badJson = JSON.parse(badText);
} catch {
  /* reported below */
}
check(badGroup.status === 400, 'an unknown group id is refused', `HTTP ${badGroup.status}`);
check(badJson?.ok === false, 'the refusal is JSON with ok:false');
check(/从未出现/.test(badJson?.detail ?? ''), 'and it explains why', badJson?.detail?.slice(0, 60));

console.log(`\n\x1b[1m${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
