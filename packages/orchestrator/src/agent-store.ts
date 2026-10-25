/**
 * The agent credential store: inspection, ownership, explicit re-import, and drift
 * (ADR-0010 §5).
 *
 * The agent root is a single path holding everything the agent *is*: `gh/` (GH_CONFIG_DIR),
 * `gitconfig` (GIT_CONFIG_GLOBAL), `ssh/`, and optionally a keychain. It has exactly one
 * writer, chosen by ownership mode:
 *
 *   - `managed`  — Pi Central owns it and may write (create, rotate, export).
 *   - `external` — the user owns it (e.g. the hardening project's `~/.agent`). Pi Central
 *                  **reads and verifies only, and never writes.**
 *
 * Two writers on one credential tree is drift, not concurrency — the hardening project hit
 * exactly that ("the repo copy and the live copy had already drifted once"). So ownership is
 * exclusive and explicit, never shared.
 *
 * ## Inspection never reads a secret
 *
 * Everything here is metadata: which files exist, their modes, the agent's *non-secret*
 * identity, and a fingerprint of those facts. Reading a token to "check" it would copy the
 * user's secret into Pi Central's process for no benefit, so `readStore` deliberately does
 * not open `gh/hosts.yml`, an SSH private key, or a keychain item. The fingerprint is built
 * from stat metadata and `gitconfig`'s non-secret keys, so drift is detectable without the
 * secret ever being read.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Ownership = "managed" | "external";

export interface StoreFile {
  /** Path relative to the agent root, so a report is portable between machines. */
  relPath: string;
  mode: number;
  size: number;
}

/** The non-secret identity an agent acts as. */
export interface AgentIdentity {
  /** `user.name` from the agent's gitconfig, if set. */
  name?: string;
  /** `user.email` from the agent's gitconfig — GitHub's noreply form links commits. */
  email?: string;
}

export interface StoreSnapshot {
  root: string;
  exists: boolean;
  ownership: Ownership;
  identity: AgentIdentity;
  /** Non-secret facts about what is present. Booleans only — never contents. */
  has: {
    gitconfig: boolean;
    ghConfig: boolean;
    sshKey: boolean;
    sshSigningKey: boolean;
    knownHosts: boolean;
    sshCommandWrapper: boolean;
    keychain: boolean;
  };
  /** Metadata for files under the root, for drift comparison. */
  files: StoreFile[];
  /**
   * A hash of the non-secret facts above.
   *
   * Drift is "the fingerprint changed", not "the secret changed" — so re-import can compare
   * states without reading a credential.
   */
  fingerprint: string;
}

/** The agent keychain's filename within an agent root (the hardening project's convention). */
export const KEYCHAIN_FILE = "agent.keychain-db";

/** Pi's provider credential file, inside an agent directory. */
export const PROVIDER_AUTH_FILE = "auth.json";

/**
 * Does this directory look like an agent credential tree?
 *
 * Used to adopt an existing external tree (the hardening project's `~/.agent`) instead of
 * creating a second one, so an existing setup is imported rather than duplicated
 * (ADR-0010 §5). Deliberately requires a marker file, not merely an existing directory: a
 * stray empty `~/.agent` must not silently become the credential root.
 */
export function looksLikeAgentTree(root: string): boolean {
  if (!existsSync(root)) return false;
  return (
    existsSync(join(root, KEYCHAIN_FILE)) ||
    existsSync(join(root, "gitconfig")) ||
    existsSync(join(root, "gh")) ||
    existsSync(join(root, "ssh"))
  );
}

/**
 * What Pi's provider configuration implies about keychain access (C13).
 *
 * `auth.json` maps a provider to either a literal key or a **command** that resolves one:
 *
 *   "litellm": { "key": "!security find-generic-password -ws 'litellm'" }
 *
 * A command-based key is looked up lazily on the first call that needs it, so Pi cannot know
 * at startup whether it will succeed. That is why the *policy* has to reason about it up
 * front: without keychain access the session starts, reports idle, and then cannot think.
 */
export interface ProviderAuth {
  /** The file inspected. */
  path: string;
  readable: boolean;
  /** Providers named in the file. Names are configuration, not secrets. */
  providers: string[];
  /** Providers whose key is resolved by running a command rather than stored inline. */
  commandProviders: string[];
  /** True when some command reaches the macOS keychain and therefore needs a policy grant. */
  needsKeychain: boolean;
}

/**
 * Inspect a provider credential file for its *shape* only.
 *
 * Never returns a key. A file may hold literal keys for some users, so the value is examined
 * only to classify it (literal vs command) and is then discarded. Nothing here logs, returns,
 * or fingerprints a secret.
 */
