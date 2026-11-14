/**
 * Outbound QQ messages: text, Markdown, and quoted replies.
 *
 * WHY THIS IS ITS OWN MODULE: sending used to be a single function that always produced
 * `{ content, msg_type: 0 }`. Three of the requested features need more than that — Markdown for
 * readable answers, a quoted reference so a reply is anchored to the message it answers, and a
 * reply target that carries the reference. Keeping the shape of a request in one place means those
 * three cannot drift apart, and it makes the payload assertable without a network.
 *
 * WHAT WAS VERIFIED RATHER THAN ASSUMED:
 *
 *   - Markdown needs no approval. The docs state that since 2026/04/23 custom Markdown is open to
 *     all bots in single and group chat (only channels still need an invitation), so `msg_type: 2`
 *     is usable without an application process.
 *
 *   - The quote index arrives in the event. A real GROUP_AT_MESSAGE_CREATE carried
 *     `message_scene.ext: ["msg_idx=REFIDX_…", "auth_token=…"]`, and `msg_idx` is exactly what
 *     `message_reference.message_id` wants.
 *
 * A NOTE ON MARKDOWN CONTENT: QQ rejects Markdown containing a newline in template parameters and
 * has its own limits, and it is stricter than the model about stray syntax. Rather than trusting
 * generated text, `toMarkdownSafe` neutralises the constructs most likely to break a send — see its
 * comments. A failed send is worse than a slightly plain one.
 */

import type { Env } from '../types';

/** Where a reply goes, and optionally what it quotes. */
export interface SendTarget {
  /** `/v2/users/{openid}/messages` or `/v2/groups/{group_openid}/messages`. */
  path: string;
  /** The triggering message id, for a passive reply. */
  msgId?: string;
  /** Disambiguates several replies to one message. */
  msgSeq: number;
  /**
   * Reference index of the message being quoted, from the event's `message_scene.ext`.
   *
   * Optional because not every event carries one, and a reply without a quote is still correct.
   */
  quoteRef?: string | null;
}

export interface SendOptions {
  /** Send as Markdown (`msg_type: 2`) instead of plain text. */
  markdown?: boolean;
  /**
   * Reference the triggering message.
   *
   * Distinct from a passive reply: `msg_id` makes the reply legal within the passive window, while
   * `message_reference` makes it VISUALLY quote the message. The first is required for delivery
   * inside the window; the second is what makes a long conversation readable.
   */
  quote?: boolean;
  /** Skip `msg_id`, producing a proactive message with its own quota. */
  passive?: boolean;
}

export interface OutboundBody {
  content?: string;
  markdown?: { content: string };
  msg_type: number;
  msg_seq: number;
  msg_id?: string;
  message_reference?: { message_id: string };
}

/**
 * Extract the quote index from an event's `message_scene.ext`.
 *
 * The field is a list of `key=value` strings, and `msg_idx` is the one that matters. Values are
 * returned verbatim: the index is opaque, contains `=` and `+` and `/`, and any normalisation
 * would corrupt it.
 */
export function extractQuoteRef(event: { d?: Record<string, unknown> }): string | null {
  const scene = (event.d?.message_scene ?? {}) as { ext?: unknown };
  const ext = Array.isArray(scene.ext) ? scene.ext : [];
  for (const entry of ext) {
    if (typeof entry !== 'string') continue;
    const idx = entry.indexOf('msg_idx=');
    if (idx === 0) return entry.slice('msg_idx='.length);
  }
  return null;
}

/**
 * Decide whether a message is worth sending as Markdown.
 *
 * A plain sentence rendered as Markdown looks the same but costs an extra failure mode, so this
 * only opts in when the text actually contains Markdown constructs the renderer supports. Sending
 * everything as Markdown would be simpler and slightly worse.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /(^|\n)\s{0,3}(#{1,3}\s|[-*+]\s|\d+\.\s|>\s)/.test(text) || // headings, lists, quotes
    /\*\*[^*\n]+\*\*/.test(text) || // bold
    /`[^`\n]+`/.test(text) || // inline code
    /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(text) || // links
    /(^|\n)```/.test(text) // fenced code
  );
}

