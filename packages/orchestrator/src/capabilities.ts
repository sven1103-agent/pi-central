/**
 * Can a session actually USE the agent credential store? (issue #28)
 *
 * The failure this exists for, reported from real use inside a sandboxed session:
 *
 *   warning: failed to load config: open /Users/sven1103/.config/gh/config.yml: operation not permitted
 *   failed to create root command: failed to read configuration: operation not permitted
 *
 * That message names a **host** path, so it reads as "the sandbox is blocking my config". The truth
 * was the opposite: the agent's own config was never pointed at, so `gh` fell back to the host's —
 * which the fragment correctly denies — and then refused to start. The deny was working perfectly;
 * the *capability* was dead.
 *
 * The same shape had already happened once, for Pi's `auth.json` (C12): a denied read is
 * indistinguishable from an absent file from inside the session. Both are cases where verifying a
 * deny proved nothing about whether the intended thing worked, and where the diagnosis required
 * reading Safehouse's source.
 *
 * ## The distinction this module is built around
 *
 * "The capability is missing" has two causes with opposite fixes, and conflating them is what makes
 * the original message mislead:
 *
 *   - **not provisioned** — there is nothing there. A setup step: create the file, add the key.
 *   - **provisioned but unreachable** — the thing exists and the session still cannot use it. That
 *     is a **bug in Pi Central** (a policy that fails to grant what the environment points at, or
 *     permissions), not something the user did wrong.
 *
 * Telling a user to "provision" a credential that is already sitting on disk sends them to fix the
 * wrong thing, which is the cost this module is meant to remove.
 *
 * ## What this CAN and CANNOT see
 *
 * It runs in the orchestrator, before the session spawns, so it reasons from facts available there:
 * the store's contents, whether those files are readable by their owner, and **the rendered policy
 * fragment the session will actually run under**. That last one is what makes the reachability
 * check real rather than a guess — the C15 defect was exactly a fragment that did not grant what
 * `GH_CONFIG_DIR` pointed at, and the fragment text is checkable.
 *
 * It does **not** observe the session from the inside. Whether a keychain item resolves, or whether
 * `gh` finds its token, needs a live session — those are asserted by `verify-three.ts` probes, which
 * run a real sandboxed process. This module deliberately claims less than that: it reports what
 * would make the capability unusable, not that the capability works.
 *
 * ## What it never says
 *
 * It does not claim anything about the **host's** credentials being blocked. That is already proven
 * by the fragment and its tests, and conflating the two is precisely how the original bug hid for so
 * long. Every message here names a path inside the agent root, and a test asserts that no message
 * names a host credential path.
 */
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_FILE, type ProviderAuth, type StoreSnapshot } from "./agent-store.ts";
import {
  allowedSignersPath,
  auditSigning,
  readSigning,
  signingKeyPath,
  signingMaterial,
  signingFixCommands,
} from "./signing.ts";
import { readFileSync } from "node:fs";

/**
 * The two causes, plus "fine".
 *
 * `unreachable` means "it is there and the session still could not use it", which is a defect in
 * Pi Central rather than a setup step.
 */
export type CapabilityState = "ok" | "not-provisioned" | "unreachable";

export type CapabilityId = "gitconfig" | "gh-config" | "ssh-key" | "keychain" | "signing";

export interface CapabilityFinding {
  id: CapabilityId;
  state: CapabilityState;
  /**
   * One sentence naming (a) which capability, (b) what is wrong, and (c) what to do or that this is
   * Pi Central's bug. Empty when `state` is `ok`.
   */
  message: string;
}

export interface CapabilityAssessment {
  findings: CapabilityFinding[];
  /** The non-ok findings as warning strings, ready for `LiveSession.warnings`. */
  warnings: string[];
  /** True when everything needed for the session to act as the agent is usable. */
  usable: boolean;
}

export interface CapabilityInput {
  store: StoreSnapshot;
  /**
   * The rendered SBPL fragment the session will run under.
   *
   * Absent in `direct` mode, which applies no policy — so nothing can be *denied* and reachability
   * is not a policy question there. That is why `sandboxed` is separate rather than inferred.
   */
  fragment?: string | undefined;
  /** Whether the session runs under Safehouse. Direct mode has no policy to fail. */
  sandboxed: boolean;
  /** What the provider configuration implies about keychain access (C13). */
  providerAuth: ProviderAuth;
  /** Where the agent keychain would be. */
  keychainPath: string;
}

/** Can this process read the file? Runs at the user's UID, which is what the session inherits for file access. */
function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the fragment grant this path to the session?
 *
 * Deliberately a check on the **rendered policy text** rather than on the inputs that produced it.
 * Re-deriving "the supervisor passed an agentRoot" would be circular — it would pass whenever the
 * caller believed it had done the right thing, which is exactly the belief the C15 defect
 * contradicted. The fragment is the artifact that gets applied, so the fragment is what is checked.
 *
 * SBPL is last-match-wins and the agent's grant is emitted after the host denies, so the presence of
 * an allow is the property to look for. It is matched as a `subpath` grant of the exact root.
 */
