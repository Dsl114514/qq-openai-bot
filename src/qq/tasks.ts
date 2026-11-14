/**
 * Scheduled tasks: messages the bot sends on its own, without being addressed.
 *
 * This GENERALISES the existing "发牢骚" feature rather than replacing it. That feature could do exactly
 * one thing — N times a day, either at a random time or one fixed time, either a fixed string or a line
 * generated from recent group chatter. Everything it could express is expressible here, and the extra
 * shapes are the ones people actually asked for: a weekly reminder, several distinct messages in one day,
 * and a per-task choice between fixed text and generated text.
 *
 * WHY A LIST OF TIMES RATHER THAN A CRON STRING. A cron field is compact and unreadable, and the value here
 * is set through a web form. `["09:00", "21:30"]` says what it does; `0 9,21 * * *` requires the reader to
 * trust that the parser and the display agree. The parser accepts both, so an operator who prefers cron can
 * paste one and still see the expanded form afterwards.
 *
 * WHY THE OLD CONFIG IS MIGRATED RATHER THAN DELETED. The old rows are the only record of what was
 * configured. Turning them into a task of the equivalent shape means an upgrade does not silently stop a
 * feature someone set up — the failure this project has hit repeatedly (see ADR-0015).
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

export type TaskKind = 'daily' | 'weekly' | 'interval';
/** What to send. */
export type TaskContent = { kind: 'fixed'; text: string } | { kind: 'generated' };

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  /** Which group to post in. Only group targets are supported: a proactive DM needs a different API. */
  group: string;
  kind: TaskKind;
  /** `HH:MM` in the configured zone. Used by `daily` and `weekly`. */
  times: string[];
  /** ISO weekdays (1 = Monday … 7 = Sunday). Used by `weekly`. */
  weekdays: number[];
  /** Minimum minutes between runs. Used by `interval`. */
  everyMinutes: number;
  content: TaskContent;
}

export const TASK_PREFIX = 'task:';
export const TASK_RUN_PREFIX = 'task_run:';

/** Bounds, so a form cannot create something the scheduler cannot honour. */
const MAX_TASKS = 50;
const MAX_TIMES = 12;
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const NAME_MAX = 60;
const TEXT_MAX = 500;

const taskKey = (id: string): string => `${TASK_PREFIX}${id}`;
const runKey = (id: string): string => `${TASK_RUN_PREFIX}${id}`;

/**
 * A short, stable id derived from the target and content.
 *
 * Deterministic rather than random so that saving the same task twice UPDATES it instead of creating a
 * duplicate — which matters because the console form has no id field for the operator to keep track of.
 */
