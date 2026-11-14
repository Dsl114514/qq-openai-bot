// Provider selection and the OpenAI-compatible client.
//
// The rules that matter here are the ones that are INVISIBLE when wrong: a base URL that silently omits
// `/v1`, a key that leaks into a response, or a stale `deepseek-web` model default sent to a third party.
// Each produces a failure that looks like something else — usually "the key is bad".

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  completionsUrl,
  modelsUrl,
  normalizeProvider,
  resolveModel,
  isExternalProvider,
  parseHeaders,
  formatHeaders,
  endpointId,
  DEFAULT_PROVIDER,
  DEFAULT_BASE_URL,
  type ProviderEndpoint,
} from '../src/providers/config';
import { toExternalMessages } from '../src/api/openai';
import {
  streamEndpoint,
  streamWithFailover,
  completeWithFailover,
  streamExternalCompletion,
  completeExternal,
  ProviderError,
  type EndpointWithKey,
} from '../src/providers/openai-compat';

describe('completions URL', () => {
  test('a base URL gains the path', () => {
    assert.equal(completionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  });

  test('a full URL is left alone', () => {
    // Typing the whole endpoint is natural, and appending to it would 404 in a way that looks like a key problem.
    assert.equal(
      completionsUrl('https://api.openai.com/v1/chat/completions'),
      'https://api.openai.com/v1/chat/completions',
    );
  });

  test('a trailing slash does not produce a double slash', () => {
    assert.equal(completionsUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(completionsUrl('https://api.openai.com/v1///'), 'https://api.openai.com/v1/chat/completions');
  });

  test('an empty base is empty, not a relative path', () => {
    // Returning "/chat/completions" would produce a request against the Worker's own origin — a confusing
    // self-call rather than a clear configuration error.
    assert.equal(completionsUrl(''), '');
    assert.equal(completionsUrl('   '), '');
  });

  test('a self-hosted URL works', () => {
    assert.equal(completionsUrl('http://192.168.1.10:8080/v1'), 'http://192.168.1.10:8080/v1/chat/completions');
  });
});

describe('provider normalisation', () => {
  test('there is exactly one provider kind now, and a stored deepseek-web kind is coerced', () => {
    // The old system's settings rows name a kind whose protocol is gone; coercion keeps them loadable
    // (endpoints intact) instead of making every read fail on an unknown value.
    assert.equal(DEFAULT_PROVIDER.kind, 'openai-compat');
    assert.equal(normalizeProvider({}).kind, 'openai-compat');
    assert.equal(normalizeProvider({ kind: 'deepseek-web' }).kind, 'openai-compat');
  });

  test('an explicit kind is kept', () => {
    assert.equal(normalizeProvider({ kind: 'openai-compat' }).kind, 'openai-compat');
  });

  test('an unknown kind falls back to the previous value rather than inventing one', () => {
    assert.equal(normalizeProvider({ kind: 'gemini' }).kind, DEFAULT_PROVIDER.kind);
  });

  test('a flat patch edits the FIRST endpoint, keeping the rest', () => {
    // The older single-endpoint shape still works, so scripts and bookmarks do not break — and a fallback
    // configured alongside it must not be lost by an edit that only mentions one endpoint.
    const base = normalizeProvider({
      kind: 'openai-compat',
      endpoints: [
        { id: 'a', label: '主', baseUrl: 'https://a/v1', model: 'm1', enabled: true },
        { id: 'b', label: '备', baseUrl: 'https://b/v1', model: 'm2', enabled: true },
      ],
    });
    const next = normalizeProvider({ model: 'm9' }, base);
    assert.equal(next.endpoints.length, 2, 'the fallback must survive');
    assert.equal(next.endpoints[0].model, 'm9');
    assert.equal(next.endpoints[1].model, 'm2', 'the fallback is untouched');
  });

  test('an empty string does not overwrite a configured value with blank', () => {
    const base = normalizeProvider({
      kind: 'openai-compat',
      endpoints: [{ id: 'a', label: 'x', baseUrl: 'https://a/v1', model: 'm', enabled: true }],
    });
    const next = normalizeProvider({ baseUrl: '', model: '' }, base);
    assert.equal(next.endpoints[0].baseUrl, 'https://a/v1');
    assert.equal(next.endpoints[0].model, 'm');
  });

  test('an endpoint with no URL is dropped, not kept as a permanent failure', () => {
    // A row that fails on every message with "empty URL" is worse than no row at all.
    const next = normalizeProvider({
      kind: 'openai-compat',
      endpoints: [
        { id: 'a', label: 'ok', baseUrl: 'https://a/v1', model: 'm', enabled: true },
        { id: 'b', label: 'broken', baseUrl: '', model: 'm', enabled: true },
      ],
    });
    assert.equal(next.endpoints.length, 1);
    assert.equal(next.endpoints[0].label, 'ok');
  });

  test('a config with no usable endpoint keeps a valid default rather than an empty list', () => {
    // An empty list fails on every message with a confusing error; an unused default merely sits there.
    assert.ok(normalizeProvider({ kind: 'openai-compat', endpoints: [] }).endpoints.length >= 1);
  });

  test('duplicate ids are made unique, because a key is addressed by id', () => {
    // Two endpoints sharing an id would silently share one key — a credential crossing between endpoints.
    const next = normalizeProvider({
      kind: 'openai-compat',
      endpoints: [
        { id: 'same', label: 'a', baseUrl: 'https://a/v1', model: 'm', enabled: true },
        { id: 'same', label: 'b', baseUrl: 'https://b/v1', model: 'm', enabled: true },
      ],
    });
    assert.equal(new Set(next.endpoints.map((e) => e.id)).size, 2);
  });

  test('the endpoint count is bounded', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, label: `e${i}`, baseUrl: `https://e${i}/v1`, model: 'm', enabled: true }));
    assert.ok(normalizeProvider({ kind: 'openai-compat', endpoints: many }).endpoints.length <= 8);
  });

  test('the timeout is bounded to something usable', () => {
    // 0 would abort every request immediately; a huge value holds the invocation open past any budget.
    assert.equal(normalizeProvider({ timeoutMs: 0 }).timeoutMs, DEFAULT_PROVIDER.timeoutMs);
    assert.equal(normalizeProvider({ timeoutMs: -5 }).timeoutMs, DEFAULT_PROVIDER.timeoutMs);
    assert.equal(normalizeProvider({ timeoutMs: 999_999 }).timeoutMs, 120_000);
    assert.equal(normalizeProvider({ timeoutMs: 1500 }).timeoutMs, 1500);
  });

  test('over-long values are truncated rather than stored', () => {
    const next = normalizeProvider({
      endpoints: [{ id: 'a', label: 'x'.repeat(200), baseUrl: 'https://a/' + 'x'.repeat(1000), model: 'y'.repeat(500), enabled: true }],
    });
    assert.ok(next.endpoints[0].baseUrl.length <= 300);
    assert.ok(next.endpoints[0].model.length <= 120);
    assert.ok(next.endpoints[0].label.length <= 60);
  });

  test('isExternalProvider: the only kind left is external, and the historical kind coerces to it', () => {
    assert.equal(isExternalProvider({ kind: 'openai-compat' }), true);
    // 'deepseek-web' is no longer a valid kind (normalisation coerces it), so this input cannot occur
    // through any code path — the assertion documents the runtime behaviour if one ever leaks through.
    assert.equal(isExternalProvider({ kind: 'deepseek-web' } as never), false);
  });
});

