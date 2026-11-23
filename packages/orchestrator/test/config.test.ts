import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkWorkspaceRoot,
  defaultConfig,
  isScratch,
  resolveAgentRoot,
  scratchDirFor,
  type Config,
} from "../src/config.ts";

const dir_base = mkdtempSync(join(tmpdir(), "pi-central-config-"));
process.on("exit", () => rmSync(dir_base, { recursive: true, force: true }));

const HOME = "/Users/tester";

test("the recommended default workspace is allowed (D-5)", () => {
  const root = join(HOME, ".local", "share", "pi-central", "workspaces");
  assert.deepEqual(checkWorkspaceRoot(root, HOME), []);
});

test("$HOME itself is refused", () => {
  const v = checkWorkspaceRoot(HOME, HOME);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.root, HOME);
});

test("a bare $HOME subdirectory is allowed -- only $HOME proper is banned", () => {
  // The distinction that matters: banning all of $HOME would reject the recommended path.
  assert.deepEqual(checkWorkspaceRoot(join(HOME, "projects"), HOME), []);
});

test("/tmp and /var/folders are refused (globally granted by the base profile)", () => {
  for (const p of ["/tmp/pi-central", "/var/folders/ab/cd", "/private/tmp/pi-central"]) {
    const v = checkWorkspaceRoot(p, HOME);
    assert.ok(v.length > 0, `${p} should be refused`);
  }
});

test("~/.pi is refused (C6)", () => {
  const v = checkWorkspaceRoot(join(HOME, ".pi", "agent"), HOME);
  assert.ok(v.some((x) => x.reason.includes("~/.pi")));
});

test("a workspace inside a recursively-granted tool dir is refused", () => {
  // ~/.local/share/go is a subpath grant in the base profile, so a workspace there would
  // be reachable by every other session.
  const v = checkWorkspaceRoot(join(HOME, ".local", "share", "go", "workspaces"), HOME);
  assert.equal(v.length, 1);
  assert.ok(v[0]!.reason.includes("recursive read/write grant"));
});

test("~/.local/share itself is NOT banned (safehouse grants it as a literal only)", () => {
  assert.deepEqual(checkWorkspaceRoot(join(HOME, ".local", "share"), HOME), []);
});

test("contains() does not confuse sibling prefixes", () => {
  // /Users/tester/.local/share/goX must not be seen as inside .../go
  assert.deepEqual(checkWorkspaceRoot(join(HOME, ".local", "share", "golang"), HOME), []);
});

test("scratchDirFor builds one directory per session and refuses unsafe ids", () => {
  const config = { workspaceRoot: "/ws" } as Config;
  assert.equal(scratchDirFor(config, "s1"), join("/ws", "s1"));
  assert.throws(() => scratchDirFor(config, "../../etc"), /unsafe id/);
  assert.throws(() => scratchDirFor(config, "a/b"), /unsafe id/);
});

test("isScratch distinguishes the app workspace from a real project", () => {
  const config = { workspaceRoot: "/ws/workspaces" } as Config;
  assert.equal(isScratch(config, "/ws/workspaces/s1"), true);
  assert.equal(isScratch(config, "/Users/tester/git/real-project"), false);
  assert.equal(isScratch(config, "/ws/workspaces-other"), false);
});


// --- Agent root resolution (ADR-0010 §5) --------------------------------------------------

test("an explicit PI_CENTRAL_AGENT_ROOT always wins, and implies external ownership", () => {
  const chosen = resolveAgentRoot("/state", { PI_CENTRAL_AGENT_ROOT: "/custom/agent" }, HOME);
  assert.deepEqual(chosen, { agentRoot: "/custom/agent", managed: false });
});

test("an existing ~/.agent tree is ADOPTED, so a hardening setup is imported not duplicated", () => {
  // This is the whole point: an interactive setup and Pi Central must share one credential
  // tree, or the two drift (ADR-0010 §5: one writer per file).
  const home = join(dir_base, "home-adopt");
  mkdirSync(join(home, ".agent", "ssh"), { recursive: true });
  const chosen = resolveAgentRoot("/state", {}, home);
  assert.deepEqual(chosen, { agentRoot: join(home, ".agent"), managed: false });
});

test("a stray empty ~/.agent is NOT adopted (markers required)", () => {
  const home = join(dir_base, "home-empty");
  mkdirSync(join(home, ".agent"), { recursive: true });
  const chosen = resolveAgentRoot("/state", {}, home);
  assert.deepEqual(chosen, { agentRoot: join("/state", "agents", "default"), managed: true });
});

test("with no external tree, a managed root under the state root is used", () => {
  const home = join(dir_base, "home-fresh");
  mkdirSync(home, { recursive: true });
  const chosen = resolveAgentRoot("/state", {}, home);
  assert.deepEqual(chosen, { agentRoot: join("/state", "agents", "default"), managed: true });
});

test("an empty explicit value is ignored rather than resolving to the filesystem root", () => {
  const home = join(dir_base, "home-blank");
  mkdirSync(home, { recursive: true });
  const chosen = resolveAgentRoot("/state", { PI_CENTRAL_AGENT_ROOT: "" }, home);
  assert.equal(chosen.managed, true);
  assert.notEqual(chosen.agentRoot, "");
});

test("the session browser is OFFERED when a browser exists, with no environment variable at all", () => {
  /*
   * The defect this holds: `sidecarOffered` was `PI_CENTRAL_SIDECAR === "1"`, so the environment was the only way to
   * offer the feature. A dock PWA or a Finder-launched .app inherits no shell environment, so the shipped, documented way
   * to run Pi Central was the one way the feature could never be turned on -- and nothing said why.
   *
   * Pointing PI_CENTRAL_BROWSER at a binary that exists proves it is a CAPABILITY question: the answer must be "offered"
   * with no PI_CENTRAL_SIDECAR in sight, and "not offered" for a path that is not there. The second half is the half that
   * would otherwise show a checkbox on a machine with no browser, where every capture fails.
   */
  const saved = { browser: process.env["PI_CENTRAL_BROWSER"], sidecar: process.env["PI_CENTRAL_SIDECAR"] };
  try {
    delete process.env["PI_CENTRAL_SIDECAR"];
    // Any path that exists will do; the check is `existsSync`, not "is it Chromium".
    process.env["PI_CENTRAL_BROWSER"] = process.execPath;
    assert.equal(defaultConfig().sidecarOffered, true, "a present browser is enough to offer it");
    assert.equal(defaultConfig().sidecar, false, "but it is still not the DEFAULT for new sessions");

    process.env["PI_CENTRAL_BROWSER"] = "/nonexistent/chrome-for-this-test";
    assert.equal(defaultConfig().sidecarOffered, false, "and no browser means no switch to show");
  } finally {
    if (saved.browser === undefined) delete process.env["PI_CENTRAL_BROWSER"];
    else process.env["PI_CENTRAL_BROWSER"] = saved.browser;
    if (saved.sidecar === undefined) delete process.env["PI_CENTRAL_SIDECAR"];
    else process.env["PI_CENTRAL_SIDECAR"] = saved.sidecar;
  }
});
