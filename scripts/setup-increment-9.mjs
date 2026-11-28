#!/usr/bin/env node
/**
 * The Increment 9 backlog: one milestone, ten slices, and the label the taxonomy forgot.
 *
 * Same shape as setup-github.mjs and for the same reasons: a BOOTSTRAP, not a sync. It creates what is
 * missing and skips what exists, so re-running is safe, and once an issue is open it belongs to whoever
 * is working on it. A backlog that can be silently rewritten is not a backlog.
 *
 * Kept separate from setup-github.mjs deliberately. That file defines the tracker's TAXONOMY plus its
 * initial backlog; this one is a single increment's hand-off from docs/INCREMENT-9-PORTABLE.md and
 * docs/USER-STORIES-9.md. Merging them would make every future increment an edit to a file that also
 * defines labels, which is how a bootstrap becomes a sync by accident.
 *
 * Usage:
 *   node scripts/setup-increment-9.mjs --dry-run   # print what would be created
 *   node scripts/setup-increment-9.mjs             # create milestone, label, issues
 */
import { execFileSync } from "node:child_process";

const REPO = "sven1103-agent/pi-central";
const DRY_RUN = process.argv.includes("--dry-run");
const MILESTONE = "Increment 9 — Portable";
const SPIKE = "spikes/platform-independence";

const MILESTONE_DESCRIPTION =
  "A person on Linux can run Pi Central with per-session confinement and an agent-owned credential " +
  "identity, and a person on macOS keeps exactly what they have today. Opened from #303 after a spike " +
  "that measured the question rather than reading about it. No ADR can be written honestly until the " +
  "Linux probe answers, so the decision issue is opened first and closed last. " +
  "See docs/INCREMENT-9-PORTABLE.md.";

/**
 * The labels this increment needs that the existing taxonomy cannot express.
 *
 * A list rather than a single entry, because the second one was discovered the way this kind of
 * omission always is: the script got as far as attaching labels to an issue and failed on
 * "could not add label: area/config not found". One hard-coded special case would have left the
 * next one to the same discovery.
 */
const MISSING_LABELS = [
  ["area/platform", "EC6CB9", "A second operating system, a second sandbox backend, and the boundary between them"],
  ["area/config", "B5D33D", "What ships as a default, and what an installation may change"],
];

