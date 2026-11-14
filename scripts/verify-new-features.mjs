// Verify both new features against the live deployment.
//
//   1. A session can be kept (pinned), and the pin actually survives the day boundary.
//   2. An interjection can be configured, and fired on demand — which is the only way to test a
//      deliberately unpredictable schedule.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const ap = readFileSync('.dryrun/ap.txt', 'utf8').trim();
const basic = 'Basic ' + Buffer.from(`admin:${ap}`).toString('base64');

const sql = (command) => {
  // The wrangler CLI occasionally fails a remote query with a transient "fetch failed". Retrying
  // here keeps a network blip from looking like a feature failure, which would be a misleading
  // result from a verification script.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(
        execFileSync(
          process.execPath,
          ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'cf-ds-api-qq-bot', '--remote', '-y', '--json', '--command', command],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      )[0]?.results ?? [];
    } catch (e) {
      lastError = e;
      // A short pause: these failures are usually a dropped connection, not a bad query.
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1200)']);
    }
  }
  throw lastError;
};

const post = (path, fields) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

const get = (path) => fetch(BASE + path, { headers: { authorization: basic } });

const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

console.log('\n=== 1. KEEP A SESSION (pin) ===');
const KEY = 'qq_session:c2c:PIN_PROBE';
sql(
  `INSERT INTO app_state (key, value) VALUES ('${KEY}', '${JSON.stringify({ sessionId: 'pin-probe-session', lastMessageId: '7', day: '2000-01-01', updatedAt: 1 })}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);
console.log('  seeded a session dated 2000-01-01 (i.e. long expired)');

let res = await post('/admin/qq/pin-session', { id: 'c2c:PIN_PROBE', pinned: 'true' });
let text = await res.text();
let note = text.match(/<p>([^<]*保留[^<]*)<\/p>/);
console.log(`  pin -> HTTP ${res.status}${note ? `: ${note[1]}` : ''}`);

const stored = JSON.parse(sql(`SELECT value FROM app_state WHERE key = '${KEY}'`)[0]?.value ?? '{}');
console.log(`  stored pinned flag: ${stored.pinned}`);

// The decisive check: the admin list must show it as live despite its ancient date.
res = await get('/admin/qq');
text = await res.text();
const showsPinned = /已保留/.test(text);
const showsPermanent = /永久保留/.test(text);
console.log(`  listed as 已保留: ${showsPinned ? 'YES' : 'NO'}`);
console.log(`  listed as 永久保留 (live despite the old date): ${showsPermanent ? 'YES' : 'NO'}`);

res = await post('/admin/qq/pin-session', { id: 'c2c:PIN_PROBE', pinned: 'false' });
console.log(`  unpin -> HTTP ${res.status}, stored flag now: ${JSON.parse(sql(`SELECT value FROM app_state WHERE key = '${KEY}'`)[0]?.value ?? '{}').pinned}`);
sql(`DELETE FROM app_state WHERE key = '${KEY}'`);

console.log('\n=== 2. CONFIGURE AN INTERJECTION ===');
const GROUP = 'AC4FBFFF8A2C43F360F6A5B3D06DCB81';
res = await post('/admin/qq/interject', {
  group: GROUP,
  perDay: '2',
  mode: 'random',
  at: '',
  text: '（测试消息，来自后台配置）',
  enabled: 'on',
});
text = await res.text();
note = text.match(/<p>([^<]*已保存[^<]*)<\/p>/);
console.log(`  save -> HTTP ${res.status}${note ? `: ${note[1]}` : ''}`);

const cfgRow = sql(`SELECT value FROM app_state WHERE key = 'interject_config:${GROUP}'`)[0]?.value;
console.log(`  stored config: ${cfgRow}`);

console.log('\n=== 3. FIRE ONE ON DEMAND ===');
console.log('  (this posts a REAL message to the group)');
res = await post('/admin/qq/interject-test', { group: GROUP });
text = await res.text();
note = text.match(/<p>([^<]*(已发送|发送失败)[^<]*)<\/p>/);
console.log(`  test -> HTTP ${res.status}${note ? `: ${note[1]}` : ''}`);

console.log('\n=== 4. THE SCHEDULE IS ARMED (not fired immediately) ===');
const stateRow = sql(`SELECT value FROM app_state WHERE key = 'interject_state:${GROUP}'`)[0]?.value;
if (stateRow) {
  const st = JSON.parse(stateRow);
  const next = new Date(st.nextDueAt);
  console.log(`  day=${st.day} sent=${st.sent} next=${next.toISOString()}`);
  console.log(`  next is in the future: ${st.nextDueAt > Date.now() ? 'YES' : 'NO — would fire immediately'}`);
} else {
  console.log('  (no state row yet — it is created on the first event-driven check)');
}

console.log('\n=== 5. DISABLE IT AGAIN ===');
res = await post('/admin/qq/interject', { group: GROUP, perDay: '1', mode: 'random', at: '', text: '', enabled: 'off' });
text = await res.text();
note = text.match(/<p>([^<]*已保存[^<]*)<\/p>/);
console.log(`  disable -> HTTP ${res.status}${note ? `: ${note[1]}` : ''}`);
console.log(`  stored: ${sql(`SELECT value FROM app_state WHERE key = 'interject_config:${GROUP}'`)[0]?.value}`);

// Leave the group unconfigured rather than enabled with a test message.
sql(`DELETE FROM app_state WHERE key IN ('interject_config:${GROUP}', 'interject_state:${GROUP}')`);
console.log('  (probe config removed)');
console.log('');
