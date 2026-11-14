// Settings, access rules, and scheduled tasks.
//
// These are the rules that decide what the bot DOES, so getting one wrong is not a display bug — it is the
// bot answering someone it should ignore, or staying silent when it was told to speak. The tests focus on
// the distinctions that are easy to collapse and expensive to get wrong:
//
//   - `undefined` (inherit) vs `false` (explicitly off);
//   - deny beating allow;
//   - an allowlist that defaults to refusing;
//   - a scheduled time that has PASSED still firing (a Worker has no clock and only runs on events).

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  personaPrefix,
} from '../src/settings';
import { normalizeAccess, checkAccess, DEFAULT_ACCESS, type AccessList } from '../src/qq/access';
import {
  normalizeTask,
  parseTime,
  parseCron,
  taskId,
  zonedNow,
} from '../src/qq/tasks';
import { splitList } from '../src/admin/settings-api';

const access = (over: Partial<AccessList> = {}): AccessList => ({ ...DEFAULT_ACCESS, ...over });

describe('settings normalisation', () => {
  test('an empty patch keeps the defaults', () => {
    const s = normalizeSettings({});
    assert.equal(s.modes.thinking, DEFAULT_SETTINGS.modes.thinking);
    assert.equal(s.allowProactive, true);
    assert.equal(s.model, DEFAULT_SETTINGS.model);
  });

  test('an explicit false is preserved, not treated as absent', () => {
    // `false` is a real value here. A truthiness check would silently turn it back on.
    const s = normalizeSettings({ modes: { thinking: false }, allowProactive: false });
    assert.equal(s.modes.thinking, false);
    assert.equal(s.allowProactive, false);
  });

  test('a partial modes patch does not clobber the other mode', () => {
    // The nesting is the trap: `{...{thinking}, ...{search}}` loses thinking.
    const s = normalizeSettings({ modes: { search: true } }, { ...DEFAULT_SETTINGS, modes: { thinking: true, search: false } });
    assert.equal(s.modes.thinking, true, 'thinking must survive a patch that only mentions search');
    assert.equal(s.modes.search, true);
  });

  test('a corrupt or hostile value falls back rather than breaking the bot', () => {
    const s = normalizeSettings({ modes: 'yes', persona: 123, model: '', allowProactive: 'true' });
    assert.equal(typeof s.modes.thinking, 'boolean');
    assert.equal(typeof s.persona, 'string');
    assert.equal(s.model, DEFAULT_SETTINGS.model, 'an empty model must not be stored');
    assert.equal(s.allowProactive, true, 'a non-boolean keeps the previous value');
  });

  test('over-long values are bounded', () => {
    const s = normalizeSettings({ persona: 'x'.repeat(10_000), model: 'y'.repeat(500) });
    assert.ok(s.persona.length <= 2000);
    assert.ok(s.model.length <= 64);
  });
});

describe('persona prefix', () => {
  test('is empty when unset, so nothing is prepended', () => {
    assert.equal(personaPrefix(''), '');
    assert.equal(personaPrefix('   '), '');
  });

  test('is delimited so the model can tell it from the user message', () => {
    // A bare sentence prepended to a message reads as part of that message — which is how "answer in
    // Cantonese" becomes a topic to discuss rather than an instruction to follow.
    const p = personaPrefix('用粤语回答');
    assert.ok(p.includes('用粤语回答'));
    assert.ok(p.indexOf('用粤语回答') > 0, 'the instruction must be preceded by a label');
    assert.ok(/\[.+\]/.test(p), 'a delimited block is what distinguishes it from the user text');
  });
});

