// Reasoning and search modes.
//
// THE GAP THIS CLOSES: the upstream client has always accepted `thinking_enabled` and
// `search_enabled`, but every call path hardcoded them to `false`. A capability the protocol supports
// was unreachable — which is a gap rather than a missing feature, and the kind that stays invisible
// because nothing errors.
//
// The subtle part is directive PARSING. Only leading directives count, because "解释一下 /think 这个词"
// is a sentence about the directive while "/think 解释一下" is an instruction. Treating them the same
// would silently reinterpret ordinary messages and leave no way to talk about the feature.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  parseModes,
  modeFooter,
  directiveOnlyReply,
  modesFromModel,
  THINK_PREFIXES,
  SEARCH_PREFIXES,
  FAST_PREFIXES,
} from '../src/modes';

describe('directive parsing', () => {
  test('a leading directive is consumed and stripped', () => {
    const r = parseModes('/think 为什么天是蓝的');
    assert.equal(r.thinking, true);
    assert.equal(r.search, false);
    assert.equal(r.prompt, '为什么天是蓝的', 'the model must not be asked to answer the directive');
    assert.deepEqual(r.directives, ['/think']);
  });

  test('a directive mid-sentence is NOT a directive', () => {
    // This is the distinction that matters: otherwise ordinary messages get silently reinterpreted.
    const r = parseModes('解释一下 /think 这个词是什么意思');
    assert.equal(r.thinking, false);
    assert.equal(r.prompt, '解释一下 /think 这个词是什么意思', 'the text must reach the model intact');
    assert.deepEqual(r.directives, []);
  });

  test('search works the same way', () => {
    const r = parseModes('/search 今天的新闻');
    assert.equal(r.search, true);
    assert.equal(r.thinking, false);
    assert.equal(r.prompt, '今天的新闻');
  });

  test('directives stack', () => {
    const r = parseModes('/think /search 分析一下');
    assert.equal(r.thinking, true);
    assert.equal(r.search, true);
    assert.equal(r.prompt, '分析一下');
    assert.deepEqual(r.directives, ['/think', '/search']);
  });

  test('/fast turns both off, including against a default', () => {
    // The opt-OUT path. Without it, a caller who pre-enables a mode could not disable it per turn.
    const r = parseModes('/fast 简单说说', { thinking: true, search: true });
    assert.equal(r.thinking, false);
    assert.equal(r.search, false);
    assert.equal(r.prompt, '简单说说');
  });

  test('defaults apply when no directive is present', () => {
    const r = parseModes('普通问题', { thinking: true });
    assert.equal(r.thinking, true);
    assert.equal(r.search, false);
    assert.equal(r.prompt, '普通问题');
  });

  test('a directive on its own is flagged rather than answered', () => {
    // Answering it would send an empty prompt upstream and produce a generic reply to nothing.
    for (const d of ['/think', '/search', '/think /search']) {
      const r = parseModes(d);
      assert.equal(r.onlyDirectives, true, `${d} is only a directive`);
      assert.equal(r.prompt, '');
    }
  });

  test('an empty message is not a directive', () => {
    const r = parseModes('');
    assert.equal(r.onlyDirectives, false);
    assert.equal(r.thinking, false);
    assert.deepEqual(r.directives, []);
  });

  test('directives are recognised regardless of case', () => {
    assert.equal(parseModes('/THINK 问题').thinking, true);
    assert.equal(parseModes('/Think 问题').thinking, true);
  });

  test('every advertised prefix is recognised', () => {
    // The help text lists these; a listed directive that does not work is a documented lie.
    for (const p of THINK_PREFIXES) assert.equal(parseModes(`${p} x`).thinking, true, `${p} should enable thinking`);
    for (const p of SEARCH_PREFIXES) assert.equal(parseModes(`${p} x`).search, true, `${p} should enable search`);
    for (const p of FAST_PREFIXES) {
      const r = parseModes(`${p} x`, { thinking: true, search: true });
      assert.equal(r.thinking && r.search, false, `${p} should disable both`);
    }
  });

  test('extra whitespace does not break detection', () => {
    const r = parseModes('   /think    问题  ');
    assert.equal(r.thinking, true);
    assert.equal(r.prompt, '问题');
  });

  test('a word that merely starts with a directive is not one', () => {
    // `/thinking` is not `/think`; matching on prefix would swallow it.
    const r = parseModes('/thinking 一下');
    assert.equal(r.thinking, false);
    assert.equal(r.prompt, '/thinking 一下');
  });
});

describe('mode feedback', () => {
  test('the footer names the modes in force', () => {
    assert.ok(modeFooter({ thinking: true, search: false }).includes('深度思考'));
    assert.ok(modeFooter({ thinking: false, search: true }).includes('联网搜索'));
    assert.ok(modeFooter({ thinking: true, search: true }).includes('深度思考'));
    assert.ok(modeFooter({ thinking: true, search: true }).includes('联网搜索'));
  });

  test('no footer when no mode is on', () => {
    // A footer on every ordinary reply would be noise.
    assert.equal(modeFooter({ thinking: false, search: false }), '');
  });

  test('a directive-only message gets a confirmation, not an empty answer', () => {
    assert.ok(directiveOnlyReply({ thinking: true, search: false }).includes('深度思考'));
    assert.ok(directiveOnlyReply({ thinking: false, search: true }).includes('联网搜索'));
    assert.ok(directiveOnlyReply({ thinking: false, search: false }).includes('普通模式'));
  });
});

describe('model-name aliases', () => {
  // A plain OpenAI client cannot send custom fields, so the model name is the only channel it has.
  test('reasoning names select thinking', () => {
    assert.equal(modesFromModel('deepseek-web-thinking').thinking, true);
    assert.equal(modesFromModel('deepseek-reasoner').thinking, true);
    assert.equal(modesFromModel('deepseek-r1').thinking, true);
  });

  test('a search name selects search', () => {
    assert.equal(modesFromModel('deepseek-web-search').search, true);
    assert.equal(modesFromModel('deepseek-web').search, false);
  });

  test('the plain name selects neither', () => {
    const m = modesFromModel('deepseek-web');
    assert.equal(m.thinking, false);
    assert.equal(m.search, false);
  });

  test('a missing model name is safe', () => {
    assert.equal(modesFromModel(undefined).thinking, false);
    assert.equal(modesFromModel('').search, false);
  });
});
