import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkWorkspaceRoot,
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
