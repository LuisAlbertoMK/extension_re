// A round is 16 buildings. Once they are assigned the map has nothing left to click until
// the workers finish, so the collector must come back in 6-7 minutes instead of scanning
// every 5 seconds - and it must not carry a finished round into the next session.
const shim = require('./shim.cjs');

const T = shim.load('resources.js',
  '{ start, stop, CFG, stats, countAssigned, roundWait, dbg: () => ({ roundCount, nextRoundAt }) }',
  (sb) => { sb.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false }; });

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

const MIN = 60 * 1000;

assert(T.CFG.batch === 16, `a round is 16 assignments (${T.CFG.batch})`);
assert(T.CFG.batchMin === 6 * MIN && T.CFG.batchMax === 7 * MIN,
  `the pause is 6-7 minutes (${T.CFG.batchMin}-${T.CFG.batchMax} ms)`);

// Half a round: no long pause yet.
for (let i = 0; i < 8; i++) T.countAssigned(1);
assert(T.dbg().roundCount === 8, `the counter follows the assignments (${T.dbg().roundCount})`);
assert(T.stats.round === 8, `the popup sees the same number (${T.stats.round})`);
assert(T.roundWait() === 0, 'a half-finished round keeps the short gap');

// Finish it: the next wait is the long one, and the round restarts.
for (let i = 0; i < 8; i++) T.countAssigned(1);
const wait = T.roundWait();
assert(wait >= 6 * MIN && wait <= 7 * MIN, `a full round waits 6-7 minutes (${Math.round(wait / 1000)}s)`);
assert(T.dbg().roundCount === 0, 'the next round starts at zero');
assert(T.stats.round === 0, 'the popup counter resets with it');
assert(T.dbg().nextRoundAt > Date.now(), 'the next round has a wake-up time');

// Asking twice must not schedule a second long pause.
assert(T.roundWait() === 0, 'the long pause is granted once per round');

// A restarted session begins a fresh round instead of inheriting the old count.
for (let i = 0; i < 15; i++) T.countAssigned(1);
T.start();
T.stop();
assert(T.dbg().roundCount === 0, `a new session resets the round (${T.dbg().roundCount})`);
assert(T.roundWait() === 0, 'so the first cycle after a start is a normal one');
