/**
 * The admin authentication gate.
 *
 * This file used to be 1,300 lines of server-rendered HTML — one template function per page. The
 * console is now a Vue app (see `web/`), so what remains is only what the SERVER must own:
 *
 *   - the credential check, because a client-side check is not a check;
 *   - one aggregate query the console's status view needs.
 *
 * Everything else moved: presentation to the browser, mutations to `handlers.ts`, and the JSON the
 * console reads to `api.ts`. The old renderers are deleted rather than kept, because two UIs over one
 * data model drift apart and the dead one is the one that rots.
 */

import type { Env } from '../types';

/** A 401 that asks the browser for credentials. */
export function basicAuthChallenge(): Response {
  return new Response('authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="cf-ds-api-qq-bot admin", charset="UTF-8"' },
  });
}

/**
 * Constant-time compare that does not leak length via early exit.
 *
 * The obvious `if (a.length !== b.length) return false` gives away the length and then stops at the
 * first differing character, so response time reveals both the length and the matching prefix of the
 * password. This folds the length difference into the accumulator and always walks the longer string,
 * so the work depends only on the (public) maximum length.
 *
 * WebCrypto's timingSafeEqual is not exposed in Workers, so the comparison is written out.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * Check the Basic credentials against `ADMIN_PASSWORD`.
 *
 * Fails CLOSED when no password is configured: an unset secret must not mean "no authentication".
 */
export function checkAdminAuth(env: Env, authorization: string | null): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  if (!authorization || !authorization.toLowerCase().startsWith('basic ')) return false;
  let decoded: string;
  try {
    decoded = atob(authorization.slice(6).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return timingSafeEqual(decoded.slice(idx + 1), env.ADMIN_PASSWORD);
}

export interface RealEventStats {
  /** Rows in call_log with origin='qq'. */
  total: number;
  /** Rows whose origin_ref does NOT look like a synthetic test identifier. */
  real: number;
  /** Timestamp of the newest real event, or null. */
  newestReal: number | null;
}

/**
 * Count events that actually came from QQ, as opposed to the probe events used in testing.
 *
 * THIS IS THE DIAGNOSTIC THAT MATTERS when a bot appears not to work, because it separates two failures
 * that look identical from the outside:
 *
 *   - the callback URL was never configured, so no event ever arrives (real = 0);
 *   - the callback is configured but delivery fails, so events arrive and error (real > 0).
 *
 * Those need completely different fixes, and without this distinction the only available evidence is
 * "the bot did not reply", which is consistent with both.
 *
 * Synthetic events are recognisable because their openids are the literals used in development
 * ("USER_OPENID_test" and friends); a real one is an opaque QQ identifier.
 */
export async function realEventStats(env: Env): Promise<RealEventStats> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN origin_ref LIKE 'USER_OPENID_%' OR origin_ref = 'unknown' THEN 0 ELSE 1 END) AS real,
            MAX(CASE WHEN origin_ref LIKE 'USER_OPENID_%' OR origin_ref = 'unknown' THEN NULL ELSE created_at END) AS newest_real
       FROM call_log WHERE origin = 'qq'`,
  ).first<{ total: number; real: number | null; newest_real: number | null }>();
  return {
    total: row?.total ?? 0,
    real: row?.real ?? 0,
    newestReal: row?.newest_real ?? null,
  };
}