describe('custom headers', () => {
  test('Name: value lines become a header map', () => {
    // Some relays require an extra header (OpenRouter's HTTP-Referer, an organisation id). Without this the only
    // way to use them would be to change the code.
    assert.deepEqual(parseHeaders('HTTP-Referer: https://example.com\nX-Title: My Bot'), {
      'HTTP-Referer': 'https://example.com',
      'X-Title': 'My Bot',
    });
  });

  test('blank lines, comments and colon-less lines are ignored', () => {
    assert.deepEqual(parseHeaders('\n# a comment\nno-colon-here\nA: 1\n'), { A: '1' });
  });

  test('a value containing a colon keeps it', () => {
    // URLs contain colons, and splitting on the FIRST colon is what makes this work.
    assert.deepEqual(parseHeaders('X-Url: https://a/b'), { 'X-Url': 'https://a/b' });
  });

  test('a header name with a space is dropped rather than sent', () => {
    // An invalid header name makes the whole request fail with a message that does not name the field.
    assert.deepEqual(parseHeaders('Bad Name: x'), {});
    assert.deepEqual(parseHeaders(': novalue'), {});
  });

  test('headers round-trip through the editable form', () => {
    const h = { A: '1', B: '2' };
    assert.deepEqual(parseHeaders(formatHeaders(h)), h);
  });
});

