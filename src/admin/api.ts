/**
 * JSON API for the Vue admin console.
 *
 * WHY A SEPARATE JSON LAYER: the server-rendered views built their HTML with string templates, so
 * every interaction was a form POST that returned a whole new page. That is workable but it puts the
 * presentation in the Worker — where it costs CPU on every request (a 10 ms budget, ADR-0005) and
 * cannot be cached or updated without a deploy. Moving the rendering to the browser leaves the Worker
 * doing what only it can do: reading D1 and calling upstream.
 *
 * The auth model is unchanged and stays server-side: these endpoints sit behind the same
 * `/admin/*` Basic gate, and they are read-only except where a mutation is explicitly named. Nothing
 * here trusts the client — the Vue app is a view, not a security boundary.
 *
 * These return DATA, never HTML. The one exception is documented where it appears.
 */

import type { Env } from '../types';
import { getCallLog, listCallLogs } from '../db/store';
import { listSessions, sessionStats, sessionTimeZone } from '../qq/session';
import { qqBotInfo } from '../qq/webhook';
import { probeVerificationSupport } from '../qq/verify';
import { interjectionStatus, listInterjectionGroups } from '../qq/interject';
import { ambientCount } from '../qq/ambient';
import { knownGroups } from './groups';

/** A JSON error body in the shape every other endpoint uses. */
const fail = (message: string, status = 400) => Response.json({ error: { message } }, { status });

/**
 * The audit list, paginated and filtered.
 *
 * Bodies are deliberately EXCLUDED from the list: a page of 50 rows would otherwise carry 50 full
 * transcripts, and the audit view only needs them when a row is opened. That is also why the detail
 * endpoint exists separately.
 */
export async function apiListCalls(env: Env, url: URL): Promise<Response> {
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
  const origin = url.searchParams.get('origin') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const status = statusParam ? Number(statusParam) : undefined;

  if (statusParam && !Number.isFinite(status)) return fail('status must be a number');

  const { rows, total } = await listCallLogs(env.DB, {
    origin,
    status: Number.isFinite(status) ? status : undefined,
    search: url.searchParams.get('search') ?? undefined,
    limit,
    offset,
  });
  return Response.json({ rows, total, offset, limit });
}

/** One call with its full request and response bodies. */
export async function apiGetCall(env: Env, url: URL): Promise<Response> {
  // A MISSING id is distinguished from a NON-NUMERIC one. Checking only `Number.isInteger` would let
  // `Number(null) === 0` through, so a request with no id at all queried for call 0 and reported
  // "no such call" — which reads as "that record is gone" rather than "you forgot the parameter".
  const raw = url.searchParams.get('id');
  if (raw === null || raw.trim() === '') return fail('missing required parameter: id');
  const id = Number(raw);
  if (!Number.isInteger(id)) return fail('id must be an integer');
  const row = await getCallLog(env.DB, id);
  if (!row) return fail('no such call', 404);
  return Response.json(row);
}

/** Every stored conversation thread, with the day it belongs to. */
export async function apiListSessions(env: Env): Promise<Response> {
  const [sessions, stats] = await Promise.all([listSessions(env), sessionStats(env)]);
  return Response.json({ ...sessions, stats: { users: stats.users, today: stats.today } });
}

/**
 * Conversations read as conversations, rather than as calls.
 *
 * WHY THIS IS SEPARATE FROM THE AUDIT LIST. The audit list is one row per CALL, with the bodies shown as
 * raw JSON — it answers "what exactly was sent", which is what debugging needs. It does not answer "what
 * has this group been talking about", which requires reading many rows in order and parsing each body to
 * find the text. This extracts that, so a conversation can be read rather than reconstructed. The raw
 * bodies stay one click away, so this is a lens and not a replacement.
 *
 * Bodies are parsed in the WORKER rather than shipped to the browser, because a page of turns would
 * otherwise mean megabytes of JSON for the client to sift — and the same extraction logic would then have
 * to exist in two languages.
 */
