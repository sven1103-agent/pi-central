/**
 * Commit and tag signing for an agent identity (issue #27).
 *
 * ## What was wrong
 *
 * ADR-0010 §4 states that SSH push **and commit signing** are required for agents. The adopted agent
 * tree satisfied the first and not the second: its `gitconfig` set
 *
 *     [commit] gpgsign = false
 *     [tag]    gpgsign = false
 *
 * with no `signingkey` and no `gpg.format`. Signing key material was present the whole time — a key
 * at `ssh/github_login_ed25519` and a matching `ssh/allowed_signers` — so commits were unsigned
 * **silently**, while every check that looked for the key reported success.
 *
 * That is the same shape as C15 and issue #28: the material exists, the configuration that makes it
 * *do* anything does not, and "is the key there?" cannot tell the difference.
 *
 * ## What this module does, and — more importantly — what it does not
 *
 * It **reads, parses, and audits**. It does not write.
 *
 * The agent root is `external` in this deployment (ADR-0010 §5): it is shared with an interactive
 * terminal setup and is maintained by the user. Pi Central must never rewrite it silently, so the fix
 * here is an **explicit, confirmed action** — the exact `git config` commands are produced as text
 * and printed, and a person runs them. `signingFixCommands` exists for that and is part of the public
 * surface precisely so the fix is reproducible from the warning.
 *
 * ## The check that carries the security weight
 *
 * `user.signingkey` pointing **outside** the agent root is not a misconfiguration of degree, it is a
 * different failure: the agent would sign as the *host user*. `ssh` receives a path, not key
 * contents (ADR-0010 §4), so a path is the only thing standing between "the agent signed" and "the
 * user signed". An in-root signing key is therefore an assertion, not a style preference, and it is
 * tested — including that a key one directory up is refused.
 *
 * ## Why the parser is hand-written
 *
 * `git config --list` is the obvious alternative and it is wrong here: it **resolves** includes and
 * applies system and global config, so it would report the *effective* value while hiding that the
 * agent's own file disagrees — and would read the host's configuration to do it. The audit must be
 * about the agent's own file, so the file is parsed. Only the handful of keys below are consulted,
 * and the parser covers exactly the syntax `git config` emits (`[section]`, `[section "sub"]`,
 * `key = value`), which is asserted against real `git config` output in the tests rather than
 * assumed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** The private key an agent signs with. The same key it pushes over SSH with (ADR-0010 §4). */
export function signingKeyPath(root: string): string {
  return join(root, "ssh", "github_login_ed25519");
}

/** The `allowed_signers` file that lets a signature be verified without the host's configuration. */
export function allowedSignersPath(root: string): string {
  return join(root, "ssh", "allowed_signers");
}

/** The signing-related settings, as they appear in the agent's own gitconfig. */
export interface SigningSettings {
  /** `commit.gpgsign`. `undefined` means unset, which — like `false` — means git does not sign. */
  commitGpgsign?: string | undefined;
  /** `tag.gpgsign`. */
  tagGpgsign?: string | undefined;
  /** `gpg.format`. Must be `ssh`; the default is `openpgp`, which would look for gpg. */
  format?: string | undefined;
  /** `user.signingkey` — a PATH, because ssh takes paths and not key contents. */
  signingKey?: string | undefined;
  /** `gpg.ssh.allowedSignersFile`. Without it a signature cannot be verified at all. */
  allowedSignersFile?: string | undefined;
}

/** The dotted key `git config` uses, mapped to the field it fills. */
const KEYS: Record<string, keyof SigningSettings> = {
  [normalizeKey("commit.gpgsign")]: "commitGpgsign",
  [normalizeKey("tag.gpgsign")]: "tagGpgsign",
  [normalizeKey("gpg.format")]: "format",
  [normalizeKey("user.signingkey")]: "signingKey",
  [normalizeKey("gpg.ssh.allowedSignersFile")]: "allowedSignersFile",
};

