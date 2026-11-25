// Meat rounds: the default schedule is 25 min, a 5 min break, then 30 min. Each
// round reads its own entry from roundDurationsMs; clearing it falls back to the
// sessionMin..sessionMax range.
const shim = require('./shim.cjs');

const T = shim.load('meat.js',
  '{ CFG: CONFIG, beginRound, start, stop, ' +
  'setRound: (n) => { roundNo = n; }, getRoundsLeft: () => roundsLeft, ' +
  'getEnds: () => sessionEndsAt }',
  (sb) => {
    sb.__SRToolkit = { show() {}, register() {}, hasOverlay: () => false };
  });

const MIN = 60000;
const near = (ms, want) => Math.abs(ms - want) < 1000;
function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

assert(T.CFG.rounds === 2, `the default is two rounds (${T.CFG.rounds})`);
assert(T.CFG.roundPauseMinMs === 5 * MIN && T.CFG.roundPauseMaxMs === 5 * MIN,
  'the break is exactly 5 min');

T.setRound(1);
T.beginRound();
let span = T.getEnds() - Date.now();
assert(near(span, 25 * MIN), `round 1 is 25 min (${Math.round(span / MIN)} min)`);

T.setRound(2);
T.beginRound();
span = T.getEnds() - Date.now();
assert(near(span, 30 * MIN), `round 2 is 30 min (${Math.round(span / MIN)} min)`);

// Clearing the plan goes back to the session range.
T.CFG.roundDurationsMs = [];
T.CFG.sessionMinMs = 10 * MIN;
T.CFG.sessionMaxMs = 10 * MIN;
T.setRound(1);
T.beginRound();
span = T.getEnds() - Date.now();
assert(near(span, 10 * MIN), `without a plan the session range is used (${Math.round(span / MIN)} min)`);

// The plan length adds the second round even if rounds was left at 1.
T.CFG.roundDurationsMs = [25 * MIN, 30 * MIN];
T.CFG.rounds = 1;
T.start();
T.stop();
assert(T.getRoundsLeft() === 1, `the plan adds the second round (${T.getRoundsLeft()})`);