describe('endpoint identity', () => {
  test('the same label yields the same id, so saving updates rather than duplicating', () => {
    assert.equal(endpointId('primary'), endpointId('primary'));
  });

  test('different labels differ', () => {
    assert.notEqual(endpointId('a'), endpointId('b'));
  });

  test('the id is short and URL-safe', () => {
    const id = endpointId('我的主端点');
    assert.ok(/^[a-z0-9]+$/.test(id), `id must be safe to embed, got ${id}`);
  });

  test('a blank label still yields a usable id', () => {
    assert.ok(/^[a-z0-9]+$/.test(endpointId('')));
  });
});

describe('models URL', () => {
  test('a base gains the path', () => {
    assert.equal(modelsUrl('https://api.test/v1'), 'https://api.test/v1/models');
  });

  test('a completions URL has its last segment swapped', () => {
    assert.equal(modelsUrl('https://api.test/v1/chat/completions'), 'https://api.test/v1/models');
  });
});

describe('model resolution', () => {
  test('the historical default is treated as NO OVERRIDE', () => {
    // `deepseek-web` is stored in every existing settings row. Sending it to a third-party endpoint would be a
    // guaranteed 404 that looks like a broken key, so it must fall through to the provider's own model.
    assert.equal(resolveModel('deepseek-web', 'gpt-4o-mini'), 'gpt-4o-mini');
    assert.equal(resolveModel(undefined, 'gpt-4o-mini'), 'gpt-4o-mini');
    assert.equal(resolveModel('', 'gpt-4o-mini'), 'gpt-4o-mini');
    assert.equal(resolveModel('   ', 'gpt-4o-mini'), 'gpt-4o-mini');
  });

  test('a real override wins', () => {
    assert.equal(resolveModel('claude-3-5-sonnet', 'gpt-4o-mini'), 'claude-3-5-sonnet');
    assert.equal(resolveModel('deepseek-chat', 'gpt-4o-mini'), 'deepseek-chat');
  });
});

describe('external message mapping', () => {
  test('roles are preserved, unlike the flattened prompt', () => {
    // A system message delivered as `role: system` is obeyed; the same words inside a user turn are merely
    // context. Flattening would silently downgrade the persona.
    const msgs = toExternalMessages([
      { role: 'system', content: '用粤语回答' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ]);
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(msgs[0].content, '用粤语回答');
  });

  test('an unknown role is sent as user, not as an elevated one', () => {
    // An unrecognised role is more likely a client extension than an instruction with elevated trust.
    const msgs = toExternalMessages([{ role: 'developer', content: 'x' }]);
    assert.equal(msgs[0].role, 'user');
  });

  test('empty content is dropped rather than sent as an empty turn', () => {
    const msgs = toExternalMessages([
      { role: 'user', content: '' },
      { role: 'user', content: 'real' },
    ]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'real');
  });

  test('non-string content is serialised rather than dropped', () => {
    // OpenAI's schema allows an array of parts; losing it would silently truncate a multimodal request.
    const msgs = toExternalMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].content.includes('hi'));
  });
});

