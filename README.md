# extension_re

Chrome extension plus a Node test harness for resource collection in **Social Reborn**
(`empires.socialreborn.com`).

> Personal-use tooling for a single game. Automating gameplay may violate that game's
> Terms of Service; use it on your own account and at your own risk.

Ramas y flujo de trabajo: [INSTRUCCIONES.md](INSTRUCCIONES.md). `main` lleva los
recolectores de carne y madera; `pruebas` agrega el de recursos, todavía en prueba.

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

Permissions: `storage`, `activeTab` and `debugger`, plus host access to the game origin.
`activeTab` is not optional — `chrome.tabs.captureVisibleTab` refuses to run with host
permissions alone, and every detector is built on that capture. It is granted when you
invoke the extension on the tab (toolbar icon or a keyboard shortcut), so if calibration
reports a missing capture permission, click the toolbar icon once and retry.

Nothing below is a promise of invisibility: `isTrusted` is `false` in synthetic mode and a
page can read it. What the input layer does do is stop being *trivially* distinguishable —
cursor paths are eased curves, every move carries real `movementX`/`movementY` deltas,
screen coordinates include the window and browser-chrome offset, and every wait is drawn
from a right-skewed distribution instead of a rectangle with hard edges.

## Tests

Node only, no dependencies. Run everything from the repository root:

```
npm test                            # every test file (tests/all.cjs)
node tests/run.cjs                  # golden-file detector regression (meat, wood, res)
node tests/meat_loop.cjs            # click burst, drag mode, stop mid-burst
node tests/meat_policy.cjs          # 100% collection in the three modes
node tests/meat_rounds.cjs          # 25 min + 5 min break + 30 min schedule
node tests/control.cjs              # one chain at a time: stop/start/resume
node tests/res_loop.cjs             # resource collector end to end
node tests/res_pair.cjs             # two buildings per gather-time dialog
node tests/res_round.cjs            # 16 assignments per round, then a 6-7 min pause
node tests/res_dialog.cjs           # the dialog is not fabricated from the UI panels
node tests/res_dialog_close.cjs     # Escape first, the X only if the dialog survives
node tests/res_capture_rate.cjs     # the dialog poll stays under Chrome's 2 captures/s
node tests/wood_loop.cjs            # empty map and capture errors never stop the run
node tests/wood_villager.cjs        # a villager that never cuts stops the module
node tests/wood_nearest.cjs         # the trunk nearest to the villager is the one cut
node tests/hud_ui.cjs               # HUD row buttons and calibration reporting
node tests/hud_input.cjs            # synthetic mouse: deltas, screen coords, gap shape
node tests/hud_capture.cjs          # a timed-out capture cannot un-hide the HUD mid-frame
node tests/background_drag.cjs      # a failed CDP drag still releases the mouse button
node tests/config_persist.cjs       # popup choices survive a reload
node tests/fetch_assets.cjs         # tools/fetch-assets.cjs against a fake page
node tests/find_recipes.cjs         # tools/find-recipes.js against a fake page
node tests/dump_data.cjs            # tools/dump-data.js against a fake page
node tests/package.cjs              # the extension folder is a loadable package
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

## Dumping the client data

	ools/dump-data.js is a console snippet that lists every text asset the client already
loaded with its size and top-level keys, so you can tell which file holds the building
times, troop stats or mixer recipes before downloading anything. It only reads.

## Finding the mixer recipes

`tools/find-recipes.js` is a console snippet, not an extension feature: paste it in the
game tab and it scans the text assets the client already loaded, reporting the ones that
look like a recipe table (with their top-level keys). It clicks nothing and sends no game
action, so the server sees the same requests a page reload produces.

Run `performance.setResourceTimingBufferSize(50000)` and reload first, then open the Soul
Mixer once so its data file is in the list.

## Layout

```
social-reborn-toolkit/    the extension (manifest v3)
  content/hud.js          shared HUD, overlays, capture and input serialization
  content/{meat,wood,resources}.js
  background.js           debugger attach, CDP input, screenshot capture
  popup.{html,js}
tests/                    detector and loop harnesses
tools/                    asset downloader and the console recipe finder
```

Load `social-reborn-toolkit/` directly with **Load unpacked**; there is nothing to build.
