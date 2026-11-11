// content/hud.js — shared in-page HUD + overlay host.
// Loaded before the meat and wood modules; both register into window.__SRToolkit.
// Lives inside a Shadow DOM so the game's CSS cannot restyle it, and it re-parents
// itself into the fullscreen element so it stays visible in HTML5 fullscreen
// (where the browser toolbar, and therefore the popup, is unreachable).
(() => {
  'use strict';
  if (window.__SRToolkit) return;

  const Z = 2147483647;
  // The HUD UI lives in the top frame only. Calibration overlays still mount in
  // whichever frame owns the canvas.
  const isTop = window.top === window;
  const modules = [];
  const rows = new Map();

  let hostEl = null;
  let shadow = null;
  let listEl = null;
  let timer = null;
  let visible = false;
  let userHidden = false;

  // Only the fullscreen element subtree is painted while in fullscreen.
  // A canvas cannot render children, so fall back to its parent.
  function fsHost() {
    const fe = document.fullscreenElement;
    if (!fe) return document.body;
    return fe.tagName === 'CANVAS' ? (fe.parentElement || document.body) : fe;
  }

  function build() {
    if (!isTop) return;
    if (hostEl && hostEl.isConnected) return;

    hostEl = document.createElement('div');
    hostEl.id = '__sr_toolkit_hud';
    Object.assign(hostEl.style, {
      position: 'fixed', top: '10px', right: '10px',
      zIndex: String(Z), pointerEvents: 'none'
    });

    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .panel {
          font: 12px/1.35 system-ui, -apple-system, sans-serif;
          background: rgba(18, 18, 28, .9); color: #e8e8ef;
          border-radius: 10px; padding: 8px; width: 200px;
          /* The panel must not swallow clicks meant for the game underneath. */
          pointer-events: none; box-shadow: 0 4px 18px rgba(0, 0, 0, .45);
        }
        .head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
        .title {
          flex: 1; font-size: 10px; font-weight: 700; letter-spacing: .6px;
          text-transform: uppercase; color: #6f6f8c;
        }
        button {
          font: inherit; font-size: 11px; border: 0; border-radius: 6px;
          background: #2f2f42; color: #cfcfe0; cursor: pointer; padding: 3px 6px;
          pointer-events: auto;
        }
        button:hover { background: #3a3a52; }
        .row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #4a4a60; flex: none; }
        .dot.on { background: #4ade80; }
        .name { width: 32px; font-size: 11px; font-weight: 600; }
        .stat {
          flex: 1; font-size: 10px; color: #8b8ba3;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .toggle { min-width: 24px; }
        .toggle.on { background: #166534; color: #dcfce7; }
      </style>
      <div class="panel">
        <div class="head">
          <span class="title">Toolkit</span>
          <button data-act="clear" title="Clear overlays and hide HUD">✕</button>
        </div>
        <div class="list"></div>
      </div>
    `;

    listEl = shadow.querySelector('.list');
    shadow.querySelector('[data-act="clear"]').addEventListener('click', () => {
      clearOverlay();
      hide();
    });

    modules.forEach(buildRow);
    modules.forEach(renderRow);
  }

  function buildRow(m) {
    if (rows.has(m.id)) return;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="dot"></span><span class="name"></span><span class="stat"></span>' +
      '<button class="toggle" data-act="toggle" title="Start / stop">▶</button>' +
      '<button data-act="cal" title="Calibrate">🎯</button>';
    row.querySelector('.name').textContent = m.label;
    row.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      // The HUD is the only control surface in fullscreen, where the popup cannot be
      // opened, so this button has to drive the module itself.
      if (m.toggle) m.toggle();
      renderRow(m);
    });
    row.querySelector('[data-act="cal"]').addEventListener('click', () => {
      if (!m.calibrate) return;
      // Never swallow the failure: a broken calibration is indistinguishable from a bad
      // threshold unless the row says which one it is.
      const done = (text) => { flashRow(row, text); renderRow(m); };
      done('calibrating...');
      Promise.resolve()
        .then(() => m.calibrate())
        .then(n => done(typeof n === 'number' ? `calibrated: ${n} icon(s)` : 'calibrated'))
        .catch(err => done((err && err.message) || String(err)));
    });
    listEl.appendChild(row);
    rows.set(m.id, row);
  }

  function renderRow(m) {
    const row = rows.get(m.id);
    if (!row) return;
    let st = { running: false, text: '—' };
    try { st = m.getStatus() || st; } catch { /* ignore */ }
    row.querySelector('.dot').className = 'dot' + (st.running ? ' on' : '');
    // A calibration result (or the reason it failed) is shown for a few seconds; the
    // 1 s repaint would otherwise wipe it before it can be read.
    const flash = row.__flash;
    row.querySelector('.stat').textContent =
      (flash && Date.now() < flash.until) ? flash.text : st.text;
    const btn = row.querySelector('.toggle');
    btn.textContent = st.running ? '⏹' : '▶';
    btn.className = 'toggle' + (st.running ? ' on' : '');
  }

  function flashRow(row, text) {
    row.__flash = { text: String(text), until: Date.now() + 6000 };
  }

  function render() {
    if (!visible) return;
    modules.forEach(renderRow);
  }

  const overlays = new Map(); // owner -> canvas
  let overlaySize = { w: innerWidth, h: innerHeight };

  function hasOverlay(owner) { return overlays.has(owner); }

  // A viewport change (Chrome's debugger infobar appearing, window resize, fullscreen)
  // re-lays out the game. The overlay canvas keeps its old backing store and CSS
  // stretches it to the new size, which visually shifts every mark. Re-size the
  // buffers (that clears them) and let the modules repaint from their last result.
  function resyncOverlays() {
    const w = innerWidth, h = innerHeight;
    if (w === overlaySize.w && h === overlaySize.h) return;
    overlaySize = { w, h };
    overlays.forEach(c => {
      c.width = w;
      c.height = h;
    });
    modules.forEach(m => {
      if (m.redraw) m.redraw();
    });
  }

  window.addEventListener('resize', () => { invalidateHit(); resyncOverlays(); });

  function hideChrome() {
    if (hostEl) hostEl.style.visibility = 'hidden';
    overlays.forEach(c => { c.style.visibility = 'hidden'; });
  }

  function showChrome() {
    if (hostEl) hostEl.style.visibility = '';
    overlays.forEach(c => { c.style.visibility = ''; });
  }

  function wipeOverlays() {
    overlays.forEach(c => {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
    });
  }

  // Two animation frames (raced against a timeout, since rAF is paused on hidden tabs).
  const nextPaint = () => Promise.race([
    new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise(r => setTimeout(r, 120))
  ]);

  // Attach the debugger up front (no-op if already attached) and, when it was just
  // attached, wait for the infobar-induced resize to settle before measuring anything.
  async function ensureDebuggerSettled() {
    await inputModeReady;
    // Synthetic mode must never touch the debugger: attaching it is exactly the signal
    // we are trying to avoid, and it raises the infobar.
    if (inputMode === 'synthetic') return false;

    let attachedNow = false;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'ENSURE_DEBUGGER' });
      attachedNow = !!(r && r.attached);
    } catch { /* ignore */ }
    if (attachedNow) await settle();
    return attachedNow;
  }

  // Resolves once no resize has fired for 260 ms, capped at 700 ms.
  function settle(timeout = 700) {
    return new Promise(resolve => {
      let finished = false;
      let quiet = null;
      let hard = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('resize', onResize);
        clearTimeout(quiet);
        clearTimeout(hard);
        nextPaint().then(resolve);
      };
      const onResize = () => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, 260);
      };
      quiet = setTimeout(finish, 260);
      hard = setTimeout(finish, timeout);
      window.addEventListener('resize', onResize);
    });
  }

  // captureVisibleTab photographs the page, so the HUD and any calibration overlay
  // end up inside the screenshot and poison detection. Hide everything for a couple
  // of frames, capture, then wipe the now-stale drawings.
  // Serialized: with both modules running, concurrent captures would let one module's
  // restored overlay leak into the other's screenshot.
  let captureLock = Promise.resolve();

  function captureClean(options) {
    // Both callbacks must ignore the previous promise's value/reason: doCaptureClean
    // takes the capture options, not whatever the last capture resolved to.
    const run = captureLock.then(
      () => doCaptureClean(options),
      () => doCaptureClean(options)
    );
    captureLock = run.catch(() => {});
    return run;
  }

  async function doCaptureClean(options) {
    // 'png' from any caller wins: that is the lossless fallback the detectors use when
    // the fast path finds nothing, and the mode the user can pin in the popup.
    const wantsPng = (options && options.format === 'png') || captureFormat === 'png';
    const format = wantsPng ? 'png' : 'jpeg';
    const quality = options && options.quality;
    // Attaching the debugger raises Chrome's infobar, which shrinks the viewport and
    // makes the game re-layout. Measuring before that settles puts every coordinate
    // off by the infobar height, so attach first and wait for the resize to go quiet.
    await ensureDebuggerSettled();

    hideChrome();
    try {
      await nextPaint();
      await new Promise(r => setTimeout(r, 40));
      let res = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', format, quality });
      if (!res || res.error) {
        // captureVisibleTab is throttled to ~2 calls/sec; back off once and retry.
        await new Promise(r => setTimeout(r, 650));
        res = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', format, quality });
      }
      return res;
    } finally {
      wipeOverlays();
      showChrome();
    }
  }

  // One overlay layer per owner so meat and wood calibration can coexist on screen.
  function mountOverlay(owner = 'default') {
    const parent = fsHost();
    let c = overlays.get(owner);
    if (!c) {
      c = document.createElement('canvas');
      Object.assign(c.style, {
        position: 'fixed', left: '0', top: '0',
        width: '100%', height: '100%',
        zIndex: String(Z - 1), pointerEvents: 'none'
      });
      overlays.set(owner, c);
    }
    c.width = innerWidth;
    c.height = innerHeight;
    overlaySize = { w: innerWidth, h: innerHeight };
    if (c.parentElement !== parent) parent.appendChild(c);
    return c;
  }

  function clearOverlay(owner) {
    if (owner === undefined) {
      overlays.forEach(c => c.remove());
      overlays.clear();
      return;
    }
    const c = overlays.get(owner);
    if (c) { c.remove(); overlays.delete(owner); }
  }

  // ------------------------------------------------------------------- input
  // Two dispatch modes, selectable from the popup:
  //   'debugger'  - CDP Input.dispatchMouseEvent. Events are isTrusted, but Chrome
  //                 raises the "started debugging this browser" infobar and a page can
  //                 detect the attached debugger.
  //   'synthetic' - PointerEvent/MouseEvent dispatched by the content script. No
  //                 debugger and no infobar, but isTrusted is false and some games
  //                 ignore them.
  // Proven on this game: it does not gate on isTrusted, so synthetic is the default.
  let inputMode = 'synthetic';
  let mouse = null; // last known cursor position
  // Capture encoding: 'jpeg' encodes ~10x faster than 'png' at 1600x900 (10 ms vs
  // 118 ms) but uses 4:2:0 chroma subsampling. 'png' is lossless and exact.
  let captureFormat = 'jpeg';

  // Resolves once the stored mode is known, so the first capture cannot race it and
  // attach the debugger before we find out we are supposed to be in synthetic mode.
  const inputModeReady = new Promise((resolve) => {
    chrome.storage.local.get(['inputMode', 'captureFormat'], ({ inputMode: saved, captureFormat: savedFormat }) => {
      if (saved === 'synthetic' || saved === 'debugger') inputMode = saved;
      if (savedFormat === 'png' || savedFormat === 'jpeg') captureFormat = savedFormat;
      if (inputMode === 'synthetic') detachDebugger();
      resolve();
    });
  });

  function detachDebugger() {
    chrome.runtime.sendMessage({ type: 'DEBUGGER_DETACH' }).catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.captureFormat) {
      captureFormat = changes.captureFormat.newValue === 'png' ? 'png' : 'jpeg';
    }
    if (!changes.inputMode) return;
    const v = changes.inputMode.newValue;
    inputMode = (v === 'synthetic' || v === 'debugger') ? v : 'synthetic';
    mouse = null;
    // Leaving debugger mode must drop the attached debugger, otherwise Chrome keeps
    // showing the "started debugging this browser" infobar.
    if (inputMode === 'synthetic') detachDebugger();
  });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Quadratic bezier between two points with a random perpendicular bend, sampled with
  // ease-in-out: no straight lines and no constant velocity.
  function curve(from, to, steps) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const bend = (Math.random() - 0.5) * Math.min(len * 0.4, 140);
    const cx = (from.x + to.x) / 2 + (-dy / len) * bend;
    const cy = (from.y + to.y) / 2 + (dx / len) * bend;

    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      const u = 1 - e;
      pts.push({
        x: Math.round(u * u * from.x + 2 * u * e * cx + e * e * to.x),
        y: Math.round(u * u * from.y + 2 * u * e * cy + e * e * to.y)
      });
    }
    return pts;
  }

  // ------------------------------------------------------- input: hit test cache
  // Shared cursor lock: the mouse is a single resource, and the modules run their loops
  // concurrently. Without this a burst from one module can interleave with moves from
  // another and leave the cursor pointing at the wrong element.
  let mouseLock = Promise.resolve();

  function acquireMouse() {
    let release;
    const p = new Promise(r => { release = r; });
    const prev = mouseLock;
    mouseLock = p;
    return prev.then(() => release);
  }

  // elementFromPoint runs a hit test against the live layout, and one moveTo() fires
  // up to 12 pointermove events plus the click. The element under the game's canvas
  // does not change along a short path, so resolve it once per movement instead of
  // once per sampled point (13 hit tests per click -> 1).
  let hitCache = null; // { el, x, y }

  function invalidateHit() { hitCache = null; }

  function hitTest(x, y) {
    // Reuse only when the cached node is still live AND the new point is close to
    // where it was resolved, so crossing into another element re-tests.
    if (hitCache && hitCache.el.isConnected &&
        Math.abs(hitCache.x - x) <= 40 && Math.abs(hitCache.y - y) <= 40) {
      return hitCache.el;
    }
    const el = document.elementFromPoint(x, y);
    hitCache = el ? { el, x, y } : null;
    return el;
  }

  async function dispatchMove(x, y, el) {
    if (inputMode === 'synthetic') {
      const target = el || hitTest(x, y);
      if (!target) return;
      const opts = {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, screenX: x, screenY: y, view: window,
        button: -1, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
      };
      target.dispatchEvent(new PointerEvent('pointermove', opts));
      target.dispatchEvent(new MouseEvent('mousemove', opts));
      return;
    }
    try { await chrome.runtime.sendMessage({ type: 'DEBUGGER_MOVE', x, y }); } catch { /* ignore */ }
  }

  // Public wrappers: serialize every cursor operation so two modules cannot fight
  // over the same mouse. The lock is released in a finally block so an exception
  // (or an aborted drag) never leaves the next caller waiting forever.
  async function moveTo(x, y, duration = 300) {
    const release = await acquireMouse();
    try {
      return await moveToImpl(x, y, duration);
    } finally {
      release();
    }
  }

  async function click(x, y) {
    const release = await acquireMouse();
    try {
      return await clickImpl(x, y);
    } finally {
      release();
    }
  }

  async function drag(pts, duration = 900) {
    const release = await acquireMouse();
    try {
      return await dragImpl(pts, duration);
    } finally {
      release();
    }
  }

  // Walk the cursor to (x, y) over `duration` ms, paced so the whole path fits.
  async function moveToImpl(x, y, duration = 300) {
    if (!mouse) {
      // Start off-target, like a cursor that was resting somewhere else on the screen.
      mouse = {
        x: Math.round(x + (Math.random() - 0.5) * innerWidth * 0.7),
        y: Math.round(y + (Math.random() - 0.5) * innerHeight * 0.7)
      };
    }

    const dist = Math.hypot(x - mouse.x, y - mouse.y);
    if (dist < 3) {
      mouse = { x, y };
      return;
    }

    const steps = Math.max(3, Math.min(12, Math.round(dist / 45)));
    const pts = curve(mouse, { x, y }, steps);
    // Resolved at the destination: that is the element the click has to reach.
    const target = inputMode === 'synthetic' ? hitTest(x, y) : null;

    const t0 = performance.now();
    for (let i = 0; i < pts.length; i++) {
      await dispatchMove(pts[i].x, pts[i].y, target);
      const due = duration * ((i + 1) / pts.length);
      const wait = due - (performance.now() - t0);
      if (wait > 1) await sleep(wait);
    }
    mouse = { x, y };
  }

  async function clickImpl(x, y) {
    if (inputMode === 'synthetic') {
      // Reuses the element resolved by the preceding moveTo(); only re-tests when
      // there is no live cached node.
      const el = hitTest(x, y);
      if (!el) return false;
      const base = {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, screenX: x, screenY: y, view: window,
        button: 0, detail: 1
      };
      const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
      return true;
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'DEBUGGER_CLICK', x, y });
      return !(r && r.error);
    } catch {
      return false;
    }
  }

  // Press, sweep along `pts`, release. Games that collect whatever the cursor passes
  // over while the button is held turn N separate clicks into a single gesture.
  async function dragImpl(pts, duration = 900) {
    if (!pts || pts.length < 2) return false;
    const start = pts[0], end = pts[pts.length - 1];

    if (inputMode === 'synthetic') {
      const el = hitTest(start.x, start.y);
      if (!el) return false;
      const base = {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, detail: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      };
      const ev = (type, x, y, buttons) => {
        const o = { ...base, clientX: x, clientY: y, screenX: x, screenY: y, buttons };
        if (type[0] === 'p') el.dispatchEvent(new PointerEvent(type, o));
        else el.dispatchEvent(new MouseEvent(type, o));
      };
      ev('pointerdown', start.x, start.y, 1);
      ev('mousedown', start.x, start.y, 1);
      let totalW = 0;
      for (let i = 1; i < pts.length; i++) totalW += pts[i].w || 1;
      const t0 = performance.now();
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        ev('pointermove', pts[i].x, pts[i].y, 1);
        ev('mousemove', pts[i].x, pts[i].y, 1);
        acc += pts[i].w || 1;
        const wait = duration * (acc / totalW) - (performance.now() - t0);
        if (wait > 1) await sleep(wait);
      }
      ev('pointerup', end.x, end.y, 0);
      ev('mouseup', end.x, end.y, 0);
      mouse = { x: end.x, y: end.y };
      return true;
    }

    try {
      const r = await chrome.runtime.sendMessage({
        type: 'DEBUGGER_DRAG', from: start, to: end, path: pts, duration,
      });
      if (r && r.ok) { mouse = { x: end.x, y: end.y }; return true; }
      return false;
    } catch {
      return false;
    }
  }

  function show(auto) {
    if (!isTop) return;
    if (auto && userHidden) return;
    userHidden = false;
    build();
    const parent = fsHost();
    if (hostEl.parentElement !== parent) parent.appendChild(hostEl);
    visible = true;
    render();
    if (!timer) timer = setInterval(render, 1000);
  }

  function hide() {
    visible = false;
    userHidden = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (hostEl) hostEl.remove();
  }

  function toggle() {
    visible ? hide() : show();
    return visible;
  }

  // Moving between normal and fullscreen replaces the rendered subtree root:
  // re-parent both the HUD and the calibration overlay every time.
  function onFullscreenChange() {
    invalidateHit();
    const parent = fsHost();
    overlays.forEach(c => { if (c.parentElement !== parent) parent.appendChild(c); });
    if (visible) {
      if (hostEl && hostEl.parentElement !== parent) parent.appendChild(hostEl);
    } else if (document.fullscreenElement && !userHidden) {
      show(true);
    }
  }

  document.addEventListener('fullscreenchange', onFullscreenChange);

  window.__SRToolkit = {
    register(m) {
      if (!m || !m.id || modules.some(x => x.id === m.id)) return;
      modules.push(m);
      if (listEl) { buildRow(m); renderRow(m); }
    },
    mountOverlay,
    clearOverlay,
    hasOverlay,
    captureClean,
    get captureFormat() { return captureFormat; },
    input: {
      moveTo,
      click,
      drag,
      get mode() { return inputMode; },
      get position() { return mouse ? { x: mouse.x, y: mouse.y } : null; }
    },
    show,
    hide,
    toggle,
    refresh: render,
    get visible() { return visible; }
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isTop) return;
    switch (msg.type) {
      case 'HUD_TOGGLE':
        sendResponse({ visible: toggle() });
        break;
      case 'HUD_SHOW':
        show();
        sendResponse({ visible: true });
        break;
      case 'HUD_HIDE':
        hide();
        sendResponse({ visible: false });
        break;
      case 'HUD_STATUS':
        sendResponse({ visible });
        break;
    }
  });
})();
