/**
 * What the app build may and may not produce (issue #218, criteria 1, 3, 5, 6, 7, 8).
 *
 * ## Why these are assertions rather than a procedure
 *
 * Six of this slice's criteria are prohibitions or invariants, and a procedure cannot test one: the failure is *a line
 * appearing* in a config, a bundle, or a document. Each would ship silently and usefully-looking — a `.dmg` target makes
 * the build produce a second artifact that cannot be notarized, and the discovery is a release pipeline that cannot
 * complete.
 *
 * The rules live in `scripts/app-build/rules.mjs` so they are plain JS (the build script runs under `node`, not through
 * the TypeScript build) and can be asserted here without building anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_CONFIG_KEYS,
  FORBIDDEN_DEPENDENCIES,
  GATEKEEPER_BYPASS_PATTERNS,
  buildConfig,
  bundleProblems,
  destinationDecision,
  chooseSigning,
  configProblems,
  gatekeeperAdviceProblems,
  helperApps,
  iconProblems,
  identityProblems,
  installPath,
  requiresAdmin,
  setDirectoryLister,
  signArguments,
  signingOrder,
} from "../../../scripts/app-build/rules.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The configuration the build script actually uses, from the module both call. */
function shippedConfig(): Record<string, unknown> {
  return buildConfig({
    electronVersion: "45.2.3",
    electronDist: "/x/electron/dist",
    output: "/x/out",
    iconPath: "/x/app/build/icon.icns",
  });
}

/**
 * A configuration that is valid except for whatever a test is about.
 *
 * Rewritten for issue #239: the icon joined the required set, so every control case needed one or it would have failed
 * for a reason unrelated to what it asserts. Naming it once keeps each test about its own prohibition.
 */
function otherwiseValid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { electronVersion: "45.2.3", mac: { target: "dir", icon: "/x/icon.icns" }, ...overrides };
}

// -----------------------------------------------------------------------------------------------------------
// Criterion 3 — no dmg, no notarization, no updater.
// -----------------------------------------------------------------------------------------------------------

test("the shipped configuration passes its own audit", () => {
  // The negative control for everything below: if `configProblems` refused everything, all the absence assertions
  // would pass while the build could never run.
  assert.deepEqual(configProblems(shippedConfig()), []);
});

test("a dmg target is refused, because it cannot be notarized and would be a second distributable", () => {
  for (const target of ["dmg", "pkg", "zip", "mas"]) {
    const problems = configProblems({ electronVersion: "45.2.3", mac: { target } });
    assert.equal(problems.length > 0, true, `${target} must be refused`);
    assert.match(problems.join("\n"), /only "dir" is allowed|App-Sandboxed|distributed/);
  }
});

test("an ABSENT target is refused, because electron-builder defaults to dmg", () => {
  // The subtle version: not setting `target` looks like "no opinion" and means "dmg and zip", which is the exact thing
  // criterion 3 forbids. A test that only checked for an explicit `dmg` would pass.
  const problems = configProblems({ electronVersion: "45.2.3", mac: {} });
  assert.match(problems.join("\n"), /would default to "dmg"/);
});

test("notarize and publish are refused at either level", () => {
  for (const key of FORBIDDEN_CONFIG_KEYS) {
    const inMac = configProblems(otherwiseValid({ mac: { target: "dir", icon: "/x/icon.icns", [key]: {} } }));
    assert.equal(inMac.length > 0, true, `mac.${key} must be refused`);
    const atRoot = configProblems(otherwiseValid({ [key]: {} }));
    assert.equal(atRoot.length > 0, true, `${key} at the root must be refused`);
  }
});

test("a version RANGE is refused, which is the failure measured against electron-builder", () => {
  // Measured: `"electron": "^45.2.3"` in the manifest produces "Electron version ^45.2.3 is a range, not a fixed
  // version" and no build at all. The script passes the INSTALLED version for this reason.
  for (const range of ["^45.2.3", "~45.2.3", "45.x", ">=45", "*"]) {
    const problems = configProblems({ electronVersion: range, mac: { target: "dir" } });
    assert.match(problems.join("\n"), /range|not set/, `${range} must be refused`);
  }
  assert.deepEqual(configProblems(otherwiseValid()), []);
  // And an absent version is its own refusal, because electron-builder cannot package without one.
  assert.match(configProblems(otherwiseValid({ electronVersion: undefined })).join("\n"), /electronVersion is not set/);
});

