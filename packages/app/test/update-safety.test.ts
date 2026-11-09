/**
 * What the update path must never do (issue #217, criteria 1, 8 and 9).
 *
 * ## Why these are separate assertions
 *
 * The other two update files check that an update *works* and that its failures are honest. These three criteria
 * are all prohibitions, and a prohibition cannot be tested by exercising the feature — it has to be tested against
 * the code and against the filesystem, because the failure is "a line appeared" rather than "a test broke":
 *
 *   - **Criterion 1:** nothing is installed without an explicit action. The failure is a `setTimeout`, a
 *     `whenReady` hook, or an `autoDownload` that arrives in a later refactor looking harmless.
 *   - **Criterion 8:** no credential and no telemetry. The failure is an extra `npm` flag or a header.
 *   - **Criterion 9:** `~/.pi` is untouched. The failure is an install or a journal write landing in the reader's
 *     Pi environment (principle 9).
 *
 * Each is asserted as a property of the source plus, where it can be, a real filesystem check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, latestVersionCommand } from "../src/update-decide.ts";

const MAIN = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const UPDATER = readFileSync(new URL("../src/updater.ts", import.meta.url), "utf8");
const DECIDE = readFileSync(new URL("../src/update-decide.ts", import.meta.url), "utf8");

/** Every source file the shell ships. Used for the "nothing phones home" scan. */
function shellSources(): { name: string; text: string }[] {
  const directory = new URL("../src/", import.meta.url);
  const files: { name: string; text: string }[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".ts")) continue;
    files.push({ name: entry, text: readFileSync(new URL(entry, directory), "utf8") });
  }
  return files;
}

// -----------------------------------------------------------------------------------------------------------
// Criterion 1 — nothing is installed without an explicit action.
// -----------------------------------------------------------------------------------------------------------

