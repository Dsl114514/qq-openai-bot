// Guard against verification scripts that destroy real data.
//
// WHY THIS EXISTS: `scripts/verify-markdown-send.mjs` cleaned up after itself with
// `DELETE FROM app_state WHERE key LIKE 'interject%'` — and a user's real "冒泡" configuration
// matched that pattern, so running a verification script silently deleted it. The script reported
// success, and the loss only surfaced later as "the feature stopped working".
//
// A verification script must undo its OWN work and nothing else. A broad pattern cannot tell the row
// it just created from the row that was already there, so this check rejects broad deletes in scripts
// and requires either an exact key or a pattern containing a per-run unique token.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'scripts';
// This file necessarily QUOTES the unsafe pattern as documentation, so it must not scan itself —
// otherwise the guard reports its own explanatory comment. The first version did exactly that.
const SELF = 'check-scripts.mjs';
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== SELF);

let problems = 0;

/** A pattern is safe when it cannot match anything this run did not create. */
function unsafeDelete(statement) {
  // An exact key is inherently scoped, whether it is `key = '…'` or `key IN ('…', '…')`.
  const exactOnly = !/LIKE/i.test(statement);
  if (exactOnly) {
    return /WHERE\s+key\s*(=|IN)/i.test(statement) ? null : 'delete without an exact key';
  }
  const like = statement.match(/WHERE\s+key\s+LIKE\s+'([^']+)'/i);
  if (!like) return 'LIKE delete whose pattern could not be read';
  const pattern = like[1];
  // A per-run token makes the pattern unique to this execution. `stamp`, `Date.now()`, or a UUID
  // interpolated into the pattern all qualify; a bare domain prefix does not.
  const hasRunToken = /\$\{(stamp|runId|nonce|Date\.now\(\))[^}]*\}/.test(pattern);
  if (hasRunToken) return null;
  return `broad pattern "${pattern}" with no per-run token`;
}

console.log('\n\x1b[1mDestructive-statement guard\x1b[0m\n');

for (const file of files) {
  const src = readFileSync(join(dir, file), 'utf8');
  // Strip comments first: a comment that quotes an unsafe statement is documentation, not code, and
  // reporting it makes the guard cry wolf on its own explanation.
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  for (const match of code.matchAll(/DELETE\s+FROM[^`'"]*/gi)) {
    const start = match.index;
    const tail = code.slice(start, start + 400);
    const end = tail.search(/[`'"]\s*[,)]/);
    const statement = end > 0 ? tail.slice(0, end + 1) : tail;
    const reason = unsafeDelete(statement);
    if (reason) {
      console.log(`  \x1b[31m✗\x1b[0m ${file}: ${reason}`);
      console.log(`      ${statement.replace(/\s+/g, ' ').slice(0, 110)}`);
      problems++;
    }
  }
}

if (problems === 0) {
  console.log(`  \x1b[32m✓\x1b[0m all ${files.length} scripts only delete what they created`);
  console.log('    (exact keys, or patterns carrying a per-run token)\n');
} else {
  console.log(`\n  ${problems} unsafe delete(s). A verification script must not be able to remove`);
  console.log('  data it did not create.\n');
}
process.exit(problems === 0 ? 0 : 1);
