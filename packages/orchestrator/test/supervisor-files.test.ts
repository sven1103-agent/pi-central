/**
 * File browsing through the SUPERVISOR, against a real session (issue #8).
 *
 * `files.test.ts` proves `resolveWithin` refuses escapes. What it cannot prove is that a *session*
 * is what supplies the confinement — that the root handed to the resolver is the session's own cwd
 * and not, say, the process cwd or the config's `home`. That seam is here: real `Supervisor`, real
 * temp directory, `listFiles`/`readFile` called the way the transport calls them.
 *
 * Nothing is spawned. A `Supervisor.start` registers the session (and its cwd) before it launches a
 * process, and the file methods read the registry rather than the process — so an `error` listener is
 * all the launch needs. That is the same seam `own-installation.test.ts` uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Supervisor } = await import("../src/supervisor.ts");

/** A supervisor over a real temp tree, with one session rooted at `cwd`. */
function supervisorWith(cwd: string, root: string) {
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
    installationRoot: join(root, "installation"),
  });
  // Without a listener, the launch failure this test run provokes becomes an unhandled exception
  // and fails the run for a reason unrelated to what is under test.
  supervisor.on("error", () => {});
  const started = supervisor.start({ cwd: realpathSync(cwd) });
  if (!started.ok) throw new Error(`start refused: ${started.message}`);
  return { supervisor, sessionId: started.session.id };
}

test("the session's own cwd is the root, not the process cwd", () => {
  // The whole point of routing through the supervisor: `listFiles` must resolve against the
  // SESSION's directory. A resolver handed `process.cwd()` would pass every test in `files.test.ts`
  // and still browse the wrong tree here.
  const root = mkdtempSync(join(tmpdir(), "pi-central-sup-"));
  try {
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, "here.txt"), "in the session cwd\n");
    // A sibling of the session's cwd. Reachable from the process, and must NOT be reachable here.
    writeFileSync(join(root, "outside.txt"), "not in the session cwd\n");

    const { supervisor, sessionId } = supervisorWith(work, root);

    const listing = supervisor.listFiles(sessionId, "");
    assert.equal(listing.ok, true);
    if (!listing.ok) return;
    assert.deepEqual(
      listing.value.entries.map((entry) => entry.name),
      ["here.txt"],
      "the listing must be the session's cwd, not its parent or the process cwd",
    );

    // And an escape to the sibling is refused, which is only true if the root is `work`.
    const escaped = supervisor.listFiles(sessionId, "../");
    assert.equal(escaped.ok, false);
    assert.equal(escaped.ok === false && escaped.error.reason, "escapes-cwd");

    supervisor.stop(sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown session is refused as such, never resolved against another root", () => {
  // A stale session id must not silently browse *something*. If this fell back to any root, a UI
  // tab left open across a restart would browse a directory with no relation to what it claimed.
  const root = mkdtempSync(join(tmpdir(), "pi-central-sup-"));
  try {
    const work = join(root, "work");
    mkdirSync(work);
    const { supervisor, sessionId } = supervisorWith(work, root);

    const listing = supervisor.listFiles("s-does-not-exist", "");
    assert.equal(listing.ok, false);
    assert.equal(listing.ok === false && listing.error.reason, "not-found");
    assert.match(listing.ok === false ? listing.error.message : "", /no session s-does-not-exist/);

    const read = supervisor.readFile("s-does-not-exist", "x.txt");
    assert.equal(read.ok, false);
    assert.equal(read.ok === false && read.error.reason, "not-found");

    supervisor.stop(sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reading through the supervisor is confined too, and a symlink escape is refused", () => {
  // A read must be held to the same root as a listing. Checking only `listFiles` would leave the
  // path that actually returns file CONTENTS unsupervised.
  const root = mkdtempSync(join(tmpdir(), "pi-central-sup-"));
  try {
    const work = join(root, "work");
    mkdirSync(work);
    writeFileSync(join(work, "inside.txt"), "safe\n");
    writeFileSync(join(root, "secret.txt"), "must not be readable\n");
    symlinkSync(join(root, "secret.txt"), join(work, "link.txt"));

    const { supervisor, sessionId } = supervisorWith(work, root);

    const ok = supervisor.readFile(sessionId, "inside.txt");
    assert.equal(ok.ok, true);
    assert.equal(ok.ok === true && ok.value.text, "safe\n");

    // The symlink is followed by `realpath`, and the resolved target is outside the cwd.
    const linked = supervisor.readFile(sessionId, "link.txt");
    assert.equal(linked.ok, false);
    assert.equal(linked.ok === false && linked.error.reason, "escapes-cwd");

    // The sibling, addressed directly, is not reachable either.
    const direct = supervisor.readFile(sessionId, "../secret.txt");
    assert.equal(direct.ok, false);
    assert.equal(direct.ok === false && direct.error.reason, "escapes-cwd");

    supervisor.stop(sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session rooted at HOME still confines to that directory, whatever HOME is", () => {
  // #49 is the open issue that a session whose cwd IS `$HOME` gets the run of the home tree. This
  // asserts the narrower fact that is in scope for #8: the resolver's root is exactly the session's
  // cwd, so the confinement boundary and the session boundary coincide. Whether such a session
  // should be *refused* is #49's question, and it is deliberately not answered here.
  const fauxHome = mkdtempSync(join(tmpdir(), "pi-central-home-"));
  try {
    mkdirSync(join(fauxHome, "git"));
    writeFileSync(join(fauxHome, ".npmrc"), "//registry:_authToken=secret\n");
    const { supervisor, sessionId } = supervisorWith(fauxHome, fauxHome);

    const atHome = supervisor.listFiles(sessionId, "");
    assert.equal(atHome.ok, true);
    // `includeHidden` off by default, so the dotfile is not even listed — but the boundary question
    // is the next assertion, not this one.
    const above = supervisor.listFiles(sessionId, "..");
    assert.equal(above.ok, false, "even from HOME, the parent is out of bounds");
    assert.equal(above.ok === false && above.error.reason, "escapes-cwd");

    supervisor.stop(sessionId);
  } finally {
    rmSync(fauxHome, { recursive: true, force: true });
  }
});