function fragmentGrants(fragment: string, path: string): boolean {
  // A `subpath` grant of the root is what covers everything beneath it. Escaped exactly as
  // `renderPolicyFragment` writes it, so the two cannot drift in quoting without this noticing.
  return fragment.includes(`(subpath ${JSON.stringify(path)})`);
}

/** Does the fragment grant the macOS keychain access a service-only provider lookup needs (C13)? */
function fragmentGrantsKeychain(fragment: string): boolean {
  return (
    fragment.includes('(global-name "com.apple.SecurityServer")') &&
    // The search list is load-bearing: without it `security` silently falls back to
    // [login, System], does not see the agent keychain, and every lookup fails with no useful
    // error (C13). A grant without it looks correct and is not.
    //
    // Matched as the RULE, not as a bare substring, and that distinction was found by a test: the
    // generated fragment also *describes* the file in a comment ("The search list lives in
    // com.apple.security.plist"), so a substring check would pass on a fragment whose only mention
    // of the search list is prose. Matching the `(home-literal …)` form is what makes it a check.
    fragment.includes('(home-literal "/Library/Preferences/com.apple.security.plist")')
  );
}

/**
 * Assess what the session will be able to do with the agent credentials.
 *
 * Pure: every input is a fact passed in, so each branch is a test case rather than something that
 * requires a sandbox to observe. Ordering is stable (gitconfig, gh-config, ssh-key, keychain) so the
 * warnings do not shuffle between runs.
 */
