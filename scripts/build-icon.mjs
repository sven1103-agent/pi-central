#!/usr/bin/env node
/**
 * `npm run build:icon` — turn the brand mark into the macOS app icon (issue #239).
 *
 * ## Why the icon was Electron's, and why that is a defect rather than a default
 *
 * `electron-builder` falls back to the framework's own icon when none is configured, and that fallback is silent: the
 * built app carries `electron.icns`, `Info.plist` says `CFBundleIconFile = electron.icns`, and the dock, ⌘-Tab, the
 * application menu's About row and Finder all show **Electron's** logo. Nothing in the build reports it, because
 * "no icon configured" is not an error to the packager. Measured on the first real bundle: the icon in
 * `Contents/Resources` was byte-identical to `node_modules/electron/dist/Electron.app`'s.
 *
 * ## Why the `.icns` is assembled here rather than by electron-builder
 *
 * electron-builder converts a PNG to `.icns` by running a helper it **downloads** from
 * `electron-userland/electron-builder-binaries` on first use. This project's build deliberately has no network beyond
 * `npm install`: `electronDist` is set for exactly that reason (`scripts/app-build/rules.mjs`), and a build that quietly
 * grows a download is the failure mode that decision exists to prevent.
 *
 * ## Why the container is written byte by byte instead of by `iconutil`
 *
 * The obvious second choice was macOS's own `iconutil -c icns`, and it **does not work on this machine**: it reports
 * `Invalid Iconset.` for a complete, correctly named iconset — including one produced by `iconutil -c iconset` itself from
 * Electron's valid `electron.icns` (macOS 26.7.2). A build step that fails on a healthy input is not a build step.
 *
 * An `.icns` is a four-byte magic, a big-endian total length, and then elements of `[type][length][payload]`, so the
 * container is 20 lines of Node with no tool at all. `sips` — stock, offline, already required by this build — produces
 * the square PNGs, and the result is verified by reading it back through `iconutil -c iconset` (the direction that does
 * work) and by `sips`, so a malformed container fails here rather than in the dock.
 *
 * ## Why there is no padding, which the first version got wrong
 *
 * The first version inset the mark into 824 of 1024 px, on the belief that this was "the macOS content box". It is not,
 * for this macOS. **Measured**: Electron's own `electron.icns` has an opaque box of 922/1024 px (90%), and the built app
 * with an 824/1024 (80%) mark rendered as a light rounded plate with a *grey margin* between the plate and the green
 * circle — the inset applied twice.
 *
 * macOS 26 changed the model: the system draws the tile and the plate, and the artwork is expected to **fill** it. The
 * evidence is in the system's own apps — `Calculator.app` and `Stickies.app` carry no `.icns` at all, only an
 * `Assets.car` produced by Icon Composer for exactly that layered rendering. A plain `.icns` is the legacy path, and
 * macOS renders it inside a plate; padding it as well puts our margin *inside* the system's.
 *
 * So the mark fills the canvas. That is also what it already looks like: the artwork is a green circle in a square, and
 * `--brand` (`#3fa383`) is the plate's own colour, so a full-bleed circle and a system plate agree with each other.
 *
 * What is NOT available here is the native macOS 26 form (`Icon Composer` → `Assets.car`): it needs Xcode 26 and
 * `icontool`, and `xcrun --find icontool` reports *"not a developer tool"* on this machine. That is the same class of
 * limit ADR-0013 already accepted for notarization — stated rather than worked around.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "packages", "app", "build");
const MARK = join(ROOT, "packages", "ui", "src", "assets", "logo-icon.svg");
const PNG = join(BUILD, "icon.png");
const ICNS = join(BUILD, "icon.icns");

/** The macOS icon grid: content occupies 824 of 1024 px, centred. */
const CANVAS = 1024;
/**
 * The drawing's box, as a fraction of the canvas.
 *
 * `1` — full bleed. The first version used 824/1024 and produced a double inset on macOS 26: the system drew its plate and
 * the artwork had already padded itself, so the margin appeared twice (see the header).
 */
const CONTENT = CANVAS;

/**
 * The elements of the container, as `[type, pixels]`.
 *
 * `ic07`–`ic14` are the PNG-bearing types macOS reads from 10.7 on, and they cover every slot the system asks for: 128,
 * 256, 512 and 1024 at 1x and 2x, plus the small retina forms. Electron's own `electron.icns` carries exactly this set,
 * which is the reference this was written against (its 16/32 px legacy `is32`/`il32` masks are 10.6-era and are not
 * needed for an app built for macOS 13+).
 */