/** Every slice states an OUTCOME, ACCEPTANCE CRITERIA that could fail, and EVIDENCE. */
const ISSUES = [
  {
    key: "9-1",
    title: "Decide: is a second sandbox backend worth defining?",
    labels: ["kind/decision", "area/sandbox", "area/platform", "area/docs", "priority/p1"],
    outcome:
      "An ADR exists with one of two statuses, accept or decline, and neither is 'proposed, pending " +
      "more research'. #303's deliverable, closed.",
    criteria: [
      "If it **accepts**, it names the interface: an argv, a policy whose `forbid` wins regardless of " +
        "order, and a statement of which file operations that policy covers.",
      "If it **declines**, it states a measured reason and the specific observation that would change " +
        "the decision, not 'if users ask for it'.",
      "CONSTRAINTS.md C10 and the README's requirements table are corrected to match, because both " +
        "currently name *Safehouse* as the reason and the measured reason is wider.",
      "The spike's five harness scripts are either promoted into CI or explicitly retired with a note " +
        "saying where their evidence now lives.",
    ],
    evidence: "the ADR itself, reviewed. No test can close this one.",
    blocked:
      "Opened first, **closed last**: an ADR naming a backend must cite the Linux probe's and the " +
      "socket probe's measurements. Its status moves in one direction only.",
    doc: "docs/USER-STORIES-9.md#us-p6--the-decision-is-recorded-whichever-way-it-goes",
  },
  {
    key: "9-2",
    title: "Does `pi` start in a Strands Box on Linux?",
    labels: ["kind/slice", "area/sandbox", "area/platform", "area/ci", "verified/measured", "priority/p1"],
    outcome:
      "The one experiment the spike could not run, run. Everything else in this increment depends on " +
      "its answer, and no amount of reading substitutes for it.",
    criteria: [
      "The probe runs on a hosted Linux ARM64 runner, Box's own reference architecture.",
      "The run records architecture, kernel, glibc and whether `unshare(CLONE_NEWUSER)` works, " +
        "**before** it claims anything about `pi`.",
      "Exit status, stdout and stderr of the run are kept in full rather than grepped, because the " +
        "three outcomes are three different findings.",
      "The result is recorded in the spike's RESULT.md with its date, replacing 'unverified here: no " +
        "Linux host'.",
    ],
    evidence: "a workflow run URL with its exit status. The number IS the evidence.",
    notes:
      "The three outcomes must not be conflated: exit 0 means pi started; exit 133 with a V8/errno " +
      "failure means executable memory is still refused; a namespace or sudo error means **the host " +
      "refused the cage and pi was never started**. This spike already confused 'the claim is stale' " +
      "with 'the thing works' once.",
    harness: "harness/linux-probe.yml",
    doc: "spikes/platform-independence/NEXT.md",
  },
  {
    key: "9-3",
    title: "Does a started box confine a unix socket?",
    labels: ["kind/slice", "area/sandbox", "area/platform", "verified/manual", "priority/p1"],
    outcome:
      "The one deny in our fragment with no rule-shaped counterpart is either shown to be replaced by " +
      "the mount view, or recorded as a genuine loss.",
    criteria: [
      "A control run connects to a granted unix socket and the probe run fails to connect to an " +
        "ungranted one, both in the same harness. A check that cannot report a wide-open policy cannot " +
        "report a closed one either.",
      "It is confirmed that `net:connect` has no socket-shaped field, so the finding is about the " +
        "language and not about a rule written wrongly.",
      "The result is stated as either 'the withheld grant is a boundary' or 'the ssh-agent deny is a " +
        "real loss', with no hedging.",
    ],
    evidence:
      "a probe reporting REFUSED beside a control reporting CONNECTED. Needs a Linux host with a plain " +
      "terminal.",
    doc: "spikes/platform-independence/RESULT.md",
  },
  {
    key: "9-4",
    title: "Does the box keep `pi`'s stdio byte-clean for JSONL framing?",
    labels: ["kind/slice", "area/orchestrator", "area/protocol", "area/sandbox", "verified/auto", "priority/p1"],
    outcome:
      "Known whether a session's JSONL framing (C7) survives a wrapper that prints its own notes and " +
      "progress. The highest-risk unknown for a port, and the cheapest to test.",
    criteria: [
      "One RPC frame written to `pi --mode rpc` inside a box produces exactly one parseable JSON line " +
        "on stdout.",
      "Any Box output reaching the workload's stdout is identified, and if present the interleaving is " +
        "described rather than worked around.",
      "The check is scripted, so it is verified/auto rather than a screenshot nobody can re-run.",
    ],
    evidence: "a parse assertion. It needs no model key, which is why it is this cheap.",
    doc: "spikes/platform-independence/RESULT.md",
  },
  {
    key: "9-5",
    title: "The backend interface: argv, an order-independent policy, and what it covers",
    labels: ["kind/slice", "area/orchestrator", "area/sandbox", "area/platform", "verified/auto", "priority/p1"],
    outcome:
      "A session's confinement has one interface, and a second backend can satisfy it without " +
      "changing policy.ts's 'single place a command line is built' guarantee.",
    criteria: [
      "The interface requires a `forbid` to win over a broad `permit` regardless of order, the " +
        "property that removes a real class of defect from our fragment.",
      "The interface states **which file operations its policy covers**, because a rule in Box's " +
        "policy.dw binds only the box's shell and Python while the agent's own file tools follow its " +
        "filesystem lists.",
      "A deliberately weak backend fails the invariant test: a backend that cannot deny a unix socket " +
        "must refuse a deny for one rather than accept and drop it.",
      "sidecar-policy.ts is not silently absorbed into a shared helper that would let one backend " +
        "inherit the other's grants.",
    ],
    evidence: "a type, plus an invariant test that a wrong implementation fails.",
    doc: "docs/INCREMENT-9-PORTABLE.md",
  },
  {
    key: "9-6",
    title: "Retire the keychain, in the right order",
    labels: ["kind/slice", "area/credentials", "area/sandbox", "area/platform", "verified/auto", "priority/p1"],
    outcome:
      "C13's lock-prompt machinery (keychain.ts, 385 lines, 24 tests, Amendment 4) is gone, because a " +
      "route has no lock and therefore no prompt, and no session lost its provider key doing it.",
    criteria: [
      "The provider configuration stops naming a `!security` command-key **before** any keychain code " +
        "is deleted. Measured: `pi` prefers a configured command-key over a route's environment " +
        "variable, so deleting first loses the key silently: the session starts, reports idle, and " +
        "cannot think.",
      "A probe asserts the keychain command is never invoked, so a reintroduced command-key fails CI.",
      "A session still reaches a model after the change, proven by a real call and not by idle.",
      "capabilities.ts's *not provisioned* / *provisioned but unreachable* distinction survives for the " +
        "remaining findings.",
    ],
    evidence:
      "a test that fails if a keychain command runs, plus one live model call (manual for that half).",
    notes:
      "Depends on 9-2: there is no point deleting macOS-only machinery until we know a session runs at " +
      "all on the other platform. See the spike's KEYCHAIN.md for the measurement that fixes the order.",
    doc: "spikes/platform-independence/KEYCHAIN.md",
  },
  {
    key: "9-7",
    title: "The Linux backend, behind the interface",
    labels: ["kind/slice", "area/sandbox", "area/platform", "area/orchestrator", "verified/manual", "priority/p1"],
    outcome:
      "A person on Linux starts a session confined to its working directory, and a path outside it is " +
      "refused by the kernel.",
    criteria: [
      "A session on Linux starts with confinement, and a path outside its working directory is refused " +
        "**with a permissive control run in the same harness** proving the probe can see an open box.",
      "The agent's **own file tools** are confined, not only a shell it starts. A deny written only " +
        "where the box's shell reads it does not satisfy this.",
      "A session on macOS behaves identically to today, asserted by the existing suite rather than a " +
        "reviewer's memory: a Seatbelt profile is still applied, observed rather than assumed.",
      "The known narrowings are recorded, not discovered: exact paths only, no unix-socket deny, and a " +
        "refused path that must exist at launch.",
    ],
    evidence:
      "a live confined session with a refusal demonstrated. Needs a plain terminal on Linux, and this " +
      "repository refuses to fake that.",
    blocked: "Depends on 9-2, 9-3 and 9-5.",
    doc: "spikes/platform-independence/BOUNDARY.md",
  },
  {
    key: "9-8",
    title: "`capabilities.ts` survives its subject",
    labels: ["kind/slice", "area/credentials", "area/orchestrator", "verified/auto", "priority/p2"],
    outcome:
      "The two-way diagnosis that module exists for (not provisioned versus provisioned but " +
      "unreachable) outlives the keychain it was partly written about.",
    criteria: [
      "The keychain finding is removed and the others (gitconfig, gh-config, ssh-key, signing) keep " +
        "their tests.",
      "No message names a host credential path: the existing assertion still holds.",
      "The module's stated limit is still true: it reports what would make a capability unusable, not " +
        "that the capability works.",
    ],
    evidence: "the existing tests, with the keychain arm deleted rather than disabled.",
    doc: "docs/INCREMENT-9-PORTABLE.md",
  },
  {
    key: "9-9",
    title: "A machine says what it is running: the backend and its limits",
    labels: ["kind/slice", "area/orchestrator", "area/ui", "area/platform", "verified/manual", "priority/p2"],
    outcome:
      "A reader can tell which isolation they got and what it does not cover, on either platform, " +
      "without reading a document.",
    criteria: [
      "--check-config names the backend, its mechanism and its stated limits, with the same output " +
        "shape on both platforms, plus a machine-readable form.",
      "The UI never states a stronger guarantee than the backend provides. Where a limit exists it is " +
        "stated where a reader would look. A displayed value that is wrong is a defect (principle 8), " +
        "not a cosmetic issue.",
      "An unsupported platform is refused with a message naming the platform and the reason, not a " +
        "failed spawn.",
      "Anything unknown is labelled unknown rather than assumed healthy.",
    ],
    evidence: "the output, captured on both hosts.",
    doc: "docs/USER-STORIES-9.md#us-p5--i-am-never-surprised-by-which-isolation-i-got",
  },
  {
    key: "9-10",
    title: "The GitHub identity survives the port",
    labels: ["kind/slice", "area/credentials", "area/sandbox", "area/platform", "verified/manual", "priority/p1"],
    outcome:
      "A sandboxed session on either platform can commit as the agent and push over HTTPS, or says in " +
      "one sentence what stopped working.",
    criteria: [
      "A commit pushed as the agent against the real remote succeeds, proven by the push and not by " +
        "reading configuration.",
      "A session whose token is absent says so **before** a push fails, naming the file or route it " +
        "looked for.",
      "Commit signing either works or is reported as not configured, never silently unsigned " +
        "(ADR-0010 Amendment 2).",
      "No route is trusted for a credential it cannot deliver. Measured: the shipped gh pack says a " +
        "route's stand-in is handed to git as a Basic password the box does not swap, so push over " +
        "HTTPS would authenticate as nothing.",
    ],
    evidence: "a real push and a signed commit, or a stated refusal.",
    notes:
      "This slice exists because the story-to-slice map found US-P4 had no slice of its own, and the " +
      "measured finding it rests on is the opposite of what the spike first assumed.",
    doc: "docs/USER-STORIES-9.md#us-p4--my-github-identity-still-works-or-i-am-told-it-does-not",
  },
  {
    key: "9-11",
    title: "The policy is configurable, and only downward",
    labels: ["kind/slice", "area/sandbox", "area/config", "area/platform", "verified/auto", "priority/p1"],
    outcome:
      "One profile named solo ships as data, an installation may narrow it freely, and an overlay that " +
      "would widen it is refused at load rather than merged. docs/POLICY.md carries the design.",
    criteria: [
      "The current deny set is expressed as a shipped profile named solo. The rules do not change, only " +
        "where they live and what they are called.",
      "An installation overlay that ADDS a deny is accepted. One that would widen is REFUSED at load, " +
        "naming the rule, and logged once — not merged and not silently dropped.",
      "A test fails on the permissive side too: an overlay that widens must be refused by a test that " +
        "would pass if the refusal were removed.",
      "Pi Central does not pass --trust-workdir-config, asserted, because a repo must not widen the " +
        "boundary by committing a file and a future caller could reintroduce the flag in one line.",
      "The shipped profile's digest is recorded and compared, so an upgrade that changes it is visible.",
      "The active profile's name appears in the status a machine reports (see 9-9).",
    ],
    evidence:
      "a test where a widening overlay is refused, beside one where a narrowing overlay is accepted.",
    notes:
      "Measured in docs/POLICY.md: Safehouse's own project-level surface takes key=value, not policy " +
      "expressions, so a trusted .safehouse file WIDENS — it granted a path the appended fragment never " +
      "named, three occurrences for one path. Enumerating names is the failure C15c already records.",
    doc: "docs/USER-STORIES-9.md#us-p7--the-policy-is-mine-and-i-may-only-tighten-it",
  },
];

