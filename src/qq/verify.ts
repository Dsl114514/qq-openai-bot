/**
 * QQ official Agent-channel callback verification.
 *
 * Two things have to be checked on every event, and both are Ed25519:
 *
 *   1. Callback URL validation (op 13). QQ POSTs `{op:13, d:{plain_token, event_ts}}` and
 *      expects `{plain_token, signature}` back, where the signed message is
 *      `event_ts + plain_token`. Without a correct answer the URL cannot be registered.
 *
 *   2. Ordinary events. QQ sends `X-Signature-Ed25519` and `X-Signature-Timestamp`
 *      headers; the signed message is `timestamp + raw_body`. The raw body is required —
 *      re-serialising the parsed JSON changes bytes and breaks the signature.
 *
 * THE AWKWARD PART
 * QQ's "Bot Secret" is not a 32-byte seed and not a PEM key: it is an arbitrary ASCII
 * string that both sides expand to 32 bytes by REPEATING it until it fills 32 bytes.
 * That is not a standard key format, so it cannot be handed straight to WebCrypto's
 * Ed25519 import. Two routes exist, tried in order:
 *
 *   A. Wrap the expanded seed in a PKCS#8 envelope (the DER prefix is fixed for Ed25519)
 *      and import as `pkcs8`. This is standards-shaped and is what we prefer.
 *   B. Fall back to the non-standard `NODE-ED25519` algorithm with `raw` format, which
 *      Workers historically support for exactly this shape of key.
 *
 * Which one a given runtime accepts is NOT something the documentation settles, so
 * `probeVerificationSupport` reports it empirically and the admin view surfaces the
 * answer. Guessing here would produce a webhook that silently rejects every event.
 */

/** DER prefix for a PKCS#8-wrapped Ed25519 private key (RFC 8410). */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Expand a QQ Bot Secret to the 32-byte seed both sides use. */
export function expandSecret(secret: string): Uint8Array {
  if (secret.length === 0) throw new Error('bot secret is empty');
  const seed = new Uint8Array(32);
  const bytes = new TextEncoder().encode(secret);
  for (let i = 0; i < 32; i++) seed[i] = bytes[i % bytes.length];
  return seed;
}

function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out;
}

export type ImportStrategy = 'pkcs8-derived-pub' | 'node-raw';

export interface Signer {
  sign(message: Uint8Array): Promise<Uint8Array>;
  verify(message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  strategy: ImportStrategy;
}

/**
 * Build an Ed25519 signer/verifier from a QQ Bot Secret.
 *
 * MEASURED RUNTIME BEHAVIOUR (this is why the code looks like this rather than the
 * obvious one-liner):
 *
 *   - `importKey('pkcs8', ..., {name:'Ed25519'}, ..., ['sign'])`  -> works
 *   - `importKey('pkcs8', ..., ..., ['verify'])`                  -> "Unsupported key
 *     usage for a Ed25519 key". A private key may NOT carry `verify`, so the tempting
 *     "import the seed and verify with it" route is simply unavailable.
 *   - `importKey('raw', seed, {name:'NODE-ED25519'})`             -> "Unrecognized
 *     algorithm name" on Node's WebCrypto. It is a Workers-only extension, so it must
 *     not be the primary path.
 *   - `exportKey('jwk', privateKey)`                              -> works, and INCLUDES
 *     the public `x`. Re-importing `{kty:'OKP',crv:'Ed25519',x}` as a public key and
 *     verifying with it round-trips successfully.
 *
 * So the working recipe is: import the seed for signing, derive the public key from the
 * exported JWK, and verify with that.
 */
export async function createSigner(secret: string): Promise<Signer> {
  const seed = expandSecret(secret);
  const failures: string[] = [];

  try {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8FromSeed(seed) as BufferSource,
      { name: 'Ed25519' },
      // extractable, because the public half is only reachable through exportKey
      true,
      ['sign'],
    );
    const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
    if (!jwk.x) throw new Error('exported JWK has no public `x` component');
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return {
      strategy: 'pkcs8-derived-pub',
      async sign(message) {
        return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message as BufferSource));
      },
      async verify(message, signature) {
        return crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature as BufferSource, message as BufferSource);
      },
    };
  } catch (e) {
    failures.push(`pkcs8->derive-public: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Workers-only fallback. Kept because it may be the faster route in the runtime that
  // actually serves this Worker, but it is never assumed to exist.
  try {
    const alg = { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as never;
    const key = await crypto.subtle.importKey('raw', seed as BufferSource, alg, false, ['sign', 'verify']);
    return {
      strategy: 'node-raw',
      async sign(message) {
        return new Uint8Array(await crypto.subtle.sign(alg, key, message as BufferSource));
      },
      async verify(message, signature) {
        return crypto.subtle.verify(alg, key, signature as BufferSource, message as BufferSource);
      },
    };
  } catch (e) {
    failures.push(`NODE-ED25519 raw: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(
    `no usable Ed25519 import path for the QQ bot secret. Neither route worked, so every ` +
      `incoming event would be rejected. Failures: ${failures.join('; ')}`,
  );
}

const hexToBytes = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Verify an incoming event's signature.
 *
 * `rawBody` must be the exact bytes received. `JSON.stringify(JSON.parse(body))` is not a
 * substitute: key order and whitespace are part of the signed payload, so re-serialising
 * silently invalidates every signature.
 */
export async function verifyEventSignature(
  secret: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);
  if (signature.length !== 64) return false;
  try {
    const signer = await createSigner(secret);
    return await signer.verify(new TextEncoder().encode(timestamp + rawBody), signature);
  } catch {
    // createSigner already reports why; here the only safe answer is "not verified".
    return false;
  }
}

