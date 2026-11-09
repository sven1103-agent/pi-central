/**
 * Resolving `ws` in the packaged app, which is a CommonJS bundle (issue #218).
 *
 * ## The defect, found in the app's own log
 *
 * ```
 * 2026-11-09 16:03:29.276 ERROR Pi Central: the orchestrator did not describe its sessions within 2000 ms
 * ```
 *
 * The app was healthy: the orchestrator was up, the window was loaded, the socket was there. What failed was **the
 * client**. `socketClient` resolved `ws` with:
 *
 *     createRequire(import.meta.url)("ws")
 *
 * which is correct in an ES module and **silently broken in the bundle**, because the packaged app is CommonJS: esbuild
 * emits `var import_meta = {}` for `import.meta`, so `import.meta.url` is `undefined` and
 * `createRequire(undefined)` throws *"The argument 'filename' must be a file URL object…"*.
 *
 * The throw was caught by the fallback, so nothing crashed. What was lost was the socket — so **every `⌘Q` waited its
 * full 2000 ms and then reported a timeout**, `decideStop` was handed an empty list, and the quit dialog never appeared.
 * That is why "⌘Q leaves the window open" survived the fix for the looping exit handler: there was a second, independent
 * fault in front of it, and the first one hid the second.
 *
 * ## What this file asserts
 *
 * The resolution must work in the shape the app actually ships — a CommonJS bundle with `ws` beside it — and must not
 * depend on `import.meta`. Both are checked against a **built** bundle, because that is the only place the difference
 * between ESM and CJS is visible; running the TypeScript directly (`npm run app`) worked all along.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MAIN = join(ROOT, "packages", "app", "src", "main.ts");

/**
 * Build the shell exactly as `install-app` does, and return the bundle's text.
 *
 * The same esbuild call: CommonJS, `electron` external, everything else bundled. A test that built it as ESM would pass
 * while the shipped artifact failed — which is precisely the bug.
 */
