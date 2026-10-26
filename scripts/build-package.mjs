#!/usr/bin/env node
/**
 * Build the distributable artifact (issue #52).
 *
 * Produces exactly two things, and nothing else is shipped:
 *
 *   bin/pi-central.js   one bundled ESM file: orchestrator + protocol + `ws`
 *   dist/ui/            the built UI, as `vite build` wrote it
 *
 * ## Why the orchestrator is BUNDLED rather than compiled file-by-file
 *
 * The published package cannot ship TypeScript. Node refuses to strip types for files under
 * `node_modules` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — and npm installs globals there,
 * so a `.ts` entry point is unrunnable no matter how the package is installed. Reproduced with a
 * minimal package before this design was chosen.
 *
 * The alternative, `tsc` with emit, is far more invasive than it looks: the sources use explicit
 * `.ts` import specifiers (required by `allowImportingTsExtensions`, which itself requires
 * `noEmit`), so every one of those 39 specifiers would have to be rewritten, or a second resolution
 * scheme introduced for the published build only. Bundling needs none of that: it follows the `.ts`
 * specifiers as written and emits one file.
 *
 * `ws` is the one exception: it is **external**, not bundled, because it is CommonJS and an ESM
 * bundle cannot `require()` it without a shim that throws at load time. The published package
 * therefore has exactly one runtime dependency, declared in `package.json`.
 *
 * ## What it does NOT do
 *
 * It does not touch the workspace. `packages/ui/dist` is where `vite build` writes and is copied
 * from, not written to; the bundle goes to `bin/`, which is generated. Both are in `.gitignore`.
 */
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const UI_SOURCE = join(root, "packages", "ui", "dist");
const UI_DEST = join(root, "dist", "ui");
const BIN_DIR = join(root, "bin");
const BIN = join(BIN_DIR, "pi-central.js");

function fail(message) {
  console.error(`build-package: ${message}`);
  process.exit(1);
}

// --- 1. The UI, via Vite -------------------------------------------------------------------------
//
// Run through `npm run` rather than by importing Vite, so the build is the SAME command a developer
// runs. A second, subtly different UI build path is how "it works in dev and not in the package"
// starts.
console.log("build-package: building the UI (vite)");
const { spawnSync } = await import("node:child_process");
const vite = spawnSync("npm", ["run", "ui:build", "--silent"], {
  cwd: root,
  stdio: "inherit",
  // `npm` is a shell script on some platforms, so it needs a shell to be found at all.
  shell: process.platform === "win32",
});
if (vite.status !== 0) fail(`the UI build failed with exit code ${String(vite.status)}`);
if (!existsSync(join(UI_SOURCE, "index.html"))) {
  // Named rather than assumed: a Vite config change that moved `outDir` would otherwise be reported
  // by the packaged app as "no built UI", which points at the wrong thing entirely.
  fail(`the UI build produced no index.html at ${UI_SOURCE}; check packages/ui/vite.config.ts`);
}

// --- 2. Copy the UI into the package layout ------------------------------------------------------
//
// `dist/ui`, NOT `packages/ui/dist`: the package must be self-contained, and `resolveUiDistDir`
// looks for it relative to the PACKAGE ROOT (found by name), so a copied tree is what makes the
// installed artifact work from any directory.
console.log("build-package: copying the UI into dist/ui");
rmSync(UI_DEST, { recursive: true, force: true });
mkdirSync(dirname(UI_DEST), { recursive: true });
cpSync(UI_SOURCE, UI_DEST, { recursive: true });

// --- 3. Bundle the orchestrator ------------------------------------------------------------------
console.log("build-package: bundling the orchestrator");
rmSync(BIN_DIR, { recursive: true, force: true });
mkdirSync(BIN_DIR, { recursive: true });

await build({
  entryPoints: [join(root, "packages", "orchestrator", "src", "server.ts")],
  outfile: BIN,
  bundle: true,
  platform: "node",
  // Node 22 is the declared floor (`engines`), and it is what type stripping was unflagged in. The
  // bundle is plain JS, but targeting the floor keeps the emitted syntax runnable there.
  target: "node22",
  format: "esm",
  // `ws` is CommonJS and calls `require()` internally. Bundled into an ESM output, esbuild emits a
  // `__require` shim that THROWS ("Dynamic require of \"events\" is not supported") the first time the
  // module is loaded — which, because the module graph is loaded eagerly, made even `--version`
  // fail. Found by installing the tarball and running it; the workspace build looked fine.
  //
  // The alternatives were both worse: a `createRequire` banner keeps the dependency count at zero
  // but bundles CommonJS into the component that runs unsandboxed, and converting the whole output
  // to CommonJS would give up `import.meta.url` — which `resolveUiDistDir` and `findOwnPackage`
  // both depend on. So `ws` stays a real, declared dependency and resolves from `node_modules`.
  external: ["ws"],
  // The shebang is injected rather than kept in the source: a `#!` line in a `.ts` file is legal for
  // Node but not for every tool that reads the file, and TypeScript has its own opinion about it.
  banner: { js: "#!/usr/bin/env node" },
  // Self-contained map: the original `.ts` files are NOT shipped, so a map without `sourcesContent`
  // would resolve to nothing. A stack trace from a supervised session is worth more than the bytes.
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  logLevel: "warning",
});

// `chmod +x` is what makes `npx pi-central` work on a POSIX host. It is not implied by the shebang,
// and npm only sets the bit from the `bin` field when installing — which will not help anyone
// running the file straight out of the tarball.
chmodSync(BIN, 0o755);

// --- 4. Say what was produced, with numbers ------------------------------------------------------
//
// Printed every time rather than only during a release: a size that jumps by a factor is a signal,
// and a signal nobody prints is a signal nobody sees. `docs/BUNDLE.md` records the UI's chunk
// budget; this is where the published artifact's own numbers come from.
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/** Recursive byte total. Written out rather than pulled in, to keep this script dependency-free. */
function directoryBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
  }
  return total;
}

const binSize = statSync(BIN).size;
const uiBytes = directoryBytes(UI_DEST);

console.log("");
console.log(`  bin/pi-central.js   ${kib(binSize)}  (includes an inline sourcemap)`);
console.log(`  dist/ui             ${kib(uiBytes)}`);
console.log(`  version             ${pkg.name} ${pkg.version}`);
console.log(`  runtime deps        ${Object.keys(pkg.dependencies ?? {}).join(", ") || "none"}`);
console.log("");
console.log("build-package: done. Inspect with `npm pack --dry-run`.");
