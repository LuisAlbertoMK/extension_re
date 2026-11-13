// Pins the requested wood policy: the cutter walks to the trunk nearest to the villager.
// The villager stands where it last cut, so "nearest to the villager" is "nearest to the
// previous click". Guards against a later edit restoring "pick one of the 3 nearest".
const shim = require('./shim.cjs');

const T = shim.load('wood.js',
  '{ pick, CFG, setRef: (p) => { last = p; recent = []; }, dbg: () => ({ last }) }',
  (sb) => {
    sb.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
  });

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const trees = [
  { x: 100, y: 100, canvasX: 100, canvasY: 100 }, // 0 px from the villager
  { x: 400, y: 400, canvasX: 400, canvasY: 400 }, // far
  { x: 900, y: 600, canvasX: 900, canvasY: 600 }, // far
];

// 1. With a villager position, the nearest trunk always wins.
T.setRef({ x: 105, y: 104 });
let picks = new Set();
for (let i = 0; i < 50; i++) picks.add(T.pick(trees).x);
assert(picks.size === 1 && picks.has(100),
  `the nearest trunk is chosen every time (${[...picks].join(',')})`);

// 2. Move the villager: the winner has to follow it, not stay where it was.
T.setRef({ x: 880, y: 590 });
picks = new Set();
for (let i = 0; i < 50; i++) picks.add(T.pick(trees).x);
assert(picks.size === 1 && picks.has(900),
  `the choice follows the villager (${[...picks].join(',')})`);

// 3. Two equally close trunks are an even walk: either one is fine, but a strictly
//    farther tree never is.
const tie = [
  { x: 200, y: 100, canvasX: 200, canvasY: 100 },
  { x: 120, y: 100, canvasX: 120, canvasY: 120 },
  { x: 800, y: 800, canvasX: 800, canvasY: 800 },
];
T.setRef({ x: 160, y: 100 });
picks = new Set();
for (let i = 0; i < 80; i++) picks.add(T.pick(tie).x);
assert(!picks.has(800), `a farther trunk is never chosen over an even one (${[...picks].join(',')})`);
assert(picks.size === 2, `both equally near trunks are used (${[...picks].join(',')})`);

// 4. A tree clicked in the last 25 s is skipped even when it is the nearest one, so a
//    trunk that did not fall is not hammered.
const ref = { x: 100, y: 100 };
shim.CUR = null;
const sb = shim.load('wood.js', '{ pick, setRef: (p, r) => { last = p; recent = r; } }', (s) => {
  s.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
});
sb.setRef(ref, [{ x: 100, y: 100, t: Date.now() }]);
picks = new Set();
for (let i = 0; i < 50; i++) picks.add(sb.pick([{ x: 100, y: 100 }, { x: 130, y: 100 }]).x);
assert(!picks.has(100), `a recently clicked trunk is skipped (${[...picks].join(',')})`);

// 5. No reference (fresh session): a random trunk, never a crash.
const fresh = shim.load('wood.js', '{ pick, setRef: () => { last = null; recent = []; } }', (s) => {
  s.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
});
fresh.setRef();
picks = new Set();
for (let i = 0; i < 80; i++) picks.add(fresh.pick(trees).x);
assert(picks.size === 3, `without a villager position the choice is random (${[...picks].join(',')})`);

// 6. The tie window is small: it must not turn into "any of the three nearest".
assert(T.CFG.nearestTiePx <= 40, `the even-walk window stays short (${T.CFG.nearestTiePx} px)`);

void dist;
