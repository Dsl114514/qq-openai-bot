// Reproduce ensureSchema's statement splitting locally, without needing D1.
//
// ensureSchema does `SCHEMA.split(';')` and hands every non-empty fragment to db.batch().
// The SCHEMA constant contains SQL comments, and a comment can contain a semicolon — which
// would make the split produce a malformed fragment. This checks whether that is what is
// breaking the deployed Worker.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/db/store.ts', import.meta.url), 'utf8');

// Pull the SCHEMA template literal out of the source.
const match = src.match(/export const SCHEMA = `([\s\S]*?)`;/);
if (!match) {
  console.error('could not find the SCHEMA constant');
  process.exit(1);
}
const schema = match[1];

console.log('\n\x1b[1mStatements produced by the current split(\x27;\x27) logic\x1b[0m\n');
const fragments = schema
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

let suspicious = 0;
fragments.forEach((f, i) => {
  const oneLine = f.replace(/\s+/g, ' ');
  // A well-formed statement starts with DDL/DML. Anything starting with a comment marker or
  // containing a stray comment is suspect.
  const startsOk = /^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|PRAGMA)/i.test(f);
  const hasComment = /--/.test(f);
  const flag = !startsOk || hasComment ? '  \x1b[31m<-- SUSPECT\x1b[0m' : '';
  if (flag) suspicious++;
  console.log(`  [${i}] ${oneLine.slice(0, 110)}${oneLine.length > 110 ? '…' : ''}${flag}`);
});

console.log(`\n  total fragments: ${fragments.length}`);
console.log(`  suspicious:      ${suspicious}`);

// Show exactly what a comment-with-semicolon does.
console.log('\n\x1b[1mDemonstration\x1b[0m');
const demo = '-- a comment; with a semicolon\nCREATE TABLE t (a INT);';
console.log('  input:  ' + JSON.stringify(demo));
console.log('  split:  ' + JSON.stringify(demo.split(';').map((s) => s.trim()).filter(Boolean)));

process.exit(suspicious > 0 ? 1 : 0);
