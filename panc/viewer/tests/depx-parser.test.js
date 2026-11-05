"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { CompressionStream } = require("node:stream/web");

const htmlPath = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "offline viewer contains its self-hosted parser script");
const browserWindow = { globalThis: null, TextDecoder, Blob, Response, DecompressionStream, CompressionStream };
browserWindow.globalThis = browserWindow;
vm.runInNewContext(inlineScript, browserWindow, { filename: htmlPath });
const { parseDepx, readFile, resolvePath, buildVisibleModel, matchAt, moveRowSelection, dependencyPage } = browserWindow.DepxViewerParser;

function occurrence(index, parentDepth, status = "executed", action = "include") {
  return `${"  ".repeat(parentDepth + 2)}${action} ${index} site=0 caller="root" target="child" location=template.pan:1 status=${status}`;
}

function v1(contents, profile = "main", version = 1, roots = []) {
  const rootLines = roots.map((root, index) => `root ${index} "${root}"`);
  const pathFields = version === 1
    ? 'caller-path="/repo/root.pan" target-path="/repo/child.pan"'
    : 'caller-path="root file /repo/root.pan" target-path="child file /repo/child.pan"';
  const dependencies = version === 1 ? '  file "/repo/child.pan"' : '  file "child file /repo/child.pan"';
  return [`depx ${version}`, ...rootLines, `profile "${profile}"`, `  site 0 caller="root" target="child" ${pathFields} location=template.pan:1`, "  occurrences", ...contents, "dependencies", dependencies, ""].join("\n");
}

test("parses ordered v1 occurrences and keeps duplicate and suppressed includes distinct", () => {
  const trace = parseDepx(v1([occurrence(0, 0), occurrence(1, 0, "skipped-unique"), occurrence(2, 1, "create", "create")]));
  const profile = trace.profiles.get("main");
  assert.equal(trace.version, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(profile.occurrences.map((item) => [item.index, item.parent, item.status]))), [
    [0, null, "executed"], [1, null, "skipped-unique"], [2, 1, "create"]
  ]);
  assert.equal(trace.dependencies[0], "/repo/child.pan");
});

test("parses escaped and Unicode values while keeping markup as plain data", () => {
  const source = v1([occurrence(0, 0)]).replaceAll('caller="root"', 'caller="<img src=x> \\\"雪\\\""').replaceAll('target="child"', 'target="café"');
  const profile = parseDepx(source).profiles.get("main");
  assert.equal(profile.sites.get(0).caller, '<img src=x> "雪"');
  assert.equal(profile.sites.get(0).target, "café");
});

test("rejects unsupported versions, invalid escapes, and malformed records", () => {
  assert.throws(() => parseDepx("depx 3\n"), /Unsupported depx/);
  assert.throws(() => parseDepx(v1([occurrence(0, 0)]).replace('target="child"', 'target="bad\\q"')), /unsupported escape/);
  assert.throws(() => parseDepx(v1([occurrence(1, 0)])), /consecutive and ordered/);
  assert.throws(() => parseDepx(v1([occurrence(0, 0, "unknown")])), /unknown occurrence status/);
});

test("rejects missing site references and nesting that skips a parent level", () => {
  assert.throws(() => parseDepx(v1([occurrence(0, 0)]).replace("site=0", "site=8")), /unknown site/);
  assert.throws(() => parseDepx(v1([occurrence(0, 2)])), /nesting skips a parent level/);
});

