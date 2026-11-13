// Pins the requested meat-collection policy: every detected icon is collected, 20% faster
// than the original pacing, and three out of four cycles sweep (drag) instead of clicking
// one by one. Guards against a later edit quietly restoring the anti-bot run skips.
const shim = require('./shim.cjs');

const T = shim.load('meat.js', '{ CONFIG }', (sb) => {
  sb.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
});

const C = T.CONFIG;

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

assert(C.collectMode === 'mixed', `drags by default and clicks the rest (mode: ${C.collectMode})`);
// 75% drag / 25% click: the drift band averages 0.75, so the split holds across a session
// without being the same constant every cycle.
const dragShare = (C.mixedDragChanceMin + C.mixedDragChanceMax) / 2;
assert(Math.abs(dragShare - 0.75) < 0.03,
  `three of four cycles sweep (drag share ~${dragShare.toFixed(2)})`);
assert(C.skipCycleChance === 0, `never skips a run (skipCycleChance: ${C.skipCycleChance})`);
assert(C.clickRatioMin === 1 && C.clickRatioMax === 1,
  `clicks every detected icon (ratio: ${C.clickRatioMin}-${C.clickRatioMax})`);

// 20% faster: the click pause and the cursor travel both shrank to 80% of the old
// 1200-2500 ms and 90-700 ms.
assert(C.clickDelayMin === 960 && C.clickDelayMax === 2000,
  `click pause is 20% shorter (${C.clickDelayMin}-${C.clickDelayMax} ms)`);
assert(C.moveMinMs === 72 && C.moveMaxMs === 560,
  `cursor travel is 20% shorter (${C.moveMinMs}-${C.moveMaxMs} ms)`);
