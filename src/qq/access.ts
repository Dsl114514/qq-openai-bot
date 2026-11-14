/**
 * Access control: who and which groups the bot will answer.
 *
 * WHY THIS EXISTS. Until now the bot answered anybody in any group it was added to. There was no way to
 * stop a particular person from using it, and no way to keep it out of a group while still being a member
 * (which is what you need when it was added by mistake or as a joke).
 *
 * THE ALLOW/DENY RULE IS DELIBERATELY NOT A SINGLE LIST. Two different questions are being asked:
 *
 *   - "is this a private bot?" — only listed ids may use it; that is an ALLOWLIST, and it must default to
 *     refusing everything not on it, or it is not a restriction at all;
 *   - "keep it out of these specific places" — everything works except the listed ids; that is a DENYLIST.
 *
 * Collapsing them into one list with an `allow | deny` mode flag makes the two impossible to use together,
 * which is the common case: "private bot, but one trusted group may use it freely". So the model is an
 * allowlist and a denylist per kind, and the MODE says what an unlisted id gets.
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

/** What a request from an id that appears on neither list gets. */
export type AccessMode = 'open' | 'closed';

export interface AccessList {
  /** Who may use the bot, in a `closed` mode. */
  users: string[];
  /** Which groups may use the bot, in a `closed` mode. */
  groups: string[];
  /** Ids refused even when the mode is `open`. */
  deniedUsers: string[];
  /** Groups refused even when the mode is `open`. */
  deniedGroups: string[];
  mode: AccessMode;
}

export const ACCESS_KEY = 'access:rules';

export const DEFAULT_ACCESS: AccessList = {
  users: [],
  groups: [],
  deniedUsers: [],
  deniedGroups: [],
  // `open` by default, so upgrading does not silently stop the bot answering everyone who could use it
  // yesterday. Restriction is opt-in; that is the safe direction for a change to permissions.
  mode: 'open',
};

/** Bounds, so a pasted list cannot bloat the row or the comparison loop. */
const MAX_IDS = 500;
const ID_MAX = 128;

/** Normalise an id list: trimmed, deduplicated, bounded, blanks dropped. */
function cleanIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || id.length > ID_MAX || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

export function normalizeAccess(input: unknown): AccessList {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    users: cleanIds(raw.users),
    groups: cleanIds(raw.groups),
    deniedUsers: cleanIds(raw.deniedUsers),
    deniedGroups: cleanIds(raw.deniedGroups),
    mode: raw.mode === 'closed' ? 'closed' : 'open',
  };
}

export async function getAccessRules(env: Env): Promise<AccessList> {
  const stored = await getState(env.DB, ACCESS_KEY);
  if (!stored) return { ...DEFAULT_ACCESS };
  try {
    return normalizeAccess(JSON.parse(stored) as unknown);
  } catch {
    console.error('access rules row is not valid JSON; falling back to open access');
    return { ...DEFAULT_ACCESS };
  }
}

export async function setAccessRules(env: Env, rules: AccessList): Promise<AccessList> {
  const next = normalizeAccess(rules);
  await setState(env.DB, ACCESS_KEY, JSON.stringify(next));
  return next;
}

/** Where a message came from, for the access decision. */
export interface AccessContext {
  /** The sender's openid. */
  user: string;
  /** The group openid, or null for a direct message. */
  group: string | null;
}

export interface AccessDecision {
  allowed: boolean;
  /** Why, for the audit log — never shown to the user, who would learn what to change. */
  reason: string;
}

/**
 * Decide whether the bot should handle this message.
 *
 * DENY ALWAYS WINS over allow. Checking the denylist first means an id on both lists is refused, which is
 * the only reading that makes "deny" mean anything — a precedence the other way would let a stale allowlist
 * entry quietly re-enable something that was deliberately blocked.
 *
 * The reason is returned rather than logged here so the caller can record it against the right row.
 */
export function checkAccess(rules: AccessList, context: AccessContext): AccessDecision {
  if (rules.deniedUsers.includes(context.user)) {
    return { allowed: false, reason: 'denied-user' };
  }
  if (context.group && rules.deniedGroups.includes(context.group)) {
    return { allowed: false, reason: 'denied-group' };
  }

  // A direct message has no group, so a group allowlist cannot apply to it: gating DMs on a group list
  // would refuse them all, which is never what an operator means.
  if (rules.mode === 'closed') {
    const userOk = rules.users.includes(context.user);
    const groupOk = context.group ? rules.groups.includes(context.group) : false;
    if (!userOk && !groupOk) {
      return { allowed: false, reason: context.group ? 'not-listed' : 'not-listed-dm' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}
