#!/usr/bin/env node
// Paste this in the game tab's DevTools console. It lists every asset the page has
// requested and copies the list as JSON, ready for:
//
//   node tools/fetch-assets.cjs --urls urls.json --out ../game-assets
//
// The console buffer only keeps ~250 entries by default, so run the two lines marked
// "step 1" first and reload the game before collecting.
//
//   step 1: performance.setResourceTimingBufferSize(50000)
//   step 2: paste the rest of this file once the game has loaded and you have opened
//           the screens you care about (the mixer, a building panel, ...).
(() => {
  const KEEP = /\.(png|jpe?g|webp|avif|ktx|atlas|json|xml|fnt|mp3|ogg|wav|woff2?|ttf)(\?|$)/i;
  const urls = [...new Set(
    performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => KEEP.test(u))
  )];
  const json = JSON.stringify(urls, null, 1);
  console.log(`${urls.length} asset URL(s) collected`);
  if (typeof copy === 'function') { copy(json); console.log('copied to the clipboard'); }
  else console.log(json);
  return urls.length;
})();
