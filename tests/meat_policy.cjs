// Pins the requested meat-collection policy: every detected icon, clicked one by one,
// 20% faster than the original pacing. Guards against a later edit quietly restoring
// the anti-bot skips (12% of runs) or the mixed drag mode.
const shim = require('./shim.cjs');

const T = shim.load('meat.js', '{ CONFIG }', (sb) => {
  sb.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
});

const C = T.CONFIG;

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

assert(C.collectMode === 'click', `clicks one by one (mode: ${C.collectMode})`);
assert(C.skipCycleChance === 0, `never skips a run (skipCycleChance: ${C.skipCycleChance})`);
assert(C.clickRatioMin === 1 && C.clickRatioMax === 1,
  `clicks every detected icon (ratio: ${C.clickRatioMin}-${C.clickRatioMax})`);

// 20% faster: the click pause and the cursor travel both shrank to 80% of the old
// 1200-2500 ms and 90-700 ms.
assert(C.clickDelayMin === 960 && C.clickDelayMax === 2000,
  `click pause is 20% shorter (${C.clickDelayMin}-${C.clickDelayMax} ms)`);
assert(C.moveMinMs === 72 && C.moveMaxMs === 560,
  `cursor travel is 20% shorter (${C.moveMinMs}-${C.moveMaxMs} ms)`);