test("parses v2 root tables and resolves compacted SourceFile descriptor locations", () => {
  const roots = ["/srv/templates", "/opt/shared"];
  const compactedFixture = v1([occurrence(0, 0)], "main", 2, roots)
    .replace('caller-path="root file /repo/root.pan" target-path="child file /repo/child.pan"', 'caller-path="root file ASCII file:///repo/root.pan" target-path="child file ASCII //0//child.pan"')
    .replace('file "child file /repo/child.pan"', 'file "child file ASCII //0//child.pan"');
  const parsed = parseDepx(compactedFixture);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.roots)), roots);
  assert.equal(resolvePath(parsed.profiles.get("main").sites.get(0).targetPath, roots, 2), "child file ASCII file:///srv/templates/child.pan");
  assert.equal(resolvePath("child file ASCII //1//network/vlan%20a.pan", roots, 2), "child file ASCII file:///opt/shared/network/vlan%20a.pan");
  assert.equal(resolvePath("child file ASCII file:///absolute/path", roots, 2), "child file ASCII file:///absolute/path");
  assert.equal(resolvePath("child file ASCII //0//", roots, 2), "child file ASCII file:///srv/templates");
  assert.equal(resolvePath("child file ASCII //one%2Ftwo", ["/srv/templates"], 2), "child file ASCII file:///srv/templates/one/two");
  assert.throws(() => resolvePath("child file ASCII //network/vlan.pan", roots), /must include a root index/);
  assert.throws(() => resolvePath("child file ASCII //2//missing.pan", roots), /missing include root/);
  assert.throws(() => parseDepx(v1([occurrence(0, 0)], "main", 2, roots).replace("root 1", "root 2")), /contiguous and ordered/);
  assert.throws(() => parseDepx(compactedFixture.replace('file "child file ASCII //0//child.pan"', 'file "child file ASCII //0//child.pan"\n  file "child file ASCII //0//child.pan"')), /duplicate dependency/);
});

test("rejects v2 root references without a root table and malformed root URI escapes", () => {
  const emptyRoots = parseDepx(v1([occurrence(0, 0)], "main", 2));
  assert.throws(() => resolvePath("child file ASCII //source.pan", emptyRoots.roots), /empty/);
  assert.throws(() => resolvePath("child file ASCII //bad%2", ["/srv/templates"], 2), /URI escaping/);
  assert.throws(() => parseDepx(v1([occurrence(0, 0)], "main", 2, ["relative/path"])), /must be absolute/);
  for (const escaped of ["..", "%2e%2e", ".", "%2e", "%2E%2e", "dir%2F..", "dir%5C..", "dir%5c..", "%2Fetc", "dir%5Csecret"]) {
    assert.throws(() => resolvePath(`child ASCII //${escaped}`, ["/srv/templates"], 2), /escape its include root/, escaped);
  }
  assert.throws(() => resolvePath("child file ASCII //sub/../file%20name.pan", ["/srv/templates"], 2), /escape its include root/);
  assert.throws(() => resolvePath("child file ASCII //../outside.pan", ["/"], 2), /escape its include root/);
});

test("accepts absolute root directory names containing literal question marks and hashes", () => {
  const roots = ["/srv/templates?rev=#stable"];
  const parsed = parseDepx(v1([occurrence(0, 0)], "main", 2, roots));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.roots)), roots);
  assert.equal(resolvePath("child file ASCII //", roots, 2), "child file ASCII file:///srv/templates%3Frev%3D%23stable");
  assert.equal(resolvePath("child file ASCII //folder.pan", roots, 2), "child file ASCII file:///srv/templates%3Frev%3D%23stable/folder.pan");
});

test("preserves raw percent characters in root paths while encoding file URIs", () => {
  assert.equal(resolvePath("child file ASCII //file.pan", ["/srv/100%"], 2), "child file ASCII file:///srv/100%25/file.pan");
  assert.equal(resolvePath("child file ASCII //file.pan", ["/srv/literal%20name"], 2), "child file ASCII file:///srv/literal%2520name/file.pan");
  assert.equal(resolvePath("child file ASCII //file.pan", ["/srv/literal%2Fname"], 2), "child file ASCII file:///srv/literal%252Fname/file.pan");
});

test("offline UI keeps potentially hostile file content on text-only render paths", () => {
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.match(html, /function makeElement[\s\S]*element\.textContent = text/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="open-file"/);
});

