// Outbound message construction.
//
// Every field in a QQ send body has a specific meaning, and getting one wrong produces a rejection
// whose message does not name the field — so the payload is asserted directly rather than inferred
// from a successful send.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildSendBody,
  extractQuoteRef,
  looksLikeMarkdown,
  toMarkdownSafe,
  type SendTarget,
} from '../src/qq/outbound';

const target = (over: Partial<SendTarget> = {}): SendTarget => ({
  path: '/v2/groups/G/messages',
  msgId: 'MSGID',
  msgSeq: 1,
  ...over,
});

describe('quote reference extraction', () => {
  test('pulls msg_idx out of a real event', () => {
    // Copied from a live GROUP_AT_MESSAGE_CREATE.
    const event = {
      d: {
        message_scene: {
          source: 'default',
          ext: [
            'msg_idx=REFIDX_G/Qznqi1YZFjZ0VbGVSmjwXFnkRz+qwM/bPONKzdAUUQxMcKnV0u0FAK0K3zuJjHjP8xf4TdKPUYQH7ZOFql84S55INP4mkyApSaq2974KQ6XtENfJQeHxDuBcIuEtxe',
            'auth_token=bP0nPC0eIsMN2zjC9gNUA4X2G41YmNOOcTa2LV3AaCzR1vdfRGIJagdxNztOzRgkQzQDjqrLbcM0_iS7lHSJpMxAAWNBUkM1r-ifYjfPRpBlJLQxqn1OSE_HUX0',
          ],
        },
      },
    };
    const ref = extractQuoteRef(event);
    assert.ok(ref);
    assert.ok(ref.startsWith('REFIDX_'), 'the index is opaque and must be returned verbatim');
    assert.ok(ref.includes('/'), 'slashes are part of the value and must not be stripped');
    assert.ok(ref.includes('+'), 'plus signs too');
  });

  test('returns null when there is no reference rather than an empty string', () => {
    // An empty string would be sent as a reference and rejected; null is skipped.
    assert.equal(extractQuoteRef({ d: {} }), null);
    assert.equal(extractQuoteRef({ d: { message_scene: {} } }), null);
    assert.equal(extractQuoteRef({ d: { message_scene: { ext: [] } } }), null);
    assert.equal(extractQuoteRef({ d: { message_scene: { ext: ['auth_token=abc'] } } }), null);
    assert.equal(extractQuoteRef({ d: { message_scene: { ext: [42] } } }), null, 'non-strings are ignored');
  });
});

describe('Markdown detection', () => {
  test('recognises the constructs QQ supports', () => {
    assert.equal(looksLikeMarkdown('# 标题\n正文'), true);
    assert.equal(looksLikeMarkdown('- 第一项\n- 第二项'), true);
    assert.equal(looksLikeMarkdown('1. 一\n2. 二'), true);
    assert.equal(looksLikeMarkdown('> 引用'), true);
    assert.equal(looksLikeMarkdown('这是 **加粗** 的'), true);
    assert.equal(looksLikeMarkdown('用 `code` 表示'), true);
    assert.equal(looksLikeMarkdown('[链接](https://qq.com)'), true);
    assert.equal(looksLikeMarkdown('```\ncode\n```'), true);
  });

  test('leaves ordinary prose alone', () => {
    // Sending plain text as Markdown adds a failure mode for no visual benefit.
    assert.equal(looksLikeMarkdown('你好呀'), false);
    assert.equal(looksLikeMarkdown('今天天气不错，出去走走吧。'), false);
    assert.equal(looksLikeMarkdown('2 * 3 = 6'), false, 'a bare asterisk is not a list');
    assert.equal(looksLikeMarkdown('a-b'), false);
  });
});

describe('Markdown sanitising', () => {
  test('drops images, keeping their alt text', () => {
    // QQ downloads and re-hosts images; a model-generated URL usually fails, and that failure
    // rejects the whole message.
    const out = toMarkdownSafe('看这个 ![截图](https://example.invalid/a.png) 效果');
    assert.ok(!out.includes('example.invalid'), 'the unreachable URL must not survive');
    assert.ok(out.includes('截图'), 'but the alt text carries the meaning');
  });

  test('flattens tables instead of letting them render as noise', () => {
    const out = toMarkdownSafe('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.ok(!out.includes('|'), 'table pipes are not supported');
    assert.ok(out.includes('a') && out.includes('1'), 'the content is preserved');
  });

  test('removes horizontal rules and HTML', () => {
    const out = toMarkdownSafe('上面\n---\n下面\n<br>换行');
    assert.ok(!out.includes('---'));
    assert.ok(!out.includes('<br>'));
    assert.ok(out.includes('上面') && out.includes('下面'));
  });

  test('keeps code fences, which are supported and useful', () => {
    const out = toMarkdownSafe('```js\nconst a = 1;\n```');
    assert.ok(out.includes('```'), 'fenced code is the most useful construct for this bot');
    assert.ok(out.includes('const a = 1;'));
  });

  test('collapses runs of blank lines', () => {
    assert.equal(toMarkdownSafe('a\n\n\n\nb'), 'a\n\nb');
  });
});

describe('send body construction', () => {
  test('plain text uses msg_type 0 and content', () => {
    const body = buildSendBody('你好', target());
    assert.equal(body.msg_type, 0);
    assert.equal(body.content, '你好');
    assert.equal(body.markdown, undefined, 'content and markdown must never both be present');
    assert.equal(body.msg_id, 'MSGID');
  });

  test('markdown uses msg_type 2 and NO content field', () => {
    // Sending both `content` and `markdown` is an error, not a preference.
    const body = buildSendBody('**粗**', target(), { markdown: true });
    assert.equal(body.msg_type, 2);
    assert.equal(body.content, undefined);
    assert.ok(body.markdown?.content.includes('粗'));
  });

  test('a quote adds message_reference alongside the passive msg_id', () => {
    // These are different things: msg_id makes the reply legal in the passive window, while
    // message_reference makes it visually quote the message.
    const body = buildSendBody('回复', target({ quoteRef: 'REFIDX_x' }), { quote: true });
    assert.equal(body.msg_id, 'MSGID');
    assert.deepEqual(body.message_reference, { message_id: 'REFIDX_x' });
  });

  test('quoting without a reference is silently skipped', () => {
    const body = buildSendBody('回复', target({ quoteRef: null }), { quote: true });
    assert.equal(body.message_reference, undefined, 'an empty reference would be rejected');
  });

  test('a proactive send omits msg_id but keeps the sequence', () => {
    const body = buildSendBody('主动', target(), { passive: false });
    assert.equal(body.msg_id, undefined);
    assert.equal(body.msg_seq, 1, 'msg_seq is still required for deduplication');
  });

  test('no msg_id means no passive reply, even without asking', () => {
    const body = buildSendBody('x', target({ msgId: undefined }));
    assert.equal(body.msg_id, undefined);
  });
});
