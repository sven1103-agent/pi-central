#!/usr/bin/env node
/**
 * `npm run install-app` — build, sign and install the desktop shell locally (issue #218).
 *
 * ## What this produces, and what it refuses to produce
 *
 * `~/Applications/Pi Central.app`, ad-hoc or self-signed, signed innermost-first, runnable on Apple Silicon with no
 * Apple Developer account. ADR-0013 decided the shape and this script only executes it:
 *
 *   - **no `.dmg`**, no notarization, no publishing — checked by `configProblems` before the build, so adding one is a
 *     build-time failure rather than a release pipeline that cannot complete (criterion 3);
 *   - **no product code in the bundle** — checked after the build, because a build script can copy files the manifest
 *     never mentions (criterion 5);
 *   - **no admin rights**, and uninstalling is `rm -rf ~/Applications/Pi Central.app` (criterion 7);
 *   - **a stable code identity** when a self-signed certificate exists, because that is what keeps TCC grants across
 *     rebuilds — and an explicit caveat when it does not (criterion 4).
 *
 * ## The three things measured while building this, each of which is a failure mode avoided
 *
 *   1. **`electron-builder` refuses a version range.** `"electron": "^45.2.3"` in the manifest produces
 *      *"Electron version ^45.2.3 is a range, not a fixed version"* and no build. So the resolved version is read from
 *      the installed package and passed explicitly.
 *   2. **Without `electronDist` it downloads Electron** into `~/Library/Caches/electron` — a network dependency for a
 *      local build of a launcher. The already-installed `node_modules/electron/dist` is used instead, which also means
 *      the app runs the exact Electron this checkout was tested with.
 *   3. **Signing order matters.** Electron ships five helper apps and five frameworks; signing a container before its
 *      contents invalidates the container. `signingOrder` lists them innermost-first, and `codesign --deep` is used only
 *      to *verify*, never to sign (Apple deprecated it for signing for this reason).
 *
 * ## Exit codes
 *
 * Non-zero on any failure, with the reason on stderr — including the post-build audits. A script that continued past a
 * failed signature would produce an app that does not start, which is the failure criterion 1 names.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConfig,
  bundleProblems,
  chooseSigning,
  configProblems,
  gatekeeperAdviceProblems,
  identityProblems,
  installPath,
  requiresAdmin,
  setDirectoryLister,
  signArguments,
  signingOrder,
} from "./app-build/rules.mjs";

// The signing order discovers the helper apps from `Contents/Frameworks`, because a packaged Electron renames them after
// the product (`Pi Central Helper.app`) rather than keeping Electron's names.
setDirectoryLister((path) => readdirSync(path));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ROOT = join(ROOT, "packages", "app");
const ELECTRON_DIST = join(ROOT, "node_modules", "electron", "dist");

/** One line of progress. Deliberately terse: this runs under `npm run`, which already echoes the command. */
const step = (text) => console.log(`install-app: ${text}`);
/** A failure that ends the run. Never thrown from a place that would leave a half-installed app. */
const fail = (text) => {
  console.error(`install-app: ${text}`);
  process.exit(1);
};

/**
 * Refuse to run on anything but macOS arm64.
 *
 * C10 makes the orchestrator macOS-only (Safehouse has no Linux backend), and this slice's ADR scopes x64 out. A build
 * on another platform would either produce a bundle that cannot run or silently produce the wrong architecture.
 */
if (process.platform !== "darwin") fail(`this builds a macOS app, and this is ${process.platform} (C10)`);
if (process.arch !== "arm64") fail(`only Apple Silicon is supported, and this is ${process.arch}`);

// ---------------------------------------------------------------------------------------------------------------
// 1. What we are building.
// ---------------------------------------------------------------------------------------------------------------

const appManifestPath = join(APP_ROOT, "package.json");
if (!existsSync(appManifestPath)) fail(`${appManifestPath} is missing`);
const appManifest = JSON.parse(readFileSync(appManifestPath, "utf8"));

const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const electronManifestPath = join(ROOT, "node_modules", "electron", "package.json");
if (!existsSync(electronManifestPath)) {
  fail("electron is not installed (npm install), so there is nothing to package the shell around");
}
// The INSTALLED version, not the manifest's range: electron-builder refuses a range, and this is the Electron the
// checkout was tested against.
const electronVersion = JSON.parse(readFileSync(electronManifestPath, "utf8")).version;

