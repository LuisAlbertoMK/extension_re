// The popup's choices must survive a page reload. They used to be sent to the content
// script and nothing else, so every reload silently restored the defaults - and with
// autostart on, the module then ran a session with settings the user never picked (the
// gather time was the expensive one: 5 min instead of the chosen 8 h).
const shim = require('./shim.cjs');

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

// Loads a module with a storage stub that answers `get` from `stored` and records `set`.
function load(file, exportExpr, stored) {
  const listeners = [];
  const writes = [];
  const T = shim.load(file, exportExpr, (sb) => {
    sb.chrome.storage.local = {
      get: (keys, cb) => {
        const out = {};
        for (const k of keys) if (k in stored) out[k] = stored[k];
        cb(out);
      },
      set: (value) => { writes.push(value); },
    };
    sb.chrome.runtime.onMessage.addListener = (fn) => listeners.push(fn);
  });
  return { T, listeners, writes };
}

// --- meat -------------------------------------------------------------------
const meat = load('meat.js',
  '{ CONFIG }',
  { meatConfig: { collectMode: 'click', clickDelayMin: 1111 } });

assert(meat.T.CONFIG.collectMode === 'click',
  `the stored collect mode is applied at load (${meat.T.CONFIG.collectMode})`);
assert(meat.T.CONFIG.clickDelayMin === 1111,
  `the stored timing is applied at load (${meat.T.CONFIG.clickDelayMin})`);
assert(meat.T.CONFIG.clickDelayMax === 2000,
  `keys that were never stored keep their default (${meat.T.CONFIG.clickDelayMax})`);

let reply = null;
meat.listeners[0]({ type: 'MEAT_CONFIG', config: { clickDelayMax: 2222 } }, {}, (r) => { reply = r; });
assert(reply && reply.ok === true, 'MEAT_CONFIG answers ok');
assert(meat.writes.length === 1, `MEAT_CONFIG is persisted (${meat.writes.length} write)`);
const saved = meat.writes[0] && meat.writes[0].meatConfig;
assert(saved && saved.clickDelayMax === 2222,
  `the new value is stored (${saved && saved.clickDelayMax})`);
assert(saved && saved.collectMode === 'click' && saved.clickDelayMin === 1111,
  'storing one field does not wipe the others');
