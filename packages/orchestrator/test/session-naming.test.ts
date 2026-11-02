/**
 * What an unnamed session is called (issue #149 follow-up).
 *
 * ## The defect this pins
 *
 * Starting a session in a directory used to name it after that directory, so three tasks in one project gave
 * three rows called `pi-central` — a name that looks chosen, and a duplicate. Reported from use after #149 made
 * starting a second task in one directory a single click:
 *
 *   > the new session gets the name of the directory as it seems. I think we should stick to the Undefined
 *   > session, because otherwise it looks intentional.
 *
 * That is #77's settled principle — *"a generated name looks chosen"* removes the nudge to name it — meeting #78's
 * defect (identical labels cannot be told apart) from a new direction.
 *
 * ## Why this is a supervisor test and not a UI one
 *
 * The name is INVENTED in the orchestrator (`LiveSession.name`), so the UI can only render what it is given. A test
 * on `displayName` alone would pass while the orchestrator went on inventing directory names.
 *
 * Nothing is spawned: `start` registers the session before it launches a process, so a launch failure is enough
 * to observe the name (the same seam `supervisor-files.test.ts` uses).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Supervisor, handleName } = await import("../src/supervisor.ts");

function supervisorFor(root: string) {
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
  // The launch failure this provokes is expected; without a listener it fails the run for an unrelated reason.
  supervisor.on("error", () => {});
  return supervisor;
}

test("an unnamed session is named by its handle, never by its directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-naming-"));
  try {
    const supervisor = supervisorFor(root);
    // The same directory twice, which is the case #149 makes easy and the case a directory name breaks: two rows,
    // one label.
    const first = supervisor.start({ cwd: root });
    const second = supervisor.start({ cwd: root });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.notEqual(first.session.name, second.session.name, "two tasks in one directory need two names");
    assert.equal(first.session.name, handleName(first.session.id), "the handle IS the name");
    assert.equal(second.session.name, handleName(second.session.id));

    // And specifically not the directory, which is the defect.
    const directory = root.split("/").filter(Boolean).pop()!;
    assert.notEqual(first.session.name, directory, "the directory name is not a session name");
    void supervisor.stopAll({ forget: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a name the caller supplies is kept — this is about the DEFAULT only", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-naming-"));
  try {
    const supervisor = supervisorFor(root);
    const started = supervisor.start({ cwd: root, name: "  my task  " });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.session.name, "my task", "trimmed, and not replaced by the handle");
    void supervisor.stopAll({ forget: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
