// Pins the anti-detection details of the synthetic mouse: a real cursor reports
// movementX/movementY as the delta since the previous event, screenX/screenY offset by
// the window position and the browser chrome, and its idle gaps are right-skewed instead
// of a rectangle with hard edges. All three were wrong before and are cheap to regress.
const shim = require('./shim.cjs');

const seen = [];          // every dispatched event, in order
const WINDOW_OFF = { x: 120, y: 180 };

function makeEl() {
  const el = {
    style: {}, className: '', textContent: '', isConnected: true, parentElement: null,
    innerHTML: '',
    addEventListener() {},
    appendChild(c) { c.parentElement = el; },
    remove() {},
    querySelector() { return makeEl(); },
    dispatchEvent(e) { seen.push(e); return true; },
  };
  return el;
}

class FakeEvent {
  constructor(type, o = {}) {
    this.type = type;
    Object.assign(this, o);
    this.movementX = 0; // constructed events keep this at 0, exactly like the real thing
    this.movementY = 0;
  }
}

const T = shim.load('hud.js', '{ api: window.__SRToolkit }', (sb) => {
  const body = makeEl();
  sb.document.body = body;
  sb.document.createElement = (tag) => {
    const el = makeEl();
    if (tag === 'div') el.attachShadow = () => ({ innerHTML: '', querySelector: (sel) => el.querySelector(sel) });
    return el;
  };
  sb.document.addEventListener = () => {};
  sb.addEventListener = () => {};
  sb.top = sb;
  sb.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sb.innerWidth = 1600;
  sb.innerHeight = 900;
  sb.screenX = WINDOW_OFF.x;
  sb.screenY = WINDOW_OFF.y;
  sb.outerHeight = 1030; // window + chrome: 130 px of browser UI above the page
  sb.screen = { x: WINDOW_OFF.x, y: WINDOW_OFF.y };
  sb.PointerEvent = FakeEvent;
  sb.MouseEvent = FakeEvent;
  sb.document.elementFromPoint = () => body;
});

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

const moves = () => seen.filter(e => e.type === 'mousemove');

(async () => {
  // 1. Idle gap distribution: right-skewed inside the requested bounds.
  assert(typeof T.api.humanGap === 'function', 'the HUD exposes humanGap for the modules');
  if (typeof T.api.humanGap !== 'function') return;
  const samples = [];
  for (let i = 0; i < 4000; i++) samples.push(T.api.humanGap(1000, 3000));
  const inRange = samples.every(v => v >= 1000 && v <= 3000);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert(inRange, `humanGap stays inside the bounds (${Math.min(...samples)}..${Math.max(...samples)})`);
  // A uniform draw centres on 2000; the skew has to sit clearly below it.
  assert(mean < 1800, `humanGap is right-skewed, not a rectangle (mean ${Math.round(mean)})`);
  assert(T.api.humanGap(500, 500) === 500, 'humanGap tolerates a zero-width range');

  // 2. Moving the cursor produces real movement deltas and offset screen coordinates.
  seen.length = 0;
  await T.api.input.moveTo(400, 300, 20);
  let mv = moves();
  assert(mv.length >= 3, `a move samples several points (${mv.length})`);
  assert(mv.every(e => e.movementX !== 0 || e.movementY !== 0),
    'every move carries a non-zero movement delta');
  const last = mv[mv.length - 1];
  assert(last.clientX === 400 && last.clientY === 300, `the move ends on the target (${last.clientX},${last.clientY})`);
  assert(last.screenX === 400 + WINDOW_OFF.x && last.screenY === 300 + WINDOW_OFF.y + 130,
    `screen coordinates include the window and chrome offset (${last.screenX},${last.screenY})`);
  assert(last.screenX !== last.clientX && last.screenY !== last.clientY,
    'screen and client coordinates are not identical');

  const sumX = mv.reduce((a, e) => a + e.movementX, 0);
  const sumY = mv.reduce((a, e) => a + e.movementY, 0);
  assert(sumX === last.clientX - mv[0].clientX + mv[0].movementX &&
         sumY === last.clientY - mv[0].clientY + mv[0].movementY,
    `movement deltas add up to the travelled distance (${sumX},${sumY})`);

  // 3. The pointer and mouse halves of one physical move share the same delta.
  const byPoint = new Map();
  for (const e of seen) {
    if (e.type !== 'mousemove' && e.type !== 'pointermove') continue;
    const k = `${e.clientX},${e.clientY}`;
    if (byPoint.has(k)) byPoint.get(k).push(e);
    else byPoint.set(k, [e]);
  }
  const mismatched = [...byPoint.values()].filter(g =>
    g.length === 2 && (g[0].movementX !== g[1].movementX || g[0].movementY !== g[1].movementY));
  assert(mismatched.length === 0, 'pointermove and mousemove agree on the delta');

  // 4. A click at the resting position reports no movement, like a real press.
  seen.length = 0;
  await T.api.input.click(400, 300);
  const click = seen.find(e => e.type === 'click');
  assert(!!click, 'the click event is dispatched');
  assert(click.movementX === 0 && click.movementY === 0,
    `a press without moving reports no delta (${click && click.movementX})`);
  assert(click.screenX === 400 + WINDOW_OFF.x && click.screenY === 300 + WINDOW_OFF.y + 130,
    `the click carries offset screen coordinates (${click.screenX},${click.screenY})`);
})();
