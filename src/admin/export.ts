/**
 * Exporting the audit log and the session list.
 *
 * WHY THIS EXISTS. The console could page through calls but not get them OUT. Two real needs: an offline
 * look (spreadsheet, grep, `jq`), and the retention obligation the QQ platform places on a bot that
 * processes user messages — which is easier to honour when the data can be taken out in one piece rather
 * than clicked through a page at a time.
 *
 * STREAMING RATHER THAN BUILDING A STRING. A month of calls is more bytes than a Worker should hold at
 * once, and building the whole document in memory would spend the 10 ms CPU budget on string
 * concatenation. The stream is generated as it is read, in pages, so the memory stays roughly constant
 * regardless of how much is exported.
 *
 * CSV IS DELIBERATELY NOT A JSON DUMP WITH COMMAS. The bodies are arbitrary text containing quotes, commas
 * and newlines — all of which break a naive CSV. They are quoted and escaped properly, because a CSV that
 * opens misaligned in a spreadsheet is worse than no export.
 */

import type { Env } from '../types';
import type { CallLogRow } from '../types';
import { listCallLogs } from '../db/store';
import { listSessions } from '../qq/session';

/**
 * Page size for the streamed export.
 *
 * D1 REJECTS A STATEMENT WITH MORE THAN 100 BOUND PARAMETERS, and `withBodies` binds one parameter per
 * row id. A page of 200 therefore failed outright with `variable number must be between ?1 and ?100` —
 * surfaced only because a stream that dies mid-flight writes the error into the output rather than
 * returning a truncated file. 50 leaves room for the extra binds a query might add later.
 */
const PAGE = 50;

/**
 * The most ids one `IN (...)` list may bind.
 *
 * Asserted rather than assumed: the query is built by joining placeholders, so a future change to PAGE
 * would turn into a runtime SQL error rather than a compile error, and the failure would appear only when
 * someone exported a large range.
 */
const MAX_BOUND_IDS = 100;

export interface ExportOptions {
  format: 'json' | 'csv';
  /** Only rows older than this are excluded. */
  fromMs?: number;
  origin?: string;
  status?: number;
  /** Cap the export, so an accidental click on "everything" cannot run forever. */
  limit?: number;
}

const MAX_EXPORT = 50_000;

/**
 * A CSV field, quoted only when it needs to be.
 *
 * Always-quoting is simpler but makes every numeric column a string in a spreadsheet, which breaks sums.
 * Quote-when-needed keeps numbers numeric and still handles the bodies.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote when the value contains a delimiter, a quote, or a newline — the three things that break CSV.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CALL_COLUMNS: (keyof CallLogRow)[] = [
  'id',
  'created_at',
  'origin',
  'origin_ref',
  'model',
  'prompt_tokens',
  'completion_tokens',
  'latency_ms',
  'status',
  'error',
  'request_body',
  'response_body',
];

/**
 * Stream the call log as JSON or CSV.
 *
 * The JSON form is a top-level object rather than an array so it can carry metadata alongside the rows —
 * and so the stream can be closed cleanly. JSON Lines would be cheaper, but `JSON.parse` on a
 * conventional file is what people actually paste into other tools.
 */