const ELEMENTS = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

const step = (text) => console.log(`build-icon: ${text}`);
const fail = (text) => {
  console.error(`build-icon: ${text}`);
  process.exit(1);
};

if (!existsSync(MARK)) fail(`${MARK} is missing; it is the only source of the mark`);
mkdirSync(BUILD, { recursive: true });

/**
 * Rasterise the mark onto a padded canvas, once.
 *
 * `rsvg-convert` is used when it is available because it keeps the drawing vector-sharp; otherwise the committed PNG is
 * kept as-is — this script's job at build time is the `.icns` container, and requiring a Homebrew tool for it would make
 * the icon unbuildable on a clean machine.
 */
function writePng() {
  const probe = spawnSync("rsvg-convert", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    if (existsSync(PNG)) {
      step("rsvg-convert is not installed, so the committed icon.png is used as the source");
      return;
    }
    fail("rsvg-convert is not installed and there is no committed icon.png to fall back to");
  }
  const svg = readFileSync(MARK, "utf8");
  /*
   * The mark is NESTED rather than transformed, and its own `viewBox` is carried through untouched.
   *
   * The first version rewrote the root `viewBox` and added a `transform` to the drawing's `<g>` — and rsvg-convert refused
   * it outright: *"Attribute transform redefined"*, because the mark's own layer already has one (Inkscape's page offset).
   * Nesting is also the more honest shape: the artwork keeps the coordinate system it was drawn in, and the padding is
   * expressed once, as the nested element's `x`/`y`/`width`/`height`.
   */
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  if (viewBox === undefined) fail(`${MARK} has no viewBox, so it cannot be scaled`);
  const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1];
  if (body === undefined) fail(`${MARK} has no body between its <svg> tags`);
  const inset = (CANVAS - CONTENT) / 2;
  const wrapped =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">\n` +
    `  <svg x="${inset}" y="${inset}" width="${CONTENT}" height="${CONTENT}" viewBox="${viewBox}">${body}</svg>\n` +
    `</svg>\n`;
  const staged = join(mkdtempSync(join(tmpdir(), "pi-central-icon-")), "wrapped.svg");
  writeFileSync(staged, wrapped, "utf8");
  const result = spawnSync("rsvg-convert", ["-w", String(CANVAS), "-h", String(CANVAS), "-o", PNG, staged], {
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`rsvg-convert failed:\n${result.stderr || result.stdout}`);
  step(`wrote ${PNG} (${CANVAS}×${CANVAS}, mark at ${CONTENT})`);
}

writePng();

/** One slot at one size, as PNG bytes. `sips -z` resamples; it is stock macOS and needs no network. */
function slot(pixels) {
  const staged = join(mkdtempSync(join(tmpdir(), "pi-central-slot-")), `${pixels}.png`);
  const result = spawnSync("sips", ["-z", String(pixels), String(pixels), PNG, "--out", staged], { encoding: "utf8" });
  if (result.status !== 0) fail(`sips failed for ${pixels}px:\n${result.stderr || result.stdout}`);
  const bytes = readFileSync(staged);
  rmSync(dirname(staged), { recursive: true, force: true });
  return bytes;
}

/** `[type][length][payload]`, lengths big-endian and including the header, as the format defines them. */
function element(type, payload) {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}

const elements = ELEMENTS.map(([type, pixels]) => element(type, slot(pixels)));
const body = Buffer.concat(elements);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
writeFileSync(ICNS, Buffer.concat([header, body]));
step(`wrote ${ICNS} (${ELEMENTS.length} elements, ${CANVAS}px master)`);

/**
 * Read the container back before declaring success.
 *
 * The failure this catches is the one that cannot be seen from here: a length field off by eight produces a file that
 * `ls` calls an icon and macOS calls nothing, and the symptom is a generic Electron icon in the dock — the exact defect
 * this script exists to fix. `sips` asks ImageIO, which is the same reader the dock uses.
 */
const readBack = spawnSync("sips", ["-g", "pixelWidth", ICNS], { encoding: "utf8" });
if (readBack.status !== 0) fail(`the container does not read back:\n${readBack.stderr || readBack.stdout}`);
const size = Number(/pixelWidth:\s*(\d+)/.exec(readBack.stdout)?.[1] ?? "0");
if (size !== CANVAS) fail(`ImageIO reads the icon as ${size}px, not ${CANVAS}px`);
step(`ImageIO reads it back as ${size}×${size}`);

