// popup.js — minimal control surface for the three modules.
const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

function paint(prefix, res, runningLabel, idleLabel, statsText) {
  const dot = $(prefix + 'Dot');
  const btn = $(prefix + 'Toggle');
  const stats = $(prefix + 'Stats');

  if (!res) {
    dot.className = 'dot';
    btn.textContent = idleLabel;
    btn.className = 'toggle';
    stats.textContent = 'no connection';
    return false;
  }

  dot.className = 'dot ' + (res.running ? 'on' : '');
  btn.textContent = res.running ? runningLabel : idleLabel;
  btn.className = 'toggle' + (res.running ? ' on' : '');
  stats.textContent = statsText(res);
  return true;
}

let meatCalibration = null;
let meatNote = null; // transient calibration result or failure reason
// Transient calibration results / failure reasons, per module.
const notes = {};
const noted = (k) => (notes[k] && Date.now() < notes[k].until ? notes[k].text : null);
// Chrome allows ~2 captures/second; a high count here means the loops are polling too fast.
const capErr = (r) => (r && r.captureErrors ? ` · ${r.captureErrors} capture errors` : '');
function calNote(k, r, unit) {
  if (!r) notes[k] = { text: 'no answer from the tab (reload the game page)', until: Date.now() + 8000 };
  else if (r.error) notes[k] = { text: String(r.error).replace(/^Error:\s*/, ''), until: Date.now() + 12000 };
  else notes[k] = { text: `calibrated: ${r.n} ${unit}`, until: Date.now() + 6500 };
}
let resOptionFilled = false;
let meatModeFilled = false;

async function refresh() {
  const [meat, wood, res] = await Promise.all([
    send({ type: 'MEAT_STATUS' }),
    send({ type: 'WOOD_STATUS' }),
    send({ type: 'RES_STATUS' })
  ]);

  const meatOk = paint('meat', meat, 'Stop', 'Start', (r) => {
    if (meatNote && Date.now() < meatNote.until) return meatNote.text;
    if (meatCalibration !== null) return `calibrated: ${meatCalibration} icon(s)`;
    if (r.error) return String(r.error);
    const base = `${r.stats.collected} clicks · ${r.stats.cycles} cycles${capErr(r)}`;
    if (r.running && r.nextCollectionTime) {
      const secs = Math.max(0, Math.ceil((r.nextCollectionTime - Date.now()) / 1000));
      return `${base} · next ${secs}s`;
    }
    if (r.running && r.isTabVisible === false) return `${base} · hidden tab`;
    return base;
  });

  const woodOk = paint('wood', wood, 'Stop', 'Start', (r) => {
    const n = noted('wood');
    if (n) return n;
    if (r.error) return String(r.error);
    return `${r.stats.clicked} marks · ${r.stats.found} seen${capErr(r)}`;
  });

  const resOk = paint('res', res, 'Stop', 'Start', (r) => {
    const n = noted('res');
    if (n) return n;
    if (r.error) return String(r.error);
    const s = r.stats;
    return `${s.meat}🥩 ${s.wood}🪵 ${s.gold}🪙 ${s.stone}🪨 · ${s.chosen} timed${capErr(r)}`;
  });

  if (res && !resOptionFilled) {
    $('resOption').value = String(res.cfg.option);
    resOptionFilled = true;
  }

  if (meat && !meatModeFilled) {
    $('meatMode').value = meat.cfg.collectMode || 'click';
    meatModeFilled = true;
  }

  $('foot').textContent = meatOk || woodOk || resOk
    ? 'Ctrl+Shift+Y toggles the HUD in fullscreen'
    : 'open the game tab and reload the page';
}

$('meatToggle').addEventListener('click', async () => {
  await send({ type: 'MEAT_TOGGLE' });
  refresh();
});

$('woodToggle').addEventListener('click', async () => {
  await send({ type: 'WOOD_TOGGLE' });
  refresh();
});

$('resToggle').addEventListener('click', async () => {
  await send({ type: 'RES_TOGGLE' });
  refresh();
});

$('meatCal').addEventListener('click', async () => {
  const r = await send({ type: 'MEAT_CALIBRATE' });
  // A silent "nothing happened" is the worst outcome: distinguish "the tab never
  // answered" from "the capture failed" from "the screen has no icons on it".
  if (!r) {
    meatNote = { text: 'no answer from the tab (reload the game page)', until: Date.now() + 8000 };
  } else if (r.error) {
    meatNote = { text: String(r.error).replace(/^Error:\s*/, ''), until: Date.now() + 12000 };
    meatCalibration = null; // never let a stale count outlive the failure message
  } else {
    meatNote = null;
    meatCalibration = r.n;
    setTimeout(() => { meatCalibration = null; }, 6500);
  }
  refresh();
});

