#!/usr/bin/env node
/**
 * Reproducible definition of the issue tracker: labels, increment milestones, and the initial
 * backlog of slices.
 *
 * This is a **bootstrap** rather than a sync. It creates what is missing and skips what exists, so
 * re-running it is safe. Once issues are open they belong to whoever is working on them — the
 * tracker is not regenerated from this file, because a backlog that can be silently rewritten is
 * not a backlog.
 *
 * Why a script at all: it keeps the taxonomy reviewable and diffable. Adding a label or an
 * increment becomes a pull request instead of a click somebody has to remember.
 *
 * Branch rules are applied from `.github/ruleset.json`, for the same reason: a setting that only
 * exists in a web UI cannot be reviewed, diffed, or restored after someone changes it by accident.
 *
 * Usage:
 *   node scripts/setup-github.mjs            # labels, milestones, issues, branch protection
 *   node scripts/setup-github.mjs --dry-run  # print what would be created
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = "sven1103-agent/pi-central";
const DRY_RUN = process.argv.includes("--dry-run");

function gh(args) {
  if (DRY_RUN && args[0] !== "label" && args[0] !== "issue" && args[0] !== "api") {
    return "";
  }
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// --- Labels ------------------------------------------------------------------------------------
//
// Two axes, deliberately orthogonal: `kind/*` says what a thing IS, `area/*` says WHERE it lives.
// `verified/*` says how "done" will be demonstrated, because "done" is otherwise ambiguous, and
// `increment/*` exists so a slice can be found without knowing which milestone it is in.
//
// The default GitHub labels are removed below when they duplicate these. Two ways to say the same
// thing is how a tracker becomes unqueryable.
const LABELS = [
  // what it is
  ["kind/slice", "1D76DB", "One unit of work, sized to land in a single pull request"],
  ["kind/bug", "D73A4A", "Something the product states or does that is not true"],
  ["kind/decision", "5319E7", "Needs an ADR before code is written"],
  ["kind/chore", "C5DEF5", "Maintenance with no user-visible change"],
  // where it lives
  ["area/orchestrator", "FBCA04", "Session supervision, policy composition, discovery"],
  ["area/ui", "0E8A16", "The React dashboard"],
  ["area/protocol", "006B75", "The orchestrator ↔ UI contract, and the Pi RPC surface"],
  ["area/sandbox", "B60205", "Safehouse profiles and isolation"],
  ["area/credentials", "8B0000", "Agent identity and provider keys"],
  ["area/docs", "BFD4F2", "Specification, decisions, and this repository's own references"],
  ["area/ci", "EDEDED", "Build, tests, and tooling"],
  // how it will be demonstrated
  ["verified/auto", "0E8A16", "Enforced by the test suite; CI fails if it regresses"],
  ["verified/manual", "FBCA04", "Needs a plain terminal or a browser; a human must confirm"],
  ["verified/measured", "D4C5F9", "The issue states a number that must be reproduced"],
  // ordering
  ["priority/p1", "B60205", "Do next"],
  ["priority/p2", "FBCA04", "Valuable, not urgent"],
  ["priority/p3", "FEF2C0", "Nice to have"],
  ["blocked/upstream", "000000", "Waiting on Pi, not on us"],
];

/** Default labels that duplicate the taxonomy above, so they are retired. */
const RETIRE = ["bug", "documentation", "enhancement", "duplicate", "invalid", "wontfix", "question"];

