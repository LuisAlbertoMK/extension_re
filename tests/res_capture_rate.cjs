// captureVisibleTab allows ~2 calls/second and drops the rest. The dialog poll used to
// ask for ~3/s, so part of the captures failed, scan() threw and the cycle aborted
// mid-dialog - the "half the bubbles get their time" symptom. Every capture now waits
// for CFG.captureMinMs, and a dropped capture no longer aborts the poll.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 1600, H = 900;
const at = [];
let failFirst = false;
let serveDialog = false;

function buttons(d) {
  for (let i = 0; i < 4; i++) {
    const x = 200 + (i % 2) * 300;
    const y = 380 + Math.floor(i / 2) * 80;
    rect(d, W, x, y, 100, 30, 250, 250, 250);
  }
}

const dialogFrame = (() => { const f = base(W, H, 5); buttons(f.d); return { w: W, h: H, data: f.d }; })();
const emptyFrame = (() => { const f = base(W, H, 9); return { w: W, h: H, data: f.d }; })();

const T = shim.load('resources.js', '{ waitForDialog, CFG }', (sb) => {
  sb.__SRToolkit = {
    show() {}, register() {}, hasOverlay: () => false,
    captureClean() {
      at.push(Date.now());
      if (failFirst) { failFirst = false; return Promise.resolve({ error: 'quota' }); }
      shim.CUR = serveDialog ? dialogFrame : emptyFrame;
      return Promise.resolve({ dataUrl: 'shot' });
    },
  };
});

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  assert(T.CFG.captureMinMs >= 500,
    `the capture floor keeps the poll under 2/s (${T.CFG.captureMinMs} ms)`);

  // A poll that never finds a dialog still has to space its captures.
  at.length = 0;
  const r = await T.waitForDialog(1600, () => true);
  assert(r === null, 'a poll that never sees the dialog returns null');
  assert(at.length >= 2, `the poll scanned more than once (${at.length})`);
  let min = Infinity;
  for (let i = 1; i < at.length; i++) min = Math.min(min, at[i] - at[i - 1]);
  assert(min >= 500, `no two captures are closer than 500 ms (${min} ms)`);

  // A dropped capture is not "no dialog": keep polling and return the frame that has it.
  at.length = 0;
  failFirst = true;
  serveDialog = true;
  const hit = await T.waitForDialog(1600, () => true);
  assert(!!hit && !!hit.dialog, 'a dropped capture does not abort the poll');
  assert(at.length >= 2, `it kept capturing after the error (${at.length})`);

  console.log(process.exitCode ? '\nFAILED' : '\nall passed');
})();
