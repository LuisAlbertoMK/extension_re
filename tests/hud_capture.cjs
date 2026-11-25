// The capture queue must keep the HUD/overlays hidden until the LAST capture in
// flight finishes. A capture that times out releases the lock while it is still
// running, so its finally used to un-hide the chrome in the middle of the next
// screenshot and the HUD ended up inside the frame.
const shim = require('./shim.cjs');

const shots = [];   // { msg, resolve } for each CAPTURE_SCREENSHOT still in flight

function makeEl() {
  const el = {
    style: {}, isConnected: true, parentElement: null,
    addEventListener() {}, appendChild(c) { c.parentElement = el; },
    remove() {}, querySelector() { return makeEl(); }, dispatchEvent() { return true; },
  };
  return el;
}

const T = shim.load('hud.js', '{ api: window.__SRToolkit }', (sb) => {
  sb.document.body = makeEl();
  sb.document.createElement = (tag) => {
    if (tag === 'canvas') {
      return {
        width: 0, height: 0, style: {}, parentElement: null,
        getContext: () => shim.ctx2d(), remove() {},
      };
    }
    return makeEl();
  };
  sb.document.addEventListener = () => {};
  sb.addEventListener = () => {};
  sb.top = sb;
  sb.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sb.innerWidth = 1600;
  sb.innerHeight = 900;
  sb.chrome.runtime.sendMessage = (msg) => {
    if (msg.type !== 'CAPTURE_SCREENSHOT') return Promise.resolve({ ok: true });
    return new Promise((resolve) => shots.push({ msg, resolve }));
  };
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  const overlay = T.api.mountOverlay('test');
  assert(!overlay.style.visibility, `the overlay starts visible (${overlay.style.visibility})`);

  // A capture that times out while it is still in flight.
  const a = T.api.captureClean({ timeoutMs: 10 });
  await wait(80);                       // A has reached its screenshot and is waiting
  const ra = await a;
  assert(ra && /timed out/.test(ra.error), `the caller gets a timeout result (${ra && ra.error})`);
  assert(shots.length === 1, `the timed-out capture is still in flight (${shots.length})`);
  assert(overlay.style.visibility === 'hidden', 'the chrome stays hidden while A is in flight');

  // A second capture starts while the first one is still pending.
  const b = T.api.captureClean({ timeoutMs: 500 });
  await wait(80);
  assert(shots.length === 2, `the second capture runs next to the stale one (${shots.length})`);
  assert(overlay.style.visibility === 'hidden', 'the chrome is hidden for the second capture');

  // The stale capture finishes first: it must NOT restore the chrome.
  shots[0].resolve({ dataUrl: 'a' });
  await wait(30);
  assert(overlay.style.visibility === 'hidden', 'a stale capture does not un-hide the chrome');

  // The real capture finishes last: now the chrome comes back.
  shots[1].resolve({ dataUrl: 'b' });
  const rb = await b;
  await wait(30);
  assert(rb && rb.dataUrl === 'b', 'the second capture returns its own frame');
  assert(overlay.style.visibility === '', 'the chrome is restored after the last capture');
})();