/** A fetch stub returning a scripted response. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as unknown as typeof fetch;
}

/** Build an SSE body from a list of JSON payloads. */
function sseBody(payloads: unknown[], lineEnding = '\n'): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}${lineEnding}${lineEnding}`).join('');
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

const config = { kind: 'openai-compat' as const, baseUrl: 'https://api.test/v1', model: 'm', timeoutMs: 5000, apiKey: 'sk-test' };

describe('external streaming', () => {
  test('deltas are accumulated in order', async () => {
    const fetchImpl = stubFetch(() =>
      new Response(
        sseBody([
          { choices: [{ delta: { content: '你' } }] },
          { choices: [{ delta: { content: '好' } }] },
          '[DONE]',
        ]),
        { status: 200 },
      ),
    );

    let text = '';
    for await (const d of streamExternalCompletion(config, { model: 'm', messages: [{ role: 'user', content: 'x' }] }, fetchImpl)) {
      text += d.text;
    }
    assert.equal(text, '你好');
  });

  test('the request is a bearer-authenticated POST to the completions URL', async () => {
    let seen = { url: '', method: '', auth: '', body: '' };
    const fetchImpl = stubFetch((url, init) => {
      seen = {
        url,
        method: init.method ?? '',
        auth: String((init.headers as Record<string, string>).authorization ?? ''),
        body: String(init.body ?? ''),
      };
      return new Response(sseBody(['[DONE]']), { status: 200 });
    });

    for await (const _ of streamExternalCompletion(config, { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }, fetchImpl)) {
      void _;
    }

    assert.equal(seen.url, 'https://api.test/v1/chat/completions');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.auth, 'Bearer sk-test');
    const body = JSON.parse(seen.body) as { model: string; stream: boolean; messages: unknown[] };
    assert.equal(body.model, 'gpt-x');
    assert.equal(body.stream, true, 'the streaming path must ask for a stream');
    assert.equal(body.messages.length, 1);
  });

  test('CRLF frames are parsed', async () => {
    // Some providers send CRLF; a parser that only looks for `\n\n` would buffer forever and hang.
    const fetchImpl = stubFetch(() =>
      new Response(sseBody([{ choices: [{ delta: { content: 'ok' } }] }], '\r\n'), { status: 200 }),
    );
    let text = '';
    for await (const d of streamExternalCompletion(config, { model: 'm', messages: [] }, fetchImpl)) text += d.text;
    assert.equal(text, 'ok');
  });

  test('a malformed frame is skipped, not fatal', async () => {
    // Keep-alive comments and partial frames are normal; failing the whole stream over one is not.
    const fetchImpl = stubFetch(() =>
      new Response(sseBody(['{not json', { choices: [{ delta: { content: 'ok' } }] }]), { status: 200 }),
    );
    let text = '';
    for await (const d of streamExternalCompletion(config, { model: 'm', messages: [] }, fetchImpl)) text += d.text;
    assert.equal(text, 'ok');
  });

  test('an empty delta is not yielded', async () => {
    const fetchImpl = stubFetch(() =>
      new Response(sseBody([{ choices: [{ delta: { content: '' } }] }, { choices: [{ delta: {} }] }]), { status: 200 }),
    );
    let count = 0;
    for await (const _ of streamExternalCompletion(config, { model: 'm', messages: [] }, fetchImpl)) count++;
    assert.equal(count, 0, 'yielding empties would emit blank chunks to the client');
  });
});

describe('external failure messages', () => {
  const failing = (status: number, body: string) => stubFetch(() => new Response(body, { status }));

  test('401 names the key, not the URL', async () => {
    // The whole point: an operator must not spend time checking the URL when the key is the problem.
    await assert.rejects(
      async () => {
        for await (const _ of streamExternalCompletion(config, { model: 'm', messages: [] }, failing(401, '{"error":{"message":"invalid_api_key"}}'))) void _;
      },
      (e: Error) => {
        assert.ok(e instanceof ProviderError);
        assert.match(e.message, /API Key/);
        assert.match(e.message, /invalid_api_key/, 'the provider detail must be included');
        return true;
      },
    );
  });

  test('404 names the URL and says /v1 is the usual cause', async () => {
    await assert.rejects(
      async () => {
        for await (const _ of streamExternalCompletion(config, { model: 'm', messages: [] }, failing(404, 'not found'))) void _;
      },
      (e: Error) => {
        assert.match(e.message, /404/);
        assert.match(e.message, /\/v1/, 'the common cause must be stated');
        assert.match(e.message, /不是密钥问题/, 'and the wrong lead must be explicitly ruled out');
        return true;
      },
    );
  });

  test('429 says the endpoint is temporarily unusable and failover applies', async () => {
    // MEASURED: `error code: 1015` persisted for minutes while the same key worked from another network — a
    // standing rule, not a burst. The message therefore does NOT say "try again later" for every case: it
    // points at the endpoint and at failover, which is what the feature now does automatically.
    await assert.rejects(
      async () => {
        for await (const _ of streamExternalCompletion(config, { model: 'm', messages: [] }, failing(429, 'error code: 1015'))) void _;
      },
      (e: Error) => {
        assert.match(e.message, /429/);
        assert.match(e.message, /限流/);
        assert.match(e.message, /端点/, 'failover is the action, and it must be named');
        assert.match(e.message, /1015/, 'the provider detail must be included');
        return true;
      },
    );
  });

  test('a missing key fails before any request is made', async () => {
    let called = false;
    const fetchImpl = stubFetch(() => {
      called = true;
      return new Response('', { status: 200 });
    });
    await assert.rejects(
      async () => {
        for await (const _ of streamExternalCompletion({ ...config, apiKey: '' }, { model: 'm', messages: [] }, fetchImpl)) void _;
      },
      (e: Error) => {
        assert.match(e.message, /API Key/);
        return true;
      },
    );
    assert.equal(called, false, 'no request should be attempted without a key');
  });

  test('a connection failure names the endpoint, not just the network', async () => {
    const fetchImpl = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(
      async () => {
        for await (const _ of streamExternalCompletion(config, { model: 'm', messages: [] }, fetchImpl)) void _;
      },
      (e: Error) => {
        assert.match(e.message, /无法连接端点/);
        // The label is included because with failover configured there are several, and "it failed" without
        // saying which one leaves the operator to guess.
        assert.match(e.message, /single/);
        return true;
      },
    );
  });
});

describe('external non-streaming', () => {
  test('returns the message content', async () => {
    const fetchImpl = stubFetch(() =>
      Response.json({ choices: [{ message: { content: '答案' } }], model: 'm' }),
    );
    const r = await completeExternal(config, { model: 'm', messages: [{ role: 'user', content: 'q' }] }, fetchImpl);
    assert.equal(r.text, '答案');
  });

  test('an empty choices array yields empty text rather than throwing', async () => {
    // The caller reports "empty reply", which is a content problem — not a transport error to be retried.
    const fetchImpl = stubFetch(() => Response.json({ choices: [] }));
    const r = await completeExternal(config, { model: 'm', messages: [] }, fetchImpl);
    assert.equal(r.text, '');
  });
});

/**
 * A REAL HTTP ROUND TRIP, against a throwaway server.
 *
 * The stubs above test the parser against synthetic `Response` objects. This one proves the whole path works
 * over an actual socket — which matters because the live failure was "the model returned an empty reply" from
 * a provider that WAS being reached. A stub cannot distinguish "our parsing is wrong" from "the transport
 * shape differs from what we assumed", and that is precisely the distinction needed.
 */
describe('external provider over a real socket', () => {
  test('a documented OpenAI stream is parsed end to end', async () => {
    const { createServer } = await import('node:http');

    let seen = { url: '', auth: '', body: null as Record<string, unknown> | null };
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen = { url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: JSON.parse(raw || '{}') };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // The real shape, INCLUDING the empty role-only frame servers send first.
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`);
        for (const piece of ['你', '好', '呀']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    try {
      let text = '';
      const deltas: string[] = [];
      for await (const d of streamExternalCompletion(
        { ...config, baseUrl: `http://127.0.0.1:${port}/v1` },
        { model: 'mock', messages: [{ role: 'user', content: '测试' }] },
      )) {
        text += d.text;
        deltas.push(d.text);
      }

      assert.equal(text, '你好呀', 'the text must be extracted in order');
      assert.equal(deltas.length, 3, 'the empty role-only frame must not be yielded as a delta');
      assert.equal(seen.url, '/v1/chat/completions');
      assert.equal(seen.auth, 'Bearer sk-test');
      assert.equal(seen.body?.model, 'mock');
      assert.equal(seen.body?.stream, true);
    } finally {
      server.close();
    }
  });

  test('the models endpoint is reachable for the connection test', async () => {
    // The console's 测试连接 button hits <base>/models; a provider that serves chat but not models would make
    // that button useless, so the path is asserted here rather than discovered in the UI.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer sk-test' } });
      const json = (await res.json()) as { data: { id: string }[] };
      assert.deepEqual(
        json.data.map((m) => m.id),
        ['mock-model', 'other'],
      );
    } finally {
      server.close();
    }
  });
});

