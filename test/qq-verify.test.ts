// QQ callback signature handling.
//
// The awkward part of QQ's scheme is the key: the "Bot Secret" is an arbitrary ASCII
// string that both sides expand to 32 bytes by repeating it. That is not a standard key
// encoding, so whether a given WebCrypto implementation accepts it is an empirical
// question, not a documented one. These tests pin the expansion rule and prove the whole
// path round-trips; `probeVerificationSupport` reports which import route the current
// runtime actually accepts.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';

import {
  expandSecret,
  createSigner,
  verifyEventSignature,
  buildValidationResponse,
  probeVerificationSupport,
  bytesToHex,
} from '../src/qq/verify';

describe('secret expansion', () => {
  test('repeats the secret to exactly 32 bytes', () => {
    assert.deepEqual([...expandSecret('abc')].slice(0, 6), [97, 98, 99, 97, 98, 99]);
    assert.equal(expandSecret('abc').length, 32);
    assert.equal(expandSecret('a'.repeat(32)).length, 32);
    // a 32-byte secret must be used verbatim, not wrapped
    assert.equal(bytesToHex(expandSecret('a'.repeat(32))), '61'.repeat(32));
  });

  test('handles secrets longer and shorter than 32 bytes deterministically', () => {
    const long = 'x'.repeat(100);
    assert.equal(bytesToHex(expandSecret(long)), '78'.repeat(32));
    // 17 chars does not divide 32, so the tail is a partial repeat
    const odd = expandSecret('0123456789abcdefg');
    assert.equal(odd.length, 32);
    assert.equal(String.fromCharCode(...odd.slice(0, 17)), '0123456789abcdefg');
    assert.equal(String.fromCharCode(...odd.slice(17)), '0123456789abcdefg'.slice(0, 15));
  });

  test('rejects an empty secret instead of producing a zero key', () => {
    assert.throws(() => expandSecret(''), /bot secret is empty/);
  });
});

describe('signature verification', () => {
  test('a signature produced by the signer verifies, and a tampered one does not', async () => {
    const secret = 'test-bot-secret-value';
    const signer = await createSigner(secret);
    const timestamp = '1700000000';
    const body = JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { content: 'hello' } });

    const signature = bytesToHex(await signer.sign(new TextEncoder().encode(timestamp + body)));
    assert.equal(await verifyEventSignature(secret, signature, timestamp, body), true, 'valid signature rejected');

    // every part of the signed message matters
    assert.equal(await verifyEventSignature(secret, signature, '1700000001', body), false, 'wrong timestamp accepted');
    assert.equal(await verifyEventSignature(secret, signature, timestamp, `${body} `), false, 'tampered body accepted');
    assert.equal(
      await verifyEventSignature('a-different-secret', signature, timestamp, body),
      false,
      'wrong secret accepted',
    );
  });

  test('the raw body is signed, so re-serialising it breaks verification', async () => {
    // This is the reason the webhook handler must read the body as text before parsing.
    // The fixture deliberately contains whitespace, because JSON.parse -> JSON.stringify
    // is byte-identical for compact JSON and would make this test vacuous.
    const secret = 'test-bot-secret-value';
    const signer = await createSigner(secret);
    const raw = '{\n  "op": 0,\n  "d": { "content": "hi" },\n  "t": "C2C_MESSAGE_CREATE"\n}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    const timestamp = '1700000000';

    assert.notEqual(raw, reserialised, 'fixture must actually change under re-serialisation');

    const sig = bytesToHex(await signer.sign(new TextEncoder().encode(timestamp + raw)));
    assert.equal(await verifyEventSignature(secret, sig, timestamp, raw), true);
    assert.equal(
      await verifyEventSignature(secret, sig, timestamp, reserialised),
      false,
      're-serialised body was accepted, which means the signed bytes are not what is checked',
    );
  });

  test('rejects malformed signatures without throwing', async () => {
    const secret = 's';
    const body = '{}';
    assert.equal(await verifyEventSignature(secret, '', '1', body), false);
    assert.equal(await verifyEventSignature(secret, 'zz', '1', body), false);
    // 63 bytes rather than 64
    assert.equal(await verifyEventSignature(secret, 'ab'.repeat(63), '1', body), false);
  });
});

describe('callback URL validation (op 13)', () => {
  test('the response signs event_ts + plain_token in that order', async () => {
    const secret = 'validation-secret';
    const plainToken = 'Arq0J4CwDEtCzXgP';
    const eventTs = '1700000000';

    const res = await buildValidationResponse(secret, plainToken, eventTs);
    assert.equal(res.plain_token, plainToken);
    assert.match(res.signature, /^[0-9a-f]{128}$/, 'signature must be 64 bytes of hex');

    // reconstruct what QQ itself would verify
    const signer = await createSigner(secret);
    const expected = bytesToHex(await signer.sign(new TextEncoder().encode(eventTs + plainToken)));
    assert.equal(res.signature, expected);
  });

  test('swapping the concatenation order produces a different signature', async () => {
    // Guards against the ordering being "accidentally right" for symmetric inputs.
    const a = await buildValidationResponse('s', 'AAA', '111');
    const b = await buildValidationResponse('s', '111', 'AAA');
    assert.notEqual(a.signature, b.signature);
  });
});

describe('runtime capability probe', () => {
  test('reports at least one working import route, and agrees with createSigner', async () => {
    const probe = await probeVerificationSupport();
    assert.ok(probe.preferred !== null, `no Ed25519 import route available: ${probe.detail.join('; ')}`);

    const signer = await createSigner('capability-check');
    const message = new TextEncoder().encode('round-trip');
    const sig = await signer.sign(message);
    assert.equal(sig.length, 64);

    // signer.verify must actually accept its own signature — this is the property the
    // webhook depends on, and the naive "verify with the private key" route fails it.
    assert.equal(await signer.verify(message, sig), true, 'signer rejected its own signature');

    if (signer.strategy === 'pkcs8-derived-pub') assert.equal(probe.derivedPublicKey, true);
    if (signer.strategy === 'node-raw') assert.equal(probe.nodeRaw, true);
  });

  test('verify rejects a signature from a different key', async () => {
    const a = await createSigner('secret-a');
    const b = await createSigner('secret-b');
    const message = new TextEncoder().encode('payload');
    const sigA = await a.sign(message);
    assert.equal(await a.verify(message, sigA), true);
    assert.equal(await b.verify(message, sigA), false, 'a foreign signature was accepted');
  });
});