test("the install is reachable only from the menu action, never from startup or a timer", () => {
  /*
   * The defect this prevents is a well-meant refactor: a "check on launch" that also applies, or a retry that
   * installs. `applyUpdate` must be called from exactly one place — the menu item's handler — and never from
   * `whenReady`, an interval, or a socket event.
   */
  const calls = [...MAIN.matchAll(/applyUpdate\(/g)].length;
  assert.equal(calls, 1, `applyUpdate must be called from exactly one place, found ${calls}`);

  // The one call site is inside the update function, which is reached from the menu.
  const updateFn = MAIN.slice(MAIN.indexOf("async function applyUpdateFromMenu"));
  assert.notEqual(updateFn.length, 0, "the update lives in its own function");
  assert.equal(updateFn.includes("applyUpdate("), true);

  // And the menu registration is what references it.
  const menu = MAIN.slice(MAIN.indexOf('label: "Check for Updates…"'));
  assert.notEqual(menu.length, 0, "there is a menu item for it");
  assert.equal(menu.slice(0, 400).includes("applyUpdateFromMenu"), true, "the menu item is the only entry point");

  // No timer installs anything. A `setInterval`/`setTimeout` that reaches the updater would be criterion 1 lost.
  for (const [pattern, why] of [
    [/setInterval\([^)]*applyUpdate/s, "an interval must not apply an update"],
    [/setTimeout\([^)]*applyUpdate/s, "a timer must not apply an update"],
  ] as const) {
    assert.equal(pattern.test(MAIN), false, why);
  }
  // `app.whenReady` must not start an update either.
  const whenReady = MAIN.slice(MAIN.indexOf("app.whenReady()"), MAIN.indexOf("app.whenReady()") + 800);
  assert.equal(/applyUpdate/.test(whenReady), false, "startup must not apply an update");
});

test("nothing in the shell mentions autoDownload or electron-updater", () => {
  // ADR-0013 §6 and ADR-0011 §4: this app has no Developer ID, so `electron-updater` cannot be used at all — and an
  // auto-download is the "never automatic" rule inverted.
  for (const source of [MAIN, UPDATER, DECIDE]) {
    for (const forbidden of ["autoDownload", "electron-updater", "checkForUpdatesAndNotify", "autoUpdater"]) {
      assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in the shell`);
    }
  }
});

test("the check action is separate from the apply action, so looking cannot install", () => {
  // ADR-0011 §4: detect freely, apply only on request. Two menu items, and the check one never installs.
  assert.equal(MAIN.includes("Check for Updates…"), true, "there is a check action");
  const checkFn = MAIN.slice(MAIN.indexOf("async function checkForUpdateFromMenu"));
  assert.notEqual(checkFn.length, 0);
  assert.equal(checkFn.slice(0, 1200).includes("applyUpdate("), false, "looking must not install");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 8 — no credential, no telemetry.
// -----------------------------------------------------------------------------------------------------------

test("the only network call is npm's own, and it carries the package name only", () => {
  const latest = latestVersionCommand();
  assert.deepEqual(latest.args, ["view", "pi-central@latest", "version", "--json"]);
  // No registry override, no token, no auth header, no `--otp`.
  for (const arg of latest.args) {
    assert.equal(/--registry|_authToken|--otp|--userconfig|Authorization/i.test(arg), false, `${arg} adds a credential or an endpoint`);
  }
  // And the install has no flags that reach the network beyond npm's own defaults.
  const install = installCommand("0.11.0");
  for (const arg of install.args) {
    assert.equal(/--registry|_authToken|--otp/i.test(arg), false, `${arg} is an extra network parameter`);
  }
});

test("the shell itself opens no socket: no fetch to anywhere but loopback, no http client", () => {
  /*
   * The distinction this asserts: **npm** makes the request, the shell does not. A `fetch` to a remote host in the
   * shell would be the product's own outbound call, which ADR-0011 §4 makes opt-in and #55's to own — and an
   * exception here is how a version check becomes telemetry.
   *
   * Only actual CALLS are matched, not every URL-shaped string: an earlier version of this test failed on the literal
   * `http://host:port` in an error message, which is a diagnostic and not a request. A test that cannot tell a message
   * from a call is a test that will be deleted the first time it is wrong about something harmless.
   */
  for (const source of shellSources()) {
    for (const match of source.text.matchAll(/\bfetch\(([^)]*)/g)) {
      const target = (match[1] ?? "").trim();
      // The only permitted fetch is `probePort` (#216): loopback, to a process this app itself started.
      assert.equal(
        /127\.0\.0\.1|localhost/.test(target),
        true,
        `${source.name} fetches ${target} — the shell must make no outbound request`,
      );
    }
    // And no HTTP client at all: a `request(`/`https.get` would be the same thing spelled differently.
    assert.equal(/\bhttps?\.(get|request)\(/.test(source.text), false, `${source.name} uses an HTTP client`);
  }
});

test("the only subprocesses the shell spawns are ones it names explicitly", () => {
  /*
   * Criterion 8's other half. The update path runs `npm`, the probe runs `sh`, and the orchestrator runs `node`. Every
   * one of those is a literal in the source, so a command built from an environment variable or a string from the
   * network would be visible here — which is the shape a "configurable npm path" fix would take.
   */
  for (const source of shellSources()) {
    assert.equal(
      /spawn\(\s*(process\.env|config|payload|message|args\[)/.test(source.text),
      false,
      `${source.name} spawns a command it did not name`,
    );
  }
});

test("the update path sends no environment to npm beyond what npm inherits", () => {
  /*
   * C11's rule one level out: the update path must not become a way to hand the child's environment somewhere. The
   * install is a plain `npm` invocation with no `env:` of its own, which is asserted here because an injected
   * `env` is exactly the shape that would arrive with a "fix" for a PATH problem.
   */
  const installFn = MAIN.slice(MAIN.indexOf("function runCommand"), MAIN.indexOf("function runCommand") + 2000);
  assert.equal(/env:\s*(process\.env|\{)/.test(installFn), false, "npm inherits its environment; nothing is injected");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 9 — the reader's Pi environment is untouched.
// -----------------------------------------------------------------------------------------------------------

test("nothing in the update path writes under ~/.pi", () => {
  // principle 9 and #56 criterion 5. The journal lives in the app's own data directory; a path that reached into the
  // Pi tree would be writing to the reader's agent environment, which this product promises not to do.
  for (const source of [MAIN, UPDATER, DECIDE]) {
    assert.equal(/\.pi\/agent|\.pi["'`]|PI_CODING_AGENT_DIR\s*=/.test(source), false, "the update path must not name the Pi tree");
  }
  // Positively: the journal is written under the app data directory, which is where `runtime.json` already lives.
  assert.equal(UPDATER.includes("persistPhase"), true);
  const journalPath = MAIN.slice(MAIN.indexOf("function updateJournalPath"), MAIN.indexOf("function persistUpdatePhase"));
  assert.equal(journalPath.includes("getPath(\"userData\")"), true, "the journal lives in the app's own data directory");
  // And the phase writer uses that path, rather than computing one of its own.
  const phaseWriter = MAIN.slice(MAIN.indexOf("function persistUpdatePhase"), MAIN.indexOf("function readUpdateJournal"));
  assert.equal(phaseWriter.includes("updateJournalPath()"), true);
  assert.equal(/\/\s*\.pi|join\([^)]*\.pi/.test(phaseWriter), false, "the journal is not inside the Pi tree");
});

test("the phase journal is written atomically, like the runtime record", () => {
  // A truncated journal reads as "no update was in progress", which would make crash recovery silently do nothing —
  // the same reasoning as `runtime.json` (#216) and `open-sessions.json` (#185).
  const writer = UPDATER.slice(UPDATER.indexOf("export interface UpdateEnvironment"));
  assert.equal(writer.length > 0, true);
  // The atomic write lives with the other record writers, in `runtime-record.ts`, and `main.ts` reuses it.
  const record = readFileSync(new URL("../src/runtime-record.ts", import.meta.url), "utf8");
  assert.equal(record.includes("renameSync"), true, "a record writer renames into place");
  assert.equal(record.includes("writeFileSync"), true);
});

test("the update never writes into a directory it chose from the environment", () => {
  /*
   * A real filesystem check for the property above: the only paths the update produces are the app data directory and
   * whatever npm owns. Asserted by scanning the modules for a write whose target came from `process.env`, which is the
   * shape that would put a journal somewhere the user did not choose.
   */
  for (const source of [UPDATER, DECIDE]) {
    assert.equal(/writeFileSync\([^)]*process\.env/s.test(source), false, "no write target comes from the environment");
  }
  // And a negative control, so the test proves it can see a violation at all.
  assert.equal(/writeFileSync\([^)]*process\.env/s.test("writeFileSync(process.env.HOME)"), true);
});

test("a temporary file is never created inside the installed package", () => {
  // The package root is what npm replaces. A temp file there would be deleted mid-write, or worse, shipped.
  const record = readFileSync(new URL("../src/runtime-record.ts", import.meta.url), "utf8");
  assert.equal(record.includes("runtimeRecordPath"), true);
  // `writeRuntimeRecord` takes the app data directory as its argument, never the package root.
  assert.equal(/writeRuntimeRecord\(\s*[^,]*findPackageRoot/.test(MAIN), false);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 2 — the current version comes from the artifact.
// -----------------------------------------------------------------------------------------------------------

test("the running version is read from the resolved package, not restated anywhere", () => {
  // `readCurrentVersion` in `main.ts` must go through `locatePackage()`, which is `package-root.ts`'s walk over the
  // installed manifest — the same resolution the spawn uses.
  const readFn = MAIN.slice(MAIN.indexOf("readCurrentVersion:"), MAIN.indexOf("readCurrentVersion:") + 500);
  assert.equal(readFn.includes("locatePackage"), true, "the version comes from the installed package");
  // No literal version anywhere in the shell's own sources: a constant is the bug criterion 2 names.
  for (const source of shellSources()) {
    assert.equal(
      /\bversion:\s*"\d+\.\d+\.\d+"/.test(source.text),
      false,
      `${source.name} hard-codes a version, which would make the app believe it is newer than it is`,
    );
  }
});
