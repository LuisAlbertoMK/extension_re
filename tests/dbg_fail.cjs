const shim = require('D:/extension_ser/tests/shim.cjs');
let failing = false;
const T = shim.load('resources.js', '{ start, stop, CFG, stats, dbg: () => ({ running, status, lastError }) }', (sb) => {
  sb.__SRToolkit = {
    show() {}, register() {}, hasOverlay: () => false,
    captureClean() { if (failing) return Promise.resolve({ error: 'boom' }); return Promise.resolve({ dataUrl: 'shot' }); },
    input: { moveTo: async () => {}, click: async () => true, get position() { return { x: 800, y: 450 }; } },
  };
});
Object.assign(T.CFG, { cycMin: 60000, cycMax: 60000, gapMin: 0, gapMax: 0, selMin: 0, selMax: 0 });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const main = async () => {
  failing = true;
  T.start();
  await wait(200);
  console.log('dbg', JSON.stringify(T.dbg()));
  T.stop();
  await wait(100);
  process.exit(0);
};
main();