test("no dependency makes the app an update target", () => {
  // A config scan cannot see a transitive dependency, so the manifest is checked too.
  const app = JSON.parse(readFileSync(join(ROOT, "packages", "app", "package.json"), "utf8")) as Record<string, unknown>;
  const all = { ...(app["dependencies"] ?? {}), ...(app["devDependencies"] ?? {}) } as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_DEPENDENCIES) {
    assert.equal(forbidden in all, false, `${forbidden} must not be a dependency of the app`);
  }
  // electron-builder is a devDependency of the ROOT (it builds the app), never of the app itself — an app that depends
  // on its own packager is a bundle that could try to rebuild itself.
  assert.equal("electron-builder" in all, false, "the packager is the root's devDependency, not the app's");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 5 — no product code in the bundle.
// -----------------------------------------------------------------------------------------------------------

test("a bundle carrying the orchestrator or the UI is refused", () => {
  // The failure this prevents is the shell becoming a second distributable (ADR-0013 §1) — a second copy of the product
  // with its own version that can drift from the one `npm install -g` installed.
  for (const forbidden of ["bin/pi-central.js", "dist/ui", "dist/ui/assets/index-abc.js"]) {
    const problems = bundleProblems(["app.asar", "package.json", forbidden]);
    assert.equal(problems.length > 0, true, `${forbidden} must be refused`);
    assert.match(problems.join("\n"), /product code/);
  }
});

test("`files` globs that would ship product code are refused BEFORE the build", () => {
  /*
   * The gap the falsification found: `bundleProblems` audits the artifact, so a `files` entry naming `bin/` only failed
   * AFTER a successful build. Catching it in the config means the build never runs — same statement, one step earlier.
   */
  for (const entry of ["bin", "bin/pi-central.js", "dist", "dist/ui", "./dist/ui"]) {
    const problems = configProblems(otherwiseValid({ files: ["main.js", entry] }));
    assert.equal(problems.length > 0, true, `files including "${entry}" must be refused`);
    assert.match(problems.join("\n"), /product code/);
  }
  // And the shipped globs pass.
  assert.deepEqual(configProblems(shippedConfig()), []);
});

test("a bundle of the shell alone is accepted", () => {
  // The control: the real bundle holds `app.asar`, `default_app.asar` and the icon. `node_modules/ws` is INSIDE the
  // asar and is a runtime dependency of the shell (it opens the socket that asks which sessions are live), not product
  // code.
  assert.deepEqual(bundleProblems(["app.asar", "default_app.asar", "icon.icns"]), []);
});

// -----------------------------------------------------------------------------------------------------------
// The icon (issue #239) — the app advertised Electron's, everywhere, and nothing said so.
// -----------------------------------------------------------------------------------------------------------

test("a configuration with no icon is refused, because electron-builder falls back to Electron's silently", () => {
  /*
   * The defect: the built bundle carried `electron.icns` with the same SHA-256 as the Electron distribution's, so the
   * dock, ⌘-Tab, the About window, Finder and Launchpad all showed Electron's logo. electron-builder treats "no icon
   * configured" as a warning, not an error, so its absence has to fail here or it is invisible.
   */
  const withoutIcon = otherwiseValid({ mac: { target: "dir" } });
  const problems = configProblems(withoutIcon);
  assert.equal(problems.length, 1, `exactly one problem, and it is the icon: ${problems.join("; ")}`);
  assert.match(problems[0] ?? "", /Electron's own icon/);
  assert.match(problems[0] ?? "", /npm run build:icon/, "and it names the fix");
});

test("a PNG icon is refused too, because electron-builder would download a converter to make an .icns", () => {
  /*
   * This one does not fail visibly — it succeeds by fetching a toolset from GitHub on first use. The build's contract is
   * "no network beyond npm install" (the same reason `electronDist` is set), and a silent download is how that erodes.
   */
  const problems = configProblems(otherwiseValid({ mac: { target: "dir", icon: "/x/build/icon.png" } }));
  assert.match(problems.join("\n"), /would download its converter toolset/);
  // And the shipped `.icns` is accepted.
  assert.deepEqual(configProblems(otherwiseValid()), []);
});

test("a bundle whose icon is Electron's is refused, whichever way it got there", () => {
  /*
   * `configProblems` catches a bad configuration, so this is the artifact check: the file the `Info.plist` names, compared
   * against the icon in the Electron distribution the build was given. It catches a missing file, a fallback that got past
   * the config check, and a misconfigured path — one comparison, and it cannot be argued with.
   */
  const electron = "5a9a78d54c157f55672afea37037464858a87fd5f276fc8206787f366ed684cf";
  const problems = iconProblems({ iconFile: "icon.icns", iconSha: electron }, electron);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /is Electron's own/);
  assert.match(problems[0] ?? "", /⌘-Tab/, "and it says where the mark shows, not just that it is wrong");

  // Our own icon passes, and so does any icon that is not the framework's.
  assert.deepEqual(iconProblems({ iconFile: "icon.icns", iconSha: "ef1ff88d" }, electron), []);
});

test("a bundle naming no icon, or naming one that is not there, is reported rather than assumed fine", () => {
  const electron = "5a9a78d";
  assert.match(iconProblems({ iconFile: "", iconSha: "x" }, electron).join("\n"), /no CFBundleIconFile/);
  assert.match(
    iconProblems({ iconFile: undefined, iconSha: undefined }, electron).join("\n"),
    /no CFBundleIconFile/,
  );
  // Named but absent is its own sentence: a plist key pointing at a file the build did not copy.
  assert.match(iconProblems({ iconFile: "icon.icns", iconSha: undefined }, electron).join("\n"), /not in Contents\/Resources/);
});

/** A decoded PNG: its size, and the colour at a point as `[r, g, b, a]`. */
function decodePng(path: string): { width: number; height: number; at: (x: number, y: number) => [number, number, number, number] } {
  const bytes = readFileSync(path);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colourType = bytes[25];
  assert.equal(bitDepth, 8, `${path} must be 8 bits per channel to be read here`);
  assert.equal(colourType, 6, `${path} must be RGBA`);
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  // Un-filter: each scanline is a filter byte then `stride` bytes, and the filter refers to the previous scanline.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left: number = x >= 4 ? (out[y * stride + x - 4] ?? 0) : 0;
      const up: number = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft: number = x >= 4 && y > 0 ? (out[(y - 1) * stride + x - 4] ?? 0) : 0;
      const value = line[x] ?? 0;
      let restored = value;
      if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        restored = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[y * stride + x] = restored & 0xff;
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const i = y * stride + x * 4;
      return [out[i] ?? 0, out[i + 1] ?? 0, out[i + 2] ?? 0, out[i + 3] ?? 0];
    },
  };
}

