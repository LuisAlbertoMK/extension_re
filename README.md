# extension_re

Chrome extension plus a Node test harness for resource collection in **Social Reborn**
(`empires.socialreborn.com`).

> Personal-use tooling for a single game. Automating gameplay may violate that game's
> Terms of Service; use it on your own account and at your own risk.

## Modules

| Module | What it does |
| --- | --- |
| `meat` | Detects the white-box / red-centre meat icons on the canvas and clicks them one by one. |
| `wood` | Detects trunks with green canopy above them and marks the trees. |
| `res` | Detects white resource bubbles, classifies meat/wood/gold/stone, then clicks them one at a time: every click opens the 2x2 gather-time dialog for that building and the configured option is picked before the next bubble. |
| HUD | In-page panel (Shadow DOM) with a calibration overlay. `Ctrl+Shift+Y` toggles it, which is the only control surface in fullscreen. |

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** and select `social-reborn-toolkit/`.
3. Open the game and reload the page so the content scripts pick up the new build.

The popup controls start/stop, calibration, the meat collect mode and the capture
format. Input is synthesized (`isTrusted: false`) by default; debugger mode uses CDP and
raises Chrome's "started debugging this browser" infobar.

## Tests

Node only, no dependencies. Run from the repository root:

```
node tests/run.cjs                  # golden-file detector regression (meat, wood, res)
node tests/meat_loop.cjs            # click burst, drag mode, stop mid-burst
node tests/control.cjs              # one chain at a time: stop/start/resume
node tests/meat_stale_start_timer.cjs
node tests/meat_policy.cjs          # 100% click-only pacing
node tests/res_loop.cjs             # resource collector end to end
node tests/hud_ui.cjs               # HUD row buttons and calibration reporting
```

`node tests/run.cjs --update` rewrites `tests/golden.json` after an intentional
threshold change; review the diff before committing it.

## Layout

```
social-reborn-toolkit/    the extension (manifest v3)
  content/hud.js          shared HUD, overlays, capture and input serialization
  content/{meat,wood,resources}.js
  background.js           debugger attach, CDP input, screenshot capture
  popup.{html,js}
tests/                    detector and loop harnesses
```
