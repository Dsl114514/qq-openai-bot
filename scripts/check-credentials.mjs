// Guard: no credential may reach the repository, and no plaintext secret may sit in a shareable path.
//
// WHY THIS EXISTS. `ADMIN_PASSWORD` was found in plaintext in `.dev.vars` and `.dryrun/ap.txt`. Both are
// gitignored, so nothing reached the repository — the guard against that already worked. What did NOT exist
// was any check that a secret is where it belongs: the files are correct-by-convention, and convention is
// exactly what fails the first time someone copies a config, adds a new credential, or pastes a value into a
// document to share.
//
// So this checks three things the repository can actually verify:
//
//   1. a known secret value does not appear in any TRACKED file (the leak that would be permanent);
//   2. the files that legitimately hold secrets are still ignored by git;
//   3. no source file or script writes a credential into a response body or a log line.
//
// It NEVER prints a secret: only a fingerprint and a location, so running the check cannot become the leak.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** Files that legitimately hold secrets. All must be gitignored. */
const SECRET_FILES = ['.dev.vars', '.env', '.dryrun/ap.txt', '.dryrun/ak.txt', '.dryrun/qq-creds.json'];

/** Read a secret without exposing it. Returns null when the file is absent. */
function readSecret(path) {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, 'utf8').trim();
  return value ? value : null;
}

const problems = [];
const notes = [];
const log = (s) => console.log(s);

log('\n\x1b[1mCredential exposure guard\x1b[0m\n');

// ── collect the secrets that exist locally ────────────────────────────────────────────────────────────
const secrets = [];
for (const file of SECRET_FILES) {
  const value = readSecret(file);
  if (value) secrets.push({ file, value });
}

// `.dev.vars` holds KEY=value lines, so each value is a separate secret.
let devVarsValues = [];
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
    // Skip a placeholder rather than treating "changeme" as a secret that must not appear anywhere.
    if (m && !/^(changeme|xxx+|your-.*|placeholder|<.*>)$/i.test(m[2].trim())) {
      devVarsValues.push({ key: m[1], value: m[2].trim() });
    }
  }
}

/**
 * Every secret inside a JSON credential file is scanned individually.
 *
 * The first version treated `.dryrun/qq-creds.json` as ONE string (the whole JSON document). Comparing that
 * against tracked files can only catch a byte-for-byte copy of the file — it misses the AppSecret when it is
 * pasted into a README, a curl command, or an issue report, which is how an AppSecret actually leaks. So the
 * JSON is walked and each string value becomes its own secret to scan.
 */
if (existsSync('.dryrun/qq-creds.json')) {
  try {
    const creds = JSON.parse(readFileSync('.dryrun/qq-creds.json', 'utf8'));
    for (const [key, value] of Object.entries(creds)) {
      // NOT every string in a credential file is a secret: `appId` is a PUBLIC identifier (it names which
      // bot app is talking to the API, analogous to an OAuth client_id), and it legitimately appears in
      // documentation and test fixtures. Only the key material — `appSecret` — must stay out of tracked files.
      const isSecretKey = /secret|token|password|key$/i.test(key);
      if (isSecretKey && typeof value === 'string' && value.length >= 8) {
        secrets.push({ file: `.dryrun/qq-creds.json#${key}`, value });
      }
    }
  } catch {
    notes.push('qq-creds.json is not valid JSON; its values were not scanned');
  }
}

log('  secrets found locally (values never printed):');
if (devVarsValues.length > 0) {
  for (const { key, value } of devVarsValues) {
    log(`    .dev.vars ${key} → ${fingerprint(value)} (${value.length} chars)`);
  }
} else {
  log('    (none in .dev.vars)');
}
for (const { file, value } of secrets) {
  if (file.startsWith('.dryrun/')) log(`    ${file} → ${fingerprint(value)} (${value.length} chars)`);
}
log('');

// ── 1. a secret must not be in a tracked file ─────────────────────────────────────────────────────────
log('  tracked-file scan');

/**
 * EVERY secret is scanned, not just the ones from `.dev.vars`.
 *
 * The first version of this check iterated only `devVarsValues`, which meant the QQ AppSecret in
 * `.dryrun/qq-creds.json` was never compared against tracked files at all — a guard with a hole in exactly
 * the place a secret is most likely to be copied out of (an AppSecret gets pasted into curl commands and
 * issue reports far more often than a password does).
 */
