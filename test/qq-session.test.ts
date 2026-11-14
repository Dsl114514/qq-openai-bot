// Daily-session behaviour for the QQ bot.
//
// THE PROPERTY UNDER TEST is not "does it store a session id" but "does it carry forward BOTH
// values continuity needs". That distinction was measured, not assumed:
//
//   same session + parent_message_id  -> remembers
//   same session + parent = null      -> forgets
//   new session                       -> forgets
//
// (scripts/test-session-continuity.mjs, run against the live upstream.)
//
// So a bot that stores only the session id looks correct in the database and silently forgets
// everything after the first message. The tests below fail if that regresses.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  SESSION_KEY_PREFIX,
  dayKey,
  decideSession,
  getSession,
  putSession,
  recordTurn,
  clearSession,
  setSessionPinned,
  listSessions,
  purgeSessions,
  sessionStats,
  sessionTimeZone,
} from '../src/qq/session';
import type { Env } from '../src/types';
import { sessionKeyFor, shouldReply, replyTargetFor } from '../src/qq/webhook';

/**
 * In-memory stand-in for the app_state table.
 *
 * Supports the handful of statements the session module issues: a keyed SELECT, an upsert, a
 * prefix scan, a batch delete, and a delete-by-key.
 */
function fakeDb(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    prepare(sql: string) {
      const isSelect = /^\s*SELECT/i.test(sql);
      const isDeleteOne = /^\s*DELETE\s+FROM\s+app_state\s+WHERE\s+key\s*=\s*\?/i.test(sql);
      const isDeletePrefix = /^\s*DELETE\s+FROM\s+app_state\s+WHERE\s+key\s+LIKE/i.test(sql);
      const isUpsert = /INSERT\s+INTO\s+app_state/i.test(sql);

      return {
        bind(...args: unknown[]) {
          const one = String(args[0] ?? '');
          return {
            async first<T>(): Promise<T | null> {
              const v = rows.get(one);
              return (v === undefined ? null : { value: v }) as T;
            },
            async all<T>(): Promise<{ results: T[] }> {
              // A LIKE scan: the only pattern the module uses is `prefix%`.
              const prefix = one.replace(/%$/, '');
              const results = [...rows.entries()]
                .filter(([k]) => k.startsWith(prefix))
                .map(([key, value]) => ({ key, value }));
              return { results: results as T[] };
            },
            async run() {
              if (isSelect) return { meta: { changes: 0, last_row_id: 0 } };
              if (isDeleteOne) {
                const had = rows.delete(one);
                return { meta: { changes: had ? 1 : 0, last_row_id: 0 } };
              }
              if (isDeletePrefix) {
                const prefix = one.replace(/%$/, '');
                let n = 0;
                for (const k of [...rows.keys()]) if (k.startsWith(prefix)) { rows.delete(k); n++; }
                return { meta: { changes: n, last_row_id: 0 } };
              }
              if (isUpsert) {
                rows.set(one, String(args[1]));
                return { meta: { changes: 1, last_row_id: 0 } };
              }
              return { meta: { changes: 0, last_row_id: 0 } };
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
  ({ DB: db, ...extra }) as unknown as Env;

describe('day boundaries', () => {
  test('a day key is the local date, not the UTC date', () => {
    // 2026-10-07T16:30:00Z is already the 8th in Shanghai (UTC+8).
    const t = Date.parse('2026-10-07T16:30:00Z');
    assert.equal(dayKey(t, 'Asia/Shanghai'), '2026-10-08');
    assert.equal(dayKey(t, 'UTC'), '2026-10-07');
    // And the other side of midnight.
    const t2 = Date.parse('2026-10-07T15:30:00Z'); // 23:30 in Shanghai
    assert.equal(dayKey(t2, 'Asia/Shanghai'), '2026-10-07');
  });

  test('the zone comes from the environment, defaulting to Asia/Shanghai', () => {
    assert.equal(sessionTimeZone(envWith({}, {})), 'Asia/Shanghai');
    assert.equal(sessionTimeZone(envWith({}, { QQ_SESSION_TZ: 'UTC' })), 'UTC');
  });

  test('an invalid zone falls back instead of throwing', () => {
    // A typo in configuration must not take chat down.
    assert.equal(sessionTimeZone(envWith({}, { QQ_SESSION_TZ: 'Not/AZone' })), 'Asia/Shanghai');
    assert.equal(dayKey(Date.now(), 'Not/AZone').length, 10, 'still produces a usable key');
  });
});

describe('thread continuity', () => {
  test('BOTH the session id and the parent message id are carried forward', async () => {
    // This is the whole point. Storing only the session id is the measured failure mode.
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');

    await recordTurn(env, 'USER1', { sessionId: 'sess-abc', messageId: '2', day });

    const decision = await decideSession(env, 'USER1');
    assert.equal(decision.reused, true, 'the same day must continue the thread');
    assert.equal(decision.sessionId, 'sess-abc');
    assert.equal(decision.parentMessageId, '2', 'the parent pointer is REQUIRED for continuity');
  });

  test('a missing message id keeps the previous pointer rather than clearing it', async () => {
    // Clearing it would drop context on the next turn — the exact failure mode measured.
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');

    await recordTurn(env, 'USER1', { sessionId: 'sess-abc', messageId: '2', day });
    const previous = await getSession(env, 'USER1');
    // A turn whose reply reported no message id.
    await recordTurn(env, 'USER1', { sessionId: 'sess-abc', messageId: null, day, previous });

    const after = await getSession(env, 'USER1');
    assert.equal(after?.lastMessageId, '2', 'the pointer must survive a reply with no id');
  });

  test('a turn with no session id writes nothing rather than a half record', async () => {
    const db = fakeDb();
    const env = envWith(db);
    await recordTurn(env, 'USER1', { sessionId: null, messageId: '2', day: '2026-10-07' });
    assert.equal(await getSession(env, 'USER1'), null);
  });

  test('the newest message id replaces the old one', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'USER1', { sessionId: 's', messageId: '2', day });
    await recordTurn(env, 'USER1', { sessionId: 's', messageId: '4', day });
    assert.equal((await getSession(env, 'USER1'))?.lastMessageId, '4');
  });

  test('users do not share threads', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'ALICE', { sessionId: 'sess-A', messageId: '2', day });
    await recordTurn(env, 'BOB', { sessionId: 'sess-B', messageId: '2', day });

    assert.equal((await decideSession(env, 'ALICE')).sessionId, 'sess-A');
    assert.equal((await decideSession(env, 'BOB')).sessionId, 'sess-B');
  });
});

describe('the daily reset', () => {
  test('a new day starts a new thread, and says why', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const yesterday = dayKey(Date.now() - 86_400_000, 'Asia/Shanghai');

    await recordTurn(env, 'USER1', { sessionId: 'sess-old', messageId: '9', day: yesterday });

    const decision = await decideSession(env, 'USER1');
    assert.equal(decision.reused, false, 'a new day must not continue yesterday');
    assert.equal(decision.sessionId, null);
    assert.equal(decision.parentMessageId, null);
    assert.equal(decision.reason, 'new-day');
  });

  test('the boundary needs no scheduled job — it is evaluated on read', async () => {
    // Two calls across a simulated midnight, with no cron in between.
    const db = fakeDb();
    const env = envWith(db);
    const tz = 'Asia/Shanghai';

    const beforeMidnight = Date.parse('2026-10-07T15:59:00Z'); // 23:59 Shanghai
    const afterMidnight = Date.parse('2026-10-07T16:01:00Z'); // 00:01 Shanghai, next day

    const day1 = dayKey(beforeMidnight, tz);
    await recordTurn(env, 'USER1', { sessionId: 'sess-1', messageId: '2', day: day1 });

    // Rewriting the record for "yesterday" then deciding after midnight is what the real flow
    // does: the stored day is compared against the current one.
    const decision = await decideSession(env, 'USER1', afterMidnight);
    assert.equal(decision.day, dayKey(afterMidnight, tz));
    assert.equal(decision.reason, 'new-day');
    assert.equal(decision.reused, false);
  });

  test('no record and a stale record are distinguished', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const fresh = await decideSession(env, 'NEVER-SEEN');
    assert.equal(fresh.reason, 'no-record');

    const db2 = fakeDb({
      [`${SESSION_KEY_PREFIX}U`]: JSON.stringify({ sessionId: 's', lastMessageId: '1', day: '2000-01-01', updatedAt: 1 }),
    });
    const stale = await decideSession(envWith(db2), 'U');
    assert.equal(stale.reason, 'new-day');
  });
});

