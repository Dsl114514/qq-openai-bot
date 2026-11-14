/**
 * Call-log storage in D1.
 *
 * Every call writes one row, request and response bodies included — the audit view
 * exists to answer "what did it actually ask and answer", so trimming bodies would
 * remove the feature. That fixes the throughput ceiling at D1's free-tier write quota
 * (100,000 rows/day); see docs/adr/0004.
 *
 * `origin` is not decoration: QQ-sourced rows carry user conversations, and the QQ
 * platform's operating rules require deleting user data when a service is terminated,
 * so retention has to be expressible per origin.
 */

import type { CallLogRow, Env } from '../types';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS call_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        INTEGER NOT NULL,
  origin            TEXT    NOT NULL,
  origin_ref        TEXT,
  model             TEXT    NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER NOT NULL,
  status            INTEGER NOT NULL,
  error             TEXT,
  request_body      TEXT    NOT NULL,
  response_body     TEXT
);
CREATE INDEX IF NOT EXISTS idx_call_log_created ON call_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_log_origin  ON call_log (origin, created_at DESC);

-- Key/value state: provider endpoints and their keys, per-group settings, access rules,
-- conversation history, session rows, and scheduled tasks. One table rather than several
-- because every consumer wants "read this key, write that key" and nothing needs a query
-- across them.
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Idempotently create the schema. Safe to call on every cold start.
 *
 * The statements are split on `;` because D1 wants one statement per prepared query. That
 * splitting is only safe once `--` comments are removed first: SCHEMA contains documentation
 * comments, and a semicolon INSIDE a comment (there is one, in the note about rotating the
 * token) splits the comment in half and leaves a fragment that starts with prose instead of
 * SQL. D1 then rejects the whole batch, which is a 500 on every route — /health included.
 *
 * Comments are stripped here rather than removed from SCHEMA so the documentation stays
 * where a reader looks for it.
 */
export function schemaStatements(schema: string = SCHEMA): string[] {
  return schema
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch(schemaStatements().map((s) => db.prepare(s)));
}

export interface LogInput {
  origin: CallLogRow['origin'];
  originRef?: string | null;
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs: number;
  status: number;
  error?: string | null;
  requestBody: unknown;
  responseBody: unknown;
}

/**
 * Append one call-log row.
 *
 * Never throws: a logging failure must not turn a successful completion into an error
 * response for the caller. Failures are reported to the console instead.
 */
export async function writeCallLog(db: D1Database, entry: LogInput): Promise<number | null> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO call_log
           (created_at, origin, origin_ref, model, prompt_tokens, completion_tokens,
            latency_ms, status, error, request_body, response_body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        Date.now(),
        entry.origin,
        entry.originRef ?? null,
        entry.model,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        Math.round(entry.latencyMs),
        entry.status,
        entry.error ?? null,
        safeStringify(entry.requestBody),
        entry.responseBody === null || entry.responseBody === undefined
          ? null
          : safeStringify(entry.responseBody),
      )
      .run();
    return res.meta.last_row_id ?? null;
  } catch (e) {
    console.error('writeCallLog failed', e);
    return null;
  }
}

/** Bodies can contain arbitrary values, including cycles from an upstream echo. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ note: 'unserialisable value', type: typeof value });
  }
}

export interface LogQuery {
  origin?: string;
  status?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listCallLogs(
  db: D1Database,
  q: LogQuery,
): Promise<{ rows: Omit<CallLogRow, 'request_body' | 'response_body'>[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (q.origin) {
    where.push('origin = ?');
    binds.push(q.origin);
  }
  if (typeof q.status === 'number') {
    where.push('status = ?');
    binds.push(q.status);
  }
  if (q.search) {
    // Body search is the point of the audit view: "which call said X".
    where.push('(request_body LIKE ? OR response_body LIKE ?)');
    binds.push(`%${q.search}%`, `%${q.search}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);

  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM call_log ${clause}`).bind(...binds).first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT id, created_at, origin, origin_ref, model, prompt_tokens, completion_tokens,
              latency_ms, status, error
         FROM call_log ${clause}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all();

  return { rows: (rows.results ?? []) as never, total: totalRow?.n ?? 0 };
}

export async function getCallLog(db: D1Database, id: number): Promise<CallLogRow | null> {
  return await db.prepare('SELECT * FROM call_log WHERE id = ?').bind(id).first<CallLogRow>();
}

/** Delete rows older than `beforeMs`, optionally restricted to one origin. */
export async function purgeCallLogs(db: D1Database, beforeMs: number, origin?: string): Promise<number> {
  const res = origin
    ? await db.prepare('DELETE FROM call_log WHERE created_at < ? AND origin = ?').bind(beforeMs, origin).run()
    : await db.prepare('DELETE FROM call_log WHERE created_at < ?').bind(beforeMs).run();
  return res.meta.changes ?? 0;
}

// ───────────────────────────────────────────────────────────────────── app_state

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO app_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(key, value)
    .run();
}