export function exportCalls(env: Env, options: ExportOptions): Response {
  const limit = Math.min(options.limit ?? MAX_EXPORT, MAX_EXPORT);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0;
      let written = 0;
      const isCsv = options.format === 'csv';

      try {
        if (isCsv) {
          controller.enqueue(encoder.encode(CALL_COLUMNS.join(',') + '\r\n'));
        } else {
          controller.enqueue(encoder.encode('{"exported_at":' + Date.now() + ',"rows":['));
        }

        while (written < limit) {
          const page = await listCallLogs(env.DB, {
            origin: options.origin,
            status: options.status,
            limit: Math.min(PAGE, limit - written),
            offset,
          });
          const rows = page.rows.length ? await withBodies(env, page.rows, options.fromMs) : [];
          if (rows.length === 0) break;

          if (isCsv) {
            for (const row of rows) {
              controller.enqueue(encoder.encode(CALL_COLUMNS.map((c) => csvField(row[c])).join(',') + '\r\n'));
            }
          } else {
            for (const row of rows) {
              const prefix = written === 0 ? '' : ',';
              controller.enqueue(encoder.encode(prefix + JSON.stringify(row)));
            }
          }

          written += rows.length;
          offset += PAGE;
          // A short page means the data is exhausted; stop rather than issuing another empty query.
          if (page.rows.length < PAGE) break;
        }

        if (!isCsv) controller.enqueue(encoder.encode(']}'));
        controller.close();
      } catch (e) {
        // A stream that dies mid-flight leaves a truncated file with no explanation. Emitting the error
        // into the output makes the breakage visible in the downloaded artifact itself.
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(isCsv ? `\r\n# ERROR: ${message}` : `],"error":${JSON.stringify(message)}}`));
        controller.close();
      }
    },
  });

  const filename = `calls-${new Date().toISOString().slice(0, 10)}.${options.format}`;
  return new Response(stream, {
    headers: {
      'content-type': options.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      // `attachment` so a browser downloads it instead of rendering JSON in a tab.
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * Attach the request/response bodies, which the list query omits.
 *
 * The list intentionally excludes bodies (a page of 50 would otherwise carry 50 transcripts), so the
 * export fetches them for its rows. Done per page, which keeps the outstanding set bounded.
 *
 * The input type is the LIST row (no bodies) and the output is the full row — an earlier version declared
 * both as the full row, which the compiler rejected because the list genuinely cannot produce bodies.
 */
async function withBodies(
  env: Env,
  rows: Omit<CallLogRow, 'request_body' | 'response_body'>[],
  fromMs?: number,
): Promise<CallLogRow[]> {
  const ids = rows.map((r) => r.id).filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];

  // Fail loudly here rather than with an opaque SQL error from D1 — the message D1 returns ("variable
  // number must be between ?1 and ?100") does not say which query or why.
  if (ids.length > MAX_BOUND_IDS) {
    throw new Error(`export page too large: ${ids.length} ids bound, but D1 allows at most ${MAX_BOUND_IDS}`);
  }

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
  const full = await env.DB.prepare(
    `SELECT id, created_at, origin, origin_ref, model, prompt_tokens, completion_tokens, latency_ms, status, error,
            request_body, response_body
       FROM call_log WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<CallLogRow>();

  const byId = new Map((full.results ?? []).map((r) => [r.id, r]));
  // Ordered by the original page so the export matches what the console displayed, and filtered rather
  // than dropped when `fromMs` is set — a silent gap in a streamed file is hard to notice.
  return rows
    .map((r) => byId.get(r.id))
    .filter((r): r is CallLogRow => r !== undefined && (fromMs === undefined || r.created_at >= fromMs));
}

/** Stream the conversation threads, without their upstream session ids. */
export function exportSessions(env: Env, format: 'json' | 'csv'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const { rows, day, timeZone } = await listSessions(env);

        if (format === 'csv') {
          controller.enqueue(encoder.encode('id,channel,pinned,day,updated_at,message_count\n'));
          for (const s of rows) {
            controller.enqueue(
              encoder.encode([s.id, s.channel ?? 'api', s.pinned, s.day, s.updatedAt, s.lastMessageId ?? ''].map(csvField).join(',') + '\r\n'),
            );
          }
        } else {
          controller.enqueue(
            encoder.encode(JSON.stringify({ exported_at: Date.now(), day, timeZone, rows }, null, 2)),
          );
        }
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(format === 'csv' ? `# ERROR: ${message}` : JSON.stringify({ error: message })));
        controller.close();
      }
    },
  });

  const filename = `sessions-${new Date().toISOString().slice(0, 10)}.${format}`;
  return new Response(stream, {
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