describe('channel separation', () => {
  // REGRESSION for a real failure reported from a group: "@bot 出错了：the model returned an empty
  // reply twice, even with a fresh challenge".
  //
  // Root cause: QQ returns the SAME string for a user's C2C `user_openid` and their group
  // `member_openid` (verified against two live events — both B0780D7BE440143E5A2D23D7C7B99E72).
  // Keying sessions by the sender alone merged a person's group thread and their direct thread
  // into one row. Both turns then read the same `parent_message_id`, and a parent that has already
  // been consumed produces an EMPTY reply with HTTP 200 and completion_tokens 1 — and the retry
  // cannot help, because it resends that same pointer.
  test('the same person in C2C and in a group get DIFFERENT session keys', () => {
    const openid = 'B0780D7BE440143E5A2D23D7C7B99E72'; // the value QQ actually sent for both
    const c2c = sessionKeyFor({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'hi', author: { user_openid: openid } },
    });
    const group = sessionKeyFor({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'm2', content: 'hi', group_openid: 'GROUP1', author: { member_openid: openid } },
    });

    assert.ok(c2c && group);
    assert.notEqual(c2c, group, 'a group message and a direct message must not share a thread');
    assert.equal(c2c, `c2c:${openid}`);
    assert.equal(group, `group:GROUP1:${openid}`);
  });

  test('the same person in two different groups gets separate threads', () => {
    const openid = 'MEMBER';
    const inA = sessionKeyFor({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'GA', author: { member_openid: openid } } });
    const inB = sessionKeyFor({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'GB', author: { member_openid: openid } } });
    assert.notEqual(inA, inB, 'each group is its own conversation');
  });

  test('the two channels do not share stored state end to end', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    const openid = 'B0780D7BE440143E5A2D23D7C7B99E72';

    const c2cKey = sessionKeyFor({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: openid } } })!;
    const groupKey = sessionKeyFor({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { group_openid: 'G', author: { member_openid: openid } },
    })!;

    await recordTurn(env, c2cKey, { sessionId: 'c2c-session', messageId: '6', day });

    // The group must NOT see the direct thread's session or its parent pointer.
    const groupDecision = await decideSession(env, groupKey);
    assert.equal(groupDecision.reused, false, 'the group must start its own thread');
    assert.equal(groupDecision.parentMessageId, null, 'the group must not inherit the C2C parent pointer');

    // And the direct thread is intact.
    const c2cDecision = await decideSession(env, c2cKey);
    assert.equal(c2cDecision.sessionId, 'c2c-session');
    assert.equal(c2cDecision.parentMessageId, '6');
  });

  test('a group event without a sender or a group id has no session key', () => {
    assert.equal(sessionKeyFor({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'G' } }), null);
    assert.equal(sessionKeyFor({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { author: { member_openid: 'M' } } }), null);
    assert.equal(sessionKeyFor({ op: 0, t: 'READY', d: { author: { user_openid: 'M' } } }), null);
  });
});

