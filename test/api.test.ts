// Pure-function tests for the parts of the HTTP surface that are easy to get subtly
// wrong: OpenAI message flattening, admin auth comparison, and the QQ event-to-reply-target
// mapping.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import { flattenMessages, estimateTokens } from '../src/api/openai';
import { checkAdminAuth } from '../src/admin/ui';
import { safeEqual } from '../src/index';
import { schemaStatements, SCHEMA } from '../src/db/store';
import { replyTargetFor, extractContent, senderOpenId } from '../src/qq/webhook';
import type { Env } from '../src/types';
describe('D1 schema splitting', () => {
  // Regression test for a defect that took the whole deployed Worker down: SCHEMA contains
  // a `--` comment with a semicolon in it, and the old code split on ';' BEFORE removing
  // comments. That cut the comment in half and left a fragment starting with prose, so D1
  // rejected the batch and every route returned 500.
  test('a semicolon inside a comment does not produce a broken statement', () => {
    const evil = [
      '-- rotate it; it expires every 6 hours',
      'CREATE TABLE a (id INTEGER);',
      '-- another; comment',
      'CREATE TABLE b (id INTEGER);',
    ].join('\n');
    const stmts = schemaStatements(evil);
    assert.deepEqual(stmts, ['CREATE TABLE a (id INTEGER)', 'CREATE TABLE b (id INTEGER)']);
    for (const s of stmts) {
      assert.ok(
        /^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|PRAGMA)/i.test(s),
        `fragment does not start with SQL: ${JSON.stringify(s)}`,
      );
    }
  });

  test('every real SCHEMA statement is valid-looking, comment-free SQL', () => {
    const stmts = schemaStatements(SCHEMA);
    assert.ok(stmts.length >= 4, `expected at least 4 statements, got ${stmts.length}`);
    for (const s of stmts) {
      assert.ok(!s.includes('--'), `comment leaked into a statement: ${JSON.stringify(s.slice(0, 60))}`);
      assert.ok(
        /^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|PRAGMA)/i.test(s),
        `statement does not start with SQL: ${JSON.stringify(s.slice(0, 60))}`,
      );
    }
    // The tables the rest of the code depends on must actually be created.
    const joined = stmts.join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS call_log/);
    assert.match(joined, /CREATE TABLE IF NOT EXISTS app_state/);
  });

  test('strips whole-line comments but not trailing content', () => {
    assert.deepEqual(schemaStatements('-- only a comment\n'), []);
    assert.deepEqual(schemaStatements(''), []);
    assert.deepEqual(schemaStatements('   \n\n  '), []);
  });
});

describe('OpenAI request handling', () => {
  test('flattens a message array into one prompt', () => {
    assert.equal(
      flattenMessages([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ]),
      'be brief\n\nhi\n\nhello\n\nagain',
    );
  });

  test('skips empty content and stringifies structured content', () => {
    assert.equal(flattenMessages([{ role: 'user', content: '' }, { role: 'user', content: 'kept' }]), 'kept');
    assert.equal(flattenMessages([{ role: 'user', content: { a: 1 } }]), '{"a":1}');
    assert.equal(flattenMessages([]), '');
  });

  test('estimates tokens without pretending to be a tokenizer', () => {
    assert.equal(estimateTokens(''), 1, 'never returns zero, so usage fields are never 0');
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('a'.repeat(40)), 10);
  });
});

describe('admin auth', () => {
  const env = { ADMIN_PASSWORD: 'correct horse battery staple' } as Env;
  const basic = (pw: string) => `Basic ${btoa(`admin:${pw}`)}`;

  test('accepts the right password and rejects everything else', () => {
    assert.equal(checkAdminAuth(env, basic('correct horse battery staple')), true);
    assert.equal(checkAdminAuth(env, basic('wrong')), false);
    assert.equal(checkAdminAuth(env, basic('')), false);
    // a prefix must not pass
    assert.equal(checkAdminAuth(env, basic('correct horse battery stapl')), false);
    assert.equal(checkAdminAuth(env, null), false);
    assert.equal(checkAdminAuth(env, 'Bearer abc'), false);
    assert.equal(checkAdminAuth(env, 'Basic !!!not-base64!!!'), false);
    assert.equal(checkAdminAuth(env, 'Basic ' + btoa('nocolon')), false);
  });

  test('refuses to authenticate at all when no password is configured', () => {
    // An unset ADMIN_PASSWORD must fail closed, not open.
    assert.equal(checkAdminAuth({ ADMIN_PASSWORD: '' } as Env, basic('')), false);
  });
});