/** Build an endpoint for the failover tests. */
function ep(id: string, label: string, baseUrl: string): EndpointWithKey {
  return { id, label, baseUrl, model: 'm', enabled: true, headers: {}, apiKey: 'sk-' + id };
}

/** A fetch stub that answers per host, so one endpoint can fail while another succeeds. */
function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [host, handler] of Object.entries(routes)) {
      if (url.includes(host)) return handler();
    }
    throw new TypeError(`no route for ${url}`);
  }) as unknown as typeof fetch;
}

const okStream = () => new Response(sseBody([{ choices: [{ delta: { content: '好的' } }] }, '[DONE]']), { status: 200 });
const okJson = () => Response.json({ choices: [{ message: { content: '好的' } }] });

describe('endpoint failover', () => {
  test('the first working endpoint answers and no others are contacted', async () => {
    const contacted: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      contacted.push(String(input));
      return okStream();
    }) as unknown as typeof fetch;

    const result = await streamWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl });

    assert.equal(result.text, '好的');
    assert.equal(result.endpoint.id, 'a');
    assert.equal(contacted.length, 1, 'the fallback must not be called when the first works');
    assert.equal(result.attempts.length, 1);
  });

  test('a rate-limited endpoint falls through to the next', async () => {
    // THIS IS THE CASE FAILOVER EXISTS FOR: a 429 on one relay is fixed by using another, and without this the
    // whole bot is down for as long as the limit lasts.
    const fetchImpl = routedFetch({
      'a.test': () => new Response('error code: 1015', { status: 429 }),
      'b.test': okStream,
    });

    const result = await streamWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl });

    assert.equal(result.text, '好的');
    assert.equal(result.endpoint.id, 'b');
    assert.deepEqual(
      result.attempts.map((a) => a.endpointId),
      ['a', 'b'],
      'both attempts must be recorded, so the failover is visible in the log',
    );
    assert.equal(result.attempts[0].status, 429);
    assert.ok(result.attempts[0].error, 'the first failure is kept, with its reason');
  });

  test('a server error falls through', async () => {
    const fetchImpl = routedFetch({ 'a.test': () => new Response('boom', { status: 503 }), 'b.test': okStream });
    const result = await streamWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl });
    assert.equal(result.endpoint.id, 'b');
  });

  test('a connection failure falls through', async () => {
    const fetchImpl = routedFetch({
      'a.test': () => {
        throw new TypeError('fetch failed');
      },
      'b.test': okStream,
    });
    const result = await streamWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl });
    assert.equal(result.endpoint.id, 'b');
  });

  test('a 400 does NOT fall through, because every endpoint would reject it identically', async () => {
    // Retrying a malformed request wastes the whole list's quota and turns one clear error into N confusing
    // ones — so the classification is deliberate, not "try everything".
    let contacted = 0;
    const fetchImpl = (async () => {
      contacted++;
      return new Response('{"error":{"message":"model_not_found"}}', { status: 400 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => streamWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl }),
      (e: Error) => {
        assert.match(e.message, /400/);
        assert.match(e.message, /换端点不会有帮助/, 'the operator must be told not to chase endpoints');
        return true;
      },
    );
    assert.equal(contacted, 1, 'the second endpoint must not be tried for a malformed request');
  });

  test('when every endpoint fails, the error names each one', async () => {
    // "It failed" without saying WHERE leaves the operator guessing which of several endpoints is the problem.
    const fetchImpl = routedFetch({
      'a.test': () => new Response('limit', { status: 429 }),
      'b.test': () => new Response('boom', { status: 500 }),
    });

    await assert.rejects(
      () => streamWithFailover([ep('a', '主端点', 'https://a.test/v1'), ep('b', '备用端点', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl }),
      (e: Error) => {
        assert.match(e.message, /2 个端点全部失败/);
        assert.match(e.message, /主端点/);
        assert.match(e.message, /备用端点/);
        return true;
      },
    );
  });

  test('an empty endpoint list is refused with an actionable message', async () => {
    await assert.rejects(
      () => streamWithFailover([], { model: 'm', messages: [] }),
      (e: Error) => {
        assert.match(e.message, /没有可用的端点/);
        assert.match(e.message, /模型来源/, 'it must say where to fix it');
        return true;
      },
    );
  });

  test('a partial answer is returned rather than discarded, and the next endpoint is not tried', async () => {
    // Concatenating a second endpoint's answer onto a partial one would show the user two replies glued together.
    const { createServer } = await import('node:http');
    let fallbackContacted = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分' } }] })}\n\n`);
      // DROPPED MID-STREAM, AFTER A DELAY. The delay is load-bearing: destroying the socket synchronously with
      // the write races the client's read, so the frame sometimes never arrives and the test reports an empty
      // partial answer — which is a different code path from the one being tested.
      setTimeout(() => res.destroy(), 80);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('fallback')) {
        fallbackContacted = true;
        return okStream();
      }
      return fetch(String(input));
    }) as unknown as typeof fetch;

    try {
      const result = await streamWithFailover(
        [ep('a', '主', `http://127.0.0.1:${port}/v1`), ep('b', '备', 'https://fallback/v1')],
        { model: 'm', messages: [] },
        { fetchImpl },
      );
      assert.equal(result.text, '部分', 'the partial answer must be kept');
      assert.equal(fallbackContacted, false, 'the fallback must not be used once text has been produced');
    } finally {
      server.close();
    }
  });

  test('an empty 200 answer does NOT trigger failover', async () => {
    // A working endpoint giving a contentless reply is a real answer; substituting a DIFFERENT model's opinion
    // silently would leave nobody able to tell which model had spoken.
    let contacted = 0;
    const fetchImpl = (async () => {
      contacted++;
      return new Response(sseBody(['[DONE]']), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await streamWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, { fetchImpl });
    assert.equal(result.text, '');
    assert.equal(result.endpoint.id, 'a');
    assert.equal(contacted, 1);
  });

  test('onDelta is called with the partial text from whichever endpoint answered', async () => {
    const fetchImpl = routedFetch({ 'a.test': () => new Response('nope', { status: 429 }), 'b.test': okStream });
    const seen: string[] = [];
    await streamWithFailover(
      [ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')],
      { model: 'm', messages: [] },
      { fetchImpl, onDelta: (t) => seen.push(t) },
    );
    assert.deepEqual(seen, ['好的']);
  });

  test('onAttempt reports each failure as it happens, not only at the end', async () => {
    // Live progress matters: a failover can take tens of seconds, and silence looks like a hang.
    const fetchImpl = routedFetch({ 'a.test': () => new Response('x', { status: 429 }), 'b.test': okStream });
    const attempts: { label: string; error: string | null }[] = [];
    await streamWithFailover(
      [ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')],
      { model: 'm', messages: [] },
      { fetchImpl, onAttempt: (a) => attempts.push({ label: a.label, error: a.error }) },
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].label, '主');
    assert.ok(attempts[0].error);
    assert.equal(attempts[1].error, null);
  });
});

describe('non-streaming failover', () => {
  test('falls through to the second endpoint', async () => {
    const fetchImpl = routedFetch({ 'a.test': () => new Response('x', { status: 429 }), 'b.test': okJson });
    const result = await completeWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, fetchImpl);
    assert.equal(result.text, '好的');
    assert.equal(result.endpoint.id, 'b');
  });

  test('a 400 does not fall through here either', async () => {
    let contacted = 0;
    const fetchImpl = (async () => {
      contacted++;
      return new Response('bad', { status: 422 });
    }) as unknown as typeof fetch;
    await assert.rejects(() => completeWithFailover([ep('a', '主', 'https://a.test/v1'), ep('b', '备', 'https://b.test/v1')], { model: 'm', messages: [] }, fetchImpl));
    assert.equal(contacted, 1);
  });
});
