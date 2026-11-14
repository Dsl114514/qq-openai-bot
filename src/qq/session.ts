/**
 * Per-user daily chat sessions for the QQ bot.
 *
 * THE REQUIREMENT: one long conversation per user per day. Everything a user sends today stays
 * in a single thread; at the day boundary the thread resets.
 *
 * WHAT CONTINUITY ACTUALLY NEEDS — measured, not inferred. The completion body carries both
 * `chat_session_id` and `parent_message_id`, and the obvious guess is that the session id alone
 * carries the context. It does not. A controlled experiment (scripts/test-session-continuity.mjs)
 * stated a fact in one turn and asked for it back in the next, three ways:
 *
 *   A. same session + parent_message_id from the previous turn  -> REMEMBERS
 *   B. same session + parent_message_id = null                  -> forgets
 *   C. a brand-new session                                      -> forgets (control)
 *
 * So BOTH values must be carried forward. Storing only the session id produces a bot that
 * confidently forgets everything after the first message, which reads as a bad model rather
 * than a broken integration — the kind of failure worth a test, and there is one.
 *
 * Because a session id alone is useless here, this module stores the pair, plus the day it
 * belongs to, so the boundary needs no scheduled job: the day is compared on read.
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

/** The zone the "day" is measured in. China has no DST, so this is a fixed offset in practice. */
export const DEFAULT_SESSION_TZ = 'Asia/Shanghai';

/** Key namespace for per-user session state, so it can be purged by prefix. */
export const SESSION_KEY_PREFIX = 'qq_session:';

/**
 * The session key the web workbench uses.
 *
 * Namespaced like an API caller because that is what it is — the workbench talks to
 * `/v1/chat/completions` with `session_key`, so it goes through the same code path as any other
 * API client. Sharing that path means the workbench cannot drift from the behaviour the API
 * documents.
 */
export const WORKBENCH_SESSION_KEY = 'api:workbench';

export interface SessionState {
  /** Upstream conversation id. */
  sessionId: string;
  /**
   * The message to hang the next turn off.
   *
   * Carried forward from each reply, because a turn without it loses the thread (see above).
   */
  lastMessageId: string | null;
  /** The calendar day (in the configured zone) this session belongs to. */
  day: string;
  updatedAt: number;
  /**
   * Keep this conversation indefinitely, ignoring the daily reset.
   *
   * WHY THIS EXISTS: the daily boundary is right for a chat bot's ordinary use — a user mostly
   * wants a fresh start each day — but it is exactly wrong for a long-running project thread, where
   * yesterday's decisions are the context you need today. Rather than making everyone choose one
   * behaviour, a session can be pinned.
   *
   * A pinned session still stores `day` (the day it was last used) so the admin view can show how
   * stale it is; the day is simply not compared when deciding whether to continue.
   */
  pinned?: boolean;
}

/**
 * The calendar day in `timeZone`, formatted YYYY-MM-DD.
 *
 * `en-CA` is used because its date format IS ISO-8601, so the result needs no parsing and sorts
 * lexicographically. Intl with a named zone is doing the real work; the fallback exists only so
 * a bad configuration cannot take chat down, and it is reported rather than hidden.
 */
export function dayKey(nowMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    // Unknown timezone: refuse to guess wrong silently, but keep serving.
    console.error(`invalid timezone ${JSON.stringify(timeZone)}; falling back to UTC for the day key`);
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/** Validate a configured zone once, so a typo is visible rather than silently UTC. */
export function sessionTimeZone(env: Env): string {
  const tz = env.QQ_SESSION_TZ || DEFAULT_SESSION_TZ;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(0));
    return tz;
  } catch {
    return DEFAULT_SESSION_TZ;
  }
}

const keyFor = (openid: string): string => `${SESSION_KEY_PREFIX}${openid}`;

/**
 * Read a user's stored session, or null when there is none.
 *
 * Returns null rather than throwing on malformed JSON: a corrupt row should cost one turn of
 * context, not every future message.
 */
