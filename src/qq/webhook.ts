/**
 * QQ official Agent-channel webhook.
 *
 * THREE THINGS THIS MUST GET RIGHT
 *
 * 1. The ACK is not the answer. QQ requires the callback to answer op 12 promptly, and the
 *    answer must carry the same `id` it received. An LLM turn takes seconds, so the ACK goes
 *    out first and the reply is sent later through the message API — inside the passive reply
 *    window (60 min for C2C, 5 min for groups). Blocking the ACK on the model is the single
 *    most common way this integration breaks.
 *
 * 2. The signature covers the RAW body. `JSON.stringify(JSON.parse(body))` changes bytes, so
 *    the handler takes the body as text, verifies, and only then parses. See src/qq/verify.ts.
 *
 * 3. THE BOT SOLVES ITS OWN PROOF-OF-WORK, and that is only possible because of a measurement.
 *
 *    The original design assumed a challenge could not be solved inside one invocation, based
 *    on the local rate of 19.8 us/hash (about 350 ms for difficulty 144,000) against a 10 ms
 *    CPU budget. Measurements on the deployed isolate inverted that: the ceiling is roughly
 *    150,000 hashes on the free plan, i.e. about 67 ns/hash, roughly 300x faster than the
 *    development machine. A full difficulty-144,000 search therefore FITS IN ONE INVOCATION
 *    and completes in 1-2 seconds of wall time.
 *
 *    So there is no cache to warm and no external driver to run. The earlier `--warm` design
 *    was a workaround for a limit that measurement showed does not exist — and it had a real
 *    cost, because a stale cache meant the bot refused to answer while claiming to be
 *    "not ready".
 *
 *    A killed invocation is still handled: the search splits and retries, because the ceiling
 *    moves with isolate temperature (measured: 4x between cold and warm).
 */

import type { Env } from '../types';
import { buildValidationResponse, verifyEventSignature } from './verify';
import { getState, setState, writeCallLog } from '../db/store';
import { handleChatCompletion, clearManagedHistory, type ChatCompletionRequest } from '../api/openai';
import { getSession, dayKey, sessionTimeZone } from './session';
import { ensureAmbientSchema, rememberAmbient, recentAmbient, renderTranscript } from './ambient';
import { dueInterjection, getInterjectionConfig, markSent } from './interject';
import { sendMessage, buildSendBody, extractQuoteRef, qqHost } from './outbound';
import { handleCommand, rememberNickname } from './commands';
import { parseModes, directiveOnlyReply, modeFooter } from '../modes';
import { getAccessRules, checkAccess } from './access';
import { resolveSettings, personaPrefix } from '../settings';
import { dueTask, markTaskRun, migrateInterjections } from './tasks';

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/**
 * QQ's message API host.
 *
 * A QQ bot MUST be tested in the sandbox before it can go live, and the sandbox is a separate
 * API host: messages sent to the production host while a bot is still in sandbox mode are
 * rejected, and vice versa. Hardcoding the production host would make every sandbox test fail
 * with an opaque error, so this is configuration.
 *
 * Set QQ_SANDBOX=true in wrangler.toml [vars] while testing, and remove it to go live.
 */
