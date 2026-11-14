// Rotate the admin password.
//
// WHAT WENT WRONG: `ADMIN_PASSWORD` sat in plaintext in two files on disk — `.dev.vars` (what
// `wrangler dev` reads) and `.dryrun/ap.txt` (what the verification scripts read). Both are gitignored
// and untracked, so nothing reached the repository, but a plaintext credential in a scratch directory is
// still a credential that leaks with one careless copy, paste, or screen share.
//
// This script does the rotation end to end and NEVER PRINTS THE SECRET. It reports lengths and
// fingerprints only, so running it cannot itself become the next leak. That is also why it captures the
// old value first and verifies it now FAILS: a rotation that only changes the file is not a rotation.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const WORKER = 'cf-ds-api-qq-bot';
const BASE = 'https://qq.hacknet.de5.net';
const AP_FILE = '.dryrun/ap.txt';
const DEV_VARS = '.dev.vars';

/** A short, non-reversible label so a password can be identified without being displayed. */
const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/**
 * Generate a password that is both strong and safe to embed in an HTTP header.
 *
 * ALPHANUMERIC ONLY, deliberately. The value travels in `Authorization: Basic <base64>`, and while base64
 * handles arbitrary bytes, a password containing quotes, backslashes or `:` makes every shell one-liner,
 * `.env` parser and PowerShell invocation that touches it a new opportunity for a quoting bug — which is how
 * credentials end up in the wrong place. 32 alphanumerics is ~190 bits, far beyond any practical attack.
 */
function generate() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const out = [];
  // Rejection sampling so the modulo does not bias the first characters of the alphabet.
  const limit = 256 - (256 % alphabet.length);
  while (out.length < 32) {
    for (const byte of randomBytes(64)) {
      if (byte >= limit) continue;
      out.push(alphabet[byte % alphabet.length]);
      if (out.length === 32) break;
    }
  }
  return out.join('');
}

const log = (s) => console.log(s);

// ── 1. capture what is there now, so the old value can be proven dead afterwards
const oldPassword = existsSync(AP_FILE) ? readFileSync(AP_FILE, 'utf8').trim() : '';
if (!existsSync(AP_FILE)) {
  log(`  \x1b[33m·\x1b[0m ${AP_FILE} not found — capturing the old value from the Worker is not possible`);
}
log(`\n\x1b[1mRotating ADMIN_PASSWORD\x1b[0m`);
log(`  old fingerprint: ${oldPassword ? fingerprint(oldPassword) : '(none on disk)'}  length ${oldPassword.length}`);

const next = generate();
log(`  new fingerprint: ${fingerprint(next)}  length ${next.length}`);

// ── 2. set the Worker secret. Fed on STDIN, never as an argument:
// an argument is visible in the process list and in shell history, which is exactly how a "rotated"
// credential leaks a second time.
log(`\n  setting the Worker secret…`);
const put = spawnSync(
  process.execPath,
  ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'ADMIN_PASSWORD', '--name', WORKER],
  { input: next + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
);
if (put.status !== 0) {
  console.error(`  \x1b[31m✗\x1b[0m wrangler secret put failed (exit ${put.status})`);
  console.error(`    stdout: ${(put.stdout ?? '').trim().slice(0, 400)}`);
  console.error(`    stderr: ${(put.stderr ?? '').trim().slice(0, 400)}`);
  process.exit(1);
}
log(`  \x1b[32m✓\x1b[0m Worker secret updated`);

// ── 3. update the local files, preserving every OTHER key in .dev.vars
log(`\n  updating local files…`);
writeFileSync(AP_FILE, next + '\n', 'utf8');
log(`  \x1b[32m✓\x1b[0m ${AP_FILE}`);

if (existsSync(DEV_VARS)) {
  const original = readFileSync(DEV_VARS, 'utf8');
  // Rewritten line by line so ACCESS_KEY and anything else added later survives untouched. A blanket
  // rewrite would be simpler and would also silently drop whatever the next person put in this file.
  let replaced = false;
  const lines = original.split('\n').map((line) => {
    if (/^\s*ADMIN_PASSWORD\s*=/.test(line)) {
      replaced = true;
      return `ADMIN_PASSWORD=${next}`;
    }
    return line;
  });
  if (!replaced) lines.push(`ADMIN_PASSWORD=${next}`);
  writeFileSync(DEV_VARS, lines.join('\n'), 'utf8');
  log(`  \x1b[32m✓\x1b[0m ${DEV_VARS} (other keys preserved)`);
}

// ── 4. a secret added to the Worker does not take effect until the Worker restarts, which a deploy does
log(`\n  redeploying so the new secret is live…`);
const deploy = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const deployed = /Version ID/i.test(deploy.stdout ?? '') || deploy.status === 0;
log(`  ${deployed ? '\x1b[32m✓\x1b[0m deployed' : `\x1b[31m✗\x1b[0m deploy failed: ${(deploy.stderr ?? '').slice(0, 300)}`}`);

// ── 5. PROVE the rotation: the new value must work and the old one must not
const basic = (pw) => 'Basic ' + Buffer.from('admin:' + pw).toString('base64');
async function probe(pw) {
  const res = await fetch(`${BASE}/admin`, { headers: { authorization: basic(pw) }, redirect: 'manual' });
  return res.status;
}

log(`\n  verifying against the live Worker…`);
let newStatus = 0;
let oldStatus = 0;
for (let attempt = 0; attempt < 6; attempt++) {
  newStatus = await probe(next);
  if (oldPassword) oldStatus = await probe(oldPassword);
  if (newStatus === 200) break;
  // Propagation is not instant; retrying is cheaper than reporting a false failure.
  await new Promise((r) => setTimeout(r, 2500));
}

log(`  new password: HTTP ${newStatus}  ${newStatus === 200 ? '\x1b[32m✓ accepted\x1b[0m' : '\x1b[31m✗ NOT accepted\x1b[0m'}`);
if (oldPassword) {
  log(`  old password: HTTP ${oldStatus}  ${oldStatus === 401 ? '\x1b[32m✓ rejected\x1b[0m' : '\x1b[31m✗ STILL WORKS\x1b[0m'}`);
}

const okay = newStatus === 200 && (!oldPassword || oldStatus === 401);
log(`\n${okay ? '\x1b[32m\x1b[1mrotation complete\x1b[0m' : '\x1b[31m\x1b[1mROTATION INCOMPLETE\x1b[0m'}`);
log(`  the new password is in ${AP_FILE} and ${DEV_VARS}; it is NOT printed here.\n`);
process.exit(okay ? 0 : 1);