describe('access rules', () => {
  test('the default is open, so an upgrade does not lock anyone out', () => {
    const d = checkAccess(normalizeAccess({}), { user: 'U1', group: 'G1' });
    assert.equal(d.allowed, true);
  });

  test('closed mode refuses an unlisted user AND group', () => {
    const rules = access({ mode: 'closed' });
    assert.equal(checkAccess(rules, { user: 'U1', group: 'G1' }).allowed, false);
    assert.equal(checkAccess(rules, { user: 'U1', group: 'G1' }).reason, 'not-listed');
  });

  test('closed mode admits a listed user or a listed group', () => {
    const byUser = access({ mode: 'closed', users: ['U1'] });
    assert.equal(checkAccess(byUser, { user: 'U1', group: 'G9' }).allowed, true, 'the user is on the list');

    const byGroup = access({ mode: 'closed', groups: ['G1'] });
    assert.equal(checkAccess(byGroup, { user: 'U9', group: 'G1' }).allowed, true, 'the group is on the list');
  });

  test('a direct message is never gated on a GROUP allowlist', () => {
    // A DM has no group, so requiring one would refuse every DM — never what an operator means.
    const rules = access({ mode: 'closed', groups: ['G1'] });
    const dm = checkAccess(rules, { user: 'U9', group: null });
    assert.equal(dm.allowed, false, 'not listed by user, so a closed bot still refuses');
    assert.equal(dm.reason, 'not-listed-dm');

    const listed = access({ mode: 'closed', users: ['U9'] });
    assert.equal(checkAccess(listed, { user: 'U9', group: null }).allowed, true);
  });

  test('deny beats allow', () => {
    // The only reading under which "deny" means anything: a stale allowlist entry must not re-enable
    // something blocked on purpose.
    const rules = access({ mode: 'open', deniedUsers: ['U1'] });
    assert.equal(checkAccess(rules, { user: 'U1', group: 'G1' }).allowed, false);

    const both = access({ mode: 'closed', users: ['U1'], deniedUsers: ['U1'] });
    assert.equal(checkAccess(both, { user: 'U1', group: 'G1' }).allowed, false, 'deny wins over the allowlist');
  });

  test('a denied group is refused even when the user is allowed', () => {
    const rules = access({ deniedGroups: ['G1'], users: ['U1'] });
    const d = checkAccess(rules, { user: 'U1', group: 'G1' });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'denied-group');
  });

  test('the reason names the cause, for the audit log', () => {
    // The user never sees this — telling them what to change would be a hint to an abuser.
    for (const [rules, ctx, expected] of [
      [access({ deniedUsers: ['U'] }), { user: 'U', group: 'G' }, 'denied-user'],
      [access({ deniedGroups: ['G'] }), { user: 'U', group: 'G' }, 'denied-group'],
      [access({ mode: 'closed' }), { user: 'U', group: 'G' }, 'not-listed'],
    ] as const) {
      assert.equal(checkAccess(rules, ctx).reason, expected);
    }
  });

  test('id lists are cleaned: trimmed, deduplicated, bounded, blanks dropped', () => {
    const n = normalizeAccess({ users: ['  A  ', 'A', '', 'B', null, 42 as never, 'C'.repeat(300)] });
    assert.deepEqual(n.users, ['A', 'B'], 'blanks, duplicates, non-strings and over-long ids are dropped');
  });

  test('an unknown mode falls back to open rather than inventing a third state', () => {
    assert.equal(normalizeAccess({ mode: 'nonsense' }).mode, 'open');
  });
});

describe('time parsing', () => {
  test('accepts what a person types and normalises it', () => {
    assert.equal(parseTime('9:30'), '09:30');
    assert.equal(parseTime('21:05'), '21:05');
    assert.equal(parseTime('00:00'), '00:00');
    assert.equal(parseTime(' 7:00 '), '07:00');
  });

  test('rejects impossible times rather than storing them', () => {
    for (const bad of ['24:00', '12:60', '25:99', 'abc', '', '12', '12:5', '12:005', '-1:00']) {
      assert.equal(parseTime(bad), null, `"${bad}" is not a time`);
    }
  });
});

