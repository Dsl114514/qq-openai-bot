#!/usr/bin/env node
/**
 * Driver for the OpenAI-compatible endpoint.
 *
 * A completion is ONE POST — no challenge loop to walk, which is why this file is short where its
 * predecessor needed a PoW chunk scheduler. It exists so an operator can exercise the deployed API
 * from a terminal without curl quoting getting in the way.
 *
 * Usage
 *   node scripts/chat.mjs "your question"
 *   node scripts/chat.mjs --session mykey "..."   continue the server-managed conversation `mykey`
 *
 * Environment
 *   BASE_URL     default http://127.0.0.1:8787  (wrangler dev) or your deployed URL
 *   ACCESS_KEY   required unless ADMIN_PASSWORD is set (which authenticates as the workbench)
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
// Strip ANSI escapes: a shell that captured PowerShell output can leave SGR sequences in the
// value, which makes a credential look present while sending a header that is not the key.
const clean = (v) => (v ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
const ACCESS_KEY = clean(process.env.ACCESS_KEY);
const ADMIN_PASSWORD = clean(process.env.ADMIN_PASSWORD);

const argv = process.argv.slice(2);
const sessionIdx = argv.indexOf('--session');
const sessionKey = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
const prompt = argv.filter((a, i) => a !== '--session' && i !== sessionIdx + 1 && !(i === sessionIdx + 1)).join(' ');

if (!prompt.trim()) {
  console.error('usage: node scripts/chat.mjs [--session <key>] "your question"');
  process.exit(2);
}

const headers = { 'content-type': 'application/json' };
if (ACCESS_KEY) headers.authorization = `Bearer ${ACCESS_KEY}`;
else if (ADMIN_PASSWORD) headers.authorization = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64');
else {
  console.error('ACCESS_KEY or ADMIN_PASSWORD must be set');
  process.exit(2);
}

const body = {
  messages: [{ role: 'user', content: prompt }],
  ...(sessionKey ? { session_key: sessionKey } : {}),
};

const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error(`HTTP ${res.status} — body was not JSON:\n${text.slice(0, 500)}`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`HTTP ${res.status}: ${json.error?.message ?? text.slice(0, 300)}`);
  process.exit(1);
}

console.log(json.choices?.[0]?.message?.content ?? '（空响应）');
const endpoint = json.endpoint ? `  [endpoint: ${json.endpoint}]` : '';
console.error(`\n${json.usage?.total_tokens ?? '?'} tokens${endpoint}`);