export function inspectProviderAuth(agentDir: string): ProviderAuth {
  const path = join(agentDir, PROVIDER_AUTH_FILE);
  const result: ProviderAuth = {
    path,
    readable: false,
    providers: [],
    commandProviders: [],
    needsKeychain: false,
  };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Absent (ENOENT) is normal and Pi tolerates it. A denied read (EPERM) is NOT tolerated:
    // Pi exits 1 (C12), which is why this file must never be denied.
    return result;
  }
  result.readable = true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;

  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    result.providers.push(provider);
    if (typeof value !== "object" || value === null) continue;
    const key = (value as { key?: unknown }).key;
    if (typeof key !== "string" || !key.startsWith("!")) continue;
    result.commandProviders.push(provider);
    // `security` is the macOS keychain CLI. Other commands (a vault CLI, say) do not need a
    // keychain grant, so the check is specific rather than "any command".
    if (/\bsecurity\b/.test(key)) result.needsKeychain = true;
  }

  return result;
}

/** Files whose *contents* are never read, only their presence and metadata. */
const SECRET_BEARING = new Set(["gh/hosts.yml", "ssh/id_ed25519", "ssh/id_rsa", KEYCHAIN_FILE]);

export interface ReadStoreOptions {
  ownership?: Ownership;
}

/**
 * Inspect an agent root without reading any secret.
 *
 * Returns a snapshot even when the root does not exist, so a caller can render "not
 * configured yet" rather than handling a special case.
 */
export function readStore(root: string, options: ReadStoreOptions = {}): StoreSnapshot {
  const ownership = options.ownership ?? "managed";
  const exists = existsSync(root);

  const gitconfigPath = join(root, "gitconfig");
  const identity = exists && existsSync(gitconfigPath) ? readIdentity(gitconfigPath) : {};

  const has = {
    gitconfig: existsSync(gitconfigPath),
    ghConfig: existsSync(join(root, "gh")),
    sshKey: existsSync(join(root, "ssh", "github_login_ed25519")) || existsSync(join(root, "ssh", "id_ed25519")),
    sshSigningKey: existsSync(join(root, "ssh", "allowed_signers")),
    knownHosts: existsSync(join(root, "ssh", "known_hosts")),
    sshCommandWrapper: existsSync(join(root, "ssh", "ssh-github.sh")),
    keychain: existsSync(join(root, KEYCHAIN_FILE)),
  };

  const files = exists ? listFiles(root) : [];
  const snapshot: StoreSnapshot = { root, exists, ownership, identity, has, files, fingerprint: "" };
  snapshot.fingerprint = fingerprintOf(snapshot);
  return snapshot;
}

/**
 * A stable hash over the *non-secret* state of a store.
 *
 * `size` is included but contents are not: it catches a rotated token (which changes the file
 * length) while still never reading the value. A same-length rotation is not detected — that
 * is a deliberate limit, and the reason re-import is explicit rather than trusted to be exact.
 */
function fingerprintOf(snapshot: StoreSnapshot): string {
  const facts = {
    exists: snapshot.exists,
    identity: snapshot.identity,
    has: snapshot.has,
    files: snapshot.files.map((f) => [f.relPath, f.mode, f.size]),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

/** List files under the root as metadata only. One level of nesting is enough here. */
function listFiles(root: string): StoreFile[] {
  const found: StoreFile[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 2) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = join(dir, entry.name);
      try {
        const stats = statSync(full);
        if (stats.isDirectory()) {
          walk(full, relPath, depth + 1);
        } else {
          found.push({ relPath, mode: stats.mode & 0o777, size: stats.size });
        }
      } catch {
        // Unreadable entries are skipped: the report is advisory, and refusing here would
        // make an unreadable file indistinguishable from a missing one.
      }
    }
  };
  walk(root, "", 0);
  return found.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Read the agent's non-secret identity from its gitconfig.
 *
 * Only `user.name` and `user.email`. A credential helper line is deliberately ignored: it may
 * embed a token, and the point of this module is not to read credentials.
 */
function readIdentity(gitconfigPath: string): AgentIdentity {
  const identity: AgentIdentity = {};
  let text: string;
  try {
    text = readFileSync(gitconfigPath, "utf8");
  } catch {
    return identity;
  }
  // Read the *user* section only, so no other section's values are picked up.
  let inUser = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inUser = /^\[user\]/i.test(line);
      continue;
    }
    if (!inUser) continue;
    const match = /^(name|email)\s*=\s*(.+)$/i.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    if (value === "") continue;
    if (match[1]!.toLowerCase() === "name") identity.name = value;
    else identity.email = value;
  }
  return identity;
}