// --- Increments --------------------------------------------------------------------------------
const MILESTONES = [
  {
    title: "Increment 1 — Verified foundation",
    state: "closed",
    description:
      "Delivered as v0.1.0. The isolation premise is proven (12/12), the orchestrator and " +
      "transport work, agent-scoped credentials are live-verified, and the dashboard renders, " +
      "streams, answers approvals, and searches history. See docs/INCREMENTS.md and CHANGELOG.md.",
  },
  {
    title: "Increment 2 — Drive a session from the UI",
    state: "open",
    description:
      "Everything a person does to a running session can be done from the dashboard, without " +
      "falling back to Pi's terminal UI. Ordered after Increment 1 because controls are only " +
      "meaningful once the session state they act on is trustworthy.",
  },
  {
    title: "Increment 3 — Files alongside the session",
    state: "open",
    description:
      "See and touch the files a session is working on, without leaving the dashboard and " +
      "without weakening the sandbox. Constrained by ADR-0007: access at the orchestrator's " +
      "UID, confined to the session's cwd, canonicalized so a symlink cannot escape.",
  },
  {
    title: "Increment 4 — Fleet ergonomics",
    state: "open",
    description: "A fleet of ten sessions should be no harder to run than one.",
  },
  {
    title: "Increment 5 — Hardening",
    state: "open",
    description:
      "The isolation claims are demonstrated against a session that is actively trying to " +
      "escape, rather than asserted.",
  },
];

