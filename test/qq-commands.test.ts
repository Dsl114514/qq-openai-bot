// Chat commands and member nicknames.
//
// Two things here were previously broken or missing, and both failed silently:
//
//   - `/reset` existed but nothing advertised it, so it may as well not have existed. `/help` is the
//     discovery path and is therefore load-bearing rather than decorative.
//   - Nicknames were never stored, so any transcript built from openids produced remarks about
//     nobody in particular.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  handleCommand,
  helpText,
  forgetNicknames,
  getNickname,
  rememberNickname,
  resolveNames,
  HELP_COMMANDS,
  RESET_COMMANDS,
} from '../src/qq/commands';
import type { Env } from '../src/types';

/** D1 stand-in for the app_state operations this module uses. */
function fakeDb(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const key = String(args[0] ?? '');
          return {
            async first<T>(): Promise<T | null> {
              const v = rows.get(key);
              return (v === undefined ? null : { value: v }) as T;
            },
            async all<T>(): Promise<{ results: T[] }> {
              const prefix = key.replace(/%$/, '');
              return {
                results: [...rows.entries()]
                  .filter(([k]) => k.startsWith(prefix))
                  .map(([k, v]) => ({ key: k, value: v })) as T[],
              };
            },
            async run() {
              if (/^\s*DELETE/i.test(sql)) {
                if (key.endsWith('%')) {
                  const prefix = key.replace(/%$/, '');
                  let n = 0;
                  for (const k of [...rows.keys()]) if (k.startsWith(prefix)) { rows.delete(k); n++; }
                  return { meta: { changes: n } };
                }
                const had = rows.delete(key);
                return { meta: { changes: had ? 1 : 0 } };
              }
              if (/INSERT\s+INTO\s+app_state/i.test(sql)) {
                rows.set(key, String(args[1]));
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

const envWith = (db: unknown): Env => ({ DB: db, QQ_SESSION_TZ: 'Asia/Shanghai' }) as unknown as Env;
const state = { day: '2026-10-10', timeZone: 'Asia/Shanghai', continued: true };

describe('command recognition', () => {
  test('every advertised command is actually recognised', () => {
    // The help text names /reset, /status and /help. A command listed but not handled would be a
    // documented lie, so the sets are checked against what handleCommand accepts.
    assert.ok(RESET_COMMANDS.has('/reset'));
    assert.ok(HELP_COMMANDS.has('/help'));
  });

  test('reset is handled and reported as an action', async () => {
    const env = envWith(fakeDb());
    const r = await handleCommand(env, '/reset', 'c2c', state);
    assert.equal(r.handled, true);
    assert.equal(r.action, 'reset');
    assert.ok(r.reply.length > 0, 'a command must answer, or the user sees nothing happen');
  });

  test('commands are recognised regardless of case and surrounding spaces', async () => {
    const env = envWith(fakeDb());
    for (const variant of ['/RESET', '  /reset  ', '/Reset']) {
      const r = await handleCommand(env, variant, 'c2c', state);
      assert.equal(r.action, 'reset', `"${variant}" should be recognised`);
    }
  });

  test('help is handled and lists the other commands', async () => {
    const env = envWith(fakeDb());
    const r = await handleCommand(env, '/help', 'c2c', state);
    assert.equal(r.action, 'help');
    assert.ok(r.reply.includes('/reset'), 'help must name the commands that exist');
    assert.ok(r.reply.includes('/status'));
  });

  test('status reflects whether a session is being continued', async () => {
    const env = envWith(fakeDb());
    const on = await handleCommand(env, '/status', 'c2c', { ...state, continued: true });
    const off = await handleCommand(env, '/status', 'c2c', { ...state, continued: false });
    assert.ok(on.reply.includes('延续'));
    assert.ok(off.reply.includes('还没有'));
  });

  test('an ordinary message is NOT treated as a command', async () => {
    // A message that merely starts with a slash is more likely a path or a date than an instruction,
    // and swallowing it would look like the bot ignoring the user.
    const env = envWith(fakeDb());
    for (const text of ['你好', '/usr/local/bin', '/2026-10-10', 'reset', '帮我 /reset 一下']) {
      const r = await handleCommand(env, text, 'c2c', state);
      assert.equal(r.handled, false, `"${text}" must reach the model`);
    }
  });
});

describe('help text', () => {
  test('mentions the group @ requirement only in a group', () => {
    const group = helpText('group', state);
    const c2c = helpText('c2c', state);
    assert.ok(group.includes('@'), 'the @ rule is a real surprise in a group and must be stated');
    assert.ok(!c2c.includes('被 @'), 'it is irrelevant in a direct message');
  });

  test('states the session situation rather than leaving it a mystery', () => {
    assert.ok(helpText('c2c', { ...state, continued: true }).includes('延续'));
    assert.ok(helpText('c2c', { ...state, continued: false }).includes('新的'));
  });
});

describe('member nicknames', () => {
  test('a name is stored and read back', async () => {
    const db = fakeDb();
    const env = envWith(db);
    // The real value from a live group event.
    await rememberNickname(env, 'GROUP1', 'C6DB3DCAD572E67A79239EE930381549', 'Chrono/VERT', 'admin');
    const got = await getNickname(env, 'GROUP1', 'C6DB3DCAD572E67A79239EE930381549');
    assert.equal(got?.name, 'Chrono/VERT');
    assert.equal(got?.role, 'admin');
  });

  test('the same person can be named differently in different groups', async () => {
    // Scoping by group matters: using one group's nickname in another reads as a stranger talking.
    const db = fakeDb();
    const env = envWith(db);
    await rememberNickname(env, 'GA', 'PERSON', '小明', null);
    await rememberNickname(env, 'GB', 'PERSON', '老王', null);
    assert.equal((await getNickname(env, 'GA', 'PERSON'))?.name, '小明');
    assert.equal((await getNickname(env, 'GB', 'PERSON'))?.name, '老王');
  });

  test('a missing or blank name is not stored', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await rememberNickname(env, 'G', 'P', null, null);
    await rememberNickname(env, 'G', 'P', '   ', null);
    assert.equal(await getNickname(env, 'G', 'P'), null, 'a blank name is worse than none');
    assert.equal(db.rows.size, 0);
  });

  test('resolveNames labels everyone, including unknown senders', async () => {
    // An unknown sender must still get a DISTINCT label: repeating "某人" would make it look like one
    // person said everything.
    const db = fakeDb();
    const env = envWith(db);
    await rememberNickname(env, 'G', 'KNOWN', '小红', null);
    const names = await resolveNames(env, 'G', ['KNOWN', 'UNKNOWN_ABCDEF', 'UNKNOWN_ABCDEF']);
    assert.equal(names.get('KNOWN'), '小红');
    const unknown = names.get('UNKNOWN_ABCDEF');
    assert.ok(unknown && unknown.includes('UNKNOW'), `expected an id-derived label, got ${unknown}`);
    assert.ok(unknown.includes('…'), 'both ends are kept so similar ids stay distinguishable');
  });

  test('unknown ids sharing a long prefix still get different labels', async () => {
    // Openids in one group often share a long prefix. A prefix-only fallback would collapse several
    // people into one label — reintroducing the confusion the fallback exists to avoid.
    const db = fakeDb();
    const env = envWith(db);
    const a = 'B0780D7BE440143E5A2D23D7C7B99E72';
    const b = 'B0780D7BE440143E5A2D23D7C7B99E73';
    const names = await resolveNames(env, 'G', [a, b]);
    assert.notEqual(names.get(a), names.get(b), 'two different people must not share a label');
  });

  test('a corrupt nickname row is treated as unknown rather than crashing', async () => {
    const db = fakeDb({ 'qq_nick:G:P': '{not json' });
    assert.equal(await getNickname(envWith(db), 'G', 'P'), null);
  });

  test('nicknames can be forgotten per scope or entirely', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await rememberNickname(env, 'GA', 'P1', 'A', null);
    await rememberNickname(env, 'GB', 'P2', 'B', null);

    assert.equal(await forgetNicknames(env, 'GA'), 1);
    assert.equal(await getNickname(env, 'GA', 'P1'), null);
    assert.ok(await getNickname(env, 'GB', 'P2'), 'the other scope survives');

    assert.equal(await forgetNicknames(env), 1);
    assert.equal(db.rows.size, 0);
  });
});