$('woodCal').addEventListener('click', async () => {
  calNote('wood', await send({ type: 'WOOD_CALIBRATE' }), 'tree(s)');
  refresh();
});

$('resCal').addEventListener('click', async () => {
  calNote('res', await send({ type: 'RES_CALIBRATE' }), 'bubble(s)');
  refresh();
});

// Gather-time choice for the resource bubbles. Without this the module kept its
// default (0 = 5 min) no matter what the popup showed.
$('resOption').addEventListener('change', async (e) => {
  await send({ type: 'RES_CONFIG', config: { option: Number(e.target.value) } });
});

$('meatApply').addEventListener('click', async () => {
  const cfg = {};
  ['minDelay','maxDelay','dragMinDelay','dragMaxDelay','clickDelayMin','clickDelayMax'].forEach(k => {
    const v = Number($('meat_' + k).value);
    if (Number.isFinite(v) && v >= 0) cfg[k] = v;
  });
  if (Object.keys(cfg).length) await send({ type: 'MEAT_CONFIG', config: cfg });
  refresh();
});

$('meatCustom').addEventListener('change', async (e) => {
  const box = $('meatTiming');
  box.style.display = e.target.checked ? 'block' : 'none';
  if (e.target.checked && !$('meat_minDelay').value) {
    const r = await send({ type: 'MEAT_STATUS' });
    if (r && r.cfg) {
      const c = r.cfg;
      $('meat_minDelay').value = c.minDelay;
      $('meat_maxDelay').value = c.maxDelay;
      $('meat_dragMinDelay').value = c.dragMinDelay;
      $('meat_dragMaxDelay').value = c.dragMaxDelay;
      $('meat_clickDelayMin').value = c.clickDelayMin;
      $('meat_clickDelayMax').value = c.clickDelayMax;
    }
  }
});

$('meatMode').addEventListener('change', async (e) => {
  await send({ type: 'MEAT_CONFIG', config: { collectMode: e.target.value } });
});

// Input mode: 'debugger' (trusted CDP events + Chrome's debugging infobar) or
// 'synthetic' (no debugger at all, but isTrusted:false).
const inputBtn = $('inputMode');

function paintInputMode(mode) {
  inputBtn.textContent = mode === 'synthetic' ? 'Input: synthetic' : 'Input: debugger';
}

chrome.storage.local.get(['inputMode'], ({ inputMode }) => paintInputMode(inputMode || 'synthetic'));

inputBtn.addEventListener('click', async () => {
  const { inputMode } = await chrome.storage.local.get(['inputMode']);
  const cur = inputMode || 'synthetic';
  const next = cur === 'synthetic' ? 'debugger' : 'synthetic';
  await chrome.storage.local.set({ inputMode: next });
  paintInputMode(next);
});

$('stopAll').addEventListener('click', async () => {
  await send({ type: 'STOP_ALL' });
  refresh();
});

$('hudToggle').addEventListener('click', async () => {
  await send({ type: 'HUD_TOGGLE' });
});

// Capture encoding: 'jpeg' is ~10x faster to encode but lossy (4:2:0 chroma
// subsampling softens the thin white border the meat detector looks for). 'png' is
// lossless. Both modules retry with PNG when a fast capture finds nothing, so this
// only needs to be pinned to PNG if detections look unreliable. The resource-bubble
// detector always uses PNG: its white threshold (243) is too tight for JPEG.
const formatBtn = $('captureFormat');

function paintCaptureFormat(fmt) {
  formatBtn.textContent = fmt === 'png' ? 'Capture: lossless (PNG)' : 'Capture: fast (JPEG)';
}

chrome.storage.local.get(['captureFormat'], ({ captureFormat }) => paintCaptureFormat(captureFormat || 'jpeg'));

formatBtn.addEventListener('click', async () => {
  const { captureFormat } = await chrome.storage.local.get(['captureFormat']);
  const next = (captureFormat || 'jpeg') === 'jpeg' ? 'png' : 'jpeg';
  await chrome.storage.local.set({ captureFormat: next });
  paintCaptureFormat(next);
});

setInterval(refresh, 1000);
refresh();