export interface DriftEntry {
  relPath: string;
  kind: "added" | "removed" | "changed";
  detail: string;
}

export interface DriftReport {
  drifted: boolean;
  entries: DriftEntry[];
  /** Fingerprint comparison, for the badge's tooltip. */
  from: string;
  to: string;
}

/**
 * Compare an imported snapshot against the current state of the same tree.
 *
 * This is what powers the drift badge: an `external` tree can change under Pi Central at any
 * time (the user owns it), so the difference is surfaced rather than silently picked up. It is
 * computed on demand — never on the launch path — because re-import is explicit (ADR-0010 §5).
 */
export function detectDrift(imported: StoreSnapshot, current: StoreSnapshot): DriftReport {
  const entries: DriftEntry[] = [];
  const before = new Map(imported.files.map((f) => [f.relPath, f]));
  const after = new Map(current.files.map((f) => [f.relPath, f]));

  for (const [relPath, file] of after) {
    const previous = before.get(relPath);
    if (!previous) {
      entries.push({ relPath, kind: "added", detail: `new file (${file.size} bytes)` });
    } else if (previous.size !== file.size || previous.mode !== file.mode) {
      // Described without values: a size change is enough to flag a rotation, and naming the
      // content would defeat the purpose of never reading it.
      entries.push({
        relPath,
        kind: "changed",
        detail:
          previous.mode !== file.mode
            ? `mode ${octal(previous.mode)} -> ${octal(file.mode)}`
            : `size ${previous.size} -> ${file.size}`,
      });
    }
  }
  for (const [relPath] of before) {
    if (!after.has(relPath)) entries.push({ relPath, kind: "removed", detail: "no longer present" });
  }

  if (imported.identity.name !== current.identity.name || imported.identity.email !== current.identity.email) {
    entries.push({
      relPath: "gitconfig",
      kind: "changed",
      detail: `identity ${describeIdentity(imported.identity)} -> ${describeIdentity(current.identity)}`,
    });
  }

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    drifted: imported.fingerprint !== current.fingerprint,
    entries,
    from: imported.fingerprint,
    to: current.fingerprint,
  };
}

function describeIdentity(identity: AgentIdentity): string {
  if (identity.name === undefined && identity.email === undefined) return "(none)";
  return `${identity.name ?? "?"} <${identity.email ?? "?"}>`;
}

function octal(mode: number): string {
  return `0${mode.toString(8)}`;
}

export interface ImportOptions {
  /** The tree to adopt. */
  root: string;
  ownership: Ownership;
}

export interface ImportPlan {
  ok: boolean;
  ownership: Ownership;
  snapshot: StoreSnapshot;
  /** What is missing for the agent to be able to act at all. */
  missing: string[];
  /** Human-readable notes, e.g. what `external` ownership means for writes. */
  notes: string[];
}

/**
 * Plan an import: inspect the tree and report what would be adopted.
 *
 * Writing is **not** part of this. For `external` ownership Pi Central never writes at all;
 * for `managed` the caller creates missing pieces. Separating the plan from the write is what
 * makes re-import safe to run repeatedly.
 */
export function planImport(options: ImportOptions): ImportPlan {
  const snapshot = readStore(options.root, { ownership: options.ownership });
  const missing: string[] = [];
  const notes: string[] = [];

  if (!snapshot.exists) {
    missing.push(`agent root does not exist: ${options.root}`);
  } else {
    if (!snapshot.has.gitconfig) missing.push("gitconfig (needed for GIT_CONFIG_GLOBAL and the agent's commit identity)");
    if (!snapshot.has.ghConfig) missing.push("gh/ (needed for GH_CONFIG_DIR; supplies the agent's GitHub token)");
    if (!snapshot.has.sshKey) {
      notes.push(
        "no SSH key found: the agent can still push over HTTPS with its gh token, but not " +
          "over SSH, and commit signing needs a key",
      );
    }
    if (snapshot.identity.email === undefined) {
      notes.push("no user.email in gitconfig: commits would not be attributed to the agent account");
    }
  }

  if (options.ownership === "external") {
    notes.push(
      "external ownership: Pi Central reads and verifies this tree but never writes to it, " +
        "so the tree can be shared with an interactive setup. Re-import is explicit.",
    );
  } else {
    notes.push("managed ownership: Pi Central owns this tree and may create or rotate files in it.");
  }

  return { ok: missing.length === 0, ownership: options.ownership, snapshot, missing, notes };
}

/** True when a path holds secret contents and must never be read by inspection code. */
export function isSecretBearing(relPath: string): boolean {
  return SECRET_BEARING.has(relPath);
}
