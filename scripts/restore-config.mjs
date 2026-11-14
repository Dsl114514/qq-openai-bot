// Restore a config value without letting a shell mangle the JSON.
//
// The first attempt used `wrangler d1 execute --command "INSERT ... '{"enabled":true}'"` and the
// stored value came back as `{enabled:true,...}` — the double quotes were consumed by PowerShell, so
// an INVALID JSON document was written. It would parse-fail on read and be treated as "feature off",
// which is the same silent failure this project keeps running into.
//
// The fix is to build the statement here and pass it as a single argument, with no shell quoting
// layer in between.
import { execFileSync } from 'node:child_process';

const GROUP = 'AC4FBFFF8A2C43F360F6A5B3D06DCB81';
const CONFIG = { enabled: true, perDay: 1, mode: 'random', text: '冒泡' };

const run = (sql) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'cf-ds-api-qq-bot', '--remote', '-y', '--json', '--command', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
  )[0]?.results ?? [];

// SQL string literals escape a single quote by doubling it; JSON needs no other escaping here.
const json = JSON.stringify(CONFIG);
const literal = json.replace(/'/g, "''");
const key = `interject_config:${GROUP}`;

run(
  `INSERT INTO app_state (key, value) VALUES ('${key}', '${literal}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

console.log('\n=== stored value ===');
const rows = run(`SELECT value FROM app_state WHERE key = '${key}'`);
const stored = rows[0]?.value;
console.log(`  ${stored}`);

// The decisive check: it must PARSE. A value that merely looks right but fails JSON.parse would be
// read as "no config" and the feature would silently stay off.
let ok = false;
try {
  const parsed = JSON.parse(stored);
  ok = parsed.enabled === true && parsed.text === '冒泡';
  console.log(`  parses: YES  enabled=${parsed.enabled} perDay=${parsed.perDay} mode=${parsed.mode} text=${parsed.text}`);
} catch (e) {
  console.log(`  parses: NO — ${e.message}`);
}
console.log(ok ? '\n  => config is valid and will be used.\n' : '\n  => config is INVALID.\n');
process.exit(ok ? 0 : 1);