export function assessAgentCapabilities(input: CapabilityInput): CapabilityAssessment {
  const { store, fragment, sandboxed, providerAuth, keychainPath } = input;
  const findings: CapabilityFinding[] = [];

  const root = store.root;
  const granted = (path: string): boolean =>
    // In direct mode no policy applies, so the only question is readability — which the checks
    // below answer separately. Returning `true` here keeps "unreachable" meaning "the policy
    // denies it", rather than firing on every direct-mode session.
    !sandboxed || (fragment !== undefined && fragmentGrants(fragment, path));

  // --- gitconfig: the agent's commit identity, via GIT_CONFIG_GLOBAL ---------------------------
  const gitconfigPath = join(root, "gitconfig");
  if (!store.has.gitconfig) {
    findings.push({
      id: "gitconfig",
      state: "not-provisioned",
      message:
        `the agent has no gitconfig at ${gitconfigPath}, which GIT_CONFIG_GLOBAL points at. ` +
        `Commits would have no identity and git would read no agent settings. ` +
        `Provision it (git config --file ${gitconfigPath} user.name …).`,
    });
  } else if (!isReadable(gitconfigPath)) {
    findings.push({
      id: "gitconfig",
      state: "unreachable",
      message:
        `the agent gitconfig exists at ${gitconfigPath} but is not readable by its owner, so no ` +
        `process at this UID can use it. This is a permissions problem, not a missing setup step.`,
    });
  } else if (!granted(root)) {
    findings.push({
      id: "gitconfig",
      state: "unreachable",
      message:
        `the session's policy does not grant ${root}, while GIT_CONFIG_GLOBAL points into it. ` +
        `The agent would be configured to read a file its own sandbox denies — a Pi Central bug, ` +
        `not a setup step.`,
    });
  }

  // --- gh config: GH_CONFIG_DIR ----------------------------------------------------------------
  const ghDir = join(root, "gh");
  if (!store.has.ghConfig) {
    findings.push({
      id: "gh-config",
      state: "not-provisioned",
      message:
        `the agent has no gh config directory at ${ghDir}, which GH_CONFIG_DIR points at. ` +
        `gh would fall back to the host's config, find it denied, and refuse to start. ` +
        `Provision it (gh auth login with GH_CONFIG_DIR set, or copy an existing gh config).`,
    });
  } else if (!granted(root)) {
    findings.push({
      id: "gh-config",
      state: "unreachable",
      message:
        `the session's policy does not grant ${root}, while GH_CONFIG_DIR points into it. ` +
        `gh would read the host's config instead, find that denied, and fail — a Pi Central bug.`,
    });
  } else if (!isReadable(ghDir)) {
    findings.push({
      id: "gh-config",
      state: "unreachable",
      message:
        `the agent gh config directory exists at ${ghDir} but is not readable by its owner, ` +
        `so gh cannot read it. This is a permissions problem, not a missing setup step.`,
    });
  }

  // --- ssh key: needed for SSH push and for signing --------------------------------------------
  if (!store.has.sshKey) {
    findings.push({
      id: "ssh-key",
      state: "not-provisioned",
      message:
        `the agent has no SSH key under ${join(root, "ssh")}. It can still push over HTTPS with its ` +
        `gh token, but not over SSH, and it cannot sign commits. Provision a key to use either.`,
    });
  }

  // --- signing: the configuration, NOT the key (issue #27) --------------------------------------
  //
  // Reported separately from `ssh-key` above, and the separation is the whole point of the issue: the
  // key was present the entire time signing was silently off, so a check that looks for the key
  // cannot see this. This one reads the gitconfig and asserts the settings that make the key DO
  // something.
  //
  // Only when there is a gitconfig at all: with none, `commit.gpgsign` is unset and git does not
  // sign, which is exactly what the `gitconfig` finding above already says. Two findings for one
  // missing file would be noise, and noise trains the reader to ignore warnings.
  if (store.has.gitconfig) {
    const gitconfigPath = join(root, "gitconfig");
    const settings = readSigning(readGitconfigText(gitconfigPath));
    const audit = auditSigning(settings, root);
    // The material, checked separately from the settings: a correct gitconfig pointing at an absent
    // key is *complete config* by text and *broken* in fact, and the repair differs.
    const material = signingMaterial(root);
    if (audit.needsFix) {
      const commands = signingFixCommands(root).map((command) => `    ${command}`).join("\n");
      findings.push({
        id: "signing",
        state: audit.state === "misconfigured" ? "unreachable" : "not-provisioned",
        message:
          `the agent's gitconfig does not sign commits or tags: ${audit.problems.join("; ")}. ` +
          `Commits would be created unsigned, SILENTLY — the key material is present, so nothing ` +
          `else would report a problem (ADR-0010 §4). This is an explicit fix, because the agent ` +
          `root is yours to maintain; Pi Central does not rewrite it:\n${commands}`,
      });
    } else if (!material.key || !material.allowedSigners) {
      findings.push({
        id: "signing",
        state: "not-provisioned",
        message:
          `the agent's gitconfig is configured to sign (gpg.format=ssh, commit.gpgsign=true) but ` +
          `${!material.key ? `the signing key ${signingKeyPath(root)} is missing` : ""}` +
          `${!material.key && !material.allowedSigners ? " and " : ""}` +
          `${!material.allowedSigners ? `the allowed-signers file ${allowedSignersPath(root)} is missing` : ""}. ` +
          `Every commit would fail, rather than be created unsigned.`,
      });
    }
  }

  // --- keychain: only relevant when the provider config needs it (C13) --------------------------
  //
  // Reported only when it MATTERS, and only in sandboxed mode. A session whose provider keys are
  // stored inline needs no keychain, and a DIRECT-mode session has no policy that could deny the
  // lookup — warning there would be noise, and noise trains the reader to ignore warnings.
  if (providerAuth.needsKeychain && sandboxed) {
    if (fragment === undefined) {
      findings.push({
        id: "keychain",
        state: "unreachable",
        message:
          `the provider config at ${providerAuth.path} resolves keys via a command ` +
          `(${providerAuth.commandProviders.join(", ")}), but this sandboxed session has no policy ` +
          `fragment at all. The keychain lookup would fail. This is a Pi Central bug.`,
      });
    } else if (!fragmentGrantsKeychain(fragment)) {
      findings.push({
        id: "keychain",
        state: "unreachable",
        message:
          `the provider config at ${providerAuth.path} resolves keys via a command ` +
          `(${providerAuth.commandProviders.join(", ")}), but the session's policy grants no ` +
          `keychain access. The session would start, report idle, and then be unable to reach a ` +
          `model (C13) — a Pi Central bug, not a setup step.`,
      });
    } else if (store.has.keychain && !isReadable(keychainPath)) {
      findings.push({
        id: "keychain",
        state: "unreachable",
        message:
          `the agent keychain exists at ${keychainPath} but is not readable by its owner. ` +
          `This is a permissions problem, not a missing setup step.`,
      });
    }
  }

  const warnings = findings
    .filter((finding) => finding.state !== "ok")
    .map((finding) => `${label(finding)}: ${finding.message}`);

  return {
    findings,
    warnings,
    usable: findings.every((finding) => finding.state === "ok"),
  };
}

/**
 * The gitconfig's text, or empty.
 *
 * A read failure yields empty text, which audits as "not configured to sign" — the correct reading:
 * if it cannot be read, the session cannot be signed by it either. Returning a *healthy* value here
 * would be the C12/C15 mistake of letting an unreadable file look like a working one.
 */
function readGitconfigText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function label(finding: CapabilityFinding): string {
  const name = {
    gitconfig: "agent git identity",
    "gh-config": "agent GitHub credentials",
    "ssh-key": "agent SSH key",
    keychain: "provider keychain access",
    signing: "agent commit signing",
  }[finding.id];
  const kind = finding.state === "not-provisioned" ? "not provisioned" : "provisioned but unreachable";
  return `${name} ${kind}`;
}

/** The keychain path convention, so callers do not each re-derive it. */
export function agentKeychainPath(agentRoot: string): string {
  return join(agentRoot, KEYCHAIN_FILE);
}
