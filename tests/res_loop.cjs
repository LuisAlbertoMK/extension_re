// Resource collector end-to-end: start, scan, click a bubble, pick the gather time,
// stop mid-flight and resume. The detector itself is pinned by the golden file; this
// covers the loop and the controls around it.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 1600, H = 900;
let clicks = 0;
let scans = 0;
let shots = [];
let shotAt = 0;
let failing = false;

function bubble(x, y, size, rgb) {
  const { d } = base(W, H, 5);
  rect(d, W, x, y, size, size, 250, 250, 250);
  const n = 12;
  rect(d, W, x + ((size - n) >> 1), y + ((size - n) >> 1), n, n, rgb[0], rgb[1], rgb[2]);
  return { w: W, h: H, data: d };
}

// Four gold bubbles: one click queues them all, but each one needs its own
// gather-time assignment.
function fourGoldFrame() {
  const { d } = base(W, H, 12);
  [[260, 220], [520, 220], [780, 220], [1040, 300]].forEach(([x, y]) => {
    rect(d, W, x, y, 40, 40, 250, 250, 250);
    rect(d, W, x + 14, y + 14, 12, 12, 220, 190, 40);
  });
  return { w: W, h: H, data: d };
}

// Two meat bubbles and one gold bubble in a single frame: one click per type is
// enough because collecting one bubble queues every bubble of that resource.
function multiFrame() {
  const { d } = base(W, H, 9);
  [[300, 300, 40, [220, 40, 40]], [600, 300, 40, [220, 40, 40]], [900, 400, 44, [220, 190, 40]]]
    .forEach(([x, y, size, rgb]) => {
      rect(d, W, x, y, size, size, 250, 250, 250);
      rect(d, W, x + ((size - 12) >> 1), y + ((size - 12) >> 1), 12, 12, rgb[0], rgb[1], rgb[2]);
    });
  return { w: W, h: H, data: d };
}

// 2x2 grid of "choose time" buttons, the shape detect() recognises as the dialog.
function dialog() {
  const { d } = base(W, H, 6);
  const bw = 100, bh = 30;
  [[420, 380], [620, 380], [420, 460], [620, 460]].forEach(([x, y]) => {
    rect(d, W, x, y, bw, bh, 250, 250, 250);
  });
  return { w: W, h: H, data: d };
}

const T = shim.load('resources.js',
  '{ start, stop, CFG, stats, detect, dbg: () => ({ running, status, lastError }) }',
  (sb) => {
    sb.__SRToolkit = {
      show() {},
      register() {},
      hasOverlay: () => false,
      captureClean() {
        scans++;
        if (failing) return Promise.resolve({ error: 'boom' });
        const i = Math.min(shotAt++, shots.length - 1);
        shim.CUR = shots[i];
        return Promise.resolve({ dataUrl: 'shot' });
      },
      input: {
        moveTo: async () => {},
        click: async () => { clicks++; return true; },
        get position() { return { x: 800, y: 450 }; },
      },
    };
  });

Object.assign(T.CFG, {
  cycMin: 20, cycMax: 20, gapMin: 0, gapMax: 0, jitter: 0,
  selMin: 0, selMax: 0,
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const picked = () => T.stats.meat + T.stats.wood + T.stats.gold + T.stats.stone;

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // --- the detector still sees what the loop needs ---------------------------
  const one = bubble(200, 200, 40, [220, 40, 40]);
  const found = T.detect({ width: W, height: H, _data: one.data });
  assert(found.items.length === 1 && found.items[0].type === 'meat',
    `detect classifies a meat bubble (${JSON.stringify(found.items.map(i => i.type))})`);

  const dlg = T.detect({ width: W, height: H, _data: dialog().data });
  assert(!!dlg.dialog && !!dlg.dialog.target, 'detect recognises the gather-time dialog');

  // --- a failed capture is reported, not swallowed ---------------------------
  failing = true;
  T.start();
  await wait(400);
  let d = T.dbg();
  assert(/capture failed: boom/.test(d.lastError), `a capture error is reported (${d.lastError})`);
  assert(d.running === true, 'a capture error does not stop the session');
  T.stop();
  failing = false;

  // --- start, collect, stop, resume -----------------------------------------
  shots = [bubble(200, 200, 40, [220, 40, 40])];
  shotAt = 0;
  T.start();
  await wait(2600);
  assert(picked() >= 1, `Start collects a bubble (${picked()} picked)`);
  assert(clicks >= 1, `the collector clicks the bubble (${clicks} clicks)`);

  T.stop();
  await wait(50);
  const frozenPicked = picked(), frozenScans = scans;
  await wait(400);
  assert(picked() === frozenPicked, 'Stop halts the collection loop');
  assert(scans === frozenScans, `Stop halts the scanning (${scans - frozenScans} extra scans)`);

  T.start();
  await wait(2600);
  assert(scans > frozenScans, `Start after Stop resumes scanning (${scans - frozenScans} scans)`);
  T.stop();

  // --- the gather-time dialog ------------------------------------------------
  shots = [dialog()];
  shotAt = 0;
  T.CFG.option = 2;
  T.start();
  await wait(2200);
  assert(T.stats.chosen >= 1, `the loop picks the gather time (${T.stats.chosen} chosen)`);
  T.stop();

  // --- one click collects every bubble of that resource ----------------------
  shots = [multiFrame()];
  shotAt = 0;
  T.CFG.cycMin = 60000; T.CFG.cycMax = 60000; // one run only
  const meat0 = T.stats.meat, gold0 = T.stats.gold, clicks0 = clicks;
  T.start();
  await wait(6000);
  T.stop();
  assert(T.stats.meat - meat0 === 1, `one meat click covers both meat bubbles (${T.stats.meat - meat0})`);
  assert(T.stats.gold - gold0 === 1, `the gold bubble is collected too (${T.stats.gold - gold0})`);
  assert(clicks - clicks0 === 2, `one click per resource type, not per bubble (${clicks - clicks0})`);

  // --- one assignment per queued bubble --------------------------------------
  shots = [fourGoldFrame(), dialog()];
  shotAt = 0;
  const chosen0 = T.stats.chosen;
  T.start();
  await wait(10000);
  T.stop();
  assert(T.stats.chosen - chosen0 === 4,
    `four bubbles mean four assignments (${T.stats.chosen - chosen0})`);
})();
