/**
 * Architectural invariants for the UI.
 *
 * These are not style preferences. Each one guards a decision that is easy to erode by a
 * later, locally reasonable change — and the erosion would not show up in a functional test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * Strip comments before scanning.
 *
 * This is not tidiness. The first version scanned raw text and failed on files whose COMMENTS
 * discuss the very rule being checked — `markdown.ts` names `dangerouslySetInnerHTML` while
 * explaining why only one site may use it, and names `switch_session` while describing what
 * script in this origin could reach. A rule that its own rationale violates is a broken rule,
 * so the check reads code only.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const files = walk(SRC);
const sources = files
  .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
  .map((file) => ({
    file: file.slice(SRC.length),
    raw: readFileSync(file, "utf8"),
    text: stripComments(readFileSync(file, "utf8")),
  }));

// --- ADR-0006: one sanitized insertion point -------------------------------------------------

test("dangerouslySetInnerHTML appears in exactly one file: the sanitized site", () => {
  // ADR-0006's rule is "no dangerouslySetInnerHTML outside the single sanitized merge point".
  // Counting it is what makes that enforceable: a second occurrence is either a mistake or a
  // deliberate change to the security model, and both should fail this test rather than ship.
  const offenders = sources.filter(({ text }) => text.includes("dangerouslySetInnerHTML"));
  assert.deepEqual(
    offenders.map(({ file }) => file).sort(),
    ["/components/Prose.tsx"],
    `Unsanitized HTML insertion found. Only Prose.tsx may use it, and only with renderMarkdown()'s output. Found: ${offenders
      .map(({ file }) => file)
      .join(", ")}`,
  );
});

test("the one insertion site uses the sanitizing pipeline, not raw Markdown", () => {
  // `md.render` directly would skip DOMPurify; `renderPlain` would not produce HTML at all.
  const prose = sources.find(({ file }) => file === "/components/Prose.tsx");
  assert.ok(prose, "Prose.tsx must exist");
  assert.ok(prose.raw.includes("renderMarkdown"), "the insertion site must call renderMarkdown");
  assert.ok(!/MarkdownIt\(|new MarkdownIt/.test(prose.text), "markdown-it must not be constructed outside markdown.ts");
});

test("markdown-it is configured with html:false, the load-bearing setting", () => {
  const module = sources.find(({ file }) => file === "/markdown.ts");
  assert.ok(module, "markdown.ts must exist");
  assert.ok(/html:\s*false/.test(module.raw), "html:false must be set; it is the first line of defence");
});

test("DOMPurify is applied after markdown rendering, never before", () => {
  // The ORDER is the safety property: sanitizing input and then rendering Markdown would let
  // markdown-it regenerate markup from the sanitized text.
  const module = sources.find(({ file }) => file === "/markdown.ts")!;
  assert.ok(/sanitize\(\s*md\.render\(/.test(module.text), "expected sanitize(md.render(source)) in that order");
});

// --- The trust boundary: no control from untrusted content -----------------------------------

test("no component constructs a Control from rendered content", () => {
  // A Control built from displayed text would let model output drive the orchestrator. The
  // kinds are enumerated here so a new one is noticed rather than silently permitted.
  const controlKinds = ["prompt", "abort", "stop", "rename", "answerDialog", "resume", "start", "list"];
  for (const { file, text } of sources) {
    if (file === "/App.tsx") continue; // the single place controls are assembled
    for (const kind of controlKinds) {
      assert.ok(
        !new RegExp(`kind:\\s*"${kind}"`).test(text),
        `${file} builds a "${kind}" control; only App.tsx should`,
      );
    }
  }
});

// --- C8: the UI must not have its own completion logic ---------------------------------------

test("the UI never treats agent_end as completion", () => {
  // `agent_end` closes a low-level run; retries, compaction recovery, steering and follow-ups
  // can all continue (C8). `state` must come from the orchestrator, which is the single place
  // that decision is made.
  for (const { file, text } of sources) {
    if (file.startsWith("/test")) continue;
    if (file === "/transcript.ts") continue; // it explicitly does NOT, with a test proving it
    assert.ok(
      !/agent_end\s*\)/.test(text),
      `${file} appears to switch on agent_end; state must come from the orchestrator (C8)`,
    );
  }
});

// --- Untrusted content is never rendered as Markdown ------------------------------------------

test("tool output is not run through the Markdown pipeline", () => {
  // Tool output is data, not prose: a diff containing `*` or `_` would be reinterpreted and the
  // user would see something other than what the command produced.
  //
  // The guard follows the responsibility: this used to point at `ToolFrame.tsx`, which the trace
  // window replaced. A test aimed at a deleted file would have silently stopped protecting
  // anything, which is worse than no test.
  const trace = sources.find(({ file }) => file === "/components/ToolTrace.tsx");
  assert.ok(trace, "ToolTrace.tsx must exist — it is the only place tool output renders");
  assert.ok(!trace.text.includes("renderMarkdown"), "tool output must not be rendered as Markdown");
  assert.ok(!trace.raw.includes("dangerouslySetInnerHTML"), "tool output must be escaped text");
});

test("the transcript does NOT append the whole tool list after the conversation", () => {
  // The reported bug. Tools are a trace and belong in the trace window; rendering them after
  // every message put 1138 frames below the conversation and made the agent's output unfindable.
  const view = sources.find(({ file }) => file === "/components/Transcript.tsx");
  assert.ok(view, "Transcript.tsx must exist");
  assert.ok(
    !/transcript\.tools\.map/.test(view.text),
    "the transcript must not render every tool; that is the trace window's job",
  );
  // It must still show WHERE tools ran, or the prose would look like an uninterrupted monologue.
  // The grouping rule lives in `src/activity.ts` — where "one group per stretch of work" and the
  // "no empty turn for a thinking-only message" rule are tested — so the invariant checks the transcript
  // USES that plan rather than re-deriving positions itself.
  assert.ok(view.text.includes("planEntries"), "the transcript should render a planned sequence");
  assert.ok(view.text.includes("ActivityGroup"), "the transcript should render one activity group per stretch of work");
  assert.ok(view.text.includes("showMarkers"), "activity must be optional, for pure reading");
  // The old per-run marker and the top-level thinking bar are GONE. If either returns, the transcript is back
  // to one row per internal step — the defect this grouping exists to remove.
  assert.ok(!view.text.includes("ToolMarker"), "no per-run tool marker: activity is one group per stretch");
  assert.ok(!view.text.includes("planTranscript"), "there must be ONE plan, not two competing ones");
});

// --- No live region on the streaming tail -----------------------------------------------------

test("the transcript region uses aria-busy and has no per-delta live region", () => {
  // Announcing per delta would emit hundreds of utterances per turn and make the app unusable
  // with a screen reader. The trade is recorded in DESIGN.md §9 so it is not "fixed" into the bug.
  const view = sources.find(({ file }) => file === "/components/Transcript.tsx");
  assert.ok(view, "Transcript.tsx must exist");
  assert.ok(view.raw.includes("aria-busy"), "the transcript region needs aria-busy while streaming");
  assert.ok(!/aria-live/.test(view.text), "the streaming transcript must not be a live region");
});

// --- ADR-0008: no way to move a session --------------------------------------------------------

test("no component offers to change a session's working directory", () => {
  // ADR-0008: the working directory is the sole input to the sandbox policy, so changing it
  // mid-session is a live policy swap. The only options are resume in place or start fresh.
  for (const { file, text } of sources) {
    assert.ok(
      !/cwdOverride|switch_session|changeDirectory|moveSession|retarget/i.test(text),
      `${file} references a working-directory change, which ADR-0008 rejects`,
    );
  }
});

// --- Steer must not be advertised ---------------------------------------------------------------

test("the UI does not offer a Steer control the protocol cannot deliver", () => {
  // `Control` has no steer, and the supervisor hard-codes followUp when streaming. A visible
  // button would be a fake capability; the hint says it is unavailable instead.
  for (const { file, text } of sources) {
    if (file === "/components/Composer.tsx") continue; // it states the unavailability
    assert.ok(
      !/Send steer|kind:\s*"steer"/.test(text),
      `${file} offers steering, which the protocol does not support`,
    );
  }
});

// --- A machine value must be formatted the same way everywhere ---------------------------------

test("the metrics strip formats tokens through the shared helper, not raw", () => {
  // The screenshot showed the SAME value two ways on one screen: the inspector read `127.2M`
  // while the metrics strip read `12723914`. That is the exact failure `format.ts` exists to
  // prevent, and it happened by interpolating the raw field in one place.
  const app = sources.find(({ file }) => file === "/App.tsx");
  assert.ok(app, "App.tsx must exist");
  assert.ok(
    !/\$\{session\.tokensTotal\}(?!\s*(===|!==|==|!=|\?|\+|>|<|\)))/.test(app.text),
    "tokensTotal must go through formatTokens(), never interpolated raw",
  );
  assert.ok(app.text.includes("formatTokens"), "the metrics strip should use the shared formatter");
});

test("the rail labels its numbers truthfully, via the derived fleet counts", () => {
  // "2 running" while both sessions were idle, because the label was applied to
  // `live.length`. Counts come from `fleetCounts` so the label and number cannot drift.
  const app = sources.find(({ file }) => file === "/App.tsx")!;
  assert.ok(app.text.includes("fleetCounts"), "the topbar should use the derived counts");
  assert.ok(
    !/\{state\.live\.length\}\s*running/.test(app.text),
    "the running label must not be applied to the total session count",
  );
});

test("the header does not append the path to a line that already contains it", () => {
  // The screenshot showed the working directory twice. `headerLocation` owns this decision.
  //
  // The check follows the responsibility: the location line moved from `App.tsx` into `SessionHeader.tsx`, and a
  // guard aimed at the old file would have silently stopped protecting anything — the failure mode this file's own
  // header records for `ToolFrame.tsx`.
  const header = sources.find(({ file }) => file === "/components/SessionHeader.tsx");
  assert.ok(header, "SessionHeader.tsx must exist — it owns the location line");
  assert.ok(header.text.includes("headerLocation"), "the header should use the shared helper");
  assert.ok(
    !/whereLine\([^)]*\)\}\s*·\s*\{shortenPath/.test(header.text),
    "appending shortenPath() to whereLine() duplicates the path for project sessions",
  );
});

// --- The dock's height must not depend on the queue (the queued-prompts rework) --------------------

test("only ONE component may enumerate the queue", () => {
  /*
   * The defect: the composer rendered a row per queued message, so its height was a function of N — and because the
   * transcript's scroller is a flex sibling above it, every queued message re-shrank the conversation. A reader pinned to
   * the tail was pushed up the page again for each message they queued.
   *
   * Guarding the SYMPTOM would mean measuring the dock, which no test in this repository can do. Guarding the CAUSE is
   * exact: a component that cannot iterate `.steering` / `.followUp` cannot grow with them. `QueuedPrompts` is the one
   * place allowed to, because it is the full list inside a bounded sheet.
   */
  const enumerators = sources
    .filter(({ text }) => /\.steering\.map|\.followUp\.map/.test(text))
    .map(({ file }) => file)
    .sort();
  assert.deepEqual(
    enumerators,
    ["/components/QueuedPrompts.tsx"],
    `only the full list may render every queued message; found: ${enumerators.join(", ")}`,
  );
});

test("the rail is bounded by KINDS, not by count", () => {
  // The companion to the check above: the rail exists, and it renders `queueRail`'s rows and nothing else. A `map` over
  // the queue in the rail would be the defect again, one component away.
  const rail = sources.find(({ file }) => file === "/components/QueueRail.tsx");
  assert.ok(rail, "QueueRail.tsx must exist");
  assert.ok(rail.text.includes("queueRail"), "it renders the bounded rail, not the queue");
  assert.ok(!/\.steering|\.followUp/.test(rail.text), "it must not read the groups at all");
});
