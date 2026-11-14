/**
 * Running one scheduled task.
 *
 * EXTRACTED SO THE SCHEDULER AND THE "立刻运行" BUTTON SHARE ONE CODE PATH. The interjection feature had
 * these as two implementations, and they drifted: the manual test logged nothing, so "did the test send
 * work?" could only be answered by looking at the group. A single runner means a manual run exercises
 * exactly what a scheduled run does, and therefore proves something about it.
 *
 * The caller records the result; this function does not write `task_run`, because a manual run must NOT
 * consume the day's slot — otherwise testing a task at 09:00 would prevent its 21:00 send.
 */

import type { Env } from '../types';
import type { ScheduledTask } from './tasks';
import { recentAmbient, renderTranscript } from './ambient';
import { getAccessToken, sendQQMessage } from './webhook';
import { handleChatCompletion } from '../api/openai';
import { resolveSettings, personaPrefix } from '../settings';

export interface TaskOutcome {
  ok: boolean;
  /** Human-readable result, shown in the console. */
  detail: string;
  /** What was sent, when something was. */
  text?: string;
  latencyMs: number;
}

export async function runTaskNow(env: Env, task: ScheduledTask): Promise<TaskOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const target = { path: `/v2/groups/${task.group}/messages`, msgSeq: 90 };

  try {
    const { settings } = await resolveSettings(env, task.group);

    let text: string;
    if (task.content.kind === 'fixed') {
      text = task.content.text;
      if (!text.trim()) return { ok: false, detail: '这个任务的固定内容是空的', latencyMs: elapsed() };
    } else {
      const recent = await recentAmbient(env.DB, task.group, 20);
      if (recent.length === 0) {
        return {
          ok: false,
          detail:
            '没有可以接话的群聊记录 —— 这个任务需要群主在 QQ 后台开启「接收所有消息」，否则机器人收不到群友的普通发言，只能收到 @ 它的消息。',
          latencyMs: elapsed(),
        };
      }

      const prompt =
        (settings.persona ? personaPrefix(settings.persona) : '') +
        `下面是群里的聊天记录。请以群友的身份，自然地接一句话参与讨论。\n` +
        `要求：口语化、简短（一到两句）、不要总结、不要列点、不要提到"记录"或"聊天记录"这些词。\n\n` +
        renderTranscript(recent);

      const res = await handleChatCompletion(
        { model: settings.model, messages: [{ role: 'user', content: prompt }] },
        { env, origin: 'qq', originRef: task.group, skipLog: true },
      );
      const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      text = payload.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) return { ok: false, detail: '模型返回了空内容', latencyMs: elapsed() };
    }

    const sent = await sendQQMessage(env, target, text.slice(0, 4000), { passive: false });
    if (!sent.ok) {
      return {
        ok: false,
        detail: `已生成内容但发送失败：HTTP ${sent.status} ${sent.body.slice(0, 160)}`,
        text,
        latencyMs: elapsed(),
      };
    }
    return { ok: true, detail: `已发送：「${text.slice(0, 60)}」`, text, latencyMs: elapsed() };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: elapsed() };
  }
}

/** The token helper is re-exported so this module's callers need only one import. */
export { getAccessToken };
