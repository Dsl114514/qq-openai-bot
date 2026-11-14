/**
 * Settings, access rules, and scheduled tasks: the write paths.
 *
 * These all follow the same rule the other admin handlers do — validate on the server and report WHY a
 * value was refused, because the operator is the only person who can fix it and the browser is not a
 * security boundary.
 *
 * A NOTE ON WHAT IS DELIBERATELY NOT VALIDATED HERE: a group id is accepted if it is syntactically an
 * id, not only if the bot has seen an event from it. That is the opposite of the interjection rule, and
 * on purpose — an access rule or a task for a group the bot has not yet heard from is legitimate (you
 * configure it before adding the bot), whereas a SCHEDULED POST to an unseen group can never fire and
 * would fail silently. So the scheduler's own group picker still refuses unknown ids.
 */

import type { Env } from '../types';
import { getGlobalSettings, setGlobalSettings, setGroupSettings, clearGroupSettings, listGroupSettings, resolveSettings, type PartialSettings } from '../settings';
import { getAccessRules, setAccessRules, type AccessList } from '../qq/access';
import { listTasks, normalizeTask, saveTask, deleteTask, getTask, lastRunAt, TASK_LIMITS, parseCron, parseTime, type ScheduledTask } from '../qq/tasks';
import { knownGroups } from './groups';

/** A request whose outcome was WRONG — a bad value, a missing field. Mapped to HTTP 400. */
const result = (ok: boolean, detail: string, extra: Record<string, unknown> = {}) =>
  Response.json({ ok, detail, ...extra }, { status: ok ? 200 : 400 });

/**
 * A DIAGNOSTIC that completed, whatever it found. Always HTTP 200.
 *
 * MEASURED BUG THIS FIXES: the connection probe returned HTTP 400 when it found an endpoint unhealthy, and the
 * console's generic request helper treats any non-2xx as a transport failure — so it threw, and the carefully
 * written diagnostic text was replaced on screen by a bare "400 Bad Request". The operator learned nothing from
 * a feature whose entire purpose is to explain what is wrong.
 *
 * The semantics are the point: the probe REQUEST succeeded. Its FINDING is that an endpoint is down, which is
 * `ok: false` in the body, not a malformed request. HTTP 400 says "your request was bad", and the operator's
 * request was perfectly fine.
 */
const diagnostic = (healthy: boolean, detail: string, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: healthy, detail, ...extra }, { status: 200 });

/**
 * Read a checkbox-ish value from a parsed body.
 *
 * Accepts the forms the three callers actually produce: `"on"` (an HTML checkbox), `"true"`/`"false"`
 * (a script), and a real boolean (JSON). Typed as `unknown` rather than the DOM's `FormDataEntryValue`
 * because these values come from `readBody`, which may have come from JSON — and the Workers type
 * definitions do not include the DOM one at all.
 */
const isOn = (v: unknown): boolean => v === 'on' || v === 'true' || v === '1' || v === true;

/**
 * Parse a JSON body, falling back to form fields.
 *
 * TOLERATING BOTH IS NOT INDULGENCE: the console's own forms post `application/x-www-form-urlencoded`
 * while a `fetch` from a script is easier as JSON, and an endpoint that silently ignores one of the two
 * looks like it accepted the request. Everything ends up as a `Record<string, unknown>`.
 */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      const parsed = (await request.json()) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const form = await request.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    // A repeated key becomes an array, which is how the multi-time and multi-weekday fields arrive.
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}

/**
 * Read a list from a parsed body, accepting EVERY separator a caller might reasonably use.
 *
 * ACCEPTS COMMA- AND WHITESPACE-SEPARATED VALUES, NOT ONLY REPEATED KEYS. The console splits its input
 * client-side and sends one parameter per value, but a direct API call naturally sends `times=09:00, 21:30`
 * and treating that as a single token produced "至少需要一个有效时间（HH:MM）" for input that clearly
 * contained two valid times. The message named the requirement without revealing that the value had never
 * been split, which is the unhelpful-error class this project keeps fixing.
 *
 * Splitting here is safe for every current caller: openids and time strings contain none of these
 * separators. Blank entries are dropped so a trailing comma is harmless.
 *
 * EXPORTED SO THE TEST EXERCISES THIS FUNCTION rather than a copy of it — a copy is free to drift, and a
 * test over a copy would keep passing while the real code changed.
 */