// --- The backlog -------------------------------------------------------------------------------
//
// Every issue states an OUTCOME (what becomes true), ACCEPTANCE CRITERIA that could fail,
// EVIDENCE (how it will be shown), and the GOVERNING CONSTRAINT where one applies. A slice whose
// criteria nothing could falsify is not a slice.
const ISSUES = [
  // ===== Increment 2 =====================================================================
  {
    title: "Model picker: change a session's model from the header",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/slice", "area/ui", "area/protocol", "verified/manual", "priority/p1"],
    body: `## Outcome
The model shown in a session's header can be changed from the dashboard, and Pi confirms it.

## Acceptance criteria
- [ ] The picker lists models from \`get_available_models\`, grouped by provider, and marks the current one.
- [ ] Choosing a model sends \`set_model\` and the header reflects the value Pi reports back — not an optimistic guess.
- [ ] A change that Pi refuses surfaces as an error naming the reason, never as a silent no-op.
- [ ] The rail's model column agrees with the header afterwards (one value, one place it comes from).
- [ ] While a run is streaming, the control says what will happen rather than pretending it is immediate.

## Evidence
Manual: change the model in a live session, then confirm the rail and header both show the new one and that the next turn used it. Automated: a transport test that a \`setModel\` control reaches the supervisor and a refusal is broadcast as an error.

## Constraints
\`Control\` is a **closed union** (packages/protocol/src/envelopes.ts) — this needs a new variant plus a supervisor method. \`rpc.send\` takes the closed \`Command\` union, so a mistyped command is a compile error rather than a runtime no-op.`,
  },
  {
    title: "Thinking-level picker, constrained by the selected model",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/slice", "area/ui", "area/protocol", "verified/manual", "priority/p2"],
    body: `## Outcome
A session's thinking level can be changed from the UI, and the UI only offers levels the current model actually supports.

## Acceptance criteria
- [ ] Levels come from \`get_available_thinking_levels\` for the **current** model, not a hardcoded list.
- [ ] Changing the model re-reads the available levels, so a level that no longer exists cannot be selected.
- [ ] \`thinking_level_changed\` events update the rail without a manual refresh.
- [ ] The rail's truncated three-character form keeps working (\`med\`, \`high\`, \`off\`).

## Evidence
Manual: switch to a model with fewer levels and confirm the picker narrows. Automated: a reducer test that a \`thinking_level_changed\` record updates the session.

## Constraints
Blocked on the same \`Control\` addition as the model picker; sequence them together or land this second.`,
  },
  {
    title: "Steer and clear_queue: make the composer's mode strip real",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/slice", "area/protocol", "area/ui", "verified/manual", "priority/p1"],
    body: `## Outcome
A message sent mid-run can be **steered** into the current turn, and Esc stops the run while returning the queued text to the composer instead of discarding it.

## Acceptance criteria
- [ ] \`steer\` and \`clear_queue\` exist in the \`Control\` union and reach Pi via the closed \`Command\` union.
- [ ] Steer is delivered after the current turn's tools finish; a follow-up still queues for afterwards.
- [ ] The mode strip appears **only** while a run is in progress, and states which of the two will happen.
- [ ] Esc clears the queue, aborts, and restores the cleared text to the composer.
- [ ] The interim copy is removed: the hint currently says "Steer is not available in this build".

## Evidence
Manual: send a steer mid-run and confirm Pi delivers it at the documented point. Automated: the store selects \`steer\` over \`followUp\` exactly when \`state === "streaming"\`.

## Constraints
This is the one place where the UI currently documents a **missing capability on purpose**. The composer says steer is unavailable rather than showing a disabled control, because a button that cannot work is worse than its absence. Keep that property until the capability is real.`,
  },
  {
    title: "Syntax highlighting with lazily loaded Shiki grammars",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/slice", "area/ui", "verified/measured", "priority/p2"],
    body: `## Outcome
Fenced code in a transcript is syntax-highlighted, and the cost of doing so is measured rather than assumed.

## Acceptance criteria
- [ ] Grammars load on first encounter of a language, not up front.
- [ ] An unknown language falls back to plain text rather than rendering nothing.
- [ ] Bundle impact is measured and stated in this issue before and after (Shiki is roughly 200 kB).
- [ ] Highlighting survives the sanitisation boundary: output is React elements or passes through DOMPurify — never raw HTML injected around ADR-0006's single insertion point.
- [ ] \`test/invariants.test.ts\` still finds exactly **one** \`dangerouslySetInnerHTML\` site.

## Evidence
Measured: \`npm run ui:build\` output size, before and after. Automated: the existing invariant test must keep passing.

## Constraints
ADR-0006. The order \`markdown-it({html:false}) → DOMPurify → React\` is the safety property, and a highlighter is the most likely thing to be bolted on in front of it.`,
  },
  {
    title: "Compaction and retry banners",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/slice", "area/ui", "verified/manual", "priority/p2"],
    body: `## Outcome
A session that is compacting, retrying, or recovering from a provider failure says so, instead of appearing to stall.

## Acceptance criteria
- [ ] \`compaction_start\` / \`compaction_end\` render as a banner, and the context meter reflects the drop.
- [ ] \`auto_retry_start\` / \`auto_retry_end\` render as a retry banner including the attempt number.
- [ ] \`summarization_retry_*\` is surfaced rather than silently swallowed.
- [ ] No banner is a live region that announces per delta (see DESIGN.md §9).
- [ ] A banner never claims completion: \`agent_end\` is not \`agent_settled\` (C8).

## Evidence
Manual: force a provider failure and confirm the retry is visible. Automated: reducer tests that each record type produces the expected banner state and does not move the session out of \`streaming\`.`,
  },
  {
    title: "A way back to the latest message when the transcript is scrolled up",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/slice", "area/ui", "verified/manual", "priority/p2"],
    body: `## Outcome
Auto-follow stops when the reader scrolls up — that is correct — but there is currently no way to resume following except scrolling to the bottom by hand, which with a fast provider can be hundreds of turns.

## Acceptance criteria
- [ ] A "jump to latest" control appears only while the view is unpinned from the bottom.
- [ ] Activating it scrolls to the newest content **and** re-enables following.
- [ ] It does not appear, or does nothing, when already at the bottom.
- [ ] It is reachable by keyboard, and does not steal focus from the composer.

## Evidence
Manual: scroll up during a run, confirm the control appears, activate it, confirm following resumes as further messages arrive.`,
  },
  {
    title: "Capture real UI screenshots for the README",
    milestone: "Increment 2 — Drive a session from the UI",
    labels: ["kind/chore", "area/docs", "verified/manual", "priority/p3"],
    body: `## Outcome
The README shows the product. It currently describes it in prose and ASCII only, because the author's environment cannot launch a browser (C1: Chromium refuses to bind its profile socket inside the sandbox).

## Acceptance criteria
- [ ] At least: the rail with several live sessions, a streaming transcript with the tool trace open, and a pending approval dialog.
- [ ] Images live under \`docs/images/\` with descriptive names — not committed to the repository root.
- [ ] Each is referenced from the README, and \`npm run check:docs\` passes.
- [ ] The screenshots match the shipped UI, including the corrected values.

## Evidence
Manual, and **must** be done from a plain terminal: \`npm run server\` plus \`npm run ui:dev\`, then capture.

## Constraints
C1. This is a \`verified/manual\` slice by nature, and worth doing: several of this project's most valuable findings came from looking at a screenshot after every automated check had passed.`,
  },

  // ===== Increment 3 =====================================================================
  {
    title: "Read-only file tree, confined to the session's working directory",
    milestone: "Increment 3 — Files alongside the session",
    labels: ["kind/slice", "area/orchestrator", "area/ui", "verified/auto", "priority/p1"],
    body: `## Outcome
The focused session's working directory can be browsed in the dashboard, and nothing outside it can be reached.

## Acceptance criteria
- [ ] Entries are read at the **orchestrator's UID**, directly — no sandbox sidecar (ADR-0007).
- [ ] Every path is canonicalized with \`realpath\` and then verified to be inside \`cwd\`. A \`..\` segment and a symlink pointing outward are both refused.
- [ ] Directories expand lazily; hidden files are hidden behind a toggle.
- [ ] A file above the size cap is not read, and says so rather than truncating silently.
- [ ] Binary files are detected and refused, not rendered as replacement characters.
- [ ] Permission errors report the **error code**, not a guess. (A permission failure was once reported as a missing directory — see C14's neighbourhood.)

## Evidence
Automated, and each criterion is a test that must FAIL if the check is removed: \`..\` escape refused, symlink escape refused, oversized refused, binary refused, unreadable reported as unreadable.

## Constraints
ADR-0007, and the trust boundary: this reads the user's files at the user's privileges, so containment is the whole feature.`,
  },
  {
    title: "File preview: read-only, with binary and size refusal",
    milestone: "Increment 3 — Files alongside the session",
    labels: ["kind/slice", "area/ui", "verified/auto", "priority/p2"],
    body: `## Outcome
A file in the tree can be opened and read in the dashboard.

## Acceptance criteria
- [ ] Content renders as inert text; a file containing markup is shown, not interpreted (ADR-0006).
- [ ] Text files render with line numbers; large files render lazily or with a stated cap.
- [ ] A binary file is reported as binary with its size and type, and is not attempted.
- [ ] A file deleted between listing and opening reports that, rather than showing an empty pane.
- [ ] Nothing is editable — Pi mutates file contents from inside its sandbox.

## Evidence
Automated: the sanitisation invariant still finds one insertion point; a test that markup in a file is escaped. Manual: open a real source file and a real binary.`,
  },
  {
    title: "File operations: create, rename, move, delete — each guarded",
    milestone: "Increment 3 — Files alongside the session",
    labels: ["kind/slice", "area/orchestrator", "area/ui", "verified/manual", "priority/p2"],
    body: `## Outcome
Files can be organised from the dashboard, with destructive actions confirmed rather than assumed.

## Acceptance criteria
- [ ] Create file, create directory, rename, move, delete.
- [ ] Non-destructive operations are immediate; destructive ones are confirmed, and a recursive delete states how many entries it will remove.
- [ ] Every operation is validated against \`cwd\` by the SAME canonicalization as reads — not a second, weaker check.
- [ ] A refusal names the reason and the offending path.
- [ ] No operation runs through a shell or through Pi; Pi Central acts at the user's UID (ADR-0007).

## Evidence
Manual: perform each operation, including a refused escape. Automated: the containment tests from the read path are reused, not duplicated — a second implementation is a second chance to get it wrong.

## Constraints
ADR-0007. Destructive operations are the reason the confirmation copy in DESIGN.md exists.`,
  },

  // ===== Increment 4 =====================================================================
  {
    title: "Retry a failed session from the rail",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/bug", "area/ui", "verified/manual", "priority/p1"],
    body: `## Outcome
A session that failed to start can be retried without starting a new one by hand.

## What is true today
A failed session shows its error and offers only "Stop session". DESIGN.md specifies the composer saying "This session failed to start. Retry it from the rail." — and the rail has no such control. The documented affordance does not exist.

## Acceptance criteria
- [ ] A failed session offers a retry that re-spawns with the same cwd and mode.
- [ ] The retry is explicit. There is **no** silent auto-restart — a crash loop must not be hidden.
- [ ] The previous failure's stderr remains visible after the retry, so a second attempt does not erase the evidence of the first.
- [ ] A retry of a session whose directory has since vanished is refused before spawning, with the reason.

## Evidence
Manual: kill a session's process externally, confirm the failure is shown, then retry. Automated: a store test that a failed session exposes a retry action.

## Constraints
C1's failure mode is the common cause here — a session spawned while Pi Central was itself sandboxed fails with EPERM. The retry must not blame the user for a misinvocation that has not changed.`,
  },
  {
    title: "Fork and clone a session from the rail",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/slice", "area/ui", "area/protocol", "verified/manual", "priority/p2"],
    body: `## Outcome
A conversation can be branched: continue from an earlier point without discarding what came after.

## Acceptance criteria
- [ ] Fork from a chosen entry; clone duplicates the active branch.
- [ ] The new session is visibly a branch of its parent, so two sessions sharing history are never confused.
- [ ] The fork records the SAME working directory — Pi Central never retargets a session (ADR-0008).
- [ ] \`get_fork_messages\` drives which entries are offered.

## Evidence
Manual: fork at an earlier entry, send a different prompt, confirm the original is unaffected. Automated: a protocol test for the \`fork\` control.

## Constraints
ADR-0004 (session identity) and ADR-0008 (no mid-session directory change).`,
  },
  {
    title: "Bulk fleet view: what is streaming, blocked, or nearly out of context",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/slice", "area/ui", "verified/manual", "priority/p2"],
    body: `## Outcome
With ten sessions, the question "which one needs me?" is answered without reading ten rows.

## Acceptance criteria
- [ ] Counts for streaming, awaiting approval, and failed are visible at once.
- [ ] A session above a context threshold is marked, using a word as well as a colour (never colour alone).
- [ ] Grouping by attention is preserved from the rail; this adds signal rather than reordering.
- [ ] The counts are derived from session state, and a test asserts each label matches its number. (An earlier version labelled the session count as "running", so two idle sessions read "2 running".)

## Evidence
Manual: run several sessions into different states and confirm the summary. Automated: \`fleetCounts\` tests already exist and must extend to any new counter.`,
  },
  {
    title: "Export a session as HTML",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/slice", "area/orchestrator", "verified/manual", "priority/p3"],
    body: `## Outcome
A session can be exported for reading or sharing outside the dashboard, via Pi's \`export_html\`.

## Acceptance criteria
- [ ] The export is requested through Pi, not re-implemented by Pi Central.
- [ ] The file lands somewhere the user chooses, and the path is reported.
- [ ] The exported content is not rendered by Pi Central's UI; it is a file on disk.
- [ ] A failed export reports the reason.

## Evidence
Manual: export a session and open the result in a browser.

## Constraints
Principle: Pi is the source of truth. Re-implementing export would fork session semantics.`,
  },
  {
    title: "Persist UI state across reloads: drafts, focus, and layout toggles",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/slice", "area/ui", "verified/manual", "priority/p2"],
    body: `## Outcome
Reloading the page does not lose what you were doing.

## Acceptance criteria
- [ ] Per-session composer drafts survive a reload. (Today they are in-memory and a reload discards them — the one keystroke the design promises never to lose, lost to F5.)
- [ ] The focused session survives a reload.
- [ ] The tool trace collapse state and the marker toggle survive.
- [ ] Nothing sensitive is persisted: drafts are text the user typed and are documented as such, but no credentials or tool output are stored.
- [ ] A cleared or sent draft is not resurrected.

## Evidence
Manual: type into a draft, reload, confirm it is still there. Automated: the persistence layer round-trips a known shape and refuses unknown keys.

## Constraints
Q7 in docs/OPEN-QUESTIONS.md is the open decision on how Pi Central persists its own state. Resolve it in an ADR before implementing.`,
  },
  {
    title: "Jump-to-session palette (⌘K)",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/slice", "area/ui", "verified/manual", "priority/p3"],
    body: `## Outcome
Any live session can be focused by typing part of its name or path, without hunting the rail.

## Acceptance criteria
- [ ] \`⌘K\` opens a searchable list of live sessions.
- [ ] Typing filters by name, working directory, and id.
- [ ] Enter focuses the selection; Escape closes without changing focus.
- [ ] It reuses the same search ranking as history, rather than a second implementation.
- [ ] The rail remains the primary navigation; this is a shortcut for people who want one.

## Evidence
Manual: open, filter, select, and confirm focus moved and the rail selection followed.`,
  },

  // ===== Increment 5 =====================================================================
  {
    title: "Adversarial isolation tests: prove the boundary against content that tries to escape",
    milestone: "Increment 5 — Hardening",
    labels: ["kind/slice", "area/sandbox", "verified/manual", "priority/p1"],
    body: `## Outcome
The isolation claims are demonstrated against a session that is actively trying to reach outside its sandbox, rather than asserted from a policy diff.

## Acceptance criteria
- [ ] A session attempts: reading a sibling session's workdir, writing into it, listing it, reaching \`$HOME\`, reading the host \`.gitconfig\`, reaching the ssh-agent, and reading the login keychain.
- [ ] Each attempt is denied, **and each denial has a falsifier** — the probe plants a known value in the parent so that "absent" is evidence rather than a tautology.
- [ ] Attempts to escape via \`..\`, a symlink, and a hardlink are all denied.
- [ ] The results are recorded as evidence on this issue, not only as a passing test.

## Evidence
Manual: \`node packages/orchestrator/verify-three.ts\` from a plain terminal (C1). Its cross-directory probes and planted-secret boundary checks are the basis; this slice extends them rather than starting again.

## Constraints
C1 (must run unsandboxed), C4a (Safehouse's allowlist is not a boundary), C6 (\`~/.pi\` is readable and writable from every session).`,
  },
  {
    title: "Explicit loopback access check before binding",
    milestone: "Increment 5 — Hardening",
    labels: ["kind/slice", "area/orchestrator", "area/sandbox", "verified/auto", "priority/p1"],
    body: `## Outcome
The transport's promise that it is local-only is enforced, not merely configured.

## What is true today
The server binds \`127.0.0.1\` and caps concurrent clients. It does not check an Origin header, and it has no way for a user to see who is connected.

## Acceptance criteria
- [ ] Binding is loopback-only and a test asserts the bound address.
- [ ] C5 is stated in the code: loopback is **not** a boundary — any local process can connect — so the socket grants exactly the orchestrator's privileges.
- [ ] A browser Origin that is not the UI's own is refused. A page on another origin can otherwise reach a loopback WebSocket.
- [ ] Connected clients are visible somewhere, and the cap is configurable.

## Evidence
Automated: a connection from a foreign Origin is refused; the cap test already exists.

## Constraints
C5. ADR-0006 depends on \`connect-src 'self'\` being truthful, and that guarantee is weaker than it looks while any origin can open the socket.`,
  },
  {
    title: "Fuzz the policy composer",
    milestone: "Increment 5 — Hardening",
    labels: ["kind/slice", "area/sandbox", "verified/auto", "priority/p2"],
    body: `## Outcome
The Safehouse profile composer cannot be induced to emit a profile that grants more than the session's working directory.

## Acceptance criteria
- [ ] Property test: for any workdir, the emitted fragment grants that directory and no sibling — checked by parsing the composed profile, not by string matching.
- [ ] Adversarial paths (\`..\`, trailing slashes, symlinked parents, unicode, spaces, quotes) produce either a correct profile or a refusal, never a broader one.
- [ ] The single-argv-site invariant still holds: exactly one module assembles safehouse's command line.
- [ ] The agent-root grants are covered: the agent's own credentials are reachable, and the host's are not.

## Evidence
Automated property tests with a fixed seed, plus the existing invariant tests.

## Constraints
C1, C4a. The policy composer is the only thing standing between a workdir and the rest of the disk.`,
  },

  // ===== Decisions ======================================================================
  {
    title: "Approval policy when nobody is watching",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/decision", "area/orchestrator", "priority/p2"],
    body: `## The question
A session emits a blocking \`confirm\` and no human is at the dashboard. What should happen — leave it blocked indefinitely, time out with a default, or refuse to start sessions that will need unsupervised approval?

## Options and consequences
- **Block indefinitely.** Nothing is ever approved by accident. One forgotten session holds a process and a working directory open, possibly for days.
- **Timeout with a default.** Sessions keep moving. A default of "allow" means unattended runs answer yes to questions a human should have seen; a default of "deny" is safe but silently changes behaviour.
- **Refuse unattended sessions.** Honest and safe. It also removes the main reason to leave a dashboard open.

## Constraints
C8 (\`agent_end\` is not completion), and the design's position that \`awaiting-approval\` is a first-class state. Pi auto-resolves a dialog when the request carries a \`timeout\`, so "timeout" may not be entirely Pi Central's decision to make.

## What would prove this wrong
If every blocking dialog in practice carries a \`timeout\`, the middle option is not a choice at all and the ADR should say so. Check the real requests before deciding.

## Evidence
Q6 in docs/OPEN-QUESTIONS.md. Answer with an ADR.`,
  },
  {
    title: "How much history to load, and what the total means",
    milestone: "Increment 4 — Fleet ergonomics",
    labels: ["kind/decision", "area/orchestrator", "verified/measured", "priority/p2"],
    body: `## The question
Discovery caps at 500 sessions and reports the true total separately. This machine has 833. What should the defaults be, and what does the UI promise about search?

## Options and consequences
- **Raise the cap.** Search covers more; discovery cost grows with it (measured: ~900 ms for 833 sessions).
- **Keep the cap, state it.** Search covers the newest 500 and says so — the current behaviour. A user can be misled into thinking a term is absent when it is merely old.
- **Index on disk.** Full search over everything, at the cost of a cache Pi Central must keep valid.

## Constraints
Q4 in docs/OPEN-QUESTIONS.md. Discovery reads Pi's session files directly (ADR-0009), so cost is real and grows.

## What would prove this wrong
Measure discovery at 2000 sessions before choosing. If it stays sub-second, the simplest option wins and the ADR is short.

## Evidence
\`verified/measured\`: state discovery duration at the current count and at a larger synthetic count. The History pane currently says "searching the 500 most recent of 833", which must remain true whatever is decided.`,
  },
];

