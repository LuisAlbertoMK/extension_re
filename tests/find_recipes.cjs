// tools/find-recipes.js runs in the game's console, so the only way to keep it honest is
// to run it against a fake page: it must scan the recorded text assets, keep the ones that
// mention mixer/recipe-shaped data, and fall back to handing over the URL list when there
// is no client-side table at all.
const shim = require('./shim.cjs');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'find-recipes.js'), 'utf8');

const FILES = {
  'https://game/assets/ui0926/ui.json': '{"atlas":{"width":2048},"frames":{"icoWoodMC":{}}}',
  'https://game/defs/souls.json': '{"soulMixer":{"recipes":[{"a":1,"b":2,"out":3}]},"version":7}',
  'https://game/defs/buildings.json': '{"buildings":[{"id":1,"name":"Farm"}]}',
  'https://game/assets/logo.png': 'not text',
};

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

async function run({ entries, copyOk = true }) {
  const logs = [];
  const sb = shim.makeSandbox();
  sb.performance = {
    getEntriesByType: () => entries.map((name) => ({ name })),
  };
  sb.fetch = async (url) => {
    const body = FILES[url];
    return body === undefined
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => body };
  };
  const copied = [];
  if (copyOk) sb.copy = (v) => copied.push(v);
  sb.console = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('WARN ' + a.join(' ')),
    table: () => {},
  };
  shim.vm.createContext(sb);
  await shim.vm.runInContext(SRC, sb);
  return { logs, copied, out: logs.join('\n') };
}

(async () => {
  // 1. Only the file that mentions mixer data is reported.
  let r = await run({ entries: Object.keys(FILES) });
  assert(/scanned 3, failed 0, 1 candidate/.test(r.out), `one candidate out of three text assets (${r.out.split('\n').find(l => l.startsWith('scanned'))})`);
  assert(/souls\.json/.test(r.out), 'the mixer data file is the one reported');
  assert(!/buildings\.json/.test(r.out), 'an unrelated data file is not a candidate');
  assert(/soulMixer/.test(r.out), 'its keys are shown, so the shape is readable');
  assert(r.copied.length === 1, `the candidates are copied once (${r.copied.length})`);
  assert(/"recipes"/.test(r.copied[0]), 'the clipboard holds the candidate details');

  // 2. Nothing client-side: hand over the asset list instead of pretending it found data.
  FILES['https://game/defs/plain.json'] = '{"a":1}';
  r = await run({ entries: ['https://game/defs/plain.json'] });
  delete FILES['https://game/defs/plain.json'];
  assert(/no client-side recipe table/.test(r.out), 'an empty result says the table is server-side');
  assert(r.copied.length === 1 && /defs\/plain\.json/.test(r.copied[0]),
    'the asset list is handed over for the downloader');

  // 3. A page with no recorded assets must ask for the bigger buffer, not crash.
  r = await run({ entries: ['https://game/assets/logo.png'] });
  assert(/setResourceTimingBufferSize/.test(r.out), 'no recorded assets asks for the bigger buffer');

  // 4. Without DevTools' copy() helper it still prints instead of throwing.
  r = await run({ entries: Object.keys(FILES), copyOk: false });
  assert(/candidate/.test(r.out), 'a missing copy() helper does not break the scan');

  // 5. A file that fails to download is counted, not fatal.
  r = await run({ entries: ['https://game/defs/missing.json'] });
  assert(/failed 1/.test(r.out), `a failed download is counted (${r.out.split('\n').find(l => l.startsWith('scanned'))})`);
})();