describe('cron parsing', () => {
  test('the daily form expands to a time list', () => {
    const p = parseCron('30 21 * * *');
    assert.deepEqual(p?.times, ['21:30']);
    assert.deepEqual(p?.weekdays, []);
  });

  test('several hours expand to several times', () => {
    assert.deepEqual(parseCron('0 9,21 * * *')?.times.sort(), ['09:00', '21:00']);
  });

  test('the weekly form carries the days', () => {
    const p = parseCron('0 9 * * 1,5');
    assert.deepEqual(p?.times, ['09:00']);
    assert.deepEqual(p?.weekdays, [1, 5]);
  });

  test('Sunday is accepted as both 0 and 7, and normalised to 7', () => {
    // Cron uses 0 for Sunday; ISO uses 7. Accepting only one silently drops Sunday for half the users.
    assert.deepEqual(parseCron('0 9 * * 0')?.weekdays, [7]);
    assert.deepEqual(parseCron('0 9 * * 7')?.weekdays, [7]);
  });

  test('an unsupported expression is refused rather than guessed at', () => {
    // Mis-scheduling a task whose syntax was not really understood is worse than saying so.
    for (const bad of ['*/5 * * * *', '0 9 1 * *', '0 9 * 6 *', '0 9', '', 'a b c d e']) {
      assert.equal(parseCron(bad), null, `"${bad}" must be refused`);
    }
  });
});

describe('task normalisation', () => {
  test('a daily task needs at least one valid time', () => {
    const missing = normalizeTask({ group: 'G', name: 'A', kind: 'daily', times: [] });
    assert.ok('error' in missing);

    const bad = normalizeTask({ group: 'G', name: 'A', kind: 'daily', times: ['99:99'] });
    assert.ok('error' in bad, 'an invalid time must not count as one');
  });

  test('a comma-separated time string is split into separate times', () => {
    // MEASURED BUG: an API caller naturally sends `times=09:00, 21:30`, and treating that as one token
    // produced "至少需要一个有效时间" for input containing two valid times — a message that named the
    // requirement without revealing the value had never been split.
    //
    // This exercises the REAL `splitList` rather than a copy of it: a copy is free to drift, and a test
    // over a copy would keep passing while the shipped code changed.
    assert.deepEqual(splitList('09:00, 21:30'), ['09:00', '21:30']);
    assert.deepEqual(splitList('09:00，21:30'), ['09:00', '21:30'], 'a full-width comma is a comma');
    assert.deepEqual(splitList('09:00 21:30'), ['09:00', '21:30'], 'whitespace separates too');
    assert.deepEqual(splitList('09:00;21:30;'), ['09:00', '21:30'], 'a trailing separator is harmless');
    assert.deepEqual(splitList(['09:00', '21:30']), ['09:00', '21:30'], 'repeated keys still work');
    assert.deepEqual(splitList(''), [], 'an empty value is not one blank entry');
    assert.deepEqual(splitList(undefined), [], 'a missing value is not an error');
    assert.deepEqual(splitList(42), [], 'a non-string is ignored rather than coerced');

    // And the end-to-end consequence: the split values must be accepted as two times.
    const r = normalizeTask({ group: 'G', name: 'A', kind: 'daily', times: splitList('09:00, 21:30') });
    assert.ok('task' in r, 'two comma-separated times must be accepted');
    assert.deepEqual(r.task.times.sort(), ['09:00', '21:30']);
  });

  test('a weekly task also needs a day', () => {
    const noDays = normalizeTask({ group: 'G', name: 'A', kind: 'weekly', times: ['09:00'], weekdays: [] });
    assert.ok('error' in noDays);

    const ok = normalizeTask({ group: 'G', name: 'A', kind: 'weekly', times: ['09:00'], weekdays: [3] });
    assert.ok('task' in ok);
  });

  test('an empty text means generated content, not an empty message', () => {
    // The old interjection semantics: blank = let the model read the group. Sending "" would be a
    // zero-length message that QQ rejects, and it would look like the task was broken.
    const t = normalizeTask({ group: 'G', name: 'A', kind: 'daily', times: ['09:00'], text: '   ' });
    assert.ok('task' in t);
    assert.equal(t.task.content.kind, 'generated');
  });

  test('a fixed text is carried through, bounded', () => {
    const t = normalizeTask({ group: 'G', name: 'A', kind: 'daily', times: ['09:00'], text: '冒泡' });
    assert.ok('task' in t);
    assert.deepEqual(t.task.content, { kind: 'fixed', text: '冒泡' });

    const long = normalizeTask({ group: 'G', name: 'A', kind: 'daily', times: ['09:00'], text: 'x'.repeat(5000) });
    assert.ok('task' in long && long.task.content.kind === 'fixed');
    assert.ok((long.task.content as { text: string }).text.length <= 500);
  });

  test('an interval is clamped into a usable range', () => {
    // Too small would flood the group; too large is likely a typo for minutes.
    const tiny = normalizeTask({ group: 'G', name: 'A', kind: 'interval', everyMinutes: 1 });
    assert.ok('task' in tiny && tiny.task.everyMinutes >= 30);

    const huge = normalizeTask({ group: 'G', name: 'A', kind: 'interval', everyMinutes: 999_999 });
    assert.ok('task' in huge && huge.task.everyMinutes <= 7 * 24 * 60);
  });

  test('a missing group is refused — there is nowhere to post', () => {
    assert.ok('error' in normalizeTask({ name: 'A', kind: 'daily', times: ['09:00'] }));
  });

  test('weekdays are deduplicated and sorted', () => {
    const t = normalizeTask({ group: 'G', name: 'A', kind: 'weekly', times: ['09:00'], weekdays: [5, 1, 5, 3] });
    assert.ok('task' in t);
    assert.deepEqual(t.task.weekdays, [1, 3, 5]);
  });

  test('an out-of-range weekday is dropped rather than stored', () => {
    const t = normalizeTask({ group: 'G', name: 'A', kind: 'weekly', times: ['09:00'], weekdays: [0, 8, 2] });
    assert.ok('task' in t);
    assert.deepEqual(t.task.weekdays, [2]);
  });
});

