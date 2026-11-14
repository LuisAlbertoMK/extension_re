// The dialog test used to accept ANY three white wide-short blobs, including the ones in
// the building panel at the bottom. That fabricated a dialog, which blanks every bubble
// for that frame and makes the collector click the UI instead of the map.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 1600, H = 900;
const keys = [];

function buttons(d, y0, n) {
  for (let i = 0; i < n; i++) {
    const x = 200 + (i % 2) * 300;
    const y = y0 + Math.floor(i / 2) * 80;
    rect(d, W, x, y, 100, 30, 250, 250, 250);
  }
}

function bubbles(d, n) {
  for (let i = 0; i < n; i++) {
    const x = 200 + i * 140;
    rect(d, W, x, 200, 30, 30, 245, 245, 245);
    rect(d, W, x + 9, 209, 12, 12, 190, 45, 40);
  }
}

const T = shim.load('resources.js',
  '{ detect, closeDialog, CFG }',
  (sb) => {
    sb.KeyboardEvent = class {
      constructor(type, o) { this.type = type; Object.assign(this, o); keys.push(this); }
    };
    sb.document.activeElement = null;
    sb.document.body = { dispatchEvent: (e) => { keys.push(e); return true; } };
    sb.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
  });

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

// --- the real dialog is still recognised ----------------------------------
let f = base(W, H, 5);
buttons(f.d, 380, 4);
let r = T.detect({ width: W, height: H, _data: f.d });
assert(!!r.dialog, 'a centred 2x2 grid is a dialog');
assert(!!r.dialog && !!r.dialog.target, 'it has a clickable target');
assert(r.items.length === 0, 'bubbles are hidden while the dialog is up');

// --- buttons in the bottom panel are not a dialog -------------------------
f = base(W, H, 6);
bubbles(f.d, 3);
buttons(f.d, 830, 4);          // inside the building panel, y = 830/900
r = T.detect({ width: W, height: H, _data: f.d });
assert(!r.dialog, 'four buttons in the bottom panel are not a dialog');
assert(r.items.length === 3, `the bubbles are still seen (${r.items.length})`);

// --- buttons in the top bar are not a dialog ------------------------------
f = base(W, H, 7);
bubbles(f.d, 2);
buttons(f.d, 20, 4);           // inside the top bar
r = T.detect({ width: W, height: H, _data: f.d });
assert(!r.dialog, 'four buttons in the top bar are not a dialog');
assert(r.items.length === 2, `the bubbles are still seen (${r.items.length})`);

// --- only one row is not a dialog -----------------------------------------
f = base(W, H, 8);
buttons(f.d, 380, 2);          // a single row of two
r = T.detect({ width: W, height: H, _data: f.d });
assert(!r.dialog, 'one row of buttons is not a dialog');

// --- a stuck dialog is closed with Escape --------------------------------
keys.length = 0;
T.closeDialog();
assert(keys.length >= 2, `Escape is dispatched (${keys.length} events)`);
assert(keys.every((k) => k.key === 'Escape' && k.keyCode === 27),
  'it is a real Escape key, not a click');