test("resolves ASCII file URIs to full local filesystem paths", () => {
  assert.equal(resolvePath("template ASCII file:///srv/templates/base%20file.pan", []), "template ASCII file:///srv/templates/base%20file.pan");
  assert.equal(resolvePath("template ASCII file://server/share/base.pan", []), "template ASCII file://server/share/base.pan");
});

test("retains source type and the empty-location marker for absent sources", () => {
  assert.equal(resolvePath("virtual builtin ", [], 2), "virtual (builtin)");
});

test("traverses very deep occurrence traces without recursive parser calls", () => {
  const count = 16000;
  const rows = Array.from({ length: count }, (_, index) => occurrence(index, index));
  const parsed = parseDepx(v1(rows));
  assert.equal(parsed.profiles.get("main").occurrences.length, count);
  assert.equal(parsed.profiles.get("main").occurrences[count - 1].depth, count - 1);
});

test("searches and navigates all matches in a 16,000-deep occurrence chain with bounded pages", () => {
  const count = 16000;
  const occurrences = Array.from({ length: count }, (_, index) => ({ index, parent: index === 0 ? null : index - 1, children: index === count - 1 ? [] : [index + 1] }));
  const matches = new Set(Array.from({ length: count }, (_, index) => index));
  const firstPage = buildVisibleModel(occurrences, matches, new Set(), true, 0, 500);
  assert.equal(firstPage.visible.length, 500);
  assert.equal(firstPage.allVisible.length, count);
  assert.equal(firstPage.pageCount, 32);
  assert.equal(firstPage.expanded.size, count - 1);
  assert.equal(firstPage.expanded.has(count - 1), false);
  assert.equal(firstPage.expanded.has(0), true);
  const allMatches = Array.from(matches);
  assert.equal(matchAt(allMatches, 499, 1), 500);
  assert.equal(matchAt(allMatches, 15999, 1), 0);
  assert.equal(moveRowSelection(firstPage.allVisible, 499, 0, 500, "ArrowDown").index, 500);
  assert.equal(moveRowSelection(firstPage.allVisible, 499, 0, 500, "ArrowDown").page, 1);
  assert.equal(moveRowSelection(firstPage.allVisible, 500, 1, 500, "ArrowUp").index, 499);
  assert.equal(moveRowSelection(firstPage.allVisible, 0, 0, 500, "End").index, 15999);
  const finalPage = buildVisibleModel(occurrences, matches, firstPage.expanded, true, 31, 500);
  assert.equal(finalPage.visible.at(-1).index, 15999);
  assert.equal(dependencyPage(Array.from({ length: 1001 }, (_, i) => i), 4, 250).items.at(-1), 1000);
  assert.equal(dependencyPage(Array.from({ length: 1001 }, (_, i) => i), 4, 250).page, 4);
});

test("search-filtered tree can collapse and reopen matching branches", () => {
  const occurrences = [
    { index: 0, parent: null, children: [1] },
    { index: 1, parent: 0, children: [2] },
    { index: 2, parent: 1, children: [] }
  ];
  const matches = new Set([2]);
  const expanded = buildVisibleModel(occurrences, matches, new Set(), true, 0, 500);
  assert.deepEqual(Array.from(expanded.visible, (row) => row.index), [0, 1, 2]);
  const collapsed = buildVisibleModel(occurrences, matches, new Set(), true, 0, 500, new Set([1]));
  assert.deepEqual(Array.from(collapsed.visible, (row) => row.index), [0, 1]);
});

test("visible tree model preserves occurrence order when only some results match", () => {
  const occurrences = [
    { index: 0, parent: null, children: [1, 3] },
    { index: 1, parent: 0, children: [2] },
    { index: 2, parent: 1, children: [] },
    { index: 3, parent: 0, children: [] }
  ];
  const model = buildVisibleModel(occurrences, new Set([2]), new Set(), true, 0, 2);
  assert.deepEqual(Array.from(model.visible, (row) => row.index), [0, 1]);
  assert.deepEqual(Array.from(buildVisibleModel(occurrences, new Set([2]), model.expanded, true, 1, 2).visible, (row) => row.index), [2]);
});

