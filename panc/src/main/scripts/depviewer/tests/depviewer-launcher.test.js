const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

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
  if (options.prepare) await options.prepare(directory, trace);
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
  assert.equal(url.hash, '');
  assert.match(url.pathname, /^\/[A-Za-z0-9_-]{32,}\/depviewer\.html$/);
  const page = await request(url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  const catalog = await request(new URL('catalog', url));
  assert.equal(catalog.status, 200);
  assert.match(catalog.headers['content-type'], /application\/json/);
  assert.equal(catalog.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(catalog.bytes), { traces: [{ id: '0', name: path.basename(f.trace) }] });
  const traceUrl = new URL('trace/0', url);
  const trace = await request(traceUrl, { Origin: url.origin, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(trace.status, 200);
  assert.equal(trace.headers['content-type'], 'application/octet-stream');
  assert.equal(trace.headers['content-encoding'], undefined);
  assert.deepEqual(trace.bytes, f.bytes);
  for (const route of ['/', '/wrong/trace', url.pathname.replace('depviewer.html', ''), url.pathname.replace('depviewer.html', 'depviewer.py'), '/%2e%2e/trace', ...['trace', 'trace/1', 'trace/00', 'trace/-1', 'trace/0?path=other', 'trace/%30', 'trace/' + encodeURIComponent(f.trace)].map(route => new URL(route, url).pathname + new URL(route, url).search)]) {
    assert.equal((await request(new URL(route, url))).status, 404);
  }
  for (const headers of [{ Host: 'evil.example' }, { Host: 'localhost:' + url.port }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(traceUrl, headers)).status, 403);
    assert.equal((await request(new URL('catalog', url), headers)).status, 403);
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
  assert.deepEqual((await request(new URL('trace/0', url))).bytes, f.bytes);
});

for (const [name, options, message] of [
  ['missing argument', { args: [] }, /usage:/i],
  ['invalid explicit input among valid inputs', { args: ['trace.depx.json', 'missing'], name: 'trace.depx.json' }, /input/i],
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

test('recursive mixed inputs are sorted, deduplicated and distinguish colliding names without following directory symlinks', { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    name: 'root.depx.json',
    args: ['tree', 'root.depx.json', 'tree/a/same.depx.json', 'alias.depx.json'],
    prepare: async directory => {
      await fs.mkdir(path.join(directory, 'tree/a'), { recursive: true });
      await fs.mkdir(path.join(directory, 'tree/b'), { recursive: true });
      await fs.mkdir(path.join(directory, 'outside'));
      await fs.writeFile(path.join(directory, 'tree/a/same.depx.json'), 'a');
      await fs.writeFile(path.join(directory, 'tree/b/same.depx.json'), 'b');
      await fs.writeFile(path.join(directory, 'tree/ignored.json'), 'ignored');
      await fs.writeFile(path.join(directory, 'outside/hidden.depx.json'), 'hidden');
      await fs.symlink('../outside', path.join(directory, 'tree/link'));
      await fs.symlink('..', path.join(directory, 'tree/a/cycle'));
      await fs.symlink('tree/a/same.depx.json', path.join(directory, 'alias.depx.json'));
      await fs.symlink('missing', path.join(directory, 'tree/broken.depx.json'));
    },
  });
  const url = await browserUrl(f);
  const catalog = JSON.parse((await request(new URL('catalog', url))).bytes);
  assert.deepEqual(catalog, { traces: [
    { id: '0', name: 'root.depx.json' },
    { id: '1', name: 'tree/a/same.depx.json' },
    { id: '2', name: 'tree/b/same.depx.json' },
  ] });
  assert.equal((await request(new URL('trace/1', url))).bytes.toString(), 'a');
  assert.equal((await request(new URL('trace/2', url))).bytes.toString(), 'b');
  assert.match(f.logs(), /omit/i);
});

test('empty recursive inventory fails before browser launch', async t => {
  const f = await fixture(t, { args: ['empty'], prepare: directory => fs.mkdir(path.join(directory, 'empty')) });
  assert.notEqual((await f.exited)[0], 0);
  assert.match(f.logs(), /no.*trace/i);
  await assert.rejects(fs.readFile(f.capture), { code: 'ENOENT' });
});

test('explicit directory symlink fails rather than traversing its target', async t => {
  const f = await fixture(t, { args: ['linked'], prepare: async directory => {
    await fs.mkdir(path.join(directory, 'target'));
    await fs.symlink('target', path.join(directory, 'linked'));
  } });
  assert.notEqual((await f.exited)[0], 0);
  assert.match(f.logs(), /directory symlinks are not followed/i);
});

test('hostile display names remain JSON metadata and never route paths', { timeout: 10000 }, async t => {
  const f = await fixture(t, { name: '<img onerror="alert(1)"> #?.depx.json' });
  const url = await browserUrl(f);
  assert.deepEqual(JSON.parse((await request(new URL('catalog', url))).bytes), {
    traces: [{ id: '0', name: path.basename(f.trace) }],
  });
  assert.deepEqual((await request(new URL('trace/0', url))).bytes, f.bytes);
});

test('thousands of invalid trace contents require only filename metadata at startup', { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    args: ['many'],
    prepare: async directory => {
      await fs.mkdir(path.join(directory, 'many'));
      await Promise.all(Array.from({ length: 2000 }, (_, index) => fs.writeFile(path.join(directory, 'many', `${String(index).padStart(4, '0')}.depx.json.gz`), 'not gzip')));
    },
  });
  const url = await browserUrl(f);
  const traces = JSON.parse((await request(new URL('catalog', url))).bytes).traces;
  assert.equal(traces.length, 2000);
  assert.deepEqual(traces[1999], { id: '1999', name: '1999.depx.json.gz' });
});