export const splitList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
  return raw
    .flatMap((s) => s.split(/[,，;；\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Build a `PartialSettings` patch from a parsed body, INCLUDING ONLY WHAT WAS SENT.
 *
 * The distinction that matters: an absent field means "leave it alone", while an empty string from a
 * checkbox means "off". Treating them the same would make saving one section silently reset the others,
 * which is the classic partial-update bug.
 *
 * `modes` is assembled once rather than per-field, because the settings object nests it and two separate
 * spreads would have the second clobber the first.
 */
function settingsPatch(body: Record<string, unknown>): PartialSettings {
  const modes: { thinking?: boolean; search?: boolean } = {};
  if (body.thinking !== undefined && body.thinking !== '') modes.thinking = isOn(body.thinking);
  if (body.search !== undefined && body.search !== '') modes.search = isOn(body.search);

  return {
    ...(Object.keys(modes).length > 0 ? { modes } : {}),
    ...(typeof body.persona === 'string' ? { persona: body.persona } : {}),
    ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model } : {}),
    ...(body.allowProactive !== undefined ? { allowProactive: isOn(body.allowProactive) } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────── settings

/** Global defaults plus every group override, resolved for display. */
export async function apiGetSettings(env: Env): Promise<Response> {
  const [global, groups, known] = await Promise.all([getGlobalSettings(env), listGroupSettings(env), knownGroups(env)]);

  // Each override is shown RESOLVED as well as raw: the operator needs to see the effective value, not
  // just the override, or "I set thinking=true globally and this group still does not use it" is invisible.
  const resolved = await Promise.all(
    groups.map(async (g) => {
      const { settings, overridden } = await resolveSettings(env, g.group);
      return { group: g.group, override: g.settings, effective: settings, overridden };
    }),
  );

  return Response.json({ global, groups: resolved, knownGroups: known });
}

export async function apiSetGlobalSettings(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  try {
    const next = await setGlobalSettings(env, settingsPatch(body));
    return result(true, '全局设置已保存', { settings: next });
  } catch (e) {
    return result(false, e instanceof Error ? e.message : String(e));
  }
}

export async function apiSetGroupSettings(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const group = String(body.group ?? '').trim();
  if (!group) return result(false, '缺少群标识');

  // An explicit "clear" removes the override so the group inherits the globals again. Without it, an
  // operator can never undo a group setting — only overwrite it with a copy of the current defaults,
  // which then stops tracking future global changes.
  if (isOn(body.clear)) {
    await clearGroupSettings(env, group);
    return result(true, '已清除该群设置，恢复继承全局默认');
  }

  const next = await setGroupSettings(env, group, settingsPatch(body));
  return result(true, '该群设置已保存', { settings: next });
}

// ───────────────────────────────────────────────────────────────── access rules

export async function apiGetAccess(env: Env): Promise<Response> {
  const [rules, known] = await Promise.all([getAccessRules(env), knownGroups(env)]);
  return Response.json({ rules, knownGroups: known });
}

export async function apiSetAccess(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const current = await getAccessRules(env);

  // Each list replaces wholesale when provided, and is left alone when absent — so the console can save
  // one section without having to resend the others (and without a race losing a concurrent change).
  const next: AccessList = {
    mode: body.mode === 'closed' ? 'closed' : body.mode === 'open' ? 'open' : current.mode,
    users: body.users !== undefined ? splitList(body.users) : current.users,
    groups: body.groups !== undefined ? splitList(body.groups) : current.groups,
    deniedUsers: body.deniedUsers !== undefined ? splitList(body.deniedUsers) : current.deniedUsers,
    deniedGroups: body.deniedGroups !== undefined ? splitList(body.deniedGroups) : current.deniedGroups,
  };

  const saved = await setAccessRules(env, next);

  const summary =
    saved.mode === 'closed'
      ? `已保存：仅白名单可用（${saved.users.length} 个用户、${saved.groups.length} 个群）；黑名单 ${saved.deniedUsers.length + saved.deniedGroups.length} 项`
      : `已保存：所有人可用，黑名单 ${saved.deniedUsers.length + saved.deniedGroups.length} 项`;
  return result(true, summary, { rules: saved });
}

// ────────────────────────────────────────────────────────────────────── tasks

export async function apiListTasks(env: Env): Promise<Response> {
  const tasks = await listTasks(env);
  // The last-run time is attached here rather than stored on the task: it changes on every send, and
  // keeping it beside the definition would mean rewriting the definition constantly.
  const withRuns = await Promise.all(tasks.map(async (t) => ({ ...t, lastRunAt: await lastRunAt(env, t.id) })));
  const known = await knownGroups(env);
  return Response.json({ tasks: withRuns, limits: TASK_LIMITS, knownGroups: known });
}

export async function apiSaveTask(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const group = String(body.group ?? '').trim();
  if (!group) return result(false, '缺少群标识');

  // A cron expression is accepted as an alternative to explicit times, and expanded here so the stored
  // task always uses the same representation — one parser, one display.
  let times = splitList(body.times);
  let weekdays = splitList(body.weekdays).map(Number);
  const cron = String(body.cron ?? '').trim();
  if (cron) {
    const parsed = parseCron(cron);
    if (!parsed) {
      return result(
        false,
        '无法解析这个 cron 表达式。只支持「分 时 * * *」和「分 时 * * 星期」两种形式，例如 `30 21 * * *` 或 `0 9 * * 1,5`。',
      );
    }
    times = parsed.times;
    if (parsed.weekdays.length > 0) weekdays = parsed.weekdays;
  }

  const enabled = body.enabled === undefined ? true : isOn(body.enabled);
  const kind = String(body.kind ?? 'daily');

  const normalized = normalizeTask({
    name: String(body.name ?? '未命名任务'),
    group,
    enabled,
    kind,
    times,
    weekdays,
    everyMinutes: Number(body.everyMinutes ?? 60),
    ...(typeof body.text === 'string' && body.text.trim() ? { text: body.text } : { content: { kind: 'generated' } }),
  });

  if ('error' in normalized) return result(false, normalized.error);

  // A group the bot has never heard from cannot receive a scheduled post, and the failure would be silent.
  // This is the ADR-0015 check, applied to the one place where an unseen id is genuinely unfixable later.
  const known = await knownGroups(env);
  if (!known.some((g) => g.openid === group)) {
    return result(
      false,
      `这个群标识从未出现在任何事件里，定时发送会静默失败：${group.slice(0, 40)}。` +
        (group.includes(':') ? '它看起来像内部会话标识（形如 group:群:成员），请从下拉里选择真正的群。' : '请先在群里 @ 一次机器人。'),
    );
  }

  await saveTask(env, normalized.task);
  const when =
    normalized.task.kind === 'interval'
      ? `每 ${normalized.task.everyMinutes} 分钟`
      : `${normalized.task.kind === 'weekly' ? `每周 ${normalized.task.weekdays.join('、')} ` : '每天 '}${normalized.task.times.join('、')}`;
  return result(true, `已保存「${normalized.task.name}」：${when}`, { task: normalized.task });
}

export async function apiDeleteTask(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const id = String(body.id ?? '').trim();
  if (!id) return result(false, '缺少任务 id');
  const task = await getTask(env, id);
  if (!task) return result(false, '没有这个任务');
  await deleteTask(env, id);
  return result(true, `已删除「${task.name}」`);
}

/**
 * Run a task immediately, ignoring its schedule.
 *
 * The schedule is deliberately spread over a day, so waiting to see whether it works is not a reasonable
 * way to test one — "it never fired" and "it fired and failed" look identical from outside.
 */
export async function apiRunTask(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const id = String(body.id ?? '').trim();
  const task = await getTask(env, id);
  if (!task) return result(false, '没有这个任务');

  const { runTaskNow } = await import('../qq/tasks-runner');
  const outcome = await runTaskNow(env, task);
  // Logged like a scheduled run, so a manual test is visible in the same place as the real thing.
  const { writeCallLog } = await import('../db/store');
  await writeCallLog(env.DB, {
    origin: 'qq',
    originRef: task.group,
    model: '',
    latencyMs: outcome.latencyMs,
    status: outcome.ok ? 200 : 502,
    error: outcome.ok ? null : outcome.detail.slice(0, 200),
    requestBody: { task: true, manual: true, id: task.id, name: task.name },
    responseBody: { detail: outcome.detail, text: outcome.text?.slice(0, 500) },
  });
  return result(outcome.ok, outcome.detail);
}

/**
 * Convert legacy interjection configs into tasks.
 *
 * EXPOSED AS A BUTTON RATHER THAN ONLY RUNNING AUTOMATICALLY. The automatic migration happens on the next
 * incoming event, which may be minutes or days away — so an operator who upgrades during a quiet period
 * would see an empty task list and have no way to tell whether the migration exists at all. Running it on
 * demand makes it observable, and it is idempotent so doing so is harmless.
 */
export async function apiMigrateTasks(env: Env): Promise<Response> {
  const { migrateInterjections } = await import('../qq/tasks');
  const outcome = await migrateInterjections(env);
  if (outcome.migrated === 0) {
    return result(
      true,
      outcome.skipped > 0
        ? `已有 ${outcome.skipped} 个群迁移过，且旧配置没有变化，因此没有改动任何任务。（你在控制台里对任务的编辑不会被覆盖。）`
        : '没有需要迁移的旧配置（未启用或不存在）。',
    );
  }
  return result(
    true,
    `已迁移或更新 ${outcome.migrated} 个群的旧「发牢骚」配置。旧配置仍保留在数据库里，可随时回退。` +
      (outcome.skipped > 0 ? `另有 ${outcome.skipped} 个群未变化，已跳过。` : ''),
    { groups: outcome.groups },
  );
}

/** Validate a time string without saving anything, so the form can warn before submitting. */
export function apiCheckTime(raw: string): Response {
  const parsed = parseTime(raw);
  return Response.json({ ok: parsed !== null, normalized: parsed });
}

// ──────────────────────────────────────────────────────────────────── provider

/**
 * The active provider, WITHOUT the API key.
 *
 * A fingerprint and a source label are returned instead, which is what makes the key identifiable without
 * being readable. That is not decoration: an operator with two keys needs to know which one is installed,
 * and the only safe way to answer that is a hash.
 */
export async function apiGetProvider(env: Env): Promise<Response> {
  const { getProviderView } = await import('../providers/config');
  return Response.json(await getProviderView(env));
}

/**
 * Save the provider kind, the endpoint list, and optionally keys.
 *
 * THE KEYS ARE SEPARATE FROM THE ENDPOINTS, in the request as well as in storage. Three distinct intentions
 * have to be expressible, and a single field would conflate them:
 *
 *   `key:<id>` absent        leave that endpoint's key alone
 *   `key:<id>` = "sk-..."    replace it
 *   `key:<id>` = ""          remove it
 *
 * Conflating "absent" with "empty" is what makes saving the URL silently wipe a key, which is the failure this
 * shape exists to prevent.
 */
export async function apiSetProvider(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const { setProviderConfig, setApiKey, getProviderView, normalizeProvider, completionsUrl } = await import('../providers/config');

  const kind = body.kind === 'openai-compat' ? 'openai-compat' : body.kind === 'deepseek-web' ? 'deepseek-web' : undefined;
  if (kind === undefined && body.kind !== undefined) {
    return result(false, '未知的 provider 类型（只支持 deepseek-web 和 openai-compat）。');
  }

  // The endpoint list arrives as JSON from the console, because a list of objects cannot be expressed in form
  // fields without inventing a flat naming scheme that is worse to read and easier to get wrong.
  let endpointsInput: unknown;
  if (typeof body.endpoints === 'string' && body.endpoints.trim()) {
    try {
      endpointsInput = JSON.parse(body.endpoints) as unknown;
    } catch {
      return result(false, '端点列表不是合法的 JSON。请刷新页面后重试。');
    }
  } else if (Array.isArray(body.endpoints)) {
    endpointsInput = body.endpoints;
  }

  // A single-endpoint patch (baseUrl/model at the top level) still works, which keeps scripts and the older
  // form shape working — it edits the first endpoint.
  const hasFlatFields = typeof body.baseUrl === 'string' || typeof body.model === 'string';

  /**
   * AN EXPLICITLY EMPTY BASE URL IS REFUSED, not silently ignored.
   *
   * `normalizeProvider` treats an empty string as "not provided" and keeps the previous value, which is right
   * for a partial update — but it means clearing the field in the form appeared to succeed while the old URL was
   * still in force. That is the exact "it saved and nothing changed" failure this project keeps fixing, so the
   * refusal happens here where the reason can be stated.
   */
  if (kind === 'openai-compat' && hasFlatFields && body.baseUrl !== undefined && !String(body.baseUrl).trim()) {
    return result(false, '使用 OpenAI 兼容接口时必须填写 Base URL（例如 https://api.openai.com/v1）。');
  }

  const patch: Record<string, unknown> = {
    ...(kind ? { kind } : {}),
    ...(body.timeoutMs !== undefined ? { timeoutMs: Number(body.timeoutMs) } : {}),
    ...(endpointsInput !== undefined ? { endpoints: endpointsInput } : {}),
    ...(endpointsInput === undefined && hasFlatFields
      ? {
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
        }
      : {}),
  };

  let next;
  try {
    next = await setProviderConfig(env, patch);
  } catch (e) {
    return result(false, e instanceof Error ? e.message : String(e));
  }

  // Validate every endpoint BEFORE reporting success: a base URL that cannot produce a completions URL is a
  // guaranteed failure on the next message, and finding that out here costs nothing.
  if (next.kind === 'openai-compat') {
    const broken = next.endpoints.find((e) => !completionsUrl(e.baseUrl));
    if (broken) return result(false, `端点「${broken.label}」的 Base URL 无法构造请求地址。例如 https://api.openai.com/v1`);
    if (!next.endpoints.some((e) => e.enabled)) {
      return result(false, '所有端点都被禁用了 —— 这样发消息只会失败。至少启用一个。');
    }
  }

  // Keys are written AFTER the config, so a validation failure above does not leave an orphaned key.
  //
  // `key:<id>` targets one endpoint. A BARE `apiKey` IS ACCEPTED TOO, as an alias for the first enabled
  // endpoint — because that is what the previous single-endpoint API used, and dropping it silently was a real
  // defect: a script that posted `apiKey` received `ok: true` and NOTHING was written, so the caller believed a
  // key had been rotated when the old one was still in force. That is the "it saved and nothing changed" failure
  // this project keeps fixing, and the alias removes the opportunity for it.
  const keyEntries = Object.entries(body).filter(([k]) => k.startsWith('key:'));
  const applied: string[] = [];
  const unmatched: string[] = [];

  for (const [field, value] of keyEntries) {
    const id = field.slice(4);
    if (!next.endpoints.some((e) => e.id === id)) {
      // Reported rather than ignored: an id that matches nothing usually means a stale page, and a silent no-op
      // would look like a successful save.
      unmatched.push(id);
      continue;
    }
    await setApiKey(env, id, String(value ?? ''));
    applied.push(id);
  }

  if (body.apiKey !== undefined && keyEntries.length === 0) {
    const target = next.endpoints[0];
    if (target) {
      await setApiKey(env, target.id, String(body.apiKey));
      applied.push(target.id);
    }
  }

  if (unmatched.length > 0 && applied.length === 0) {
    return result(false, `没有找到端点 ${unmatched.join('、')}，Key 未保存 —— 页面可能已过期，刷新后重试。`);
  }

  const view = await getProviderView(env);
  const enabled = view.endpoints.filter((e) => e.enabled);
  const withKeys = enabled.filter((e) => e.hasKey);

  // Naming the fingerprint of every key that was WRITTEN is what makes a mismatch visible: an operator who
  // expects one key and sees a different fingerprint can tell immediately that the wrong value arrived, instead
  // of discovering it later from a provider error that blames the key without being able to say which one.
  const written =
    applied.length > 0
      ? ' 已写入 Key：' +
        applied
          .map((id) => {
            const e = view.endpoints.find((x) => x.id === id);
            return e ? `${e.label}=${e.keyFingerprint ?? '已清空'}` : id;
          })
          .join('、')
      : '';

  const detail =
    enabled.length === 0
      ? '已保存，但没有启用任何端点 —— 现在发消息会报错。'
      : withKeys.length === 0
        ? `已保存 ${enabled.length} 个端点，但都没有 API Key —— 现在发消息会报错。请填写 Key 或设置 OPENAI_API_KEY secret。${written}`
        : `已保存 ${enabled.length} 个端点，其中 ${withKeys.length} 个有 Key。首选：${withKeys[0].label}（${withKeys[0].resolvedUrl} · ${withKeys[0].model} · Key ${withKeys[0].keyFingerprint}）` +
          (withKeys.length > 1 ? `，另有 ${withKeys.length - 1} 个备用端点会在失败时自动顶上。` : '') +
          written;

  return result(true, detail, { provider: view });
}

/**
 * Ask ONE endpoint to list its models.
 *
 * The single most useful diagnostic when a key or URL is wrong, because it separates the causes: 401 means the
 * key, 404 means the URL, and 200 with an empty list means the key is valid but scoped away from every model.
 * Guessing between those from a failed completion is what makes provider setup frustrating.
 *
 * `endpointId` selects which one to test. Testing the FIRST configured endpoint would be useless once a
 * fallback is the one that actually answers.
 */
export async function apiProbeProvider(env: Env, request?: Request): Promise<Response> {
  const { getProviderConfig, resolveEndpoints, modelsUrl } = await import('../providers/config');

  const config = await getProviderConfig(env);
  if (config.kind !== 'openai-compat') {
    return result(true, '当前使用 DeepSeek 网页版，不需要探测模型列表。');
  }

  const body = request ? await readBody(request) : {};
  const requestedId = typeof body.endpointId === 'string' ? body.endpointId : '';

  const endpoints = await resolveEndpoints(env);
  // A DIAGNOSTIC, so it returns 200 and the operator can read the reason. "You have nothing configured" is a
  // finding about their setup, not a malformed request.
  if (endpoints.length === 0) return diagnostic(false, '没有启用的端点。请先添加一个并填写 API Key。');

  // Test ALL endpoints when none is named, so one click answers "which of my endpoints actually work" —
  // which is the question an operator has when configuring a fallback.
  const targets = requestedId ? endpoints.filter((e) => e.id === requestedId) : endpoints;
  if (targets.length === 0) return diagnostic(false, `没有找到端点 ${requestedId} —— 页面可能已过期，刷新后重试。`);

  const results: { id: string; label: string; ok: boolean; detail: string; models?: string[]; modelFound?: boolean }[] = [];

  for (const endpoint of targets) {
    const url = modelsUrl(endpoint.baseUrl);
    if (!endpoint.apiKey) {
      results.push({ id: endpoint.id, label: endpoint.label, ok: false, detail: '没有 API Key。' });
      continue;
    }

    try {
      const res = await fetch(url, {
        headers: { ...endpoint.headers, authorization: `Bearer ${endpoint.apiKey}` },
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 15_000)),
      });
      const text = await res.text();

      if (!res.ok) {
        // A 403 is NOT reliably a key problem. MEASURED: OpenAI answers a request from an unsupported region
        // with 403 `unsupported_country_region_territory`, which reads as "your key is bad" if the status code
        // alone is mapped to a cause — and the operator then regenerates a key that was never the issue.
        const regionBlocked = /unsupported_country_region_territory|not available in your (country|region)|not supported/i.test(text);
        results.push({
          id: endpoint.id,
          label: endpoint.label,
          ok: false,
          detail: regionBlocked
            ? `上游拒绝了这个地区（HTTP ${res.status}）。这不是密钥的问题 —— 该服务不支持从当前地区访问。${text.slice(0, 160)}`
            : res.status === 401 || res.status === 403
              ? `密钥被拒绝（HTTP ${res.status}）：${text.slice(0, 200)}`
              : res.status === 404
                ? `模型列表地址不存在（HTTP 404）：${url}。通常是 Base URL 少了 /v1。`
                : res.status === 429
                  ? `上游限流（HTTP 429）：${text.slice(0, 200)}`
                  : `HTTP ${res.status}：${text.slice(0, 200)}`,
        });
        continue;
      }

      let ids: string[] = [];
      try {
        const json = JSON.parse(text) as { data?: { id?: string }[] };
        ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      } catch {
        results.push({ id: endpoint.id, label: endpoint.label, ok: false, detail: `返回的不是 JSON：${text.slice(0, 160)}` });
        continue;
      }

      const found = ids.includes(endpoint.model);
      results.push({
        id: endpoint.id,
        label: endpoint.label,
        ok: true,
        detail:
          `${ids.length} 个模型` +
          (found ? `，「${endpoint.model}」在列表里 ✓` : `，但「${endpoint.model}」不在列表里 —— 发消息可能报 model_not_found`),
        models: ids.slice(0, 100),
        modelFound: found,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      results.push({ id: endpoint.id, label: endpoint.label, ok: false, detail: isTimeout ? `连接 ${url} 超时。` : `无法连接 ${url}：${message}` });
    }
  }

  const good = results.filter((r) => r.ok);
  const summary =
    results.length === 1
      ? results[0].detail
      : good.length === 0
        ? `${results.length} 个端点全部失败：` + results.map((r) => `${r.label}（${r.detail.slice(0, 60)}）`).join('；')
        : `${good.length}/${results.length} 个端点可用。` + results.map((r) => `${r.label}：${r.ok ? '✓ ' + r.detail : '✗ ' + r.detail.slice(0, 60)}`).join('；');

  return diagnostic(good.length > 0, summary, { results });
}

/**
 * Send a REAL completion to one endpoint.
 *
 * WHY THIS IS SEPARATE FROM THE MODELS PROBE, and worth the extra button: the probe proves the key is accepted
 * and the URL resolves, but NOT that the configured model will answer. MEASURED: a model name was entered as `d`,
 * and the bot's only symptom was "the model returned an empty reply" — which reads like the provider
 * misbehaving. A one-token completion names the real problem immediately (`model_not_found`), because the
 * provider says so in its own words.
 *
 * The prompt is deliberately trivial and the response is discarded: the point is whether a completion happens,
 * not what it says. It costs one request, which is the cheapest possible price for certainty.
 */
export async function apiTestProvider(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const endpointId = String(body.endpointId ?? '').trim();
  const modelOverride = String(body.model ?? '').trim();

  const { getProviderConfig, resolveEndpoints } = await import('../providers/config');
  const { completeEndpoint, ProviderError } = await import('../providers/openai-compat');

  const config = await getProviderConfig(env);
  if (config.kind !== 'openai-compat') {
    return result(true, '当前使用 DeepSeek 网页版，不需要测试 OpenAI 端点。「工作台」可以直接对话验证。');
  }

  const endpoints = await resolveEndpoints(env);
  if (endpoints.length === 0) return diagnostic(false, '没有启用的端点。请先添加一个并填写 API Key。');

  const targets = endpointId ? endpoints.filter((e) => e.id === endpointId) : endpoints;
  if (targets.length === 0) return diagnostic(false, `没有找到端点 ${endpointId} —— 页面可能已过期，刷新后重试。`);

  const outcomes: { id: string; label: string; ok: boolean; detail: string; ms: number }[] = [];

  for (const endpoint of targets) {
    const started = Date.now();
    // A per-endpoint model override lets the console test a name the operator is ABOUT to save, before saving
    // it — which is what makes "try this model" a safe action rather than an edit-and-see.
    const model = modelOverride || endpoint.model;

    try {
      const { text } = await completeEndpoint(
        endpoint,
        { model, messages: [{ role: 'user', content: '回复一个字即可。' }], max_tokens: 16 },
        fetch,
        Math.min(config.timeoutMs, 20_000),
      );
      outcomes.push({
        id: endpoint.id,
        label: endpoint.label,
        ok: true,
        detail: text.trim() ? `模型「${model}」答复了：${text.trim().slice(0, 60)}` : `模型「${model}」返回了空内容（HTTP 200）。`,
        ms: Date.now() - started,
      });
    } catch (e) {
      const message = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : String(e);
      outcomes.push({ id: endpoint.id, label: endpoint.label, ok: false, detail: message.slice(0, 400), ms: Date.now() - started });
    }
  }

  const good = outcomes.filter((o) => o.ok);
  const summary =
    outcomes.length === 1
      ? outcomes[0].detail
      : good.length === 0
        ? `${outcomes.length} 个端点都无法完成对话：` + outcomes.map((o) => `${o.label}（${o.detail.slice(0, 70)}）`).join('；')
        : `${good.length}/${outcomes.length} 个端点可以正常对话。` +
          outcomes.map((o) => `${o.label}：${o.ok ? '✓' : '✗ ' + o.detail.slice(0, 60)}`).join('；');

  return diagnostic(good.length > 0, summary, { results: outcomes });
}

/** Re-exported so this module's callers need only one import for the task type. */
export type { ScheduledTask };

/**
 * Send ONE diagnostic request with a chosen shape.
 *
 * WHY ONE AT A TIME. An earlier version tried seven shapes in a single call. That answered the question — the
 * baseline shape returned 200 while six variations were refused in 2-5ms — but it also TRIPPED the provider's own
 * rate limit, because seven requests in a burst is exactly what a burst limit exists to stop. Worse, it made its
 * own result hard to read: the first shape succeeded and every later one was refused, which looks like a
 * shape-sensitivity finding when it is really a rate-limit artefact.
 *
 * So each call issues exactly ONE request — no more than the models probe — and the caller chooses which shape.
 * The shapes remain useful because a provider's acceptance can depend on something an ordinary client cannot
 * reproduce from outside: a Worker adds `CF-Worker` and uses its own egress, and some providers gate on either.
 */
export async function apiDiagnoseProvider(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const endpointId = String(body.endpointId ?? '').trim();
  const shape = String(body.shape ?? 'baseline').trim();

  const { getProviderConfig, resolveEndpoints, completionsUrl, modelsUrl } = await import('../providers/config');
  const config = await getProviderConfig(env);
  const endpoints = await resolveEndpoints(env);
  const endpoint = endpointId ? endpoints.find((e) => e.id === endpointId) : endpoints[0];
  if (!endpoint) return diagnostic(false, '没有可用的端点。');

  const key = endpoint.apiKey;
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return base;
    }
  })();

  const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  /**
   * The available shapes, each a hypothesis about what a provider's gate keys on.
   *
   * `baseline` is exactly what the completion code sends, so a failure there is the code's own path failing —
   * which is the only shape that needs explaining.
   */
  const shapes: Record<string, { label: string; url: string; init: RequestInit }> = {
    baseline: {
      label: 'baseline（代码实际发送的形态）',
      url: modelsUrl(base),
      init: { method: 'GET', headers: { authorization: `Bearer ${key}` } },
    },
    browser: {
      label: 'browser UA + Accept-Language',
      url: modelsUrl(base),
      init: {
        method: 'GET',
        headers: {
          authorization: `Bearer ${key}`,
          'user-agent': BROWSER_UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
    },
    origin: {
      label: 'browser UA + Origin/Referer',
      url: modelsUrl(base),
      init: {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, 'user-agent': BROWSER_UA, origin, referer: `${origin}/` },
      },
    },
    'no-auth': {
      label: '不带 Key（判断 429/403 发生在鉴权之前还是之后）',
      url: modelsUrl(base),
      init: { method: 'GET', headers: {} },
    },
    root: {
      label: '站点根路径（判断是整个域名被挡，还是只有 /v1）',
      url: `${origin}/`,
      init: { method: 'GET', headers: { 'user-agent': BROWSER_UA } },
    },
    completion: {
      label: '真实 POST 补全（baseline 的 POST 版本）',
      url: completionsUrl(base),
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: endpoint.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      },
    },
  };

  const chosen = shapes[shape];
  if (!chosen) {
    return diagnostic(false, `没有这种形态：${shape}。可选：${Object.keys(shapes).join('、')}`);
  }

  const started = Date.now();
  try {
    const res = await fetch(chosen.url, { ...chosen.init });
    const text = await res.text();
    const ms = Date.now() - started;
    // A 2-5ms answer is the EDGE replying, not the origin — that distinction is what separates "the provider's
    // own rate limit" from "the provider's server said no", and it is the single most useful number here.
    const fast = ms < 50 && res.status !== 200;
    const summary =
      `形态「${chosen.label}」→ HTTP ${res.status}，${ms}ms` +
      (fast ? '（响应极快，说明是边缘直接拒绝，请求没到源站）' : '') +
      ` · ${text.slice(0, 200).replace(/\s+/g, ' ')}`;
    return diagnostic(res.status === 200, summary, {
      shape,
      status: res.status,
      ms,
      fastEdgeReject: fast,
      url: chosen.url,
      snippet: text.slice(0, 400),
    });
  } catch (e) {
    return diagnostic(false, `形态「${chosen.label}」连接失败：${e instanceof Error ? e.message : String(e)}`, {
      shape,
      status: 0,
      ms: Date.now() - started,
      url: chosen.url,
    });
  }
}
