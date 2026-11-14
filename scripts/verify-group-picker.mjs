// Verify the group-selection fix.
//
// The failure being fixed: the form asked for a `group_openid` while the session list displayed the
// INTERNAL session identifier (`group:<group>:<member>`), so the value that got pasted never matched
// any event. The config saved, no error appeared, and the feature silently never fired.
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const ap = readFileSync('.dryrun/ap.txt', 'utf8').trim();
const basic = 'Basic ' + Buffer.from(`admin:${ap}`).toString('base64');

const post = (path, fields) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

const REAL_GROUP = 'AC4FBFFF8A2C43F360F6A5B3D06DCB81';
const BAD_KEY = `${REAL_GROUP}:B0780D7BE440143E5A2D23D7C7B99E72`; // the session-shaped value

console.log('\n=== the page now offers a dropdown of real groups ===');
const page = await (await fetch(BASE + '/admin/qq', { headers: { authorization: basic } })).text();
const hasSelect = /<select name="group"/.test(page);
const offersReal = page.includes(`value="${REAL_GROUP}"`);
console.log(`  dropdown present          : ${hasSelect ? 'YES' : 'NO'}`);
console.log(`  contains the real group   : ${offersReal ? 'YES' : 'NO'}`);
console.log(`  group name shown          : ${/都市的异想体|异想体/.test(page) ? 'YES' : 'no (falls back to the id)'}`);

console.log('\n=== saving the WRONG (session-shaped) value is refused ===');
let res = await post('/admin/qq/interject', {
  group: BAD_KEY,
  perDay: '1',
  mode: 'random',
  text: '冒泡',
  enabled: 'on',
});
let text = await res.text();
let note = text.match(/<p>([^<]*(?:从未出现|不会触发)[^<]*)<\/p>/);
console.log(`  HTTP ${res.status}`);
console.log(`  verdict: ${note ? note[1].slice(0, 150) : '(no explanatory note found)'}`);

console.log('\n=== saving the RIGHT value is accepted ===');
res = await post('/admin/qq/interject', {
  group: REAL_GROUP,
  perDay: '2',
  mode: 'fixed',
  at: '21:30',
  text: '冒泡',
  enabled: 'on',
});
text = await res.text();
note = text.match(/<p>([^<]*已保存[^<]*)<\/p>/);
console.log(`  HTTP ${res.status}`);
console.log(`  verdict: ${note ? note[1] : '(no note)'}`);

console.log('\n=== fire one on demand to prove the target is valid ===');
console.log('  (this posts a REAL message to the group)');
res = await post('/admin/qq/interject-test', { group: REAL_GROUP });
text = await res.text();
note = text.match(/<p>([^<]*(?:已发送|发送失败)[^<]*)<\/p>/);
console.log(`  HTTP ${res.status}`);
console.log(`  verdict: ${note ? note[1].slice(0, 160) : '(no note)'}`);

console.log('\n=== the invalid config should now be flagged in the table ===');
const after = await (await fetch(BASE + '/admin/qq', { headers: { authorization: basic } })).text();
console.log(`  an 无效 badge is shown: ${/无效/.test(after) ? 'YES' : 'no (nothing invalid is configured)'}`);
console.log('');