export async function apiHistory(env: Env, url: URL): Promise<Response> {
  const scope = url.searchParams.get('scope') ?? '';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);

  // The scopes are derived from the log itself, so the picker only ever offers things that exist.
  const scopes = await env.DB.prepare(
    `SELECT origin_ref AS id, COUNT(*) AS n, MAX(created_at) AS newest
       FROM call_log
      WHERE origin = 'qq' AND origin_ref IS NOT NULL AND origin_ref NOT IN ('unknown', 'scheduler')
      GROUP BY origin_ref
      ORDER BY newest DESC
      LIMIT 30`,
  ).all<{ id: string; n: number; newest: number }>();

  const rows = await env.DB.prepare(
    `SELECT id, created_at, status, latency_ms, origin_ref,
            request_body, response_body, error
       FROM call_log
      WHERE origin = 'qq' ${scope ? 'AND origin_ref = ?2' : ''}
      ORDER BY id DESC
      LIMIT ?${scope ? '3' : '2'}`,
  )
    .bind(...(scope ? ['qq', scope, limit] : ['qq', limit]))
    .all<{
      id: number;
      created_at: number;
      status: number;
      latency_ms: number;
      origin_ref: string;
      request_body: string;
      response_body: string | null;
      error: string | null;
    }>();

  // Newest-first from SQL, reversed for reading.
  const turns = (rows.results ?? []).reverse().map((row) => {
    const req = safeParse(row.request_body);
    const res = safeParse(row.response_body);

    // The user's text can be in one of three places depending on which path handled it: a plain QQ event
    // (`d.content`), an API message (`messages[0].content`), or a command (`command`).
    const user = firstString(req?.d?.content, req?.messages?.[0]?.content, req?.command, req?.text) ?? '(无法提取)';
    const reply =
      firstString(res?.payload?.choices?.[0]?.message?.content, res?.reply, res?.detail, res?.text) ?? '';

    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      latencyMs: row.latency_ms,
      scope: row.origin_ref,
      user,
      reply,
      // Which pipeline produced it, so a surprising turn can be traced: a scheduled send has no user text.
      kind: req?.task ? 'task' : req?.interjection ? 'interjection' : req?.command ? 'command' : 'chat',
      stage: typeof res?.stage === 'string' ? res.stage : null,
      error: row.error,
    };
  });

  return Response.json({ scopes: scopes.results ?? [], turns, scope, limit });
}

/** JSON.parse that yields null rather than throwing, since a truncated body is a normal occurrence. */
function safeParse(text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** The first argument that is a non-empty string. */
function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Usage statistics over a window.
 *
 * A thin wrapper so the route layer stays declarative: the aggregation itself lives in `stats.ts`, where
 * the SQL and the timezone handling can be read together.
 */
export async function apiStats(env: Env, url: URL): Promise<Response> {
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30) || 30, 1), 365);
  const { computeStats } = await import('./stats');
  return Response.json(await computeStats(env, days));
}

/**
 * Everything the status and QQ pages need, in one response.
 *
 * Deliberately ONE endpoint rather than four: the two pages show overlapping state (token, PoW,
 * groups, interjections), and four round trips would each pay the schema check and the auth gate for
 * data that is read together. It is also the endpoint the page polls, so fewer requests is fewer
 * opportunities to interleave a stale read.
 */
export async function apiStatus(env: Env): Promise<Response> {
  const [ed25519, info, groups] = await Promise.all([
    probeVerificationSupport().catch((e) => ({ preferred: null, detail: [String(e)] }) as never),
    qqBotInfo(env),
    knownGroups(env),
  ]);

  const configured = await listInterjectionGroups(env);
  const interjections = await Promise.all(
    configured.map(async (group) => {
      const status = await interjectionStatus(env, group);
      return {
        group,
        config: status.config,
        sent: status.sent,
        nextDueAt: status.nextDueAt,
        ambient: await ambientCount(env.DB, group),
      };
    }),
  );

  return Response.json({
    ed25519: { preferred: ed25519.preferred, detail: ed25519.detail ?? [] },
    qq: {
      sandbox: info.sandbox,
      apiHost: info.apiHost,
      appId: env.QQ_APP_ID || null,
      identity: info.identity,
      shareUrl: info.shareUrl,
      error: info.error,
    },
    timeZone: sessionTimeZone(env),
    groups,
    interjections,
  });
}
