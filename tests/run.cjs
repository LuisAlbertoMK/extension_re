// Detector regression tests. Golden-file based: run `node tests/run.cjs --update`
// after an intentional threshold change, then `node tests/run.cjs` to verify.
const shim = require('./shim.cjs');
const { path, fs } = shim;
const { base, rect } = require('./frames.cjs');
const GOLD = path.join(__dirname, 'golden.json');

function meatFrame(w, h, seed) {
  const { d, r } = base(w, h, seed);
  for (let k = 0; k < 6; k++) {
    const bs = 24 + Math.floor(r() * 20);
    const x = 40 + Math.floor(r() * (w - 120)), y = 40 + Math.floor(r() * (h - 120));
    rect(d, w, x, y, bs, bs, 245, 245, 245);
    const n = Math.max(8, Math.floor(bs * 0.55));
    rect(d, w, x + ((bs - n) >> 1), y + ((bs - n) >> 1), n, n, 190, 45, 40);
  }
  rect(d, w, 300, 50, 400, 8, 252, 252, 252);
  return { w, h, data: d };
}

function woodFrame(w, h, seed) {
  const { d, r } = base(w, h, seed);
  for (let k = 0; k < 10; k++) {
    const bs = 4 + Math.floor(r() * 14);
    const x = 140 + Math.floor(r() * (w - 320)), y = 160 + Math.floor(r() * (h - 340));
    rect(d, w, x, y, bs, bs, 175, 105, 70);
    rect(d, w, x - 6, y - 12, bs + 12, 12, 60, 150, 60);
  }
  return { w, h, data: d };
}

function resFrame(w, h, seed) {
  const { d, r } = base(w, h, seed);
  const cols = [[220, 40, 40], [150, 95, 45], [220, 190, 40], [150, 150, 150]];
  for (let k = 0; k < 8; k++) {
    const bw = 32 + Math.floor(r() * 26), bh = 32 + Math.floor(r() * 26);
    const x = 140 + Math.floor(r() * (w - 300)), y = 160 + Math.floor(r() * (h - 340));
    rect(d, w, x, y, bw, bh, 250, 250, 250);
    const c = cols[k % 4];
    rect(d, w, x + ((bw - 12) >> 1), y + ((bh - 12) >> 1), 12, 12, c[0], c[1], c[2]);
  }
  return { w, h, data: d };
}

const SIZE = [[1600, 900]];

async function measure(name, file, exp) {
  const T = shim.load(file, exp);
  const rows = [];
  for (const [w, h] of SIZE) {
    if (name === 'meat') {
      shim.CUR = meatFrame(w, h, 7);
      const r = await T.analyzeScreenshot('x');
      rows.push(r.targets.map(t => [t.canvasX, t.canvasY, t.boxW, t.boxH]).sort());
    } else {
      const f = name === 'wood' ? woodFrame(w, h, 7) : resFrame(w, h, 7);
      const out = T.detect({ width: w, height: h, _data: f.data });
      const list = Array.isArray(out) ? out : out.items;
      rows.push(list.map(t => [Math.round(t.x), Math.round(t.y), t.size || 0]).sort());
    }
  }
  return rows;
}

(async () => {
  const update = process.argv.includes('--update');
  const known = fs.existsSync(GOLD) ? JSON.parse(fs.readFileSync(GOLD, 'utf8')) : {};
  const next = {};
  let bad = 0;
  for (const [name, file, exp] of [
    ['meat', 'meat.js', '{ analyzeScreenshot }'],
    ['wood', 'wood.js', '{ detect }'],
    ['res', 'resources.js', '{ detect }'],
  ]) {
    const rows = await measure(name, file, exp);
    next[name] = rows;
    if (update) { console.log(`updated ${name}: ${rows.map(r => r.length).join('/')}`); continue; }
    if (JSON.stringify(known[name]) !== JSON.stringify(rows)) {
      bad++;
      console.log(`FAIL ${name}`);
      console.log('  want', JSON.stringify(known[name] || null).slice(0, 320));
      console.log('  got ', JSON.stringify(rows).slice(0, 320));
    } else {
      console.log(`ok ${name}: ${rows.map(r => r.length).join('/')} targets`);
    }
  }
  if (update) { fs.writeFileSync(GOLD, JSON.stringify(next)); console.log('golden.json written'); }
  process.exit(bad ? 1 : 0);
})();

