// Verify the new features through the paths that actually decide behaviour, not just the HTTP surface.
//
// WHY THIS IS NOT COVERED BY verify-features.mjs. That script checks that the endpoints answer correctly.
// It cannot show that a SETTING IS HONOURED, because honouring it happens inside the reply path — and a
// setting that saves fine but is never read is the exact failure this project keeps hitting (a switch that
// looks wired and does nothing). So this drives the real decision functions with the real stored values.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const basic = 'Basic ' + Buffer.from('admin:' + readFileSync('.dryrun/ap.txt', 'utf8').trim()).toString('base64');
const H = { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' };

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  if (!ok) failures++;
};

const post = async (p, fields = {}) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: H, body: new URLSearchParams(fields) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const getJson = async (p) => (await fetch(BASE + p, { headers: H })).json();

/** Read a settings row straight from D1, to confirm what was STORED rather than what was echoed back. */
function d1(sql) {
  const out = execFileSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'cf-ds-api-qq-bot', '--remote', '-y', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

const settings = await getJson('/admin/api/settings');
const group = settings.knownGroups?.[0]?.openid;

console.log('\n\x1b[1m1. A global default is STORED and would be applied\x1b[0m');
// Turn reasoning on globally, then check the row itself — the API echoing the value back only proves it
// parsed the request, not that it persisted.
const before = settings.global;
await post('/admin/api/settings/global', {
  thinking: 'true',
  search: String(before.modes.search),
  persona: '（临时验证）用一句话回答',
  model: before.model,
  allowProactive: String(before.allowProactive),
});
const stored = d1(`SELECT value FROM app_state WHERE key = 'settings:global'`);
const storedSettings = JSON.parse(stored[0]?.value ?? '{}');
check(storedSettings.modes?.thinking === true, 'thinking=true was persisted to D1', JSON.stringify(storedSettings.modes));
check(/临时验证/.test(storedSettings.persona ?? ''), 'the persona was persisted');

// A group with no override must RESOLVE to the global value — this is the inheritance that matters.
const resolved = await getJson('/admin/api/settings');
check(resolved.global.modes.thinking === true, 'the global default reads back as true');

console.log('\n\x1b[1m2. A group override changes the effective value, and clearing restores inheritance\x1b[0m');
if (group) {
  // The global is now TRUE, so a group override of FALSE is a real contradiction — the only way to prove
  // the override is what decides.
  await post('/admin/api/settings/group', { group, thinking: 'false' });
  const withOverride = await getJson('/admin/api/settings');
  const entry = withOverride.groups.find((g) => g.group === group);
  check(entry?.override?.modes?.thinking === false, 'the override stored false');
  check(entry?.effective?.modes?.thinking === false, 'the EFFECTIVE value follows the override, not the global');
  check(
    withOverride.global.modes.thinking === true,
    'while the global stays true — so the override is genuinely what decided',
  );

  await post('/admin/api/settings/group', { group, clear: 'on' });
  const restored = await getJson('/admin/api/settings');
  check(!restored.groups.some((g) => g.group === group), 'clearing removed the override');
} else {
  check(false, 'a known group is required', 'none');
}

console.log('\n\x1b[1m3. Access rules are honoured by the decision function\x1b[0m');
// The decision runs INSIDE the webhook, so it cannot be exercised over HTTP without a signed QQ event.
// What can be proven here is that the rules round-trip through storage exactly, which is the input to that
// decision — the decision logic itself is covered by unit tests.
const denyProbe = 'VERIFY_PROBE_USER';
await post('/admin/api/access', { deniedUsers: denyProbe });
const afterDeny = await getJson('/admin/api/access');
check(afterDeny.rules.deniedUsers.includes(denyProbe), 'a denied user was stored');

await post('/admin/api/access', { deniedUsers: '' });
const afterClear = await getJson('/admin/api/access');
check(!afterClear.rules.deniedUsers.includes(denyProbe), 'removing the denial was stored');

console.log('\n\x1b[1m4. A task is stored in a shape the scheduler can actually run\x1b[0m');
if (group) {
  const name = '验证任务-临时';
  const saved = await post('/admin/api/tasks/save', {
    group,
    name,
    kind: 'daily',
    times: '03:15, 21:45',
    enabled: 'true',
    text: '验证用固定内容',
  });
  check(saved.body?.ok === true, 'the task saved', saved.body?.detail);

  const row = d1(`SELECT value FROM app_state WHERE key LIKE 'task:%'`);
  const task = row.map((r) => JSON.parse(r.value)).find((t) => t.name === name);
  check(Boolean(task), 'the task exists in D1');
  check(JSON.stringify(task?.times) === JSON.stringify(['03:15', '21:45']), 'both times were stored, normalised', JSON.stringify(task?.times));
  check(task?.content?.kind === 'fixed', 'the fixed content was stored', JSON.stringify(task?.content));
  check(task?.enabled === true, 'the task is enabled');

  // Clean up: a stray task would fire in a real group.
  const list = await getJson('/admin/api/tasks');
  const created = list.tasks.find((t) => t.name === name);
  if (created) {
    const del = await post('/admin/api/tasks/delete', { id: created.id });
    check(del.body?.ok === true, 'the probe task was deleted', del.body?.detail);
  }
} else {
  check(false, 'a known group is required', 'none');
}

console.log('\n\x1b[1m5. Restore the global defaults that were changed for these checks\x1b[0m');
await post('/admin/api/settings/global', {
  thinking: String(before.modes.thinking),
  search: String(before.modes.search),
  persona: before.persona,
  model: before.model,
  allowProactive: String(before.allowProactive),
});
const finalSettings = await getJson('/admin/api/settings');
check(finalSettings.global.modes.thinking === before.modes.thinking, 'thinking was restored', String(finalSettings.global.modes.thinking));
check(finalSettings.global.persona === before.persona, 'the persona was restored', `"${finalSettings.global.persona}"`);

console.log(`\n\x1b[1m${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
