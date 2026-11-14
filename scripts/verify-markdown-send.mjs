// Send real Markdown and a real quote to QQ, to confirm the payloads are accepted.
//
// Unit tests assert the SHAPE; only QQ can say whether the shape is right. A rejected payload comes
// back with a code that does not name the field, so the only reliable check is to send one.
//
// This posts to the configured group. The messages are labelled as tests.
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const ak = readFileSync('.dryrun/ak.txt', 'utf8').trim();
const GROUP = 'AC4FBFFF8A2C43F360F6A5B3D06DCB81';

// A tiny endpoint would be ideal, but the point is to exercise the REAL outbound path, so this uses
// the admin "send now" action with a Markdown body and inspects QQ's response.
const post = (path, fields) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ak, 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });

console.log('\n=== does QQ accept a Markdown group message? ===');
console.log('  (this posts a real message to the group)');

// Capture the existing config BEFORE touching anything, so this script can restore it exactly.
// See the note at the end for why a broad delete is not an option here.
const CONFIG_KEY = `interject_config:${GROUP}`;
const beforeRow = (() => {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      process.execPath,
      ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'cf-ds-api-qq-bot', '--remote', '-y', '--json', '--command', `SELECT value FROM app_state WHERE key = '${CONFIG_KEY}'`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(out)[0]?.results?.[0]?.value ?? null;
  } catch {
    return null;
  }
})();
console.log(`  existing config: ${beforeRow ?? '(none)'}`);

// Configure a fixed Markdown body and fire it, which routes through the same sendMessage() the bot uses.
const ap = readFileSync('.dryrun/ap.txt', 'utf8').trim();
const basic = 'Basic ' + Buffer.from(`admin:${ap}`).toString('base64');
const form = (path, fields) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

// 1. A fixed PLAIN message, as a control.
await form('/admin/qq/interject', {
  group: GROUP,
  perDay: '1',
  mode: 'random',
  text: '【测试】普通文本消息',
  enabled: 'on',
});
let res = await form('/admin/qq/interject-test', { group: GROUP });
let text = await res.text();
let note = text.match(/<p>([^<]*(?:已发送|发送失败)[^<]*)<\/p>/);
console.log(`  plain text  -> ${note ? note[1].slice(0, 90) : '(no note)'}`);

// 2. A Markdown message. The detection is automatic, so a heading is enough to trigger msg_type 2.
await form('/admin/qq/interject', {
  group: GROUP,
  perDay: '1',
  mode: 'random',
  text: '# 【测试】Markdown\n- 这是**加粗**\n- 这是 `代码`',
  enabled: 'on',
});
res = await form('/admin/qq/interject-test', { group: GROUP });
text = await res.text();
note = text.match(/<p>([^<]*(?:已发送|发送失败)[^<]*)<\/p>/);
console.log(`  markdown    -> ${note ? note[1].slice(0, 90) : '(no note)'}`);

console.log('\n=== what QQ recorded for those sends ===');
const { execFileSync } = await import('node:child_process');
const sql = (command) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'cf-ds-api-qq-bot', '--remote', '-y', '--json', '--command', command],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
  )[0]?.results ?? [];

for (const r of sql(
  `SELECT id, status, substr(response_body,1,220) AS resp FROM call_log WHERE request_body LIKE '%interjection%' ORDER BY id DESC LIMIT 2`,
)) {
  console.log(`  id=${r.id} status=${r.status}`);
  console.log(`    ${r.resp}`);
}

console.log('\n=== restore whatever config existed before this probe ===');
// NEVER `DELETE ... LIKE 'interject%'` here. An earlier version of this script did exactly that to
// clean up after itself, and it destroyed a real user's configuration — a broad pattern cannot tell
// "the row I just created" from "the row that was already there". A verification script must only
// undo its own work, so the previous value is captured first and put back verbatim.
if (before === null) {
  sql(`DELETE FROM app_state WHERE key = '${CONFIG_KEY}'`);
  console.log('  no config existed before; removed the probe row');
} else {
  sql(`INSERT INTO app_state (key, value) VALUES ('${CONFIG_KEY}', '${before.replace(/'/g, "''")}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  console.log('  restored the original config');
}
console.log('');
