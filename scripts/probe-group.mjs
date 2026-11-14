// Ask both QQ API hosts about one group, to settle what a 11292 means here.
//
// Read-only unless --send is passed.
import { readFileSync } from 'node:fs';

const ak = readFileSync('.dryrun/ak.txt', 'utf8').trim();
const group = process.argv[2];
const send = process.argv.includes('--send');
if (!group) {
  console.error('usage: node scripts/probe-group.mjs <GROUP_OPENID> [--send]');
  process.exit(2);
}

const url = `https://qq.hacknet.de5.net/qq/probe-group?group_openid=${encodeURIComponent(group)}${send ? '&send=1' : ''}`;
const res = await fetch(url, { headers: { authorization: `Bearer ${ak}` } });
const json = await res.json();

console.log(`\nHTTP ${res.status}   configured host: ${json.configuredHost}`);
console.log(`group_openid: ${json.groupOpenid}\n`);

const width = Math.max(...json.results.map((r) => r.label.length));
for (const r of json.results) {
  console.log(`[${r.label.padEnd(width)}] ${r.check.padEnd(15)} -> HTTP ${r.status}`);
  console.log(`   ${r.body}`);
  console.log('');
}

// Interpret, rather than leaving the reader to compare codes.
const by = (label, check) => json.results.find((r) => r.label === label && r.check === check);
const sbInfo = by('sandbox', 'group-info');
const prInfo = by('production', 'group-info');

console.log('=== reading ===');
if (sbInfo?.status === 200 && prInfo?.status !== 200) {
  console.log('  The sandbox host KNOWS this group, production does not.');
  console.log('  => it is a sandbox group; keep QQ_SANDBOX="true".');
} else if (prInfo?.status === 200 && sbInfo?.status !== 200) {
  console.log('  The production host KNOWS this group, sandbox does not.');
  console.log('  => it is a PRODUCTION group. QQ_SANDBOX="true" is why sending fails with 11292.');
  console.log('     Fix: set QQ_SANDBOX="false" and redeploy, or use a sandbox group instead.');
} else if (sbInfo?.status === 200 && prInfo?.status === 200) {
  console.log('  BOTH hosts know this group — unusual, and worth investigating before changing config.');
} else {
  console.log('  NEITHER host knows this group.');
  console.log('  => the group is not registered as a sandbox group either way.');
  console.log('     Fix: register it in 管理端 → 开发设置 → 沙箱配置, and make sure the bot is in the group.');
}
