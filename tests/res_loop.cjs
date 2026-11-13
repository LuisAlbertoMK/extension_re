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
let dialogPending = false;
let bubbleClicks = 0;
let dialogClicks = 0;
let failing = false;
let dyn = null;   // optional live frame provider, used to grow/shrink the world
let onMsg = null; // the module's chrome.runtime.onMessage listener

function frame(n, y0) {
  const { d } = base(W, H, 11);
  for (let k = 0; k < n; k++) {
    const x = 60 + k * 120;
    rect(d, W, x, y0, 30, 30, 245, 245, 245);
    rect(d, W, x + 9, y0 + 9, 12, 12, 190, 45, 40);
  }
  return { w: W, h: H, data: d };
}

function multiFrame() {
  const { d } = base(W, H, 11);
  [[60, 200], [180, 200]].forEach(([x, y]) => {
    rect(d, W, x, y, 30, 30, 245, 245, 245);
    rect(d, W, x + 9, y + 9, 12, 12, 190, 45, 40);
  });
  rect(d, W, 400, 300, 44, 44, 250, 250, 250);
  rect(d, W, 414, 314, 12, 12, 220, 190, 40);
  return { w: W, h: H, data: d };
}

// Five fixed bubbles, so a frame can describe "how many exist right now".
const GOLD_SPOTS = [[260, 220], [520, 220], [780, 220], [1040, 300], [1040, 180]];

function goldFrame(n) {
  const { d } = base(W, H, 12);
  GOLD_SPOTS.slice(0, n).forEach(([x, y]) => {
    rect(d, W, x, y, 40, 40, 250, 250, 250);
    rect(d, W, x + 14, y + 14, 12, 12, 220, 190, 40);
  });
  return { w: W, h: H, data: d };
}

function fourGoldFrame() {
  return goldFrame(4);
}

function dialog() {
  const { d } = base(W, H, 6);
  [[420, 380], [620, 380], [420, 460], [620, 460]].forEach(([x, y]) => {
    rect(d, W, x, y, 100, 30, 250, 250, 250);
  });
  return { w: W, h: H, data: d };
}

function emptyFrame() {
  const { d } = base(W, H, 99);
  return { w: W, h: H, data: d };
}

const T = shim.load('resources.js',
  '{ start, stop, CFG, stats, detect, dbg: () => ({ running, status, lastError }) }',
  (sb) => {
    sb.chrome.runtime.onMessage.addListener = (fn) => { onMsg = fn; };
    sb.__SRToolkit = {
      show() {},
      register() {},
      hasOverlay: () => false,
      captureClean() {
        scans++;
        if (failing) return Promise.resolve({ error: 'boom' });
        if (dialogPending) {
          shim.CUR = dialog();
          return Promise.resolve({ dataUrl: 'shot' });
        }
        if (dyn) {
          shim.CUR = dyn();
          return Promise.resolve({ dataUrl: 'shot' });
        }
        if (shots.length === 0 || shotAt >= shots.length) {
          shim.CUR = emptyFrame();
          return Promise.resolve({ dataUrl: 'shot' });
        }
        const i = Math.min(shotAt++, shots.length - 1);
        shim.CUR = shots[i];
        return Promise.resolve({ dataUrl: 'shot' });
      },
      input: {
        moveTo: async () => {},
        click: async (x, y) => {
          clicks++;
          if (y > 360) {
            dialogPending = false;  // clicking a dialog button closes it
            dialogClicks++;
          } else {
            dialogPending = true;   // clicking a bubble/zz opens it
            bubbleClicks++;
          }
          return true;
        },
        get position() { return { x: 800, y: 450 }; },
      },
    };
  });

