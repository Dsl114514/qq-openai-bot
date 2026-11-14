/**
 * Admin mutations, as JSON.
 *
 * These used to return a rendered HTML page — the form POST re-rendered the whole view with a success
 * banner. That is replaced by the Vue console calling these endpoints and updating itself, so the
 * responses are now small JSON objects.
 *
 * The distinction that matters: these are the WRITE paths, and each one validates server-side. The
 * client is a view, never a security boundary, and every rule enforced here (a group id that must have
 * been seen, a token that must parse, a non-negative day count) is enforced because the server refuses
 * — not because the form prevents it.
 */

import type { Env } from '../types';
import { writeCallLog, purgeCallLogs } from '../db/store';
import { setSessionPinned, purgeSessions, WORKBENCH_SESSION_KEY } from '../qq/session';
import { normalizeConfig, setInterjectionConfig, clearInterjectionConfig, runInterjectionNow } from '../qq/interject';
import { sendQQMessage } from '../qq/webhook';
import { clearManagedHistory } from '../api/openai';
import { knownGroups } from './groups';

/** A JSON result. `ok: false` carries the reason the client shows. */
const result = (ok: boolean, detail: string) => Response.json({ ok, detail }, { status: ok ? 200 : 400 });

export async function handlePurge(env: Env, form: FormData): Promise<Response> {
  const days = Number(form.get('days') ?? 30);
  const origin = String(form.get('origin') ?? '') || undefined;
  if (!Number.isFinite(days) || days < 0) return result(false, '天数必须是非负数。');
  const deleted = await purgeCallLogsSafe(env, days, origin);
  return result(true, `已删除 ${deleted} 条记录${origin ? `（来源 ${origin}）` : ''}。`);
}

/** Kept separate so the import list stays readable. */
async function purgeCallLogsSafe(env: Env, days: number, origin?: string): Promise<number> {
  const { purgeCallLogs } = await import('../db/store');
  return purgeCallLogs(env.DB, Date.now() - days * 86_400_000, origin);
}

/** Delete conversation sessions inactive for N days. Separate data, separate retention. */
export async function handleSessionPurge(env: Env, form: FormData): Promise<Response> {
  const days = Number(form.get('days') ?? 7);
  if (!Number.isFinite(days) || days < 0) return result(false, '天数必须是非负数。');
  const removed = await purgeSessions(env, days === 0 ? undefined : Date.now() - days * 86_400_000);
  return result(true, days === 0 ? `已删除全部 ${removed} 个会话。` : `已删除 ${removed} 个超过 ${days} 天未活动的会话。`);
}

/**
 * Start a new conversation for one user.
 *
 * The operator's version of the user-facing `/reset`: the people who read this page are the ones asked
 * "the bot is confused, can you fix it", and telling them to type a command is a worse answer.
 */
export async function handleSessionReset(env: Env, form: FormData): Promise<Response> {
  const id = String(form.get('id') ?? '').trim();
  if (!id) return result(false, '缺少会话标识。');
  // "A new conversation" now means forgetting the stored messages, because that stored history IS the
  // context: there is no upstream thread id to drop.
  await clearManagedHistory(env, id);
  return result(true, `已为 ${id} 开新会话 —— 它的下一条消息会从空白上下文开始。`);
}

/**
 * Keep a conversation indefinitely, or let it reset daily again.
 *
 * The daily reset is right for most chat and wrong for a thread someone is deliberately building on,
 * so it is opt-out per session rather than a global setting.
 */
export async function handleSessionPin(env: Env, form: FormData): Promise<Response> {
  const id = String(form.get('id') ?? '').trim();
  const pinned = String(form.get('pinned') ?? '') === 'true';
  if (!id) return result(false, '缺少会话标识。');
  const r = await setSessionPinned(env, id, pinned);
  return result(r.ok, r.detail);
}

/** Clear the workbench's own conversation. */
export async function handleWorkbenchReset(env: Env): Promise<Response> {
  await clearManagedHistory(env, WORKBENCH_SESSION_KEY);
  return result(true, '工作台会话已重置 —— 下一条消息会开一个新会话。');
}

/**
 * Configure the scheduled interjection for one group.
 *
 * REFUSES A GROUP ID THAT HAS NEVER BEEN SEEN. This is the check that was missing: a config saved
 * against an id no event will ever carry never fires and produces no error anywhere — the failure mode
 * is indistinguishable from "the feature does not work", which is exactly how it presented. See
 * ADR-0015.
 */
export async function handleInterjectionConfig(env: Env, form: FormData): Promise<Response> {
  const group = String(form.get('group') ?? '').trim();
  if (!group) return result(false, '缺少群标识。');

  const seen = await knownGroups(env);
  if (!seen.some((g) => g.openid === group)) {
    const looksLikeSessionKey = group.includes(':');
    return result(
      false,
      `这个群标识从未出现在任何事件里，保存了也不会触发：${group.slice(0, 40)}` +
        (looksLikeSessionKey
          ? '。它看起来像内部会话标识（形如 group:群:成员），请从下拉里选择真正的群。'
          : '。请先在群里 @ 一次机器人，让它出现在下拉列表里。'),
    );
  }

  const config = normalizeConfig({
    enabled: form.get('enabled') === 'on' || form.get('enabled') === 'true',
    perDay: Number(form.get('perDay') ?? 1),
    mode: String(form.get('mode') ?? 'random') as 'random' | 'fixed',
    at: String(form.get('at') ?? ''),
    text: String(form.get('text') ?? ''),
  });
  await setInterjectionConfig(env, group, config);

  const summary = config.enabled
    ? `已保存：每天 ${config.perDay} 次，` +
      `${config.mode === 'fixed' ? `固定 ${config.at ?? '（时间无效，已忽略）'}` : '随机时间'}` +
      (config.text ? `，发送固定内容「${config.text.slice(0, 20)}」` : '，内容由模型根据群聊生成')
    : '已保存：发牢骚功能已关闭。';
  return result(true, summary);
}

/**
 * Send an interjection immediately, ignoring the schedule.
 *
 * The schedule is deliberately unpredictable, so waiting to see whether it works is not a reasonable
 * way to test it — "it never fired" and "it fired and failed" look identical from outside.
 */
export async function handleInterjectionTest(env: Env, form: FormData): Promise<Response> {
  const group = String(form.get('group') ?? '').trim();
  if (!group) return result(false, '缺少群标识。');
  const started = Date.now();
  const r = await runInterjectionNow(env, group, (text) =>
    sendQQMessage(env, { path: `/v2/groups/${group}/messages`, msgSeq: 90 }, text, { passive: false }),
  );
  // Logged like a scheduled one, so a manual test is visible in the same place as the real thing.
  await writeCallLog(env.DB, {
    origin: 'qq',
    originRef: group,
    model: '',
    latencyMs: Date.now() - started,
    status: r.ok ? 200 : 502,
    error: r.ok ? null : r.detail.slice(0, 200),
    requestBody: { interjection: true, manual: true, group },
    responseBody: { detail: r.detail },
  });
  return result(r.ok, r.detail);
}

/** Remove a group's interjection configuration and its bookkeeping. */
export async function handleInterjectionClear(env: Env, form: FormData): Promise<Response> {
  const group = String(form.get('group') ?? '').trim();
  if (!group) return result(false, '缺少群标识。');
  await clearInterjectionConfig(env, group);
  return result(true, `已清除 ${group} 的发牢骚配置。`);
}
