/**
 * The self-hosting hazard (issue #25).
 *
 * The predicate is the point of the slice, so it is tested directly as well as through its two
 * callers. The case that matters most is the one that must be **false**: a separate clone of the
 * same repository is the RECOMMENDED setup (`docs/DOGFOODING.md`), and a warning there would train
 * the user to dismiss the warning — which is worse than not having one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOwnInstallation,
  looksLikePiCentral,
  normalizePath,
  ownInstallationWarning,
  OWN_INSTALLATION_WARNING,
} from "@pi-central/protocol";

const INSTALL = "/Users/x/git/pi-central";

// --- The path boundary: segments, not prefixes ---------------------------------------------------

test("a path is compared by SEGMENTS, so a prefix-named sibling is not inside it", () => {
  // The bug a bare `startsWith` produces, and the reason this is tested on its own: the recommended
  // setup is a sibling clone (`pi-central-dev` beside `pi-central`), and `"…/pi-central-dev"
  // .startsWith("…/pi-central")` is TRUE. Every user doing the right thing would have been warned.
  assert.equal(isOwnInstallation("/Users/x/git/pi-central-dev", INSTALL), false);
  assert.equal(isOwnInstallation("/Users/x/git/pi-central-old", INSTALL), false);
  assert.equal(isOwnInstallation(`${INSTALL}-dev`, INSTALL), false);
});

test("the installation itself warns", () => {
  assert.equal(isOwnInstallation(INSTALL, INSTALL), true);
});

test("an ANCESTOR warns, because a grant on the parent includes the child", () => {
  // A session is sandboxed to its working directory, so a session at `~/git` can write the checkout
  // inside it. Less obvious than the same-directory case, and just as real.
  assert.equal(isOwnInstallation("/Users/x/git", INSTALL), true);
  assert.equal(isOwnInstallation("/Users/x", INSTALL), true);
  assert.equal(isOwnInstallation("/", INSTALL), true);
});

test("a DESCENDANT warns, because editing one package is enough", () => {
  // Editing `packages/ui` hot-reloads the UI; breaking `packages/orchestrator` is failure 3.
  assert.equal(isOwnInstallation(`${INSTALL}/packages/ui`, INSTALL), true);
  assert.equal(isOwnInstallation(`${INSTALL}/packages/orchestrator/src`, INSTALL), true);
});

test("an unrelated directory does not warn", () => {
  assert.equal(isOwnInstallation("/Users/x/git/other-project", INSTALL), false);
  assert.equal(isOwnInstallation("/tmp", INSTALL), false);
});

test("a trailing slash does not change the answer", () => {
  assert.equal(isOwnInstallation(`${INSTALL}/`, INSTALL), true);
  assert.equal(isOwnInstallation(INSTALL, `${INSTALL}/`), true);
});

test("a path with . or .. segments is normalised before comparison", () => {
  // A user typing `/Users/x/git/pi-central/packages/../packages/ui` means the descendant case, and a
  // textual comparison that skipped normalisation would miss it.
  assert.equal(isOwnInstallation("/Users/x/git/pi-central/packages/../packages/ui", INSTALL), true);
  assert.equal(isOwnInstallation("/Users/x/git/./pi-central", INSTALL), true);
});

test("a RELATIVE path is not mistaken for an absolute one that shares its suffix", () => {
  // Patched through the client bundle, this was reported as `packages/ui` matching
  // `…/packages/ui` — but the client compilation is patched BEFORE this file is ours, so the
  // corrected, unpatched call is what the next test covers. Kept explicit: `packages/ui` relative to
  // an unknown base is not evidence about `/Users/x/git/pi-central/packages/ui`.
  assert.equal(isOwnInstallation("packages/ui", INSTALL), false);
});

test("normalizePath resolves textually, without touching the filesystem", () => {
  // `realpath` is deliberately not used: this runs on every keystroke in the sheet, and it must be
  // sync and pure. A symlink that resolves differently from its spelling is a case where warning is
  // the safer error — a sentence on screen versus a broken dashboard.
  assert.equal(normalizePath("/a/b/../c"), "/a/c");
  assert.equal(normalizePath("/a/./b/"), "/a/b");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("//a//b"), "/a/b");
});

// --- The "could not tell" case is not the "safe" case --------------------------------------------

test("an unknown installation path produces NO warning, rather than a wrong one", () => {
  // A warning on every session would be noise; the honest report for "unknown" is the absence of a
  // claim, and the startup banner says so once. Collapsing unknown into "warns" or into "safe"
  // would both be a fabricated answer.
  assert.equal(ownInstallationWarning("/Users/x/git/pi-central", undefined), undefined);
  assert.equal(ownInstallationWarning(INSTALL, undefined), undefined);
});

test("the warning is undefined for a safe directory and a string otherwise", () => {
  assert.equal(ownInstallationWarning("/tmp/work", INSTALL), undefined);
  assert.equal(ownInstallationWarning(INSTALL, INSTALL), OWN_INSTALLATION_WARNING);
});

// --- The copy, which the issue asks to name consequences ----------------------------------------

test("the warning names the CONSEQUENCES, not only the condition", () => {
  // "This is the installation Pi Central is running from" describes a condition the reader cannot
  // evaluate. What they need is which three things break, so the sentence alone is enough to decide.
  const text = OWN_INSTALLATION_WARNING;
  assert.match(text, /hot-reload/i);
  assert.match(text, /desynchronise/i);
  assert.match(text, /restart/i);
  // And it points at the fix, because a warning without one is just anxiety.
  assert.match(text, /separate clone/i);
  assert.match(text, /DOGFOODING/);
});

test("the warning reads as a warning, not as a refusal", () => {
  // Non-blocking is a requirement: the user may have a good reason. The copy must not claim the
  // action is forbidden.
  assert.ok(!/\bmust not\b|\bcannot\b|\bforbidden\b|\brefused\b/i.test(OWN_INSTALLATION_WARNING));
});

// --- Recognising a checkout ----------------------------------------------------------------------

test("a Pi Central checkout is recognised by its workspace packages, not its directory name", () => {
  // A checkout may be called anything (`pi-central-dev`, a temporary clone), so the name is not
  // evidence. All three packages are required: two would mistake an unrelated repository that
  // happens to have a `packages/ui`.
  assert.equal(
    looksLikePiCentral([
      "/Users/x/git/anything/packages/orchestrator",
      "/Users/x/git/anything/packages/ui",
      "/Users/x/git/anything/packages/protocol",
    ]),
    true,
  );
  assert.equal(looksLikePiCentral(["/Users/x/git/other/packages/ui", "/Users/x/git/other/packages/protocol"]), false);
  assert.equal(looksLikePiCentral([]), false);
});

// --- The warning reaches the session row ---------------------------------------------------------

test("a session started in the installation's own tree carries the warning", async () => {
  // The warning has to PERSIST on the rail, not only appear in the sheet — a user who typed the
  // path and dismissed the sheet must still see why the dashboard is about to misbehave. This drives
  // the real `Supervisor` far enough to produce a `LiveSession`, without spawning anything: the
  // warning is assembled while the session object is built, before the process starts.
  const { Supervisor } = await import("../src/supervisor.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-central-hazard-"));
  // A SEPARATE tree, not a child of `root`. A child would be a DESCENDANT of the installation and
  // correctly warned about — which is what the first version of this test asserted, wrongly. The
  // failure is worth keeping in mind: "somewhere else" is not the same as "not inside it".
  const safeRoot = mkdtempSync(join(tmpdir(), "pi-central-safe-"));
  try {
    const supervisor = new Supervisor({
      workspaceRoot: join(root, "workspaces"),
      stateRoot: join(root, "state"),
      sessionsRoot: join(root, "sessions"),
      safehouse: "safehouse",
      pi: "pi",
      agentRoot: join(root, "agent"),
      fragmentDir: join(root, "state", "policy"),
      agentRootManaged: true,
      providerAgentDir: join(root, "provider"),
      home: root,
      installationRoot: root,
    });
    // The seam exists so this test can supply a path rather than depending on where the test file
    // happens to sit — the same reason every other path here is under a temp root.
    supervisor.setInstallationRoot(root);
    supervisor.on("error", () => {});

    // The directories must EXIST: the orchestrator validates the cwd before building the session,
    // and a missing one is refused (D-4). Building the shape matters — an empty temp root would have
    // failed for a reason unrelated to what is under test.
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    const dangerous = supervisor.start({ cwd: join(root, "packages", "ui") });
    if (!dangerous.ok) throw new Error(`start refused: ${dangerous.message}`);
    assert.ok(
      dangerous.session.warnings.includes(OWN_INSTALLATION_WARNING),
      `expected the self-hosting warning, got: ${JSON.stringify(dangerous.session.warnings)}`,
    );
    // `stop` emits on the supervisor; without a listener an emitted `error` becomes an unhandled
    // exception and fails the test run rather than the assertion.
    supervisor.on("error", () => {});
    supervisor.stop(dangerous.session.id);

    const safe = supervisor.start({ cwd: safeRoot });
    if (!safe.ok) throw new Error(`start refused: ${safe.message}`);
    assert.ok(
      !safe.session.warnings.includes(OWN_INSTALLATION_WARNING),
      "a sibling directory must not be warned about",
    );
    supervisor.stop(safe.session.id);
  } finally {
    for (const directory of [root, safeRoot]) rmSync(directory, { recursive: true, force: true });
  }
});

// --- The root travels to the UI, so the sheet can warn live --------------------------------------

test("the snapshot carries the installation root, so the sheet can evaluate it in the browser", async () => {
  // Without this the browser would have to guess where the orchestrator lives, and a guess about
  // "am I pointing at my own checkout?" is exactly the kind of claim the UI may not invent.
  const { Transport } = await import("../src/transport.ts");
  const { EventEmitter } = await import("node:events");
  const { WebSocket } = await import("ws");
  const root = mkdtempSync(join(tmpdir(), "pi-central-snapshot-"));
  try {
    class Fake extends EventEmitter {
      list() {
        return [];
      }
      async fetchTranscript() {
        return { ok: true as const, messages: [] };
      }
    }
    const transport = new Transport(
      new Fake() as never,
      {
        workspaceRoot: join(root, "workspaces"),
        stateRoot: join(root, "state"),
        sessionsRoot: join(root, "sessions"),
        safehouse: "safehouse",
        pi: "pi",
        agentRoot: join(root, "agent"),
        fragmentDir: join(root, "policy"),
        agentRootManaged: true,
        providerAgentDir: join(root, "provider"),
        home: root,
        installationRoot: "/Users/x/git/pi-central",
      },
      { uiDir: null },
    );
    const address = await transport.listen();
    try {
      const socket = new WebSocket(address.url);
      const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on("message", (data) => {
          const payload = JSON.parse(String(data)).payload as Record<string, unknown>;
          if (payload["kind"] === "snapshot") resolve(payload);
        });
        socket.on("error", reject);
      });
      assert.equal(snapshot["installationRoot"], "/Users/x/git/pi-central");
      socket.close();
    } finally {
      await transport.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
