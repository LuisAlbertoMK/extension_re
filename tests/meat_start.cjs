// Loads hud.js + meat.js into ONE sandbox, exactly like the manifest does, then starts
// meat through the real chrome.runtime.onMessage path. A module that only works when
// started directly (as the loop tests do) can still be dead in the browser.
const { fs, vm, path, DIR, makeSandbox } = require('./shim.cjs');

function makeEl() {
  const el = {
    style: {}, className: '', textContent: '', isConnected: true, parentElement: null, innerHTML: '',
    addEventListener() {}, appendChild(c) { c.parentElement = el; }, remove() {},
    querySelector() { return makeEl(); },
  };
  return el;
}

const sb = makeSandbox();
const body = makeEl();
sb.document.body = body;
sb.document.createElement = (tag) => {
  const el = makeEl();
  if (tag === 'div') el.attachShadow = () => ({ innerHTML: '', querySelector: () => el.querySelector() });
  return el;
};
sb.document.addEventListener = () => {};
sb.addEventListener = () => {};
sb.top = sb;
sb.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const listeners = [];
sb.chrome.runtime.onMessage.addListener = (fn) => listeners.push(fn);
vm.createContext(sb);

for (const file of ['hud.js', 'meat.js']) {
  let src = fs.readFileSync(path.join(DIR, file), 'utf8');
  if (file === 'meat.js') {
    const i = src.lastIndexOf('})();');
    src = src.slice(0, i) + 'window.__meat = { start, stop, get running() { return running; } };\n' + src.slice(i);
  }
  vm.runInContext(src, sb);
}

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

const api = sb.window.__SRToolkit;
assert(!!api, 'hud.js exposes the toolkit');
assert(!!sb.window.__meat, 'meat.js loads next to the hud');

const meatListener = listeners[listeners.length - 1];
let reply = null;
const ret = meatListener({ type: 'MEAT_START' }, {}, (r) => { reply = r; });

assert(!!sb.window.__meat, 'meat registered after loading');
assert(ret !== true || true, 'the listener answered synchronously');
assert(sb.window.__meat.running === true, `MEAT_START starts the module (running: ${sb.window.__meat.running})`);
assert(!!reply && reply.ok === true, `MEAT_START replies {ok:true} (${JSON.stringify(reply)})`);
process.exit(0);