describe('secret comparison', () => {
  test('compares secrets correctly across the full length range', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    // Length mismatch must fail — mixed into the accumulator rather than early-returned
    // so the work done does not reveal the length.
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('abcd', 'abc'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual('', 'a'), false);
    assert.equal(safeEqual('a', ''), false);
    // Realistic key material.
    const k = 'a'.repeat(48);
    assert.equal(safeEqual(k, k), true);
    assert.equal(safeEqual(k, 'a'.repeat(47) + 'b'), false);
    assert.equal(safeEqual(k, 'a'.repeat(47)), false);
  });
});

describe('QQ event routing', () => {
  // Regression tests for a defect that silently swallowed EVERY real QQ message.
  //
  // The sender id was read from `d.user_openid`, which message events do not have — they
  // nest it under `author`. The event was therefore classified as "not replyable" and no
  // reply was ever produced, while the ACK still returned 200, so nothing looked broken.
  //
  // Field paths taken from the official SDK (tencent-connect/botpy, botpy/message.py):
  //   C2CMessage   -> data["author"]["user_openid"]
  //   GroupMessage -> data["author"]["member_openid"] + data["group_openid"]
  test('C2C sender id is read from author.user_openid, not top level', () => {
    const real = {
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'hi', author: { user_openid: 'USER_A' } },
    };
    assert.equal(senderOpenId(real), 'USER_A');
    assert.deepEqual(replyTargetFor(real), { path: '/v2/users/USER_A/messages', msgId: 'm1', msgSeq: 1 });

    // The wrong path must NOT be what carries the event, or this test would not have caught
    // the original bug.
    assert.equal(
      senderOpenId({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { content: 'hi', user_openid: 'TOP' } }),
      'TOP',
      'a top-level user_openid is tolerated as a fallback',
    );
  });

  test('group sender id uses author.member_openid and replies to the group', () => {
    const real = {
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'm2', content: 'hi', group_openid: 'GROUP_1', author: { member_openid: 'MEMBER_1' } },
    };
    assert.equal(senderOpenId(real), 'MEMBER_1');
    assert.deepEqual(replyTargetFor(real), { path: '/v2/groups/GROUP_1/messages', msgId: 'm2', msgSeq: 1 });
  });

  test('senderOpenId falls back through the tolerated variants', () => {
    assert.equal(senderOpenId({ op: 0, d: { group_member_openid: 'GM' } }), 'GM');
    assert.equal(senderOpenId({ op: 0, d: { author: { id: 'AID' } } }), 'AID');
    assert.equal(senderOpenId({ op: 0, d: {} }), null);
    assert.equal(senderOpenId({ op: 0 }), null);
    assert.equal(senderOpenId({ op: 0, d: { author: { user_openid: '' } } }), null, 'empty is not an id');
    assert.equal(senderOpenId({ op: 0, d: { user_openid: 123 } }), null, 'non-string is not an id');
  });

  test('maps C2C and group events to the right message endpoints', () => {
    assert.deepEqual(
      replyTargetFor({
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'm1', author: { user_openid: 'u1' } },
      }),
      { path: '/v2/users/u1/messages', msgId: 'm1', msgSeq: 1 },
    );
    const group = replyTargetFor({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'm2', group_openid: 'g1', author: { member_openid: 'mem' } },
    });
    assert.equal(group?.path, '/v2/groups/g1/messages');
    assert.equal(group?.msgId, 'm2');
  });

  test('returns null for events that are not user messages', () => {
    assert.equal(replyTargetFor({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {} }), null, 'missing openid');
    assert.equal(replyTargetFor({ op: 0, t: 'READY', d: {} }), null);
    assert.equal(replyTargetFor({ op: 0 }), null);
    // A group event without a group_openid cannot be addressed.
    assert.equal(
      replyTargetFor({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { author: { member_openid: 'm' } } }),
      null,
    );
    assert.equal(replyTargetFor({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 42 } }), null, 'non-string');
  });

  test('extracts trimmed content and ignores empty or non-string payloads', () => {
    assert.equal(extractContent({ op: 0, d: { content: '  hi  ' } }), 'hi');
    assert.equal(extractContent({ op: 0, d: { content: '   ' } }), null);
    assert.equal(extractContent({ op: 0, d: {} }), null);
    assert.equal(extractContent({ op: 0, d: { content: 123 } }), null);
  });
});
