// background.js — service worker
// Owns chrome.debugger attach/detach and relays CDP input for the content scripts.

let debuggeeTabId = null;

function ensureAttached(tabId, cb) {
  if (debuggeeTabId === tabId) {
    cb(null);
    return;
  }
  chrome.debugger.attach({ tabId }, '1.3', () => {
    const err = chrome.runtime.lastError;
    // The MV3 service worker is killed after ~30 s idle and loses debuggeeTabId while
    // the debugger stays attached. The next attach then fails with "already attached"
    // and every click fails for good, so that case counts as success.
    if (err && !/already attached/i.test(err.message)) {
      cb(err.message);
      return;
    }
    debuggeeTabId = tabId;
    cb(null);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  if (msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: senderTabId });
    return true;
  }

  if (msg.type === 'CAPTURE_SCREENSHOT') {
    // JPEG encodes ~10x faster than PNG (118 ms -> 10 ms at 1600x900), which is the
    // single biggest cost left in a capture cycle. 'png' is still available as the
    // lossless path the detectors fall back to.
    const format = msg.format === 'png' ? 'png' : 'jpeg';
    const options = format === 'png'
      ? { format: 'png' }
      : { format: 'jpeg', quality: msg.quality ?? 95 };
    // Pin the game's own window: `null` means "whichever window is current", so with
    // another window focused the capture returned that window's tab instead of the game.
    chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? null, options, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true;
  }

  if (msg.type === 'ENSURE_DEBUGGER') {
    const tabId = msg.tabId ?? senderTabId;
    if (!tabId) {
      sendResponse({ error: 'no tab id' });
      return true;
    }
    const wasAttached = debuggeeTabId === tabId;
    ensureAttached(tabId, (err) => {
      if (err) sendResponse({ error: err, attached: false });
      else sendResponse({ ok: true, attached: !wasAttached });
    });
    return true;
  }

  // Cursor movement and clicks share the same attach path.
  if (msg.type === 'DEBUGGER_MOVE' || msg.type === 'DEBUGGER_CLICK') {
    const tabId = msg.tabId ?? senderTabId;
    const { x, y } = msg;
    if (!tabId) {
      sendResponse({ error: 'no tab id' });
      return true;
    }

    ensureAttached(tabId, (err) => {
      if (err) {
        sendResponse({ error: err });
        return;
      }

      if (msg.type === 'DEBUGGER_MOVE') {
        chrome.debugger.sendCommand(
          { tabId },
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
          () => {
            if (chrome.runtime.lastError) {
              sendResponse({ error: chrome.runtime.lastError.message });
              return;
            }
            sendResponse({ ok: true });
          }
        );
        return;
      }

      chrome.debugger.sendCommand(
        { tabId },
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
        () => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }
          chrome.debugger.sendCommand(
            { tabId },
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 },
            () => {
              if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
                return;
              }
              sendResponse({ ok: true });
            }
          );
        }
      );
    });
    return true;
  }

  // Press, sweep along the path, release. One gesture instead of N clicks.
  if (msg.type === 'DEBUGGER_DRAG') {
    const tabId = msg.tabId ?? senderTabId;
    const { from, to, path = [], duration = 900 } = msg;
    if (!tabId) {
      sendResponse({ error: 'no tab id' });
      return true;
    }
    ensureAttached(tabId, async (err) => {
      if (err) {
        sendResponse({ error: err });
        return;
      }
      const dispatch = (type, x, y, buttons, button) => new Promise((res) =>
        chrome.debugger.sendCommand(
          { tabId },
          'Input.dispatchMouseEvent',
          { type, x, y, button, buttons, clickCount: 1 },
          () => res()
        ));
      let totalW = 0;
      for (const p of path) totalW += p.w || 1;
      const t0 = Date.now();
      let acc = 0;
      try {
        await dispatch('mousePressed', from.x, from.y, 1, 'left');
        for (const p of path) {
          await dispatch('mouseMoved', p.x, p.y, 1, 'none');
          acc += p.w || 1;
          const wait = duration * (acc / Math.max(1, totalW)) - (Date.now() - t0);
          if (wait > 1) await new Promise(r => setTimeout(r, wait));
        }
        await dispatch('mouseMoved', to.x, to.y, 1, 'none');
        await dispatch('mouseReleased', to.x, to.y, 0, 'left');
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    });
    return true;
  }

  if (msg.type === 'DEBUGGER_DETACH') {
    if (debuggeeTabId) {
      const id = debuggeeTabId;
      chrome.debugger.detach({ tabId: id }, () => {
        void chrome.runtime.lastError; // already detached is fine
        debuggeeTabId = null;
        sendResponse({ ok: true });
      });
      return true;
    }
    sendResponse({ ok: true });
  }
});

// If the debugger is detached behind our back (the user pressing "Cancel" on the
// "started debugging this browser" infobar, DevTools opening, tab closing), the cached
// id goes stale and every later click fails silently. Reset it so the next click re-attaches.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === debuggeeTabId) {
    debuggeeTabId = null;
  }
});

// Limpiar debugger al cerrar tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === debuggeeTabId) {
    chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
    debuggeeTabId = null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
});

// Keyboard shortcut: toggles the in-page HUD. This is the only way to reach the
// controls while the page is in fullscreen, where the toolbar (and the popup) is hidden.
chrome.commands.onCommand.addListener((command) => {
  // 'stop-all' is the panic button: it stops every module in the active tab.
  const type = command === 'toggle-hud' ? 'HUD_TOGGLE' : command === 'stop-all' ? 'STOP_ALL' : null;
  if (!type) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
  });
});
