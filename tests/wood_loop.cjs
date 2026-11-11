// Wood collector: an empty map must not stop the session, and a failed capture must
// surface instead of leaving the module "running" and idle.
const shim = require('./shim.cjs');
const { base } = require('./frames.cjs');

const W = 800, H = 600;
let failing = false;

const T = shim.load('wood.js',
  '{ start, stop, CFG, stats, dbg: () => ({ running, status, lastError }) }',
  (sb) => {
    sb.__SRToolkit = {
      show() {}, register() {}, hasOverlay: () => false, captureFormat: 'jpeg',
      captureClean() {
        if (failing) return Promise.resolve({ error: 'boom' });
        const { d } = base(W, H, 3);
        shim.CUR = { w: W, h: H, data: d };
        return Promise.resolve({ dataUrl: 'shot' });
      },
      input: {
        moveTo: async () => {}, click: async () => true,
        get position() { return { x: 400, y: 300 }; },
      },
    };
  });

Object.assign(T.CFG, { intMin: 20, intMax: 20, maxQueue: 99 });

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  T.start();
  await wait(800);
  let d = T.dbg();
  assert(d.running === true, `an empty map does not stop the session (running: ${d.running})`);
  assert(T.stats.cycles >= 4, `it keeps scanning (${T.stats.cycles} cycles)`);

  failing = true;
  await wait(120);
  d = T.dbg();
  assert(/capture failed: boom/.test(d.lastError), `a capture error is reported (${d.lastError})`);
  assert(d.running === true, 'a capture error does not stop the session');
  T.stop();
})();
