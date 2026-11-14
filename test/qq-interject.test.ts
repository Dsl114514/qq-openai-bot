// The interjection scheduler.
//
// Three things here are easy to get subtly wrong, and each would fail in a way that looks like
// something else entirely:
//
//   - the timezone conversion, which would fire at the wrong hour (or never);
//   - the daily reset, where a stale counter would silently consume today's quota;
//   - the concurrency claim, where two requests both decide to speak and the bot double-posts.
//
// None of those are visible from the code, so they are asserted directly.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  MAX_PER_DAY,
  addDays,
  dayKeyInZone,
  drawNextDueAt,
  dueInterjection,
  getInterjectionConfig,
  interjectionStatus,
  markSent,
  normalizeConfig,
  setInterjectionConfig,
  zonedTimeToEpoch,
} from '../src/qq/interject';
import type { Env } from '../src/types';

/**
 * D1 stand-in supporting the app_state operations this module uses, including the CONDITIONAL
 * update that the claim depends on — a fake that ignored the `value = ?` clause would make the
 * concurrency test pass vacuously.
 */
function fakeDb(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  let failNextConditional = false;
  return {
    rows,
    /** Make the next conditional UPDATE match nothing, simulating a lost race. */
    loseNextRace() {
      failNextConditional = true;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const key = String(args[args.length - 2] ?? args[0] ?? '');
          return {
            async first<T>(): Promise<T | null> {
              const v = rows.get(String(args[0]));
              return (v === undefined ? null : { value: v }) as T;
            },
            async all<T>(): Promise<{ results: T[] }> {
              const prefix = String(args[0] ?? '').replace(/%$/, '');
              return {
                results: [...rows.entries()]
                  .filter(([k]) => k.startsWith(prefix))
                  .map(([k, v]) => ({ key: k, value: v })) as T[],
              };
            },
            async run() {
              if (/^\s*UPDATE\s+app_state/i.test(sql)) {
                // args: [newValue, key, expectedOldValue]
                const [newValue, updateKey, expected] = args as [string, string, string];
                if (failNextConditional) {
                  failNextConditional = false;
                  return { meta: { changes: 0 } };
                }
                if (rows.get(updateKey) !== expected) return { meta: { changes: 0 } };
                rows.set(updateKey, newValue);
                return { meta: { changes: 1 } };
              }
              if (/^\s*DELETE/i.test(sql)) {
                const had = rows.delete(key);
                return { meta: { changes: had ? 1 : 0 } };
              }
              if (/INSERT\s+INTO\s+app_state/i.test(sql)) {
                rows.set(String(args[0]), String(args[1]));
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

const envWith = (db: unknown, extra: Record<string, unknown> = {}): Env =>
  ({ DB: db, QQ_SESSION_TZ: 'Asia/Shanghai', ...extra }) as unknown as Env;

/** Always returns 0, so draws are deterministic without touching the real RNG. */
const zero = () => 0;
const half = () => 0.5;

describe('timezone conversion', () => {
  test('a local wall-clock time maps to the right instant', () => {
    // 09:00 in Shanghai (UTC+8) is 01:00 UTC.
    const t = zonedTimeToEpoch('2026-10-07', 9, 0, 'Asia/Shanghai');
    assert.equal(new Date(t).toISOString(), '2026-10-07T01:00:00.000Z');
  });

  test('a zone behind UTC maps the other way', () => {
    // 09:00 in New York on this date is 13:00 UTC (EDT, UTC-4).
    const t = zonedTimeToEpoch('2026-10-07', 9, 0, 'America/New_York');
    assert.equal(new Date(t).toISOString(), '2026-10-07T13:00:00.000Z');
  });

  test('the day key follows the zone, not UTC', () => {
    // 2026-10-07T16:30Z is already the 8th in Shanghai.
    const t = Date.parse('2026-10-07T16:30:00Z');
    assert.equal(dayKeyInZone(t, 'Asia/Shanghai'), '2026-10-08');
    assert.equal(dayKeyInZone(t, 'UTC'), '2026-10-07');
  });

  test('addDays crosses month and year boundaries', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

describe('config validation', () => {
  test('a perDay beyond the cap is clamped, not honoured', () => {
    assert.equal(normalizeConfig({ perDay: 1000 }).perDay, MAX_PER_DAY);
    assert.equal(normalizeConfig({ perDay: -5 }).perDay, 0);
    assert.equal(normalizeConfig({ perDay: 2.7 }).perDay, 2);
    assert.equal(normalizeConfig({}).perDay, 1, 'a missing value gets the default');
  });

  test('a malformed time is dropped rather than firing at a nonsense hour', () => {
    assert.equal(normalizeConfig({ mode: 'fixed', at: 'banana' }).at, undefined);
    assert.equal(normalizeConfig({ mode: 'fixed', at: '25:00' }).at, undefined);
    assert.equal(normalizeConfig({ mode: 'fixed', at: '9:00' }).at, undefined, 'must be zero-padded');
    assert.equal(normalizeConfig({ mode: 'fixed', at: '09:00' }).at, '09:00');
  });

  test('an unknown mode falls back to random', () => {
    assert.equal(normalizeConfig({ mode: 'hourly' as never }).mode, 'random');
  });

  test('empty text becomes undefined, which means "let the model comment"', () => {
    assert.equal(normalizeConfig({ text: '   ' }).text, undefined);
    assert.equal(normalizeConfig({ text: ' 早 ' }).text, '早');
  });

  test('the feature is off unless explicitly enabled', () => {
    assert.equal(normalizeConfig({}).enabled, false);
    assert.equal(normalizeConfig({ enabled: true }).enabled, true);
  });

  test('a stored config round-trips through validation', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', { enabled: true, perDay: 3, mode: 'fixed', at: '09:30', text: '早' });
    const got = await getInterjectionConfig(env, 'G1');
    assert.deepEqual(got, { enabled: true, perDay: 3, mode: 'fixed', at: '09:30', text: '早' });
  });

  test('an unconfigured group is off', async () => {
    const got = await getInterjectionConfig(envWith(fakeDb()), 'NEVER');
    assert.equal(got.enabled, false);
  });

  test('a corrupt config row is treated as off rather than crashing', async () => {
    const db = fakeDb({ 'interject_config:G1': '{not json' });
    assert.equal((await getInterjectionConfig(envWith(db), 'G1')).enabled, false);
  });
});

describe('drawing the next due time', () => {
  const base = { enabled: true, perDay: 1, mode: 'random' as const };

  test('random mode never lands in the past', () => {
    // A draw in the past would fire immediately, and every later check would re-draw another past
    // time — the feature would look like it fires constantly rather than randomly.
    const now = Date.parse('2026-10-07T02:00:00Z'); // 10:00 in Shanghai
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const due = drawNextDueAt(base, '2026-10-07', now, 'Asia/Shanghai', 0, () => r);
      assert.ok(due > now, `a draw of ${r} produced ${new Date(due).toISOString()}, which is not after now`);
    }
  });

  test('random draws stay inside the current day when there is time left', () => {
    const now = Date.parse('2026-10-07T02:00:00Z'); // 10:00 Shanghai
    const endOfDay = zonedTimeToEpoch('2026-10-08', 0, 0, 'Asia/Shanghai');
    const due = drawNextDueAt(base, '2026-10-07', now, 'Asia/Shanghai', 0, half);
    assert.ok(due <= endOfDay, 'should aim within today when hours remain');
  });

  test('with several per day, draws spread out instead of clustering', () => {
    const now = Date.parse('2026-10-07T02:00:00Z');
    const first = drawNextDueAt({ ...base, perDay: 4 }, '2026-10-07', now, 'Asia/Shanghai', 0, zero);
    const second = drawNextDueAt({ ...base, perDay: 4 }, '2026-10-07', now, 'Asia/Shanghai', 1, zero);
    assert.ok(second > first, 'the second slot must come after the first');
  });

  test('fixed mode lands exactly on the configured local time', () => {
    const now = Date.parse('2026-10-07T00:00:00Z'); // 08:00 Shanghai, before 09:00
    const due = drawNextDueAt(
      { enabled: true, perDay: 1, mode: 'fixed', at: '09:00' },
      '2026-10-07',
      now,
      'Asia/Shanghai',
      0,
      zero,
    );
    assert.equal(new Date(due).toISOString(), '2026-10-07T01:00:00.000Z');
  });

  test('fixed mode rolls to tomorrow once today\'s time has passed', () => {
    const now = Date.parse('2026-10-07T05:00:00Z'); // 13:00 Shanghai, after 09:00
    const due = drawNextDueAt(
      { enabled: true, perDay: 1, mode: 'fixed', at: '09:00' },
      '2026-10-07',
      now,
      'Asia/Shanghai',
      0,
      zero,
    );
    assert.equal(new Date(due).toISOString(), '2026-10-08T01:00:00.000Z', 'a fixed time means a time, not "as soon as possible"');
  });
});

describe('due decisions', () => {
  const cfg = { enabled: true, perDay: 2, mode: 'random' as const };
  const NOW = Date.parse('2026-10-07T06:00:00Z'); // 14:00 Shanghai

  test('a disabled group never speaks', async () => {
    const env = envWith(fakeDb());
    const d = await dueInterjection(env, 'G1', NOW, zero);
    assert.equal(d.due, false);
    assert.equal(d.reason, 'disabled');
  });

  test('the first check establishes a schedule instead of speaking immediately', async () => {
    // Speaking on the first ever check would mean the bot interjects the moment the feature is
    // switched on, which is not what "at a random time" means.
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', cfg);
    const d = await dueInterjection(env, 'G1', NOW, zero);
    assert.equal(d.due, false);
    assert.equal(d.reason, 'no-state');
    assert.ok(d.nextDueAt && d.nextDueAt > NOW);
  });

  test('it speaks once the stored time has passed', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', cfg);
    await dueInterjection(env, 'G1', NOW, zero); // establishes the schedule

    // Advance WITHIN the same day. Jumping a whole day would cross the daily boundary, which
    // deliberately starts fresh rather than firing — that is a different test.
    const day = dayKeyInZone(NOW, 'Asia/Shanghai');
    const stored = JSON.parse(db.rows.get('interject_state:G1') as string) as { nextDueAt: number };
    const later = stored.nextDueAt + 1000;
    assert.equal(dayKeyInZone(later, 'Asia/Shanghai'), day, 'the test must stay inside one day');

    const d = await dueInterjection(env, 'G1', later, zero);
    assert.equal(d.due, true, 'once the time has passed it must fire');
    assert.equal(d.claimed, true);
  });

  test('the quota stops it after perDay interjections', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', { ...cfg, perDay: 1 });
    const day = dayKeyInZone(NOW, 'Asia/Shanghai');
    // Pretend one was already sent today, with a time long past.
    db.rows.set('interject_state:G1', JSON.stringify({ day, sent: 1, nextDueAt: NOW - 1000 }));

    const d = await dueInterjection(env, 'G1', NOW, zero);
    assert.equal(d.due, false);
    assert.equal(d.reason, 'quota-used');
  });

  test('a new day resets the counter rather than consuming today\'s quota', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', { ...cfg, perDay: 1 });
    const yesterday = dayKeyInZone(NOW - 86_400_000, 'Asia/Shanghai');
    // Yesterday's quota was used up.
    db.rows.set('interject_state:G1', JSON.stringify({ day: yesterday, sent: 1, nextDueAt: NOW - 1000 }));

    const d = await dueInterjection(env, 'G1', NOW, zero);
    assert.equal(d.reason, 'no-state', 'a stale day must start fresh, not report quota-used');
    assert.equal(d.due, false, 'and it must not fire immediately either');
  });

  test('a lost race means staying quiet, not double-posting', async () => {
    // Two requests can both read "due" and both decide to speak. The conditional write is what
    // prevents the second from going through; if it did not, the group would see two identical
    // interjections.
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', cfg);
    const day = dayKeyInZone(NOW, 'Asia/Shanghai');
    db.rows.set('interject_state:G1', JSON.stringify({ day, sent: 0, nextDueAt: NOW - 1000 }));

    db.loseNextRace();
    const d = await dueInterjection(env, 'G1', NOW, zero);
    assert.equal(d.due, false, 'a lost claim must not report success');
    assert.equal(d.claimed, undefined);
  });

  test('perDay of 0 silences without discarding the settings', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', { ...cfg, perDay: 0 });
    const d = await dueInterjection(env, 'G1', NOW, zero);
    assert.equal(d.reason, 'quota-used');
    // And the rest of the config is still there, unlike disabling.
    assert.equal((await getInterjectionConfig(env, 'G1')).mode, 'random');
  });

  test('markSent does not throw when there is no state', async () => {
    await markSent(envWith(fakeDb()), 'G1');
  });

  test('status reports the config, the day and the next time', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', { enabled: true, perDay: 2, mode: 'fixed', at: '09:00', text: '早' });
    await dueInterjection(env, 'G1', NOW, zero);

    const s = await interjectionStatus(env, 'G1', NOW);
    assert.equal(s.config.enabled, true);
    assert.equal(s.config.at, '09:00');
    assert.equal(s.day, dayKeyInZone(NOW, 'Asia/Shanghai'));
    assert.equal(s.sent, 0);
    assert.ok(s.nextDueAt !== null, 'the next time should be known after a check');
  });

  test('changing the config clears the pending time so the old schedule cannot fire', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await setInterjectionConfig(env, 'G1', cfg);
    await dueInterjection(env, 'G1', NOW, zero);
    assert.ok(db.rows.has('interject_state:G1'));

    await setInterjectionConfig(env, 'G1', { ...cfg, perDay: 5 });
    assert.equal(db.rows.has('interject_state:G1'), false, 'the pending time must be recomputed');
  });
});