describe('pinned (kept) sessions', () => {
  // The daily reset is right for ordinary chat and wrong for a thread someone is deliberately
  // building on. Pinning is the opt-in escape hatch, and the property that matters is that a pinned
  // session survives the day boundary while an unpinned one does not.
  test('a pinned session survives the day boundary', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const yesterday = dayKey(Date.now() - 86_400_000, 'Asia/Shanghai');

    await recordTurn(env, 'c2c:USER', { sessionId: 'long-lived', messageId: '9', day: yesterday, pinned: true });

    const decision = await decideSession(env, 'c2c:USER');
    assert.equal(decision.reused, true, 'a pinned thread must NOT reset on a new day');
    assert.equal(decision.sessionId, 'long-lived');
    assert.equal(decision.parentMessageId, '9', 'and it keeps its parent pointer');
    assert.equal(decision.pinned, true);
    assert.equal(decision.reason, undefined, 'no reset happened, so there is no reason to report');
  });

  test('an unpinned session still resets, so pinning stays opt-in', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const yesterday = dayKey(Date.now() - 86_400_000, 'Asia/Shanghai');
    await recordTurn(env, 'c2c:USER', { sessionId: 'ordinary', messageId: '9', day: yesterday });

    const decision = await decideSession(env, 'c2c:USER');
    assert.equal(decision.reused, false);
    assert.equal(decision.reason, 'new-day');
    assert.equal(decision.pinned, false);
  });

  test('an ordinary turn does not silently unpin a kept conversation', async () => {
    // The subtle failure this guards: recordTurn writes a fresh state object, and if it defaulted
    // `pinned` to false the pin would be lost the very next time the user spoke — which would look
    // like the feature randomly stopping.
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');

    await recordTurn(env, 'c2c:USER', { sessionId: 'kept', messageId: '2', day, pinned: true });
    const previous = await getSession(env, 'c2c:USER');
    await recordTurn(env, 'c2c:USER', { sessionId: 'kept', messageId: '4', day, previous });

    const after = await getSession(env, 'c2c:USER');
    assert.equal(after?.pinned, true, 'the pin must survive a normal turn');
    assert.equal(after?.lastMessageId, '4', 'while the pointer still advances');
  });

  test('unpinning is possible and takes effect immediately', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'c2c:USER', { sessionId: 'kept', messageId: '2', day, pinned: true });

    const off = await setSessionPinned(env, 'c2c:USER', false);
    assert.equal(off.ok, true);
    assert.equal((await getSession(env, 'c2c:USER'))?.pinned, false);

    const on = await setSessionPinned(env, 'c2c:USER', true);
    assert.equal(on.ok, true);
    assert.equal((await getSession(env, 'c2c:USER'))?.pinned, true);
  });

  test('pinning a session that does not exist reports failure instead of pretending', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const r = await setSessionPinned(env, 'c2c:NOBODY', true);
    assert.equal(r.ok, false, 'there is nothing to keep, and saying otherwise would be a lie');
    assert.match(r.detail, /没有这个会话/);
  });

  test('a pinned session is reported as current regardless of its stored day', async () => {
    // The admin list says "current" based on the day. For a pinned row that would contradict the
    // pin, so pinned rows are always current.
    const db = fakeDb();
    const env = envWith(db);
    const old = dayKey(Date.now() - 5 * 86_400_000, 'Asia/Shanghai');
    await recordTurn(env, 'c2c:USER', { sessionId: 'kept', messageId: '2', day: old, pinned: true });

    const { rows } = await listSessions(env);
    const row = rows.find((r) => r.id === 'c2c:USER');
    assert.ok(row);
    assert.equal(row.pinned, true);
    assert.equal(row.current, true, 'a pinned row is always live, whatever its stored day');
  });
});

