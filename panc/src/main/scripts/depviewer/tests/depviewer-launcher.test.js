const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { gzipSync } = require('node:zlib');

const scripts = process.env.DEPVIEWER_ASSET_DIRECTORY || path.resolve(__dirname, '..');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp('/tmp/opencode/depviewer-launcher-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'relocated scripts');
  await fs.mkdir(assets);
  for (const name of ['depviewer', 'depviewer.py']) {
    await fs.copyFile(path.join(scripts, name), path.join(assets, name));
  }
  if (!options.missingPage) {
    await fs.copyFile(path.join(scripts, 'depviewer.html'), path.join(assets, 'depviewer.html'));
  }
  const trace = path.join(directory, options.name || 'spaced ü #.depx.json.gz');
  const json = Buffer.from('{"hello":"world"}');
  const bytes = trace.endsWith('.gz') ? gzipSync(json) : json;
  if (!options.missingTrace) await fs.writeFile(trace, bytes);
  const capture = path.join(directory, 'browser-url');
  await fs.writeFile(path.join(directory, 'xdg-open'), '#!/bin/sh\nprintf "%s" "$1" > "$CAPTURE"\nexit ' + (options.openerFailure ? '7' : '0') + '\n', { mode: 0o755 });
  const child = spawn('bash', [path.join(assets, 'depviewer'), ...(options.args || [options.absoluteTrace ? trace : path.basename(trace)])], {
    cwd: directory,
    env: { ...process.env, PATH: directory + ':' + process.env.PATH, CAPTURE: capture },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
    await exited;
  });
  return { directory, trace, bytes, capture, child, exited, logs: () => logs };
}

async function browserUrl(f) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await fs.readFile(f.capture, 'utf8');
      if (value) return new URL(value);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (f.child.exitCode !== null) throw new Error(f.logs());
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Browser was not launched: ' + f.logs());
}

function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('relocated launcher serves only protected page and original gzip bytes', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const url = await browserUrl(f);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.hash, '#filename=' + encodeURIComponent(path.basename(f.trace)));
  assert.match(url.pathname, /^\/[A-Za-z0-9_-]{32,}\/depviewer\.html$/);
  const page = await request(url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.bytes.toString('utf8'), /void loadAutomaticTrace\(\{/);
  assert.match(page.bytes.toString('utf8'), /fetchTrace:\s*\(relativePath\)\s*=>\s*fetch\(relativePath\)/);
  const traceUrl = new URL('trace', url);
  const trace = await request(traceUrl, { Origin: url.origin, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(trace.status, 200);
  assert.equal(trace.headers['content-type'], 'application/octet-stream');
  assert.equal(trace.headers['content-encoding'], undefined);
  assert.deepEqual(trace.bytes, f.bytes);
  for (const route of ['/', '/wrong/trace', url.pathname.replace('depviewer.html', ''), url.pathname.replace('depviewer.html', 'depviewer.py'), '/%2e%2e/trace']) {
    assert.equal((await request(new URL(route, url))).status, 404);
  }
  for (const headers of [{ Host: 'evil.example' }, { Host: 'localhost:' + url.port }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(traceUrl, headers)).status, 403);
  }
  assert.equal((await request(traceUrl, {}, 'POST')).status, 405);
  const token = url.pathname.split('/')[1];
  f.child.kill('SIGINT');
  assert.equal((await f.exited)[0], 0);
  assert.doesNotMatch(f.logs(), new RegExp(token));
  assert.match(f.logs(), /shutdown/i);
  await assert.rejects(request(url));
});

test('uncompressed JSON is served byte-for-byte with an absolute trace path', { timeout: 10000 }, async t => {
  const f = await fixture(t, { name: 'trace.depx.json', absoluteTrace: true });
  const url = await browserUrl(f);
  assert.deepEqual((await request(new URL('trace', url))).bytes, f.bytes);
});

for (const [name, options, message] of [
  ['missing argument', { args: [] }, /usage:/i],
  ['extra argument', { args: ['one', 'two'] }, /usage:/i],
  ['missing trace', { missingTrace: true }, /trace/i],
  ['invalid suffix', { name: 'trace.json' }, /depx\.json/],
  ['missing page', { missingPage: true }, /viewer/i],
]) {
  test('launcher rejects ' + name, async t => {
    const f = await fixture(t, options);
    assert.notEqual((await f.exited)[0], 0);
    assert.match(f.logs(), message);
    await assert.rejects(fs.readFile(f.capture), { code: 'ENOENT' });
  });
}

test('browser-launch failure closes the listening socket', { timeout: 10000 }, async t => {
  const f = await fixture(t, { openerFailure: true, name: 'trace.depx.json' });
  const url = await browserUrl(f);
  assert.notEqual((await f.exited)[0], 0);
  assert.match(f.logs(), /xdg-open/);
  assert.doesNotMatch(f.logs(), new RegExp(url.pathname.split('/')[1]));
  await assert.rejects(request(url));
});
