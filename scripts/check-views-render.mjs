/**
 * Render every view once and report which ones throw.
 *
 * Run after `npm run build:web`, which also produces the SSR bundle this executes
 * (`web/dist/ssr/render-check.js`). See web/src/render-check.ts for why this exists: a template that
 * references an undefined name throws during render, and a thrown render blanks the view with no visible
 * error — which is how `{{ location.origin }}` in QqView presented as "the QQ page does not display".
 */
import { existsSync, statSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const bundle = resolve('web/build-test/render-check.js');

console.log('\n\x1b[1mView render check\x1b[0m\n');

if (!existsSync(bundle)) {
  console.log(`  \x1b[31m✗\x1b[0m SSR bundle missing: ${bundle}`);
  console.log('    Run `npm run build:web` first (it builds both the client and this check).\n');
  process.exit(1);
}

/**
 * Refuse to check a STALE bundle.
 *
 * This is not hypothetical: during development a source edit broke the build, the SSR bundle was never
 * regenerated, and this script happily reported "all views render" against the PREVIOUS bundle — a green
 * result that proved nothing. A verification tool that passes on outdated output is worse than no tool,
 * because it reports success for code that was never compiled.
 */
const newestSource = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(vue|ts)$/.test(name.name)) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk('web/src');
  return newest;
})();

if (newestSource > statSync(bundle).mtimeMs) {
  const ageS = Math.round((newestSource - statSync(bundle).mtimeMs) / 1000);
  console.log(`  \x1b[31m✗\x1b[0m the SSR bundle is STALE (${ageS}s older than web/src)`);
  console.log('    A source change did not reach the bundle, so this check would report on old code.');
  console.log('    Run `npm run build:web` (it builds the SSR bundle too) and try again.\n');
  process.exit(1);
}

let results;
try {
  const mod = await import(pathToFileURL(bundle).href);
  results = await mod.renderAll();
} catch (e) {
  console.log(`  \x1b[31m✗\x1b[0m could not load the SSR bundle: ${e.message}\n`);
  process.exit(1);
}

let failures = 0;
for (const r of results) {
  if (r.ok) {
    // A view that renders zero bytes is as broken as one that throws — it just fails quietly.
    const empty = r.length < 50;
    if (empty) failures++;
    console.log(
      `  ${empty ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'} ${r.name.padEnd(14)} ${String(r.length).padStart(6)} bytes${empty ? '  (rendered nothing)' : ''}`,
    );
  } else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${r.name.padEnd(14)} THREW: ${r.error}`);
  }
}

console.log('');
if (failures === 0) {
  console.log(`  \x1b[32m✓ all ${results.length} views render\x1b[0m\n`);
  process.exit(0);
}
console.log(`  ${failures} view(s) failed. A template name is not resolved against globals —`);
console.log('  `{{ location.origin }}` is undefined, not the browser location, and throws.\n');
process.exit(1);
