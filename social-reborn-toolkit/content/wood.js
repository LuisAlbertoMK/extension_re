// content/wood.js — Wood Cutter: detects trees by trunk + surrounding grass and marks them
// Wrapped in an IIFE: the meat module shares this isolated world, so no
// top-level bindings may leak between the two scripts.
(() => {
  'use strict';

  const CFG = {
    intMin: 2600, intMax: 3600,   // ms between marks
    cutTime: 7000,                // ms to cut one tree
    noCutWindowMs: 45000,         // no clicked tree has fallen for this long = villager is dead/busy
    maxQueue: 5,                  // queue cap (do not mark when full)
    rMin: 150, rGap: 40, gbGap: 15, // trunk color: R>=rMin, R-G>=rGap, G-B>=gbGap
    minTrunk: 3, maxTrunk: 60,    // trunk size (screenshot px)
    foreignMax: 0.15, canopyMin: 0.5, // isolation: max % non-green around / min % green canopy above
    lightG: 190, lightMin: 0.12,  // tree canopy has bright lime highlights (G>=lightG) that grass, fields and roofs lack
    clickOffsetY: -4,             // move the click up toward the canopy
    jitter: 2,
    nearestTiePx: 15,             // trees within this much of the nearest one are an even walk
    mTop: 90, mBottom: 150, mLeft: 90, mRight: 100, // excluded UI zones (CSS px)
    // Hard session cap: the cutter stops itself after a random 20-30 minutes.
    sessionMinMs: 20 * 60 * 1000,
    sessionMaxMs: 30 * 60 * 1000,
    // Auto-pan: when the view has no trees left and the queue is empty, drag the map one
    // step along a serpentine route (rows left<->right, then down/up) and rescan.
    autoPan: true,
    panFrac: 0.55,                // step = this fraction of the usable view
    panMinMs: 600, panMaxMs: 1000,
    panSettleMs: 700,             // wait after a drag before rescanning
    edgeDiff: 4                   // mean luminance change (0-255) below which a pan did not move the map
  };

  let running = false, timer = null, last = null;
  let pendingCut = [];     // clicked trees not yet seen gone: { x, y, at (click time) }
  let lastFall = 0;        // last time a clicked tree was seen gone from the map
  // One chain at a time: every start/stop bumps the token and a callback carrying an
  // older token is ignored. Without it, a cycle that was still in flight when the user
  // pressed Stop and then Start would reschedule itself next to the new chain.
  let loopToken = 0, tickBusy = false;
  let errStreak = 0;       // consecutive failed cycles; only used to back off, never to stop
  let liveOverlay = false; // calibration mode: keep the detection overlay updated each cycle
  let lastTrees = [];      // last detection, used to repaint after a viewport change
  let sessionEndsAt = 0;   // wall-clock deadline for the current run
  let status = 'idle';
  let lastError = '';      // last capture/scan failure, shown in the popup
  const stats = { clicked: 0, cycles: 0, found: 0, queue: 0, pans: 0 };
  let finish = [], recent = [];
  let emptyStreak = 0;     // consecutive scans with nothing to cut: slows polling while the map is empty
  let zeroStreak = 0;      // consecutive empty JPEG scans: gates the lossless confirmation
  let lastSig = null;      // coarse luminance signature of the last frame (pan edge detection)
  let pan = null;          // { sig, axis } while a pan is being verified
  let panDirX = 1, panDirY = 1, nextAxis = 'x';
  const falls = [];        // recent intervals between tree falls, to learn the real cut time
  let lastFallAt = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  // Right-skewed wait for the schedule; the HUD owns it so the three modules share one
  // distribution. Falls back to plain uniform when the HUD is not loaded.
  const gap = (a, b) => (window.__SRToolkit?.humanGap
    ? window.__SRToolkit.humanGap(a, b)
    : rand(a, b));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hasCanvas = () => !!document.querySelector('canvas');

  function queueSize() { const n = Date.now(); finish = finish.filter(t => t > n); return finish.length; }
  function regClick() { const n = Date.now(); finish.push(Math.max(finish[finish.length - 1] || n, n) + CFG.cutTime); }

  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('screenshot decode failed'));
      i.src = url;
    });
  }

  // Reused between scans. A 1080p frame needs ~25 MB of buffers and the scan runs every
  // few seconds, so allocating them fresh each cycle is pure GC churn.
  let scratchCanvas = null, scratchCtx = null;
  let flags = null; // bit0 trunk, bit1 grass, bit2 seen
  let own = null;
  let floodQueue = null;

  function ensureScratch(W, H) {
    if (!scratchCanvas) {
      scratchCanvas = document.createElement('canvas');
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (scratchCanvas.width !== W || scratchCanvas.height !== H) {
      scratchCanvas.width = W;
      scratchCanvas.height = H;
    }
    if (!flags || flags.length !== W * H) {
      flags = new Uint8Array(W * H);
      own = new Int32Array(W * H);
      floodQueue = new Int32Array(W * H);
    }
    return scratchCtx;
  }

  function detect(img) {
    const W = img.width, H = img.height, s = W / innerWidth;
    const ctx = ensureScratch(W, H);
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const x0 = CFG.mLeft * s, x1 = W - CFG.mRight * s, y0 = CFG.mTop * s, y1 = H - CFG.mBottom * s;
    const sig = new Uint8Array(48 * 27);
    for (let j = 0; j < 27; j++) for (let k = 0; k < 48; k++) {
      const p = (Math.floor((j + 0.5) * H / 27) * W + Math.floor((k + 0.5) * W / 48)) * 4;
      sig[j * 48 + k] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    lastSig = sig;
    const f = flags;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2];
      let v = 0;
      if (g > r + 8 && g > b + 20) { v |= 2; if (g >= CFG.lightG && g > r + 35) v |= 8; }
      if (x >= x0 && x < x1 && y >= y0 && y < y1 &&
          r >= CFG.rMin && r - g >= CFG.rGap && g - b >= CFG.gbGap) v |= 1;
      f[i] = v;
    }
    const q = floodQueue, o = own;
    const out = [];
    for (let st = 0; st < W * H; st++) {
      if ((f[st] & 5) !== 1) continue; // trunk and not yet seen
      let h = 0, t = 0, sx = 0, sy = 0; q[t++] = st; f[st] |= 4;
      while (h < t) {
        const i = q[h++], x = i % W, y = (i - x) / W; sx += x; sy += y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if ((f[ni] & 5) === 1) { f[ni] |= 4; q[t++] = ni; }
        }
      }
      if (t < CFG.minTrunk || t > CFG.maxTrunk) continue;
      const cx = Math.round(sx / t), cy = Math.round(sy / t);
      const id = t * 100000 + st;
      for (let k = 0; k < t; k++) o[q[k]] = id;
      let foreign = 0, n = 0, cg = 0, cn = 0, cl = 0;
      for (let y = Math.max(0, cy - 14); y <= Math.min(H - 1, cy + 2); y++)
        for (let x = Math.max(0, cx - 9); x <= Math.min(W - 1, cx + 9); x++) {
          const i = y * W + x;
          if (o[i] === id) continue;
          n++; if (!(f[i] & 2)) foreign++;
          if (y <= cy - 3 && Math.abs(x - cx) <= 6) { cn++; if (f[i] & 2) cg++; if (f[i] & 8) cl++; }
        }
      // Clear the markers instead of memsetting the whole array: q[0..t) still holds
      // this trunk's pixels, so no stale id can leak into the next scan.
      for (let k = 0; k < t; k++) o[q[k]] = 0;
      if (!n || foreign / n > CFG.foreignMax) continue;
      if (!cn || cg / cn < CFG.canopyMin || cl / cn < CFG.lightMin) continue;
      out.push({ x: cx / s, y: cy / s + CFG.clickOffsetY, size: t });
    }
    return out;
  }

  // Capture with the HUD and overlays hidden, so our own drawing never ends up in
  // the screenshot that the detector reads.
  async function capture(format) {
    const hud = window.__SRToolkit;
    return hud
      ? hud.captureClean({ format })
      : chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', format });
  }

  async function scanOnce(format) {
    const r = await capture(format);
    if (!r) throw new Error('capture returned nothing');
    if (r.error) throw new Error(`capture failed: ${r.error}`);
    return detect(await loadImg(r.dataUrl));
  }

  async function scan() {
    const trees = await scanOnce('jpeg');
    if (trees.length) { zeroStreak = 0; return trees; }
    zeroStreak++;
    // The trunk test is chroma-based and JPEG uses 4:2:0 subsampling, so an empty
    // result gets one lossless confirmation before it counts as "no trees". A genuinely
    // empty map must not pay a PNG capture on every cycle (and with auto-pan it would
    // double the capture rate against Chrome's 2/s cap), so confirm on the first empty
    // frame and then every 4th, the same policy as the meat detector.
    if (window.__SRToolkit?.captureFormat === 'png') return trees;
    if (zeroStreak !== 1 && zeroStreak % 4 !== 0) return trees;
    return scanOnce('png');
  }

  // Which clicked trees are gone from the map? The queue is FIFO and each walk adds up, so
  // a per-tree deadline drifts: the 4th tree in the queue is legitimately still standing
  // when its estimated time arrives (a healthy villager tripped a "not cutting" stop after
  // ~30 s that way). What a working villager does guarantee is that SOME tree falls every
  // cutTime or so, so the check is the time since the last fall, not "on schedule".
  // A tree the detector no longer sees counts as fallen: that errs toward not stopping.
  function settleCuts(trees, now) {
    const keep = [];
    let fell = false;
    for (const p of pendingCut) {
      const standing = trees.some(x => Math.hypot(x.x - p.x, x.y - p.y) < 10);
      if (!standing) { lastFall = now; fell = true; }
      else if (now - p.at < 5 * 60 * 1000) keep.push(p);
    }
    // Learn the real cut time: median gap between consecutive falls while a backlog exists.
    if (fell) {
      if (lastFallAt && keep.length && now - lastFallAt < 20000) {
        falls.push(now - lastFallAt);
        if (falls.length > 5) falls.shift();
        if (falls.length >= 3) {
          const m = [...falls].sort((a, b) => a - b)[falls.length >> 1];
          CFG.cutTime = Math.min(20000, Math.max(3000, m));
        }
      }
      lastFallAt = now;
    }
    // Aged out after 5 min, not sooner: a backlog can legitimately keep a tree standing for
    // a minute or more, and dropping it early (or keeping only the newest ones) would hide
    // the fall that proves the villager works. A click that never took (landed on grass)
    // is simply forgotten after that.
    pendingCut = keep;
  }

  // The villager stands where it last cut, so the trunk nearest to that point is the
  // shortest walk. Distance to the previous click is the stand-in for distance to the
  // villager: it is the same spot, and no sprite match is needed for it.
  function pick(trees) {
    const now = Date.now(); recent = recent.filter(p => now - p.t < 25000);
    const c = trees.filter(t => !recent.some(p => Math.hypot(p.x - t.x, p.y - t.y) < 10));
    if (!c.length) return null;
    // Nothing cut yet in this session: there is no villager position to aim at.
    if (!last) return c[Math.floor(Math.random() * c.length)];
    const ref = last;
    const dist = (t) => Math.hypot(t.x - ref.x, t.y - ref.y);
    c.sort((a, b) => dist(a) - dist(b));
    // Trees that are practically the same walk: choose between them so the pick is not
    // a frozen arithmetic result, but never walk past one to reach a farther tree.
    const nearest = dist(c[0]);
    const tie = c.filter(t => dist(t) <= nearest + CFG.nearestTiePx);
    return tie[Math.floor(Math.random() * tie.length)];
  }

  async function clickAt(x, y) {
    const input = window.__SRToolkit?.input;
    if (!input) return false;
    const j = CFG.jitter;
    const tx = Math.round(x + rand(-j, j));
    const ty = Math.round(y + rand(-j, j));
    // Travel time from distance, not a fixed number: a nearby tree is a short move,
    // a far one takes longer. Same speed model as the meat module.
    const from = input.position || { x: innerWidth / 2, y: innerHeight / 2 };
    const dist = Math.hypot(tx - from.x, ty - from.y);
    const moveMs = Math.min(700, Math.max(90, Math.round(dist * (0.5 + Math.random() * 0.4))));
    await input.moveTo(tx, ty, moveMs);
    return input.click(tx, ty);
  }

  function sigDiff(a, b) {
    if (!a || !b) return 255;
    let t = 0;
    for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
    return t / a.length;
  }

  // Drag the map one step. Dragging left moves the view right. Returns false if the
  // gesture could not be sent. Everything tied to screen coordinates is invalidated.
  async function panStep(axis) {
    const input = window.__SRToolkit?.input;
    if (!input?.drag) return false;
    const ux = innerWidth - CFG.mLeft - CFG.mRight, uy = innerHeight - CFG.mTop - CFG.mBottom;
    const cx = CFG.mLeft + ux / 2 + rand(-20, 20), cy = CFG.mTop + uy / 2 + rand(-20, 20);
    const len = (axis === 'x' ? ux : uy) * CFG.panFrac * rand(0.9, 1.1);
    const dir = axis === 'x' ? panDirX : panDirY;
    // View moves by +dir, so the cursor travels by -dir.
    const a = axis === 'x' ? { x: cx + dir * len / 2, y: cy } : { x: cx, y: cy + dir * len / 2 };
    const b = axis === 'x' ? { x: cx - dir * len / 2, y: cy } : { x: cx, y: cy - dir * len / 2 };
    const N = 14, pts = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, e = u * u * (3 - 2 * u); // ease in/out
      pts.push({
        x: Math.round(a.x + (b.x - a.x) * e + (i && i < N ? rand(-2, 2) : 0)),
        y: Math.round(a.y + (b.y - a.y) * e + (i && i < N ? rand(-2, 2) : 0)),
        w: 1
      });
    }
    pan = { sig: lastSig, axis };
    const ok = await input.drag(pts, rand(CFG.panMinMs, CFG.panMaxMs));
    pendingCut = []; recent = []; last = null; lastFall = 0; lastFallAt = 0;
    await sleep(CFG.panSettleMs);
    if (!ok) pan = null;
    return ok;
  }

  // After a pan, a near-identical frame means the map did not move = edge reached.
  function resolvePan() {
    if (!pan) return;
    const moved = sigDiff(pan.sig, lastSig) > CFG.edgeDiff;
    const axis = pan.axis; pan = null;
    if (axis === 'y') nextAxis = 'x';
    if (moved) return;
    if (axis === 'x') { panDirX = -panDirX; nextAxis = 'y'; }
    else { panDirY = -panDirY; }
  }

  async function tick(my) {
    if (!running || my !== loopToken) return;
    // A cycle is already in flight: it owns the chain and reschedules when it ends.
    if (tickBusy) return;
    if (Date.now() >= sessionEndsAt) {
      stop('session cap reached');
      return;
    }
    tickBusy = true;
    lastError = '';
    try {
      if (document.hidden) status = 'paused (hidden tab)';
      else if (queueSize() >= CFG.maxQueue) status = 'queue full, waiting';
      else {
        const trees = await scan();
        errStreak = 0;
        stats.found = trees.length; stats.cycles++;
        emptyStreak = trees.length ? 0 : emptyStreak + 1;
        resolvePan();
        if (liveOverlay && window.__SRToolkit?.hasOverlay('wood')) drawOverlay(trees);
        else liveOverlay = false;

        // Did any clicked tree fall? A dead or busy villager keeps every tree standing, and
        // without this check the module would keep clicking for the whole session cap.
        const now = Date.now();
        settleCuts(trees, now);
        const since = Math.max(lastFall, pendingCut.length ? pendingCut[0].at : 0);
        if (pendingCut.length && since && now - since > CFG.noCutWindowMs) {
          stop('villager is not cutting (dead or busy)');
          return;
        }
        if (pendingCut.length && since && now - since > CFG.noCutWindowMs / 2) {
          status = `no tree cut for ${Math.round((now - since) / 1000)}s`;
        }

        const t = pick(trees);
        if (!t) {
          // Never stop the session because the map looks empty: trees respawn, and a
          // self-stop leaves the module off until the user notices. The 20-30 min
          // session cap is the only automatic stop.
          status = 'no trees';
          // Everything visible is cut and the villager is idle: move to the next screen.
          if (CFG.autoPan && queueSize() === 0 && pendingCut.length === 0) {
            status = 'panning';
            if (await panStep(nextAxis)) stats.pans++;
          }
        } else {
          await sleep(gap(80, 300));
          if (await clickAt(t.x, t.y)) {
            stats.clicked++; regClick(); last = t; recent.push({ x: t.x, y: t.y, t: Date.now() });
            pendingCut.push({ x: t.x, y: t.y, at: Date.now() });
            status = 'cutting';
          }
        }
      }
    } catch (e) {
      // A failed capture used to vanish here, leaving the module "running" and idle.
      lastError = String((e && e.message) || e);
      errStreak++;
    } finally {
      tickBusy = false;
    }
    stats.queue = queueSize();
    // Never stops on its own: a capture hiccup must not end the session - the user owns
    // Stop. Back off instead, so a failing capture is retried slower, not tighter.
    if (running) timer = setTimeout(() => tick(loopToken), gap(CFG.intMin, CFG.intMax) * (1 + Math.min(errStreak, 10)) * (1 + Math.min(emptyStreak >> 2, 2)));
  }

  function start() {
    if (running) return;
    running = true;
    lastError = '';
    errStreak = 0;
    pendingCut = []; recent = []; finish = []; falls.length = 0;
    last = null; pan = null; lastFall = 0; lastFallAt = 0; nextAxis = 'x';
    emptyStreak = 0; panDirX = 1; panDirY = 1;
    status = 'starting';
    const my = ++loopToken;
    const cap = CFG.sessionMinMs + Math.random() * (CFG.sessionMaxMs - CFG.sessionMinMs);
    sessionEndsAt = Date.now() + cap;
    window.__SRToolkit?.show(true);
    tick(my);
  }

  function stop(msg) {
    running = false; loopToken++; clearTimeout(timer); timer = null; status = msg || 'idle';
    // Deliberately NOT detaching the debugger here: detaching hides Chrome's
    // "started debugging this browser" infobar, which resizes the viewport and
    // shifts every coordinate we already measured.
  }

  // Draws the detection result plus the excluded UI zones. Wiped by every capture,
  // so it must be re-run after each cycle while calibration mode is on.
  function drawOverlay(trees) {
    lastTrees = trees;
    const hud = window.__SRToolkit;
    if (!hud) return;

    const o = hud.mountOverlay('wood');
    const g = o.getContext('2d');
    g.clearRect(0, 0, o.width, o.height);
    // Excluded UI zones
    g.strokeStyle = 'rgba(255,0,0,.45)';
    g.lineWidth = 1;
    g.strokeRect(CFG.mLeft, CFG.mTop, innerWidth - CFG.mLeft - CFG.mRight, innerHeight - CFG.mTop - CFG.mBottom);
    // Detected trunks
    g.strokeStyle = '#ffeb3b';
    g.lineWidth = 2;
    trees.forEach(t => g.strokeRect(t.x - 7, t.y - 7, 14, 14));
    // Count badge (offset down so it does not overlap the meat badge)
    g.fillStyle = 'rgba(0,0,0,.75)';
    g.fillRect(10, 50, 210, 34);
    g.fillStyle = '#ffeb3b';
    g.font = 'bold 15px system-ui, sans-serif';
    g.fillText(`Wood: ${trees.length} tree(s) detected`, 20, 73);
  }

  // Calibration mode: detect once and keep the overlay updated on every cycle.
  async function calibrate() {
    // Diagnostics are not the hot path: always lossless, even when the cycles use JPEG.
    const trees = await scanOnce('png');
    liveOverlay = true;
    drawOverlay(trees);
    return trees.length;
  }

  function applyConfig(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in CFG) CFG[k] = v;
    }
  }

  chrome.runtime.onMessage.addListener((m, s, send) => {
    if (!hasCanvas()) return;
    switch (m.type) {
      case 'WOOD_STATUS':
        send({ running, status, error: lastError, stats: { ...stats, queue: queueSize() }, cfg: CFG, captureErrors: window.__SRToolkit?.captureStats?.errors || 0 });
        break;
      case 'WOOD_TOGGLE':
        running ? stop() : start();
        send({ running });
        break;
      case 'WOOD_CONFIG':
        applyConfig(m.config || {});
        send({ ok: true, cfg: CFG });
        break;
      case 'STOP_ALL':
        stop('stopped (hotkey)');
        break;
      case 'WOOD_CALIBRATE':
        calibrate().then(n => send({ n })).catch(e => send({ n: 0, error: String((e && e.message) || e) }));
        return true;
    }
  });

  window.__SRToolkit?.register({
    id: 'wood',
    label: 'Wood',
    getStatus() {
      const leftMin = running ? ` · ${Math.max(0, Math.ceil((sessionEndsAt - Date.now()) / 60000))}m` : '';
      return { running, text: `${stats.clicked} marks · ${stats.pans} pans${leftMin}` };
    },
    toggle() { running ? stop() : start(); },
    // Must return the promise: the HUD shows the count, or the reason it failed.
    calibrate() { return calibrate(); },
    // Diagnostic dump: the raw lossless frame + detections/config as JSON, so a bad
    // detection can be reproduced offline from the exact pixels the detector saw.
    async exportFrame() {
      const r = await capture('png');
      if (!r || r.error) throw new Error((r && r.error) || 'capture returned nothing');
      const trees = detect(await loadImg(r.dataUrl));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const save = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
      save(r.dataUrl, `sr-wood-${stamp}.png`);
      const blob = new Blob([JSON.stringify({ at: stamp, viewport: [innerWidth, innerHeight, devicePixelRatio], cfg: CFG, trees }, null, 1)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      save(url, `sr-wood-${stamp}.json`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return trees.length;
    },
    redraw() { if (liveOverlay) drawOverlay(lastTrees); }
  });

  // Autostart only in the frame that owns the game canvas: the manifest injects into
  // every frame, and each one would otherwise run its own capture/click loop.
  chrome.storage.local.get(['woodAutoPan'], ({ woodAutoPan }) => { if (woodAutoPan === false) CFG.autoPan = false; });
  chrome.storage.onChanged.addListener((c) => { if (c.woodAutoPan) CFG.autoPan = c.woodAutoPan.newValue !== false; });
  chrome.storage.local.get(['woodAutoStart'], ({ woodAutoStart }) => {
    if (!woodAutoStart) return;
    let tries = 0;
    const arm = () => { if (hasCanvas()) start(); else if (++tries < 60) setTimeout(arm, 500); };
    arm();
  });

})();
