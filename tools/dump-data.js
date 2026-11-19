// tools/dump-data.js — paste in the game tab's console.
// Lists every text asset the client already loaded, with size and top-level keys, so we
// can tell which file holds the data we want (building times, troop stats, mixer recipes).
// It only reads: no click, no game action, nothing new reaches the server.
//
//   performance.setResourceTimingBufferSize(50000)   // then reload
(async () => {
  const TEXT = /\.(json|xml|atlas|txt|fnt|js)(\?|$)/i;
  const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name))]
    .filter((u) => TEXT.test(u));

  if (!urls.length) {
    console.warn('no text asset recorded: setResourceTimingBufferSize(50000) and reload');
    return [];
  }

  const rows = [];
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      let text;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        text = await res.text();
      } catch { continue; }
      const row = { url, bytes: text.length };
      try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object') {
          row.keys = Object.keys(value).slice(0, 8);
          const list = Object.values(value).find(Array.isArray);
          if (list) row.items = list.length;
        }
      } catch { /* not JSON: leave it without keys */ }
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  rows.sort((a, b) => b.bytes - a.bytes);
  console.table(rows.map((r) => ({
    file: r.url.replace(/^https?:\/\/[^/]+/, ''),
    KB: Math.round(r.bytes / 1024),
    items: r.items === undefined ? '' : r.items,
    keys: (r.keys || []).join(', '),
  })));

  if (typeof copy === 'function') {
    copy(JSON.stringify(urls, null, 1));
    console.log('URL list copied to the clipboard.');
    console.log('Next: node tools/fetch-assets.cjs --urls urls.json --out game-assets');
  }
  return rows;
})();
