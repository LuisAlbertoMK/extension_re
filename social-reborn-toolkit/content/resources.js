// content/resources.js — Resource Collector: detects white bubbles over buildings and
// classifies the resource by the colour inside (meat / wood / gold / stone), then picks
// the gather duration in the "choose time" dialog.
// Wrapped in an IIFE: the other modules share this isolated world, so no top-level
// bindings may leak between them.
(() => {
  'use strict';

  const CFG = {
    meat: true, wood: true, gold: true, stone: true,
    cycMin: 25000, cycMax: 40000,        // ms entre escaneos
    whiteMin: 243,                       // umbral de "blanco" de la burbuja
    wMin: 30, wMax: 65, hMin: 30, hMax: 70, // tamaño burbuja (px de screenshot)
    minPx: 40,                           // píxeles mínimos del color del recurso
    mTop: 0.09, mBottom: 0.14, mLeft: 0.07, mRight: 0.08, // zonas UI excluidas (fracción)
    jitter: 3, gapMin: 700, gapMax: 1800, // jitter y pausa entre clicks (ms)
    maxAttempts: 3,
    option: 0,                           // 0=5min(arriba-izq) 1=1h 2=4h 3=8h
    selMin: 10000, selMax: 40000,        // espera antes de elegir el tiempo (ms)
    btnWMin: 80, btnWMax: 140, btnHMin: 20, btnHMax: 40, // botón "Elegir" (px)
    // Hard session cap, same anti-bot model as the meat and wood modules.
    sessionMinMs: 20 * 60 * 1000,
    sessionMaxMs: 30 * 60 * 1000
  };

  let running = false, timer = null, status = 'idle';
  // One chain at a time: every start/stop bumps the token and a callback carrying an
  // older token is ignored. Without it, a scan that was still in flight when the user
  // pressed Stop and then Start would reschedule itself next to the new chain.
  let loopToken = 0, tickBusy = false;
  let lastError = '';                    // last capture/scan failure, shown in the popup
  let sessionEndsAt = 0;
  let liveOverlay = false;               // calibration mode: keep the overlay updated
  let lastResult = { items: [], dialog: null, rejects: [] };
  let dialogTries = 0;
  const stats = { meat: 0, wood: 0, gold: 0, stone: 0, cycles: 0, found: 0, chosen: 0 };
  const attempts = new Map();

  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hasCanvas = () => !!document.querySelector('canvas');

  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      // Without this the promise never settles and the scan loop dies silently.
      i.onerror = () => reject(new Error('screenshot decode failed'));
      i.src = url;
    });
  }

  // Reused between scans: three full-frame masks plus a queue is ~15 MB at 1080p, and
  // the detector runs every 25-40 s.
  let scratchCanvas = null, scratchCtx = null;
  let whiteMask = null, thinA = null, thinB = null, seenMask = null, floodQueue = null;

  function ensureScratch(W, H) {
    if (!scratchCanvas) {
      scratchCanvas = document.createElement('canvas');
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (scratchCanvas.width !== W || scratchCanvas.height !== H) {
      scratchCanvas.width = W;
      scratchCanvas.height = H;
    }
    if (!whiteMask || whiteMask.length !== W * H) {
      whiteMask = new Uint8Array(W * H);
      thinA = new Uint8Array(W * H);
      thinB = new Uint8Array(W * H);
      seenMask = new Uint8Array(W * H);
      floodQueue = new Int32Array(W * H);
    }
    return scratchCtx;
  }

  function classify(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, d = mx - mn;
    const sat = mx ? d / mx : 0;
    if (sat < 0.18) return (v >= 0.4 && v <= 0.95) ? 'stone' : null;
    if (sat < 0.3 || v < 0.4) return null;
    let h;
    if (d === 0) return null;
    if (mx === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h <= 13 || h >= 340) return v >= 0.55 ? 'meat' : null;
    if (h >= 33 && h <= 62) return 'gold';
    if (h > 13 && h < 33) return v <= 0.86 ? 'wood' : null;
    return null;
  }

  function detect(img) {
    const W = img.width, H = img.height, s = W / innerWidth;
    const ctx = ensureScratch(W, H);
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const total = W * H;
    const mx0 = CFG.mLeft * W, mx1 = W - CFG.mRight * W, my0 = CFG.mTop * H, my1 = H - CFG.mBottom * H;

    const { whiteMin } = CFG;
    const white = whiteMask;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      white[i] = (d[p] >= whiteMin && d[p + 1] >= whiteMin && d[p + 2] >= whiteMin) ? 1 : 0;
    }

    // One pass over the mask thinned E times (E = 0, 1, 2).
    function pass(E) {
      let mask = white;
      if (E > 0) {
        // Erosion separates bubbles that touch, so each pass gets a thinner mask.
        // The buffers are reused, hence the explicit clear before each write.
        let src = white;
        for (let k = 0; k < E; k++) {
          const dst = k === 0 ? thinA : thinB;
          dst.fill(0);
          for (let y = 1; y < H - 1; y++) {
            const row = y * W;
            for (let x = 1; x < W - 1; x++) {
              const i = row + x;
              if (src[i] && src[i - 1] && src[i + 1] && src[i - W] && src[i + W]) dst[i] = 1;
            }
          }
          src = dst;
        }
        mask = src;
      }

      const seen = seenMask;
      seen.fill(0);
      const q = floodQueue;
      const items = [], btns = [], frags = [], rejects = [];

      for (let st = 0; st < total; st++) {
        if (!mask[st] || seen[st]) continue;
        let h = 0, t = 0, minX = W, maxX = 0, minY = H, maxY = 0;
        q[t++] = st; seen[st] = 1;
        while (h < t) {
          const i = q[h++], x = i % W, y = (i / W) | 0;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[t++] = i - 1; }
          if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[t++] = i + 1; }
          if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; q[t++] = i - W; }
          if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; q[t++] = i + W; }
        }
        minX = Math.max(0, minX - E); maxX = Math.min(W - 1, maxX + E);
        minY = Math.max(0, minY - E); maxY = Math.min(H - 1, maxY + E);
        const w = maxX - minX + 1, hh = maxY - minY + 1, fill = t / (w * hh), ratio = hh / w;
        if (E === 0 && w >= CFG.btnWMin && w <= CFG.btnWMax && hh >= CFG.btnHMin && hh <= CFG.btnHMax && fill > 0.5 && ratio < 0.4) {
          btns.push({ x: (minX + w / 2) / s, y: (minY + hh / 2) / s, w: w / s, h: hh / s }); continue;
        }
        if (t >= (E ? 20 : 40) && w <= CFG.wMax && hh <= CFG.hMax) frags.push({ minX, maxX, minY, maxY, t });
      }

      // Merge fragments (the icon splits the white background) without exceeding the
      // maximum bubble size.
      frags.sort((a, b) => b.t - a.t); frags.length = Math.min(frags.length, 1500);
      const groups = [], G = 3;
      for (const f of frags) {
        let done = false;
        for (const g of groups) {
          const ox = Math.min(f.maxX, g.maxX) - Math.max(f.minX, g.minX) + 1, oy = Math.min(f.maxY, g.maxY) - Math.max(f.minY, g.minY) + 1;
          const mw = Math.min(f.maxX - f.minX, g.maxX - g.minX) + 1, mh = Math.min(f.maxY - f.minY, g.maxY - g.minY) + 1;
          const gx = Math.max(f.minX - g.maxX, g.minX - f.maxX), gy = Math.max(f.minY - g.maxY, g.minY - f.maxY);
          // close: touching, or aligned (the middle icon separates them) with a gap <= 28px
          if ((gx <= G && gy <= G) || (ox >= 0.6 * mw && gy <= 28) || (oy >= 0.6 * mh && gx <= 28)) {
            const nminX = Math.min(g.minX, f.minX), nmaxX = Math.max(g.maxX, f.maxX),
                  nminY = Math.min(g.minY, f.minY), nmaxY = Math.max(g.maxY, f.maxY);
            if (nmaxX - nminX + 1 <= CFG.wMax && nmaxY - nminY + 1 <= CFG.hMax) {
              g.minX = nminX; g.maxX = nmaxX; g.minY = nminY; g.maxY = nmaxY; g.t += f.t; done = true; break;
            }
          }
        }
        if (!done) groups.push({ ...f });
      }

      for (const g of groups) {
        const w = g.maxX - g.minX + 1, hh = g.maxY - g.minY + 1, fill = g.t / (w * hh), ratio = hh / w;
        const cx = g.minX + w / 2, cy = g.minY + hh / 2;
        if (cx < mx0 || cx > mx1 || cy < my0 || cy > my1) continue;
        const rj = why => rejects.push({ x: cx / s, y: cy / s, w: w / s, h: hh / s, why });
        if (w < CFG.wMin || w > CFG.wMax || hh < CFG.hMin || hh > CFG.hMax) { if (w >= 20 && hh >= 20) rj('size ' + w + 'x' + hh); continue; }
        if (fill < 0.12 || fill > 0.92 || ratio < 0.8 || ratio > 1.6) { rj('shape ' + fill.toFixed(2) + '/' + ratio.toFixed(1)); continue; }

        // Bubble shape: both top corners (with a 6 px margin) must be white.
        const wh = (x, y) => {
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && white[yy * W + xx]) return true;
          }
          return false;
        };
        if (!wh(g.minX + 6, g.minY + 6) || !wh(g.maxX - 6, g.minY + 6)) { rj('corners'); continue; }

        const cnt = { meat: 0, wood: 0, gold: 0, stone: 0 };
        for (let y = g.minY; y <= g.maxY; y++) for (let x = g.minX; x <= g.maxX; x++) {
          if (white[y * W + x]) continue;
          const p = (y * W + x) * 4, k = classify(d[p], d[p + 1], d[p + 2]);
          if (k) cnt[k]++;
        }
        let best = null, bn = 0;
        for (const k in cnt) if (cnt[k] > bn) { bn = cnt[k]; best = k; }
        if (!best || bn < CFG.minPx) { rj('colour ' + JSON.stringify(cnt)); continue; }
        items.push({ type: best, x: cx / s, y: cy / s, w: w / s, h: hh / s, n: bn });
      }
      return { items, btns, rejects };
    }

    let items = [], btns = [], rej = [];
    for (const E of [0, 1, 2]) {
      const r = pass(E);
      if (E === 0) btns = r.btns;
      rej.push(...r.rejects);
      for (const it of r.items) if (!items.some(o => Math.hypot(o.x - it.x, o.y - it.y) < it.w * 0.6)) items.push(it);
    }

    // Dialog: >=3 "choose" buttons in a 2x2 grid.
    let dialog = null;
    if (btns.length >= 3) {
      btns.sort((a, b) => a.y - b.y);
      const top = btns.filter(b => b.y <= btns[0].y + 30).sort((a, b) => a.x - b.x);
      const bot = btns.filter(b => b.y > btns[0].y + 30).sort((a, b) => a.x - b.x);
      if (top.length >= 1 && bot.length >= 1) {
        const row = CFG.option >= 2 ? bot : top;
        dialog = { target: row[CFG.option % 2] || null, btns };
      }
    }
    rej = rej.filter(r => !items.some(o => Math.hypot(o.x - r.x, o.y - r.y) < r.w * 0.6));
    return { items: dialog ? [] : items, dialog, rejects: rej.slice(0, 40) };
  }

  // The bubble test needs white >= 243, so this module always asks for a lossless PNG
  // capture: JPEG chroma subsampling pushes border pixels below that threshold.
  async function capture() {
    const hud = window.__SRToolkit;
    return hud
      ? hud.captureClean({ format: 'png' })
      : chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', format: 'png' });
  }

  async function scan() {
    const r = await capture();
    if (!r) throw new Error('capture returned nothing');
    if (r.error) throw new Error(`capture failed: ${r.error}`);
    return detect(await loadImg(r.dataUrl));
  }

  async function humanClick(it) {
    const input = window.__SRToolkit?.input;
    if (!input) return false;
    const j = CFG.jitter;
    const x = Math.round(it.x + rand(-j, j));
    const y = Math.round(it.y + rand(-j, j));
    // Travel time from distance, same speed model as the other modules.
    const from = input.position || { x: innerWidth / 2, y: innerHeight / 2 };
    const dist = Math.hypot(x - from.x, y - from.y);
    const moveMs = Math.min(700, Math.max(90, Math.round(dist * (0.5 + Math.random() * 0.4))));
    await input.moveTo(x, y, moveMs);
    return input.click(x, y);
  }

  async function wait(ms, label) {
    const end = Date.now() + ms;
    while (running && Date.now() < end) {
      if (label) status = `${label} (${Math.ceil((end - Date.now()) / 1000)}s)`;
      await sleep(Math.min(500, Math.max(0, end - Date.now())));
    }
  }

  async function chooseTime() {
    await wait(rand(CFG.selMin, CFG.selMax), 'choosing time in');
    if (!running) return;
    const r = await scan();
    if (!r.dialog) return;                         // already closed
    if (!r.dialog.target) { dialogTries = 99; return; }
    if (await humanClick(r.dialog.target)) stats.chosen++;
    await sleep(rand(800, 1500));
  }

  function nextItem(items) {
    const cand = items.filter(it => {
      const key = Math.round(it.x / 14) + ',' + Math.round(it.y / 14), now = Date.now();
      let a = attempts.get(key);
      if (a && now - a.t > 300000) { attempts.delete(key); a = null; }
      if (a && a.n < CFG.maxAttempts && now - a.t > 60000) a.n = 0;
      return CFG[it.type] && !(a && (now - a.t < 8000 || a.n >= CFG.maxAttempts));
    });
    return cand.length ? cand[Math.floor(Math.random() * cand.length)] : null;
  }

  async function cycle() {
    let clicked = 0; dialogTries = 0; stats.cycles++;
    for (let iter = 0; iter < 40 && running; iter++) {
      status = 'scanning';
      const r = await scan();
      if (iter === 0) stats.found = r.items.length;
      if (liveOverlay) drawOverlay(r);
      if (r.dialog) {
        if (++dialogTries > 3) {
          // Give up on this run instead of stopping the session: the dialog closes on
          // its own and the next cycle retries, so the collector is never left off.
          lastError = 'cannot pick the gather time (check Calibrate)';
          return clicked;
        }
        await chooseTime(); continue;
      }
      const it = nextItem(r.items);
      if (!it) break;
      await sleep(rand(CFG.gapMin, CFG.gapMax));
      if (await humanClick(it)) {
        stats[it.type]++; clicked++;
        const key = Math.round(it.x / 14) + ',' + Math.round(it.y / 14), a = attempts.get(key);
        attempts.set(key, { n: (a ? a.n : 0) + 1, t: Date.now() });
        await sleep(rand(1200, 2200));            // let the dialog open
      }
    }
    return clicked;
  }

  async function tick(my) {
    if (!running || my !== loopToken) return;
    // A scan is already in flight: it owns the chain and reschedules when it ends.
    if (tickBusy) return;
    if (Date.now() >= sessionEndsAt) {
      stop('session cap reached');
      return;
    }
    tickBusy = true;
    lastError = '';
    try {
      if (document.hidden) status = 'paused (hidden tab)';
      else {
        const n = await cycle();
        if (running) status = n ? `collected ${n}` : 'waiting for resources';
      }
    } catch (e) {
      // A failed capture used to vanish here, leaving the module "running" and idle.
      lastError = String((e && e.message) || e);
    } finally {
      tickBusy = false;
    }
    // Reschedule with the CURRENT token: this scan may have belonged to a run the user
    // already stopped and restarted, and the restarted chain is the one that continues.
    if (running) timer = setTimeout(() => tick(loopToken), rand(CFG.cycMin, CFG.cycMax));
  }

  function start() {
    if (running) return;
    running = true;
    lastError = '';
    status = 'starting';
    const my = ++loopToken;
    const cap = CFG.sessionMinMs + Math.random() * (CFG.sessionMaxMs - CFG.sessionMinMs);
    sessionEndsAt = Date.now() + cap;
    window.__SRToolkit?.show(true);
    tick(my);
  }

  function stop(msg) {
    running = false;
    loopToken++; // invalidate any scan that is already queued
    clearTimeout(timer);
    timer = null;
    status = msg || 'idle';
    // Deliberately NOT detaching the debugger: detaching hides Chrome's "started
    // debugging this browser" infobar, which resizes the viewport and shifts every
    // coordinate already measured.
  }

  // Draws the detection result, the excluded UI zones and the dialog buttons. Wiped by
  // every capture, so it must be re-run after each cycle while calibration is on.
  function drawOverlay(result) {
    lastResult = result;
    const hud = window.__SRToolkit;
    if (!hud) return;
    const o = hud.mountOverlay('res');
    const g = o.getContext('2d');
    g.clearRect(0, 0, o.width, o.height);

    // Excluded UI zones
    g.strokeStyle = 'rgba(255,0,0,.45)';
    g.lineWidth = 1;
    g.strokeRect(CFG.mLeft * innerWidth, CFG.mTop * innerHeight,
      innerWidth * (1 - CFG.mLeft - CFG.mRight), innerHeight * (1 - CFG.mTop - CFG.mBottom));

    const col = { meat: '#f44', wood: '#a63', gold: '#fc0', stone: '#aaa' };
    const tag = (x, y, txt, c) => {
      g.fillStyle = 'rgba(0,0,0,.75)';
      g.fillRect(x, y - 15, 54, 14);
      g.fillStyle = c;
      g.fillText(txt, x + 2, y - 4);
    };

    g.lineWidth = 2;
    g.font = 'bold 13px system-ui, sans-serif';
    result.items.forEach(t => {
      g.strokeStyle = col[t.type];
      g.strokeRect(t.x - t.w / 2, t.y - t.h / 2, t.w, t.h);
      tag(t.x - t.w / 2, t.y - t.h / 2, t.type, '#fff');
    });

    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.font = '10px system-ui, sans-serif';
    (result.rejects || []).forEach(t => {
      g.strokeStyle = '#ccc';
      g.strokeRect(t.x - t.w / 2, t.y - t.h / 2, t.w, t.h);
      const tx = t.why.slice(0, 28), tw = g.measureText(tx).width + 4;
      g.fillStyle = 'rgba(0,0,0,.75)';
      g.fillRect(t.x + t.w / 2 + 2, t.y - 6, tw, 12);
      g.fillStyle = '#fff';
      g.fillText(tx, t.x + t.w / 2 + 4, t.y + 4);
    });

    g.setLineDash([]);
    g.lineWidth = 2;
    g.font = 'bold 13px system-ui, sans-serif';
    if (result.dialog) {
      result.dialog.btns.forEach(b => {
        const isTarget = result.dialog.target === b;
        g.strokeStyle = isTarget ? '#0f0' : '#08f';
        g.strokeRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
        tag(b.x - b.w / 2, b.y - b.h / 2, isTarget ? 'CHOOSE' : 'button', isTarget ? '#0f0' : '#8cf');
      });
    }

    // Count badge (offset down so it does not overlap the meat and wood badges)
    g.fillStyle = 'rgba(0,0,0,.75)';
    g.fillRect(10, 90, 210, 34);
    g.fillStyle = result.dialog ? '#0f0' : '#4fc3f7';
    g.font = 'bold 15px system-ui, sans-serif';
    g.fillText(
      result.dialog ? 'Res: gather-time dialog' : `Res: ${result.items.length} bubble(s)`,
      20, 113
    );
  }

  async function calibrate() {
    liveOverlay = true;
    const result = await scan();
    drawOverlay(result);
    return result.items.length;
  }

  chrome.runtime.onMessage.addListener((m, s, send) => {
    if (!hasCanvas()) return;
    switch (m.type) {
      case 'RES_STATUS':
        send({ running, status, error: lastError, stats: { ...stats }, cfg: CFG, liveOverlay });
        break;
      case 'RES_TOGGLE':
        running ? stop() : start();
        send({ running });
        break;
      case 'RES_START':
        start();
        send({ ok: true, running });
        break;
      case 'RES_STOP':
        stop();
        send({ ok: true, running });
        break;
      case 'RES_CONFIG':
        Object.assign(CFG, m.config || {});
        send({ ok: true, cfg: CFG });
        break;
      case 'RES_CALIBRATE':
        calibrate().then(n => send({ n })).catch(() => send({ n: 0 }));
        return true;
    }
  });

  window.__SRToolkit?.register({
    id: 'res',
    label: 'Res',
    getStatus() {
      const base = `${stats.meat + stats.wood + stats.gold + stats.stone} picked · ${stats.chosen} timed`;
      if (running) {
        const leftMin = Math.max(0, Math.ceil((sessionEndsAt - Date.now()) / 60000));
        return { running, text: `${base} · ${leftMin}m` };
      }
      return { running, text: status === 'idle' ? base : `${base} · ${status}` };
    },
    toggle() { running ? stop() : start(); },
    calibrate() { calibrate().catch(() => {}); },
    redraw() { if (liveOverlay) drawOverlay(lastResult); }
  });

  chrome.storage.local.get(['resAutoStart'], ({ resAutoStart }) => {
    if (resAutoStart) start();
  });

})();
