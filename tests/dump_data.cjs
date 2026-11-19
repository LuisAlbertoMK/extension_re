// tools/dump-data.js runs in the game console, so it is tested against a fake page: it must
// list every loaded text asset with its keys, keep quiet when nothing was recorded, and
// hand over the URL list for the downloader.
const shim = require('./shim.cjs');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'dump-data.js'), 'utf8');

const FILES = {
  'https://game/defs/buildings.json': '{"buildings":[{"id":1},{"id":2},{"id":3}],"version":7,"meta":1}',
  'https://game/defs/troops.json': '{"troops":[{"id":1}],"cost":5}',
  'https://game/assets/ui.json': '{"frames":{"a":{}}}',
  'https://game/assets/logo.png': 'not text',
};

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

async function run(entries, copyOk = true) {
  const logs = [];
  let table = null;
  const copied = [];
  const sb = shim.makeSandbox();
  sb.performance = { getEntriesByType: () => entries.map((name) => ({ name })) };
  sb.fetch = async (url) => (FILES[url] === undefined
    ? { ok: false, status: 404, text: async () => '' }
    : { ok: true, status: 200, text: async () => FILES[url] });
  sb.console = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), table: (r) => { table = r; } };
  if (copyOk) sb.copy = (v) => copied.push(v);
  shim.vm.createContext(sb);
  const rows = await shim.vm.runInContext(SRC, sb);
  return { rows, table, copied, out: logs.join('\n') };
}

(async () => {
  const r = await run(Object.keys(FILES));

  assert(Array.isArray(r.table) && r.table.length === 3, `three text assets listed (${r.table && r.table.length})`);
  assert(!r.table.some((x) => /logo\.png/.test(x.file)), 'a binary asset is skipped');
  const b = r.table.find((x) => /buildings\.json/.test(x.file));
  assert(!!b, 'the building data file is listed');
  assert(b.items === 3, `its array length is shown (${b.items})`);
  assert(/buildings/.test(b.keys), `its keys are shown (${b.keys})`);
  assert(r.table[0].KB >= r.table[2].KB, 'the biggest file comes first');
  assert(r.copied.length === 1 && /buildings\.json/.test(r.copied[0]), 'the URL list is handed over');
  assert(/fetch-assets\.cjs/.test(r.out), 'the next command is printed');

  const empty = await run(['https://game/assets/logo.png']);
  assert(/setResourceTimingBufferSize/.test(empty.out), 'no recorded assets asks for the bigger buffer');

  const noCopy = await run(Object.keys(FILES), false);
  assert(noCopy.table && noCopy.table.length === 3, 'a missing copy() helper does not break it');
})();