if (!existsSync(join(ELECTRON_DIST, "Electron.app"))) {
  fail(`Electron's app bundle is not unpacked at ${ELECTRON_DIST}; run npm install`);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. The entry point, built from the shell's own sources.
// ---------------------------------------------------------------------------------------------------------------

/*
 * The bundle needs a single CommonJS `main.js`: Electron loads `package.json`'s `main`, and the shell's sources are
 * TypeScript using `.ts` import specifiers (`allowImportingTsExtensions`), which Node strips but Electron does not.
 * So `main.ts` is bundled once — the same way `window-security.test.ts` assembles it for its audit — with `electron`
 * left external because the runtime provides it.
 */
const buildDir = join(APP_ROOT, "dist-app");
step(`bundling the shell into ${buildDir}`);
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
{
  const esbuild = await import("esbuild");
  try {
    await esbuild.build({
      entryPoints: [join(APP_ROOT, "src", "main.ts")],
      outfile: join(buildDir, "main.js"),
      bundle: true,
      platform: "node",
      target: "node22",
      // CommonJS, because Electron's entry loader treats a `.js` file in a directory with no `"type": "module"` as
      // CommonJS and a bundle with top-level `await` would otherwise be rejected.
      format: "cjs",
      // `electron` is provided by the runtime. Everything else is bundled, so the app carries no `node_modules`.
      external: ["electron"],
      logLevel: "warning",
    });
  } catch (error) {
    fail(`could not bundle the shell: ${error.message}`);
  }
}

/*
 * A package.json for the packaged app: the entry, the identity, and the version (criterion 6 — the app carries the
 * package's version, so "which version is the app?" has one answer). `main` is what electron-builder checks for.
 */
const bundledManifest = {
  name: appManifest.name,
  productName: "Pi Central",
  version: rootManifest.version,
  description: appManifest.description,
  main: "main.js",
  // No `dependencies`: everything the shell needs is bundled, and a dependency list would make electron-builder try to
  // install into the app (and could carry product code, which criterion 5 forbids).
};
writeFileSync(join(buildDir, "package.json"), `${JSON.stringify(bundledManifest, null, 2)}\n`, "utf8");

// ---------------------------------------------------------------------------------------------------------------
// 3. The configuration, audited before anything is built.
// ---------------------------------------------------------------------------------------------------------------

const config = buildConfig({
  electronVersion,
  electronDist: ELECTRON_DIST,
  output: join(APP_ROOT, "dist-app-out"),
});
const problems = configProblems(config);
if (problems.length > 0) {
  fail(`refusing to build with this configuration:\n  ${problems.join("\n  ")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Build.
// ---------------------------------------------------------------------------------------------------------------

const builder = join(ROOT, "node_modules", ".bin", "electron-builder");
if (!existsSync(builder)) {
  fail(
    "electron-builder is not installed. It is a devDependency of this project; run npm install, then try again.",
  );
}

/*
 * The config is written to a file rather than passed with `-c <json>`.
 *
 * Measured: with `--mac --dir --arm64` present, `-c '{"…"}'` is interpreted as a FILE PATH — the error names a file whose
 * name is the JSON — so electron-builder is given a path to a real file and nothing has to be guessed by the CLI's
 * argument parser.
 */
const configPath = join(buildDir, "electron-builder.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

step(`packaging with electron-builder (Electron ${electronVersion})`);
const buildResult = spawnSync(
  builder,
  ["--mac", "--dir", "--arm64", "-c", configPath],
  // The project directory is the one holding the bundled manifest, so `files` resolves against the bundle and the app
  // cannot accidentally include the shell's sources or the unpacked Electron.
  { cwd: buildDir, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } },
);
if (buildResult.status !== 0) {
  fail(`electron-builder failed (exit ${buildResult.status ?? "signal"}); nothing was installed`);
}

/*
 * `directories.output` is absolute in the config, so the app lands at `<output>/mac-arm64/Pi Central.app` — NOT nested
 * under the project directory, which is what the first version looked for. The path is computed from the same value the
 * config carries, so the two cannot drift.
 */
const outputDir = config.directories.output;
const builtApp = join(outputDir, "mac-arm64", "Pi Central.app");
if (!existsSync(builtApp)) fail(`electron-builder reported success but produced no app at ${builtApp}`);

// ---------------------------------------------------------------------------------------------------------------
// 5. Audit the built tree, before signing it.
// ---------------------------------------------------------------------------------------------------------------

/*
 * Criterion 5, checked on the ARTIFACT rather than on the manifest: a build script can copy files the manifest never
 * mentions, and the bundle becoming a second distributable is the failure this exists to prevent.
 */
const resourcesDir = join(builtApp, "Contents", "Resources");
const resources = existsSync(resourcesDir) ? walk(resourcesDir) : [];
const productCode = bundleProblems(resources);
if (productCode.length > 0) {
  fail(`refusing to sign this bundle:\n  ${productCode.join("\n  ")}`);
}

const infoPlist = readPlist(join(builtApp, "Contents", "Info.plist"));
const identityIssues = identityProblems(
  { id: infoPlist["CFBundleIdentifier"] ?? "", version: infoPlist["CFBundleShortVersionString"] ?? "" },
  rootManifest.version,
);
if (identityIssues.length > 0) fail(`refusing to install this bundle:\n  ${identityIssues.join("\n  ")}`);

// ---------------------------------------------------------------------------------------------------------------
// 6. Sign, innermost first.
// ---------------------------------------------------------------------------------------------------------------

/*
 * A fresh ad-hoc signature from electron-builder is stripped first, because signing over an existing signature leaves the
 * old one in place for any item whose contents did not change — which is how a bundle ends up with two identities.
 */
step("removing the signature electron-builder applied");
spawnSync("codesign", ["--remove-signature", builtApp], { stdio: "ignore" });

const signing = chooseSigning(process.env["PI_CENTRAL_SIGN_IDENTITY"], availableIdentities());
step(signing.reason);
if (signing.kind === "adhoc") {
  // Said out loud, not buried: a reader whose permissions reset after every rebuild needs the cause, not a surprise.
  console.warn(`\ninstall-app: ${signing.caveat}\n`);
}

const order = signingOrder(builtApp, (path) => existsSync(path));
if (order.length < 2) fail(`found no nested bundles to sign under ${builtApp}; that is not an Electron app`);
step(`signing ${order.length} items, innermost first`);
for (const item of order) {
  const args = signArguments(item, signing);
  const result = spawnSync("codesign", args, { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    fail(`codesign failed for ${item}:\n${result.stderr || result.stdout}`);
  }
}

/*
 * `--deep --strict` for VERIFICATION only. It is deprecated for signing (the order becomes opaque), and it is the right
 * tool for checking that every nested bundle carries a valid signature that chains to the one we chose.
 */
const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", builtApp], {
  stdio: "pipe",
  encoding: "utf8",
});
if (verify.status !== 0) {
  fail(`the signed app does not verify, so it would not start:\n${verify.stderr || verify.stdout}`);
}
step("signature verified (--deep --strict)");

// ---------------------------------------------------------------------------------------------------------------
// 7. Install into ~/Applications.
// ---------------------------------------------------------------------------------------------------------------

const destination = installPath(homedir());
if (requiresAdmin(destination)) {
  fail(`${destination} needs admin rights, and this app must install without them (criterion 7)`);
}
step(`installing into ${destination}`);
spawnSync("mkdir", ["-p", dirname(destination)], { stdio: "ignore" });
// Replaced wholesale: a merge would leave files from the previous version behind, which is how a bundle accumulates an
// identity that no longer matches its signature.
try {
  rmSync(destination, { recursive: true, force: true });
} catch (error) {
  /*
   * Reported as what it is. `EPERM` here is a permission on the destination, not a build failure — and the reader needs
   * to know the app IS built and signed, and that only the copy failed, or they will go looking for a build problem.
   */
  fail(
    `the app was built and signed, but could not be installed: ${error.message}\n` +
      `  The finished bundle is at ${builtApp}\n` +
      `  Move it into place yourself, or check permissions on ${dirname(destination)}.`,
  );
}
try {
  cpSync(builtApp, destination, { recursive: true, verbatimSymlinks: true });
} catch (error) {
  fail(`the app was built and signed, but could not be copied into place: ${error.message}\n  It is at ${builtApp}`);
}

/*
 * The copy is verified too. `cp` preserves the code but not necessarily the extended attributes a signature lives in
 * depending on the filesystem, and an app that does not verify after installation is an app that will not start.
 */
const installed = spawnSync("codesign", ["--verify", "--deep", "--strict", destination], { stdio: "pipe", encoding: "utf8" });
if (installed.status !== 0) {
  fail(`the installed app does not verify:\n${installed.stderr || installed.stdout}`);
}

// ---------------------------------------------------------------------------------------------------------------
// 8. What the reader should know.
// ---------------------------------------------------------------------------------------------------------------

step(`installed ${destination}`);
console.log("");
console.log(`  version:  ${rootManifest.version}  (Electron ${electronVersion}, arm64)`);
console.log(`  identity: ${signing.kind === "identity" ? signing.identity : "ad-hoc"}`);
console.log(`  run it:   open "${destination}"`);
console.log("");
console.log("  Gatekeeper will refuse this app if it is moved to another machine, because it is not notarized.");
console.log("  That is expected: notarization needs a Developer ID this project does not have. On THIS machine it");
console.log("  runs, because a bundle produced locally is not quarantined.");
console.log("");
console.log(`  uninstall: rm -rf "${destination}"`);
console.log("             (plus ~/Library/Application Support/Pi Central if you want its runtime record gone)");
console.log("");

// ---------------------------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------------------------

/** Every path under `root`, relative to it, so the audit can look for names rather than load a tree. */
function walk(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    out.push(relative);
    if (entry.isDirectory()) out.push(...walk(join(root, entry.name), relative));
  }
  return out;
}

/** `Info.plist` as an object. `plutil -convert json` because parsing XML by hand is a bug waiting to happen. */
function readPlist(path) {
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
  if (result.status !== 0) fail(`could not read ${path}:\n${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {};
  }
}

/** The code-signing identities this machine has, as names. Empty when there are none — which is the common case. */
function availableIdentities() {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => /"([^"]+)"/.exec(line)?.[1])
    .filter((name) => name !== undefined);
}

// This is a script; `rules.mjs` holds everything worth asserting.
