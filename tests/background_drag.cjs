// background.js: the CDP drag must always try to release the mouse button, even when a
// move fails mid-gesture. A failed `mouseReleased` leaves the game holding the left
// button down, which is far worse than a short gesture.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'social-reborn-toolkit', 'background.js');
let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Loads background.js against a fake chrome. `failOn(method, params, index)` returns an
// error string for the command that should fail.
function load(failOn) {
  const calls = [];
  let listener = null;
  let pending = null;
  const setError = (m) => { pending = m ? { message: m } : null; };
  const chrome = {
    runtime: {
      get lastError() { const e = pending; pending = null; return e; },
      onMessage: { addListener: (f) => { listener = f; } },
      sendMessage: () => Promise.resolve(),
    },
    debugger: {
      attach: (t, v, cb) => { setError(null); cb(); },
      detach: (t, cb) => { setError(null); if (cb) cb(); },
      sendCommand: (target, method, params, cb) => {
        setError(null);
        calls.push({ method, params });
        setError(failOn ? failOn(method, params, calls.length - 1) : null);
        if (cb) cb();
      },
      onDetach: { addListener() {} },
    },
    tabs: {
      onRemoved: { addListener() {} },
      query: (q, cb) => cb([]),
      sendMessage: () => Promise.resolve(),
      captureVisibleTab: (w, o, cb) => cb('data:,x'),
    },
    commands: { onCommand: { addListener() {} } },
  };
  const ctx = vm.createContext({ chrome, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
  return {
    calls,
    send(msg) {
      return new Promise((resolve) => {
        listener(msg, { tab: { id: 7, windowId: 1 } }, resolve);
      });
    },
  };
}

const path3 = [{ x: 10, y: 10, w: 1 }, { x: 20, y: 20, w: 1 }, { x: 30, y: 30, w: 1 }];
const drag = { type: 'DEBUGGER_DRAG', from: { x: 0, y: 0 }, to: { x: 40, y: 40 }, path: path3, duration: 10 };

(async () => {
  {
    const bg = load(null);
    const r = await bg.send(drag);
    const types = bg.calls.map(c => c.params.type);
    ok(r && r.ok === true, 'a drag with no failures reports ok');
    ok(types[0] === 'mousePressed' && types[types.length - 1] === 'mouseReleased',
      'the gesture is press, moves, release');
  }

  {
    // The second move fails: the release must still be dispatched.
    const bg = load((method, params, i) => (params.type === 'mouseMoved' && i >= 2 ? 'detached' : null));
    const r = await bg.send(drag);
    const types = bg.calls.map(c => c.params.type);
    ok(r && r.error === 'detached', 'a failed move is reported to the caller');
    ok(types.includes('mouseReleased'), 'the button is released after a failed move');
    const release = bg.calls.find(c => c.params.type === 'mouseReleased');
    ok(release && release.params.buttons === 0 && release.params.button === 'left',
      'the release clears the button state');
  }

  {
    // The press itself fails: no release is needed (nothing was pressed) and the error
    // still reaches the caller.
    const bg = load((method, params) => (params.type === 'mousePressed' ? 'no attach' : null));
    const r = await bg.send(drag);
    const types = bg.calls.map(c => c.params.type);
    ok(r && r.error === 'no attach', 'a failed press is reported');
    ok(!types.includes('mouseReleased'), 'no release is sent when the press never landed');
  }

  {
    // A click is still a plain press+release pair.
    const bg = load(null);
    const r = await bg.send({ type: 'DEBUGGER_CLICK', x: 5, y: 6 });
    const types = bg.calls.map(c => c.params.type);
    ok(r && r.ok === true, 'a click reports ok');
    ok(types.join(',') === 'mousePressed,mouseReleased', 'a click is exactly press+release');
  }

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