test("the committed icon is a container macOS can read, and it is not Electron's", (t) => {
  /*
   * The icon is assembled byte by byte by `scripts/build-icon.mjs` — because `iconutil -c icns` refuses a complete, valid
   * iconset on this macOS (26.7.2), including one it had just extracted itself from Electron's own valid `.icns`. So "it
   * is a file" is not evidence: a length field off by eight produces something `ls` calls an icon and macOS calls
   * nothing, and the symptom is exactly the defect this slice fixes — a generic mark in the dock.
   */
  const path = join(ROOT, "packages", "app", "build", "icon.icns");
  assert.ok(existsSync(path), "packages/app/build/icon.icns is committed; npm run build:icon regenerates it");
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "icns", "the container magic");
  assert.equal(bytes.readUInt32BE(4), bytes.length, "the length field covers the whole file");
  // Every element's length must land exactly on the next one, and the last must land on the end of the file.
  let offset = 8;
  const types: string[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= bytes.length, `element at ${offset} has a bad length ${length}`);
    types.push(bytes.subarray(offset, offset + 4).toString("ascii"));
    offset += length;
  }
  assert.equal(offset, bytes.length, "the elements cover the file with no slack");
  assert.deepEqual(types, ["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]);

  /*
   * The comparison against the framework's icon needs Electron's **macOS** distribution, which only exists on a macOS
   * checkout: `node_modules/electron/dist` is the host platform's build, so CI (ubuntu) has a Linux binary and no
   * `Electron.app`. This was the first version's mistake — it asserted `existsSync(electronIcon)` and failed on CI for a
   * reason unrelated to the icon. The skip is named, per the convention `spawn-live.test.ts` states, so a run that did
   * not make the comparison says so instead of looking green.
   *
   * The container assertions above still run everywhere, and they are the ones that catch a hand-written `.icns` being
   * malformed. The `app-icon.test.ts` colour assertions are the ones that catch the artwork being Electron's, and they
   * need no external file.
   */
  const electronIcon = join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "Resources", "electron.icns");
  if (!existsSync(electronIcon)) {
    t.diagnostic("Electron's macOS icon is not unpacked here (not a macOS checkout); the framework comparison is skipped");
    return;
  }
  assert.notEqual(
    createHash("sha256").update(bytes).digest("hex"),
    createHash("sha256").update(readFileSync(electronIcon)).digest("hex"),
    "the app's icon must not be Electron's",
  );
});

