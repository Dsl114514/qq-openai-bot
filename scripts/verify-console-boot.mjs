// Verify the LIVE bundle the browser receives, not the local build.
//
// THE GAP THIS CLOSES. `verify-console.mjs` asserted that the shell contains `<div id="app">`, and passed
// while the console rendered a BLANK PAGE. The shell was correct; the app that mounts into it was not. A
// check that stops at the HTML cannot see that, because the failure is in the JavaScript.
//
// So this inspects the deployed bundle for the evidence that distinguishes "compiled Vue app" from
// "component with a template string that runtime-only Vue silently ignores":
//
//   broken  -> the raw markup survives as a template STRING, and Vue's runtime-compiler warning is present
//   working -> the markup appears as a compiled props object, e.g. {class:"app-header"}
//
// It also asserts the shell's asset URLs and the bundle that is actually served agree, which is the other
// way a console goes blank while every status code stays 200.
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const ap = readFileSync('.dryrun/ap.txt', 'utf8').trim();
const basic = 'Basic ' + Buffer.from(`admin:${ap}`).toString('base64');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  if (!ok) failures++;
};

console.log('\n\x1b[1mLive console boot check\x1b[0m\n');

// ── fetch the shell, then the exact assets it names ───────────────────────────────────────────────
const shellRes = await fetch(`${BASE}/admin`, { headers: { authorization: basic } });
const shell = await shellRes.text();
check(shellRes.status === 200 && shell.includes('<div id="app">'), 'the shell is served with a mount point');

const srcMatch = shell.match(/<script[^>]*src="([^"]+)"/);
const hrefMatch = shell.match(/<link[^>]*href="([^"]+\.css)"/);
check(Boolean(srcMatch), 'the shell names a module script');
check(Boolean(hrefMatch), 'the shell names a stylesheet');

const jsUrl = srcMatch?.[1] ?? '';
const cssUrl = hrefMatch?.[1] ?? '';

const jsRes = await fetch(BASE + jsUrl, { headers: { authorization: basic } });
const js = await jsRes.text();
check(jsRes.status === 200, `the named bundle is served`, `${jsUrl} HTTP ${jsRes.status}`);
check(
  (jsRes.headers.get('content-type') ?? '').includes('javascript'),
  'it is served as JavaScript, not HTML',
  jsRes.headers.get('content-type') ?? '',
);
check(js.length > 50_000, 'the bundle is the real app', `${js.length} bytes`);

const cssRes = await fetch(BASE + cssUrl, { headers: { authorization: basic } });
const css = await cssRes.text();
check(cssRes.status === 200, 'the named stylesheet is served', `${cssUrl} HTTP ${cssRes.status}`);
check(css.includes(':root'), 'the stylesheet defines the theme variables');

console.log('\n\x1b[1mDoes the deployed bundle actually render?\x1b[0m');

// 1. The runtime-compiler warning means a template string reached runtime. With runtime-only Vue that is
//    a SILENT no-render, so its presence is a failure rather than a curiosity.
check(
  !js.includes('runtime compilation is not supported'),
  'no uncompiled template reached runtime',
  js.includes('runtime compilation is not supported') ? 'runtime-compiler warning present' : '',
);

