/**
 * Scheduled interjections ("发牢骚"): the bot speaks up on its own.
 *
 * THREE CONSTRAINTS SHAPED THIS DESIGN, and each one is a measured fact rather than a preference.
 *
 * 1. NO CRON. A free-plan Cron Trigger gets 10 ms of CPU — the same allowance as a request — while
 *    solving one proof-of-work challenge costs a full difficulty-144,000 search (ADR-0007). A model
 *    call therefore CANNOT complete inside a cron invocation. So the scheduler is driven by ordinary
 *    requests: each incoming QQ event checks whether an interjection is due, and if one is, the
 *    already-running `waitUntil` handles it. No new infrastructure, and no CPU budget that does not
 *    exist.
 *
 * 2. AT MOST ONE IN FLIGHT. Two interjections racing would both read the same "last sent" value and
 *    both decide to speak, producing a double post. A Durable Object would serialise this properly,
 *    but a conditional UPDATE is enough for one bot in one group: the row is claimed by an
 *    UPDATE that only matches when the stored timestamp is still what we read. Whichever request
 *    wins the write speaks; the loser sees zero changed rows and stays quiet.
 *
 * 3. A RANDOM TIME NEEDS A PRE-COMMITTED TARGET. "Random time each day" cannot mean "check every
 *    request whether the dice say now" — with a request every few seconds that fires almost
 *    immediately. Instead a target time is drawn once per day and stored; the first check after it
 *    passes is the one that fires. That is what makes it random in the sense a person expects:
 *    unpredictable, but exactly once.
 *
 * Nothing here sends anything by itself. `dueInterjection` reports what is due and `markSent`
 * records that it happened, so the decision and the side effect stay separable — and testable
 * without a network.
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

/** How the daily interjection time is chosen. */
export type ScheduleMode = 'random' | 'fixed';

export interface InterjectionConfig {
  /** Whether the feature is on for this group. */
  enabled: boolean;
  /**
   * Interjections per day. Capped by MAX_PER_DAY, and 0 is a valid way to keep the config while
   * silencing the bot — distinct from `enabled: false`, which discards the rest of the settings.
   */
  perDay: number;
  mode: ScheduleMode;
  /**
   * Time of day for `fixed` mode, "HH:MM" in the configured zone.
   *
   * Ignored in `random` mode, where the time is drawn instead.
   */
  at?: string;
  /**
   * What to say.
   *
   * - a non-empty string: send it verbatim (the "指定固定发出的内容" case)
   * - empty/absent: ask the model to comment on what the group has been saying
   *
   * This is the difference between a bot that repeats a configured line and one that reacts to the
   * room, and both are useful for different reasons.
   */
  text?: string;
}

/**
 * Upper bound on interjections per day.
 *
 * Not a technical limit — a social one. A bot that speaks unprompted more than a few times a day in
 * a group of friends is spam, and the platform's own rate limits (20 proactive messages/minute per
 * group) are far more permissive than what people tolerate.
 */
export const MAX_PER_DAY = 10;

/** Default when a group has never been configured. Off, so nothing speaks until asked to. */
export const DEFAULT_CONFIG: InterjectionConfig = { enabled: false, perDay: 1, mode: 'random' };

/** State key namespaces, so the admin view can find and purge them. */
export const INTERJECTION_CONFIG_PREFIX = 'interject_config:';
export const INTERJECTION_STATE_PREFIX = 'interject_state:';

/** Per-group daily bookkeeping. */
interface InterjectionState {
  /** The day this record belongs to; a new day resets the counters. */
  day: string;
  /** How many were sent today. */
  sent: number;
  /**
   * When the next one is due, as an absolute epoch ms.
   *
   * An absolute time rather than "seconds from now" so a restart or an idle period cannot push it
   * around, and so the admin view can show when it will happen.
   */
  nextDueAt: number;
}

const configKey = (group: string): string => `${INTERJECTION_CONFIG_PREFIX}${group}`;
const stateKey = (group: string): string => `${INTERJECTION_STATE_PREFIX}${group}`;