/**
 * Normalise a dotted git config key the way git compares it.
 *
 * **The section and the final key are case-insensitive; the subsection is case-sensitive.** That is
 * git's rule, and getting it wrong is not cosmetic: git writes `gpg.ssh.allowedSignersFile` as
 * `[gpg "ssh"] allowedSignersFile`, so a parser that lowercased the whole key produced
 * `gpg.ssh.allowedsignersfile` while the lookup table said `…allowedSignersFile` — and a store that
 * was configured *exactly as instructed* was reported as missing that setting. Found by running the
 * audit against a store configured by the fix commands themselves rather than by hand.
 *
 * The subsection is left verbatim because it can legitimately match a remote or key name, where case
 * carries meaning.
 */
export function normalizeKey(key: string): string {
  const parts = key.split(".");
  if (parts.length < 2) return key.toLowerCase();
  const last = parts.length - 1;
  return parts.map((part, index) => (index === 0 || index === last ? part.toLowerCase() : part)).join(".");
}

/**
 * Parse a gitconfig into dotted keys.
 *
 * Only the syntax `git config` writes is handled, which is the point: this file is written by git,
 * not by hand, in the supported path. A line it cannot parse is skipped rather than guessed at —
 * guessing would let a malformed file report a *healthier* state than it has.
 *
 * `[section "subsection"]` becomes `section.subsection.key`, which is what git does — and it is
 * needed here, because `git config` writes `gpg.ssh.allowedSignersFile` as `[gpg "ssh"]`. A parser
 * that only handled `[section]` would miss that key entirely and report every correctly-configured
 * store as incomplete.
 */
export function parseGitConfig(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let prefix = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      // `[user]`, `[gpg "ssh"]`, or git's whitespace-tolerant `[user "x"]`.
      const match = /^\[([^\]"\s]+)(?:\s+"([^"]*)")?\]$/.exec(line);
      // Section lowercased (case-insensitive), subsection verbatim (case-sensitive), exactly as
      // git compares them.
      prefix =
        match?.[2] !== undefined
          ? `${match[1]!.toLowerCase()}.${match[2]}`
          : (match?.[1]?.toLowerCase() ?? "");
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!match || prefix === "") continue;
    // git keeps any value, including a trailing comment, verbatim. Trailing whitespace is trimmed;
    // nothing else is interpreted, because interpreting it is how a path gets read as "fine".
    values.set(normalizeKey(`${prefix}.${match[1]!}`), match[2]!.trim());
  }
  return values;
}

/** The signing settings, as configured in the agent's own gitconfig. */
export function readSigning(text: string): SigningSettings {
  const values = parseGitConfig(text);
  const signing: SigningSettings = {};
  for (const [key, field] of Object.entries(KEYS)) {
    const value = values.get(key);
    if (value !== undefined && value !== "") signing[field] = value;
  }
  return signing;
}

/** Read an agent's gitconfig and return its signing settings. Never throws. */
export function readSigningFromGitconfig(path: string): SigningSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return readSigning(text);
}

export type SigningState = "ok" | "disabled" | "incomplete" | "misconfigured";

export interface SigningAudit {
  state: SigningState;
  /**
   * One sentence per problem, each naming what is wrong. Several can apply at once, because
   * "signing is off" and "the key points at the host" are independent facts.
   */
  problems: string[];
  /** Whether this store needs the explicit fix at all. */
  needsFix: boolean;
}

/**
 * Is `path` inside `root`?
 *
 * Compared by resolved **segments**, not by string prefix: `/a/agent-other` is not inside `/a/agent`,
 * and a `startsWith` would say it is. That distinction is not hypothetical — it is the exact bug
 * issue #25 had to fix for its sibling-clone case.
 */
export function isInside(root: string, path: string): boolean {
  const from = resolve(root);
  const to = resolve(path);
  if (to === from) return true;
  return to.startsWith(from.endsWith(sep) ? from : from + sep);
}

/**
 * Audit the signing configuration.
 *
 * Ordering is deliberate: **misconfiguration is reported before absence**. A `user.signingkey`
 * pointing at the host's key means the agent is already configured to sign as the user, and telling
 * the reader only that "signing is off" would hide the more serious of the two facts.
 */
