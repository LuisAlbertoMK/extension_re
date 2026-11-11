// Deterministic synthetic frames for the detector regression tests.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function base(w, h, seed) {
  const r = rng(seed), d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = r() * 26;
    d[i * 4] = 48 + n; d[i * 4 + 1] = 96 + n; d[i * 4 + 2] = 52 + n; d[i * 4 + 3] = 255;
  }
  return { d, r };
}
function rect(d, w, x0, y0, bw, bh, R, G, B) {
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
    const q = (y * w + x) * 4;
    d[q] = R; d[q + 1] = G; d[q + 2] = B; d[q + 3] = 255;
  }
}
module.exports = { rng, base, rect };
