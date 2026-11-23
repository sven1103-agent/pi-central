import { statSync } from "node:fs";
import { join } from "node:path";
import { servedUiIdentity } from "./static-ui.ts";

/**
 * Startup failures, said in terms a person can act on (issue #114).
 *
 * ## What this replaces
 *
 * `main()` already failed with exit 1 and already printed the error's own message:
 *
 *     Pi Central failed to start: listen EADDRINUSE: address already in use 127.0.0.1:8787
 *
 * So my first write-up of this issue was wrong in a specific way, and the correction matters: it is not
 * that the failure is invisible, it is that **the message names the mechanism and not the situation**.
 * "EADDRINUSE" tells you a syscall failed. It does not tell you that you almost certainly have a second
 * `npm run server` running, or that *that* is why the UI you are looking at is the old one — which is the
 * debugging round trip this issue is actually about.
 *
 * A message about a port collision has to answer three things, in order: what happened, what it means for
 * you, and what to do. The syscall name is none of them.
 */

/** A startup failure explained for a human. `undefined` when this error is not one we can explain. */
export function explainStartupError(error: unknown, host: string, port: number): string | undefined {
  const code = (error as { code?: string } | undefined)?.code;

  if (code === "EADDRINUSE") {
    return [
      `Port ${port} is already in use on ${host}.`,
      ``,
      `That is almost always a Pi Central that is already running — and it is why this one did not`,
      `start. If you were expecting the code you just rebuilt to be served, you are probably looking at`,
      `the OLD process: its pages are still being served, and Node has its old modules cached.`,
      ``,
      `  Find it:   lsof -ti tcp:${port}`,
      `  Stop it:   kill $(lsof -ti tcp:${port})`,
      `  Or use another port:  --port <n>`,
    ].join("\n");
  }

  if (code === "EACCES") {
    return [
      `Permission denied binding ${host}:${port}.`,
      ``,
      `Ports below 1024 need elevated privileges on most systems, and Pi Central has no reason to want`,
      `one — it is a local tool. Use a port above 1024:  --port 8788`,
    ].join("\n");
  }

  if (code === "EADDRNOTAVAIL") {
    return [
      `${host} is not an address this machine has.`,
      ``,
      `Pi Central binds loopback only (C5), so the host should be 127.0.0.1. A wrong host is usually a`,
      `typo in --host or in PI_CENTRAL_HOST.`,
    ].join("\n");
  }

  return undefined;
}

/**
 * The identity of the built UI on disk, for the startup log (issue #114).
 *
 * Read from the emitted `index.html`, because that is the file which names the current fingerprint set —
 * so the entry asset's hash IS the build's identity, and it is the same string a `curl` of the running
 * page would show. That is the comparison the issue is about.
 *
 * `(unreadable)` rather than a throw: a missing or malformed `index.html` is `hasBuiltUi`'s business
 * (it reports "no built UI"), and a log line must not be able to fail a start.
 */
/**
 * Whether the served UI was built a long way from the code that is running.
 *
 * The two artifacts are built by separate commands — `bin/` by `build:package`, `dist/ui` by `ui:build` — so a stale
 * bundle beside a fresh server is the ordinary result of rebuilding only one, and the UI that comes up is missing every
 * control the server has learned since. Measured: Settings rendered a protocol number and no Browser row, from source
 * that had both.
 *
 * **A wide window on purpose.** The two builds run seconds apart in a package build and an hour apart in a dev loop, so a
 * tight threshold would cry wolf constantly and teach the reader to ignore it. This is not a freshness check — that is
 * `staleBuiltUi` and it compares against a sibling tree. It only catches the case where the gap is large enough that the
 * reader is probably looking at something else.
 *
 * Left UNDONE: the marker fires when *either* artifact is much newer, which catches "stale bundle, fresh server" but not
 * its mirror — a page from tomorrow against a server from last week would need the bundle's own mtime, and `ServedUiIdentity`
 * does not carry one. Worth a field when someone is bitten by that direction.
 */
function uiLooksForeign(uiDir: string, builtAt: string): boolean {
  const built = Date.parse(builtAt);
  if (!Number.isFinite(built)) return false;
  try {
    // The orchestrator's own module file: its mtime is when THIS code was last built or edited.
    const own = statSync(new URL(import.meta.url)).mtimeMs;
    return own - built > UI_FOREIGN_MS;
  } catch {
    return false;
  }
}

/** A day. Any shorter and a dev loop that rebuilds the UI in the morning would warn every afternoon. */
const UI_FOREIGN_MS = 24 * 60 * 60 * 1000;

export function describeBuiltUi(uiDir: string): string {
  // `statSync` decides which failure this is: an `index.html` that cannot be read is "(unreadable)",
  // one that reads but names no bundle is a different defect and says so.
  let readable = true;
  try {
    statSync(join(uiDir, "index.html"));
  } catch {
    readable = false;
  }
  const identity = servedUiIdentity(uiDir);
  if (identity === undefined) return readable ? "(no entry bundle named in index.html)" : "(unreadable)";
  /*
   * SAY IT WHEN THE PAGE AND THE ORCHESTRATOR ARE FROM DIFFERENT BUILDS.
   *
   * Measured, and it cost a full afternoon: the orchestrator and the UI bundle are built separately, and a stale
   * `dist/ui` beside a fresh `bin/` produces a UI that lacks the feature the orchestrator has. Desktop Settings showed a
   * protocol number with no Browser row, while a fresh build showed both — same source, different artifacts. Nothing on
   * screen said so, and the bundle name is the one fact that distinguishes them.
   *
   * Not an ERROR: a dev loop that rebuilds the UI and not the server is legitimate, and an orchestrator that refused to
   * start would be wrong. A marker, because the question "is the page I am looking at built from this code?" is the
   * question nobody thinks to ask while staring at a missing control.
   */
  const marker = uiLooksForeign(uiDir, identity.builtAt) ? "  <-- UI looks older than this build" : "";
  // The asset name and the file's mtime together: the name distinguishes builds, the time tells you
  // whether it predates your last edit.
  return `${identity.entry} (built ${identity.builtAt.slice(0, 16).replace("T", " ")})${marker}`;
}

/**
 * One line stating whether a session browser is offered, and why not when it is not.
 *
 * Every confusion of the last several rounds was resolved by making a value visible rather than by reasoning about it:
 * which UI is served, which package is launched, which protocol is spoken. The sidecar had no equivalent line, so
 * "Pi reports 0 servers" could mean the config was never written, the token was wrong, or the file was unreadable --
 * and telling those apart took a filesystem inspection on the machine.
 *
 * Printed at startup, beside `UI build:`, so it answers the question before a session is started.
 */
export function describeSidecar(options: {
  offered: boolean;
  browser: string;
  browserExists: boolean;
}): string {
  // The advice names the IN-APP switch first, because that is the one a reader can reach: a dock PWA or a Finder-launched
  // .app inherits no shell environment, so telling them to set a variable is telling them to do something they cannot.
  // The variable is still the answer for a scripted launch, so it is named second rather than dropped.
  // Measured: this advice said "set PI_CENTRAL_SIDECAR=1" and nothing else, which stayed in place for several commits
  // after the switch existed and told the reader to work around the fix.
  if (!options.offered) {
    return `not offered — no browser at ${options.browser}. Set PI_CENTRAL_BROWSER, or turn on "Preview its work in a browser" in Settings once one is found`;
  }
  if (!options.browserExists) return `OFFERED BUT UNSABLE: no browser at ${options.browser}`;
  return `offered, browser ${options.browser}`;
}
