// Verify the eight new capabilities against the live deployment.
//
// These are mostly WRITE paths, so this checks both directions: that the endpoint answers with the right
// shape, and that a refused input is refused with a REASON (a silent acceptance is the failure mode this
// project keeps hitting).
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'https://qq.hacknet.de5.net';
const basic = 'Basic ' + Buffer.from('admin:' + readFileSync('.dryrun/ap.txt', 'utf8').trim()).toString('base64');
const H = { authorization: basic };

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  if (!ok) failures++;
};

const getJson = async (p) => {
  const res = await fetch(BASE + p, { headers: H });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.json().catch(() => null) };
};

const post = async (p, fields) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('\n\x1b[1m1. Conversation history (the view that was lost in the Vue rewrite)\x1b[0m');
const hist = await getJson('/admin/api/history?limit=5');
check(hist.status === 200 && hist.type.includes('json'), 'the endpoint answers JSON');
check(Array.isArray(hist.body?.scopes), 'it lists the scopes it discovered', `${hist.body?.scopes?.length ?? 0} scopes`);
check(Array.isArray(hist.body?.turns), 'it returns extracted turns', `${hist.body?.turns?.length ?? 0} turns`);
const firstTurn = hist.body?.turns?.[0];
if (firstTurn) {
  check(typeof firstTurn.user === 'string' && firstTurn.user.length > 0, 'a turn carries the user text');
  check('reply' in firstTurn && 'kind' in firstTurn, 'a turn carries the reply and its kind', `kind=${firstTurn.kind}`);
  check(!/^\s*\{/.test(firstTurn.user), 'the text is EXTRACTED, not a raw JSON body');
} else {
  check(false, 'expected at least one turn', 'no history rows');
}

console.log('\n\x1b[1m2. Usage statistics\x1b[0m');
const stats = await getJson('/admin/api/stats?days=30');
check(stats.status === 200, 'the endpoint answers');
check(Array.isArray(stats.body?.days) && stats.body.days.length > 0, 'it buckets by day', `${stats.body?.days?.length ?? 0} days`);
check(typeof stats.body?.latency?.p50 === 'number', 'it computes percentiles', `p50=${stats.body?.latency?.p50} p95=${stats.body?.latency?.p95}`);
check(Array.isArray(stats.body?.byOrigin) && stats.body.byOrigin.length > 0, 'it breaks down by origin');
check(Array.isArray(stats.body?.byStatus), 'it breaks down by status');
// The day bucket must be LOCAL, not UTC: a UTC bucket would put an 09:00 Shanghai call on the prior day.
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
check(
  stats.body?.days?.some((d) => d.day === today),
  'today appears in the local-day bucket',
  `today=${today}, newest=${stats.body?.days?.at(-1)?.day}`,
);

console.log('\n\x1b[1m3. Settings: global defaults and per-group overrides\x1b[0m');
const settings = await getJson('/admin/api/settings');
check(settings.status === 200, 'the endpoint answers');
check(typeof settings.body?.global?.modes?.thinking === 'boolean', 'global defaults are typed', `thinking=${settings.body?.global?.modes?.thinking}`);
check(Array.isArray(settings.body?.knownGroups), 'it offers the known groups', `${settings.body?.knownGroups?.length ?? 0} groups`);

const group = settings.body?.knownGroups?.[0]?.openid;
if (group) {
  // Save an override, confirm it takes effect, then clear it — leaving the deployment as found.
  const saved = await post('/admin/api/settings/group', { group, thinking: 'true', allowProactive: 'true' });
  check(saved.body?.ok === true, 'a group override saves', saved.body?.detail);

  const after = await getJson('/admin/api/settings');
  const entry = after.body?.groups?.find((g) => g.group === group);
  check(entry?.effective?.modes?.thinking === true, 'the effective value reflects the override');
  check(entry?.override?.modes?.thinking === true, 'the stored override is shown separately from the effective value');
  check(entry?.overridden === true, 'the group is marked as overridden');

  const cleared = await post('/admin/api/settings/group', { group, clear: 'on' });
  check(cleared.body?.ok === true, 'the override can be cleared, restoring inheritance', cleared.body?.detail);
  const restored = await getJson('/admin/api/settings');
  check(!restored.body?.groups?.some((g) => g.group === group), 'the cleared group no longer has an override');
} else {
  check(false, 'a known group is required to test overrides', 'none discovered');
}

console.log('\n\x1b[1m4. Access rules\x1b[0m');
const access = await getJson('/admin/api/access');
check(access.status === 200, 'the endpoint answers');
check(access.body?.rules?.mode === 'open' || access.body?.rules?.mode === 'closed', 'it reports a mode', access.body?.rules?.mode);
check(Array.isArray(access.body?.rules?.deniedGroups), 'it carries a denylist');

// A round trip that leaves the rules as it found them.
const before = access.body.rules;
const roundTrip = await post('/admin/api/access', {
  mode: before.mode,
  deniedGroups: before.deniedGroups.join(','),
  deniedUsers: before.deniedUsers.join(','),
});
check(roundTrip.body?.ok === true, 'rules save and reload', roundTrip.body?.detail);
const afterAccess = await getJson('/admin/api/access');
check(afterAccess.body?.rules?.mode === before.mode, 'the mode survived the round trip');
check(
  afterAccess.body.rules.deniedGroups.length === before.deniedGroups.length,
  'the denylist survived the round trip',
  `${before.deniedGroups.length} → ${afterAccess.body.rules.deniedGroups.length}`,
);

console.log('\n\x1b[1m5. Scheduled tasks\x1b[0m');
const tasks = await getJson('/admin/api/tasks');
check(tasks.status === 200, 'the endpoint answers');
check(Array.isArray(tasks.body?.tasks), 'it lists tasks', `${tasks.body?.tasks?.length ?? 0} tasks`);
check(typeof tasks.body?.limits?.minIntervalMinutes === 'number', 'it publishes the limits it enforces', `min=${tasks.body?.limits?.minIntervalMinutes}min`);

// An unknown group must be refused WITH a reason — a silent accept would schedule a message that can never
// be delivered, which is the failure mode ADR-0015 documents.
const badGroup = await post('/admin/api/tasks/save', {
  group: 'NOT_A_REAL_GROUP',
  name: '测试',
  kind: 'daily',
  times: '09:00',
  enabled: 'true',
});
check(badGroup.status === 400 && badGroup.body?.ok === false, 'an unseen group id is refused', `HTTP ${badGroup.status}`);
check(/从未出现/.test(badGroup.body?.detail ?? ''), 'the refusal explains why', badGroup.body?.detail?.slice(0, 50));

// A malformed time must be refused rather than stored.
const badTime = await post('/admin/api/tasks/save', {
  group: group ?? 'G',
  name: '测试',
  kind: 'daily',
  times: '99:99',
  enabled: 'true',
});
check(badTime.body?.ok === false, 'an impossible time is refused', badTime.body?.detail);

// An unsupported cron expression must be refused rather than mis-scheduled.
const badCron = await post('/admin/api/tasks/save', {
  group: group ?? 'G',
  name: '测试',
  kind: 'daily',
  cron: '*/5 * * * *',
  enabled: 'true',
});
check(badCron.body?.ok === false, 'an unsupported cron is refused rather than guessed', badCron.body?.detail?.slice(0, 60));

console.log('\n\x1b[1m6. Exports stream real files\x1b[0m');
for (const [path, expect] of [
  ['/admin/api/export/calls?format=json&limit=5', 'application/json'],
  ['/admin/api/export/calls?format=csv', 'text/csv'],
  ['/admin/api/export/sessions?format=json', 'application/json'],
  ['/admin/api/export/sessions?format=csv', 'text/csv'],
]) {
  const res = await fetch(BASE + path, { headers: H });
  const type = res.headers.get('content-type') ?? '';
  const disp = res.headers.get('content-disposition') ?? '';
  const text = await res.text();
  check(res.status === 200 && type.includes(expect.split('/')[1]), `${path} → ${type.split(';')[0]}`, `${text.length}B`);
  check(/attachment; filename=/.test(disp), `  it downloads rather than rendering`, disp.replace(/.*filename=/, ''));
}

// The CSV must be correctly escaped: the bodies contain quotes, commas AND newlines.
//
// SPLITTING ON \r\n DOES NOT WORK, and that is the point of the check: a body containing a newline is
// quoted, so its newline is INSIDE a field and must not start a new row. Naively splitting would report a
// perfectly good file as broken (or, worse, a broken file as fine). So the file is parsed properly.
const csvRes = await fetch(BASE + '/admin/api/export/calls?format=csv', { headers: H });
const csv = await csvRes.text();
const header = csv.slice(0, csv.indexOf('\n')).trim();
check(header.startsWith('id,created_at,origin'), 'the CSV has a header row', header.slice(0, 40));
check(!/# ERROR:/.test(csv), 'the CSV contains no streamed error', csv.match(/# ERROR:.*/)?.[0] ?? '');

/** Split a CSV document into rows, respecting quoted newlines. */
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // an escaped quote
        else inQuotes = false;
      } else {
        field += c;                                       // includes \r and \n inside a quoted field
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // part of a \r\n row separator; handled by the \n branch
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const parsed = csvRows(csv);
check(parsed.length > 1, 'the CSV parses into rows', `${parsed.length - 1} data rows`);

const expected = parsed[0].length;
const badRows = parsed.slice(1).filter((r) => r.length !== expected);
check(
  badRows.length === 0,
  'every CSV row has the same field count',
  `${badRows.length} malformed of ${parsed.length - 1}, expected ${expected} fields`,
);
if (badRows.length > 0) console.log(`    \x1b[2mfirst bad row: ${JSON.stringify(badRows[0]).slice(0, 140)}\x1b[0m`);

// The decisive check that the bodies are intact: a row whose request_body is valid JSON means the quoting
// round-tripped — quotes, commas and newlines all survived.
const bodyIndex = parsed[0].indexOf('request_body');
const withBody = parsed.slice(1).find((r) => r[bodyIndex]?.trim().startsWith('{'));
check(Boolean(withBody), 'a data row carries a parseable request body');
if (withBody) {
  let parsedBody = null;
  try { parsedBody = JSON.parse(withBody[bodyIndex]); } catch { /* reported below */ }
  check(parsedBody !== null, 'the exported body round-trips as JSON after CSV escaping');
}

console.log('\n\x1b[1m7. The session-cleanup endpoint is now reachable from the console\x1b[0m');
const purge = await post('/admin/qq/purge-sessions', { days: '365' });
check(purge.status === 200 && purge.body?.ok === true, 'purging old sessions answers with a result', purge.body?.detail);

console.log('\n\x1b[1m8. Workbench thread state\x1b[0m');
const wb = await getJson('/admin/workbench/session');
check(wb.status === 200, 'the endpoint answers');
check(typeof wb.body?.current === 'boolean', 'it reports whether the thread would be CONTINUED', `current=${wb.body?.current}`);
check(typeof wb.body?.reason === 'string' && wb.body.reason.length > 0, 'and says why in words', wb.body?.reason);

console.log(`\n\x1b[1m${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