describe('event routing does not answer the room', () => {
  // REGRESSION for a real hazard: `replyTargetFor` returns a target for GROUP_MESSAGE_CREATE (the
  // full-mode event that fires for EVERY group message), so deciding to reply from that alone made
  // the bot answer everything anyone said in a group. That is obnoxious and a fast route to being
  // muted. Replying is now gated by `shouldReply`, and the two questions are deliberately separate.
  test('an @ mention or a direct message is answered', () => {
    assert.equal(shouldReply({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {} }), true);
    assert.equal(shouldReply({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {} }), true);
  });

  test('an ordinary group message is NOT answered, even though it has a target', () => {
    const event = { op: 0, t: 'GROUP_MESSAGE_CREATE', d: { group_openid: 'G', author: { member_openid: 'M' } } };
    assert.equal(shouldReply(event), false, 'this is one person talking to others');
    // It still has somewhere a reply COULD go — which is exactly why the two checks are separate.
    assert.ok(replyTargetFor(event), 'the target exists; the decision not to use it is separate');
  });

  test('events that are not messages are never answered', () => {
    assert.equal(shouldReply({ op: 0, t: 'READY', d: {} }), false);
    assert.equal(shouldReply({ op: 0, d: {} }), false);
  });
});

describe('robustness', () => {
  test('a corrupt row costs one turn, not the conversation forever', async () => {
    const db = fakeDb({ [`${SESSION_KEY_PREFIX}U`]: '{not json' });
    const env = envWith(db);
    assert.equal(await getSession(env, 'U'), null);
    const decision = await decideSession(env, 'U');
    assert.equal(decision.reused, false);
    assert.equal(decision.reason, 'no-record');
  });

  test('a record without a session id is treated as absent', async () => {
    const db = fakeDb({ [`${SESSION_KEY_PREFIX}U`]: JSON.stringify({ lastMessageId: '2', day: '2030-01-01' }) });
    assert.equal(await getSession(envWith(db), 'U'), null);
  });

  test('clearing a session forces a fresh thread', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'USER1', { sessionId: 's', messageId: '2', day });
    await clearSession(env, 'USER1');
    assert.equal((await decideSession(env, 'USER1')).reused, false);
  });
});