// --- Run ---------------------------------------------------------------------------------------

function existingIssueTitles() {
  const raw = execFileSync(
    "gh",
    ["issue", "list", "--repo", REPO, "--state", "all", "--limit", "200", "--json", "title"],
    { encoding: "utf8" },
  );
  return new Set(JSON.parse(raw).map((issue) => issue.title));
}

function existingMilestones() {
  const raw = execFileSync(
    "gh",
    ["api", `repos/${REPO}/milestones?state=all&per_page=100`, "--jq", ".[].title"],
    { encoding: "utf8" },
  );
  return new Set(raw.split("\n").filter(Boolean));
}

/**
 * Apply the branch ruleset from the checked-in config.
 *
 * A **ruleset** rather than a classic branch-protection rule: rulesets support named bypass
 * actors, layer with one another, and — the reason this repository migrated — are the mechanism
 * GitHub's own `GET /repos/{owner}/{repo}/rules/branches/{branch}` endpoint reports. Classic
 * protection does not appear there at all, so a correctly protected branch reads as "no rules"
 * to anyone checking the modern way. That asymmetry is worth avoiding.
 *
 * Two failure modes are guarded, both silent:
 *
 *   1. A required check name that no workflow produces. Nothing errors; every merge is blocked
 *      forever with a message about a check that never runs. Validated against real check runs.
 *   2. Applying a ruleset in `evaluate` mode, which reports as configured while enforcing
 *      nothing. `active` is asserted rather than trusted.
 *
 * Idempotent: an existing ruleset of the same name is updated in place, so re-running after an
 * edit does not produce a second, competing ruleset.
 */
