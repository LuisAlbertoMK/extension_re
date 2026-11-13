// tools/find-recipes.js — paste this in the game tab's DevTools console.
//
// It looks for the mixer's recipe table inside the data the client already loaded.
// Nothing is clicked and no game action is sent: it only reads the asset list the page
// produced and re-downloads those same static files, so the server sees exactly what it
// sees when you reload the game.
//
// Before pasting, run this once and reload, or the resource buffer keeps only ~250 entries:
//
//   performance.setResourceTimingBufferSize(50000)
//
// Then open the Soul Mixer once (so its data file loads) and paste the rest of this file.
(async () => {
  const KEY = /soul|mix|fusion|mezcla|recipe|combin|alma|monster|breed/i;
  const TEXT = /\.(json|xml|atlas|txt|fnt|js)(\?|$)/i;

  const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name))]
    .filter((u) => TEXT.test(u));

  if (!urls.length) {
    console.warn('no text asset recorded: run performance.setResourceTimingBufferSize(50000) and reload');
    return;
  }
  console.log(`${urls.length} text asset(s) to scan`);

  const hits = [];
  let scanned = 0, failed = 0;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      let text = '';
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } catch {
        failed++;
        continue;
      }
      scanned++;
      const head = text.slice(0, 300000);
      if (!KEY.test(url) && !KEY.test(head)) continue;
      hits.push({
        url,
        bytes: text.length,
        // The keys are what matter: they say whether this file is a recipe table at all.
        keys: (head.match(/"[A-Za-z_][A-Za-z0-9_]{2,30}"\s*:/g) || [])
          .map((k) => k.replace(/["\s:]/g, '')).slice(0, 40),
        sample: head.slice(0, 600),
      });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  console.log(`scanned ${scanned}, failed ${failed}, ${hits.length} candidate file(s)`);
  if (!hits.length) {
    console.warn('no client-side recipe table found: the mixer is probably server-side');
    console.log('the full asset list is in your clipboard, for: node tools/fetch-assets.cjs --urls urls.json --out game-assets');
    if (typeof copy === 'function') copy(JSON.stringify(urls, null, 1));
    return;
  }
  console.table(hits.map((h) => ({ url: h.url, bytes: h.bytes, keys: h.keys.length })));
  hits.forEach((h) => console.log(`\n=== ${h.url}\n${h.keys.join(', ')}\n${h.sample}`));
  if (typeof copy === 'function') {
    copy(JSON.stringify(hits, null, 1));
    console.log('candidates copied to the clipboard: paste them back here');
  }
})();