describe('retention and reporting', () => {
  test('purge removes only stale sessions when given a cutoff', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'OLD', { sessionId: 's1', messageId: '1', day });
    await recordTurn(env, 'NEW', { sessionId: 's2', messageId: '1', day });

    // Backdate OLD by writing its record with an old updatedAt.
    db.rows.set(
      `${SESSION_KEY_PREFIX}OLD`,
      JSON.stringify({ sessionId: 's1', lastMessageId: '1', day, updatedAt: 1000 }),
    );

    const removed = await purgeSessions(env, Date.now() - 60_000);
    assert.equal(removed, 1, 'exactly the stale row');
    assert.equal(await getSession(env, 'OLD'), null);
    assert.ok(await getSession(env, 'NEW'), 'the fresh row survives');
  });

  test('purge with no cutoff removes every session', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const day = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'A', { sessionId: 's', messageId: '1', day });
    await recordTurn(env, 'B', { sessionId: 's', messageId: '1', day });
    assert.equal(await purgeSessions(env), 2);
    assert.equal((await sessionStats(env)).users, 0);
  });

  test('stats count users and how many are active today', async () => {
    const db = fakeDb();
    const env = envWith(db);
    const today = dayKey(Date.now(), 'Asia/Shanghai');
    await recordTurn(env, 'TODAY', { sessionId: 's', messageId: '1', day: today });
    db.rows.set(
      `${SESSION_KEY_PREFIX}OLD`,
      JSON.stringify({ sessionId: 's', lastMessageId: '1', day: '2000-01-01', updatedAt: 1 }),
    );

    const stats = await sessionStats(env);
    assert.equal(stats.users, 2);
    assert.equal(stats.today, 1);
    assert.equal(stats.timeZone, 'Asia/Shanghai');
  });
});
