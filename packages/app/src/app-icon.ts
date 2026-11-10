/**
 * The icon a running app shows, for the case the bundle cannot cover (issue #239).
 *
 * ## The defect this is named after
 *
 * The first installed bundle advertised **Electron's** icon everywhere — dock, ⌘-Tab, About, Finder, Launchpad — because
 * electron-builder falls back to the framework's icon when `mac.icon` is unset, and says nothing while doing it. The app
 * is called Pi Central; the only thing on the machine that said otherwise was the picture.
 *
 * That is fixed in the bundle: `packages/app/build/icon.icns` is assembled by `npm run build:icon`, passed as
 * `mac.icon`, and `iconProblems` refuses to install a bundle whose icon is still Electron's.
 *
 * ## What is left over is the development run
 *
 * `npm run app` launches the Electron binary from `node_modules/electron/dist` — there is no bundle of ours, so macOS
 * reads **that** bundle's icon, and the dock shows Electron's logo in the window the person writing the change is looking
 * at. That is the gap this module fills, and the only one: in a packaged launch the bundle is authoritative, so overriding
 * the tile from the same file could only introduce a disagreement (Finder showing one mark and the dock another).
 *
 * ## Why the candidate list is a pure function
 *
 * The path depends on `process.argv[1]`, which differs between the three ways the shell runs (an unbundled dev run, the
 * esbuild CommonJS bundle, a test). Keeping "which paths would be right" separate from "does one exist" is what makes it
 * assertable without an Electron process, which `node --test` cannot start.
 */

/** What the caller knows about its own launch. */
export interface IconEnvironment {
  /** True when running from a packaged bundle (`app.isPackaged`). */
  packaged: boolean;
  /** `process.argv[1]`: a real path in an unbundled run, the asar's `main.js` when packaged. */
  entryPath: string | undefined;
}

/**
 * Candidate icon files, most specific first. Empty when the app should leave the dock alone.
 *
 * The PNG rather than the `.icns`, and that is a measured choice: `nativeImage.createFromPath` returns an **empty image**
 * for an `.icns` — Electron's decoder is Skia's, which knows PNG and JPEG and does not read an icns container, even
 * though `sips` and ImageIO read the same file. Handing it a `.icns` would set an invisible dock tile, which is a worse
 * failure than the wrong one because it looks like the app crashed its own icon.
 */
export function dockIconCandidates(environment: IconEnvironment): string[] {
  if (environment.packaged) return [];
  const entry = environment.entryPath;
  if (entry === undefined || entry === "") return [];
  /*
   * `<checkout>/packages/app/src/main.ts` → `<checkout>/packages/app/build/icon.png`, the generated master.
   *
   * Stripping `/src/<file>` rather than walking up a fixed number of directories: `package-root.ts` established that
   * this repository resolves paths named relative to a known root, and a `dirname` chain would land in `build/` for the
   * entry point and in the asar's parent for the bundle, silently, with no error.
   */
  const appRoot = entry.replace(/[/\\]src[/\\][^/\\]+$/, "");
  if (appRoot === entry) return [];
  return [`${appRoot}/build/icon.png`];
}