describe('task identity', () => {
  test('the same name and group produce the same id, so saving twice updates', () => {
    // The console form has no id field, so a random id would create a duplicate on every save.
    assert.equal(taskId('G1', '早报'), taskId('G1', '早报'));
  });

  test('different names or groups produce different ids', () => {
    assert.notEqual(taskId('G1', 'A'), taskId('G1', 'B'));
    assert.notEqual(taskId('G1', 'A'), taskId('G2', 'A'));
  });

  test('the id is short and URL-safe', () => {
    const id = taskId('AC4FBFFF8A2C43F360F6A5B3D06DCB81', '每天早上提醒');
    assert.ok(/^[a-z0-9]+$/.test(id), `id must be safe to embed, got ${id}`);
    assert.ok(id.length <= 10);
  });

  test('the name is matched case-insensitively', () => {
    assert.equal(taskId('G', 'Daily'), taskId('G', 'daily'));
  });
});

describe('zoned clock', () => {
  test('reads the local wall clock, not UTC', () => {
    // 2026-10-10 13:00 UTC is 21:00 in Shanghai. Reading UTC here would schedule everything 8h off.
    const at = Date.UTC(2026, 9, 10, 13, 0, 0);
    const z = zonedNow(at, 'Asia/Shanghai');
    assert.equal(z.day, '2026-10-10');
    assert.equal(z.minutes, 21 * 60);
  });

  test('rolls the day over at local midnight, not UTC midnight', () => {
    // 16:30 UTC is 00:30 the NEXT day in Shanghai.
    const z = zonedNow(Date.UTC(2026, 9, 10, 16, 30, 0), 'Asia/Shanghai');
    assert.equal(z.day, '2026-10-11');
    assert.equal(z.minutes, 30);
  });

  test('midnight is 0 minutes, not 1440', () => {
    // Some ICU builds render midnight as hour "24", which would place it at the end of the day and make
    // every "00:00" task fire a day late.
    const z = zonedNow(Date.UTC(2026, 9, 10, 16, 0, 0), 'Asia/Shanghai');
    assert.equal(z.minutes, 0);
  });

  test('reports the ISO weekday', () => {
    // 2026-10-10 is a Saturday.
    const z = zonedNow(Date.UTC(2026, 9, 10, 4, 0, 0), 'Asia/Shanghai');
    assert.equal(z.weekday, 6);
  });

  test('an unknown zone does not throw', () => {
    // A bad QQ_SESSION_TZ must not take the whole scheduler down.
    assert.doesNotThrow(() => zonedNow(Date.now(), 'Not/AZone'));
  });
});
