const shim = require('D:/extension_ser/tests/shim.cjs');
const { base, rect } = require('D:/extension_ser/tests/frames.cjs');
const W=1600,H=900;
let failing = false;
let scans = 0;
let dialogPending = false;
const T = shim.load('resources.js', '{ start, stop, CFG, stats, dbg: () => ({ running, status, lastError }) }', (sb) => {
  sb.__SRToolkit = {
    show() {}, register() {}, hasOverlay: () => false,
    captureClean() {
      scans++;
      if (failing) return Promise.resolve({ error: 'boom' });
      if (dialogPending) {
        const { d } = base(W, H, 6);
        [[420,380],[620,380],[420,460],[620,460]].forEach(([x,y])=>rect(d,W,x,y,100,30,250,250,250));
        shim.CUR = { w: W, h: H, data: d };
        return Promise.resolve({ dataUrl: 'shot' });
      }
      if (shots.length === 0 || shotAt >= shots.length) {
        const { d } = base(W, H, 99);
        shim.CUR = { w: W, h: H, data: d };
        return Promise.resolve({ dataUrl: 'shot' });
      }
      const i = Math.min(shotAt++, shots.length - 1);
      shim.CUR = shots[i];
      return Promise.resolve({ dataUrl: 'shot' });
    },
    input: { moveTo: async () => {}, click: async () => true, get position() { return { x: 800, y: 450 }; } },
  };
});
let shots = [];
let shotAt = 0;
Object.assign(T.CFG, { cycMin: 60000, cycMax: 60000, gapMin: 0, gapMax: 0, selMin: 0, selMax: 0 });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const main = async () => {
  failing = true;
  dialogPending = false;
  shots = [];
  shotAt = 0;
  T.start();
  await wait(400);
  console.log('scans', scans, 'dbg', JSON.stringify(T.dbg()));
  T.stop();
  await wait(100);
  process.exit(0);
};
main();