const allSecrets = [
  ...devVarsValues,
  ...secrets
    .filter(({ file }) => !file.startsWith('.dev.vars'))
    .map(({ file, value }) => ({ key: file, value })),
];

let trackedLeak = false;
try {
  // `git ls-files` lists what would be committed — the working tree is not enough, because a file could be
  // ignored while an identical value still sits in a tracked one.
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const candidates = tracked.filter(
    (f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|wasm|map)$/i.test(f) && (statSync(f, { throwIfNoEntry: false })?.size ?? 0) < 2_000_000,
  );

  for (const { key, value } of allSecrets) {
    // A very short value would match ordinary text everywhere, producing noise instead of a finding.
    if (value.length < 8) continue;

    for (const file of candidates) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes(value)) {
        problems.push(`${file} contains the value of ${key} (${fingerprint(value)}) — this would be committed`);
        trackedLeak = true;
      }
      // A base64 form defeats a plaintext scan, and an Authorization header is exactly where it appears.
      const b64 = Buffer.from(`admin:${value}`).toString('base64');
      if (text.includes(b64)) {
        problems.push(`${file} contains the BASE64 form of ${key} (${fingerprint(value)})`);
        trackedLeak = true;
      }
    }
  }
  if (!trackedLeak) {
    log(`    \x1b[32m✓\x1b[0m none of ${allSecrets.length} local secrets appears in ${candidates.length} tracked files`);
  }
} catch (e) {
  notes.push(`could not run the tracked-file scan: ${e instanceof Error ? e.message : String(e)}`);
}

// ── 2. the secret-holding files must still be ignored ─────────────────────────────────────────────────
log('\n  ignore rules');
for (const file of SECRET_FILES) {
  if (!existsSync(file)) continue;
  let ignored = false;
  try {
    // Exit 0 means "ignored". `--no-index` makes this work for untracked paths too.
    execFileSync('git', ['check-ignore', '--no-index', '-q', file], { stdio: 'ignore' });
    ignored = true;
  } catch {
    ignored = false;
  }
  if (ignored) log(`    \x1b[32m✓\x1b[0m ${file} is ignored by git`);
  else problems.push(`${file} holds a secret but is NOT gitignored — it will be committed`);
}

// ── 3. no source may echo a credential ────────────────────────────────────────────────────────────────
log('\n  source scan (credentials must not be returned or logged)');
const suspicious = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'web/dist', 'web/build-test', '.wrangler', '.dryrun'].includes(entry.name)) continue;
      walk(p);
    } else if (/\.(ts|vue|mjs)$/.test(entry.name)) {
      suspicious.push(p);
    }
  }
};
walk('.');
walk('src');
walk('scripts');
walk('web/src');

// Reading a secret is fine — it is RETURNING it that leaks. So this looks for a credential name inside a
// response body, a log argument, or an object that is sent to a client.
const LEAK_PATTERNS = [
  /Response\.json\([^)]*ADMIN_PASSWORD/,
  /Response\.json\([^)]*ACCESS_KEY\b(?!.*fingerprint)/,
  /console\.(log|error)\([^)]*(ADMIN_PASSWORD|ACCESS_KEY)\s*[,)]/,
  /new Response\([^)]*ADMIN_PASSWORD/,
  /headers\.set\([^)]*,\s*(ADMIN_PASSWORD|ACCESS_KEY)\s*\)/,
  /body:\s*JSON\.stringify\([^)]*(ADMIN_PASSWORD|ACCESS_KEY)\s*[,)}]/,
];
let sourceHits = 0;
for (const file of [...new Set(suspicious)]) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of LEAK_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${relative('.', file)}:${line} appears to return or log a credential`);
      sourceHits++;
    }
  }
}
if (sourceHits === 0) log(`    \x1b[32m✓\x1b[0m no credential is returned or logged in ${new Set(suspicious).size} source files`);

// ── report ────────────────────────────────────────────────────────────────────────────────────────────
log('');
for (const n of notes) log(`  \x1b[33m·\x1b[0m ${n}`);
if (problems.length === 0) {
  log('  \x1b[32m✓ no credential exposure found\x1b[0m\n');
  process.exit(0);
}
for (const p of problems) log(`  \x1b[31m✗\x1b[0m ${p}`);
log('\n  A credential in a tracked file is permanent in history — rotate it, do not just delete the file.\n');
process.exit(1);