Object.assign(T.CFG, {
  cycMin: 20, cycMax: 20, gapMin: 0, gapMax: 0, selMin: 0, selMax: 0,
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const picked = () => T.stats.meat + T.stats.wood + T.stats.gold + T.stats.stone;

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // --- the detector still sees what the loop needs ---------------------------
  const one = multiFrame();
  const found = T.detect({ width: W, height: H, _data: one.data });
  assert(found.items.length >= 2, `detect finds multiple bubbles (${found.items.length})`);

  const dlg = T.detect({ width: W, height: H, _data: dialog().data });
  assert(!!dlg.dialog && !!dlg.dialog.target, 'detect recognises the gather-time dialog');

  // The popup reads this message: an empty handler here leaves it with no counters.
  let status = null;
  onMsg({ type: 'RES_STATUS' }, {}, (r) => { status = r; });
  assert(!!status && !!status.stats && typeof status.stats.chosen === 'number',
    'the status message carries the counters');

  // --- start, collect, stop, resume -----------------------------------------
  dialogPending = false;
  shots = [multiFrame(), emptyFrame()];
  shotAt = 0;
  T.start();
  await wait(2600);
  assert(picked() >= 1, `Start collects a bubble (${picked()} picked)`);
  assert(bubbleClicks >= 1, `the collector clicks a bubble (${bubbleClicks} clicks)`);

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

  // --- one assignment per queued bubble --------------------------------------
  dialogPending = false;
  shots = [multiFrame(), emptyFrame()];
  shotAt = 0;
  const bubbleClicks0 = bubbleClicks, dialogClicks0 = dialogClicks;
  T.start();
  await wait(6000);
  T.stop();
  assert(bubbleClicks - bubbleClicks0 >= 1, `a bubble is clicked for each assignment (${bubbleClicks - bubbleClicks0})`);
  assert(dialogClicks - dialogClicks0 >= 1, `each bubble click gets a gather time (${dialogClicks - dialogClicks0})`);

  // --- a failed capture is reported, not swallowed ---------------------------
  T.stop();
  await wait(8000);
  failing = true;
  dialogPending = false;
  shots = [];
  shotAt = 0;
  T.start();
  await wait(400);
  let d = T.dbg();
  assert(/capture failed: boom/.test(d.lastError), `a capture error is reported (${d.lastError})`);
  assert(d.running === true, 'a capture error does not stop the session');
  T.stop();
  await wait(500);
  failing = false;

  // --- four bubbles mean four assignments -----------------------------------
  await wait(500);
  dialogPending = false;
  // One fresh items frame per bubble: the loop re-scans after every assignment, so a
  // static frame must be served again for each of the four bubbles.
  shots = Array.from({ length: 10 }, fourGoldFrame).concat([emptyFrame()]);
  shotAt = 0;
  const dialogClicks0g = dialogClicks;
  const chosen0 = T.stats.chosen;
  T.start();
  await wait(10000);
  T.stop();
  assert(dialogClicks - dialogClicks0g === 4, `four bubbles mean four assignments (${dialogClicks - dialogClicks0g}) chosen=${T.stats.chosen - chosen0} err=${T.dbg().lastError}`);
  assert(T.stats.chosen - chosen0 === 4, `four bubbles mean four assignments (${T.stats.chosen - chosen0})`);

  // --- a bubble that renders late is still assigned -------------------------
  // The old two-phase design built its queue from ONE snapshot, so a bubble that was
  // not on screen yet (or a whole type that rendered late) never got its time.
  await wait(500);
  dialogPending = false;
  shots = [];
  shotAt = 0;
  const dlg0 = dialogClicks;
  // Only one cycle: bumping the cycle pause keeps the assertions deterministic.
  T.CFG.cycMin = 60000; T.CFG.cycMax = 60000;
  dyn = () => goldFrame(dialogClicks - dlg0 >= 3 ? 5 : 3);
  T.start();
  await wait(6000);
  T.stop();
  dyn = null;
  assert(dialogClicks - dlg0 === 5, `a bubble that renders late is still assigned (${dialogClicks - dlg0})`);
})();