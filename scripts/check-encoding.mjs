// Check every text file for mojibake.
//
// WHY THIS EXISTS: twice during development, a PowerShell text rewrite round-tripped
// non-ASCII through the console's GBK code page and silently corrupted file contents — an em
// dash became U+9225 + "?", and the Chinese audit marker became four unrelated characters.
// `tsc` and the test suite did not catch it; it surfaced as a syntax error in one case and as
// a visibly broken page title in another.
//
// PowerShell's own redirection and Set-Content are the usual culprits on Windows. The safe
// patterns are the edit/write tools, or Node with an explicit utf8 encoding — never a shell
// pipeline. This check makes a regression loud.
//
// WHAT IT DOES NOT DO: it does not flag Chinese text. src/admin/ui.ts and the QQ notices are
// deliberately Chinese-facing, so all CJK is legitimate content. Only the specific byte
// sequences that GBK misreading produces are reported.
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.dryrun', '_audit', '.probe', 'spike', '.wrangler', 'dist']);
const TEXT_EXT = new Set(['.ts', '.mjs', '.js', '.md', '.toml', '.json', '.sh', '.txt', '.html', '.css']);

// Sequences that only appear when UTF-8 has been decoded as GBK and re-encoded. These are
// the exact characters observed in the two real corruption incidents.
//
// This file is skipped by the scan: it necessarily CONTAINS these characters as data, and
// reporting itself would make the check useless.
const MOJIBAKE = [
  '\u9225', // 鈥  — the em dash / ellipsis damage
  '\u7039', // 瀹  — part of the damaged audit marker
  '\u6ff9', // 滿
  '\u9359', // 鍙
  '\u9429', // 鑩
  '\u7e94', // 縔
  '\ue178', // private-use artefact seen in the damaged marker
];

const SELF = join('.', 'scripts', 'check-encoding.mjs');

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (TEXT_EXT.has(extname(entry.name))) files.push(p);
  }
};
walk('.');

let problems = 0;
let scanned = 0;

for (const file of files) {
  if (file === SELF) continue; // see the note on MOJIBAKE
  scanned++;

  const text = readFileSync(file, 'utf8');
  for (const marker of MOJIBAKE) {
    if (!text.includes(marker)) continue;
    const cp = marker.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    // Show the surrounding context so the damage is locatable, not just detectable.
    const at = text.indexOf(marker);
    const context = text.slice(Math.max(0, at - 30), at + 30).replace(/\n/g, '\\n');
    console.log(`  MOJIBAKE  ${file}`);
    console.log(`            U+${cp} at offset ${at}: ...${context}...`);
    problems++;
  }
}

console.log(problems === 0 ? `\n  ${scanned} text files clean\n` : `\n  ${problems} corruption(s) in ${scanned} files\n`);
process.exit(problems === 0 ? 0 : 1);