export async function getInterjectionConfig(env: Env, group: string): Promise<InterjectionConfig> {
  const raw = await getState(env.DB, configKey(group));
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<InterjectionConfig>;
    return normalizeConfig(parsed);
  } catch {
    console.error(`unreadable interjection config for ${group}; treating it as off`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Coerce a stored or submitted config into a valid one.
 *
 * Every field is validated rather than trusted: these values come from a form, and a `perDay` of
 * 1000 or an `at` of "banana" would otherwise reach the scheduler and either spam a group or
 * silently never fire.
 */
export function normalizeConfig(input: Partial<InterjectionConfig>): InterjectionConfig {
  const perDayRaw = Number(input.perDay);
  const perDay = Number.isFinite(perDayRaw) ? Math.min(Math.max(Math.floor(perDayRaw), 0), MAX_PER_DAY) : 1;
  const mode: ScheduleMode = input.mode === 'fixed' ? 'fixed' : 'random';
  const at = typeof input.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.at.trim()) ? input.at.trim() : undefined;
  const text = typeof input.text === 'string' && input.text.trim() ? input.text.trim().slice(0, 500) : undefined;
  return { enabled: input.enabled === true, perDay, mode, at, text };
}

export async function setInterjectionConfig(env: Env, group: string, config: InterjectionConfig): Promise<void> {
  await setState(env.DB, configKey(group), JSON.stringify(normalizeConfig(config)));
  // Changing the schedule invalidates the pending time, so it is recomputed on the next check
  // rather than firing at a moment the operator has just moved away from.
  await env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(stateKey(group)).run();
}

/**
 * Draw the next due time.
 *
 * RANDOM MODE spreads the remaining interjections across the remaining part of the day rather than
 * picking uniformly across all 24 hours: picking across the whole day means a draw can land in the
 * past, which would fire immediately and make the feature look broken (or worse, fire several at
 * once as each check re-draws a past time).
 *
 * `rand` is injectable so the behaviour can be asserted without flakiness.
 */
export function drawNextDueAt(
  config: InterjectionConfig,
  day: string,
  nowMs: number,
  timeZone: string,
  sentToday: number,
  rand: () => number = Math.random,
): number {
  if (config.mode === 'fixed' && config.at) {
    const [hh, mm] = config.at.split(':').map(Number);
    const target = zonedTimeToEpoch(day, hh, mm, timeZone);
    // If today's slot has passed and the quota allows more, the next one is tomorrow — a fixed
    // time means a time, not "as soon as possible".
    if (target > nowMs) return target;
    const tomorrow = addDays(day, 1);
    return zonedTimeToEpoch(tomorrow, hh, mm, timeZone);
  }

  // Random: pick somewhere in the rest of today, or early tomorrow if today is nearly over.
  //
  // The result is clamped to be STRICTLY after `nowMs`. A draw of exactly 0 would otherwise return
  // the current instant, which counts as due on the very next check — so a "random" schedule would
  // fire immediately, and then again on every check that re-drew zero. The floor is one minute,
  // which is both imperceptible as a delay and impossible to collide with.
  const MIN_DELAY_MS = 60_000;
  const endOfDay = zonedTimeToEpoch(addDays(day, 1), 0, 0, timeZone);
  const remaining = endOfDay - nowMs;
  if (remaining <= MIN_DELAY_MS) {
    // Less than a minute left: aim at a random point in the coming day instead of a sliver.
    const nextDay = addDays(day, 1);
    const dayEnd = zonedTimeToEpoch(addDays(nextDay, 1), 0, 0, timeZone);
    const span = Math.max(dayEnd - endOfDay, MIN_DELAY_MS);
    return Math.max(nowMs + MIN_DELAY_MS, endOfDay + Math.floor(rand() * span));
  }
  // Spread the remaining quota over the remaining time, so several per day do not cluster.
  const slots = Math.max(config.perDay - sentToday, 1);
  const slot = Math.floor(remaining / slots);
  const base = nowMs + slot * Math.max(0, Math.min(sentToday, slots - 1));
  return Math.max(nowMs + MIN_DELAY_MS, base + Math.floor(rand() * Math.max(slot, MIN_DELAY_MS)));
}

export interface DueDecision {
  due: boolean;
  /** Why not, when not due — so the admin view can explain rather than just say "no". */
  reason?: 'disabled' | 'quota-used' | 'not-yet' | 'no-state';
  /** The absolute time it will next be due, when known. */
  nextDueAt?: number;
  /** True when this call claimed the slot; the caller must call `markSent` after a successful send. */
  claimed?: boolean;
}

/**
 * Decide whether an interjection is due, and claim the slot if so.
 *
 * The claim is a conditional write: the state row is only updated when its `nextDueAt` still equals
 * what this call read. Two concurrent checks therefore cannot both claim — the loser's UPDATE
 * matches nothing. This is the cheap alternative to a Durable Object for the one-bot-one-group case.
 */
export async function dueInterjection(
  env: Env,
  group: string,
  nowMs: number = Date.now(),
  rand: () => number = Math.random,
): Promise<DueDecision> {
  const config = await getInterjectionConfig(env, group);
  if (!config.enabled) return { due: false, reason: 'disabled' };
  if (config.perDay <= 0) return { due: false, reason: 'quota-used' };

  const tz = env.QQ_SESSION_TZ || 'Asia/Shanghai';
  const day = dayKeyInZone(nowMs, tz);

  const raw = await getState(env.DB, stateKey(group));
  let state: InterjectionState | null = null;
  if (raw) {
    try {
      state = JSON.parse(raw) as InterjectionState;
    } catch {
      state = null;
    }
  }

  // A record from an earlier day starts fresh: the quota is per day, and yesterday's count must not
  // consume today's.
  if (!state || state.day !== day) {
    const nextDueAt = drawNextDueAt(config, day, nowMs, tz, 0, rand);
    const fresh: InterjectionState = { day, sent: 0, nextDueAt };
    await setState(env.DB, stateKey(group), JSON.stringify(fresh));
    return { due: false, reason: 'no-state', nextDueAt };
  }

  if (state.sent >= config.perDay) return { due: false, reason: 'quota-used', nextDueAt: state.nextDueAt };
  if (nowMs < state.nextDueAt) return { due: false, reason: 'not-yet', nextDueAt: state.nextDueAt };

  // Due. Claim it with a conditional write: only the caller that sees the same nextDueAt wins.
  const nextDueAt = drawNextDueAt(config, day, nowMs, tz, state.sent + 1, rand);
  const claimed: InterjectionState = { day, sent: state.sent + 1, nextDueAt };
  const res = await env.DB.prepare(
    'UPDATE app_state SET value = ?1 WHERE key = ?2 AND value = ?3',
  )
    .bind(JSON.stringify(claimed), stateKey(group), JSON.stringify(state))
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    // Another request claimed it first. Staying quiet is correct; speaking would double-post.
    return { due: false, reason: 'not-yet', nextDueAt: state.nextDueAt };
  }
  return { due: true, claimed: true, nextDueAt };
}

