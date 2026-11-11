// HUD wiring: the in-page panel is the only control surface in fullscreen (where the
// popup cannot be opened), so its Start/Stop and Calibrate buttons must drive the
// module they belong to and not just repaint the row. A calibration failure must show
// its reason in the row instead of silently doing nothing.
const shim = require('./shim.cjs');

function makeEl() {
  const handlers = {};
  const kids = {};
  const el = {
    style: {}, className: '', textContent: '', isConnected: true, parentElement: null,
    innerHTML: '',
    addEventListener(type, fn) { handlers[type] = fn; },
    appendChild(c) { c.parentElement = el; },
    remove() {},
    querySelector(sel) {
      if (!kids[sel]) kids[sel] = makeEl();
      return kids[sel];
    },
    fire(type) { if (handlers[type]) handlers[type]({ target: el }); },
  };
  return el;
}

let toggled = 0;
let calibrated = 0;

const T = shim.load('hud.js', '{ api: window.__SRToolkit, rows }', (sb) => {
  const body = makeEl();
  sb.document.body = body;
  sb.document.createElement = (tag) => {
    const el = makeEl();
    if (tag === 'div') {
      el.attachShadow = () => ({ innerHTML: '', querySelector: (sel) => el.querySelector(sel) });
    }
    return el;
  };
  sb.document.addEventListener = () => {};
  sb.addEventListener = () => {};
  sb.top = sb; // hud.js only builds its UI in the top frame
  sb.requestAnimationFrame = (fn) => setTimeout(fn, 0);
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

T.api.register({
  id: 'meat',
  label: 'Meat',
  getStatus: () => ({ running: false, text: '0 clicks' }),
  toggle() { toggled++; },
  calibrate() { calibrated++; return Promise.resolve(4); },
});

T.api.register({
  id: 'wood',
  label: 'Wood',
  getStatus: () => ({ running: false, text: '0 marks' }),
  toggle() {},
  calibrate() { return Promise.reject(new Error('capture failed: quota')); },
});

(async () => {
  T.api.show();

  const row = T.rows.get('meat');
  assert(!!row, 'the module gets a row in the HUD panel');

  row.querySelector('[data-act="toggle"]').fire('click');
  assert(toggled === 1, `the row Start/Stop button drives the module (${toggled} toggle calls)`);

  row.querySelector('[data-act="cal"]').fire('click');
  await wait(5);
  assert(calibrated === 1, `the row Calibrate button drives the module (${calibrated} calibrate calls)`);
  assert(row.querySelector('.stat').textContent === 'calibrated: 4 icon(s)',
    `a successful calibration reports the count (${row.querySelector('.stat').textContent})`);

  // A failing calibration must say why, and the 1 s repaint must not wipe it.
  const woodRow = T.rows.get('wood');
  woodRow.querySelector('[data-act="cal"]').fire('click');
  await wait(5);
  T.api.refresh();
  assert(woodRow.querySelector('.stat').textContent === 'capture failed: quota',
    `a failed calibration shows its reason (${woodRow.querySelector('.stat').textContent})`);

  // A second click must toggle again, not stick on the first result.
  row.querySelector('[data-act="toggle"]').fire('click');
  assert(toggled === 2, `the button keeps toggling (${toggled} toggle calls)`);

  // The HUD runs a 1 s repaint timer; stop it so the test process can exit.
  T.api.hide();
})();
