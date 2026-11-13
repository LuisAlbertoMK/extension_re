// Wood collector: if the villager is dead or busy, the clicked tree stays standing.
// Clicking 20-30 min at nothing is worse than stopping with a reason, so three clicks
// in a row whose tree survived must stop the module - and a tree that does fall must
// keep it running.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 800, H = 600;
let treesAlive = true;
let clicks = 0;

// One trunk with the green canopy above it, at a fixed spot.
// Same fixture the golden test uses, so the detector is known to accept it.
function treeFrame() {
  const { d, r } = base(W, H, 7);
  if (!treesAlive) return { w: W, h: H, data: d };
  for (let k = 0; k < 10; k++) {
    const bs = 4 + Math.floor(r() * 14);
    const x = 140 + Math.floor(r() * (W - 320)), y = 160 + Math.floor(r() * (H - 340));
    rect(d, W, x, y, bs, bs, 175, 105, 70);
    rect(d, W, x - 6, y - 12, bs + 12, 12, 60, 150, 60);
  }
  return { w: W, h: H, data: d };
}

const T = shim.load('wood.js',
  '{ start, stop, CFG, stats, cutStreak, dbg: () => ({ running, status, lastError }) }',
  (sb) => {
    sb.__SRToolkit = {
      show() {}, register() {}, hasOverlay: () => false, captureFormat: 'png',
      captureClean() {
        shim.CUR = treeFrame();
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
  cutTime: 100, cutGrace: 30, noCutLimit: 3,
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // --- the tree never falls: the villager is dead or busy -------------------
  treesAlive = true;
  clicks = 0;
  T.start();
  await wait(2500);
  let d = T.dbg();
  assert(d.running === false, `a villager that never cuts stops the module (running: ${d.running})`);
  assert(/not cutting/.test(d.status), `the reason is reported (${d.status})`);
  assert(clicks >= 3, `it tried several trees before giving up (${clicks} clicks)`);

  // --- the tree falls: keep going ------------------------------------------
  await wait(100);
  treesAlive = false;      // every click now removes the tree
  T.stop();
  T.start();
  await wait(2500);
  d = T.dbg();
  assert(d.running === true, `a villager that does cut keeps the module running (running: ${d.running})`);
  assert(!/not cutting/.test(d.status), `no false alarm while cutting (${d.status})`);
  T.stop();

  // --- the batch verdict does not depend on the order of the queue ----------
  // Same facts, two orders: the oldest click fell (the villager IS working) while the
  // newer ones are still being walked to. Before, [cut, still, still] ended the streak
  // at 2 and could stop the module; [still, still, cut] ended at 0 for identical facts.
  const gone = { x: 100, y: 100 };
  const still = [{ x: 300, y: 300 }, { x: 500, y: 200 }];
  const trees = still.map(t => ({ ...t }));         // only the newer trunks are visible
  const due = [gone, ...still];
  const forward = T.cutStreak(0, due, trees);
  const backward = T.cutStreak(0, [...due].reverse(), trees);
  assert(forward === 0 && backward === 0,
    `one tree that fell resets the streak whatever the order (${forward}/${backward})`);
  assert(T.cutStreak(0, still.map(t => ({ x: t.x, y: t.y, at: 0 })), trees) === 2,
    'a batch that all survived advances the streak by its size');
  assert(T.cutStreak(2, [{ x: 300, y: 300, at: 0 }], trees) === 3,
    'a single surviving tree still advances it');
  assert(T.cutStreak(1, [], trees) === 1, 'an empty batch leaves the streak alone');
})();
