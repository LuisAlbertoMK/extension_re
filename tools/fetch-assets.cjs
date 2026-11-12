#!/usr/bin/env node
// Downloads the game's asset files into a local folder, without the browser's
// per-file "keep this download?" prompt.
//
//   node tools/fetch-assets.cjs --urls urls.json --out ../game-assets
//   node tools/fetch-assets.cjs --seed https://host/client/ui0926/ui.json --out ../game-assets
//
// Every JSON/text file that is downloaded is scanned for asset-looking paths, and those
// are queued too, so an atlas or a UI index pulls in the images it references.
const fs = require('fs');
const path = require('path');

const ASSET_RE = /[\w./-]+\.(?:png|jpe?g|webp|avif|ktx|atlas|json|xml|fnt|mp3|ogg|wav|woff2?|ttf)\b/gi;

function parseArgs(argv) {
  const a = { concurrency: 6, out: null, urls: null, seed: null, base: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--out') { a.out = v; i++; }
    else if (k === '--urls') { a.urls = v; i++; }
    else if (k === '--seed') { a.seed = v; i++; }
    else if (k === '--base') { a.base = v; i++; }
    else if (k === '--concurrency') { a.concurrency = Math.max(1, Number(v) || 1); i++; }
    else if (k === '--force') a.force = true;
  }
  return a;
}

// Keeps the URL path under the output folder and refuses to escape it.
function localPath(out, url) {
  const u = new URL(url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(out, clean);
  return full.startsWith(path.resolve(out)) ? full : null;
}

async function fetchOne(url, out, force) {
  const file = localPath(out, url);
  if (!file) return { url, skipped: 'outside the output folder' };
  const isText = /\.(json|xml|atlas|fnt|txt)$/i.test(new URL(url).pathname);
  if (!force && fs.existsSync(file)) {
    // A skipped index still has to be parsed, or its images are never queued.
    return { url, skipped: 'already downloaded', refs: isText ? references(fs.readFileSync(file, 'utf8'), url) : null };
  }
  const res = await fetch(url, { headers: { 'user-agent': 'asset-fetcher' } });
  if (!res.ok) return { url, error: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return {
    url, bytes: buf.length, type: res.headers.get('content-type') || '',
    refs: isText ? references(buf.toString('utf8'), url) : null,
  };
}

// Asset paths referenced by a downloaded JSON/text file, resolved against its URL.
function references(text, from) {
  const out = new Set();
  for (const m of text.matchAll(ASSET_RE)) {
    const ref = m[0];
    try {
      const abs = new URL(ref, from).href;
      if (/^https?:/.test(abs)) out.add(abs);
    } catch { /* not a URL */ }
  }
  return [...out];
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.out) {
    console.error('missing --out <folder>');
    process.exit(2);
  }
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });

  const queue = [];
  const seen = new Set();
  const add = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    queue.push(u);
  };

  if (args.urls) {
    const list = JSON.parse(fs.readFileSync(path.resolve(args.urls), 'utf8'));
    for (const u of Array.isArray(list) ? list : list.urls || []) {
      add(new URL(u, args.base || undefined).href);
    }
  }
  if (args.seed) add(new URL(args.seed).href);
  if (!queue.length) {
    console.error('nothing to download: pass --urls <file.json> or --seed <url>');
    process.exit(2);
  }

  const stats = { ok: 0, skipped: 0, failed: 0, bytes: 0 };
  const failures = [];
  let active = 0, done = 0;
  const total0 = queue.length;

  await new Promise((resolve) => {
    const pump = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < args.concurrency && queue.length) {
        const url = queue.shift();
        active++;
        fetchOne(url, out, args.force)
          .then((r) => {
            done++;
            if (r.error) { stats.failed++; failures.push(`${url} -> ${r.error}`); }
            else {
              if (r.skipped) stats.skipped++;
              else { stats.ok++; stats.bytes += r.bytes; }
              if (r.refs) for (const ref of r.refs) add(ref);
            }
            if (done % 50 === 0) console.log(`${done}/${total0} (+${queue.length} queued) ...`);
          })
          .catch((e) => { stats.failed++; failures.push(`${url} -> ${e.message}`); })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  });

  console.log(`\ndownloaded ${stats.ok} file(s), ${(stats.bytes / 1048576).toFixed(1)} MB, skipped ${stats.skipped}, failed ${stats.failed}`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures.slice(0, 20)) console.log('  ' + f);
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
  }
  console.log(`saved under ${out}`);
  process.exit(failures.length ? 1 : 0);
}

main();