function applyRuleset() {
  const config = JSON.parse(readFileSync(new URL("../.github/ruleset.json", import.meta.url), "utf8"));
  console.log("\nBranch ruleset");

  if (config.enforcement !== "active") {
    console.error(`  REFUSING: enforcement is "${config.enforcement}", which reports as configured`);
    console.error("  while enforcing nothing. Only \"active\" actually protects the branch.");
    process.exit(1);
  }

  const statusRule = config.rules.find((rule) => rule.type === "required_status_checks");
  const contexts = statusRule?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const actual = new Set(
    JSON.parse(
      execFileSync("gh", ["api", `repos/${REPO}/commits/${head}/check-runs`], { encoding: "utf8" }),
    ).check_runs.map((run) => run.name),
  );
  for (const context of contexts) {
    if (!actual.has(context)) {
      console.error(`  REFUSING: required check "${context}" is not produced by this repository.`);
      console.error(`  Available now: ${[...actual].join(", ")}`);
      console.error("  Applying this would block every merge permanently.");
      process.exit(1);
    }
  }
  console.log(`  required checks match real check runs: ${contexts.join(", ")}`);

  if (DRY_RUN) {
    console.log(`  would apply ruleset "${config.name}" (${config.rules.length} rules)`);
    return;
  }

  const existing = JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/rulesets`], { encoding: "utf8" }))
    .find((ruleset) => ruleset.name === config.name);

  const result = existing
    ? execFileSync("gh", ["api", "-X", "PUT", `repos/${REPO}/rulesets/${existing.id}`, "--input", "-"], { input: JSON.stringify(config), encoding: "utf8" })
    : execFileSync("gh", ["api", "-X", "POST", `repos/${REPO}/rulesets`, "--input", "-"], { input: JSON.stringify(config), encoding: "utf8" });
  const applied = JSON.parse(result);
  console.log(`  ${existing ? "updated" : "created"} ruleset "${applied.name}" (id ${applied.id}, ${applied.enforcement})`);
}

function main() {
  console.log(DRY_RUN ? "DRY RUN — nothing will be created\n" : `Setting up ${REPO}\n`);

  // Labels. `--force` updates in place, so changing a colour or description is idempotent.
  console.log(`Labels (${LABELS.length})`);
  for (const [name, color, description] of LABELS) {
    if (DRY_RUN) {
      console.log(`  would ensure ${name}`);
      continue;
    }
    gh(["label", "create", name, "--repo", REPO, "--color", color, "--description", description, "--force"]);
  }
  for (const name of RETIRE) {
    if (DRY_RUN) {
      console.log(`  would retire ${name}`);
      continue;
    }
    try {
      gh(["label", "delete", name, "--repo", REPO, "--yes"]);
      console.log(`  retired duplicate default label ${name}`);
    } catch {
      // Already gone is the desired end state.
    }
  }

  // Milestones (increments).
  const milestones = DRY_RUN ? new Set() : existingMilestones();
  console.log(`\nIncrements (${MILESTONES.length})`);
  for (const milestone of MILESTONES) {
    if (milestones.has(milestone.title)) {
      console.log(`  exists  ${milestone.title}`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would create ${milestone.title}`);
      continue;
    }
    gh([
      "api", `repos/${REPO}/milestones`,
      "-f", `title=${milestone.title}`,
      "-f", `description=${milestone.description}`,
      "-f", `state=${milestone.state}`,
    ]);
    console.log(`  created ${milestone.title}${milestone.state === "closed" ? " (closed)" : ""}`);
  }

  // Issues.
  const titles = DRY_RUN ? new Set() : existingIssueTitles();
  console.log(`\nSlices (${ISSUES.length})`);
  let created = 0;
  for (const issue of ISSUES) {
    if (titles.has(issue.title)) {
      console.log(`  exists  ${issue.title}`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would create [${issue.milestone}] ${issue.title}`);
      continue;
    }
    const args = ["issue", "create", "--repo", REPO, "--title", issue.title, "--body", issue.body, "--milestone", issue.milestone];
    for (const label of issue.labels) args.push("--label", label);
    const url = gh(args).trim();
    created += 1;
    console.log(`  created ${url.split("/").pop()}  ${issue.title}`);
  }

  console.log(`\n${created} issue(s) created, ${ISSUES.length - created} already present.`);

  applyRuleset();
}

main();
