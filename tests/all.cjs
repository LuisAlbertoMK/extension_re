// Runs every test file in this directory and fails if any of them fails.
// Usage: node tests/all.cjs   (or `npm test`)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['shim.cjs', 'frames.cjs', 'all.cjs']);
const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.cjs') && !SKIP.has(f))
  .sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`\nFAIL ${f}\n`); }
}

console.log(`\n${files.length} test files, ${failed} failed`);
process.exit(failed ? 1 : 0);
