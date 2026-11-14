/**
 * Ambient group messages: what the bot overheard.
 *
 * WHY THIS EXISTS: to comment on a conversation the bot has to have seen it. QQ only delivers
 * every group message when the group owner has enabled "receive all messages", which produces
 * `GROUP_MESSAGE_CREATE` — an event the bot must NOT answer on arrival (it is one person talking
 * to others; see `shouldReply`). So those messages are recorded here instead, and later read back.
 *
 * TWO THINGS THIS IS NOT:
 *
 *   1. It is not a chat log. Only what is needed to understand the room is kept — the sender label
 *      and the text — and rows expire. Keeping full transcripts of a group's chatter is both a
 *      storage problem on a free plan and a privacy problem for people who never opted into it.
 *
 *   2. It is not a source of replies. Nothing here is ever answered directly; it only feeds a
 *      deliberate, rate-limited interjection.
 *
 * The read path returns the most recent N messages oldest-first, which is the order a language
 * model needs to make sense of a conversation.
 */

import type { Env } from '../types';

/** Table name, so the schema and the queries cannot drift apart. */
export const AMBIENT_TABLE = 'ambient_message';

/**
 * Schema for the ambient store.
 *
 * `group_openid` and `created_at` are the two things every query filters on, so they are indexed
 * together. `sender` is the display label (the group nickname when QQ provides one) rather than an
 * openid: the interjection only needs to say who spoke, and storing the identifier would make this
 * table a mapping of people to their messages for no benefit.
 */
export const AMBIENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${AMBIENT_TABLE} (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_openid TEXT    NOT NULL,
  sender       TEXT,
  content      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ambient_group_time ON ${AMBIENT_TABLE} (group_openid, created_at DESC);
`;

export interface AmbientMessage {
  sender: string | null;
  content: string;
  createdAt: number;
}

/**
 * How long an overheard message is kept.
 *
 * A conversation is only useful to comment on while it is still going, and retaining a group's
 * chatter for longer than a day serves no feature while widening the privacy footprint. One day
 * also bounds the table on the free plan without needing a scheduled job: the prune happens on
 * write.
 */
export const AMBIENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Cap per group.
 *
 * An interjection reads the last handful of messages. Beyond that the older ones add storage cost
 * and no context, and a busy group can produce thousands a day.
 */
export const AMBIENT_MAX_PER_GROUP = 200;

/** Ensure the ambient table exists. Called from the same place the main schema is. */
export async function ensureAmbientSchema(db: D1Database): Promise<void> {
  const statements = AMBIENT_SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.batch(statements.map((s) => db.prepare(s)));
}

/**
 * Record one overheard message, and prune while we are here.
 *
 * Pruning on write rather than on a schedule is deliberate: a cron job would need its own CPU
 * budget (10 ms on the free plan) for work that is trivially cheap to do opportunistically, and a
 * scheduled job that silently stops running is a failure mode with no symptom.
 *
 * Never throws: an event handler must not fail because a log write did.
 */
export async function rememberAmbient(
  db: D1Database,
  groupOpenid: string,
  sender: string | null,
  content: string,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO ${AMBIENT_TABLE} (group_openid, sender, content, created_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(groupOpenid, sender, content, nowMs)
      .run();

    // Prune by age, then by count, so both kinds of growth are bounded.
    await db
      .prepare(`DELETE FROM ${AMBIENT_TABLE} WHERE group_openid = ?1 AND created_at < ?2`)
      .bind(groupOpenid, nowMs - AMBIENT_RETENTION_MS)
      .run();
    await db
      .prepare(
        `DELETE FROM ${AMBIENT_TABLE}
          WHERE group_openid = ?1
            AND id NOT IN (
              SELECT id FROM ${AMBIENT_TABLE} WHERE group_openid = ?1 ORDER BY id DESC LIMIT ?2
            )`,
      )
      .bind(groupOpenid, AMBIENT_MAX_PER_GROUP)
      .run();
  } catch (e) {
    console.error('rememberAmbient failed', e);
  }
}

/**
 * Read a group's recent messages, OLDEST FIRST.
 *
 * The reversal matters: the table is stored newest-first for pruning, but a conversation read
 * backwards is nonsense to a model, and the caller would have to remember to reverse it. Doing it
 * here means the only correct order is the one that comes out.
 */
export async function recentAmbient(
  db: D1Database,
  groupOpenid: string,
  limit = 20,
  nowMs: number = Date.now(),
): Promise<AmbientMessage[]> {
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await db
    .prepare(
      `SELECT sender, content, created_at FROM ${AMBIENT_TABLE}
        WHERE group_openid = ?1 AND created_at >= ?2
        ORDER BY id DESC LIMIT ?3`,
    )
    .bind(groupOpenid, nowMs - AMBIENT_RETENTION_MS, capped)
    .all<{ sender: string | null; content: string; created_at: number }>();

  return (rows.results ?? [])
    .map((r) => ({ sender: r.sender, content: r.content, createdAt: r.created_at }))
    .reverse();
}

/** How many messages are held for a group, for the admin view. */
export async function ambientCount(db: D1Database, groupOpenid: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${AMBIENT_TABLE} WHERE group_openid = ?1`)
    .bind(groupOpenid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Forget everything overheard in a group. Used by the retention control and by tests. */
export async function forgetAmbient(db: D1Database, groupOpenid?: string): Promise<number> {
  const res = groupOpenid
    ? await db.prepare(`DELETE FROM ${AMBIENT_TABLE} WHERE group_openid = ?1`).bind(groupOpenid).run()
    : await db.prepare(`DELETE FROM ${AMBIENT_TABLE}`).run();
  return res.meta.changes ?? 0;
}

/**
 * Render overheard messages as a transcript for a prompt.
 *
 * A bare concatenation of lines loses who said what, which is most of what makes a conversation
 * commentable. Unnamed senders become "某人" rather than an empty prefix, so the transcript never
 * reads as if the bot said it.
 */
export function renderTranscript(messages: AmbientMessage[]): string {
  return messages.map((m) => `${m.sender?.trim() || '某人'}：${m.content}`).join('\n');
}
