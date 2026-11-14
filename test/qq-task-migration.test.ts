// Migrating the legacy interjection config into tasks.
//
// REGRESSION TEST FOR A MEASURED BUG. The first version called `saveTask` unconditionally on every run, and
// the scheduler invokes the migration on EVERY incoming message. So an edit made in the console was silently
// reverted to the old config's value by the next group message — observed live, where a task's content went
// back from the operator's new value to the old one, with nothing in the logs to explain it.
//
// The rule the tests pin down is the one an operator expects:
//
//   edit the TASK        -> the old config is unchanged, so nothing overwrites it
//   edit the OLD CONFIG  -> the task is updated to match

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import { migrateInterjections, listTasks, getTask, MIGRATED_TASK_NAME } from '../src/qq/tasks';
import type { Env } from '../src/types';

/**
 * A D1 stand-in covering the statements this module issues: point reads, an upsert, a `LIKE` scan, and an
 * `IN (?, ?)` delete.
 *
 * Keyed by the literal SQL the real code sends, because the point of the fake is to answer the queries that
 * are actually made — a fake that responds to "any select" would let a wrong query pass.
 */
function fakeDb(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              const v = rows.get(String(args[0]));
              return (v === undefined ? null : { value: v }) as T;
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (/LIKE/i.test(sql)) {
                const pattern = String(args[0]).replace(/%$/, '');
                return {
                  results: [...rows.entries()]
                    .filter(([k]) => k.startsWith(pattern))
                    .map(([k, v]) => ({ key: k, value: v })) as T[],
                };
              }
              const ids = args.map(String);
              return { results: ids.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k)! })) as T[] };
            },
            async run() {
              if (/^\s*DELETE/i.test(sql)) {
                if (/IN\s*\(/i.test(sql)) {
                  let n = 0;
                  for (const k of args.map(String)) if (rows.delete(k)) n++;
                  return { meta: { changes: n } };
                }
                const had = rows.delete(String(args[0]));
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
    // `all()` without `.bind()` is not used by these modules, but the type requires the shape.
    async batch() {
      return [];
    },
  };
}

const GROUP = 'AC4FBFFF8A2C43F360F6A5B3D06DCB81';
const envWith = (db: unknown): Env => ({ DB: db, QQ_SESSION_TZ: 'Asia/Shanghai' }) as unknown as Env;

const legacy = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ enabled: true, perDay: 1, mode: 'random', text: '冒泡', ...over });