/**
 * Neutralise the Markdown constructs most likely to make QQ reject a send.
 *
 * QQ is stricter than a browser renderer: it rejects newlines inside template parameters, has its
 * own limits, and a malformed construct fails the WHOLE message rather than degrading gracefully.
 * So the risky pieces are removed instead of trusted:
 *
 *   - images, because they require a publicly reachable URL that QQ then downloads and re-hosts;
 *     a model-generated URL is almost never reachable, and a failed transfer fails the send;
 *   - tables, which are not in the supported subset and render as noise;
 *   - horizontal rules and HTML tags, neither of which is supported.
 *
 * Code fences are KEPT — they are supported and are the most useful construct for this bot.
 */
export function toMarkdownSafe(text: string): string {
  return text
    // Images become their alt text: the URL is the part that can fail.
    .replace(/!\[([^\]]*)\]\((?:[^)\s]+)\)/g, '$1')
    // Tables are unsupported; keep the cells as plain lines so no information is lost.
    .replace(/^\s*\|.*\|\s*$/gm, (line) => line.replace(/\|/g, ' ').trim())
    .replace(/^\s*[-:]+[-|\s:]*$/gm, '')
    // Horizontal rules render as literal dashes.
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
    // HTML is not part of the subset.
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    // Collapse runs of blank lines, which the renderer handles inconsistently.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the request body for a send.
 *
 * Pure and exported so the payload can be asserted directly: every field here has a specific
 * meaning to QQ, and getting one wrong produces a rejection whose message does not name the field.
 */
export function buildSendBody(content: string, target: SendTarget, opts: SendOptions = {}): OutboundBody {
  const useMarkdown = opts.markdown === true;
  const body: OutboundBody = { msg_type: useMarkdown ? 2 : 0, msg_seq: target.msgSeq };

  if (useMarkdown) {
    // A Markdown message must carry `markdown`, and `content` must be ABSENT — sending both is an
    // error, not a preference.
    body.markdown = { content: toMarkdownSafe(content) };
  } else {
    body.content = content;
  }

  if (opts.passive !== false && target.msgId) body.msg_id = target.msgId;
  if (opts.quote && target.quoteRef) body.message_reference = { message_id: target.quoteRef };

  return body;
}

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** The QQ API host for the configured environment. */
export function qqHost(env: Env): string {
  return env.QQ_SANDBOX === 'true' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
}

/**
 * Send one message.
 *
 * Takes the access token as an argument rather than fetching it, so a caller sending several
 * messages (a long answer split into parts) does not re-authenticate each time.
 */
export async function sendMessage(
  env: Env,
  token: string,
  target: SendTarget,
  content: string,
  opts: SendOptions = {},
): Promise<{ ok: boolean; status: number; body: string; usedMarkdown: boolean }> {
  // Auto-detect Markdown only when the caller did not decide, and never for a fixed string that a
  // human typed as plain text.
  const markdown = opts.markdown ?? looksLikeMarkdown(content);
  const payload = buildSendBody(content, target, { ...opts, markdown });

  const res = await fetch(`${qqHost(env)}${target.path}`, {
    method: 'POST',
    headers: {
      authorization: `QQBot ${token}`,
      'content-type': 'application/json',
      'x-union-appid': env.QQ_APP_ID,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();

  // If Markdown was auto-detected and rejected, retry as plain text. The detection is a heuristic,
  // and a readable plain answer beats a failed send — the failure would otherwise be indistinguishable
  // from the bot being offline.
  if (!res.ok && markdown && opts.markdown === undefined) {
    const plain = buildSendBody(content, target, { ...opts, markdown: false });
    const retry = await fetch(`${qqHost(env)}${target.path}`, {
      method: 'POST',
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
        'x-union-appid': env.QQ_APP_ID,
      },
      body: JSON.stringify(plain),
    });
    const retryText = await retry.text();
    return { ok: retry.ok, status: retry.status, body: retryText.slice(0, 500), usedMarkdown: false };
  }

  return { ok: res.ok, status: res.status, body: text.slice(0, 500), usedMarkdown: markdown };
}

export { QQ_TOKEN_URL };
