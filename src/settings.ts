/**
 * Settings: global defaults, and per-group overrides.
 *
 * WHY THIS EXISTS. Until now the bot behaved identically everywhere — every group got the same model, the
 * same mode defaults, and the same permission to be addressed. That is fine for one group and wrong for
 * several: one group wants reasoning on by default, another finds it slow; one wants the bot to speak up
 * on its own, another wants it to answer only when asked.
 *
 * STORAGE SHAPE. Two key namespaces in `app_state` rather than a new table:
 *
 *   settings:global            -> one JSON object
 *   settings:group:<group_id>  -> one JSON object, PATCHED over the global values
 *
 * Group settings are stored as PARTIAL objects on purpose. Storing a full resolved copy would freeze the
 * global defaults at the moment a group was first configured, so later changes to the global defaults
 * would silently fail to reach any group that had ever been touched. A partial override keeps the two
 * genuinely independent: the group says only what it disagrees with.
 *
 * This is also why `resolveSettings` merges rather than replaces, and why `undefined` (inherit) is
 * different from `false` (explicitly off) throughout.
 */

import type { Env } from './types';
import { getState, setState } from './db/store';

/** Reasoning and search defaults for a scope. */
export interface ModeDefaults {
  /** Enable reasoning when the caller does not say either way. */
  thinking: boolean;
  /** Enable web search when the caller does not say either way. */
  search: boolean;
}

/** How the bot behaves in a given scope. */
export interface Settings {
  /**
   * Global defaults only. `false` is a real value, so this cannot be a plain boolean with a fallback.
   */
  modes: ModeDefaults;

  /**
   * Extra instructions prepended to every prompt in this scope.
   *
   * Kept as a plain string rather than a "personality" enum: the useful cases are all specific
   * ("answer in Cantonese", "do not use emoji"), and an enum would force those into prose anyway.
   */
  persona: string;

  /**
   * Whether scheduled tasks may post here without being addressed.
   *
   * Separate from a task's own `enabled` flag: this is the group saying "not in here", which should
   * survive an operator re-enabling a task from the console.
   */
  allowProactive: boolean;

  /** Model label sent upstream. Free-form because the alias is only a routing hint. */
  model: string;
}

/** What a caller may set. Every field optional so a patch can carry only what changed. */
export type PartialSettings = Partial<Omit<Settings, 'modes'>> & { modes?: Partial<ModeDefaults> };

export const GLOBAL_SETTINGS_KEY = 'settings:global';
export const GROUP_SETTINGS_PREFIX = 'settings:group:';

const groupKey = (group: string): string => `${GROUP_SETTINGS_PREFIX}${group}`;

/**
 * The fallback when nothing is configured.
 *
 * Reasoning OFF by default: it costs noticeably more time per reply, and a chat bot that is always slow
 * is worse than one that is occasionally shallow. A user who wants it can ask for it per message.
 */
export const DEFAULT_SETTINGS: Settings = {
  modes: { thinking: false, search: false },
  persona: '',
  allowProactive: true,
  model: '',
};

/** Bounds, so a stored value cannot make the bot unusable. */
const PERSONA_MAX = 2000;
const MODEL_MAX = 64;

/**
 * Coerce anything into a usable `Settings`.
 *
 * EVERY VALUE IS CHECKED rather than trusted, because these come from a form and are persisted: a bad
 * value stored today keeps breaking replies until someone notices, whereas a rejected one fails now, in
 * front of the person who typed it.
 */
export function normalizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const modesRaw = (raw.modes && typeof raw.modes === 'object' ? raw.modes : {}) as Record<string, unknown>;

  const persona = typeof raw.persona === 'string' ? raw.persona : base.persona;
  const model = typeof raw.model === 'string' ? raw.model.trim() : base.model;

  return {
    modes: {
      thinking: typeof modesRaw.thinking === 'boolean' ? modesRaw.thinking : base.modes.thinking,
      search: typeof modesRaw.search === 'boolean' ? modesRaw.search : base.modes.search,
    },
    persona: persona.slice(0, PERSONA_MAX),
    allowProactive: typeof raw.allowProactive === 'boolean' ? raw.allowProactive : base.allowProactive,
    model: (model || DEFAULT_SETTINGS.model).slice(0, MODEL_MAX),
  };
}