test("the icon is Pi Central's mark, not a re-encode of Electron's artwork", () => {
  /*
   * A hash is not enough on its own: a copy of Electron's drawing re-encoded is a different file with the same defect. So
   * the pixels are read, and the mark's own colours are asserted.
   */
  const icon = decodePng(join(ROOT, "packages", "app", "build", "icon.png"));
  assert.equal(icon.width, 1024, "the master is 1024px, the macOS icon grid");
  assert.equal(icon.height, 1024);

  const counts = new Map<string, number>();
  for (let y = 0; y < 1024; y += 1) {
    for (let x = 0; x < 1024; x += 1) {
      const [r, g, b, a] = icon.at(x, y);
      const key = a === 0 ? "transparent" : `${r},${g},${b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const total = 1024 * 1024;
  const green = counts.get("63,163,131") ?? 0;
  const white = counts.get("255,255,255") ?? 0;
  // The circle inscribes the square, so its area is pi/4 ≈ 78.5% of the canvas, of which the pi glyph is the white part.
  assert.ok(green > total * 0.5, `the brand green must be the mark's body, found ${green} of ${total} px`);
  assert.ok(white > total * 0.15, `the pi must be white, found ${white} of ${total} px`);
  // Nothing else is drawn: those two colours, the outside of the circle, and their antialiased blends.
  const colours = [...counts.entries()].filter(([, n]) => n > total * 0.005).map(([colour]) => colour);
  assert.deepEqual(colours.sort(), ["255,255,255", "63,163,131", "transparent"]);
});

test("the mark FILLS the canvas, because macOS 26 draws the tile and plate itself", () => {
  /*
   * This test is the inverse of the first version of it, and that is the point: the first version asserted a transparent
   * margin of more than 10% of the canvas, which *enforced* the defect.
   *
   * Measured, after the mark was inset to 824 of 1024 px: the built app rendered as a light rounded plate with a **grey
   * margin between the plate and the green circle**. macOS 26 draws the tile and expects the artwork to fill it, so the
   * inset was applied twice — ours inside the system's. Electron's own icon has an opaque box of 922/1024 px (90%), which
   * is the reference that was available all along.
   *
   * So: the drawing must reach the edges, and the only transparency may be outside the circle.
   */
  const icon = decodePng(join(ROOT, "packages", "app", "build", "icon.png"));
  // Midpoints of all four edges are on the circle, so they must be opaque — that is what "fills the canvas" means.
  for (const [x, y, where] of [
    [512, 0, "top"],
    [512, 1023, "bottom"],
    [0, 512, "left"],
    [1023, 512, "right"],
  ] as const) {
    assert.notEqual(icon.at(x, y)[3], 0, `the ${where} edge must carry the drawing, not a margin`);
  }
  // And the corners are outside the inscribed circle, which is the only reason any of this is transparent.
  for (const [x, y] of [
    [0, 0],
    [1023, 0],
    [0, 1023],
    [1023, 1023],
  ] as const) {
    assert.equal(icon.at(x, y)[3], 0, `the corner at ${x},${y} is outside the circle and must be transparent`);
  }
  // The content box reaches the full canvas, so no inset survives.
  let minX = 1024;
  let maxX = -1;
  for (let y = 0; y < 1024; y += 1) {
    for (let x = 0; x < 1024; x += 1) {
      if (icon.at(x, y)[3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  assert.equal(minX, 0, "the drawing starts at the left edge");
  assert.equal(maxX, 1023, "and reaches the right edge");
});
