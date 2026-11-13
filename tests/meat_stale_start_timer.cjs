// Regression: a restart while a cycle is still in flight must not leave the previous
// start-delay timer armed. When it fires during the idle gap it starts an extra cycle
// next to the one already scheduled, so the module runs at double cadence.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

let captureCalls = 0;
let firstGate = null;

function frame(n, y0) {
  const w = 1600, h = 900;
  const { d } = base(w, h, 11);
  for (let k = 0; k < n; k++) {
    const x = 60 + k * 120;
    rect(d, w, x, y0, 30, 30, 245, 245, 245);
    rect(d, w, x + 9, y0 + 9, 12, 12, 190, 45, 40);
  }
  return { w, h, data: d };
}

const T = shim.load('meat.js', '{ start, stop, CONFIG }', (sb) => {
  sb.__SRToolkit = {
    show() {}, register() {}, hasOverlay: () => false, captureFormat: 'jpeg',
    captureClean() {
      captureCalls++;
      // Hold the very first capture so the test can restart while that cycle is busy.
      if (captureCalls === 1) {
        return new Promise((resolve) => { firstGate = () => resolve({ dataUrl: 'shot' }); });
      }
      return Promise.resolve({ dataUrl: 'shot' });
    },
    input: {
      moveTo: async () => {}, drag: async () => true, click: async () => true,
      get position() { return { x: 800, y: 450 }; },
    },
  };
});

Object.assign(T.CONFIG, {
  startDelayMin: 0, startDelayMax: 0,
  minDelay: 1000, maxDelay: 1000, dragMinDelay: 1000, dragMaxDelay: 1000,
  clickDelayMin: 0, clickDelayMax: 0, distractionChance: 0, runPauseChance: 0,
  skipCycleChance: 0, preClickDelayMin: 0, preClickDelayMax: 0, clickRatioMin: 1, clickRatioMax: 1,
  moveMinMs: 0, moveMaxMs: 0, clickJitter: 0,
  collectMode: 'click',
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  shim.CUR = frame(4, 200);
  T.start();
  await wait(20);
  T.stop();
  // Restart with a start delay while the first cycle is still parked on its capture.
  Object.assign(T.CONFIG, { startDelayMin: 200, startDelayMax: 200 });
  T.start();
  if (firstGate) firstGate();
  await wait(300);

  const ok = captureCalls === 1;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + `a stale start timer does not add a cycle (${captureCalls} captures, want 1)`);
  if (!ok) process.exitCode = 1;
  T.stop();
  await wait(50);
})();