export function auditSigning(settings: SigningSettings, root: string): SigningAudit {
  const problems: string[] = [];
  const keyPath = signingKeyPath(root);
  const signersPath = allowedSignersPath(root);

  // --- What is present but wrong. Checked first, because it is the dangerous half. --------------
  let misconfigured = false;
  if (settings.signingKey !== undefined && !isInside(root, settings.signingKey)) {
    misconfigured = true;
    problems.push(
      `user.signingkey is ${settings.signingKey}, which is OUTSIDE the agent root ${root}. ` +
        `ssh takes a key path rather than key contents, so this would sign commits as whoever owns ` +
        `that key — a leak of the user's identity, not a formatting problem.`,
    );
  }
  if (settings.allowedSignersFile !== undefined && !isInside(root, settings.allowedSignersFile)) {
    misconfigured = true;
    problems.push(
      `gpg.ssh.allowedSignersFile is ${settings.allowedSignersFile}, which is outside the agent ` +
        `root ${root}. Verification would consult the host's trust list instead of the agent's.`,
    );
  }
  if (settings.format !== undefined && settings.format !== "ssh") {
    misconfigured = true;
    problems.push(
      `gpg.format is ${JSON.stringify(settings.format)}, not "ssh". The default is openpgp, which ` +
        `looks for a gpg installation the session does not need and may not have.`,
    );
  }
  if (misconfigured) return { state: "misconfigured", problems, needsFix: true };

  // --- What is switched off. ---------------------------------------------------------------------
  //
  // `undefined` counts as off, not as "unknown": git's own default for `commit.gpgsign` is false, so
  // an unset key produces unsigned commits exactly as `= false` does. Treating unset as neutral
  // would report a store that never signs as healthy.
  const disabled =
    !truthy(settings.commitGpgsign) || !truthy(settings.tagGpgsign);
  if (disabled) {
    if (!truthy(settings.commitGpgsign)) problems.push("commit.gpgsign is not true");
    if (!truthy(settings.tagGpgsign)) problems.push("tag.gpgsign is not true");
    return { state: "disabled", problems, needsFix: true };
  }

  // --- What is missing. --------------------------------------------------------------------------
  if (settings.format === undefined) problems.push("gpg.format is unset (must be ssh)");
  if (settings.signingKey === undefined) problems.push(`user.signingkey is unset (must be ${keyPath})`);
  if (settings.allowedSignersFile === undefined) {
    problems.push(`gpg.ssh.allowedSignersFile is unset (must be ${signersPath})`);
  }
  if (problems.length > 0) return { state: "incomplete", problems, needsFix: true };

  return { state: "ok", problems: [], needsFix: false };
}

/** `true` only for git's affirmative spellings. `1`/`yes`/`on` are git's too, so they are honoured. */
function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Does the material signing needs actually exist on disk?
 *
 * Separate from the audit because it answers a different question: an audit of a correctly-written
 * gitconfig that points at a key which is not there is *incomplete config* by text and *missing
 * material* in fact, and the repairs differ. The caller has both facts and can say which.
 */
export function signingMaterial(root: string): { key: boolean; allowedSigners: boolean } {
  return { key: existsSync(signingKeyPath(root)), allowedSigners: existsSync(allowedSignersPath(root)) };
}

/**
 * The exact commands that bring a store into compliance.
 *
 * Returned as data rather than executed. The agent root is user-maintained in `external` ownership,
 * so Pi Central reports and instructs; a person runs these. That ordering is the requirement, not a
 * convenience — see the module comment.
 */
export function signingFixCommands(root: string): string[] {
  return [
    `git config --file ${join(root, "gitconfig")} commit.gpgsign true`,
    `git config --file ${join(root, "gitconfig")} tag.gpgsign true`,
    `git config --file ${join(root, "gitconfig")} gpg.format ssh`,
    `git config --file ${join(root, "gitconfig")} user.signingkey ${signingKeyPath(root)}`,
    `git config --file ${join(root, "gitconfig")} gpg.ssh.allowedSignersFile ${allowedSignersPath(root)}`,
  ];
}
