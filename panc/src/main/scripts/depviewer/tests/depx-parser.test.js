"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

const htmlPath = path.join(__dirname, "..", "depviewer.html");
const html = fs.readFileSync(htmlPath, "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInThisContext(script, { filename: htmlPath });
const { parseDepx, resolvePath, readFile, buildVisibleModel, matchAt, moveRowSelection, dependencyPage, statusLabel, searchableText, validateTraceCatalog, filterTraces, initializeTraceCatalog, wireTraceLauncherControls, loadRemoteTrace, loadLocalTrace } = globalThis.DepxViewerParser;

const location = { begin_line: 4, begin_column: 0, end_line: 4, end_column: 12 };

test("streamed response without Content-Length exceeding 128 MiB cancels and releases the reader", async () => {
  let reads = 0;
  let cancelled = false;
  let released = false;
  const chunk = new Uint8Array(1024 * 1024);
  const response = {
    ok: true,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => { reads++; return { done: false, value: chunk }; },
      cancel: async () => { cancelled = true; },
      releaseLock: () => { released = true; },
    }) },
  };

  await assert.rejects(globalThis.DepxViewerParser.readResponseFile(response, "oversized.depx.json", class {
    constructor() { assert.fail("oversized response must not create a file"); }
  }), /128 MiB/);
  assert.equal(reads, 129);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});
const fixture = () => ({
  format: "depx",
  version: 1,
  roots: ["/work/100% ?# café"],
  profiles: [{
    name: "default",
    sites: [
      { caller: null, target: { name: "root", source: { name: "root", type: "Template", location: { root: 0, path: "" } } }, location: null },
      { caller: { name: "root", source: { name: "root", type: "Template", location: { root: 0, path: "caller%?# 雪" } } }, target: { name: "child", source: { name: "child", type: "Template", location: { uri: "file:///external/child%25" } } }, location: { ...location } },
      { caller: null, target: { name: "skipped", source: { name: "skipped", type: "Template", location: null } }, location: null },
      { caller: null, target: { name: "declaration", source: null }, location: null },
      { caller: null, target: { name: "created", source: { name: "created", type: "File", location: { root: 0, path: "created" } } }, location: null }
    ],
    occurrences: [
      { site: 0, parent: null, status: "executed" },
      { site: 1, parent: 0, status: "executed" },
      { site: 1, parent: 0, status: "executed" },
      { site: 2, parent: 2, status: "skipped_unique" },
      { site: 3, parent: 2, status: "skipped_declaration" },
      { site: 4, parent: null, status: "create" }
    ]
  }],
  dependencies: [
    { name: "dep", type: "File", location: { root: 0, path: "dep%?# Ω" } },
    { name: "missing", type: "File", location: null },
    { name: "outside", type: "File", location: { uri: "file:///outside/a%20b" } }
  ]
});

test("normalizes structured sources and preserves statuses, null metadata, and dependencies", () => {
  const normalized = parseDepx(JSON.stringify(fixture()));
  const profile = normalized.profiles.get("default");
  assert.deepEqual([...profile.sites.keys()], [0, 1, 2, 3, 4]);
  assert.deepEqual(profile.occurrences.map(({ status, parent, kind }) => [status, parent, kind]), [
    ["executed", null, "include"], ["executed", 0, "include"], ["executed", 0, "include"],
    ["skipped_unique", 2, "include"], ["skipped_declaration", 2, "include"], ["create", null, "create"]
  ]);
  assert.equal(profile.sites.get(0).caller, null);
  assert.equal(profile.sites.get(0).location, null);
  assert.equal(profile.sites.get(1).location, "4:0-4:12");
  assert.match(profile.sites.get(1).callerPath, /caller%25%3F%23%20%E9%9B%AA/);
  assert.equal(profile.sites.get(1).targetPath, "child Template file:///external/child%25");
  assert.deepEqual(normalized.dependencies, [
    "dep File file:///work/100%25%20%3F%23%20caf%C3%A9/dep%25%3F%23%20%CE%A9",
    "missing (File)", "outside File file:///outside/a%20b"
  ]);
});

