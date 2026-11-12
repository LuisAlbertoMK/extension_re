// tools/fetch-assets.cjs: the downloader must walk asset references from a JSON index,
// keep the URL layout on disk, and not refetch what it already has.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = Buffer.from('fake-webp-a');
const B = Buffer.from('fake-png-bb');

const server = http.createServer((req, res) => {
  if (req.url === '/client/ui.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ images: ['img/a.webp', 'img/b.png'], nested: { more: 'img/a.webp' } }));
  } else if (req.url === '/client/img/a.webp') {
    res.writeHead(200, { 'content-type': 'image/webp' }); res.end(A);
  } else if (req.url === '/client/img/b.png') {
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(B);
  } else {
    res.writeHead(404); res.end('nope');
  }
});

function summary(log) {
  return (log.match(/downloaded \d+ file\(s\), [^\n]*/) || [''])[0];
}

function assert(cond, msg) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) process.exitCode = 1;
}

// Async on purpose: the test server lives in this process, so blocking would deadlock.
function run(args) {
  return new Promise((res, rej) => {
    execFile(process.execPath, [path.join(ROOT, 'tools', 'fetch-assets.cjs'), ...args],
      { encoding: 'utf8' },
      (err, stdout) => (err ? rej(err) : res(stdout)));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));

  let log = await run(['--seed', `${base}/client/ui.json`, '--out', out, '--concurrency', '3']);
  assert(/downloaded 3 file/.test(log), `the index and both images are fetched (${summary(log)})`);
  assert(fs.readFileSync(path.join(out, 'client', 'img', 'a.webp')).equals(A), 'the directory layout is kept');
  assert(fs.readFileSync(path.join(out, 'client', 'img', 'b.png')).equals(B), 'referenced images are downloaded');

  log = await run(['--seed', `${base}/client/ui.json`, '--out', out]);
  assert(/downloaded 0 file/.test(log), `a second run does not refetch (${summary(log)})`);
  assert(/skipped 3/.test(log), 'already downloaded files are skipped');

  server.close();
  fs.rmSync(out, { recursive: true, force: true });
})();
