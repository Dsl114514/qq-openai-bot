// Guard: no component may rely on Vue's template compiler.
//
// WHY THIS EXISTS. Vite resolves `vue` to the RUNTIME-ONLY build (`vue.runtime.esm-bundler.js`), which
// does not ship the template compiler. A component that passes a `template` STRING therefore mounts
// successfully and renders NOTHING: a blank page, no error in the console, and every server-side check
// still green — the shell returns 200, the bundle returns 200, and the bundle is a valid ES module.
//
// That is exactly what happened: `main.ts` defined the root component with a `template` string, the whole
// console rendered blank, and only finding the uncompiled markup sitting in the built bundle as an unused
// string literal identified it. This check makes that failure impossible to ship again.
//
// Two assertions:
//   1. In SOURCE: no `template:` option in a plain `.ts` entry (SFCs are fine — they are compiled).
//   2. In the BUILD OUTPUT: the runtime-compiler warning string is absent, and the shell's markup appears
//      as compiled render code rather than as a template literal.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const note = (s) => console.log(`  ${s}`);

/** Walk a directory, returning matching files. */
function walk(dir, filter) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter(name)) out.push(p);
  }
  return out;
}

console.log('\n\x1b[1mVue template-compiler guard\x1b[0m\n');

// ── 1. source: `template:` in a .ts file ────────────────────────────────────────────────────────────
console.log('  source check — no `template:` option outside an SFC');
const tsFiles = walk('web/src', (n) => n.endsWith('.ts'));
let sourceHits = 0;
for (const f of tsFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^\s*template\s*:/gm)) {
    // Allow it inside a comment or a string that documents the hazard.
    const line = src.slice(0, m.index).split('\n').pop() ?? '';
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const lineNo = src.slice(0, m.index).split('\n').length;
    problems.push(`${f}:${lineNo} uses a \`template:\` option — runtime-only Vue cannot compile it`);
    sourceHits++;
  }
}
if (sourceHits === 0) note(`\x1b[32m✓\x1b[0m none of ${tsFiles.length} .ts files define a template string`);
note(`  (${walk('web/src', (n) => n.endsWith('.vue')).length} .vue SFCs are compiled at build time — fine)`);

// ── 2. build output ──────────────────────────────────────────────────────────────────────────────
const distDir = 'web/dist/admin/assets';
const jsFiles = walk(distDir, (n) => n.endsWith('.js'));

if (jsFiles.length === 0) {
  note('\x1b[33m·\x1b[0m no build output found — run `npm run build:web` for the output check');
} else {
  console.log('\n  output check — the compiled bundle contains no uncompiled template');
  for (const f of jsFiles) {
    const js = readFileSync(f, 'utf8');

    // The runtime-only build warns when handed a template string. Its presence means a raw template
    // reached runtime and is being silently ignored.
    if (js.includes('runtime compilation is not supported')) {
      problems.push(`${f} contains the runtime-compiler warning — a template string will not render`);
    }

    // A compiled SFC emits a props object (`{class:"app-header"}`) plus many render calls. Minification
    // renames the runtime helpers, and it picks DIFFERENT short names between builds — an earlier version
    // of this check counted `u("` because that is what one build produced, and the next build renamed it,
    // so the check failed on a good bundle. Counting by SHAPE (`name("`) avoids depending on the name.
    const hasPropsObject = /\{\s*class:\s*"[a-z-]+"/.test(js);
    const elementCalls = (js.match(/\b[A-Za-z_$]{1,3}\("/g) ?? []).length;
    const hasRenderCalls = elementCalls > 100 || /\bcreateElementVNode\b/.test(js);
    const hasRender = hasPropsObject && hasRenderCalls;
    if (!hasRender) {
      problems.push(
        `${f} has no recognizable render output (props object: ${hasPropsObject}, element calls: ${elementCalls}) — nothing will be drawn`,
      );
    }

    note(`  ${f}: ${hasRender ? 'render code present' : 'NO RENDER CODE'}, ${js.length} bytes`);
  }

  // The decisive regression check: the shell's own markup must not survive as a template literal. If a
  // future edit reintroduces a `template:` option, the literal `class="app-header"` shows up as a plain
  // string instead of being compiled into createElementVNode calls.
  const bundle = jsFiles.map((f) => readFileSync(f, 'utf8')).join('');
  const templateLiteral = /["'`]\s*<header class=\\?"app-header\\?">/.test(bundle);
  if (templateLiteral) {
    problems.push('the root markup is present as a template LITERAL — the root component is not compiled');
  } else {
    note('  \x1b[32m✓\x1b[0m the shell markup is compiled, not a template literal');
  }
}

console.log('');
if (problems.length === 0) {
  console.log('  \x1b[32m✓ all checks passed\x1b[0m\n');
  process.exit(0);
}
for (const p of problems) console.log(`  \x1b[31m✗\x1b[0m ${p}`);
console.log('\n  Runtime-only Vue renders a component with a `template` string as NOTHING, silently.');
console.log('  Move the component into a .vue file.\n');
process.exit(1);
