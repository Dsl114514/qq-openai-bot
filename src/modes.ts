/**
 * DeepSeek reasoning and web-search modes.
 *
 * WHY THIS MODULE EXISTS: the upstream client has always accepted `thinkingEnabled` and
 * `searchEnabled` (`thinking_enabled` / `search_enabled` in the completion body), but NOTHING in the
 * API surface could turn them on — they were hardcoded to `false` on every path. So a capability the
 * reverse-engineered protocol supports was unreachable, which is a gap rather than a missing feature.
 *
 * WHY THE FLAGS ARE PARSED FROM TEXT: DeepSeek's web UI enables these per conversation, not per
 * request in the API sense. Two kinds of caller need them:
 *
 *   - a chat user who types "/think 为什么…" — an explicit instruction in the message itself;
 *   - an API caller who sends a flag.
 *
 * Parsing a leading directive is how the first case works, and it has to be a PREFIX rather than a
 * search: a message that merely contains the word "think" mid-sentence is a sentence about thinking,
 * not an instruction. Stripping a matched prefix also means the model never sees the directive, which
 * would otherwise be answered as text.
 */

/** Reasoning mode: the model works through the problem before answering. */
export const THINK_PREFIXES = ['/think', '/思考', '/r1', '/深度'] as const;
/** Search mode: the model may look things up before answering. */
export const SEARCH_PREFIXES = ['/search', '/搜索', '/web'] as const;
/** Explicitly disable both, for a caller who has them on by default. */
export const FAST_PREFIXES = ['/fast', '/快', '/nothink'] as const;

export interface ModeRequest {
  /** What the user actually asked, with any directive removed. */
  prompt: string;
  /** Enable reasoning for this turn. */
  thinking: boolean;
  /** Enable web search for this turn. */
  search: boolean;
  /** Which directives were consumed, for logging and for the reply footer. */
  directives: string[];
  /** True when the message was nothing but directives. */
  onlyDirectives: boolean;
}

/**
 * Read leading directives off a message.
 *
 * Only LEADING directives are recognised, and only one of each kind. `"解释一下 /think 这个词"` is a
 * sentence about the directive; `"/think 解释一下"` is an instruction. Treating them the same would
 * make the bot silently reinterpret ordinary messages, and there would be no way to talk about the
 * feature.
 *
 * `defaults` let a caller (the API, or a per-group setting) pre-enable a mode while still allowing
 * `/fast` to turn it off for one turn.
 */
export function parseModes(
  input: string,
  defaults: { thinking?: boolean; search?: boolean } = {},
): ModeRequest {
  let thinking = defaults.thinking === true;
  let search = defaults.search === true;
  const directives: string[] = [];

  let rest = input.trim();

  // Loop rather than a single check: "/think /search …" is two directives, and a user who types both
  // means both. Bounded by the string length, so no risk of looping.
  for (let guard = 0; guard < 8; guard++) {
    const first = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!first) break;

    if ((THINK_PREFIXES as readonly string[]).includes(first)) {
      thinking = true;
      directives.push(first);
    } else if ((SEARCH_PREFIXES as readonly string[]).includes(first)) {
      search = true;
      directives.push(first);
    } else if ((FAST_PREFIXES as readonly string[]).includes(first)) {
      // `/fast` wins over both, including over a default: it is the way to opt OUT.
      thinking = false;
      search = false;
      directives.push(first);
    } else {
      break;
    }

    // Remove the consumed token, preserving the rest of the message verbatim.
    const idx = rest.indexOf(first);
    rest = rest.slice(idx + first.length).trim();
  }

  return {
    prompt: rest,
    thinking,
    search,
    directives,
    onlyDirectives: rest.length === 0 && directives.length > 0,
  };
}

/**
 * A short footer naming the modes in force.
 *
 * The modes are invisible in the answer itself — a reasoning answer looks like a good answer — so a
 * user who turned one on has no way to tell whether it took effect. The footer is that confirmation,
 * and it is deliberately terse because it appears on every affected reply.
 */
export function modeFooter(modes: { thinking: boolean; search: boolean }): string {
  const parts: string[] = [];
  if (modes.thinking) parts.push('深度思考');
  if (modes.search) parts.push('联网搜索');
  return parts.length ? `\n\n_（${parts.join(' · ')}）_` : '';
}

/** What to say when a message was only directives, so there is nothing to answer. */
export function directiveOnlyReply(modes: { thinking: boolean; search: boolean }): string {
  const on: string[] = [];
  if (modes.thinking) on.push('深度思考');
  if (modes.search) on.push('联网搜索');
  if (on.length === 0) return '好的，已切换回普通模式。';
  return `好的，已开启：${on.join('、')}。下一条消息就会生效 —— 直接把问题发给我即可。`;
}

/**
 * OpenAI-compatible aliases for the two modes.
 *
 * A client that speaks the OpenAI protocol cannot send `/think`, so the model name is used as the
 * switch — which is what the ecosystem already does (`o1`-style names select reasoning). Recognising
 * the names here means an ordinary OpenAI client can reach both modes with no protocol extension.
 */
export function modesFromModel(model: string | undefined): { thinking: boolean; search: boolean } {
  const m = (model ?? '').toLowerCase();
  return {
    thinking: m.includes('thinking') || m.includes('reason') || m.includes('r1'),
    search: m.includes('search'),
  };
}
