# extension_re

Chrome extension plus a Node test harness for resource collection in **Social Reborn**
(`empires.socialreborn.com`).

> Personal-use tooling for a single game. Automating gameplay may violate that game's
> Terms of Service; use it on your own account and at your own risk.

## Modules

| Module | What it does |
| --- | --- |
| `meat` | Detects the white-box / red-centre meat icons on the canvas. Three out of four runs sweep the cursor over them with the button held (drag); the fourth clicks them one by one. |
| `wood` | Detects trunks with green canopy above them and marks the tree nearest to the villager (the last tree it cut), so the walk is the shortest one. |
| `res` | Detects white resource bubbles, classifies meat/wood/gold/stone, then clicks them one at a time: every click opens the 2x2 gather-time dialog for that building and the configured option is picked before the next bubble. |
| HUD | In-page panel (Shadow DOM) with a calibration overlay. `Ctrl+Shift+Y` toggles it, which is the only control surface in fullscreen. |

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** and select `social-reborn-toolkit/`.
3. Open the game and reload the page so the content scripts pick up the new build.

The popup controls start/stop, calibration, the meat collect mode, the gather time, the
per-module autostart-on-reload and the capture format. Input is synthesized
(`isTrusted: false`) by default; debugger mode uses CDP and raises Chrome's "started
debugging this browser" infobar.

Nothing below is a promise of invisibility: `isTrusted` is `false` in synthetic mode and a
page can read it. What the input layer does do is stop being *trivially* distinguishable —
cursor paths are eased curves, every move carries real `movementX`/`movementY` deltas,
screen coordinates include the window and browser-chrome offset, and every wait is drawn
from a right-skewed distribution instead of a rectangle with hard edges.

## Tests

Node only, no dependencies. Run from the repository root:

```
node tests/run.cjs                  # golden-file detector regression (meat, wood, res)
node tests/meat_loop.cjs            # click burst, drag mode, stop mid-burst
node tests/control.cjs              # one chain at a time: stop/start/resume
node tests/meat_stale_start_timer.cjs
node tests/meat_policy.cjs          # 100% click-only pacing
node tests/res_loop.cjs             # resource collector end to end
node tests/wood_loop.cjs            # empty map and capture errors never stop the run
node tests/wood_villager.cjs        # a villager that never cuts stops the module
node tests/wood_nearest.cjs         # the trunk nearest to the villager is the one cut
node tests/hud_ui.cjs               # HUD row buttons and calibration reporting
node tests/hud_input.cjs            # synthetic mouse: movement deltas, screen coords, gap shape
```

`node tests/run.cjs --update` rewrites `tests/golden.json` after an intentional
threshold change; review the diff before committing it.

## Downloading the game assets

The client's own files (UI atlas, icons, data tables) are useful for the detectors and
for the mixer data. The browser asks "keep this download?" for every file, so fetch them
with a script instead.

1. Open the game tab, run the "step 1" line at the top of `tools/collect-urls.js`, then
   reload the page so the resource buffer records everything.
2. Play the screens you care about (a building panel, the mixer), paste the rest of
   `tools/collect-urls.js` and save the printed JSON as `urls.json`.
3. Download everything:

```
node tools/fetch-assets.cjs --urls urls.json --out game-assets
```

Re-running is safe: it skips what is already there and keeps walking references from the
JSON/atlas files it downloads. `--seed <url>` downloads a single index instead of a list.

## Layout

```
social-reborn-toolkit/    the extension (manifest v3)
  content/hud.js          shared HUD, overlays, capture and input serialization
  content/{meat,wood,resources}.js
  background.js           debugger attach, CDP input, screenshot capture
  popup.{html,js}
tests/                    detector and loop harnesses
```
