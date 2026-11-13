// Verifies the meat click burst: it clicks every detected icon, and it aborts when
// the module is stopped mid-burst or the session cap has expired.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

let clicks = 0, stopAfter = -1, T = null;
const drags = [];

function frame(n, y0) {
  const w = 1600, h = 900;
  const { d } = base(w, h, 3);
  for (let k = 0; k < n; k++) {
    const x = 60 + k * 120;
    rect(d, w, x, y0, 30, 30, 245, 245, 245);
    rect(d, w, x + 9, y0 + 9, 12, 12, 190, 45, 40);
  }
  return { w, h, data: d };
}

T = shim.load(
  'meat.js',
  '{ collectCycle, CONFIG, stats, setRunning(v){ running = v; }, setDeadline(ms){ sessionEndsAt = Date.now() + ms; }, clearHistory(){ clickHistory.length = 0; } }',
  (sb) => {
    sb.__SRToolkit = {
      show() {}, register() {}, hasOverlay: () => false,
      captureClean: () => Promise.resolve({ dataUrl: 'x' }),
      input: {
        moveTo: async () => {},
        drag: async (pts, dur) => { drags.push({ pts: pts.length, dur }); return true; },
        click: async () => {
          clicks++;
          if (stopAfter > 0 && clicks >= stopAfter) T.setRunning(false);
          return true;
        },
        get position() { return { x: 800, y: 450 }; },
      },
    };
  }
);

Object.assign(T.CONFIG, {
  clickDelayMin: 0, clickDelayMax: 0, distractionChance: 0, runPauseChance: 0,
  preClickDelayMin: 0, preClickDelayMax: 0, skipCycleChance: 0,
  clickRatioMin: 1, clickRatioMax: 1, moveMinMs: 0, moveMaxMs: 1, collectMode: 'click',
});

function assert(c, m) {
  console.log((c ? 'PASS  ' : 'FAIL  ') + m);
  if (!c) process.exitCode = 1;
}

(async () => {
  shim.CUR = frame(5, 200);
  clicks = 0; stopAfter = -1;
  T.CONFIG.collectMode = 'click';
  T.setRunning(true); T.setDeadline(60000);
  await T.collectCycle();
  assert(clicks === 5, `clicks every detected icon (${clicks}/5)`);

  shim.CUR = frame(6, 400);
  clicks = 0; stopAfter = 2;
  T.setRunning(true); T.setDeadline(60000);
  await T.collectCycle();
  assert(clicks === 2, `Stop aborts the burst (${clicks} clicks, expected 2)`);

  shim.CUR = frame(5, 600);
  clicks = 0; stopAfter = -1;
  T.setRunning(true); T.setDeadline(-1);
  await T.collectCycle();
  assert(clicks === 0, `expired session does not click (${clicks})`);

  // Drag mode: one gesture over every icon instead of N clicks.
  shim.CUR = frame(7, 700);
  clicks = 0; drags.length = 0;
  T.CONFIG.collectMode = 'drag';
  T.setRunning(true); T.setDeadline(60000);
  await T.collectCycle();
  assert(drags.length === 1, `drag mode issues one gesture (${drags.length})`);
  assert(drags[0] && drags[0].pts > 7, `gesture is densely sampled (${drags[0] && drags[0].pts} points)`);
  assert(drags[0] && drags[0].dur >= 300 && drags[0].dur <= 4000, `gesture duration is clamped (${drags[0] && drags[0].dur} ms)`);
  assert(clicks === 0, `drag mode does not click individually (${clicks})`);

  // Mixed mode must produce both kinds of run, not just one.
  shim.CUR = frame(5, 800);
  T.CONFIG.collectMode = 'mixed';
  T.CONFIG.mixedDragChance = 0.5;
  let d = 0, c = 0;
  for (let i = 0; i < 24; i++) {
    clicks = 0; drags.length = 0;
    T.clearHistory();
    T.setRunning(true); T.setDeadline(60000);
    await T.collectCycle();
    if (drags.length) d++;
    else if (clicks) c++;
  }
  assert(d > 0 && c > 0, `mixed alternates between drag and click (${d} drags / ${c} click runs)`);
})();