export async function getSession(env: Env, openid: string): Promise<SessionState | null> {
  const raw = await getState(env.DB, keyFor(openid));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
    return {
      sessionId: parsed.sessionId,
      lastMessageId: typeof parsed.lastMessageId === 'string' ? parsed.lastMessageId : null,
      day: typeof parsed.day === 'string' ? parsed.day : '',
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      pinned: parsed.pinned === true,
    };
  } catch {
    console.error(`unreadable session state for ${openid}; starting a fresh thread`);
    return null;
  }
}

/** Persist a user's session. */
export async function putSession(env: Env, openid: string, state: SessionState): Promise<void> {
  await setState(env.DB, keyFor(openid), JSON.stringify(state));
}

/** Drop a user's session, forcing the next turn to start a fresh thread. */
export async function clearSession(env: Env, openid: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(keyFor(openid)).run();
}

/**
 * Decide which thread the next turn belongs to.
 *
 * A new day, a missing record, or a record that cannot be used all mean "start fresh" — the
 * caller learns that from `reused: false` rather than having to compare days itself.
 */
export interface SessionDecision {
  /** Existing session to continue, or null to let the completion path create one. */
  sessionId: string | null;
  /** Parent message for the next turn, or null for a fresh thread. */
  parentMessageId: string | null;
  /** True when an existing thread is being continued. */
  reused: boolean;
  /** The day this decision applies to. */
  day: string;
  /** Why a new thread was started, when one was. */
  reason?: 'no-record' | 'new-day';
  /** True when the session is pinned, i.e. the daily boundary was deliberately ignored. */
  pinned: boolean;
}

export async function decideSession(
  env: Env,
  openid: string,
  nowMs: number = Date.now(),
): Promise<SessionDecision> {
  const day = dayKey(nowMs, sessionTimeZone(env));
  const existing = await getSession(env, openid);

  const base = { day, pinned: existing?.pinned === true };
  if (!existing) return { ...base, sessionId: null, parentMessageId: null, reused: false, reason: 'no-record' };

  // A pinned session ignores the day boundary — that is the entire point of pinning it. The
  // comparison still happens for unpinned sessions, which is what makes the feature opt-in.
  if (!existing.pinned && existing.day !== day) {
    // The boundary. No scheduled job does this: the comparison happens when the user writes.
    return { ...base, sessionId: null, parentMessageId: null, reused: false, reason: 'new-day' };
  }

  return {
    ...base,
    sessionId: existing.sessionId,
    parentMessageId: existing.lastMessageId,
    reused: true,
  };
}

/**
 * Record the outcome of a turn so the next one continues the same thread.
 *
 * `messageId` may be null when upstream does not report one. In that case the previous pointer
 * is KEPT rather than cleared: clearing it would silently drop the conversation's context on
 * the next turn (experiment B in ADR-0009), which is the exact failure this module exists to avoid.
 *
 * `pinned` is preserved from `previous` unless explicitly overridden, so an ordinary turn cannot
 * silently unpin a long-lived conversation.
 */
export async function recordTurn(
  env: Env,
  openid: string,
  turn: {
    sessionId: string | null;
    messageId: string | null;
    day: string;
    previous?: SessionState | null;
    pinned?: boolean;
  },
): Promise<void> {
  const sessionId = turn.sessionId ?? turn.previous?.sessionId ?? null;
  // Without a session id there is nothing to continue; do not write a half-record.
  if (!sessionId) return;

  await putSession(env, openid, {
    sessionId,
    lastMessageId: turn.messageId ?? turn.previous?.lastMessageId ?? null,
    day: turn.day,
    updatedAt: Date.now(),
    pinned: turn.pinned ?? turn.previous?.pinned ?? false,
  });
}

/**
 * Pin or unpin a session.
 *
 * Returns the resulting state so a caller can report what actually happened rather than assuming
 * the change applied — and so pinning a session that does not exist can be distinguished from
 * pinning one that does.
 */
