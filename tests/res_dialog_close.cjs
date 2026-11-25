// closeDialog: Escape is tried first because a synthetic key cannot click anything in
// the game world. The dialog's own X (computed from the button grid) is only clicked if
// the dialog is still there afterwards, so a wrong guess never opens another building.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 1600, H = 900;
const keys = [];
const clicks = [];
let scanFrame = null;

function buttons(d, y0, n) {
  for (let i = 0; i < n; i++) {
    const x = 200 + (i % 2) * 300;
    const y = y0 + Math.floor(i / 2) * 80;
    rect(d, W, x, y, 100, 30, 250, 250, 250);
  }
}

const dialogFrame = (() => {
  const f = base(W, H, 5);
  buttons(f.d, 380, 4);
  return { w: W, h: H, data: f.d };
})();

const emptyFrame = (() => {
  const f = base(W, H, 9);
  return { w: W, h: H, data: f.d };
})();

const T = shim.load('resources.js', '{ detect, closeDialog, CFG }', (sb) => {
  sb.KeyboardEvent = class {
    constructor(type, o) { this.type = type; Object.assign(this, o); keys.push(this); }
  };
  sb.document.activeElement = null;
  sb.document.body = { dispatchEvent: (e) => { keys.push(e); return true; } };
  sb.__SRToolkit = {
    show() {}, register() {}, hasOverlay: () => false,
    captureClean() { shim.CUR = scanFrame || emptyFrame; return Promise.resolve({ dataUrl: 'shot' }); },
    input: { click: async (x, y) => { clicks.push([x, y]); return true; } },
  };
});

T.CFG.captureMinMs = 0;

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  shim.CUR = dialogFrame;
  const dialog = T.detect({ width: W, height: H, _data: dialogFrame.data }).dialog;
  assert(!!dialog && !!dialog.close, 'the dialog exposes a close point');

  // Escape works: nothing else is clicked.
  keys.length = 0; clicks.length = 0;
  scanFrame = emptyFrame;
  await T.closeDialog(dialog, () => true);
  assert(keys.length >= 2, `Escape is dispatched first (${keys.length} events)`);
  assert(keys.every(k => k.key === 'Escape'), 'the first attempt is only Escape');
  assert(clicks.length === 0, `no click when Escape closed the dialog (${clicks.length})`);

  // Escape is ignored: the dialog's X is clicked instead.
  keys.length = 0; clicks.length = 0;
  scanFrame = dialogFrame;
  await T.closeDialog(dialog, () => true);
  assert(keys.length >= 2, 'Escape is still tried first');
  assert(clicks.length === 1, `the X is clicked when the dialog survives (${clicks.length})`);
  const [cx, cy] = clicks[0] || [];
  assert(cx === Math.round(dialog.close.x) && cy === Math.round(dialog.close.y),
    `the click lands on the computed X (${cx},${cy})`);

  // No dialog object: Escape only, never a blind click.
  keys.length = 0; clicks.length = 0;
  await T.closeDialog(null, () => true);
  assert(keys.length >= 2 && clicks.length === 0, 'without a dialog there is no click');

  console.log(process.exitCode ? '\nFAILED' : '\nall passed');
})();