// 2. The app's markup must appear as COMPILED output. After minification a compiled SFC emits a props
//    object literal for its classes and hundreds of element calls; an uncompiled one leaves the source
//    markup as a string.
//
//    THE CALL COUNT IS MATCHED WITHOUT NAMING THE HELPER. An earlier version counted `u("` because that
//    was what one build produced — and the next build renamed the helper, so the check failed on a
//    perfectly good bundle. The minifier is free to pick any short identifier, so this counts element
//    calls by their SHAPE (`name("`) rather than by a remembered name.
const compiledShell = /\{\s*class:\s*"app-header"/.test(js);
check(compiledShell, 'the app shell is compiled to render code', compiledShell ? '' : 'no {class:"app-header"} props object');

const elementCalls = (js.match(/\b[A-Za-z_$]{1,3}\("/g) ?? []).length;
check(elementCalls > 100, 'the bundle contains compiled element calls', `${elementCalls} calls`);

// 3. The views are lazily bundled into the same chunk here (no code splitting was configured), so their
//    strings are present. If they were missing, the shell would mount and every view would be blank.
check(js.includes('审计台'), 'the audit view is bundled', '');
check(js.includes('状态'), 'the status view is bundled', '');

// 4. A raw template literal for the shell would mean the root component is not compiled — the exact bug.
check(
  !/["'`]\s*<header class=\\?"app-header\\?">/.test(js),
  'the shell markup is NOT present as a template literal',
);

console.log('\n\x1b[1mDoes the app agree with the server about its own routes?\x1b[0m');
// Every API path the bundle calls must exist. A typo here produces a console that loads and then shows an
// error banner, which is a different bug from a blank page but just as invisible to a status-code check.
//
// THE MATCH MUST NOT BE A PREFIX. The regex below grabs `/admin/api/<word>`, but several real paths have a
// second segment (`/admin/api/export/calls`), so the scan also yields the bare prefix `/admin/api/export` —
// which is not a route and answers with the HTML shell. That looked like a missing endpoint until the
// extra segment was accounted for, so the pattern now captures the full path.
const apiPaths = [
  ...new Set([...js.matchAll(/["'`](\/admin\/api\/[a-z-]+(?:\/[a-z-]+)?)/g)].map((m) => m[1])),
];
check(apiPaths.length > 0, 'the bundle calls the JSON API', `${apiPaths.length} distinct paths`);

// A path that is a strict prefix of another is not itself called; the bundle only ever builds the longer
// form. Filtering avoids probing a route that does not exist by design.
const called = apiPaths.filter((p) => {
  if (p.endsWith('/export') || p.endsWith('/settings') || p.endsWith('/tasks')) {
    // These parents exist only as prefixes of real endpoints in this app.
    return false;
  }
  return true;
});

// Find a real call id to use, so the detail endpoint is tested the way the app calls it.
let sampleId = null;
const callsRes = await fetch(`${BASE}/admin/api/calls?limit=1`, { headers: { authorization: basic } });
if (callsRes.ok) {
  const body = await callsRes.json();
  sampleId = body.rows?.[0]?.id ?? null;
}

// The app has both GETs and POSTs, and probing a POST-only path with GET is not a missing route — that is
// why the server now answers an unknown API path with a JSON 404 rather than the HTML shell: a 200 with
// HTML in it hides a wrong-method call from both a person and a monitor.
const POSTS = new Set([
  '/admin/api/settings/global',
  '/admin/api/settings/group',
  '/admin/api/access',
  '/admin/api/tasks/save',
  '/admin/api/tasks/delete',
  '/admin/api/tasks/run',
  '/admin/api/tasks/migrate',
]);

for (const p of called) {
  const isPost = POSTS.has(p);
  const probe = p === '/admin/api/call' && sampleId !== null ? `${p}?id=${sampleId}` : p;

  if (isPost) {
    // An empty POST must be refused by VALIDATION (400 with a JSON reason), not by routing — which is what
    // proves the endpoint exists and is wired. A JSON 404 would mean the route is missing.
    const res = await fetch(BASE + probe, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });
    const type = res.headers.get('content-type') ?? '';
    const body = await res.json().catch(() => null);
    const wired = res.status !== 404 && type.includes('json');
    check(wired, `POST ${probe} is wired (rejects empty input)`, `HTTP ${res.status} ${body?.detail ?? body?.error?.message ?? ''}`);
  } else {
    const res = await fetch(BASE + probe, { headers: { authorization: basic } });
    const type = res.headers.get('content-type') ?? '';
    const okStatus = p === '/admin/api/call' && sampleId === null ? res.status === 400 : res.status === 200;
    check(okStatus && type.includes('json'), `${probe} exists and returns JSON`, `HTTP ${res.status} ${type}`);
  }
}
// The exports are downloads, so they are checked by requesting one directly.
const exportProbe = await fetch(`${BASE}/admin/api/export/calls?format=json&limit=1`, { headers: { authorization: basic } });
check(
  exportProbe.ok && (exportProbe.headers.get('content-type') ?? '').includes('json'),
  '/admin/api/export/calls exists and returns JSON',
  `HTTP ${exportProbe.status}`,
);

// A path that does not exist must be a JSON 404, not the HTML shell with status 200 — otherwise a mistyped
// endpoint fails inside JSON.parse with a message about an unexpected `<`, and the 200 hides it.
const noSuch = await fetch(`${BASE}/admin/api/definitely-not-a-route`, { headers: { authorization: basic } });
const noSuchType = noSuch.headers.get('content-type') ?? '';
const noSuchBody = await noSuch.json().catch(() => null);
check(noSuch.status === 404 && noSuchType.includes('json'), 'an unknown API path is a JSON 404', `HTTP ${noSuch.status} ${noSuchType}`);
check(typeof noSuchBody?.error === 'string', 'the 404 explains itself in JSON', String(noSuchBody?.error ?? '').slice(0, 40));

console.log(`\n\x1b[1m${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