export async function setSessionPinned(
  env: Env,
  id: string,
  pinned: boolean,
): Promise<{ ok: boolean; detail: string }> {
  const existing = await getSession(env, id);
  if (!existing) {
    return { ok: false, detail: pinned ? '没有这个会话，无法保留' : '没有这个会话' };
  }
  await putSession(env, id, { ...existing, pinned });
  return {
    ok: true,
    detail: pinned
      ? `已保留：这个会话不会再每日重置（当前上下文 ${existing.sessionId.slice(0, 8)}…）`
      : '已取消保留：这个会话会在跨天后的下一条消息重置',
  };
}

/**
 * Delete session records for users inactive since `beforeMs`, or all of them.
 *
 * Session state is user data — it maps an openid to a conversation thread — and the QQ
 * operating rules require user data to be deletable when a service ends. Retention is therefore
 * expressible here rather than being an afterthought.
 */
export async function purgeSessions(env: Env, beforeMs?: number): Promise<number> {
  const res =
    beforeMs === undefined
      ? await env.DB.prepare('DELETE FROM app_state WHERE key LIKE ?').bind(`${SESSION_KEY_PREFIX}%`).run()
      : // The stored `updatedAt` is inside the JSON, so filter on the numeric `day` boundary by
        // scanning: a LIKE cannot compare a timestamp. The set is one row per active user, which
        // is small, and this runs from an admin action rather than a hot path.
        await purgeByUpdatedAt(env, beforeMs);
  return res.meta.changes ?? 0;
}

async function purgeByUpdatedAt(env: Env, beforeMs: number): Promise<D1Result> {
  const rows = await env.DB.prepare('SELECT key, value FROM app_state WHERE key LIKE ?')
    .bind(`${SESSION_KEY_PREFIX}%`)
    .all<{ key: string; value: string }>();

  const stale: string[] = [];
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.value) as { updatedAt?: number };
      if (typeof parsed.updatedAt !== 'number' || parsed.updatedAt < beforeMs) stale.push(row.key);
    } catch {
      // Unparseable rows are dead weight; remove them.
      stale.push(row.key);
    }
  }

  if (stale.length === 0) return { meta: { changes: 0 } } as unknown as D1Result;
  // Bound the statement count: D1 batches are finite, and a purge of thousands of rows is not
  // something to attempt in one call.
  const slice = stale.slice(0, 500);
  await env.DB.batch(slice.map((k) => env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(k)));
  return { meta: { changes: slice.length } } as unknown as D1Result;
}

/** Summary for the admin view. */
export async function sessionStats(
  env: Env,
  nowMs: number = Date.now(),
): Promise<{ users: number; today: number; day: string; timeZone: string }> {
  const tz = sessionTimeZone(env);
  const day = dayKey(nowMs, tz);
  const rows = await env.DB.prepare('SELECT value FROM app_state WHERE key LIKE ?')
    .bind(`${SESSION_KEY_PREFIX}%`)
    .all<{ value: string }>();

  let today = 0;
  for (const row of rows.results ?? []) {
    try {
      if ((JSON.parse(row.value) as { day?: string }).day === day) today++;
    } catch {
      /* unreadable rows simply do not count */
    }
  }
  return { users: (rows.results ?? []).length, today, day, timeZone: tz };
}

/**
 * Whether a stored key uses the pre-channel format (`<openid>` with no channel prefix).
 *
 * Keys changed from `<openid>` to `<channel>:<openid>` when the group/C2C collision was fixed. An
 * old row is not merely unused — it is AMBIGUOUS, because the collision means it may hold a mix of
 * both conversations. It therefore must not be adopted as either channel's thread; the safe action
 * is to drop it and let that user start fresh, which costs one turn of context and cannot produce a
 * wrong one.
 */
export function isLegacySessionKey(id: string): boolean {
  if (id.startsWith('c2c:') || id.startsWith('group:') || id.startsWith('api:')) return false;
  // The `api:` namespace predates the change too, but those rows were never ambiguous, so they are
  // left alone.
  return true;
}

