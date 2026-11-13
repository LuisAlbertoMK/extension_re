// Start / stop / resume behaviour for the collector loop.
//
// The bug this pins: a cycle that is already in flight when the user presses Stop
// and then Start keeps its own tail. With a plain `if (running) setTimeout(...)` the
// stale tail schedules a second chain next to the one the new Start created, so the
// module runs at double cadence and Stop can no longer kill the extra chain.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

let gates = [];
let captureCalls = 0;
let inFlight = 0;
let peakInFlight = 0;
let clicks = 0;

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

function hudStub() {
  return {
    show() {},
    register() {},
    hasOverlay: () => false,
    captureFormat: 'jpeg',
    // Gated capture: every call parks until the test releases it, so a cycle can be
    // held mid-flight while the test presses Stop and Start.
    captureClean() {
      captureCalls++;
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      return new Promise((resolve) => {
        gates.push(() => { inFlight--; resolve({ dataUrl: 'shot' }); });
      });
    },
    input: {
      moveTo: async () => {},
      drag: async () => true,
      click: async () => { clicks++; return true; },
      get position() { return { x: 800, y: 450 }; },
    },
  };
}

const T = shim.load('meat.js',
  '{ start, stop, CONFIG, stats, dbg: () => ({ running, loopToken, cycleBusy }) }',
  (sb) => { sb.__SRToolkit = hudStub(); });

Object.assign(T.CONFIG, {
  startDelayMin: 0, startDelayMax: 0,
  minDelay: 0, maxDelay: 0, dragMinDelay: 0, dragMaxDelay: 0,
  clickDelayMin: 0, clickDelayMax: 0, distractionChance: 0, runPauseChance: 0,
  skipCycleChance: 0, preClickDelayMin: 0, preClickDelayMax: 0, clickRatioMin: 1, clickRatioMax: 1,
  moveMinMs: 0, moveMaxMs: 0, clickJitter: 0,
  collectMode: 'click',
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Release every parked capture and let the loop settle, so the assertions never race
// the async tail of a cycle.
async function drain(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    const g = gates.shift();
    if (g) g();
    await wait(25);
  }
}

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  shim.CUR = frame(4, 200);

  // --- one cycle at a time --------------------------------------------------
  T.start();
  await wait(20);
  assert(captureCalls === 1, `Start runs one cycle (${captureCalls} capture)`);

  // Stop and Start while that cycle is still waiting for its screenshot.
  T.stop();
  T.start();
  await wait(20);
  assert(peakInFlight === 1, `Stop+Start does not stack a second cycle (${peakInFlight} in flight)`);
  assert(captureCalls === 1, `no extra capture from the restarted loop yet (${captureCalls})`);

  // The held cycle owns the chain: when it ends, exactly one continues.
  await drain();
  assert(captureCalls >= 2, `the loop keeps running after the resume (${captureCalls} captures)`);
  assert(peakInFlight === 1, `still a single chain after the resume (${peakInFlight} peak)`);
  assert(T.dbg().running === true, 'the module is still running after the resume');

  // --- stop really stops ----------------------------------------------------
  T.stop();
  if (gates.length) gates.shift()(); // let the parked cycle finish and try to reschedule
  await wait(80);
  const frozen = captureCalls;
  await wait(80);
  assert(captureCalls === frozen, `Stop halts the chain (${captureCalls - frozen} extra captures)`);
  assert(T.dbg().cycleBusy === false, 'Stop leaves no cycle marked as in flight');

  // --- restart after a stop --------------------------------------------------
  const before = clicks;
  shim.CUR = frame(4, 300);
  T.start();
  await drain();
  assert(captureCalls > frozen, `Start after Stop resumes the loop (${captureCalls - frozen} captures)`);
  assert(clicks > before, `the resumed loop clicks detected icons (${clicks - before})`);
  T.stop();
})();