test("requires JSON format, version, schema types, references, unique profiles, and valid sources", () => {
  const cases = [
    ["format", (value) => { value.format = "other"; }, /format/],
    ["version", (value) => { value.version = 2; }, /version/],
    ["roots", (value) => { value.roots = "/tmp"; }, /arrays/],
    ["absolute root", (value) => { value.roots[0] = "relative"; }, /absolute/],
    ["profiles", (value) => { value.profiles[0].sites[0].target.source.location.root = 2; }, /missing root/],
    ["unknown site", (value) => { value.profiles[0].occurrences[0].site = 8; }, /unknown site/],
    ["invalid status", (value) => { value.profiles[0].occurrences[0].status = "ignored"; }, /status/],
    ["bad location", (value) => { value.profiles[0].sites[1].location.begin_line = 0; }, /coordinate/],
    ["bad source", (value) => { value.profiles[0].sites[1].target.source.location = { root: 0, path: "../escape" }; }, /traversal/],
    ["ambiguous source location", (value) => { value.dependencies[0].location = { root: 0, path: "ok", uri: "file:///also" }; }, /either root and path or URI/],
    ["bad URI", (value) => { value.dependencies[0].location = { uri: "https://example.test/a" }; }, /file URI/],
    ["malformed file URI", (value) => { value.dependencies[0].location = { uri: "file:///bad%2" }; }, /file URI/],
    ["relative file URI", (value) => { value.dependencies[0].location = { uri: "file:relative" }; }, /file URI/],
    ["duplicate profile", (value) => { value.profiles.push(structuredClone(value.profiles[0])); }, /Duplicate profile/],
    ["missing required source", (value) => { delete value.profiles[0].sites[1].target.source.type; }, /type/]
  ];
  for (const [label, change, error] of cases) {
    const value = fixture();
    if (label === "bad URI") value.profiles[0].sites[1].location = null;
    change(value);
    assert.throws(() => parseDepx(JSON.stringify(value)), error, label);
  }
  assert.throws(() => parseDepx("{bad json"), /Invalid depx JSON/);
});

test("requires occurrence parents to be earlier active ancestors and forbids skipped children", () => {
  const futureParent = fixture(); futureParent.profiles[0].occurrences[1].parent = 3;
  assert.throws(() => parseDepx(JSON.stringify(futureParent)), /earlier occurrence/);
  const nonAncestor = fixture(); nonAncestor.profiles[0].occurrences[3].parent = 1;
  assert.throws(() => parseDepx(JSON.stringify(nonAncestor)), /active ancestor/);
  for (const status of ["skipped_unique", "skipped_declaration"]) {
    const skippedParent = fixture();
    skippedParent.profiles[0].occurrences[2].status = status;
    skippedParent.profiles[0].occurrences[3].parent = 2;
    assert.throws(() => parseDepx(JSON.stringify(skippedParent)), /skipped/);
  }
  const createdParent = fixture();
  createdParent.profiles[0].occurrences.push({ site: 1, parent: 5, status: "executed" });
  assert.equal(parseDepx(JSON.stringify(createdParent)).profiles.get("default").occurrences[6].parent, 5);
});

test("keeps path text literal and never URI-decodes percent, question, hash, or Unicode", () => {
  const parsed = parseDepx(JSON.stringify(fixture()));
  const pathValue = parsed.dependencies[0];
  assert.ok(pathValue.includes("100%25%20%3F%23%20caf%C3%A9/dep%25%3F%23%20%CE%A9"));
  assert.equal(resolvePath({ name: "x", type: "File", location: { root: 0, path: "a%2Fb" } }, ["/r"]), "x File file:///r/a%252Fb");
  assert.equal(resolvePath({ name: "x", type: "File", location: { root: 0, path: "child" } }, ["/"]), "x File file:///child");
  assert.equal(resolvePath({ name: "x", type: "File", location: { root: 0, path: "child" } }, ["/root/"]), "x File file:///root/child");
  const javaUri = "file:/tmp/caf%C3%A9%25.txt";
  const javaUriFixture = fixture();
  javaUriFixture.dependencies[0].location = { uri: javaUri };
  assert.equal(parseDepx(JSON.stringify(javaUriFixture)).dependencies[0], "dep File file:///tmp/caf%C3%A9%25.txt");
  javaUriFixture.dependencies[0].location = { uri: "file:/" };
  assert.equal(parseDepx(JSON.stringify(javaUriFixture)).dependencies[0], "dep File file:///");
  assert.throws(() => resolvePath("legacy source descriptor", ["/r"]), /structured JSON/);
  for (const traversal of ["..", "../x", "a/../x", "a\\..\\x", "/absolute"]) {
    const value = fixture(); value.dependencies[0].location.path = traversal;
    assert.throws(() => parseDepx(JSON.stringify(value)), /relative path|traversal/);
  }
});