/**
 * Delete pre-channel session rows.
 *
 * Returns the ids removed, so an operator can see exactly whose threads were reset rather than
 * being told a number.
 */
export async function purgeLegacySessions(env: Env): Promise<string[]> {
  const result = await env.DB.prepare('SELECT key FROM app_state WHERE key LIKE ?')
    .bind(`${SESSION_KEY_PREFIX}%`)
    .all<{ key: string }>();

  const legacy: string[] = [];
  for (const row of result.results ?? []) {
    const id = row.key.slice(SESSION_KEY_PREFIX.length);
    if (isLegacySessionKey(id)) legacy.push(id);
  }
  if (legacy.length === 0) return [];

  const slice = legacy.slice(0, 500);
  await env.DB.batch(slice.map((id) => env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(keyFor(id))));
  return slice;
}

export interface SessionRow {
  /** The raw key suffix, i.e. `<channel>:<openid>` or `api:<name>`. */
  id: string;
  /** True for `/v1` callers (including the workbench) rather than QQ users. */
  isApi: boolean;
  /** Human-readable channel, or null for API rows. */
  channel: 'c2c' | 'group' | null;
  /** A pre-channel row: ambiguous about which conversation it belongs to, and not usable. */
  legacy: boolean;
  /** Kept indefinitely, ignoring the daily reset. */
  pinned: boolean;
  sessionId: string;
  lastMessageId: string | null;
  day: string;
  updatedAt: number;
  /** Whether this row is for the current day, i.e. whether it would be continued. */
  current: boolean;
}

/**
 * List stored sessions for the admin view.
 *
 * Sessions are otherwise invisible — the only way to know one exists is that the bot remembers
 * something — so this is what makes "who has a thread, and is it live" answerable.
 */
export async function listSessions(
  env: Env,
  nowMs: number = Date.now(),
  limit = 100,
): Promise<{ rows: SessionRow[]; day: string; timeZone: string }> {
  const tz = sessionTimeZone(env);
  const day = dayKey(nowMs, tz);

  const result = await env.DB.prepare('SELECT key, value FROM app_state WHERE key LIKE ? ORDER BY key LIMIT ?')
    .bind(`${SESSION_KEY_PREFIX}%`, limit)
    .all<{ key: string; value: string }>();

  const rows: SessionRow[] = [];
  for (const row of result.results ?? []) {
    const id = row.key.slice(SESSION_KEY_PREFIX.length);
    const isApi = id.startsWith('api:');
    const legacy = isLegacySessionKey(id);
    const channel: SessionRow['channel'] = id.startsWith('c2c:') ? 'c2c' : id.startsWith('group:') ? 'group' : null;
    try {
      const parsed = JSON.parse(row.value) as Partial<SessionState>;
      if (typeof parsed.sessionId !== 'string') continue;
      const pinned = parsed.pinned === true;
      rows.push({
        id,
        isApi,
        channel,
        legacy,
        pinned,
        sessionId: parsed.sessionId,
        lastMessageId: typeof parsed.lastMessageId === 'string' ? parsed.lastMessageId : null,
        day: typeof parsed.day === 'string' ? parsed.day : '',
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        // A legacy row is never "current": it must not be offered as a live thread to continue.
        // A pinned row is always current, because the day boundary does not apply to it — which is
        // exactly what pinning means, and showing "no" there would contradict the pin.
        current: !legacy && (pinned || parsed.day === day),
      });
    } catch {
      // A corrupt row is reported rather than hidden, because it is a real problem the admin
      // view is the right place to notice.
      rows.push({
        id,
        isApi,
        channel,
        legacy,
        pinned: false,
        sessionId: '',
        lastMessageId: null,
        day: '',
        updatedAt: 0,
        current: false,
      });
    }
  }
  // Newest activity first; corrupt rows (updatedAt 0) sink to the bottom.
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return { rows, day, timeZone: tz };
}
