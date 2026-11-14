/**
 * Usage statistics.
 *
 * WHY THIS EXISTS. The console could show the most recent N calls and a total count, which answers
 * "what just happened" but not "is this getting slower / more expensive / more broken". Those are
 * trends, and a trend needs aggregation over time rather than a page of rows.
 *
 * AGGREGATION HAPPENS IN SQL, not in the Worker. The rows are in D1, and shipping thousands of them into
 * a Worker to sum them in JavaScript would spend the 10 ms CPU budget (ADR-0005) on work the database can
 * do for free. Each query here returns a handful of numbers.
 *
 * THE DAY BUCKET USES THE CONFIGURED ZONE. Grouping by `created_at / 86400000` would bucket by UTC, so
 * every call between midnight and 08:00 in Asia/Shanghai would land on the previous day — a chart that is
 * wrong for a third of each day is worse than no chart.
 */

import type { Env } from '../types';
import { sessionTimeZone } from '../qq/session';

export interface DayBucket {
  day: string;
  total: number;
  errors: number;
  avgLatencyMs: number;
}

export interface StatsSummary {
  /** Per-day totals, oldest first. */
  days: DayBucket[];
  /** Total calls, all time. */
  total: number;
  /** Calls per origin. */
  byOrigin: { origin: string; n: number }[];
  /** Calls per status code, most frequent first. */
  byStatus: { status: number; n: number }[];
  /** Latency percentiles over the window, in ms. */
  latency: { p50: number; p95: number; max: number; avg: number };
  /** Token totals over the window. */
  tokens: { prompt: number; completion: number };
  /** The busiest origin refs, which is who is actually using it. */
  topUsers: { ref: string; n: number }[];
  /** The window the numbers cover. */
  from: number;
  to: number;
}

/**
 * A local-day expression for SQLite.
 *
 * SQLite has no timezone database, so the offset is computed from the zone at the window's start and
 * applied as a fixed shift. That is exact except across a DST boundary inside the window, where one hour
 * of one day can be attributed to the neighbouring day — acceptable for a usage chart, and much better
 * than bucketing everything by UTC.
 */
function dayExpression(offsetMinutes: number): string {
  const shift = offsetMinutes * 60;
  return `date(created_at / 1000 + ${shift}, 'unixepoch')`;
}

/** The zone's UTC offset in minutes at a given instant. */
function zoneOffsetMinutes(nowMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  });
  const name = fmt.formatToParts(new Date(nowMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

export async function computeStats(env: Env, windowDays = 30): Promise<StatsSummary> {
  const to = Date.now();
  const from = to - windowDays * 86_400_000;
  const tz = sessionTimeZone(env);
  const dayExpr = dayExpression(zoneOffsetMinutes(to, tz));

  const [perDay, byOrigin, byStatus, agg, tokens, topUsers] = await Promise.all([
    env.DB.prepare(
      `SELECT ${dayExpr} AS day,
              COUNT(*) AS total,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency
         FROM call_log WHERE created_at >= ?1
        GROUP BY day ORDER BY day`,
    )
      .bind(from)
      .all<{ day: string; total: number; errors: number; avg_latency: number }>(),

    env.DB.prepare(`SELECT origin, COUNT(*) AS n FROM call_log WHERE created_at >= ?1 GROUP BY origin ORDER BY n DESC`)
      .bind(from)
      .all<{ origin: string; n: number }>(),

    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM call_log WHERE created_at >= ?1 GROUP BY status ORDER BY n DESC`)
      .bind(from)
      .all<{ status: number; n: number }>(),

    // Percentiles are computed from a limited sample: SQLite has no percentile function, and ordering the
    // whole table to pick one row would scan far more than the chart justifies.
    env.DB.prepare(
      `SELECT COUNT(*) AS n, AVG(latency_ms) AS avg, MAX(latency_ms) AS max FROM call_log WHERE created_at >= ?1`,
    )
      .bind(from)
      .first<{ n: number; avg: number; max: number }>(),

    env.DB.prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion
         FROM call_log WHERE created_at >= ?1`,
    )
      .bind(from)
      .first<{ prompt: number; completion: number }>(),

    env.DB.prepare(
      `SELECT origin_ref AS ref, COUNT(*) AS n FROM call_log
        WHERE created_at >= ?1 AND origin_ref IS NOT NULL AND origin_ref != ''
        GROUP BY origin_ref ORDER BY n DESC LIMIT 10`,
    )
      .bind(from)
      .all<{ ref: string; n: number }>(),
  ]);

  const sample = await env.DB.prepare(`SELECT latency_ms FROM call_log WHERE created_at >= ?1 ORDER BY latency_ms`)
    .bind(from)
    .all<{ latency_ms: number }>();
  const latencies = (sample.results ?? []).map((r) => r.latency_ms).sort((a, b) => a - b);
  const at = (q: number): number => (latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]);

  const total = (perDay.results ?? []).reduce((sum, d) => sum + d.total, 0);

  return {
    days: (perDay.results ?? []).map((d) => ({
      day: d.day,
      total: d.total,
      errors: d.errors ?? 0,
      avgLatencyMs: Math.round(d.avg_latency ?? 0),
    })),
    total,
    byOrigin: byOrigin.results ?? [],
    byStatus: byStatus.results ?? [],
    latency: {
      p50: at(0.5),
      p95: at(0.95),
      max: agg?.max ?? 0,
      avg: Math.round(agg?.avg ?? 0),
    },
    tokens: { prompt: tokens?.prompt ?? 0, completion: tokens?.completion ?? 0 },
    topUsers: topUsers.results ?? [],
    from,
    to,
  };
}