describe('legacy interjection migration', () => {
  test('a legacy config becomes a task', async () => {
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy() }));
    const r = await migrateInterjections(env);
    assert.equal(r.migrated, 1);
    assert.equal(r.groups[0], GROUP);

    const tasks = await listTasks(env);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].group, GROUP);
    assert.equal(tasks[0].name, MIGRATED_TASK_NAME);
    assert.deepEqual(tasks[0].content, { kind: 'fixed', text: '冒泡' });
  });

  test('a random per-day config becomes a daily interval', async () => {
    // A random time has no slot to carry over, so it becomes an interval — the observable behaviour is
    // "roughly once a day", which is what the old setting meant.
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy({ perDay: 2 }) }));
    await migrateInterjections(env);
    const t = (await listTasks(env))[0];
    assert.equal(t.kind, 'interval');
    assert.equal(t.everyMinutes, 720, 'twice a day is every 12 hours');
  });

  test('a fixed-time config becomes a daily task at that time', async () => {
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy({ mode: 'fixed', at: '21:30', perDay: 1 }) }));
    await migrateInterjections(env);
    const t = (await listTasks(env))[0];
    assert.equal(t.kind, 'daily');
    assert.deepEqual(t.times, ['21:30']);
  });

  test('an empty text becomes generated content, not an empty message', async () => {
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy({ text: '' }) }));
    await migrateInterjections(env);
    assert.deepEqual((await listTasks(env))[0].content, { kind: 'generated' });
  });

  test('a disabled config is left alone', async () => {
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy({ enabled: false }) }));
    const r = await migrateInterjections(env);
    assert.equal(r.migrated, 0);
    assert.equal((await listTasks(env)).length, 0);
  });

  test('a corrupt config does not stop the others', async () => {
    // One unreadable row must not prevent a valid one from migrating.
    const env = envWith(
      fakeDb({ [`interject_config:${GROUP}`]: '{not json', 'interject_config:ANOTHER': legacy({ text: '嗨' }) }),
    );
    const r = await migrateInterjections(env);
    assert.equal(r.migrated, 1);
    assert.equal(r.groups[0], 'ANOTHER');
  });

  test('running twice does not duplicate or rewrite the task', async () => {
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy() }));
    await migrateInterjections(env);
    const first = (await listTasks(env))[0];

    const second = await migrateInterjections(env);
    assert.equal(second.migrated, 0, 'an unchanged config must not re-migrate');
    assert.equal(second.skipped, 1, 'it must report that it was skipped, not silently do nothing');

    const tasks = await listTasks(env);
    assert.equal(tasks.length, 1, 'no duplicate task');
    assert.deepEqual(tasks[0], first, 'the task is byte-for-byte unchanged');
  });

  test('AN EDIT TO THE TASK SURVIVES THE NEXT MIGRATION', async () => {
    // THE REGRESSION. The migration runs on every event, so an unconditional write reverted console edits
    // on the next incoming message. This is the assertion that fails against that version.
    const env = envWith(fakeDb({ [`interject_config:${GROUP}`]: legacy({ text: '冒泡' }) }));
    await migrateInterjections(env);

    // The operator edits the task in the console.
    const edited = { ...(await listTasks(env))[0], content: { kind: 'fixed' as const, text: '戳破' }, name: '每天一句' };
    const { saveTask } = await import('../src/qq/tasks');
    await saveTask(env, edited);

    // The next group message triggers the migration again.
    const r = await migrateInterjections(env);
    assert.equal(r.migrated, 0, 'the old config did not change, so nothing should be written');

    const after = await getTask(env, edited.id);
    assert.equal(after?.content.kind === 'fixed' && after.content.text, '戳破', 'the edit must survive');
    assert.equal(after?.name, '每天一句', 'the renamed task must survive');
  });

  test('editing the OLD config updates the task to match', async () => {
    // The other direction: the fingerprint is what makes a genuine config change propagate.
    const db = fakeDb({ [`interject_config:${GROUP}`]: legacy({ text: '冒泡' }) });
    const env = envWith(db);
    await migrateInterjections(env);
    assert.deepEqual((await listTasks(env))[0].content, { kind: 'fixed', text: '冒泡' });

    // The old config changes — the operator used the legacy form to say something different.
    db.rows.set(`interject_config:${GROUP}`, legacy({ text: '戳破' }));
    const r = await migrateInterjections(env);
    assert.equal(r.migrated, 1, 'a changed config must re-migrate');

    assert.deepEqual((await listTasks(env))[0].content, { kind: 'fixed', text: '戳破' }, 'the task follows the config');
  });

  test('a config whose JSON is re-serialised identically is not treated as changed', async () => {
    // The fingerprint is the parsed-and-re-serialised JSON, so a rewrite with different key order or
    // whitespace does not look like a change and does not trigger an overwrite.
    const db = fakeDb();
    const env = envWith(db);
    db.rows.set(`interject_config:${GROUP}`, '{"enabled":true,"perDay":1,"mode":"random","text":"冒泡"}');
    await migrateInterjections(env);

    db.rows.set(`interject_config:${GROUP}`, '{"text":"冒泡","mode":"random","perDay":1,"enabled":true}');
    const r = await migrateInterjections(env);
    assert.equal(r.migrated, 0, 'the same config in a different key order is not a change');
  });
});
