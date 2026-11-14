/**
 * Groups the bot has actually seen an event from.
 *
 * THIS EXISTS BECAUSE ASKING FOR AN ID BY HAND FAILED. The interjection form used to say "paste the
 * `group_openid` from the audit log", but the session list shows the INTERNAL session identifier
 * (`group:<group_openid>:<member_openid>`), so the obvious thing to copy was the wrong value. A
 * configuration saved that way never fires and never errors — the scheduler simply never matches an
 * event to it — which is the worst kind of failure: silent and permanent. See ADR-0015.
 *
 * Discovered from the events themselves, so the only values offered are ones that have demonstrably
 * arrived. The label prefers a group name when the platform will give one, and falls back to a
 * truncated openid rather than hiding the entry.
 */

import type { Env } from '../types';
import { getAccessToken } from '../qq/webhook';

export interface KnownGroup {
  openid: string;
  label: string;
}

export async function knownGroups(env: Env, limit = 50): Promise<KnownGroup[]> {
  const rows = await env.DB.prepare(
    `SELECT json_extract(request_body, '$.d.group_openid') AS g,
            MAX(created_at) AS newest
       FROM call_log
      WHERE origin = 'qq' AND g IS NOT NULL
      GROUP BY g
      ORDER BY newest DESC
      LIMIT ?1`,
  )
    .bind(limit)
    .all<{ g: string; newest: number }>();

  const out: KnownGroup[] = [];
  for (const row of rows.results ?? []) {
    if (!row.g) continue;
    // A group name makes the dropdown readable; a failed lookup just means the id is shown instead —
    // which is still usable, unlike hiding the entry.
    const name = await groupLabel(env, row.g).catch(() => null);
    out.push({ openid: row.g, label: name ? `${name} · ${row.g.slice(0, 10)}…` : `${row.g.slice(0, 16)}…` });
  }
  return out;
}

/** Fetch a group's display name, or null when the platform will not say. */
async function groupLabel(env: Env, groupOpenid: string): Promise<string | null> {
  const token = await getAccessToken(env);
  const host = env.QQ_SANDBOX === 'true' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
  const res = await fetch(`${host}/v2/groups/${groupOpenid}/info`, {
    headers: { authorization: `QQBot ${token}`, 'x-union-appid': env.QQ_APP_ID },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { group_name?: string };
  return json.group_name?.trim() || null;
}
