// Wood collector: a villager that never cuts must stop the module, one that does
// must keep it running. The stop is "no clicked tree fell for noCutWindowMs", not a
// per-tree deadline: the queue is FIFO, so a per-tree deadline drifted and tripped a
// false "not cutting" on a healthy villager.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 800, H = 600;
let frameMode = 'trees';   // 'trees' | 'empty' | 'falls'
let clicks = 0;
let scans = 0;

function treeFrame() {
  const { d, r } = base(W, H, 7);
  for (let k = 0; k < 10; k++) {
    const bs = 4 + Math.floor(r() * 14);
    const x = 140 + Math.floor(r() * (W - 320)), y = 160 + Math.floor(r() * (H - 340));
    rect(d, W, x, y, bs, bs, 175, 105, 70);
    rect(d, W, x - 6, y - 12, bs + 12, 12, 60, 150, 60);
    rect(d, W, x - 6, y - 12, bs + 12, 6, 120, 205, 80); // lime highlights
  }
  return { w: W, h: H, data: d };
}

function emptyFrame() {
  const { d } = base(W, H, 7);
  return { w: W, h: H, data: d };
}

// 'falls' shows trees once, then an empty map: the clicked tree disappears, which is
// exactly what a working villager does.
function nextFrame() {
  scans++;
  if (frameMode === 'empty') return emptyFrame();
  if (frameMode === 'falls' && scans > 1) return emptyFrame();
  return treeFrame();
}

const T = shim.load('wood.js',
  '{ start, stop, CFG, stats, settleCuts, ' +
  'setPending: (p) => { pendingCut = p; }, ' +
  'getLastFall: () => lastFall, getPending: () => pendingCut, ' +
  'dbg: () => ({ running, status, lastError }) }',
  (sb) => {
    sb.__SRToolkit = {
      show() {}, register() {}, hasOverlay: () => false, captureFormat: 'png',
      captureClean() {
        shim.CUR = nextFrame();
        return Promise.resolve({ dataUrl: 'shot' });
      },
      input: {
        moveTo: async () => {},
        click: async () => { clicks++; return true; },
        get position() { return { x: 400, y: 300 }; },
      },
    };
  });

Object.assign(T.CFG, {
  intMin: 20, intMax: 20, maxQueue: 99, jitter: 0,
  autoPan: false, noCutWindowMs: 400,
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // --- the tree never falls: the villager is dead or busy -------------------
  frameMode = 'trees'; clicks = 0; scans = 0;
  T.start();
  await wait(1500);
  let d = T.dbg();
  assert(d.running === false, `a villager that never cuts stops the module (running: ${d.running})`);
  assert(/not cutting/.test(d.status), `the reason is reported (${d.status})`);
  assert(clicks >= 1, `it clicked before giving up (${clicks} clicks)`);

  // --- the tree falls: keep going ------------------------------------------
  T.stop();
  frameMode = 'falls'; clicks = 0; scans = 0;
  T.start();
  await wait(1500);
  d = T.dbg();
  assert(d.running === true, `a villager that does cut keeps the module running (running: ${d.running})`);
  assert(!/not cutting/.test(d.status), `no false alarm while cutting (${d.status})`);
  T.stop();

  // --- settleCuts: a tree that is gone counts as fallen ---------------------
  const now = Date.now();
  T.setPending([{ x: 100, y: 100, at: now }]);
  T.settleCuts([{ x: 300, y: 300 }], now);   // the clicked tree is not in the frame
  assert(T.getLastFall() === now, 'a tree that is gone counts as fallen');
  assert(T.getPending().length === 0, 'a fallen tree leaves the queue');

  // --- settleCuts: a tree that is still there stays in the queue ------------
  T.setPending([{ x: 100, y: 100, at: now }]);
  T.settleCuts([{ x: 100, y: 100 }], now);   // still standing
  assert(T.getPending().length === 1, 'a standing tree stays in the queue');
  assert(T.getLastFall() === now, 'a standing tree does not reset the last fall');

  // --- settleCuts: a click older than 5 min is forgotten --------------------
  T.setPending([{ x: 100, y: 100, at: now - 6 * 60 * 1000 }]);
  T.settleCuts([{ x: 100, y: 100 }], now);
  assert(T.getPending().length === 0, 'a click older than 5 min is forgotten');
})();
