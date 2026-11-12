// content/wood.js — Wood Cutter: detects trees by trunk + surrounding grass and marks them
// Wrapped in an IIFE: the meat module shares this isolated world, so no
// top-level bindings may leak between the two scripts.
(() => {
  'use strict';

  const CFG = {
    intMin: 2600, intMax: 3600,   // ms between marks
    cutTime: 7000,                // ms to cut one tree
    cutGrace: 3000,               // extra ms before a clicked tree must be gone
    noCutLimit: 3,                // clicks in a row whose tree survived = villager is dead/busy
    maxQueue: 5,                  // queue cap (do not mark when full)
    rMin: 150, rGap: 40, gbGap: 15, // trunk color: R>=rMin, R-G>=rGap, G-B>=gbGap
    minTrunk: 3, maxTrunk: 60,    // trunk size (screenshot px)
    foreignMax: 0.15, canopyMin: 0.5, // isolation: max % non-green around / min % green canopy above
    clickOffsetY: -4,             // move the click up toward the canopy
    jitter: 2,
    mTop: 90, mBottom: 150, mLeft: 90, mRight: 100, // excluded UI zones (CSS px)
    // Hard session cap: the cutter stops itself after a random 20-30 minutes.
    sessionMinMs: 20 * 60 * 1000,
    sessionMaxMs: 30 * 60 * 1000
  };

  let running = false, timer = null, last = null;
  let pendingCut = [];     // clicks still waiting to see their tree disappear: { x, y, at }
  let noCutStreak = 0;     // consecutive clicks whose tree was still standing afterwards
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
  const stats = { clicked: 0, cycles: 0, found: 0, queue: 0 };
  let finish = [], recent = [];

  const rand = (a, b) => a + Math.random() * (b - a);
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
    const f = flags;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2];
      let v = 0;
      if (g > r + 8 && g > b + 20) v |= 2;
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
      let foreign = 0, n = 0, cg = 0, cn = 0;
      for (let y = Math.max(0, cy - 14); y <= Math.min(H - 1, cy + 2); y++)
        for (let x = Math.max(0, cx - 9); x <= Math.min(W - 1, cx + 9); x++) {
          const i = y * W + x;
          if (o[i] === id) continue;
          n++; if (!(f[i] & 2)) foreign++;
          if (y <= cy - 3 && Math.abs(x - cx) <= 6) { cn++; if (f[i] & 2) cg++; }
        }
      // Clear the markers instead of memsetting the whole array: q[0..t) still holds
      // this trunk's pixels, so no stale id can leak into the next scan.
      for (let k = 0; k < t; k++) o[q[k]] = 0;
      if (!n || foreign / n > CFG.foreignMax) continue;
      if (!cn || cg / cn < CFG.canopyMin) continue;
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
    if (trees.length) return trees;
    // The trunk test is chroma-based and JPEG uses 4:2:0 subsampling, so an empty
    // result gets one lossless confirmation before it counts as "no trees". Skipped
    // when the user pinned PNG, where the fast path was already lossless.
    if (window.__SRToolkit?.captureFormat === 'png') return trees;
    return scanOnce('png');
  }

  function pick(trees) {
    const now = Date.now(); recent = recent.filter(p => now - p.t < 25000);
    const c = trees.filter(t => !recent.some(p => Math.hypot(p.x - t.x, p.y - t.y) < 10));
    if (!c.length) return null;
    if (last) c.sort((a, b) => Math.hypot(a.x - last.x, a.y - last.y) - Math.hypot(b.x - last.x, b.y - last.y));
    // Fisher-Yates: sort(() => Math.random() - 0.5) is a biased shuffle, not a
    // uniform one, so "pick one of the 3 nearest" would not really be random.
    else for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c[Math.floor(Math.random() * Math.min(3, c.length))];
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
        if (liveOverlay && window.__SRToolkit?.hasOverlay('wood')) drawOverlay(trees);
        else liveOverlay = false;

        // Did the trees we clicked earlier actually fall? A dead or busy villager keeps
        // the tree standing, and without this check the module would keep clicking for
        // the whole session cap without collecting anything.
        const now = Date.now();
        const due = pendingCut.filter(p => now >= p.at);
        if (due.length) pendingCut = pendingCut.filter(p => now < p.at);
        for (const p of due) {
          if (trees.some(x => Math.hypot(x.x - p.x, x.y - p.y) < 10)) {
            noCutStreak++;
          } else noCutStreak = 0;
        }
        if (noCutStreak >= CFG.noCutLimit) {
          stop('villager is not cutting (dead or busy)');
          return;
        }
        if (noCutStreak) status = `tree not cut (${noCutStreak}/${CFG.noCutLimit})`;

        const t = pick(trees);
        if (!t) {
          // Never stop the session because the map looks empty: trees respawn, and a
          // self-stop leaves the module off until the user notices. The 20-30 min
          // session cap is the only automatic stop.
          if (!noCutStreak) status = 'no trees';
        } else {
          await sleep(rand(80, 300));
          if (await clickAt(t.x, t.y)) {
            stats.clicked++; regClick(); last = t; recent.push({ x: t.x, y: t.y, t: Date.now() });
            pendingCut.push({ x: t.x, y: t.y, at: Date.now() + CFG.cutTime + CFG.cutGrace });
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
    if (running) timer = setTimeout(() => tick(loopToken), rand(CFG.intMin, CFG.intMax) * (1 + Math.min(errStreak, 10)));
  }

  function start() {
    if (running) return;
    running = true;
    lastError = '';
    errStreak = 0;
    pendingCut = [];
    noCutStreak = 0;
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
    const trees = await scan();
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
        send({ running, status, error: lastError, stats: { ...stats, queue: queueSize() }, cfg: CFG });
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
      return { running, text: `${stats.clicked} marks${leftMin}` };
    },
    toggle() { running ? stop() : start(); },
    // Must return the promise: the HUD shows the count, or the reason it failed.
    calibrate() { return calibrate(); },
    redraw() { if (liveOverlay) drawOverlay(lastTrees); }
  });

  // Autostart only in the frame that owns the game canvas: the manifest injects into
  // every frame, and each one would otherwise run its own capture/click loop.
  chrome.storage.local.get(['woodAutoStart'], ({ woodAutoStart }) => {
    if (!woodAutoStart) return;
    let tries = 0;
    const arm = () => { if (hasCanvas()) start(); else if (++tries < 60) setTimeout(arm, 500); };
    arm();
  });

})();