// --- Plumbing -----------------------------------------------------------------------------------

function gh(args) {
  if (DRY_RUN) return "";
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function run(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function milestoneExists() {
  if (DRY_RUN) return false;
  try {
    return run(["api", "repos/" + REPO + "/milestones?state=all", "--paginate", "--jq", ".[].title"])
      .split("\n").map((s) => s.trim()).includes(MILESTONE);
  } catch {
    return false;
  }
}

// `gh label view` does not exist in current gh releases, so the first version of this
// function always returned false and the script re-created an existing label on every run.
// `label list` is the command that actually exists; filter it here rather than relying on a
// subcommand that may or may not be present.
function labelExists(name) {
  if (DRY_RUN) return false;
  try {
    const out = run(["label", "list", "--repo", REPO, "--limit", "200", "--json", "name", "--jq", ".[].name"]);
    return out.split("\n").map((s) => s.trim()).includes(name);
  } catch {
    return false;
  }
}

function issueExists(title) {
  if (DRY_RUN) return false;
  try {
    const out = run(["issue", "list", "--repo", REPO, "--state", "all", "--search", title + " in:title",
                     "--json", "title", "--jq", ".[].title"]);
    return out.split("\n").map((s) => s.trim()).includes(title);
  } catch {
    return false;
  }
}

/** The issue body. Generated, so a criterion lives in one place and cannot drift from the doc. */
function body(issue) {
  const slug = issue.doc;
  const lines = [
    "Part of **" + MILESTONE + "** — [the increment](https://github.com/" + REPO +
      "/blob/main/docs/INCREMENT-9-PORTABLE.md) · [the stories](https://github.com/" + REPO +
      "/blob/main/docs/USER-STORIES-9.md) · [the spike](https://github.com/" + REPO +
      "/tree/main/" + SPIKE + ")",
    "",
    "## Outcome",
    "",
    issue.outcome,
    "",
    "## Acceptance criteria",
    "",
  ];
  for (const c of issue.criteria) lines.push("- [ ] " + c);
  lines.push("", "## Evidence", "", issue.evidence);
  if (issue.blocked) lines.push("", "## Ordering", "", issue.blocked);
  if (issue.notes) lines.push("", "## Why this is here", "", issue.notes);
  if (issue.harness) {
    lines.push("", "## Harness", "",
      "[" + SPIKE + "/" + issue.harness + "](https://github.com/" + REPO + "/blob/main/" + SPIKE +
      "/" + issue.harness + ") — workflow_dispatch only, so it never runs on an ordinary push.");
  }
  lines.push("", "**Background:** [" + slug + "](https://github.com/" + REPO + "/blob/main/" + slug + ")", "",
    "---", "",
    "The deny that binds **the agent's own file tools**, not only a shell it starts, is the property this",
    "increment must not lose. Every slice touching confinement adds a probe that **fails** on a permissive",
    "configuration before it passes on a strict one: a confinement claim with no permissive run beside it",
    "is not evidence.");
  return lines.join("\n");
}

// --- Run ----------------------------------------------------------------------------------------

// --print <key>: render one issue body and exit, so a body can be reviewed before it is created.
const printIndex = process.argv.indexOf("--print");
if (printIndex !== -1) {
  const key = process.argv[printIndex + 1];
  const issue = ISSUES.find((i) => i.key === key);
  if (!issue) {
    console.error("no such slice: " + key + "; known: " + ISSUES.map((i) => i.key).join(", "));
    process.exit(1);
  }
  console.log(body(issue));
  process.exit(0);
}

console.log((DRY_RUN ? "DRY RUN — " : "") + "Increment 9 bootstrap for " + REPO);

for (const [name, color, description] of MISSING_LABELS) {
  if (labelExists(name)) {
    console.log("  label " + name + ": exists");
  } else {
    console.log("  label " + name + ": create");
    gh(["label", "create", name, "--repo", REPO, "--color", color, "--description", description]);
  }
}

if (milestoneExists()) {
  console.log('  milestone "' + MILESTONE + '": exists');
} else {
  console.log('  milestone "' + MILESTONE + '": create');
  gh(["api", "repos/" + REPO + "/milestones", "-X", "POST",
      "-f", "title=" + MILESTONE, "-f", "description=" + MILESTONE_DESCRIPTION]);
}

for (const issue of ISSUES) {
  const title = "[portable] " + issue.title;
  if (issueExists(title)) {
    console.log("  " + issue.key + ": exists");
    continue;
  }
  console.log("  " + issue.key + ": create — " + title);
  const args = ["issue", "create", "--repo", REPO, "--title", title, "--body", body(issue),
                "--milestone", MILESTONE];
  for (const label of issue.labels) args.push("--label", label);
  gh(args);
}

console.log(DRY_RUN ? "\nDry run: nothing was created." : "\nDone. Re-running is safe: existing items are skipped.");