export function taskId(group: string, name: string): string {
  const basis = `${group}:${name.trim().toLowerCase()}`;
  // A simple deterministic hash is sufficient: this is a lookup key, not a security boundary, and a
  // collision would be caught by the fact that the stored task's `name` would differ.
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Parse `HH:MM` (24h). Returns null when it is not a valid time. */
export function parseTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Expand a cron expression of the limited shape this scheduler supports.
 *
 * Only the two forms that map cleanly onto "daily" and "weekly" are accepted — `M H * * *` and
 * `M H * * D[,D…]`. Anything else returns null, and the caller keeps whatever the operator typed in the
 * `times`/`weekdays` fields instead. Guessing at a general cron implementation would mean silently
 * mis-scheduling tasks whose expression the parser did not really understand.
 */
export function parseCron(expr: string): { times: string[]; weekdays: number[] } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*') return null;

  const mins = minute === '*' ? null : minute.split(',').map((s) => Number(s));
  const hours = hour === '*' ? null : hour.split(',').map((s) => Number(s));
  if (!mins || !hours) return null;
  if (mins.some((n) => !Number.isInteger(n) || n < 0 || n > 59)) return null;
  if (hours.some((n) => !Number.isInteger(n) || n < 0 || n > 23)) return null;

  const times: string[] = [];
  for (const h of hours) for (const m of mins) times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  if (times.length === 0 || times.length > MAX_TIMES) return null;

  let weekdays: number[] = [];
  if (dow !== '*') {
    weekdays = dow
      // Cron uses 0 for Sunday; ISO uses 7. Accept both.
      .split(',')
      .map((s) => (s === '0' ? 7 : Number(s)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
    if (weekdays.length === 0) return null;
  }
  return { times, weekdays };
}

/** Coerce an arbitrary object into a usable task, or report why it cannot be one. */
export function normalizeTask(input: unknown): { task: ScheduledTask } | { error: string } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const group = typeof raw.group === 'string' ? raw.group.trim() : '';
  if (!group) return { error: '缺少群标识' };

  const name = (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '未命名任务').slice(0, NAME_MAX);
  const kind: TaskKind = raw.kind === 'weekly' || raw.kind === 'interval' ? raw.kind : 'daily';

  const times = Array.isArray(raw.times)
    ? raw.times
        .map((t) => (typeof t === 'string' ? parseTime(t) : null))
        .filter((t): t is string => t !== null)
        .slice(0, MAX_TIMES)
    : [];

  const weekdays = Array.isArray(raw.weekdays)
    ? [...new Set(raw.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
    : [];

  const everyRaw = Number(raw.everyMinutes);
  const everyMinutes = Number.isFinite(everyRaw)
    ? Math.min(Math.max(Math.round(everyRaw), MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES)
    : 60;

  if ((kind === 'daily' || kind === 'weekly') && times.length === 0) {
    return { error: '至少需要一个有效时间（HH:MM）' };
  }
  if (kind === 'weekly' && weekdays.length === 0) {
    return { error: '每周任务至少需要选择一天' };
  }

  // Content: an explicit object wins; a bare `text` string is accepted as the fixed-content shorthand that
  // the old interjection form produced.
  let content: TaskContent;
  const contentRaw = raw.content as Record<string, unknown> | undefined;
  if (contentRaw && contentRaw.kind === 'generated') {
    content = { kind: 'generated' };
  } else if (contentRaw && contentRaw.kind === 'fixed' && typeof contentRaw.text === 'string') {
    content = { kind: 'fixed', text: contentRaw.text.slice(0, TEXT_MAX) };
  } else if (typeof raw.text === 'string' && raw.text.trim()) {
    content = { kind: 'fixed', text: raw.text.trim().slice(0, TEXT_MAX) };
  } else {
    // Empty means "let the model read the group and say something" — the behaviour that was already there.
    content = { kind: 'generated' };
  }

  return {
    task: {
      id: taskId(group, name),
      name,
      enabled: raw.enabled !== false,
      group,
      kind,
      times,
      weekdays,
      everyMinutes,
      content,
    },
  };
}

export async function saveTask(env: Env, task: ScheduledTask): Promise<void> {
  await setState(env.DB, taskKey(task.id), JSON.stringify(task));
}

export async function getTask(env: Env, id: string): Promise<ScheduledTask | null> {
  const stored = await getState(env.DB, taskKey(id));
  if (!stored) return null;
  try {
    const normalized = normalizeTask(JSON.parse(stored) as unknown);
    return 'task' in normalized ? normalized.task : null;
  } catch {
    return null;
  }
}

export async function deleteTask(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_state WHERE key IN (?1, ?2)')
    .bind(taskKey(id), runKey(id))
    .run();
}

/** Every stored task, newest name first for a stable listing. */
export async function listTasks(env: Env): Promise<ScheduledTask[]> {
  const rows = await env.DB.prepare('SELECT value FROM app_state WHERE key LIKE ?1')
    .bind(`${TASK_PREFIX}%`)
    .all<{ value: string }>();

  const out: ScheduledTask[] = [];
  for (const row of rows.results ?? []) {
    try {
      const normalized = normalizeTask(JSON.parse(row.value) as unknown);
      if ('task' in normalized) out.push(normalized.task);
      else console.error(`task row rejected: ${normalized.error}`);
    } catch {
      /* unreadable rows are skipped, not fatal */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** When a task last ran, as epoch ms, or 0 when it never has. */
export async function lastRunAt(env: Env, id: string): Promise<number> {
  const stored = await getState(env.DB, runKey(id));
  const n = stored ? Number(stored) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function markTaskRun(env: Env, id: string, nowMs: number = Date.now()): Promise<void> {
  await setState(env.DB, runKey(id), String(nowMs));
}

// ─────────────────────────────────────────────────────────── the scheduler

/** Minutes since midnight in a zone, plus the day key and ISO weekday there. */
export interface ZonedNow {
  day: string;
  minutes: number;
  weekday: number;
}

/**
 * The local wall-clock reading in a zone, derived from epoch ms.
 *
 * Uses `Intl` rather than arithmetic on the offset because the offset CHANGES across a DST boundary, and
 * a fixed offset would schedule an hour wrong for half the year in any zone that observes it.
 *
 * FALLS BACK TO UTC ON A BAD ZONE rather than throwing. This runs on every incoming event, so a typo in
 * `QQ_SESSION_TZ` would otherwise take down the scheduler AND the reply path — a configuration mistake
 * turning into a total outage. Scheduling a few hours off is recoverable; not answering is not.
 */
export function zonedNow(nowMs: number, timeZone: string): ZonedNow {
  try {
    return zonedNowStrict(nowMs, timeZone);
  } catch (e) {
    if (timeZone !== 'UTC') {
      console.error(`invalid time zone "${timeZone}" (${e instanceof Error ? e.message : e}); falling back to UTC`);
    }
    return zonedNowStrict(nowMs, 'UTC');
  }
}

/** The real implementation, which throws on an unknown zone so the caller can substitute one. */
function zonedNowStrict(nowMs: number, timeZone: string): ZonedNow {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24; // some ICU builds render midnight as "24"
  const minute = Number(parts.minute);
  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekday = weekdayNames.indexOf(parts.weekday ?? 'Mon') + 1;

  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: hour * 60 + minute, weekday: weekday || 1 };
}

export interface TaskRunDecision {
  /** A task that should run right now, or null. */
  run: ScheduledTask | null;
  /** Why nothing ran, for the console's "why didn't it fire" answer. */
  reason: string;
}

/**
 * Pick at most ONE due task.
 *
 * One per invocation on purpose: the runner sends messages, and sending several from a single webhook
 * handler would burst the passive-reply quota and turn one missed schedule into several. The next
 * invocation picks up the next task.
 *
 * `due` is a claim, not a prediction: the caller must report success with `markTaskRun`, or the same task
 * looks due again on the next event. That is the intended behaviour for a FAILED send — better a retry
 * than a silently skipped message.
 */
export async function dueTask(env: Env, nowMs: number, timeZone: string): Promise<TaskRunDecision> {
  const tasks = await listTasks(env);
  if (tasks.length === 0) return { run: null, reason: 'no-tasks' };

  const now = zonedNow(nowMs, timeZone);
  const enabled = tasks.filter((t) => t.enabled);
  if (enabled.length === 0) return { run: null, reason: 'all-disabled' };

  for (const task of enabled) {
    const last = await lastRunAt(env, task.id);

    if (task.kind === 'interval') {
      if (last === 0) {
        // Never run: fire immediately rather than waiting a full interval, so enabling a task has a
        // visible effect instead of looking broken.
        return { run: task, reason: 'interval-first-run' };
      }
      if (nowMs - last >= task.everyMinutes * 60_000) return { run: task, reason: 'interval-due' };
      continue;
    }

    // `daily` and `weekly`: a scheduled minute, run at most once per day.
    const lastLocal = last > 0 ? zonedNow(last, timeZone) : null;
    const alreadyToday = lastLocal !== null && lastLocal.day === now.day;
    if (alreadyToday) continue;

    if (task.kind === 'weekly' && !task.weekdays.includes(now.weekday)) continue;

    const target = task.times
      .map((t) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      })
      .sort((a, b) => a - b);

    // Run when the current minute has reached a scheduled time. The window is intentionally open-ended
    // rather than an exact-minute match: a Worker has no clock and only runs when an event arrives, so an
    // exact match would miss the slot entirely whenever nothing happened at that minute.
    const hit = target.find((t) => now.minutes >= t);
    if (hit !== undefined) {
      return { run: task, reason: `scheduled-${String(Math.floor(hit / 60)).padStart(2, '0')}:${String(hit % 60).padStart(2, '0')}` };
    }
  }

  return { run: null, reason: 'nothing-due' };
}

// ─────────────────────────────────────────────────────────── legacy migration

/**
 * Convert the old `interject_config:<group>` rows into tasks.
 *
 * WHY MIGRATE RATHER THAN IGNORE: the old rows are the only record of a configured feature. Dropping them
 * would silently stop a scheduled message someone set up, and the failure would look like "the feature
 * broke" — the exact class of problem this project keeps fixing (ADR-0015). The old keys are left in place
 * so a rollback still finds them.
 *
 * RUNS ON EVERY EVENT, SO IT MUST NOT CLOBBER. This was measured the hard way: the first version called
 * `saveTask` unconditionally, and because the scheduler invokes this on every incoming message, an edit made
 * in the console was silently reverted to the old config's value by the next group message. The operator
 * would see their change undone with nothing in the logs to explain it.
 *
 * So the migration records a FINGERPRINT of the config it converted, and touches the task only when that
 * fingerprint changes. That gives the semantics an operator expects:
 *
 *   - edit the task in the console  -> the old config is unchanged, so nothing overwrites it;
 *   - edit the OLD config           -> the fingerprint changes, so the task is updated to match.
 *
 * Idempotent by construction: re-running with an unchanged config writes nothing at all.
 */
export async function migrateInterjections(env: Env): Promise<{ migrated: number; groups: string[]; skipped: number }> {
  const rows = await env.DB.prepare('SELECT key, value FROM app_state WHERE key LIKE ?1')
    .bind('interject_config:%')
    .all<{ key: string; value: string }>();

  const groups: string[] = [];
  let skipped = 0;

  for (const row of rows.results ?? []) {
    const group = row.key.slice('interject_config:'.length);
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (cfg.enabled !== true) continue;

    // The fingerprint is a CANONICAL serialisation of the config, with object keys sorted.
    //
    // `JSON.stringify(parsed)` IS NOT ENOUGH, and that was measured: `JSON.parse` preserves the key order of
    // the source text, so the same configuration written with its keys in a different order produced a
    // different string — which looked like a change and triggered an unnecessary overwrite. Since the whole
    // point of the fingerprint is to distinguish "the operator changed the config" from "the config is
    // merely formatted differently", the comparison has to be order-insensitive.
    const fingerprint = canonicalJson(cfg);
    const marker = await getState(env.DB, migrateMarkerKey(group));
    if (marker === fingerprint) {
      skipped++;
      continue;
    }

    const perDay = Number(cfg.perDay) || 1;
    const fixedAt = typeof cfg.at === 'string' ? parseTime(cfg.at) : null;
    const text = typeof cfg.text === 'string' ? cfg.text.trim() : '';

    // A fixed-time config maps to one daily slot; a random one has no time to carry over, so it becomes an
    // interval that fires once per day. Both preserve what the operator would observe.
    const shape: Record<string, unknown> =
      cfg.mode === 'fixed' && fixedAt
        ? { kind: 'daily', times: [fixedAt] }
        : { kind: 'interval', everyMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.round((24 * 60) / Math.max(perDay, 1))) };

    const normalized = normalizeTask({
      name: MIGRATED_TASK_NAME,
      group,
      enabled: true,
      ...shape,
      ...(text ? { text } : {}),
    });
    if (!('task' in normalized)) {
      console.error(`could not migrate interjection for ${group}: ${normalized.error}`);
      continue;
    }

    await saveTask(env, normalized.task);
    await setState(env.DB, migrateMarkerKey(group), fingerprint);
    groups.push(group);
  }

  return { migrated: groups.length, groups, skipped };
}

/** The name every migrated task carries, so one can be recognised as migration output. */
export const MIGRATED_TASK_NAME = '发牢骚（从旧配置迁移）';

/** Where the fingerprint of the last-migrated config is recorded, per group. */
const migrateMarkerKey = (group: string): string => `interject_migrated:${group}`;

/**
 * A stable serialisation of a JSON value, with object keys sorted at every level.
 *
 * Used to decide whether a legacy config actually CHANGED. Plain `JSON.stringify` reflects the key order of
 * the parsed source, so two spellings of the same configuration compare as different — which would look like
 * an edit and overwrite a task the operator had changed in the console.
 *
 * Arrays keep their order: `[1, 2]` and `[2, 1]` genuinely differ.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Bounds exported so the console can show the same limits it will enforce. */
export const TASK_LIMITS = {
  maxTasks: MAX_TASKS,
  maxTimes: MAX_TIMES,
  minIntervalMinutes: MIN_INTERVAL_MINUTES,
  maxIntervalMinutes: MAX_INTERVAL_MINUTES,
  nameMax: NAME_MAX,
  textMax: TEXT_MAX,
} as const;