async function buildBundle(t: { after: (fn: () => void) => void }): Promise<{ path: string; text: string }> {
  // esbuild is CommonJS; a named import fails under ESM, which is how this test first broke.
  const { build } = (await import("esbuild")).default ?? (await import("esbuild"));
  const directory = mkdtempSync(join(tmpdir(), "pi-central-bundle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outfile = join(directory, "main.js");
  await build({
    entryPoints: [MAIN],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  return { path: outfile, text: readFileSync(outfile, "utf8") };
}

test("the bundled shell never reads `import.meta.url`, which is undefined in the CommonJS bundle", async (t) => {
  /*
   * The defect in one assertion. `import_meta.url` is what esbuild emits for it in CJS, and `import_meta` is `{}` — so
   * anything reading `.url` from it gets `undefined` at runtime, with no error until something throws on it.
   */
  const { text } = await buildBundle(t);
  assert.equal(
    /import_meta(\.url|\["url"\])/.test(text),
    false,
    "the bundle reads import.meta.url, which esbuild sets to an empty object in CommonJS",
  );
});

test("the bundle anchors `createRequire` on a real path", async (t) => {
  // `createRequire` needs a filename, file URL or absolute path. `process.argv[1]` is the entry script in both a dev run
  // and a bundle; `import.meta.url` is not available in the second.
  const { text } = await buildBundle(t);
  assert.equal(text.includes("createRequire"), true, "the resolution still uses createRequire as one route");
  /*
   * The anchor is `anchor` in the bundle (a loop variable bound to `process.argv[1]` and a sibling of it), so the
   * assertion is that it is NOT a module URL — the positive half is the `import.meta` test above. Matching the minified
   * spelling of the loop would be asserting on esbuild's output rather than on the code.
   */
  assert.equal(/createRequire\)\(import_meta/.test(text), false, "and it is not anchored on a module URL");
});

test("a CommonJS bundle with `ws` beside it resolves `ws`", async (t) => {
  /*
   * The shape the packaged app has: `app.asar` holds `main.js` and `node_modules/ws` as siblings, so a CommonJS
   * `require("ws")` from the bundle finds it. Reproduced here with a real temporary tree, because the packaged asar
   * cannot be mounted in a test.
   */
  const directory = mkdtempSync(join(tmpdir(), "pi-central-ws-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // A stand-in `ws` whose export is recognisable, in the layout the asar uses.
  const wsDirectory = join(directory, "node_modules", "ws");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(wsDirectory, { recursive: true });
  writeFileSync(join(wsDirectory, "package.json"), JSON.stringify({ name: "ws", version: "0.0.0", main: "index.js" }));
  writeFileSync(join(wsDirectory, "index.js"), "module.exports = { WebSocket: function FakeSocket() {} };\n");

  // The resolution, copied from `resolveWs`'s first two routes — the module's own function is not exported (it is a
  // private helper in `main.ts`), so the *behaviour* is asserted rather than the call.
  const probe = join(directory, "probe.cjs");
  writeFileSync(
    probe,
    [
      'const { createRequire } = require("node:module");',
      "const accept = (loaded) => {",
      '  const c = typeof loaded === "function" ? loaded : loaded?.WebSocket ?? loaded?.default;',
      '  return typeof c === "function" ? c : undefined;',
      "};",
      "let found;",
      'try { found = accept(require("ws")); } catch {}',
      "if (found === undefined) {",
      "  const entry = process.argv[1];",
      "  try { found = accept(createRequire(entry)(\"ws\")); } catch {}",
      "}",
      'console.log(typeof found);',
    ].join("\n"),
  );
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim();
  assert.equal(output, "function", "a CommonJS require of `ws` beside the bundle resolves the constructor");
});

test("the resolution has three independent routes, so one failing does not silence the dialog", () => {
  /*
   * The point of the fallback chain. The bug was not that one route failed — it is that the ONE route failed and the
   * failure was swallowed, so the app looked healthy while `⌘Q` could not name a single session.
   *
   * Asserted as the presence of the three attempts, in the order they are tried.
   */
  const source = readFileSync(MAIN, "utf8");
  const resolver = source.slice(source.indexOf("function resolveWs"), source.indexOf("function socketClient"));
  /*
   * Route 1 is the MODULE-SCOPE `require`, not `globalThis.require`. The difference is not stylistic and it cost a
   * release: in a real `.cjs` FILE `typeof globalThis.require === "undefined"` while `typeof require === "function"`,
   * because `require` is a module-scope binding. Measured both ways, against the packaged asar:
   *
   *     module-scope require  -> function
   *     globalThis.require    -> undefined      <- the bug
   */
  assert.match(resolver, /typeof require === "function" \? \(?require/, "route 1: the module-scope require");
  assert.equal(resolver.includes("globalThis as { require?"), false, "and NOT globalThis.require, which is undefined in a .cjs file");
  assert.match(resolver, /createRequire\(entry\)/, "route 2: createRequire from a real path");
  assert.match(resolver, /createRequire\(join\(process\.cwd\(\)/, "route 3: the working directory as a last resort");
});

test("a resolution failure is LOGGED, because its consequence is silent", () => {
  /*
   * Found by reading the log, so the log must be able to say this. Without the line, the visible symptom is
   * "the orchestrator did not describe its sessions within 2000 ms" — which blames the orchestrator for a client-side
   * failure, and sent the diagnosis in the wrong direction for a whole session.
   */
  const source = readFileSync(MAIN, "utf8");
  assert.match(source, /could not resolve `ws`/);
  assert.match(source, /quit dialog will not be able to name sessions/, "and it names the consequence");
});

test("the resolver works in a real `.cjs` FILE, where `globalThis.require` does not exist", async (t) => {
  /*
   * The test that would have caught the second failed fix, and the reason the first version of this file did not.
   *
   * `globalThis.require` is `undefined` in a `.cjs` FILE and **defined** under `node -e`, because `-e` evaluates in the
   * main module's scope. So a probe written with `new Function` inside a `-e` snippet — which is what was used to
   * validate the second attempt — reports success for a route that cannot work in the shipped bundle. Measured both ways:
   *
   *     node -e  'typeof globalThis.require'  -> function
   *     node check.cjs                        -> undefined
   *
   * This test writes a `.cjs` file and runs it, so the harness matches the artifact.
   */
  const directory = mkdtempSync(join(tmpdir(), "pi-central-cjs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { mkdirSync, cpSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");

  // The shape the packaged app has: `ws` beside the entry file.
  mkdirSync(join(directory, "node_modules"), { recursive: true });
  cpSync(join(ROOT, "node_modules", "ws"), join(directory, "node_modules", "ws"), { recursive: true });

  const { text } = await buildBundle(t);
  const start = text.indexOf("function resolveWs");
  const end = text.indexOf("function socketClient");
  assert.ok(start !== -1 && end > start, "the resolver is in the bundle");

  // Both routes, side by side, run from a file.
  const probe = join(directory, "probe.cjs");
  writeFileSync(
    probe,
    [
      'const { join } = require("node:path");',
      'const { createRequire } = require("node:module");',
      "const accept = (loaded) => {",
      '  const c = typeof loaded === "function" ? loaded : loaded?.WebSocket ?? loaded?.default;',
      '  return typeof c === "function" ? c : undefined;',
      "};",
      "const moduleScope = () => {",
      '  const r = typeof require === "function" ? require : undefined;',
      '  try { return accept(r("ws")); } catch { return undefined; }',
      "};",
      "const globalScope = () => {",
      "  const r = globalThis.require;",
      '  try { return accept(r("ws")); } catch { return undefined; }',
      "};",
      // The bundle's own resolver, evaluated in this file's scope so `typeof require` is the real one.
      text.slice(start, end),
      'console.log(JSON.stringify({',
      "  globalThisRequire: typeof globalThis.require,",
      "  moduleScope: typeof moduleScope(),",
      "  globalScope: typeof globalScope(),",
      "  bundle: typeof resolveWs(),",
      "}));",
    ].join("\n"),
  );

  const result = JSON.parse(execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim()) as Record<string, string>;
  // The premise: in a FILE, `globalThis.require` does not exist. Without this the rest proves nothing.
  assert.equal(result["globalThisRequire"], "undefined", "a .cjs file has no globalThis.require");
  assert.equal(result["moduleScope"], "function", "the module-scope require works");
  assert.equal(result["globalScope"], "undefined", "and the globalThis route cannot");
  assert.equal(result["bundle"], "function", "so the bundle's own resolver must use the module-scope one");
});