test('browser-launch failure closes the listening socket', { timeout: 10000 }, async t => {
  const f = await fixture(t, { openerFailure: true, name: 'trace.depx.json' });
  const url = await browserUrl(f);
  assert.notEqual((await f.exited)[0], 0);
  assert.match(f.logs(), /xdg-open/);
  assert.doesNotMatch(f.logs(), new RegExp(url.pathname.split('/')[1]));
  await assert.rejects(request(url));
});

test('real Chromium autoloads one trace and bounds a multiple-trace selector', {
  skip: !process.env.DEPVIEWER_BROWSER,
  timeout: 30000,
}, async t => {
  const traceBytes = profile => JSON.stringify({
    format: 'depx', version: 1, roots: [], dependencies: [],
    profiles: [{ name: profile, sites: [], occurrences: [] }],
  });
  async function dump(f) {
    const url = await browserUrl(f);
    const { stdout } = await promisify(execFile)(process.env.DEPVIEWER_BROWSER, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(f.directory, 'chromium-profile'),
      '--dump-dom', '--virtual-time-budget=5000', url.href,
    ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }

  const single = await fixture(t, { name: 'single.depx.json', prepare: (directory, trace) => fs.writeFile(trace, traceBytes('browser-smoke-profile')) });
  const singleDom = await dump(single);
  assert.match(singleDom, /<option[^>]*>browser-smoke-profile<\/option>/);
  assert.doesNotMatch(singleDom, /id="status"[^>]*>[^<]*(?:Could not|Invalid)/);

  const multiple = await fixture(t, { args: ['many'], prepare: async directory => {
    await fs.mkdir(path.join(directory, 'many'));
    await Promise.all(Array.from({ length: 150 }, (_, index) => fs.writeFile(
      path.join(directory, 'many', `${String(index).padStart(3, '0')}.depx.json`), traceBytes('not-autoloaded'),
    )));
  } });
  const multipleDom = await dump(multiple);
  const selector = multipleDom.match(/<select id="trace-select"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selector, 'trace selector must be rendered');
  assert.equal((selector[1].match(/<option\b/g) || []).length, 100);
  assert.match(selector[1], /000\.depx\.json/);
  assert.match(selector[1], /099\.depx\.json/);
  assert.doesNotMatch(multipleDom, /<option[^>]*>not-autoloaded<\/option>/);
});
