// content/meat.js - Recolector de carne (corre en el contexto de la pagina del juego)
// Envuelto en IIFE: el modulo de madera comparte este mundo aislado, por lo que
// ninguna variable de nivel superior puede filtrarse entre los dos scripts.
(() => {
  'use strict';

  const CONFIG = {
    // Idle gap between runs. The map refills slower than a full pass takes, so a long
    // skip just leaves items uncollected.
    minDelay: 10000,
    maxDelay: 25000,
    dragMinDelay: 30000,
    dragMaxDelay: 40000,
    // Pause between clicks (ms). Human pace for picking up items one by one.
    clickDelayMin: 1200,
    clickDelayMax: 2500,
    // Occasional longer pause, like getting distracted mid-run.
    distractionChance: 0.05,
    distractionMin: 2000,
    distractionMax: 3500,
    // Chance of skipping a whole run, like not noticing the items at all.
    skipCycleChance: 0.12,
    // Idle before the first run of a session: opening the game and collecting on the
    // same tick is not what a person does. Kept short so a broken start is obvious.
    startDelayMin: 2000,
    startDelayMax: 5000,
    // Chance of breaking the optimal path by doubling back to a far item.
    detourChance: 0.15,
    // One longer pause somewhere in a run, so the run length is not a near-constant.
    runPauseChance: 0.2,
    runPauseMin: 3000,
    runPauseMax: 7000,
    // Hard session cap: the collector stops itself after a random 20-30 minutes.
    sessionMinMs: 20 * 60 * 1000,
    sessionMaxMs: 30 * 60 * 1000,
    // Anti-bot: delay before the first click
    preClickDelay: 300,
    // Anti-bot: click position jitter (px)
    clickJitter: 3,
    // Cursor travel time bounds (ms). Duration is derived from distance, so a short hop
    // is quick and a long one is slow - never the other way around.
    moveMinMs: 90,
    moveMaxMs: 700,
    // Fraction of the icons on screen clicked per cycle (random inside this range)
    clickRatioMin: 1.0,
    clickRatioMax: 1.0,
    // Hard safety ceiling, so a bad calibration can never fire hundreds of clicks
    maxClicksPerCycle: 60,
    // Thresholds to detect the WHITE BOX of the meat icon
    whiteThreshold: { rMin: 200, gMin: 200, bMin: 200 },
    // Bounding box size of the white box
    minBoxSize: 20,
    maxBoxSize: 50,
    // Minimum red pixels inside the box
    minRedPixelsInside: 50,
    // Maximum red pixels inside the box
    maxRedPixelsInside: 1500,
    // Minimum white pixel ratio on the box border
    minWhiteBorderRatio: 0.3,
    enabled: true,
    // 'drag' sweeps the cursor over every icon with the button held (one gesture);
    // 'click' clicks them one by one. Drag is much faster but only works if the game
    // collects on cursor-over while pressed.
    collectMode: 'mixed',
    // Probability that a 'mixed' cycle sweeps instead of clicking one by one. It drifts
    // from the low value to the high one across the session instead of staying fixed.
    mixedDragChanceMin: 0.3,
    mixedDragChanceMax: 0.7,
    // Drag speed in px/ms and the hard duration cap for one gesture.
    dragSpeed: 0.9,
    dragMinMs: 3000,
    dragMaxMs: 5000,
    dragJitter: 5
  };

  let running = false;
  let liveOverlay = false; // calibration mode: keep the detection overlay updated each cycle
  let lastTargets = [];    // last detection, used to repaint after a viewport change
  let sessionEndsAt = 0;   // wall-clock deadline for the current run
  let sessionStartedAt = 0; // used to drift the drag/click mix across the session
  let zeroStreak = 0;      // consecutive cycles that detected nothing
  let stopReason = '';
  const stats = { collected: 0, cycles: 0, lastFound: 0 };
  let nextCollectionTime = null;
  // Consecutive cycles that detected nothing. Used to decide when a lossless re-check
  // of an empty frame is worth its cost.
  let usedDragThisCycle = false; // whether this cycle's burst was a drag sweep

  // Anti-bot: history of clicked positions (last 4 cycles)
  const clickHistory = []; // array of arrays of "x,y" strings
  const MAX_HISTORY = 4;
  const MAX_REPEATS = 4; // max consecutive clicks on the same position

  // Anti-bot: pause when the tab is not visible
  let isTabVisible = !document.hidden;

  function getCanvasRect() {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return {
      top: r.top, left: r.left,
      width: r.width, height: r.height,
      canvasW: canvas.width, canvasH: canvas.height
    };
  }

  function screenshotToCanvas(sx, sy, canvasRect) {
    const scaleX = canvasRect.width / canvasRect.canvasW;
    const scaleY = canvasRect.height / canvasRect.canvasH;
    return {
      x: Math.round((sx - canvasRect.left) / scaleX),
      y: Math.round((sy - canvasRect.top) / scaleY)
    };
  }

  // Reused between cycles. A screenshot-sized canvas plus the pixel masks are ~10 MB
  // at 1080p; rebuilding them on every cycle is nothing but GC pressure, and every
  // capture has the same dimensions anyway.
  let scratchCanvas = null;
  let scratchCtx = null;
  let pixelMask = null;   // bit0 white, bit1 red, bit2 visited, bit3 opaque
  let floodQueue = null;

  function ensureScratch(w, h) {
    if (!scratchCanvas) {
      scratchCanvas = document.createElement('canvas');
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
      scratchCanvas.width = w;
      scratchCanvas.height = h;
    }
    if (!pixelMask || pixelMask.length !== w * h) {
      pixelMask = new Uint8Array(w * h);
      floodQueue = new Int32Array(w * h);
    }
    return scratchCtx;
  }

  function analyzeScreenshot(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // Without this handler the promise never settles and the collect loop dies silently.
      img.onerror = () => reject(new Error('screenshot decode failed'));
      img.onload = () => {
        try {
          const w = img.width;
          const h = img.height;
          const ctx = ensureScratch(w, h);
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, w, h).data;

          const mask = pixelMask;
          const total = w * h;

          // One linear pass classifies every pixel into a bitmask. The previous version
          // allocated a {r,g,b,a} object and an "x,y" string per pixel (millions of
          // allocations per cycle) and used Set lookups inside the flood fill.
          const { rMin, gMin, bMin } = CONFIG.whiteThreshold;
          for (let i = 0, p = 0; i < total; i++, p += 4) {
            if (data[p + 3] <= 128) { mask[i] = 0; continue; }
            const r = data[p], g = data[p + 1], b = data[p + 2];
            let f = 8; // opaque
            if (r >= rMin && g >= gMin && b >= bMin) f |= 1;
            if (r >= 150 && g <= 130 && b <= 120 && r > g + 20 && r > b + 20) f |= 2;
            mask[i] = f;
          }

          // STEP 1: find connected white regions (boxes) via 4-neighbour flood fill.
          // Only the bounding box and the pixel count are kept, which is all the checks
          // below need; the old per-pixel region arrays were pure overhead.
          const whiteRegions = [];
          const q = floodQueue;

          for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
              const start = row + x;
              if ((mask[start] & 5) !== 1) continue; // white and not yet visited

              let head = 0, tail = 0;
              q[tail++] = start;
              mask[start] |= 4;
              let size = 0, minX = x, maxX = x, minY = y, maxY = y;

              // Indexed queue instead of Array#shift(): shift() is O(n), which made a
              // large white area quadratic. A typed array also cannot blow the stack.
              while (head < tail) {
                const i = q[head++];
                const px = i % w;
                const py = (i - px) / w;
                size++;
                if (px < minX) minX = px; else if (px > maxX) maxX = px;
                if (py < minY) minY = py; else if (py > maxY) maxY = py;

                if (px > 0) { const n = i - 1; if ((mask[n] & 5) === 1) { mask[n] |= 4; q[tail++] = n; } }
                if (px + 1 < w) { const n = i + 1; if ((mask[n] & 5) === 1) { mask[n] |= 4; q[tail++] = n; } }
                if (py > 0) { const n = i - w; if ((mask[n] & 5) === 1) { mask[n] |= 4; q[tail++] = n; } }
                if (py + 1 < h) { const n = i + w; if ((mask[n] & 5) === 1) { mask[n] |= 4; q[tail++] = n; } }
              }

              whiteRegions.push({ size, minX, minY, maxX, maxY });
            }
          }

          const countRed = (minX, minY, maxX, maxY) => {
            let n = 0;
            const width = maxX - minX + 1;
            for (let py = minY; py <= maxY; py++) {
              for (let i = py * w + minX, end = i + width; i < end; i++) {
                if (mask[i] & 2) n++;
              }
            }
            return n;
          };

          // STEP 2: for each white region, check whether it contains red inside
          const validIcons = [];

          for (const region of whiteRegions) {
            const { minX, minY, maxX, maxY } = region;
            const boxW = maxX - minX + 1;
            const boxH = maxY - minY + 1;

            if (boxW < CONFIG.minBoxSize || boxH < CONFIG.minBoxSize) continue;
            if (boxW > CONFIG.maxBoxSize || boxH > CONFIG.maxBoxSize) continue;

            // Aspect ratio (should be roughly square)
            const aspect = boxW / boxH;
            if (aspect < 0.6 || aspect > 1.7) continue;

            const redInside = countRed(minX, minY, maxX, maxY);
            if (redInside < CONFIG.minRedPixelsInside) continue;
            if (redInside > CONFIG.maxRedPixelsInside) continue;

            // The bounding box border must be mostly white
            let borderWhite = 0;
            let borderTotal = 0;
            for (let dy = 0; dy < boxH; dy++) {
              for (let dx = 0; dx < boxW; dx++) {
                if (dx > 0 && dx < boxW - 1 && dy > 0 && dy < boxH - 1) continue;
                const m = mask[(minY + dy) * w + minX + dx];
                if (m & 8) {
                  borderTotal++;
                  if (m & 1) borderWhite++;
                }
              }
            }
            const borderRatio = borderTotal > 0 ? borderWhite / borderTotal : 0;
            if (borderRatio < CONFIG.minWhiteBorderRatio) continue;

            const centerX = Math.round((minX + maxX) / 2);
            const centerY = Math.round((minY + maxY) / 2);

            validIcons.push({
              minX, minY, maxX, maxY,
              boxW, boxH,
              redInside,
              borderRatio: Math.round(borderRatio * 100),
              whitePixels: region.size,
              centerX, centerY
            });
          }

          let canvasRect = getCanvasRect();
          if (!canvasRect) {
            resolve({ whiteRegionCount: whiteRegions.length, validCount: validIcons.length, targets: [], error: 'no canvas' });
            return;
          }
          // A canvas whose backing store or CSS box is still 0 makes the scale infinite
          // and silently drops every target. Fall back to the screenshot size (1:1).
          if (!canvasRect.canvasW || !canvasRect.canvasH || !canvasRect.width || !canvasRect.height) {
            canvasRect = {
              top: 0, left: 0, width: w, height: h,
              canvasW: w, canvasH: h
            };
          }

          const targets = validIcons.map(icon => {
          const canvasPos = screenshotToCanvas(icon.centerX, icon.centerY, canvasRect);
          return {
            screenshotX: icon.centerX,
            screenshotY: icon.centerY,
            canvasX: canvasPos.x,
            canvasY: canvasPos.y,
            boxW: icon.boxW,
            boxH: icon.boxH,
            boxSize: `${icon.boxW}x${icon.boxH}`,
            redInside: icon.redInside,
            borderRatio: icon.borderRatio
          };
        });

        const canvasTargets = targets.filter(t =>
          t.canvasX >= 0 && t.canvasX <= canvasRect.canvasW &&
          t.canvasY >= 0 && t.canvasY <= canvasRect.canvasH
        );

        // Verbose diagnostics only in calibration mode. Counting red pixels for every
        // white region is expensive (1014 regions in a busy field), so it must not run
        // on normal cycles. Reuses the bounding boxes already computed above.
        if (liveOverlay) {
          const sortedRegions = whiteRegions.map(region => ({
            size: region.size,
            boxW: region.maxX - region.minX + 1,
            boxH: region.maxY - region.minY + 1,
            redInside: countRed(region.minX, region.minY, region.maxX, region.maxY),
            minX: region.minX,
            minY: region.minY,
            maxX: region.maxX,
            maxY: region.maxY
          })).sort((a, b) => b.size - a.size);

          sortedRegions.slice(0, 10).forEach((r, i) => {
          });
          if (validIcons.length > 0 && validIcons.length <= 25) {
            validIcons.forEach((icon, i) => {
            });
          }
        }

          resolve({
            whiteRegionCount: whiteRegions.length,
            validCount: validIcons.length,
            targets: canvasTargets
          });
        } catch (e) {
          reject(e);
        }
      };
      img.src = dataUrl;
    });
  }

  // Sample a polyline every `stepPx` so the cursor sweeps smoothly instead of jumping
  // between icons: the game samples the cursor position while the button is held.
  function densify(points, stepPx = 8) {
    if (points.length < 2) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / stepPx));
      for (let k = 1; k <= n; k++) {
        out.push({
          x: Math.round(a.x + (b.x - a.x) * k / n),
          y: Math.round(a.y + (b.y - a.y) * k / n),
        });
      }
    }
    return out;
  }

  // Adds a smooth perpendicular wobble that fades at both ends (so the gesture still
  // starts and ends on an icon) plus a few weighted points so the cursor hesitates
  // instead of gliding at constant speed. Both are what makes the sweep stop looking
  // like a mathematical interpolation.
  function humanizePath(points, jitterPx = 5) {
    if (points.length < 3) return points;
    const D = [0];
    for (let i = 1; i < points.length; i++) {
      D.push(D[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    const total = D[D.length - 1] || 1;
    const phase = Math.random() * Math.PI * 2;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const t = D[i] / total;
      const taper = Math.sin(t * Math.PI);
      if (i === 0 || i === points.length - 1) {
        out.push({ x: p.x, y: p.y, w: 1 });
        continue;
      }
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const wob = Math.sin(t * total * 0.012 + phase) * jitterPx * taper;
      out.push({
        x: Math.round(p.x - (dy / len) * wob),
        y: Math.round(p.y + (dx / len) * wob),
        w: 1,
      });
    }
    const pauses = 2 + Math.floor(Math.random() * 2);
    for (let k = 0; k < pauses; k++) {
      const at = 2 + Math.floor(Math.random() * Math.max(1, out.length - 4));
      if (out[at]) out[at].w = 4 + Math.random() * 8;
    }
    return out;
  }

  // How often a 'mixed' cycle should sweep. Drifts from the low to the high bound as the
  // session advances, plus a little noise, so the mix is never the same constant.
  function dragChanceNow() {
    const span = sessionEndsAt - sessionStartedAt;
    const t = span > 0 ? Math.min(1, Math.max(0, (Date.now() - sessionStartedAt) / span)) : 0;
    const base = CONFIG.mixedDragChanceMin + (CONFIG.mixedDragChanceMax - CONFIG.mixedDragChanceMin) * t;
    return Math.min(0.9, Math.max(0.1, base + (Math.random() - 0.5) * 0.15));
  }

  async function clickAtCanvasPositions(targets) {
    const done = [];
    const canvas = document.querySelector('canvas');
    if (!canvas) return done;

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;

    const input = window.__SRToolkit?.input;
    if (!input) {
      return done;
    }

    // Resolve every target to client coordinates once, with its own jitter.
    const points = targets.map((t) => {
      const jx = Math.round((Math.random() - 0.5) * CONFIG.clickJitter * 2);
      const jy = Math.round((Math.random() - 0.5) * CONFIG.clickJitter * 2);
      return {
        x: Math.round(rect.left + t.canvasX * scaleX) + jx,
        y: Math.round(rect.top + t.canvasY * scaleY) + jy,
        t
      };
    });

    // Visit them by proximity (picking randomly among the 3 nearest) instead of in a
    // random order. Long hops force an impossible cursor speed, which is what makes
    // the hand look robotic; short hops also read as more human than teleporting.
    const ordered = [];
    const pool = [...points];
    let cur = input.position || { x: innerWidth / 2, y: innerHeight / 2 };
    while (pool.length) {
      const ranked = pool
        .map((p, i) => ({ p, i, d: Math.hypot(p.x - cur.x, p.y - cur.y) }))
        .sort((a, b) => a.d - b.d);
      // Usually take one of the 3 nearest; occasionally double back to a far item.
      // An always-optimal route is its own fingerprint.
      const pick = Math.random() < CONFIG.detourChance
        ? ranked[Math.floor(Math.random() * ranked.length)]
        : ranked[Math.floor(Math.random() * Math.min(3, ranked.length))];
      ordered.push(pick.p);
      pool.splice(pick.i, 1);
      cur = { x: pick.p.x, y: pick.p.y };
    }

    // Anti-bot: initial delay before the first click
    await new Promise(resolve => setTimeout(resolve, CONFIG.preClickDelay));

    // 'mixed' alternates between one sweep and a click-by-click run: neither a pure
    // dragger nor a pure clicker, which is closer to how a person actually farms.
    const useDrag = CONFIG.collectMode === 'drag'
      || (CONFIG.collectMode === 'mixed' && Math.random() < dragChanceNow());
    if (useDrag && typeof input.drag === 'function') {      // Route pattern varies per cycle, the same way the click path does: a compact
      // nearest-neighbour tour, a left-to-right sweep, a top-to-bottom sweep, or a
      // straight shuffle. Always sweeping the same way is its own fingerprint.
      const route = ['tour', 'ltr', 'ttb', 'random'][Math.floor(Math.random() * 4)];
      const pts = ordered.map(q => ({ x: q.x, y: q.y }));
      if (route === 'ltr') pts.sort((a, b) => a.x - b.x || a.y - b.y);
      else if (route === 'ttb') pts.sort((a, b) => a.y - b.y || a.x - b.x);
      else if (route === 'random') {
        for (let i = pts.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pts[i], pts[j]] = [pts[j], pts[i]];
        }
      }

      const raw = densify(pts);
      // Arrive at the first icon before pressing: a press that teleports from the last
      // cursor position is both suspicious and may miss a hover-gated pickup.
      const dist0 = Math.hypot(raw[0].x - cur.x, raw[0].y - cur.y);
      await input.moveTo(raw[0].x, raw[0].y, Math.min(500, Math.max(90, Math.round(dist0 * 0.6))));
      let dist = Math.hypot(raw[0].x - cur.x, raw[0].y - cur.y);
      for (let i = 1; i < raw.length; i++) {
        dist += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
      }
      const path = humanizePath(raw, CONFIG.dragJitter);
      const duration = Math.min(
        CONFIG.dragMaxMs,
        Math.max(CONFIG.dragMinMs, Math.round(dist / CONFIG.dragSpeed))
      );
      const ok = await input.drag(path, duration);
      if (ok) {
        stats.collected += ordered.length;
        usedDragThisCycle = true;
        for (const q of ordered) done.push(`${q.t.canvasX},${q.t.canvasY}`);
      }
      return done;
    }

    // One longer pause at a random point in the run, so its total length varies
    // (roughly 40-55 s) instead of being a near-constant ~40 s.
    const pauseAt = Math.random() < CONFIG.runPauseChance
      ? Math.floor(Math.random() * ordered.length)
      : -1;

    for (let i = 0; i < ordered.length; i++) {
      // Stop is asynchronous: without this the burst keeps clicking for up to a minute
      // after the user presses Stop (or the tab is hidden, or the session cap hits).
      if (!running || !isTabVisible || Date.now() >= sessionEndsAt) {
        break;
      }
      const p = ordered[i];
      const t = p.t;

      // Cursor speed is derived from the distance, not from the click interval:
      // ~0.5-0.9 ms per pixel lands around 1100-2000 px/s, inside human range.
      const dist = Math.hypot(p.x - cur.x, p.y - cur.y);
      cur = { x: p.x, y: p.y };
      const travel = Math.round(dist * (0.5 + Math.random() * 0.4));
      const moveMs = Math.min(CONFIG.moveMaxMs, Math.max(CONFIG.moveMinMs, travel));

      const t0 = performance.now();
      await input.moveTo(p.x, p.y, moveMs);

      if (await input.click(p.x, p.y)) {
        stats.collected++;
        done.push(`${t.canvasX},${t.canvasY}`);
      } else {
      }

      // Pause between clicks, on top of the travel time. Occasional long pause so the
      // timing distribution has the heavy tail a human has, instead of being uniform.
      let pause = CONFIG.clickDelayMin + Math.random() * (CONFIG.clickDelayMax - CONFIG.clickDelayMin);
      if (Math.random() < CONFIG.distractionChance) {
        pause += CONFIG.distractionMin + Math.random() * (CONFIG.distractionMax - CONFIG.distractionMin);
      }
      const rest = pause - (performance.now() - t0 - moveMs);
      if (rest > 5) await new Promise(resolve => setTimeout(resolve, rest));

      if (i === pauseAt) {
        const extra = CONFIG.runPauseMin + Math.random() * (CONFIG.runPauseMax - CONFIG.runPauseMin);
        await new Promise(resolve => setTimeout(resolve, extra));
      }
    }
    return done;
  }

  async function collectCycle() {
    if (!running || !CONFIG.enabled) return;
    if (!isTabVisible) {
      return;
    }

    // Sometimes a human just does not notice the items. Skip the whole run.
    if (Math.random() < CONFIG.skipCycleChance) {
      return;
    }

    try {
      const response = await capture('jpeg');
      if (!response || response.error) {
        return;
      }

      let result = await analyzeScreenshot(response.dataUrl);

      // JPEG's 4:2:0 chroma subsampling softens the thin white border of the icon, so a
      // frame that finds nothing gets a lossless re-check before we call the field empty.
      // Only on the first empty cycle and then every 4th: a genuinely empty map must not
      // pay a PNG capture on every single cycle.
      if (result.targets.length === 0) {
        zeroStreak++;
        // When the user pinned PNG the fast path was already lossless, so a second
        // capture would be the identical image.
        const alreadyLossless = window.__SRToolkit?.captureFormat === 'png';
        if (!alreadyLossless && (zeroStreak === 1 || zeroStreak % 4 === 0)) {
          const lossless = await capture('png');
          if (lossless && !lossless.error) {
            const retry = await analyzeScreenshot(lossless.dataUrl);
            if (retry.targets.length > 0) { result = retry; zeroStreak = 0; }
          }
        }
      } else {
        zeroStreak = 0;
      }

      stats.lastFound = result.targets.length;

      // Keep the calibration view in sync with what was just detected (and never let
      // a stale overlay survive a clear).
      if (liveOverlay && window.__SRToolkit?.hasOverlay('meat')) {
        drawOverlay(result.targets);
      } else {
        liveOverlay = false;
      }


      if (result.targets.length > 0) {
        // Anti-bot: skip positions clicked too many times in a row
        const filteredTargets = result.targets.filter(t => {
          const posKey = `${t.canvasX},${t.canvasY}`;
          let recentCount = 0;
          for (const cycle of clickHistory) {
            if (cycle.includes(posKey)) recentCount++;
          }
          if (recentCount >= MAX_REPEATS) {
            return false;
          }
          return true;
        });

        if (filteredTargets.length === 0) {
          stats.cycles++;
          broadcastStats();
          return;
        }

        // Click a random 85-100% of the icons on screen. Shuffle first so the ones
        // left out vary between cycles instead of always being the bottom rows.
        const pool = [...filteredTargets];
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const ratio = CONFIG.clickRatioMin + Math.random() * (CONFIG.clickRatioMax - CONFIG.clickRatioMin);
        const want = Math.max(1, Math.round(pool.length * ratio));
        const toClick = pool.slice(0, Math.min(want, pool.length, CONFIG.maxClicksPerCycle));


        // Record only the positions that were actually clicked. The burst can abort
        // mid-way (Stop, hidden tab, session cap) and marking the rest as done would
        // block them for the next MAX_HISTORY cycles without ever clicking them.
        const clicked = await clickAtCanvasPositions(toClick);
        if (clicked.length) {
          clickHistory.push(clicked);
          if (clickHistory.length > MAX_HISTORY) clickHistory.shift();
        }
      }

      stats.cycles++;
      broadcastStats();
    } catch (e) {
    }
  }

  function start() {
    if (running) return;
    running = true;
    stopReason = '';
    zeroStreak = 0;
    usedDragThisCycle = false;
    // Random 20-30 minute cap, so the account is never farming for hours on end.
    const cap = CONFIG.sessionMinMs + Math.random() * (CONFIG.sessionMaxMs - CONFIG.sessionMinMs);
    sessionEndsAt = Date.now() + cap;
    sessionStartedAt = Date.now();
    window.__SRToolkit?.show(true);

    if (!isTabVisible) {
      return;
    }

    // A human opens the game, looks around and collects later - not on the same tick.
    const wait = CONFIG.startDelayMin + Math.random() * (CONFIG.startDelayMax - CONFIG.startDelayMin);
    nextCollectionTime = Date.now() + wait;
    window.__meatTimeout = setTimeout(() => runLoop(), wait);
  }

  // Anti-bot: pause/resume based on tab visibility
  document.addEventListener('visibilitychange', () => {
    isTabVisible = !document.hidden;
    if (running) {
      if (isTabVisible) {
        if (!window.__meatTimeout) runLoop();
      } else {
        // The countdown is dead while hidden; clear it so the HUD does not keep
        // showing a timer that already expired.
        nextCollectionTime = null;
        if (window.__meatTimeout) {
          clearTimeout(window.__meatTimeout);
          window.__meatTimeout = null;
        }
      }
    }
  });

  function stop(reason) {
    running = false;
    stopReason = reason || '';
    if (window.__meatTimeout) clearTimeout(window.__meatTimeout);
    window.__meatTimeout = null;
    clickHistory.length = 0;
    nextCollectionTime = null;
  }

  // One run at a time: the next one is scheduled only after this one finishes, so a
  // 40 s clicking burst can never overlap with the following cycle.
  async function runLoop() {
    if (!running) return;
    nextCollectionTime = null; // the countdown is over; the run is starting now
    if (Date.now() >= sessionEndsAt) {
      stop('session cap reached');
      return;
    }
    await collectCycle();
    if (!running) return;
    scheduleNext();
  }

  function scheduleNext() {
    if (!running) return;
    // Idle gap after the previous run finished. Drag cycles are slower and more
    // suspicious, so they wait 30-40 s instead of the 6-10 s used after clicks.
    let min = CONFIG.minDelay, max = CONFIG.maxDelay;
    if (usedDragThisCycle) { min = CONFIG.dragMinDelay; max = CONFIG.dragMaxDelay; }
    usedDragThisCycle = false;
    const delay = min + Math.random() * (max - min);
    nextCollectionTime = Date.now() + delay;
    window.__meatTimeout = setTimeout(() => {
      runLoop();
    }, delay);
  }

  // Capture with the HUD and overlays hidden. captureVisibleTab photographs the page,
  // so anything of ours on screen ends up inside the screenshot and poisons detection.
  async function capture(format) {
    const hud = window.__SRToolkit;
    return hud
      ? hud.captureClean({ format })
      : chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', format });
  }

  // Draws the detection result over the page. The overlay is wiped by every capture,
  // so this must be re-run after each cycle to keep the live view current.
  function drawOverlay(targets) {
    lastTargets = targets;
    const hud = window.__SRToolkit;
    const canvas = document.querySelector('canvas');
    if (!hud || !canvas) return;

    const o = hud.mountOverlay('meat');
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;

    const g = o.getContext('2d');
    g.clearRect(0, 0, o.width, o.height);
    g.strokeStyle = '#4fc3f7';
    g.lineWidth = 2;
    targets.forEach(t => {
      const x = rect.left + t.canvasX * scaleX;
      const y = rect.top + t.canvasY * scaleY;
      const w = t.boxW * scaleX;
      const h = t.boxH * scaleY;
      g.strokeRect(x - w / 2, y - h / 2, w, h);
      // Click point
      g.fillStyle = '#ff5252';
      g.fillRect(x - 2, y - 2, 4, 4);
    });

    g.fillStyle = 'rgba(0,0,0,.75)';
    g.fillRect(10, 10, 260, 34);
    g.fillStyle = '#4fc3f7';
    g.font = 'bold 15px system-ui, sans-serif';
    g.fillText(`Meat: ${targets.length} icon(s) detected`, 20, 33);
  }

  // Calibration mode: detect once and keep the overlay updated on every cycle.
  async function calibrate() {
    const canvas = document.querySelector('canvas');
    if (!canvas) return 0;

    // Set before the capture so the verbose diagnostics run for this pass.
    liveOverlay = true;
    // Calibration is a diagnostic, not a hot path: always lossless, even though the
    // normal cycles use the faster JPEG capture.
    const response = await capture('png');
    if (!response || response.error) {
      return 0;
    }

    const result = await analyzeScreenshot(response.dataUrl);
    drawOverlay(result.targets);
    return result.targets.length;
  }

  // Deep merge so nested config objects (e.g. whiteThreshold) are not replaced wholesale.
  function applyConfig(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const current = CONFIG[key];
      if (current && typeof current === 'object' && !Array.isArray(current) &&
          value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(current, value);
      } else {
        CONFIG[key] = value;
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Frames without the game canvas must not answer at all: chrome.tabs.sendMessage
    // resolves with the FIRST response, so a canvas-less frame replying {n:0} hides the
    // real calibration result from the frame that owns the game.
    if (!document.querySelector('canvas')) return;
    switch (msg.type) {
      case 'MEAT_STATUS':
        sendResponse({ running, stats, nextCollectionTime, isTabVisible, cfg: CONFIG });
        break;
      case 'MEAT_TOGGLE':
        running ? stop() : start();
        sendResponse({ running });
        break;
      case 'MEAT_START':
        start();
        sendResponse({ ok: true, running });
        break;
      case 'MEAT_STOP':
        stop();
        sendResponse({ ok: true, running });
        break;
      case 'MEAT_CONFIG':
        applyConfig(msg.config || {});
        sendResponse({ ok: true, cfg: CONFIG });
        break;
      case 'MEAT_CALIBRATE':
        calibrate()
          .then(n => sendResponse({ n }))
          .catch(e => {
            sendResponse({ n: 0, error: String(e) });
          });
        return true;
    }
  });

  function broadcastStats() {
    chrome.runtime.sendMessage({ type: 'MEAT_STATS', stats, running }).catch(() => {});
  }

  // Register into the shared in-page HUD so both modules are controllable
  // without the toolbar popup (needed in fullscreen).
  window.__SRToolkit?.register({
    id: 'meat',
    label: 'Meat',
    getStatus() {
      const base = `${stats.collected}c · ${stats.cycles}cy`;
      if (running) {
        const leftMin = Math.max(0, Math.ceil((sessionEndsAt - Date.now()) / 60000));
        if (nextCollectionTime) {
          const secs = Math.max(0, Math.ceil((nextCollectionTime - Date.now()) / 1000));
          return { running, text: `${base} · ${secs}s · ${leftMin}m` };
        }
        return { running, text: `${base} · ${leftMin}m left` };
      }
      return { running, text: stopReason ? `${base} · ${stopReason}` : base };
    },
    toggle() { running ? stop() : start(); },
    calibrate() { calibrate().catch(() => {}); },
    redraw() { if (liveOverlay) drawOverlay(lastTargets); }
  });

  chrome.storage.local.get(['meatAutoStart'], ({ meatAutoStart }) => {
    if (meatAutoStart) start();
  });

})();
