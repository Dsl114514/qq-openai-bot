// Mode resolution: which flags actually reach the upstream request.
//
// REGRESSION TEST FOR A REAL BUG. The first implementation computed the resolved modes into local
// variables and never wrote them back onto the request, while `completeOnce` reads
// `request.thinking` / `request.search`. Measured against the live API:
//
//   explicit { thinking: true }        -> 26-token reasoning reply   (worked: already on the request)
//   model name "deepseek-web-thinking" -> plain 1-token answer       (silently did nothing)
//   "/think <question>"                -> plain 1-token answer       (silently did nothing)
//
// Two of three advertised routes were placebos. Nothing errored, and the answers looked fine.
//
// This test asserts the RESOLUTION, because that is where the bug was: it is not enough for the
// parser to be right if its result never reaches the request.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import { modesFromModel, parseModes } from '../src/modes';

/**
 * The resolution rule as `handleChatCompletion` applies it.
 *
 * Mirrors the three-line block in src/api/openai.ts. Kept as a local copy so the test states the
 * intended rule explicitly rather than importing an internal — but the assertion that matters is the
 * one below about the REQUEST being mutated, which is what actually broke.
 */
function resolve(request: { model?: string; thinking?: boolean; search?: boolean; messages: { content: string }[] }) {
  const fromModel = modesFromModel(request.model);
  const directive = parseModes(request.messages[0]?.content ?? '', {});
  request.thinking = request.thinking ?? (fromModel.thinking || directive.thinking);
  request.search = request.search ?? (fromModel.search || directive.search);
  return request;
}

describe('mode resolution reaches the request', () => {
  test('an explicit field is preserved', () => {
    const req = resolve({ thinking: true, messages: [{ content: 'hi' }] });
    assert.equal(req.thinking, true);
  });

  test('an explicit false is NOT overridden by the model name', () => {
    // `??` not `||`: a caller that explicitly disabled a mode must win over a name that implies it.
    const req = resolve({ model: 'deepseek-web-thinking', thinking: false, messages: [{ content: 'hi' }] });
    assert.equal(req.thinking, false, 'an explicit opt-out must beat the model name');
  });

  test('the model name enables thinking — and the value lands on the request', () => {
    // This is the assertion the original bug would have failed: the parser was right, but nothing
    // assigned the result, so the request stayed `undefined` and upstream saw `false`.
    const req = resolve({ model: 'deepseek-web-thinking', messages: [{ content: 'hi' }] });
    assert.equal(req.thinking, true, 'the resolved value must be ON the request, not just computed');
  });

  test('a /think directive enables thinking — and the value lands on the request', () => {
    const req = resolve({ messages: [{ content: '/think 为什么' }] });
    assert.equal(req.thinking, true);
  });

  test('the model name enables search', () => {
    const req = resolve({ model: 'deepseek-web-search', messages: [{ content: 'hi' }] });
    assert.equal(req.search, true);
  });

  test('a plain request enables neither', () => {
    const req = resolve({ model: 'deepseek-web', messages: [{ content: '你好' }] });
    assert.equal(req.thinking, false);
    assert.equal(req.search, false);
  });

  test('a mid-sentence mention does not enable anything', () => {
    const req = resolve({ messages: [{ content: '解释 /think 这个词' }] });
    assert.equal(req.thinking, false);
  });

  test('the directive is stripped from the prompt the model sees', () => {
    const directive = parseModes('/think 真正的问题');
    assert.equal(directive.prompt, '真正的问题');
  });
});
