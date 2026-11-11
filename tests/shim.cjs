const fs = require('fs'), vm = require('vm'), path = require('path');
const DIR = path.join(__dirname, '..', 'social-reborn-toolkit', 'content');
let CUR = null;
function ctx2d() {
  const o = {
    img: null,
    drawImage(m) { o.img = m; },
    clearRect() {},
    getImageData: (x, y, w, h) => ({
      data: (o.img && o.img._data) || new Uint8ClampedArray(w * h * 4), width: w, height: h,
    }),
  };
  return o;
}
module.exports = { fs, vm, path, DIR, ctx2d, makeSandbox, load, get CUR() { return CUR; }, set CUR(v) { CUR = v; } };

function makeSandbox() {
  const s = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Promise, Error, Uint8Array, Int32Array, Uint8ClampedArray, Map, Set, Date,
    performance: { now: () => Date.now() },
    innerWidth: 1600, innerHeight: 900,
    Image: class {
      constructor() { this.width = 0; this.height = 0; }
      set src(v) {
        this.width = CUR.w; this.height = CUR.h; this._data = CUR.data;
        setTimeout(() => this.onload && this.onload(), 0);
      }
    },
    document: {
      hidden: false,
      querySelector: (t) => (t === 'canvas'
        ? { width: 1600, height: 900, getBoundingClientRect: () => ({ top: 0, left: 0, width: 1600, height: 900 }) }
        : null),
      createElement: (t) => (t === 'canvas' ? { width: 0, height: 0, getContext: () => ctx2d() } : {}),
      addEventListener() {},
    },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve({}) },
      storage: { local: { get: (k, f) => f({}) }, onChanged: { addListener() {} } },
    },
  };
  s.window = s;
  return s;
}

// Loads a content script, injecting the `exportExpr` binding as window.__T.
function load(file, exportExpr, setup) {
  let src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const i = src.lastIndexOf('})();');
  src = src.slice(0, i) + 'window.__T = ' + exportExpr + ';\n' + src.slice(i);
  const sb = makeSandbox();
  if (setup) setup(sb);
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb.window.__T;
}