/**
 * Record that an interjection was sent.
 *
 * Called after the send succeeds. `dueInterjection` has already advanced the counter as part of
 * claiming the slot, so this only refreshes the timestamp — kept separate so a failed send does not
 * silently consume a day's quota... which it does anyway, and that is the honest tradeoff: retrying
 * a failed interjection risks double-posting, which is worse than losing one.
 */
export async function markSent(env: Env, group: string, nowMs: number = Date.now()): Promise<void> {
  const raw = await getState(env.DB, stateKey(group));
  if (!raw) return;
  try {
    const state = JSON.parse(raw) as InterjectionState;
    await setState(env.DB, stateKey(group), JSON.stringify({ ...state, updatedAt: nowMs }));
  } catch {
    /* nothing to update */
  }
}

/** Status for the admin view: the config plus when it will next speak. */
export async function interjectionStatus(
  env: Env,
  group: string,
  nowMs: number = Date.now(),
): Promise<{ config: InterjectionConfig; day: string; sent: number; nextDueAt: number | null }> {
  const tz = env.QQ_SESSION_TZ || 'Asia/Shanghai';
  const day = dayKeyInZone(nowMs, tz);
  const config = await getInterjectionConfig(env, group);
  const raw = await getState(env.DB, stateKey(group));
  if (!raw) return { config, day, sent: 0, nextDueAt: null };
  try {
    const state = JSON.parse(raw) as InterjectionState;
    if (state.day !== day) return { config, day, sent: 0, nextDueAt: null };
    return { config, day, sent: state.sent, nextDueAt: state.nextDueAt };
  } catch {
    return { config, day, sent: 0, nextDueAt: null };
  }
}