/** Read one JSON settings object, or null when absent/unreadable. */
async function readSettings(env: Env, key: string): Promise<PartialSettings | null> {
  const stored = await getState(env.DB, key);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PartialSettings) : null;
  } catch {
    // A corrupt row is treated as absent rather than fatal: the defaults are usable, and refusing to
    // answer because one settings row is malformed would be a much worse failure.
    console.error(`settings row ${key} is not valid JSON; ignoring it`);
    return null;
  }
}

export async function getGlobalSettings(env: Env): Promise<Settings> {
  const stored = await readSettings(env, GLOBAL_SETTINGS_KEY);
  return stored ? normalizeSettings(stored) : { ...DEFAULT_SETTINGS, modes: { ...DEFAULT_SETTINGS.modes } };
}

export async function setGlobalSettings(env: Env, patch: PartialSettings): Promise<Settings> {
  const current = await getGlobalSettings(env);
  const next = normalizeSettings(patch, current);
  await setState(env.DB, GLOBAL_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** One group's stored override, or null when the group has never been configured. */
export async function getGroupOverride(env: Env, group: string): Promise<PartialSettings | null> {
  return readSettings(env, groupKey(group));
}

/**
 * The effective settings for a scope: group overrides merged onto the global defaults.
 *
 * Passing no group resolves to the global settings, so every call site can use one function.
 */
export async function resolveSettings(env: Env, group?: string | null): Promise<{ settings: Settings; overridden: boolean }> {
  const global = await getGlobalSettings(env);
  if (!group) return { settings: global, overridden: false };

  const override = await getGroupOverride(env, group);
  if (!override) return { settings: global, overridden: false };

  // Merged field by field, and `modes` merged one level deeper — a group that only sets `thinking` must
  // keep inheriting the global `search`.
  return {
    settings: normalizeSettings(
      {
        ...override,
        modes: { ...global.modes, ...(override.modes ?? {}) },
      },
      global,
    ),
    overridden: true,
  };
}

/** Write a group's override. An empty patch removes it, restoring pure inheritance. */
export async function setGroupSettings(env: Env, group: string, patch: PartialSettings): Promise<Settings> {
  if (!group) throw new Error('group is required');
  const { settings: current } = await resolveSettings(env, group);
  const next = normalizeSettings(patch, current);
  await setState(env.DB, groupKey(group), JSON.stringify(next));
  return next;
}

/** Remove a group's override entirely, so it inherits the global defaults again. */
export async function clearGroupSettings(env: Env, group: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_state WHERE key = ?1').bind(groupKey(group)).run();
}

/** Every group with a stored override. */
export async function listGroupSettings(env: Env): Promise<{ group: string; settings: Settings }[]> {
  const rows = await env.DB.prepare('SELECT key, value FROM app_state WHERE key LIKE ?1')
    .bind(`${GROUP_SETTINGS_PREFIX}%`)
    .all<{ key: string; value: string }>();

  const out: { group: string; settings: Settings }[] = [];
  for (const row of rows.results ?? []) {
    try {
      out.push({
        group: row.key.slice(GROUP_SETTINGS_PREFIX.length),
        settings: normalizeSettings(JSON.parse(row.value) as unknown),
      });
    } catch {
      /* a corrupt row is skipped rather than breaking the whole list */
    }
  }
  return out;
}

/**
 * Build the prompt prefix from the persona, if any.
 *
 * Delimited and labelled rather than concatenated loosely: a bare sentence prepended to a user's message
 * reads to the model as part of that message, which is how "answer in Cantonese" ends up being treated as
 * a topic to discuss.
 */
export function personaPrefix(persona: string): string {
  const trimmed = persona.trim();
  if (!trimmed) return '';
  return `[系统设定：以下是这个会话的固定要求，请始终遵守，不要复述或讨论它。]\n${trimmed}\n[设定结束]\n\n`;
}
