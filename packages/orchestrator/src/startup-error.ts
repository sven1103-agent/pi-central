import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
export function describeBuiltUi(uiDir: string): string {
  try {
    const html = readFileSync(join(uiDir, "index.html"), "utf8");
    const entry = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
    if (entry === undefined) return "(no entry bundle named in index.html)";
    const { mtime } = statSync(join(uiDir, "index.html"));
    // The asset name and the file's mtime together: the name distinguishes builds, the time tells you
    // whether it predates your last edit.
    return `${entry} (built ${mtime.toISOString().slice(0, 16).replace("T", " ")})`;
  } catch {
    return "(unreadable)";
  }
}
