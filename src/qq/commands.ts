/**
 * Chat commands, and what the bot knows about the people using it.
 *
 * WHY COMMANDS NEED A DISCOVERY PATH: `/reset` already existed, but nothing told anyone it was
 * there — a command nobody knows about is indistinguishable from one that does not exist. `/help`
 * is therefore not decoration; it is the only way the other commands are usable.
 *
 * WHY NICKNAMES ARE STORED: QQ sends `author.username` on group events (verified on a real event:
 * `"username": "Chrono/VERT"`), and it is the only human-readable name available. Without it the
 * transcript fed to the model is a wall of openids, which makes "comment on what people are saying"
 * produce remarks about nobody in particular. The name is kept as a display label only.
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

/** Where a command was typed, so the help text can be right for the context. */
export type CommandContext = 'c2c' | 'group';

export interface CommandResult {
  /** The text to send back. */
  reply: string;
  /** True when the message was a command and must not reach the model. */
  handled: boolean;
  /** Commands that change state, so the caller can log what happened. */
  action?: 'reset' | 'help' | 'status' | 'ping';
}

/** Everything the bot treats as a command rather than something to answer. */
export const RESET_COMMANDS = new Set(['/reset', '/new', '/重置', '/清空', '/新会话']);
export const HELP_COMMANDS = new Set(['/help', '/?', '/帮助', '/指令']);
export const STATUS_COMMANDS = new Set(['/status', '/状态', '/info']);
export const PING_COMMANDS = new Set(['/ping', '/在吗']);

/**
 * The help text. Kept short because it is read inside a chat window.
 *
 * The mode directives are listed here for the same reason `/reset` is: a capability nobody knows
 * about is indistinguishable from one that does not exist. They are also the only way to reach
 * reasoning and search from a chat client, which has no request fields to set.
 */
export function helpText(context: CommandContext, opts: { day: string; timeZone: string; continued: boolean }): string {
  const lines = [
    '# 我能做什么',
    '',
    '**直接聊天** —— 私聊随便说，群里需要 @我。',
    '',
    '## 指令',
    '- `/reset` 开一个新会话（丢掉当前上下文）',
    '- `/status` 看看当前会话状态',
    '- `/help` 显示这份说明',
    '',
    '## 模式（加在消息最前面）',
    '- `/think 你的问题` 开启**深度思考**',
    '- `/search 你的问题` 开启**联网搜索**',
    '- `/fast 你的问题` 两个都关掉',
    '',
    '可以叠加：`/think /search 问题`。也可以只发指令，我会告诉你是开还是关。',
    '',
    `## 关于会话`,
    `现在是 ${opts.day}（${opts.timeZone}）。`,
    opts.continued
      ? '你正在**延续**今天的会话，我记得之前聊过的内容。'
      : '你**还没有**今天的会话，下一条消息会开一个新的。',
    '',
    '会话默认每天重置。管理员可以在后台把某个会话设为**长期保留**。',
  ];
  if (context === 'group') {
    lines.push('', '在群里我需要被 @ 才会收到消息 —— 这是平台规则，不是我的选择。');
  }
  return lines.join('\n');
}

/**
 * Recognise and answer a command.
 *
 * Returns `handled: false` for anything that is not a command, so the caller can fall through to the
 * model. The check is deliberately exact rather than prefix-based: a message that merely starts with
 * a slash is more likely to be a path or a date than an instruction, and swallowing it would look
 * like the bot ignoring the user.
 */
export async function handleCommand(
  env: Env,
  content: string,
  context: CommandContext,
  sessionState: { day: string; timeZone: string; continued: boolean },
): Promise<CommandResult> {
  const cmd = content.trim().toLowerCase();

  if (RESET_COMMANDS.has(cmd)) {
    return { handled: true, action: 'reset', reply: '好的，已开新会话 —— 下一条消息从空白开始。' };
  }

  if (HELP_COMMANDS.has(cmd)) {
    return { handled: true, action: 'help', reply: helpText(context, sessionState) };
  }

  if (STATUS_COMMANDS.has(cmd)) {
    return {
      handled: true,
      action: 'status',
      reply: [
        `# 会话状态`,
        `- 日期：${sessionState.day}（${sessionState.timeZone}）`,
        `- 状态：${sessionState.continued ? '延续今天的会话' : '还没有今天的会话'}`,
        `- 上下文：${sessionState.continued ? '保留' : '将在下一条消息建立'}`,
      ].join('\n'),
    };
  }

  if (PING_COMMANDS.has(cmd)) {
    return { handled: true, action: 'ping', reply: '在的。' };
  }

  return { handled: false, reply: '' };
}

// ─────────────────────────────────────────────────────────── member nicknames

/** Key namespace, so nicknames can be listed and purged like other user data. */
export const NICKNAME_PREFIX = 'qq_nick:';

const nickKey = (scope: string, openid: string): string => `${NICKNAME_PREFIX}${scope}:${openid}`;

export interface Nickname {
  name: string;
  role: string | null;
  seenAt: number;
}

/**
 * Remember what someone is called in a group.
 *
 * Scoped by group because the same person can be called something different in each one — and a
 * transcript that used one group's nickname in another would read as a stranger talking.
 *
 * Never throws: a failed write must not lose the message being answered.
 */
export async function rememberNickname(
  env: Env,
  scope: string,
  openid: string,
  name: string | null,
  role: string | null,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!name || !name.trim()) return;
  try {
    await setState(env.DB, nickKey(scope, openid), JSON.stringify({ name: name.trim(), role, seenAt: nowMs }));
  } catch (e) {
    console.error('rememberNickname failed', e);
  }
}

/** Look up what someone is called. Returns null when unknown. */
export async function getNickname(env: Env, scope: string, openid: string): Promise<Nickname | null> {
  const raw = await getState(env.DB, nickKey(scope, openid));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Nickname>;
    return typeof parsed.name === 'string' ? { name: parsed.name, role: parsed.role ?? null, seenAt: parsed.seenAt ?? 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve several openids to display names in one go.
 *
 * A transcript needs a name per line, so this avoids a round trip per message. Unknown senders fall
 * back to a short openid prefix rather than a generic word: a repeated "某人" would make it look like
 * one person said everything, which is worse than an ugly but distinct label.
 *
 * The fallback keeps BOTH ends of the id (`ABCD…WXYZ`) rather than just the start. Openids in one
 * group often share a long prefix, so a prefix-only label can collapse several different people into
 * the same string — which reintroduces exactly the confusion the fallback exists to avoid.
 */
export async function resolveNames(env: Env, scope: string, openids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(openids)].map(async (id) => {
      const nick = await getNickname(env, scope, id);
      const fallback = id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
      out.set(id, nick?.name ?? fallback);
    }),
  );
  return out;
}

/** Forget nicknames, per scope or entirely. */
export async function forgetNicknames(env: Env, scope?: string): Promise<number> {
  const pattern = scope ? `${NICKNAME_PREFIX}${scope}:%` : `${NICKNAME_PREFIX}%`;
  const res = await env.DB.prepare('DELETE FROM app_state WHERE key LIKE ?').bind(pattern).run();
  return res.meta.changes ?? 0;
}