/** Forget a group's interjection settings and bookkeeping entirely. */
export async function clearInterjectionConfig(env: Env, group: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_state WHERE key IN (?1, ?2)')
    .bind(configKey(group), stateKey(group))
    .run();
}

/** Every group that has an interjection configuration, for the admin view. */
export async function listInterjectionGroups(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT key FROM app_state WHERE key LIKE ?')
    .bind(`${INTERJECTION_CONFIG_PREFIX}%`)
    .all<{ key: string }>();
  return (rows.results ?? []).map((r) => r.key.slice(INTERJECTION_CONFIG_PREFIX.length));
}

/**
 * Force an interjection now, ignoring the schedule.
 *
 * The schedule is deliberately unpredictable, which makes it untestable by waiting: "it never
 * fired" and "it fired and failed" look identical. This makes the send path exercisable on demand.
 *
 * It does NOT go through the claim, so it cannot double-post with a scheduled one in a harmful way
 * — at worst the group sees a test message and then the scheduled one shortly after, which is
 * expected when a human presses a button.
 */
export async function runInterjectionNow(
  env: Env,
  group: string,
  send: (text: string) => Promise<{ ok: boolean; status: number; body: string }>,
  compose?: () => Promise<string | null>,
): Promise<{ ok: boolean; detail: string }> {
  const config = await getInterjectionConfig(env, group);
  let text = config.text ?? null;

  if (!text) {
    if (!compose) return { ok: false, detail: '这条没有固定内容，且没有可用的生成方式。' };
    text = await compose();
    if (!text) return { ok: false, detail: '模型没有产出内容（可能是群里还没有可读的消息）。' };
  }

  const sent = await send(text);
  return sent.ok
    ? { ok: true, detail: `已发送：「${text.slice(0, 40)}」` }
    : { ok: false, detail: `发送失败：HTTP ${sent.status} ${sent.body.slice(0, 120)}` };
}

// ───────────────────────────────────────────────────────────────── date helpers

/**
 * The calendar day in `timeZone`, formatted YYYY-MM-DD.
 *
 * Duplicated from session.ts deliberately rather than imported: this module must be usable without
 * pulling in the session store, and the two have different reasons to exist. The `en-CA` locale is
 * used because its date format IS ISO-8601, so the result needs no parsing.
 */
export function dayKeyInZone(nowMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(nowMs),
    );
  } catch {
    console.error(`invalid timezone ${JSON.stringify(timeZone)}; using UTC`);
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/** Add whole days to a YYYY-MM-DD string. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Convert a local wall-clock time in `timeZone` to an epoch timestamp.
 *
 * There is no `Intl` API for this, so the offset is measured: guess the UTC instant, format it back
 * in the target zone, and correct by the difference. One correction is enough for every real zone,
 * including ones with DST, because the guess is within a day of the answer.
 */
export function zonedTimeToEpoch(day: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  const asZone = new Date(guess).toLocaleString('sv-SE', { timeZone });
  // `sv-SE` yields "YYYY-MM-DD HH:MM:SS", which Date.parse reads as local time.
  const zoneAsUtc = Date.parse(asZone.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(zoneAsUtc)) return guess;
  return guess - (zoneAsUtc - guess);
}