/** The `op 13` callback-validation response body. */
export async function buildValidationResponse(
  secret: string,
  plainToken: string,
  eventTs: string,
): Promise<{ plain_token: string; signature: string }> {
  const signer = await createSigner(secret);
  const message = new TextEncoder().encode(eventTs + plainToken);
  return { plain_token: plainToken, signature: bytesToHex(await signer.sign(message)) };
}

/**
 * Report which import path this runtime actually supports.
 *
 * The admin view surfaces the result, because a webhook that rejects every event looks
 * identical to a webhook receiving no events, and the difference matters when diagnosing.
 */
export async function probeVerificationSupport(): Promise<{
  derivedPublicKey: boolean;
  nodeRaw: boolean;
  preferred: ImportStrategy | null;
  detail: string[];
}> {
  const detail: string[] = [];
  const seed = expandSecret('probe-secret-for-capability-check');
  const message = new TextEncoder().encode('probe');
  let derivedPublicKey = false;
  let nodeRaw = false;

  try {
    const priv = await crypto.subtle.importKey('pkcs8', pkcs8FromSeed(seed) as BufferSource, { name: 'Ed25519' }, true, ['sign']);
    const jwk = (await crypto.subtle.exportKey('jwk', priv)) as JsonWebKey;
    if (!jwk.x) throw new Error('exported JWK has no `x`');
    const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, message as BufferSource);
    derivedPublicKey = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, message as BufferSource);
    detail.push(derivedPublicKey ? 'pkcs8 + derived public jwk: round-trip ok' : 'derived public key refused its own signature');
  } catch (e) {
    detail.push(`pkcs8 + derived public jwk unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const alg = { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as never;
    const key = await crypto.subtle.importKey('raw', seed as BufferSource, alg, false, ['sign', 'verify']);
    const sig = await crypto.subtle.sign(alg, key, message as BufferSource);
    nodeRaw = await crypto.subtle.verify(alg, key, sig, message as BufferSource);
    detail.push(nodeRaw ? 'NODE-ED25519 raw: round-trip ok' : 'NODE-ED25519 raw: verify rejected its own signature');
  } catch (e) {
    detail.push(`NODE-ED25519 raw unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    derivedPublicKey,
    nodeRaw,
    preferred: derivedPublicKey ? 'pkcs8-derived-pub' : nodeRaw ? 'node-raw' : null,
    detail,
  };
}

export { bytesToHex, hexToBytes };
