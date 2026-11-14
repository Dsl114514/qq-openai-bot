/**
 * Conversation history for stateless providers.
 *
 * WHY THIS EXISTS. The bot's continuity used to come from DeepSeek's web interface: a session id and a parent
 * message id told upstream what had already been said. An OpenAI-compatible endpoint has no such concept —
 * continuity means RESENDING the conversation with every request. Without that, the bot forgets each message
 * the moment it answers, and a "chat bot" that cannot remember the previous sentence is not a chat bot.
 *
 * STORAGE IS A SINGLE JSON ROW per session, capped both by message count and by total size. The cap matters:
 * a group that chats all day would otherwise grow the row without bound, and D1 rows have a practical size
 * limit that a silent failure to exceed is worse than a deliberate trim.
 *
 * The day travels with the history so a session's daily reset (see src/qq/session.ts) clears it too — a new
 * day means a new conversation, and resuming yesterday's context would contradict that.
 */

import type { Env } from '../types';
import { getState, setState } from '../db/store';

export interface HistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const PREFIX = 'history:';
/** Turns kept. Two entries per turn (user + assistant), so 40 is 20 turns of context. */
export const MAX_MESSAGES = 40;
/** Total stored characters. A hard ceiling so one very long exchange cannot dominate the row. */
const MAX_CHARS = 60_000;

const historyKey = (sessionKey: string): string => `${PREFIX}${sessionKey}`;

interface StoredHistory {
  day: string;
  messages: HistoryMessage[];
}

/** Read a session's history, or an empty one. A corrupt row is treated as empty rather than fatal. */
export async function loadHistory(env: Env, sessionKey: string): Promise<StoredHistory> {
  const stored = await getState(env.DB, historyKey(sessionKey));
  if (!stored) return { day: '', messages: [] };
  try {
    const parsed = JSON.parse(stored) as Partial<StoredHistory>;
    if (!Array.isArray(parsed.messages)) return { day: '', messages: [] };
    return {
      day: typeof parsed.day === 'string' ? parsed.day : '',
      messages: parsed.messages.filter(
        (m): m is HistoryMessage =>
          m !== null && typeof m === 'object' && typeof (m as HistoryMessage).content === 'string',
      ),
    };
  } catch {
    console.error(`history row ${sessionKey} is not valid JSON; starting empty`);
    return { day: '', messages: [] };
  }
}

/**
 * Append one exchange and trim.
 *
 * BOTH messages of the exchange are appended together, because a history with an assistant reply but no user
 * message before it is malformed, and splitting the writes across two calls invites exactly that.
 *
 * Trimming is by message count first, then by total size — so one enormous message is eventually dropped even
 * when the count is under the limit.
 */
export async function appendExchange(
  env: Env,
  sessionKey: string,
  day: string,
  user: string,
  assistant: string,
): Promise<void> {
  const history = await loadHistory(env, sessionKey);
  if (history.day !== day) history.messages = [];

  history.day = day;
  if (user.trim()) history.messages.push({ role: 'user', content: user });
  if (assistant.trim()) history.messages.push({ role: 'assistant', content: assistant });

  while (history.messages.length > MAX_MESSAGES) history.messages.shift();

  // Drop oldest pairs until the total size fits. Two at a time keeps user/assistant together, so the model
  // never sees an answer with no question.
  const size = () => history.messages.reduce((n, m) => n + m.content.length, 0);
  while (size() > MAX_CHARS && history.messages.length > 2) history.messages.splice(0, 2);

  await setState(env.DB, historyKey(sessionKey), JSON.stringify(history));
}

/** Forget a session's history — the conversation-level `/reset`. */
export async function clearHistory(env: Env, sessionKey: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_state WHERE key = ?1').bind(historyKey(sessionKey)).run();
}