test("allows null caller, target, and source metadata from the approved schema", () => {
  const value = fixture();
  value.profiles[0].sites[0].target = null;
  value.profiles[0].sites[1].caller = null;
  value.profiles[0].sites[1].target.source = null;
  const profile = parseDepx(JSON.stringify(value)).profiles.get("default");
  assert.equal(profile.sites.get(0).target, null);
  assert.equal(profile.sites.get(1).caller, null);
  assert.equal(profile.sites.get(1).targetPath, null);
});

test("keeps hostile names and source strings as plain text data", () => {
  const value = fixture();
  value.profiles[0].name = '<img src=x onerror="alert(1)">';
  value.profiles[0].sites[0].target.name = "<script>alert(1)</script>";
  value.dependencies[0].name = "</li><img src=x>";
  const normalized = parseDepx(JSON.stringify(value));
  assert.equal(normalized.profiles.keys().next().value, value.profiles[0].name);
  assert.equal(normalized.profiles.get(value.profiles[0].name).sites.get(0).target, value.profiles[0].sites[0].target.name);
  assert.equal(normalized.dependencies[0].startsWith("</li><img src=x>"), true);
  assert.match(html, /textContent = text/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
});

test("normalizes very deep flat traces iteratively and keeps rendered pages bounded", () => {
  const value = fixture();
  value.profiles[0].sites = [{ caller: null, target: { name: "deep", source: null }, location: null }];
  value.profiles[0].occurrences = Array.from({ length: 16001 }, (_, index) => ({ site: 0, parent: index ? index - 1 : null, status: "executed" }));
  const occurrences = parseDepx(JSON.stringify(value)).profiles.get("default").occurrences;
  assert.equal(occurrences.at(-1).depth, 16000);
  assert.equal(occurrences[0].children.length, 1);
  const model = buildVisibleModel(occurrences, new Set(), new Set(), false, 0, 500);
  assert.equal(model.visible.length, 1);
  const allExpanded = buildVisibleModel(occurrences, new Set(), new Set(occurrences.map(({ index }) => index)), false, 0, 500);
  assert.equal(allExpanded.visible.length, 500);
  assert.equal(allExpanded.allVisible.length, 16001);
});

test("retains search, pagination, and keyboard navigation helpers", () => {
  assert.equal(matchAt([2, 5, 8], 5, 1), 2);
  assert.deepEqual(moveRowSelection([{ index: 1 }, { index: 2 }], 1, 0, 1, "ArrowDown"), { index: 2, page: 1 });
  assert.deepEqual(dependencyPage([1, 2, 3], 1, 2), { items: [3], page: 1, pageCount: 2, start: 2 });
  assert.equal(statusLabel("skipped_unique"), "skipped unique");
  assert.equal(statusLabel("skipped_declaration"), "skipped declaration");
  assert.equal(statusLabel("create"), "create");
  assert.ok(searchableText({ site: { caller: null, target: "leaf", callerPath: null, targetPath: null }, location: null, status: "skipped_unique" }).includes("skipped unique"));
});

test("offers JSON and gzip JSON only in the file picker and help copy", () => {
  assert.match(html, /accept="\.json,\.gz,application\/json,application\/gzip"/);
  assert.match(html, /Choose a \.depx\.json or \.depx\.json\.gz file/);
  assert.doesNotMatch(html, /depx 1|depx 2|\.depx or \.depx\.gz/);
  assert.match(html, /occurrence\.status\.startsWith\("skipped"\)/);
  assert.match(html, /\$\{occurrence\.kind\} · \$\{statusLabel\(occurrence\.status\)\}/);
});

test("decompresses gzip JSON locally, enforces size limits, and reports invalid gzip", async () => {
  const json = JSON.stringify(fixture());
  const gzip = zlib.gzipSync(Buffer.from(json));
  const file = (name, bytes, reportedSize = bytes.length) => ({ name, size: reportedSize, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  assert.equal(await readFile(file("trace.depx.json.gz", gzip)), json);
  await assert.rejects(readFile(file("huge.json", Buffer.from("{}"), 128 * 1024 * 1024 + 1)), /128 MiB/);
  await assert.rejects(readFile(file("invalid.json.gz", Buffer.from([0x1f, 0x8b, 0, 0]))), /decompress/);
});

test("validates catalog IDs and filters names with case-sensitive path globs", () => {
  const traces = validateTraceCatalog({ traces: [
    { id: "0", name: "builds/One.depx.json.gz" },
    { id: "1", name: "builds/Two.depx.json" },
    { id: "2", name: "other/one.depx.json" }
  ] });
  assert.equal(filterTraces(traces, "").length, 3);
  assert.deepEqual(filterTraces(traces, "builds/*.depx.json.?z"), [traces[0]]);
  assert.deepEqual(filterTraces(traces, "builds/One*").map(({ id }) => id), ["0"]);
  assert.deepEqual(filterTraces(traces, "builds/one*").length, 0);
  assert.deepEqual(filterTraces(traces, "builds/One.depx.json.gz").map(({ id }) => id), ["0"]);
  assert.deepEqual(filterTraces(traces, "*/*.depx.json").map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(filterTraces([{ id: "0", name: "folder\ntrace" }], "folder?trace").length, 1);
  for (const invalid of [null, {}, { traces: [{ id: "1", name: "x" }] }, { traces: [{ id: "0", name: "" }] }]) {
    assert.throws(() => validateTraceCatalog(invalid), /catalog|trace/i);
  }
  const hostileName = '<img src=x onerror="alert(1)">.depx.json';
  assert.equal(validateTraceCatalog({ traces: [{ id: "0", name: hostileName }] })[0].name, hostileName);
  assert.match(html, /option\.textContent|new Option\(/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
});

test("filters large catalogs in memory while rendering can remain bounded", () => {
  const traces = Array.from({ length: 5000 }, (_, index) => ({ id: String(index), name: `production/${index}.depx.json.gz` }));
  assert.equal(filterTraces(traces, "production/49??.depx.json.gz").length, 100);
  assert.match(html, /TRACE_PAGE_SIZE\s*=\s*100/);
  assert.match(html, /slice\(.*TRACE_PAGE_SIZE/s);
  assert.match(html, /option\.textContent = trace\.name/);
});

test("autoloads one HTTP catalog trace but leaves multi-trace catalogs idle", async () => {
  const json = JSON.stringify(fixture());
  const cases = [
    { traces: [{ id: "0", name: "trace café.depx.json" }] },
    { traces: [{ id: "0", name: "trace café.depx.json" }, { id: "1", name: "trace space.depx.json.gz" }] }
  ];
  for (const [index, catalog] of cases.entries()) {
    let requestedPath;
    let loaded = 0;
    const handled = await initializeTraceCatalog({
      protocol: "http:",
      fetchCatalog: async () => ({ ok: true, json: async () => catalog }),
      loadTrace: async (trace) => {
        loaded++;
        const bytes = index === 0 ? Buffer.from(json) : zlib.gzipSync(Buffer.from(json));
        const file = await loadRemoteTrace({
          trace,
          fetchTrace: async (relativePath) => {
            requestedPath = relativePath;
            return { ok: true, headers: { get: () => String(bytes.length) }, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
          },
          FileConstructor: class TestFile {
            constructor(parts, name) { this.name = name; this.bytes = Buffer.concat(parts.map((part) => Buffer.from(part))); this.size = this.bytes.length; }
            async arrayBuffer() { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength); }
          },
          isCurrent: () => true,
          loadFile: async (file) => assert.equal(parseDepx(await readFile(file)).profiles.size, 1),
          reportError: (error) => assert.fail(error)
        });
        assert.equal(file, true);
      },
      onCatalog: () => {},
      onError: (error) => assert.fail(error)
    });
    assert.equal(handled, true);
    assert.equal(loaded, index === 0 ? 1 : 0);
    assert.equal(requestedPath, index === 0 ? "trace/0" : undefined);
  }
  let fetches = 0;
  assert.equal(await initializeTraceCatalog({ protocol: "file:", fetchCatalog: async () => { fetches++; }, loadTrace: () => {}, onCatalog: () => {}, onError: () => {} }), false);
  assert.equal(fetches, 0, "standalone file pages do not fetch a catalog");
});

test("catalog and selected-trace errors are reported and oversized responses are rejected", async () => {
  const errors = [];
  await initializeTraceCatalog({
    protocol: "http:", fetchCatalog: async () => { throw new Error("offline"); },
    loadTrace: async () => {}, onCatalog: () => {}, onError: (message) => errors.push(message)
  });
  assert.match(errors[0], /offline/);
  await loadRemoteTrace({
    trace: { id: "0", name: "trace.depx.json" }, FileConstructor: class TestFile {}, isCurrent: () => true,
    fetchTrace: async () => ({ ok: true, headers: { get: () => String(128 * 1024 * 1024 + 1) }, body: { getReader: () => assert.fail("oversize body must not be read") } }),
    loadFile: async () => assert.fail("oversize trace must not reach the parser"), reportError: (message) => errors.push(message)
  });
  assert.match(errors[1], /128 MiB/);
  await initializeTraceCatalog({ protocol: "http:", fetchCatalog: async () => ({ ok: true, json: async () => ({ traces: [{ id: "9", name: "bad" }] }) }), loadTrace: async () => {}, onCatalog: () => {}, onError: (message) => errors.push(message) });
  assert.match(errors[2], /catalog/i);
});

test("stale remote responses cannot start parsing after a newer or manual choice", async () => {
  const pending = [];
  const loaded = [];
  let generation = 0;
  const select = (id) => {
    const requestGeneration = ++generation;
    return loadRemoteTrace({
      trace: { id, name: `${id}.depx.json` }, isCurrent: () => generation === requestGeneration,
      fetchTrace: () => new Promise((resolve) => pending.push({ id, resolve })),
      FileConstructor: class TestFile { constructor(parts, name) { this.name = name; this.parts = parts; } },
      loadFile: async (file, isCurrent) => { if (isCurrent()) loaded.push(file.name); }, reportError: (error) => assert.fail(error)
    });
  };
  const first = select("0");
  const second = select("1");
  const response = (name) => ({ ok: true, headers: { get: () => null }, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(name)); controller.close(); } }) });
  pending[1].resolve(response("new"));
  await second;
  pending[0].resolve(response("old"));
  await first;
  assert.deepEqual(loaded, ["1.depx.json"]);
  const third = select("2");
  generation++; // A manual file selection invalidates a pending remote response.
  pending[2].resolve(response("remote"));
  await third;
  assert.deepEqual(loaded, ["1.depx.json"]);
});

test("manual local loading invalidates remote work and failed replacement retains the installed model", async () => {
  let generation = 0;
  let installed = { name: "existing trace" };
  const remoteResults = [];
  const pending = [];
  const remoteGeneration = ++generation;
  const remoteLoad = loadRemoteTrace({
    trace: { id: "0", name: "remote.depx.json" }, isCurrent: () => generation === remoteGeneration,
    fetchTrace: () => new Promise((resolve) => pending.push(resolve)),
    FileConstructor: class TestFile {},
    loadFile: async () => remoteResults.push("installed"), reportError: (error) => assert.fail(error)
  });

  const localGeneration = ++generation;
  const localResult = await loadLocalTrace({
    file: { name: "manual.depx.json" }, isCurrent: () => generation === localGeneration,
    read: async () => "valid", parse: (text) => ({ text }),
    install: (document, name) => { installed = { document, name }; }, reportError: (error) => assert.fail(error)
  });
  assert.equal(localResult, true);
  assert.equal(installed.name, "manual.depx.json");

  pending[0]({ ok: true, headers: { get: () => null }, body: new ReadableStream({ start(controller) { controller.close(); } }) });
  await remoteLoad;
  assert.deepEqual(remoteResults, []);

  const priorModel = installed;
  const failureMessages = [];
  const failedResult = await loadLocalTrace({
    file: { name: "bad.depx.json" }, isCurrent: () => true,
    read: async () => "invalid", parse: () => { throw new Error("invalid depx document"); },
    install: (document, name) => { installed = { document, name }; }, reportError: (message) => failureMessages.push(message)
  });
  assert.equal(failedResult, false);
  assert.equal(installed, priorModel, "a failed replacement does not release or clear the displayed trace");
  assert.deepEqual(failureMessages, ["invalid depx document"]);
});

test("launcher controls invoke selection once without passing click events as traces", () => {
  class FakeButton {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    click() { this.listeners.get("click")({ type: "click" }); }
  }
  const openButton = new FakeButton();
  const fileInput = { clickCount: 0, click() { this.clickCount++; } };
  const traceLoadButton = new FakeButton();
  const traceSelect = new FakeButton();
  let manualOpens = 0;
  let traceSelections = 0;
  let receivedArguments = -1;
  wireTraceLauncherControls({
    openButton, fileInput, traceLoadButton, traceSelect,
    selectRemoteTrace(...args) { traceSelections++; receivedArguments = args.length; },
    onManualOpen() { manualOpens++; }
  });

  openButton.click();
  openButton.click();
  assert.equal(manualOpens, 2, "each manual open click invalidates pending catalog or trace loads exactly once");
  assert.equal(fileInput.clickCount, 2, "manual open dispatches exactly one file-picker click each time");
  traceLoadButton.click();
  assert.equal(traceSelections, 1);
  assert.equal(receivedArguments, 0, "the DOM click event is not mistaken for a selected trace");
  traceSelect.listeners.get("change")({ type: "change" });
  assert.equal(manualOpens, 3, "changing the selected filename invalidates in-flight loads");
});

test("a one-file catalog arriving after manual selection does not autoload over it", async () => {
  let resolveCatalog;
  let manualSelectionGeneration = 0;
  let automaticLoads = 0;
  const catalogLoad = initializeTraceCatalog({
    protocol: "http:",
    fetchCatalog: () => new Promise((resolve) => { resolveCatalog = resolve; }),
    loadTrace: async () => { automaticLoads++; },
    onCatalog: () => {},
    onError: (error) => assert.fail(error),
    shouldAutoload: () => manualSelectionGeneration === 0
  });
  manualSelectionGeneration++;
  resolveCatalog({ ok: true, json: async () => ({ traces: [{ id: "0", name: "relative/path.depx.json" }] }) });
  await catalogLoad;
  assert.equal(automaticLoads, 0, "catalog initialization respects a newer manual open/selection");
});

test("consumes compiler-generated depx JSON and matching gzip output", async (t) => {
  const integrationPath = process.env.DEPX_INTEGRATION_FILE;
  if (!integrationPath) return t.skip("set DEPX_INTEGRATION_FILE to compiler-generated trace_context.depx.json");
  const jsonBytes = fs.readFileSync(integrationPath);
  const compressedPath = `${integrationPath}.gz`;
  const gzipBytes = fs.readFileSync(compressedPath);
  const jsonText = jsonBytes.toString("utf8");
  const gzipText = await readFile({ name: path.basename(compressedPath), size: gzipBytes.length, arrayBuffer: async () => gzipBytes.buffer.slice(gzipBytes.byteOffset, gzipBytes.byteOffset + gzipBytes.byteLength) });
  assert.equal(gzipText, jsonText, "gzip output decompresses to the exact plain JSON bytes");
  const plain = parseDepx(jsonText);
  const compressed = parseDepx(gzipText);
  assert.equal(plain.roots.length, 1);
  assert.equal(plain.profiles.size, 2);
  assert.equal(Array.from(plain.profiles.values()).reduce((count, profile) => count + profile.sites.size, 0), 5);
  assert.equal(Array.from(plain.profiles.values()).reduce((count, profile) => count + profile.occurrences.length, 0), 7);
  assert.equal(Array.from(plain.profiles.values()).flatMap((profile) => profile.occurrences).filter(({ status }) => status === "executed").length, 5);
  assert.equal(Array.from(plain.profiles.values()).flatMap((profile) => profile.occurrences).filter(({ status }) => status === "create").length, 2);
  assert.equal(plain.dependencies.length, 7);
  assert.deepEqual(compressed.roots, plain.roots);
  assert.deepEqual(compressed.dependencies, plain.dependencies);
  for (const [name, profile] of plain.profiles) {
    const gzipProfile = compressed.profiles.get(name);
    assert.ok(gzipProfile, `gzip trace contains profile ${name}`);
    assert.deepEqual(
      gzipProfile.occurrences.map(({ parent, siteIndex, status }) => ({ parent, siteIndex, status })),
      profile.occurrences.map(({ parent, siteIndex, status }) => ({ parent, siteIndex, status }))
    );
    assert.equal(gzipProfile.sites.size, profile.sites.size);
    for (const [siteIndex, site] of profile.sites) {
      const compressedSite = gzipProfile.sites.get(siteIndex);
      assert.deepEqual([compressedSite.caller, compressedSite.target, compressedSite.callerPath, compressedSite.targetPath, compressedSite.location], [site.caller, site.target, site.callerPath, site.targetPath, site.location]);
      for (const sourcePath of [site.callerPath, site.targetPath]) {
        if (sourcePath !== null) {
          assert.match(sourcePath, / file:\/\//, "normalized source path is an absolute file URI");
          assert.doesNotMatch(sourcePath, /\{\s*root\s*:/, "normalized source paths do not expose unresolved root descriptors");
        }
      }
    }
  }
});