test("UI controls expose pagination, keyboard tree navigation, and honest search collapse", () => {
  assert.match(html, /id="tree-previous-page"/);
  assert.match(html, /id="tree-next-page"/);
  assert.match(html, /Files \$\{page\.start \+ 1\}–\$\{Math\.min\(page\.start \+ DEPENDENCY_PAGE_SIZE, dependencyCount\)\} of/);
  assert.match(html, /Next files/);
  assert.match(html, /aria-label="Occurrence tree pages"/);
  assert.match(html, /moveRowSelection\(state\.allVisible, index, state\.treePage, PAGE_SIZE, event\.key\)/);
  assert.match(html, /collapsedSearchBranches\.add\(occurrence\.index\)/);
  assert.match(html, /navigateMatch\(event\.shiftKey \? -1 : 1\)/);
});

test("decompresses gzip locally and reports invalid gzip data", async () => {
  const content = Buffer.from(v1([occurrence(0, 0)]));
  const compressedStream = new Blob([content]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = Buffer.from(await new Response(compressedStream).arrayBuffer());
  const file = { name: "trace.depx.gz", size: compressed.length, arrayBuffer: async () => compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) };
  assert.match(await readFile(file), /^depx 1/);
  const broken = { name: "broken.depx.gz", size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  await assert.rejects(() => readFile(broken), /Could not decompress/);
});

test("consumes compiler-generated v2 trace_context output with gzip parity", {
  skip: !process.env.DEPX_INTEGRATION_FILE && "set DEPX_INTEGRATION_FILE to compiler-generated trace_context.depx"
}, async (context) => {
  const filename = process.env.DEPX_INTEGRATION_FILE;
  const plainText = fs.readFileSync(filename, "utf8");
  const parsed = parseDepx(plainText);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.roots.length, 1);
  assert.ok(path.isAbsolute(parsed.roots[0]));
  assert.equal(parsed.profiles.size, 2);
  assert.equal(parsed.dependencies.length, 7);
  const main = parsed.profiles.get("trace_context");
  const external = parsed.profiles.get("trace_external");
  assert.equal(main.sites.size, 4);
  assert.equal(main.occurrences.length, 6);
  assert.equal(external.sites.size, 1);
  assert.equal(external.occurrences.length, 1);
  assert.deepEqual(Array.from(main.occurrences, (item) => item.status), [
    "executed", "create", "executed", "executed", "create", "executed"
  ]);
  for (const profile of parsed.profiles.values()) {
    for (const site of profile.sites.values()) {
      for (const descriptor of [site.callerPath, site.targetPath]) {
        const resolved = resolvePath(descriptor, parsed.roots, parsed.version);
        assert.match(resolved, / file:\/\/\//);
        assert.doesNotMatch(resolved, / \/\//);
      }
    }
  }
  for (const descriptor of parsed.dependencies) {
    const resolved = resolvePath(descriptor, parsed.roots, parsed.version);
    assert.match(resolved, / file:\/\/\//);
    assert.doesNotMatch(resolved, / \/\//);
  }
  const compressed = fs.readFileSync(`${filename}.gz`);
  const gzipText = await readFile({
    name: path.basename(`${filename}.gz`),
    size: compressed.length,
    arrayBuffer: async () => compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
  });
  assert.equal(gzipText, plainText);
  const gzipParsed = parseDepx(gzipText);
  assert.deepEqual(Array.from(gzipParsed.profiles.keys()), Array.from(parsed.profiles.keys()));
  assert.deepEqual(Array.from(gzipParsed.dependencies), Array.from(parsed.dependencies));
  context.diagnostic("v2: 1 root, 2 profiles, 5 sites, 7 occurrences (5 executed, 2 create), 7 dependencies; gzip parity passed");
});