const qqApiBase = (env: Env): string => (env.QQ_SANDBOX === 'true' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com');

/**
 * Nonces per solve loop iteration, and why this number is larger than the challenge.
 *
 * Measured: the free-plan CPU ceiling is about 150,000 hashes, and a full difficulty-144,000
 * search needs 144,000 of them. The whole challenge therefore fits inside ONE invocation.
 *
 * This is set above the difficulty on purpose. `solveRange` allocates a scratch buffer sized
 * to the range it is given, so splitting a search means allocating MORE in total than doing it
 * once — the opposite of the usual reason to chunk. The loop below exists only so a future
 * challenge with a larger difficulty still works; for today's 144,000 the first iteration
 * finishes the job.
 *
 * The earlier design assumed the opposite (that a solve needed ~100 invocations) and built a
 * warm-cache requirement around it. That was a workaround for a limit that measurement showed
 * does not exist, and it made the bot refuse to answer while the work was actually affordable.
 */
export const SOLVE_CHUNK = 200_000;

export interface QQEvent {
  id?: string;
  op: number;
  t?: string;
  d?: Record<string, unknown>;
}

export interface QQEnvelope {
  op: number;
  d?: { plain_token?: string; event_ts?: string };
}

export interface ReplyTarget {
  /** `/v2/users/{openid}/messages` or `/v2/groups/{group_openid}/messages`. */
  path: string;
  /** Groups take `msg_id` for passive replies; C2C takes `msg_id` too. */
  msgId?: string;
  /** `msg_seq` disambiguates multiple replies to one message. */
  msgSeq: number;
  /**
   * Reference index of the message being quoted, from the event's `message_scene.ext`.
   *
   * Set from the event rather than chosen, and optional because not every event carries one. Kept on
   * this type so a reply target and an outbound send target are the same shape — they were separate
   * and the difference had to be reconciled at every call site.
   */
  quoteRef?: string | null;
}

/**
 * The identifier of whoever sent an event, from the field QQ actually populates.
 *
 * VERIFIED AGAINST the official Python SDK (tencent-connect/botpy, botpy/message.py), which
 * is authoritative where the prose docs are not:
 *
 *   C2CMessage:    data["author"]["user_openid"]
 *   GroupMessage:  data["author"]["member_openid"]  (plus data["group_openid"])
 *
 * Earlier versions read `d.user_openid`, which does not exist — so every real C2C event was
 * classified as "not replyable" and silently produced no reply. Note that `Interaction`
 * events DO carry a top-level `user_openid`, which is what made the wrong path look
 * plausible; message events nest it under `author`.
 */
export function senderOpenId(event: QQEvent): string | null {
  const d = event.d ?? {};
  const author = (d.author ?? {}) as Record<string, unknown>;

  // Group members identify by member_openid, C2C users by user_openid.
  const nested = author.user_openid ?? author.member_openid;
  if (typeof nested === 'string' && nested) return nested;

  // Tolerated fallbacks, for shapes that are not the documented one. Kept because losing a
  // reply is worse than accepting a variant field, and the value is only used as a label and
  // as the reply recipient.
  for (const candidate of [d.user_openid, d.group_member_openid, author.id]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

/** Read a non-empty string field, or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Choose where a reply to this event would go.
 *
 * Note this answers "where", NOT "should we reply". The two are separate because a full-mode group
 * event (`GROUP_MESSAGE_CREATE`) arrives for EVERY message in the group — so deciding to reply
 * from this function alone would make the bot answer every single thing anyone says. That is what
 * `shouldReply` exists to prevent.
 */
export function replyTargetFor(event: QQEvent): ReplyTarget | null {
  const d = event.d ?? {};
  const msgId = str(d.id) ?? undefined;

  if (event.t === 'C2C_MESSAGE_CREATE') {
    const openid = senderOpenId(event);
    if (!openid) return null;
    return { path: `/v2/users/${openid}/messages`, msgId, msgSeq: 1 };
  }

  if (event.t === 'GROUP_AT_MESSAGE_CREATE' || event.t === 'GROUP_MESSAGE_CREATE') {
    const group = str(d.group_openid);
    if (!group) return null;
    return { path: `/v2/groups/${group}/messages`, msgId, msgSeq: 1 };
  }

  return null;
}

/**
 * Whether an event should get an immediate reply.
 *
 * A DIRECT MESSAGE OR AN @ MENTION IS ADDRESSED TO THE BOT and deserves an answer. A plain group
 * message is not: it is one person talking to other people. Replying to those would make the bot
 * interrupt every conversation in the group, which is both obnoxious and a fast route to being
 * muted.
 *
 * Full-mode group messages are still RECORDED (the "read the room" feature needs them, and it is
 * what a random-interjection feature would draw on) — they are simply not answered on arrival.
 */
export function shouldReply(event: QQEvent): boolean {
  return event.t === 'C2C_MESSAGE_CREATE' || event.t === 'GROUP_AT_MESSAGE_CREATE';
}

/** The text a user sent, if the event carries any. */
export function extractContent(event: QQEvent): string | null {
  const content = event.d?.content;
  return typeof content === 'string' && content.trim() ? content.trim() : null;
}

/**
 * Get a QQ access token, reusing the cached one until shortly before it expires.
 *
 * The token lasts ~7200 s; refreshing on every event would burn the endpoint's rate limit
 * for no benefit.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const cached = await getState(env.DB, 'qq_access_token');
  const expiresAt = Number((await getState(env.DB, 'qq_access_token_expires_at')) ?? 0);
  // 60 s of slack so a token cannot expire mid-flight.
  if (cached && expiresAt > Date.now() + 60_000) return cached;

  const res = await fetch(QQ_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: env.QQ_APP_ID, clientSecret: env.QQ_APP_SECRET }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QQ token request failed ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { access_token?: string; expires_in?: string | number };
  if (!json.access_token) throw new Error(`QQ token response had no access_token: ${text.slice(0, 300)}`);

  const ttlMs = Number(json.expires_in ?? 7200) * 1000;
  await setState(env.DB, 'qq_access_token', json.access_token);
  await setState(env.DB, 'qq_access_token_expires_at', String(Date.now() + ttlMs));
  return json.access_token;
}

/** Send a message into the channel a target describes. */
export async function sendQQMessage(
  env: Env,
  target: ReplyTarget,
  content: string,
  opts: { passive?: boolean } = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const token = await getAccessToken(env);
  const body: Record<string, unknown> = { content, msg_type: 0, msg_seq: target.msgSeq };
  // A passive reply references the triggering message and does not consume proactive quota.
  if (opts.passive !== false && target.msgId) body.msg_id = target.msgId;

  const res = await fetch(`${qqApiBase(env)}${target.path}`, {
    method: 'POST',
    headers: {
      authorization: `QQBot ${token}`,
      'content-type': 'application/json',
      'x-union-appid': env.QQ_APP_ID,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

/**
 * Extract QQ's own error code and message from a send response, for the audit log.
 *
 * QQ returns `{"message":"请求的资源不存在(用户/群已注销)","code":11255,"err_code":40011028}`.
 * Without these, a delivery failure is recorded as a bare "HTTP 400", which is compatible with
 * a closed reply window, an unknown recipient, and an exhausted quota — three problems with
 * three different fixes.
 */
export function qqErrorCode(body: string): string {
  try {
    const json = JSON.parse(body) as { code?: number; message?: string };
    const code = json.code ?? '?';
    const msg = (json.message ?? '').slice(0, 60);
    return msg ? `${code}: ${msg}` : String(code);
  } catch {
    return body.slice(0, 60) || 'no body';
  }
}

/**
 * Query the bot's own identity from QQ, using the host this deployment actually talks to.
 *
 * Shared by the /qq/status route and the admin page so the two can never disagree about which
 * environment is live — a mismatch there would send someone debugging the wrong host.
 */
export async function qqBotInfo(env: Env): Promise<{
  apiHost: string;
  sandbox: boolean;
  identity: { status: number; body: unknown } | null;
  shareUrl: string | null;
  error: string | null;
}> {
  const sandbox = env.QQ_SANDBOX === 'true';
  const apiHost = qqApiBase(env);

  try {
    const token = await getAccessToken(env);
    const res = await fetch(`${apiHost}/users/@me`, { headers: { authorization: `QQBot ${token}` } });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
    // `share_url` is the actionable part: it is the link that opens the bot's profile card,
    // which is where a user adds the bot in the QQ client.
    const shareUrl =
      typeof body === 'object' && body !== null && 'share_url' in body
        ? String((body as { share_url?: unknown }).share_url ?? '') || null
        : null;
    return { apiHost, sandbox, identity: { status: res.status, body }, shareUrl, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { apiHost, sandbox, identity: null, shareUrl: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Handle a control command, returning true when the message was one.
 *
 * These exist because the daily reset is otherwise invisible and uncontrollable: a user who wants to
 * change the subject mid-day would have to wait for midnight. They are handled here rather than by
 * the model so a command is never interpreted as a prompt — and `/help` matters as much as `/reset`,
 * because a command nobody knows about is indistinguishable from one that does not exist.
 */
async function handleControlCommand(
  env: Env,
  target: ReplyTarget,
  sessionKey: string,
  originRef: string,
  content: string,
  context: 'c2c' | 'group',
): Promise<boolean> {
  const tz = sessionTimeZone(env);
  const day = dayKey(Date.now(), tz);
  const existing = await getSession(env, sessionKey);
  const continued = Boolean(existing && (existing.pinned || existing.day === day));

  const result = await handleCommand(env, content, context, { day, timeZone: tz, continued });
  if (!result.handled) return false;

  // `/reset` clears the stored CONVERSATION, which is the only thing that constitutes context now: there is no
  // upstream thread id to drop, so forgetting the messages is exactly what "start a new conversation" means.
  if (result.action === 'reset') await clearManagedHistory(env, sessionKey);

  // Commands are Markdown on purpose: `/help` is a list, and a list is what Markdown is for.
  const token = await getAccessToken(env);
  const sent = await sendMessage(env, token, target, result.reply, { markdown: true, quote: true });

  await writeCallLog(env.DB, {
    origin: 'qq',
    originRef,
    model: '',
    latencyMs: 0,
    status: sent.ok ? 200 : 502,
    error: sent.ok ? null : `command reply not delivered: HTTP ${sent.status}`,
    requestBody: { command: content.trim(), action: result.action },
    responseBody: { action: result.action, sent },
  });
  return true;
}

/**
 * Ask both QQ API hosts what they know about a group, to resolve a 11292.
 *
 * WHY THIS EXISTS: "沙箱环境不能访问此资源" (11292) says the resource is unknown to SANDBOX, but it
 * does not say the resource belongs to production — it could equally mean the group was never
 * registered as a sandbox group. The two need opposite fixes (switch host vs. fix console
 * configuration), and the error text is identical. Asking each host directly is the only way to
 * tell them apart.
 *
 * Read-only by default (a group-info lookup). Pass `send: true` to additionally attempt a
 * proactive message on both hosts, which is the only way to know whether sending actually
 * works — and which will post a real message if it does.
 */
export async function probeGroupAccess(
  env: Env,
  groupOpenid: string,
  opts: { send?: boolean; text?: string } = {},
): Promise<{ groupOpenid: string; results: { host: string; label: string; check: string; status: number; body: string }[] }> {
  const token = await getAccessToken(env);
  const hosts = [
    { host: 'https://sandbox.api.sgroup.qq.com', label: 'sandbox' },
    { host: 'https://api.sgroup.qq.com', label: 'production' },
  ];

  const results: { host: string; label: string; check: string; status: number; body: string }[] = [];

  const record = async (host: string, label: string, check: string, path: string, init: RequestInit = {}) => {
    try {
      const res = await fetch(`${host}${path}`, {
        ...init,
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
          'x-union-appid': env.QQ_APP_ID,
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      results.push({ host: label, label, check, status: res.status, body: text.slice(0, 400) });
    } catch (e) {
      results.push({ host: label, label, check, status: 0, body: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const { host, label } of hosts) {
    await record(host, label, 'group-info', `/v2/groups/${groupOpenid}/info`);
  }
  if (opts.send) {
    for (const { host, label } of hosts) {
      await record(host, label, 'proactive-send', `/v2/groups/${groupOpenid}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: opts.text ?? '（连通性测试消息）', msg_type: 0, msg_seq: 99 }),
      });
    }
  }

  return { groupOpenid, results };
}

/**
 * Check whether the bot may act in production at all.
 *
 * Distinct from the group probe: this asks the PRODUCTION host who the bot is and what the
 * gateway says. A bot that has never been published is typically refused for production sends
 * even when the group is a production group — so switching `QQ_SANDBOX` off without checking
 * would trade one opaque error for another.
 */
export async function probeProductionAccess(env: Env): Promise<{
  tokenOk: boolean;
  results: { check: string; status: number; body: string }[];
}> {
  const out: { check: string; status: number; body: string }[] = [];
  let token = '';
  try {
    token = await getAccessToken(env);
  } catch (e) {
    return { tokenOk: false, results: [{ check: 'access-token', status: 0, body: e instanceof Error ? e.message : String(e) }] };
  }

  const hit = async (check: string, path: string) => {
    try {
      const res = await fetch(`https://api.sgroup.qq.com${path}`, {
        headers: { authorization: `QQBot ${token}`, 'x-union-appid': env.QQ_APP_ID },
      });
      out.push({ check, status: res.status, body: (await res.text()).slice(0, 300) });
    } catch (e) {
      out.push({ check, status: 0, body: e instanceof Error ? e.message : String(e) });
    }
  };

  // /users/@me proves the credential works against production at all.
  await hit('production /users/@me', '/users/@me');
  // The gateway response carries the session_start_limit, which is refused for unpublished bots.
  await hit('production /gateway/bot', '/gateway/bot');

  return { tokenOk: true, results: out };
}

/**
 * QQ error codes that mean "this resource exists, but not on the host you called".
 *
 * 11292 is the one observed: sending a production group's message to the sandbox host. Without
 * special handling it looks like a permanent failure, and the reply is lost even though the
 * model already answered.
 *
 * Exported so a test can pin the set: widening it is a behavioural change worth noticing, since
 * each entry adds an outbound request to every failed send.
 */
export const WRONG_ENVIRONMENT_CODES = new Set([11292]);

/** Extract QQ's numeric error code, or null. */
export function qqErrorCodeValue(body: string): number | null {
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

/** Send on the opposite host from the configured one, to recover from a wrong-environment send. */
async function sendQQMessageOnOtherHost(
  env: Env,
  target: ReplyTarget,
  content: string,
  opts: { passive?: boolean } = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const token = await getAccessToken(env);
  const body: Record<string, unknown> = { content, msg_type: 0, msg_seq: target.msgSeq };
  if (opts.passive !== false && target.msgId) body.msg_id = target.msgId;

  const other = qqApiBase(env) === 'https://api.sgroup.qq.com' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
  const res = await fetch(`${other}${target.path}`, {
    method: 'POST',
    headers: {
      authorization: `QQBot ${token}`,
      'content-type': 'application/json',
      'x-union-appid': env.QQ_APP_ID,
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 500) };
}

/**
 * Send a reply, recovering from a wrong-environment refusal.
 *
 * A 11292 means the configured host cannot reach the resource, which in practice means the
 * `QQ_SANDBOX` setting does not match the group or user being answered. Rather than losing an
 * answer the model already produced, the send is retried once against the other host.
 *
 * This is a safety net, not the intended path: `GET /qq/probe-group` is how to find and fix the
 * setting. The retry exists because the alternative is a user receiving nothing.
 */
async function sendQQMessageResilient(
  env: Env,
  target: ReplyTarget,
  content: string,
): Promise<{ ok: boolean; status: number; body: string; retriedOnOtherHost?: boolean }> {
  const first = await sendQQMessage(env, target, content);
  if (first.ok) return first;

  const code = qqErrorCodeValue(first.body);
  if (code === null || !WRONG_ENVIRONMENT_CODES.has(code)) return first;

  console.error(`QQ send refused with ${code} (wrong environment); retrying on the other host`);
  const second = await sendQQMessageOnOtherHost(env, target, content);
  return { ...second, retriedOnOtherHost: true };
}

/**
 * The key a conversation is stored under, which MUST distinguish the channel.
 *
 * MEASURED PROBLEM THIS SOLVES: QQ returns the SAME string for a user's C2C `user_openid` and
 * their group `member_openid`. Verified against two live events:
 *
 *   C2C   author.user_openid    = B0780D7BE440143E5A2D23D7C7B99E72
 *   group author.member_openid  = B0780D7BE440143E5A2D23D7C7B99E72   <- identical
 *
 * Keying sessions by the sender alone therefore merged a person's group conversation and their
 * direct conversation into ONE thread. That is wrong on its own terms (group chat and private chat
 * are different contexts), and it breaks in a specific way: both turns read the same
 * `parent_message_id`, and a parent that has already been consumed yields an EMPTY reply — with
 * `completion_tokens: 1` and HTTP 200. The retry cannot recover either, because it resends the
 * same pointer. That is exactly the reported "empty reply twice, even with a fresh challenge".
 *
 * Including the channel keeps the two apart. The group id is part of the key as well, so the same
 * person talking in two different groups gets a separate thread for each — which is what a user
 * expects.
 */
export function sessionKeyFor(event: QQEvent): string | null {
  const openid = senderOpenId(event);
  if (!openid) return null;

  if (event.t === 'C2C_MESSAGE_CREATE') return `c2c:${openid}`;

  if (event.t === 'GROUP_AT_MESSAGE_CREATE' || event.t === 'GROUP_MESSAGE_CREATE') {
    const group = str(event.d?.group_openid);
    if (!group) return null;
    return `group:${group}:${openid}`;
  }

  return null;
}

/**
 * Send a reply, recovering from a wrong-environment refusal.
 *
 * A 11292 means the configured host cannot reach the resource, which in practice means the
 * `QQ_SANDBOX` setting does not match the group or user being answered. Rather than losing an answer
 * the model already produced, the send is retried once against the other host.
 *
 * This is a safety net, not the intended path: `GET /qq/probe-group` is how to find and fix the
 * setting. The retry exists because the alternative is a user receiving nothing.
 */
async function sendWithEnvironmentRecovery(
  env: Env,
  token: string,
  target: ReplyTarget,
  content: string,
  opts: { quote?: boolean } = {},
): Promise<{ ok: boolean; status: number; body: string; retriedOnOtherHost?: boolean }> {
  const first = await sendMessage(env, token, target, content, opts);
  if (first.ok) return first;

  const code = qqErrorCodeValue(first.body);
  if (code === null || !WRONG_ENVIRONMENT_CODES.has(code)) return first;

  console.error(`QQ send refused with ${code} (wrong environment); retrying on the other host`);
  const other = qqHost(env) === 'https://api.sgroup.qq.com' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
  const payload = buildSendBody(content, target, opts);
  const res = await fetch(`${other}${target.path}`, {
    method: 'POST',
    headers: {
      authorization: `QQBot ${token}`,
      'content-type': 'application/json',
      'x-union-appid': env.QQ_APP_ID,
    },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 500), retriedOnOtherHost: true };
}

/**
 * Answer an LLM turn and send it back.
 *
 * Runs inside `waitUntil`, so it must never throw: an unhandled rejection there is invisible
 * to the caller and the user simply never hears back.
 *
 * The logging lives in `finally` on purpose. An earlier version only logged on the happy
 * path, so a failure while sending the reply (a rejected access token, for instance) left
 * NOTHING in the audit view — the event had been received and paid for, yet there was no
 * record that it happened. Now every delivered event produces exactly one row, and a
 * failure to reply is recorded with the reason instead of disappearing.
 */
async function replyWithModel(env: Env, event: QQEvent, target: ReplyTarget, content: string): Promise<void> {
  const started = Date.now();
  const originRef = senderOpenId(event) ?? 'unknown';
  // The conversation is keyed per channel, not per person — see sessionKeyFor.
  const sessionKey = sessionKeyFor(event) ?? originRef;
  const context: 'c2c' | 'group' = event.t === 'C2C_MESSAGE_CREATE' ? 'c2c' : 'group';
  let status = 500;
  let error: string | null = null;
  let responseBody: unknown = null;

  // Remember who this is, so a transcript can name them. The group is the scope: the same person
  // can be called different things in different groups.
  const author = (event.d?.author ?? {}) as Record<string, unknown>;
  const groupId = str(event.d?.group_openid) ?? null;
  const scope = groupId ?? 'c2c';
  void rememberNickname(env, scope, originRef, str(author.username), str(author.member_role));

  // ACCESS CONTROL runs BEFORE the command handler and before the model. A blocked sender must not be able
  // to read `/help`, send `/reset`, or learn anything from the reply — so the refusal is silent from the
  // user's side and recorded on the operator's side. Saying "you are blocked" tells them what to change.
  const access = await getAccessRules(env);
  const decisionAccess = checkAccess(access, { user: originRef, group: groupId });
  if (!decisionAccess.allowed) {
    await writeCallLog(env.DB, {
      origin: 'qq',
      originRef,
      model: '',
      latencyMs: 0,
      status: 403,
      error: `access denied: ${decisionAccess.reason}`,
      requestBody: { t: event.t, user: originRef, group: groupId, content: content.slice(0, 200) },
      responseBody: { action: 'ignored', reason: decisionAccess.reason },
    });
    return;
  }

  // Per-group settings, merged over the global defaults (ADR-0019).
  const { settings } = await resolveSettings(env, groupId);

  try {
    // A control command is never sent to the model.
    if (await handleControlCommand(env, target, sessionKey, originRef, content, context)) {
      status = 200;
      responseBody = { handled: 'command', sessionKey };
      return;
    }

    // A conversation is keyed per channel, not per person — see sessionKeyFor.

    // Modes come from a leading directive, because a chat client has no request fields to set — and fall
    // back to the scope's configured defaults, so a group can have reasoning on without each message
    // carrying a directive.
    const modes = parseModes(content, { thinking: settings.modes.thinking, search: settings.modes.search });
    if (modes.onlyDirectives) {
      // Nothing to answer, so confirm the mode instead of sending an empty prompt upstream — which
      // would produce a generic reply to nothing.
      const token = await getAccessToken(env);
      const sent = await sendMessage(env, token, target, directiveOnlyReply(modes), { quote: true });
      status = sent.ok ? 200 : 502;
      responseBody = { directives: modes.directives, thinking: modes.thinking, search: modes.search, send: sent };
      return;
    }

    /**
     * The conversation is keyed per channel, and the WORKER owns its history.
     *
     * `session_key` makes `handleChatCompletion` resend the stored messages with this request and append the
     * reply afterwards. That is the only form continuity takes for a stateless endpoint — there is no thread id
     * upstream to carry, so nothing but the resent history tells the model what was already said.
     */
    const storedSession = await getSession(env, sessionKey);

    const request: ChatCompletionRequest = {
      model: settings.model,
      // The persona is prepended rather than merged into the message: the model treats a system-ish
      // preamble as instructions and the user's text as the request, which is the intended split.
      messages: [{ role: 'user', content: personaPrefix(settings.persona) + modes.prompt }],
      thinking: modes.thinking,
      search: modes.search,
      session_key: sessionKey,
      pinned: storedSession?.pinned === true,
    };

    // ONE ATTEMPT. There is no degradation ladder because there is nothing for it to recover: the ladder
    // exists to escape a poisoned DeepSeek thread and a consumed challenge, and neither exists here. Running it
    // would send up to three billed requests per message, which was measured to make a rate limit worse.
    status = 200;
    let reply = '';
    let failure: string | null = null;
    let endpoint: string | null = null;

    try {
      const outcome = await handleChatCompletion(request, { env, origin: 'qq', originRef, skipLog: true });
      const json = (await outcome.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
        endpoint?: string;
      };
      reply = json.choices?.[0]?.message?.content?.trim() ?? '';
      endpoint = json.endpoint ?? null;
      if (!outcome.ok) failure = json.error?.message ?? `HTTP ${outcome.status}`;
      responseBody = { reply, endpoint, pinned: request.pinned === true };
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      responseBody = { reply: '', error: failure };
    }

    if (!reply) {
      error = failure;
      // SAY WHAT ACTUALLY WENT WRONG. A user told "the model returned an empty reply" after their API answered
      // 429 has been given a false lead, so the upstream error is passed through (truncated) when there is one.
      const upstream = (failure ?? '').trim();
      const notice = upstream
        ? `出错了：你的 API 返回错误 —— ${upstream.slice(0, 300)}`
        : '出错了：你的 API 返回了空内容（HTTP 200 但没有文字）。检查模型名是否正确，或换一个模型试试。';
      const sent = await sendQQMessage(env, target, notice);
      responseBody = { ...(responseBody as object), send: sent };
      return;
    }

    error = null;
    // The modes are invisible in the answer itself — a reasoning answer just looks like a good answer
    // — so a footer confirms which ones were in force. Without it a user who typed `/think` has no
    // way to tell whether it did anything.
    const footer = modeFooter({ thinking: modes.thinking, search: modes.search });
    const outgoing = (reply + footer).slice(0, 4000);

    // Markdown and quoting are decided per message: the sender picks the format, and the reference
    // was extracted from the event. A model answer that contains a list or code renders far better
    // as Markdown, and `sendMessage` falls back to plain text if QQ rejects it.
    const token = await getAccessToken(env);
    const sent = await sendWithEnvironmentRecovery(env, token, target, outgoing, {
      quote: true,
    });
    if (sent.ok) {
      responseBody = { ...(responseBody as object), modes: { thinking: modes.thinking, search: modes.search }, send: sent };
      return;
    }

    // The passive window may have closed, or the quota is exhausted. Retrying without
    // msg_id makes it a proactive message, which has its own quota — worth one attempt
    // because a delivered answer beats a lost one.
    const fallback = await sendMessage(env, token, target, outgoing, {
      passive: false,
      quote: false,
    });
    responseBody = { ...(responseBody as object), send: sent, fallback };
    if (!fallback.ok) {
      // Keep QQ's own message: it is the only thing that distinguishes a closed reply window
      // from an unknown recipient, and those need different fixes.
      error =
        `reply not delivered: passive HTTP ${sent.status} (${qqErrorCode(sent.body)}), ` +
        `proactive HTTP ${fallback.status} (${qqErrorCode(fallback.body)})`;
      status = 502;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error('replyWithModel failed', e);
    try {
      const notice = await sendQQMessage(env, target, `内部错误：${error.slice(0, 300)}`);
      responseBody = { notice: 'internal error', send: notice };
    } catch (sendErr) {
      // Nothing further we can do; the log entry below is the only record.
      responseBody = { notice: 'internal error and the failure notice could not be sent', sendErr: String(sendErr) };
    }
  } finally {
    await writeCallLog(env.DB, {
      origin: 'qq',
      originRef,
      model: '',
      latencyMs: Date.now() - started,
      status,
      error,
      requestBody: event,
      // A delivered answer is the whole payload; a failure keeps whatever we learned.
      responseBody,
    });
  }
}

export interface WebhookDeps {
  env: Env;
  /** Exact bytes received, needed for signature verification. */
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  /** Where background work goes. In a Worker this is `ctx.waitUntil`. */
  waitUntil: (p: Promise<unknown>) => void;
  /** Presentation-time hooks, injected so the reply path can be tested without HTTP. */
  now?: () => number;
}

export interface WebhookResult {
  status: number;
  body: unknown;
}

/**
 * Handle one webhook delivery.
 *
 * Returns the ACK body; any model work is scheduled through `waitUntil`.
 */
export async function handleQQWebhook(deps: WebhookDeps): Promise<WebhookResult> {
  const { env, rawBody, signature, timestamp } = deps;

  let event: QQEvent;
  try {
    event = JSON.parse(rawBody) as QQEvent;
  } catch {
    return { status: 400, body: { error: 'body is not JSON' } };
  }

  // op 13 is the callback-URL validation handshake. It is NOT signed by QQ — we sign the
  // reply — so it must be answered before signature checks, or validation can never pass.
  if (event.op === 13) {
    const d = (event as unknown as QQEnvelope).d ?? {};
    if (!d.plain_token || !d.event_ts) return { status: 400, body: { error: 'op 13 requires plain_token and event_ts' } };
    if (!env.QQ_APP_SECRET) return { status: 500, body: { error: 'QQ_APP_SECRET is not configured' } };
    try {
      return { status: 200, body: await buildValidationResponse(env.QQ_APP_SECRET, d.plain_token, d.event_ts) };
    } catch (e) {
      return { status: 500, body: { error: `cannot build validation response: ${(e as Error).message}` } };
    }
  }

  // Everything else must be signed.
  if (!env.QQ_APP_SECRET) return { status: 500, body: { error: 'QQ_APP_SECRET is not configured' } };
  if (!signature || !timestamp) return { status: 401, body: { error: 'missing signature headers' } };

  const valid = await verifyEventSignature(env.QQ_APP_SECRET, signature, timestamp, rawBody);
  if (!valid) return { status: 401, body: { error: 'signature verification failed' } };

  const target = replyTargetFor(event);
  const content = extractContent(event);

  // Anchor the reply to the message it answers. QQ carries the reference index in the event
  // (`message_scene.ext` → `msg_idx`), verified on a live event. Without it a long conversation is a
  // wall of unanchored replies; with it each answer visibly quotes its question.
  if (target) target.quoteRef = extractQuoteRef(event);

  // A full-mode group message is one person talking to other people, so it is NOT answered on
  // arrival. It is still recorded, because that is what makes it possible to "read the room" later
  // — and because replying to every message in a group is the fastest way to get the bot muted.
  if (event.t === 'GROUP_MESSAGE_CREATE') {
    try {
      deps.waitUntil(rememberAmbientMessage(env, event));
    } catch (e) {
      console.error('failed to schedule ambient-message recording', e);
    }
    return { status: 200, body: { op: 12, d: { id: event.id ?? '' } } };
  }

  // Any event is an opportunity to check whether a scheduled task is due.
  //
  // This is how the schedule runs WITHOUT a Cron Trigger: a free-plan cron invocation gets the same
  // 10 ms CPU allowance as a request, while one task needs a proof-of-work solve plus a model call
  // (ADR-0007). So the check rides along on events that are already arriving, and the `waitUntil` below
  // is what gives it room to finish.
  //
  // CHECKED ON EVERY EVENT, NOT JUST GROUP ONES. A task targets a specific group, but the scheduler
  // considers all tasks — so a slow morning in group B still lets group A's 09:00 message fire, because
  // any arriving event is enough to trigger the scan. Gating this on the event's own group would mean a
  // quiet group never runs its schedule.
  try {
    deps.waitUntil(runScheduledTasks(env, sessionTimeZone(env)));
  } catch (e) {
    console.error('failed to schedule the task check', e);
  }

  // ACK first. The reply travels through the message API afterwards.
  if (target && content && shouldReply(event)) {
    try {
      deps.waitUntil(replyWithModel(env, event, target, content));
    } catch (e) {
      // If scheduling itself throws, the reply promise is created but never awaited, so the
      // work silently never happens and the user hears nothing. Record it loudly rather than
      // losing the event without a trace.
      console.error('qq waitUntil scheduling failed; the reply will not be sent', e);
    }
  }

  return { status: 200, body: { op: 12, d: { id: event.id ?? '' } } };
}

/**
 * Check whether an interjection is due, and if so, say something.
 *
 * Runs from `waitUntil` on an ordinary request, because a Cron Trigger cannot afford the work
 * (see the note in the event handler).
 *
 * WHAT IT SAYS is either a configured line or a comment on the room, and the difference matters:
 * a fixed line is a broadcast, while reading the room is a contribution. The transcript is what
 * makes the second possible, and it is also why the bot must never reply to those messages
 * directly — overheard messages are context, not requests.
 *
 * Never throws: it is scheduled, so an exception would vanish and the bot would simply never
 * speak, with no record of why.
 */
/**
 * Send any scheduled task that is due.
 *
 * THIS REPLACES THE OLD "发牢骚" PATH. That feature could express exactly one shape — N per day, random or
 * one fixed time, fixed text or generated text. `src/qq/tasks.ts` expresses all of those plus weekly and
 * interval tasks with several slots, so the old shape is a subset rather than a second system. Legacy
 * `interject_config:*` rows are migrated into tasks the first time this runs, so an upgrade does not
 * silently stop a message someone configured.
 *
 * ONE TASK PER INVOCATION, and the claim is only finalised on SUCCESS. Sending several from one event would
 * burst the passive-reply quota; marking a FAILED send as done would silently drop the message. So the run
 * is recorded after the send, which means a failure retries on the next event.
 *
 * Never throws: it is scheduled, so an exception would vanish and the bot would simply never speak, with no
 * record of why.
 */
async function runScheduledTasks(env: Env, timeZone: string): Promise<void> {
  const started = Date.now();
  try {
    // Migrate once, cheaply: this only writes when a legacy row exists and is still enabled.
    await migrateInterjections(env).catch((e) => console.error('interjection migration failed', e));

    const { run } = await dueTask(env, started, timeZone);
    if (!run) return;

    // A group may refuse proactive posts. Checked here rather than inside `dueTask` so the reason is
    // recorded on the log row, where "why did it not fire" is actually answered.
    const { settings } = await resolveSettings(env, run.group);
    if (!settings.allowProactive) {
      await writeCallLog(env.DB, {
        origin: 'qq',
        originRef: run.group,
        model: '',
        latencyMs: Date.now() - started,
        status: 200,
        error: 'proactive posts are disabled for this group',
        requestBody: { task: true, id: run.id, name: run.name },
        responseBody: { skipped: 'allowProactive=false' },
      });
      // Recorded as run so it is not re-evaluated on every subsequent event for the rest of the day.
      await markTaskRun(env, run.id, started);
      return;
    }

    const target: ReplyTarget = { path: `/v2/groups/${run.group}/messages`, msgSeq: 1 };
    let text: string;

    if (run.content.kind === 'fixed') {
      text = run.content.text;
    } else {
      // Read the room. An empty transcript means nothing was overheard — which happens when the group owner
      // has not enabled full-message delivery — so there is nothing to comment on, and speaking anyway
      // would produce a generic, context-free remark.
      const recent = await recentAmbient(env.DB, run.group, 20);
      if (recent.length === 0) {
        await writeCallLog(env.DB, {
          origin: 'qq',
          originRef: run.group,
          model: '',
          latencyMs: Date.now() - started,
          status: 200,
          error: 'no ambient messages to comment on',
          requestBody: { task: true, id: run.id, name: run.name },
          responseBody: { skipped: 'empty transcript' },
        });
        await markTaskRun(env, run.id, started);
        return;
      }

      const transcript = renderTranscript(recent);
      const prompt =
        (settings.persona ? personaPrefix(settings.persona) : '') +
        `下面是群里的聊天记录。请以群友的身份，自然地接一句话参与讨论。\n` +
        `要求：口语化、简短（一到两句）、不要总结、不要列点、不要提到"记录"或"聊天记录"这些词。\n\n` +
        transcript;

      const res = await handleChatCompletion(
        { model: settings.model, messages: [{ role: 'user', content: prompt }] },
        { env, origin: 'qq', originRef: run.group, skipLog: true },
      );
      const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      text = payload.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) {
        console.error('scheduled task produced an empty reply');
        return;
      }
    }

    const sent = await sendMessage(env, await getAccessToken(env), target, text.slice(0, 4000), { passive: false });
    await markTaskRun(env, run.id, started);
    await writeCallLog(env.DB, {
      origin: 'qq',
      originRef: run.group,
      model: settings.model,
      latencyMs: Date.now() - started,
      status: sent.ok ? 200 : 502,
      error: sent.ok ? null : `scheduled task not delivered: HTTP ${sent.status} (${qqErrorCode(sent.body)})`,
      requestBody: { task: true, id: run.id, name: run.name, source: run.content.kind },
      responseBody: { text, send: sent },
    });
  } catch (e) {
    console.error('runScheduledTasks failed', e);
    try {
      await writeCallLog(env.DB, {
        origin: 'qq',
        originRef: 'scheduler',
        model: '',
        latencyMs: Date.now() - started,
        status: 500,
        error: e instanceof Error ? e.message : String(e),
        requestBody: { task: true },
        responseBody: null,
      });
    } catch {
      /* logging a failure must not itself throw */
    }
  }
}

/**
 * The old interjection runner, kept only as a fallback.
 *
 * It is no longer called from the event path — `runScheduledTasks` replaced it — but the function is
 * retained because `runInterjectionNow` (the console's "立刻发一条" button) still drives the same code, and
 * removing both at once would leave that button broken. New behaviour belongs in the task runner.
 */
async function maybeInterject(env: Env, groupOpenid: string): Promise<void> {
  const started = Date.now();
  try {
    const decision = await dueInterjection(env, groupOpenid);
    if (!decision.due) return;

    const config = await getInterjectionConfig(env, groupOpenid);
    const target: ReplyTarget = { path: `/v2/groups/${groupOpenid}/messages`, msgSeq: 1 };

    let text: string;
    let source: 'fixed' | 'model';

    if (config.text) {
      text = config.text;
      source = 'fixed';
    } else {
      source = 'model';
      // Read the room. An empty transcript means nothing was overheard — which happens when the
      // group owner has not enabled full-message delivery — so there is nothing to comment on and
      // speaking anyway would produce a generic, context-free remark.
      const recent = await recentAmbient(env.DB, groupOpenid, 20);
      if (recent.length === 0) {
        await writeCallLog(env.DB, {
          origin: 'qq',
          originRef: groupOpenid,
          model: '',
          latencyMs: Date.now() - started,
          status: 200,
          error: 'no ambient messages to comment on',
          requestBody: { interjection: true, group: groupOpenid, source },
          responseBody: { skipped: 'empty transcript' },
        });
        return;
      }

      const transcript = renderTranscript(recent);
      const prompt =
        `下面是群里的聊天记录。请以群友的身份，自然地接一句话参与讨论。\n` +
        `要求：口语化、简短（一到两句）、不要总结、不要列点、不要提到"记录"或"聊天记录"这些词。\n\n` +
        transcript;

      const res = await handleChatCompletion(
        { model: '', messages: [{ role: 'user', content: prompt }] },
        { env, origin: 'qq', originRef: groupOpenid, skipLog: true },
      );
      const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      text = payload.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) {
        console.error('interjection produced an empty reply');
        return;
      }
    }

    const sent = await sendQQMessageResilient(env, target, text.slice(0, 4000));
    await markSent(env, groupOpenid);
    await writeCallLog(env.DB, {
      origin: 'qq',
      originRef: groupOpenid,
      model: '',
      latencyMs: Date.now() - started,
      status: sent.ok ? 200 : 502,
      error: sent.ok ? null : `interjection not delivered: HTTP ${sent.status} (${qqErrorCode(sent.body)})`,
      requestBody: { interjection: true, group: groupOpenid, source },
      responseBody: { text, send: sent },
    });
  } catch (e) {
    console.error('maybeInterject failed', e);
    try {
      await writeCallLog(env.DB, {
        origin: 'qq',
        originRef: groupOpenid,
        model: '',
        latencyMs: Date.now() - started,
        status: 500,
        error: e instanceof Error ? e.message : String(e),
        requestBody: { interjection: true, group: groupOpenid },
        responseBody: null,
      });
    } catch {
      /* the log is best-effort; never let it mask the original failure */
    }
  }
}

/**
 * Record an overheard group message.
 *
 * The sender label prefers the group nickname, because a transcript that says who spoke is what
 * makes a conversation commentable — and an openid would be meaningless in a prompt.
 */
async function rememberAmbientMessage(env: Env, event: QQEvent): Promise<void> {
  const d = event.d ?? {};
  const group = str(d.group_openid);
  const content = extractContent(event);
  if (!group || !content) return;

  const author = (d.author ?? {}) as Record<string, unknown>;
  const openid = senderOpenId(event);
  const username = str(author.username);
  const sender = username ?? (openid ? openid.slice(0, 10) : null);

  // Remember the name too, so a transcript can attribute lines to people rather than to openids.
  if (openid) await rememberNickname(env, group, openid, username, str(author.member_role));

  await ensureAmbientSchema(env.DB);
  await rememberAmbient(env.DB, group, sender, content);
}
