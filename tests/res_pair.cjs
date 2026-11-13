// Pairing: in the game the first click on a zZ bubble only selects the building and the
// shared "choose time" dialog appears with the SECOND click, assigning both. The collector
// must exploit that (two buildings per dialog) and must not lose the last building when it
// is the only one left on the map.
const shim = require('./shim.cjs');
const { base, rect } = require('./frames.cjs');

const W = 1600, H = 900;
const SPOTS = [[260, 220], [520, 220], [780, 220], [1040, 300]];

let remaining = SPOTS.slice();
let mapClicks = [];       // every bubble click since the last dialog, in order
let dialogPending = false;
let dialogClicks = 0, bubbleClicks = 0, reClicks = 0;

function mapFrame() {
  const { d } = base(W, H, 12);
  for (const [x, y] of remaining) {
    rect(d, W, x, y, 40, 40, 250, 250, 250);
    rect(d, W, x + 14, y + 14, 12, 12, 220, 190, 40);
  }
  return { w: W, h: H, data: d };
}

function dialogFrame() {
  const { d } = base(W, H, 6);
  [[420, 380], [620, 380], [420, 460], [620, 460]].forEach(([x, y]) => {
    rect(d, W, x, y, 100, 30, 250, 250, 250);
  });
  return { w: W, h: H, data: d };
}

const T = shim.load('resources.js',
  '{ start, stop, CFG, stats, dbg: () => ({ running, status, lastError }) }',
  (sb) => {
      sb.__SRToolkit = {
      show() {}, register() {}, hasOverlay: () => false,
      captureClean() {
        shim.CUR = dialogPending ? dialogFrame() : mapFrame();
        return Promise.resolve({ dataUrl: 'shot' });
      },
      input: {
        moveTo: async () => {},
        click: async (x, y) => {
          if (y > 360) {                       // a dialog button closes it
            dialogClicks++;
            dialogPending = false;
            // Every building whose bubble was clicked is assigned by this one dialog.
            remaining = remaining.filter(([sx, sy]) =>
              !mapClicks.some((c) => Math.hypot(c.x - sx, c.y - sy) < 60));
            mapClicks = [];
            return true;
          }
          bubbleClicks++;
          if (mapClicks.some((c) => Math.hypot(c.x - x, c.y - y) < 30)) { reClicks++; dialogPending = true; return true; }
          mapClicks.push({ x, y });
          if (mapClicks.length >= 2) dialogPending = true;
          return true;
        },
        get position() { return { x: 800, y: 450 }; },
      },
    };
  });

Object.assign(T.CFG, {
  cycMin: 20, cycMax: 20, gapMin: 0, gapMax: 0, pairBeatMin: 0, pairBeatMax: 0,
  selMin: 0, selMax: 0, jitter: 0,
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // --- four bubbles, two per dialog ---------------------------------------
  T.start();
  const end = Date.now() + 15000;
  while (remaining.length && Date.now() < end) await wait(100);
  T.stop();

  assert(remaining.length === 0, `every bubble got assigned (${remaining.length} left)`);
  assert(dialogClicks === 2, `two dialogs covered four buildings (${dialogClicks} dialogs)`);
  assert(bubbleClicks === 4, `one click per building (${bubbleClicks} clicks)`);
  // The counter is what the popup shows; the pairing itself is what the two assertions
  // above prove. At least one dialog of four buildings must have covered two.
  assert(T.stats.chosen >= 2 && T.stats.chosen <= 4, `assignments counted (${T.stats.chosen})`);
  assert(T.stats.paired >= 1, `at least one dialog covered two buildings (${T.stats.paired})`);
  assert(reClicks === 0, `nothing had to be clicked twice (${reClicks} re-clicks)`);

  // --- one bubble left alone ----------------------------------------------
  // The game needs a second click even for a single building, so the collector has to
  // click the selected one again instead of waiting for a dialog that never comes.
  remaining = [[520, 220]];
  mapClicks = [];
  dialogPending = false;
  bubbleClicks = 0; dialogClicks = 0; reClicks = 0;
  const chosen0 = T.stats.chosen;

  T.start();
  const end2 = Date.now() + 12000;
  while (remaining.length && Date.now() < end2) await wait(100);
  T.stop();

  assert(remaining.length === 0, `a lone bubble still gets its gather time (${remaining.length} left)`);
  assert(reClicks >= 1, `the selected bubble is clicked a second time (${reClicks})`);
  assert(T.stats.chosen - chosen0 >= 1, `the lone assignment is reported (${T.stats.chosen - chosen0})`);

  // Pairing off is the unit-test surface: roundWait/countAssigned cover the accounting.
})();
