// After a cleanup the extension folder must still be a loadable MV3 package: every file
// the manifest and the popup reference has to exist. A missing content script is a silent
// half-dead extension (the popup shows "no connection"), so this is checked on its own.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'social-reborn-toolkit');

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const referenced = [];
for (const cs of manifest.content_scripts) for (const f of cs.js) referenced.push(f);
referenced.push(manifest.background.service_worker, manifest.action.default_popup);
for (const f of Object.values(manifest.action.default_icon)) referenced.push(f);

const missing = referenced.filter((f) => !fs.existsSync(path.join(ROOT, f)));
assert(missing.length === 0, `every file the manifest points at exists (${missing.join(', ') || 'all ' + referenced.length + ' present'})`);

const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
assert(scripts.length > 0, 'the popup loads its script');
assert(scripts.every((s) => fs.existsSync(path.join(ROOT, s))), `every popup script exists (${scripts.join(', ')})`);

assert(/^\d+\.\d+\.\d+$/.test(manifest.version), `the version is a Chrome-accepted semver (${manifest.version})`);
assert(manifest.permissions.includes('debugger'), 'the debugger permission survived the cleanup');
assert(fs.existsSync(path.join(ROOT, 'content', 'hud.js')), 'the HUD content script is present');
assert(fs.existsSync(path.join(ROOT, 'icons', 'icon128.png')), 'the shipped icons are present');

// Nothing from the old scratch layout may come back: a copy of the extension inside the
// repository is how two different builds get loaded by accident.
assert(!fs.existsSync(path.join(__dirname, '..', 'social-reborn-toolkit - copia')), 'no duplicate copy of the extension');
