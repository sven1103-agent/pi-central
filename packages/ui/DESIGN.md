# Pi Central — Phase 2 UI Design

**Scope.** `packages/ui/` (React 19 + Vite). Grounded in `docs/USER-STORIES.md`, `docs/PROTOCOL.md`, `docs/CONSTRAINTS.md`, `docs/ARCHITECTURE.md`, `docs/STACK.md`, ADR-0004/0006/0008/0009/0010, `packages/protocol/src/envelopes.ts`, `packages/orchestrator/src/{state,supervisor,resume,config,registry,transport}.ts`, and the
implemented UI in `packages/ui/src/`.

**This document is the design system, and `packages/ui/src/styles.css` implements it.** No
component library is used; the tokens, states and component inventory below are hand-written. The
UI is built and running as of v0.1.0 — where this document and the code disagree, the code is what
a user sees, and the disagreement is a bug worth reporting.

Nothing here is invented that the project already has: session rail, transcript pane, composer,
approvals, tool trace, and the sanitized `.md` pipeline are all named in `docs/STACK.md`.

---

## 0. Subject, audience, governing decision

**Subject.** A local control station for N sandboxed Pi sessions across N directories, on one Mac, for one developer. Adjacent to a terminal all day.

**One job.** Answer "what needs me right now, and let me act on it" in under two seconds — and stay honest about isolation, state, and what is untrusted.

**Governing decision (accepted, not re-litigated).** Scratch-first. The primary action starts a session with **no path entry**; the session gets an app-owned scratch workspace (`~/.local/share/pi-central/workspaces/<session-id>/`, per `config.ts#scratchDirFor`). `Open in a directory…` is a secondary affordance. There is no migrate/re-target/move affordance anywhere (ADR-0008).

`assumption:` the orchestrator's `--direct` flag remains as a host workaround (C10), so the UI must render a `NO ISOLATION` state — but it never *offers* Direct mode as a choice (§5.4, flagged as contentious).

---

## 1. Information architecture

```
┌ topbar 44px ───────────────────────────────────────────────────────────────┐
│ Pi Central · [Sessions|History] · fleet counts · isolation · connection     │
├ rail 288px (240–420) ─┬─ transcript column 1fr ─┬─ inspector 320px ─────────┤
│ New session (primary) │ session header          │ Isolation                │
│ Open in a directory…  │ ctx/tokens/cost chips   │ Paths                    │
│ filter (/)            │ run bar                 │ Usage                    │
│ ── Needs you ──       │ warnings strip          │ Warnings & notices       │
│ ── Running ──         │ dialog dock             │ Actions                  │
│ ── Idle ──            │ transcript (scroll)     │                          │
│ ── Stopped (n) ──     │ queue strip             │                          │
│ ── Failed (n) ──      │ composer                │                          │
└───────────────────────┴─────────────────────────┴──────────────────────────┘
```

| Region | Primary content | Never here |
|---|---|---|
| Rail | Live sessions, ordered by *attention*; the two start actions; filter | On-disk history (40 dead rows under live ones was the spike's worst rail mistake) |
| Transcript column | One focused session: header, metrics, run state, dialogs, transcript, composer | Session list, cross-session stats |
| Inspector | The auditable facts about the focused session: isolation, exact argv, paths, usage, warnings | Anything actionable mid-run except `Rename`, `Stop`, and copy affordances |
| Topbar | Fleet counts + mode tabs + connection | Per-session controls |

**Primary:** the focused session, its approvals, its composer. **Secondary:** history, rename, stop, model/thinking pickers. **Absent:** any directory field on the primary path; any "move this session"; any per-session isolation toggle.

### Task flow

```
1. ENTER      app loads → topbar + rail; no session focused until you pick or start one
2. ACT        "New session" (⌘N) → rail row appears at `starting`, focused, composer disabled
              → `starting` → `idle`. Workspace path is printed in the header, not asked for.
   (secondary) "Open in a directory…" (⌘⇧O) → sheet with recent dirs + typed path + validation
3. WORK       type → Enter → Send. State leaves `idle` on `agent_start` (never on `agent_end`, C8)
4. INTERRUPT  (optional) Esc while streaming → clear_queue + abort (see §4.3)
5. APPROVE    (optional) dialog arrives in *any* session → row turns amber, line 3 carries the ask
6. RESUME     History tab → search → row detail → Resume, or a refusal with a way forward
```
Interruptible/reversible: focus switch (instant), abort (queue text is restored to the composer), model/thinking change (next turn), dialog cancel (`{cancelled:true}`). Not reversible: **Stop** (confirmed while streaming), **resume of a missing directory** (refused before spawn).

---

## 2. Layout concept

One sentence: **a fixed 288px triage rail, a single wide document column optimised for reading, and a narrow auditable sidecar — separated by 1px `--line` gutters rather than borders or cards** (the `#panes` technique, as implemented: `display:grid; gap:1px; background:var(--line)`). Alignment is **left throughout**, including the empty state, because every surface is either a scan list or a document; centring would break the column rhythm and the mono-value alignment that makes the rail scannable.

Spacing rhythm: 4px base. Rail padding 12/16, rows 8px apart, group gaps 16px, column padding 18px, section gaps 12px. Content measure caps at **72ch** in the transcript (`max-width:72ch`) — prose stays readable on a 27" display while tool output may use full width.

Responsive: `≥1440` three panes; `1024–1439` two panes (inspector becomes a tab in the transcript header, opened as a 380px right sheet); `<1024` the rail becomes a left drawer (⌘\, `aria-expanded`), inspector a bottom sheet. Phase 2 floor is 1024px.

**Why not mobile.** The orchestrator binds `127.0.0.1` (STACK operational rule 2, C5), so no phone can reach it. A phone layout would be dead code that still costs accessibility surface. Stated once here, not designed.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Prototype layout: form-first rail** (path + name + isolation radios at the top, live list, 40 history rows stacked below in one scroll) | Makes a working directory a precondition of "hello" (US-1), mixes a *form* with a *triage list*, and buries history in an unsearchable tail. This is the layout the governing decision exists to kill. |
| **Modal-centric approvals** (dialog steals the window) | `awaiting-approval` is a first-class state (ARCHITECTURE.md), and the *agent* is blocked, not the human. A modal over the whole app would make switching to another session — the dashboard's reason to exist — a punishable act. |
| **History inside the rail** | 833 sessions discovered on this machine (`registry.ts`, ROADMAP verification). Two orderings (attention + recency) in one scrolling column cannot both be legible. |
| **Terminal-style single column with a fleet overlay (⌘K)** | Hides the fleet, which is the product. ⌘K survives only as an optional jump-to-session palette. |

---

## 3. Wireframes

Geometry: rail 288px · gutter 1px `--line` · inspector 320px · topbar 44px · rail row 68px · transcript header 56px · run bar 2px · composer min 96px.

**W1 — First run (nothing live, no history at all)**

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Pi Central   [ Sessions | History ]        0 running      safehouse            │
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ┌ New session (⌘N) ─────┐│                                                     │
│ │ runs in a scratch     ││   No session selected                                │
│ │ workspace             ││                                                     │
│ └───────────────────────┘│   New session gives it its own scratch workspace     │
│  Open in a directory… ⌘⇧O│   immediately — no directory to pick, nothing to      │
│                          │   decide first. Files it writes stay there.          │
│  / filter sessions       │                                                     │
│ ──────────────────────── │   Working in a project? Open in a directory.         │
│ ── Idle · 0 ───────────  │                                                     │
│   No live sessions.      │   ── Activity ─────────────────────────────────      │
│   Start one with ⌘N.     │   Nothing yet.                                       │
│ ──────────────────────── │                                                     │
│  All sessions  833  ›    │                                                     │
└──────────────────────────┴─────────────────────────────────────────────────────┘
```

**W2 — One live session, idle**

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Pi Central   [ Sessions | History ]        1 running      safehouse            │
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ┌ New session (⌘N) ─────┐│ s3  [scratch]   ~/.local/share/pi-central/workspaces │
│ └───────────────────────┘│                 /s3              [ Model ▾ ][ med ▾ ] │
│  Open in a directory…    │ ───────────────────────────────────────────────────  │
│  / filter sessions       │ ctx —   ·   — tok   ·   $0.0000   ·   0 msgs          │
│ ──────────────────────── │──────────────────────────────────────────────────────│
│ ── Idle · 1 ───────────  │                                                     │
│ ▌s3        scratch   idle│   No messages yet.                                   │
│ │ scratch · s3          ││                                                     │
│ │ sonnet-4.5 · med · —  ││   This session works in its own scratch workspace.   │
│ ──────────────────────── │   Anything it writes stays there. To work in a       │
│ ── Stopped · 0 ────────  │   project, use Open in a directory.                  │
│ ── Failed · 0 ─────────  │                                                     │
│                          │ ───────────────────────────────────────────────────  │
│                          │ ┌────────────────────────────┐      ┌ Send ──────┐   │
│                          │ │ Send a prompt…             │      │            │   │
│                          │ └────────────────────────────┘      └────────────┘   │
│                          │ Enter to send · Shift+Enter for a new line            │
└──────────────────────────┴─────────────────────────────────────────────────────┘
```

**W3 — One live session, streaming (follow-up mode, queue non-empty, tool frame)**

```
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ▌s7        scratch   ●run│ s7 [scratch]  ~/git/repo   [ Model ▾ ][ high ▾ ]     │
│ │ scratch · s7          ││ ctx 62% ▓▓▓▓▓▓░░░░ · 41.2k tok · $0.0142 · 12 msgs   │
│ │ sonnet-4.5 · high·62% ││ ══════════════════════════════════════════════════  │ ← run bar
│ │ $0.0142               ││ ┌ Run in progress · Follow-up | Steer ────────────┐  │
│                          │ │ Queued: starts after this run finishes           │ │
│ ── Running · 1 ───────── │ └──────────────────────────────────────────────────┘ │
│                          │ user ▏Add a --json flag to the CLI export path        │
│                          │ ╎ Tool output ╎ ⌄ bash · npm test --silent            │
│                          │ ╎             ╎   PASS src/cli.test.ts (14)           │
│                          │ ╎ (hatched)   ╎   2 failing: render.test.ts           │
│                          │ assistant ▏Two tests fail on the fixture path…        │
│                          │ ── 2 queued ───────────────────────────────────────  │
│                          │ 1 follow-up  also update the README table             │
│                          │ 2 follow-up  then run the full suite                  │
│                          │        [ Clear queue and stop run (Esc) ]             │
│                          │ ┌────────────────────────────┐ ┌ Queue follow-up ─┐  │
│                          │ │ also pin the version…      │ └──────────────────┘  │
│                          │ Enter to queue · Esc stops the run and clears the    │
│                          │ queue · @ mentions a file                            │
```

**W4 — Multiple sessions (9 live) — attention order, collapse, filter**

```
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ┌ New session (⌘N) ─────┐│ s12  api-gateway  ~/git/api-gateway                  │
│ └───────────────────────┘│                                                     │
│  Open in a directory…    │   ╔══ 2 sessions need you ═══════════════════════╗   │
│  / api            ⌘K     │   ║ s4 · Allow running `npm test`?        0:41   ║   │
│ ──────────────────────── │   ║ s9 · Choose a package manager         0:12   ║   │
│ ── Needs you · 2 ──────  │   ╚═══════════════════════════════════════════════╝   │
│ ▌s4  api-gateway  ●wait  │                                                      │
│ │ ~/git/api-gateway     ││   Pick a session on the left, or answer the ones     │
│ │ ⚠ Allow running npm…  ││   that are waiting.                                  │
│ ▌s9  web-docs     ●wait  │                                                     │
│ │ ~/git/web-docs        │                                                     │
│ │ ⚠ Choose a package m… ││                                                     │
│ ── Running · 4 ────────  │                                                     │
│ ▌s7  scratch      ●run   │                                                     │
│ │ scratch · s7          ││                                                     │
│ │ sonnet · high · 62%   ││                                                     │
│ ▌s12 api-gateway  ●run   │                                                     │
│ │ ~/git/api-gateway     ││                                                     │
│ │ opus · med · 31%      ││                                                     │
│ ▌s2  infra        ●run   │                                                     │
│ ▌s11 scratch      ●run   │                                                     │
│ ── Idle · 3 ──────────── │                                                     │
│ ▌s3  scratch      idle   │                                                     │
│ ▌s5  billing-api  idle   │                                                     │
│ ▌s10 web-docs     idle   │                                                     │
│ ── Stopped · 6 ───────── │                                                     │
│ ── Failed · 1 ────────── │                                                     │
│                          │                                                     │
│ All sessions  833  ›     │                                                     │
```

**W5 — Approval dialog pending (`confirm`), focused session**

```
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ▌s4  api-gateway  ●wait  │ s4  api-gateway   ~/git/api-gateway                  │
│ │ ~/git/api-gateway     ││ ctx 44% ▓▓▓▓░░░░░░ · 28.1k tok · $0.0091 · 21 msgs   │
│ │ ⚠ Allow running npm…  ││ ───────────────────────────────────────────────────  │
│ ── Running · 2 ────────  │ ┌ Permission request · waiting 0:41 ───────────────┐ │
│                          │ │ Allow running `npm test`?                         │ │
│                          │ │ The agent wants to run a shell command in this    │ │
│                          │ │ session's working directory.                      │ │
│                          │ │                                                   │ │
│                          │ │ [ Allow once ]  [ Deny ]        [ Cancel request ]│ │
│                          │ │ Answered on timeout by Pi if nobody is watching.  │ │
│                          │ └───────────────────────────────────────────────────┘ │
│                          │ (composer is replaced by this dock while it waits)    │
```

**W6 — History browsing, with a missing-directory row selected**

```
┌ Pi Central   [ Sessions | History ]                    833 sessions on disk    ┐
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ⚠ 82 sessions point at    │ 🔍 [ authorization                                  ]│
│   directories that no     │  search name, first message, project · ⏎ opens     │
│   longer exist            │ ─────────────────────────────────────────────────── │
│                          │                                                                
│ Filters                  │ npi2  billing-api                           12m ago │
│ [x] any project          │ ~/git/billing-api · 421 KB · 138+ msgs · #8f21   › │
│ [ ] scratch only         │ "add retry with backoff to the charge client"      │
│ [x] directory still exists│                                                     │
│ [ ] has a name           │ ▸s9  web-docs   ⚠ directory is gone          3d ago │
│ ──────────────────────── │ /Volumes/archive/web-docs · 96 KB · 0 msgs      ›  │
│ Groups                   │ "flatten the table of contents"                     │
│ ▸ by project (18)        │                                                     │
│ ▸ by last touched        │ s7  [scratch]                               1d ago  │
│                          │ scratch workspace · 12 KB · 6+ msgs             ›  │
│                          │ "authorization header casing in tests"              │
│                          │                                                     │
│                          │ ┌ Selected: s9 · web-docs ────────────────────────┐ │
│                          │ │ Its directory is gone                            │ │
│                          │ │ The directory this session worked in no longer   │ │
│                          │ │ exists:                                          │ │
│                          │ │   /Volumes/archive/web-docs                      │ │
│                          │ │ Restore it, or start a new session in the        │ │
│                          │ │ directory you want to work in. Pi Central does   │ │
│                          │ │ not move a session between directories.          │ │
│                          │ │ [ Check again ]   [ Start a new session… ]       │ │
│                          │ └──────────────────────────────────────────────────┘ │
└──────────────────────────┴─────────────────────────────────────────────────────┘
```

**W7 — Session that started but cannot reach a model (C13)**

```
├──────────────────────────┬─────────────────────────────────────────────────────┤
│ ▌s1  scratch      ●warn  │ s1 [scratch]  scratch · s1        [ Model ▾ ][ med ▾] │
│ │ scratch · s1          ││ ctx — · — tok · $0.0000 · 0 msgs                     │
│ │ ⚠ no model response   ││ ═══════════════════════════════════════════════════  │
│                          │ ┌ This session can't reach a model ────────────────┐ │
│ ── Running · 1 ───────── │ │ It started without an error, but no model call    │ │
│                          │ │ has completed since you queued a prompt 0:34 ago. │ │
│                          │ │                                                   │ │
│                          │ │ Its provider key is resolved by a command that    │ │
│                          │ │ reads a keychain, and this session's sandbox may  │ │
│                          │ │ not be able to reach it.                          │ │
│                          │ │                                                   │ │
│                          │ │ [ Copy diagnostic ] [ Try again ] [ Stop session ]│ │
│                          │ │ [ Still working — hide this ]                     │ │
│                          │ └───────────────────────────────────────────────────┘ │
│                          │ user ▏hello                                            │
│                          │ (no records received; the session reports idle)       │
├──────────────────────────┴─────────────────────────────────────────────────────┤
│ inspector ▸ Isolation: Safehouse workdir=/Users/…/workspaces/s1 +bespoke-fragment│
│             Warnings: provider config resolves keys via a command (litellm), but │
│             no keychain exists at …/agents/default/agent.keychain-db.            │
```

**W8 — Spawn failure / crash (compact)**

```
│ ▌s6  billing-api  ✖fail  │ ┌ Session failed to start ────────────────────────┐  │
│ │ ~/git/billing-api     ││ │ pi exited (code=71, signal=-)                   │  │
│ │ ✖ exited code=71      ││ │ sandbox-exec: sandbox_apply: Operation not      │  │
│ ── Failed · 1 ────────── │ │ permitted                                       │  │
│                          │ │ This looks like Seatbelt refusing to nest (C1).  │  │
│                          │ │ [ Retry ]  [ Copy stderr ]  [ Dismiss from rail ]│  │
```

---

## 4. The composer

Four honest fates for one Enter, decided by `LiveSession.state`, the draft's first character, and the discovered command list (`get_commands`):

| Situation | Header strip | Button label | Hint line |
|---|---|---|---|
| `idle`/`stopped`/`failed-with-file` | *(none)* | **Send** | `Enter to sends · Shift+Enter for a new line` |
| `streaming`, Follow-up selected | `Run in progress · Follow-up \| Steer` + `Queued: starts after this run finishes` | **Queue follow-up** | `Enter to queue · Esc stops the run and clears the queue` |
| `streaming`, Steer selected | same strip, Steer selected + `Delivered after the current turn's tools finish` | **Send steer** | same |
| draft starts with a known `/command` | `Command · runs immediately, even mid-run` | **Run command** | `/ for commands · Esc dismisses` |
| `awaiting-approval` | *(none — the composer is replaced by the dialog dock)* | — | — |
| `starting` | *(none)* | **Send** (disabled) | `Waiting for the session to start…` |
| `failed` (no session file) | *(none)* | — | `This session failed to start. Retry it from the rail.` |

The absence of a mode control when idle is deliberate: when only one thing can happen, a selector is a lie about complexity. The strip appears only when the choice is real.

**4.1 Steer is a prerequisite, not a control — and the prerequisite was ours.** This section originally read: *"`Control` (envelopes.ts) has no `steer` and no `clear_queue`, and `Supervisor#prompt` hard-codes `streamingBehavior: "followUp"` when streaming. So Phase 2 ships Follow-up only … A visible-but-disabled Steer toggle would advertise a capability the protocol cannot deliver — worse than its absence."*

The observation was accurate about Pi Central and wrong about Pi. Pi's RPC mode handles `steer`, `follow_up`, `prompt` with a `streamingBehavior`, and `clear_queue`, and `Command` (pi.ts) already carried the first two — the supervisor simply never passed a behavior through. So the missing piece was a `Control` variant, not a Pi capability, and the hedge was describing our own vocabulary. It has been removed (issue #3).

The lesson is worth keeping: **"the protocol cannot express it" is a claim about two protocols**, and this conflated Pi's with ours. A hedge that names a missing capability is only honest if the thing that is missing is outside our control; otherwise the honest move is to build the capability. The disposition rule survives unchanged — a visible-but-disabled control is still worse than its absence — but it no longer applies to steer, because steer is real.

Esc's ladder is now fully implemented, including the `clear_queue` step: it clears the queue, stops the run, and returns the cleared text to the composer (merged below the draft, once). The order — clear *then* abort — is the behaviour, not an implementation detail: aborting first lets the run settle while messages are still queued, and Pi may deliver one as a real turn in that window.

**4.2 Queue visibility.** `LiveSession.pending` is a *count*; the texts arrive in `queue_update` records (`record.steering`, `record.followUp`), which the client keeps in a per-session buffer. Rules: count from `LiveSession.pending`, texts from the record buffer, keyed by index; if they disagree (after a reload/snapshot, where no texts exist) the strip header reads `2 queued` and rows read `1 message queued before this page loaded` — never invented text. Rows are **read-only**: Pi Central has no per-item removal in its vocabulary, so offering a `×` would be a fake control. One action: `Clear queue and stop run (Esc)`.

**4.3 Esc precedence ladder** (the spec builders get wrong most often):

```
1. A dialog is open in the focused session → answer { cancelled: true }
2. A popover/menu/sheet is open            → close it
3. Streaming                               → clear_queue + abort
4. Anything else                           → no-op
```
Esc **never** touches the draft text. Drafts are preserved per session in memory and restored on focus switch (`assumption:` in-memory only; persisting drafts is Q7 territory, deferred). After (3) the queue text returns to the composer and a transient line appears: `Stopped. 2 queued messages are back in the composer. Send to run them.` — no fake undo, because there is none.

**4.4 Composer geometry.** Textarea `min-height:72px; max-height:40vh; rows:3`, `font-size:15px`, `line-height:1.5`, `border-radius:6px`, `border:1px solid var(--line)`; on focus `border-color:var(--accent)` + `box-shadow: var(--focus)`. Actions sit right, `height:34px`. `@`-mention and `/`-command autocomplete use the same popover component as the model picker (`--panel-3`, `--sh-2`).

---

## 5. Working a long day on this screen

### 5.1 Session rail entries

Row: 68px, `padding:8px 12px`, 3 lines, `border-left:3px solid` = state colour, `border-radius:0 6px 6px 0` on hover only.

```
line 1  12px/600  name (or generated label)          right: state chip 10px
line 2  11px mono --dim   cwd (middle-truncated)  |  scratch · s7
line 3  11px mono --dim   model · thinking · ctx · cost   |  ⚠ <dialog ask> when awaiting
```

Rendering spec (exact, from `LiveSession`):

| Field | Rule |
|---|---|
| name | `s.name`; if the session is scratch and the name is a bare id (`s7`), show the first 42 chars of the first user message, else `Scratch session` |
| cwd | scratch → `scratch · <id>`; else the path, middle-truncated at 34 chars: `~/git/idea…ry/pi-central`, full path in `title` + `aria-label` |
| state | chip, `--fs-2xs`, uppercase OFF — sentence case (`streaming`, `needs you`) |
| model | `s.model ?? "model —"`, truncated to 14 chars mid-ellipsis |
| thinking | `s.thinkingLevel ?? "—"` truncated to 3 (`med`, `high`, `off`) |
| context | `s.contextPercent == null ? "ctx —" : ctx ${Math.round(p)}%`, amber ≥ 80% |
| cost | `< 1 ? $0.0142 : $1.42`; `null → "—"`. Never `$0.0000` for unknown — use `—` |
| pending | `+2 queued` appended only when `pending > 0` |
| warnings | a `⚠` prefix on line 3 replaces the metric line if `warnings.length > 0` |

Full line 3 at 288px: `sonnet-4.5 · high · ctx 62% · $0.0142` = 37 chars at 11px mono (6.6px/char) fits in 264px. Mono is not decoration here — it is what makes six values line up in a column across 20 rows.

**20 sessions without chaos** — six rules, in order of effect:

1. **Order by attention, not creation.** Groups: `Needs you` → `Running` → `Idle` → `Stopped (n)` → `Failed (n)`. `Needs you` rows put the ask itself on line 3, so the rail answers "what about?" before you click.
2. **History is not here.** The rail defaults to live sessions; on-disk sessions live in the History tab (833 on this machine).
3. **Collapse by state**, never by count. `Stopped`/`Failed` are collapsed by default with a count; `Needs you`/`Running`/`Idle` always show their rows.
4. **Filter** (`/` focuses the field): matches name, cwd, model. A filter input plus 3 collapsible groups beats a palette for a 20-row list; a ⌘K palette is optional (Phase 2 if cheap).
5. **Focus changes only on user action.** Starting a session focuses it. An approval arriving in session 9 must *never* yank you out of session 4 — it badges, it counts, it does not teleport. (This is the single most important behavioural rule in the rail.)
6. **Dismissal, not deletion.** `Dismiss from rail` on stopped/failed rows hides them for this browser session (US-6). No file is ever deleted from the rail — deleting a scratch workspace is an explicit action in the inspector and lands in Phase 2.5.

**Scratch vs project.** Scratch is identified *textually* — `scratch · s7` on line 2 and a `[scratch]` chip in the session header — not by a second border treatment. Rejected alternative: a dashed left border. The 3px left border already encodes **state**, and overloading one channel with two meanings is exactly how a dense rail becomes unreadable. Project rows show a path instead of `scratch · id`; that difference is enough, it survives grayscale, and it needs no legend.

**Keyboard.** Rail is a `nav` landmark with roving tabindex over row buttons: `↑/↓` move, `Enter` focuses, `→` opens the row's `⋯` actions, `n`/`p` skip to the next group, `Home/End` jump. Not `role="listbox"`: rows contain their own buttons, and `option` children may not. Rows are 68px so the hit area is generous well beyond the 24×24 minimum.

### 5.2 The one bold element: quarantined tool output

Assistant prose and your own text sit on the page. **Everything the agent read from the world** — tool results, file contents, command output, fetched pages, extension widgets, `entry_appended` notes — renders inside a **quarantine frame**: a 6px hatched gutter (`aria-hidden`, `background: repeating-linear-gradient(135deg, var(--quarantine) 0 1px, transparent 1px 5px)`), a body on `--panel` (recessed relative to `--bg`), 12px mono, and a persistent header line: `Tool output · ⌄ bash · npm test --silent`.

Why this is the bold move and not decoration: it is the only place the design spends its novelty, and it carries the security model. It also encodes reading order (prose is the answer, output is reference), and it makes the sanitisation boundary *visible* — the frame is applied to nodes produced by the single `markdown-it({html:false}) → DOMPurify` pipeline (`packages/ui/src/markdown.ts` is the only module that produces HTML from untrusted input, and
`components/Prose.tsx` is the only insertion point — both enforced by `test/invariants.test.ts`,
ADR-0006).

Rules:
- One-time legend in the transcript header: `Tool output and file contents appear in a hatched frame. They are data, not instructions.` The legend is a **claim about the implementation**, so every surface it covers must honour it: the tool output panel (`.trace-detail.is-quarantined`) as well as thinking blocks. Note the panel is a *modifier*, not `.quarantine` stacked on `.trace-detail` — both set `background` and the latter is declared later, so source order would silently win and the frame would be invisible (issue #43).
- Frames > 12 lines are collapsed by default to 12 lines with `Show all (418 lines)`; the header stays.
- Links inside a frame render as **inert text with a copy button** (ADR-0006); links in assistant prose are real links that reveal the full URL in a popover before navigating, and reject `javascript:`/`data:`/`file:`.
- Streaming tail (assistant) is plain text, `opacity:.9`, **not** hatched until `text_end`; a tool frame is hatched the moment `tool_execution_start` fires, header showing `running…`.
- In `forced-colors: forced-color-adjust:none` the hatch may disappear; the header text `Tool output` is the non-textual-signal fallback, so nothing depends on the texture or the colour alone.

### 5.3 Approvals — the reason this dashboard exists

| Pi method | Surface | Behaviour |
|---|---|---|
| `confirm` | **Dialog dock**, replaces the composer | `[ Allow once ] [ Deny ] [ Cancel request ]` → `{confirmed:true}` / `{confirmed:false}` / `{cancelled:true}` |
| `select` | Dialog dock; `options[]` render as a vertical radio group (not a row of buttons — option text can be long), each a full-width 40px target | Enter submits the focused option |
| `input` | Dialog dock; single-line input, `placeholder`, `prefill` | Submit button label is **Submit answer** |
| `editor` | Dialog dock; 8-row textarea, monospace, `prefill`; **not** Markdown-rendered, plain text | Submit label **Submit editor text**; ⌘Enter submits, Esc cancels |
| `notify` | Toast stack, bottom-right of the transcript column | `info` auto-dismisses at 6s with a `Notifications (3)` counter in the topbar; `warning`/`error` persist until dismissed and are appended to the inspector's Notices log |
| `setStatus` | Status chips in the session header, keyed by the status id, replaced in place | Never a toast, never a state change (`state.ts` asserts this) |
| `setWidget` | A collapsed strip above the composer: `1 panel from an extension  ▸` | Never auto-expands, never steals focus, body renders inside a quarantine frame |

Dialogs are **non-modal**: `role="dialog"`, `aria-modal="false"`, `aria-labelledby` pointing at the header. Focus **moves into** the dock when the dialog arrives (so Enter is enough), and Shift+Tab from the first control leaves it deliberately — the human must stay free to switch sessions while the *agent* waits. Esc = cancel, and the ladder in §4.3 applies. `receivedAt` drives a visible `waiting 0:41` clock: since Q6's working default is fail-closed, the human should be able to see how long the agent has been stuck. No countdown is possible — `state.ts` drops Pi's `timeout` field when building `PendingDialog` (see P2).

Multiple sessions waiting: topbar reads `2 sessions need you`; each rail row carries its own ask on line 3; the rail group `Needs you` is pinned above `Running`. Background dialogs never open over the focused session.

**Startup burst (`~9` records: 5 notify, 3 setStatus, 1 setWidget).** Three rules: (a) notifies arriving within the session's first 5 seconds collapse into one grouped toast `Session started · 5 notices  ▸`; (b) identical texts within 2s collapse to `×3`; (c) statuses/widgets render in place, never as toasts, and never touch `state` or `dialogs`. A wall of nine toasts at startup is how a user learns to ignore notifications — which is fatal when one of them is a real warning.

### 5.4 Direct mode

The spike's isolation radio group is **removed**. Direct mode is a host workaround for machines where Safehouse cannot run (C10), and was only ever meant to be deleted once real sandboxing existed. It is instead a startup flag; when the orchestrator runs with `--direct`, the UI shows a persistent topbar banner `Direct mode: sessions are not sandboxed` and every session gets the `NO ISOLATION` chip from `LiveSession.mode` plus the verbatim warning from `policy.ts`. `` `assumption:` `` flagged as contentious in §13.

---

## 6. History

**Entry.** Topbar `History` tab, or `All sessions 833 ›` at the rail's foot. One full-width list, not a rail tail.

**Row** (56px, 2 lines):
```
line 1  12px/600  name (or first-message excerpt, 56 chars)
         right: relative time, --dim 11px mono (`12m ago`, `3d ago`)
line 2  11px mono --dim:  <project basename> · <cwd> · <KB> · <n>+ msgs · #<id8>
line 3 (only when selected or hovered): "first message excerpt"
```
- `bytes`: `421 KB` under 1 MB, `2.8 MB` above.
- `messageCount` is a **floor** for files larger than 256 KB (`registry.ts#HEAD_BYTES`), so it renders `138+` with `aria-label="at least 138 messages, counted from the first 256 KB of the transcript"`.
- `#<id8>` is `id.slice(0,8)` — the handle you can grep for on disk.
- `scratch: true` → `[scratch]` chip and the path reads `scratch workspace`.
- `cwdExists: false` → ⚠ prefix, line 2 prefixed `directory is gone`, row at `opacity:.72`... **no**: the row is *not* dimmed to illegibility; dimming a row that a user needs to read is a contrast failure. Instead: a ⚠ glyph plus the words `directory is gone` in `--warn-text`, and the row stays fully legible.

**Search.** `🔍` field, `inputmode=search`, debounced 150ms. Phase 2 searches **name, `firstMessage`, cwd/project, date**. Filters: project, `scratch only`, `directory still exists`, `has a name`. Groups: by project, by last touched.

**Honest limit.** Searching *all* message content is not in the protocol: `HistoricalSession` carries `firstMessage` only, and `registry.ts` reads only the first 256 KB. `Control` has no search kind — `list` returns everything, and filtering happens in the UI over 833 rows (fine: it is a few hundred KB in memory). Full-transcript search needs an orchestrator-side index or a new `Control` kind → **P5, Phase 3** (already "Backlog: Session search across all projects"). The field label says `search name, first message, project`, not `search transcripts`, so it never lies.

**Resume of a missing directory.** The refusal is a first-class panel, not a raw error:
- Discovery-time badge (`cwdExists === false`) is a *hint*. The authoritative check is at resume time (`Supervisor#resume` → `checkResumable`), because a directory can vanish in between (D-4).
- On failure, the panel prints the orchestrator's message **verbatim** in mono, preserving its line break and path — that string is already written for a human ("The directory this session worked in no longer exists: … Pi Central does not move a session between directories."). Do not paraphrase it.
- Actions: **`Check again`** (re-validate — the volume may be remounted) and **`Start a new session…`** (opens the directory sheet). The second is flagged in §13: ADR-0008 frames the choice as resume-or-cancel, so this is an added affordance, and it is offered as a *new* session with the explicit line `This does not carry over this conversation.` Never a "resume there instead" button.
- The rail never shows a Resume control for a row whose `cwdExists` is false; live sessions already holding that file are returned as-is (`#findLiveByPath`, ADR-0004).

**Stopped-session resume** goes through `{kind:"resume", path}` after a `{kind:"list"}` refresh, because the transport resolves `path` against the discovered set — a stopped session is only resumable once its file is in the history snapshot.

---

## 7. State & failure coverage

For each region: what it looks like and what it lets you do. Columns: **rail row**, **transcript column**, **actions enabled**.

| `LiveState` | Rail row | Transcript column | Enabled |
|---|---|---|---|
| `registered` | *(unreachable in Phase 2: `Supervisor#spawn` starts at `starting`; design defensively)* rendered as a history-like row with a `Resume` action | detail panel, no live controls | Resume |
| `starting` | grey dot, `starting`, elapsed `0:04` | header present, `Waiting for the session to start…`, buttons disabled | Stop |
| `idle` | green dot, metric line | composer = Send | Send, Rename, Stop, model/thinking, Export (P3) |
| `streaming` | blue dot + run bar, `●run`, elapsed | run bar, live transcript | Queue follow-up, Esc=stop+clear, Abort, Stop (confirmed) |
| `awaiting-approval` | amber, line 3 = the ask, `●wait` | dialog dock replaces the composer | answer/cancel dialog, Stop |
| `stopped` | dim grey, collapsed group | inspector only; transcript still readable, composer read-only | Resume, Rename, Dismiss |
| `failed` | red, `✖ exited code=71` | error card, stderr in mono, `Copy stderr` | Retry (resume if `sessionFile`, else start in the same cwd), Stop, Dismiss |

**Failure modes beyond `LiveState`**

| Case | Detection | Surface |
|---|---|---|
| Spawn failure (`composePolicy` throws) | `{kind:"start"}` returns `{kind:"error", message}` | Topbar error toast + an inline card at the top of the rail's `Running` group, with the message verbatim |
| `failed` (nonzero exit) | `RpcProcess` `exit` → `session.error` | W8. Retry performs a *new* spawn; Pi Central never auto-restarts (ARCHITECTURE "Restart policy") — say so in the card: `Pi Central does not restart sessions by itself. Retrying replays nothing.` |
| Model unreachable (C13) | heuristic: `state === "idle"` + a prompt sent + no `agent_start`/`message_*` within 10s; or `warnings[]` non-empty | W7. Labelled as inference, with `Still working — hide this` and a live elapsed clock so the claim stays checkable |
| Sandbox warning (policy/keychain warnings) | `LiveSession.warnings[]` non-empty | Amber strip in the transcript column (first line of the warning) + full text in the inspector, verbatim and copyable |
| Discovery failure | transport emits `{kind:"error", message:"discovery failed: …"}` | History tab shows `History is unavailable` + the message + `Try again`; live sessions keep working |
| Socket loss | `onclose` | Global banner `Lost connection to the orchestrator` / `If Pi Central exited, it stopped every session it started. Reconnect to see what is still live.` + `Reconnect now`. Auto-retry 2s → backoff to 10s, **stops after 5 attempts** (an infinite silent retry loop is how a UI hides a dead backend) |
| Context pressure | `contextPercent ≥ 80`, `compaction_start/end` | ctx chip turns amber; a notice `Compacting context… (the context was full)` / `Context compacted: 118.0k → 41.0k tokens.` An **aborted** compaction says `Context compaction stopped.` and never the success sentence, because reporting a failure as a success is the lie that matters most. `compaction_end` **refreshes stats** — the meter must show the drop, or it keeps displaying the pressure that was just relieved |
| Retries | `auto_retry_start/end`, `summarization_retry_*` | Inline notice in the transcript: `Retrying (2/3) in 4s after provider returned 529.` — never a state change (C8; `agent_end` is not `agent_settled`). The attempt **and** the bound are both stated, or "retrying" reads as an unbounded loop. `summarization_retry_*` is a **different mechanism** and gets its own wording: a summarizer failed while compacting, so blaming the provider would send the reader looking in the wrong place |
| Extension fault | `extension_error` | Notices log + an amber strip: `An extension in this session threw an error. The session keeps running.` + `Copy error`. Never an approval dialog — it is not blocking |

**Context/token/cost empty rule.** `contextPercent: null` until a fresh assistant response (PROTOTYPE README finding 5) renders as `ctx —`, `aria-label="context usage not reported yet"` — never `0%`, which would be a false claim about a full window.

---

## 8. Design tokens

The tokens as implemented in `packages/ui/src/styles.css`. Existing var names are kept exactly (`--bg --panel --panel-2 --line --text --dim --accent --warn --danger --ok --mono`); everything below marked **+** is new.

```css
/* surfaces */
--bg:#0e1116; --panel:#161b22; --panel-2:#1c2230; --panel-3:#222937;   /* + raised: menus, dialogs, sheets */
--line:#262d3a; --line-strong:#3a4354;                                  /* + dialog & popover borders */
/* text — two levels only, both ≥6:1 on --bg, so 10px meta is AA-safe */
--text:#e6edf3; --dim:#8b949e;
/* state — saturated hue for dots/borders; lightened sibling for text on tinted chips */
--accent:#4c9aff; --accent-text:#a5d6ff; --accent-tint:rgba(76,154,255,.15);
--ok:#3fb950;     --ok-text:#7ee787;     --ok-tint:rgba(63,185,80,.15);
--warn:#d29922;   --warn-text:#e3b341;   --warn-tint:rgba(210,153,34,.15);
--danger:#f85149; --danger-text:#ffb4ae; --danger-tint:rgba(248,81,73,.15);
/* quarantine is NOT a state colour: it labels content provenance */
--quarantine:#586069;                                                   /* + hatch stripe + frame rule */
/* scale */
--sp-1:4; --sp-2:8; --sp-3:12; --sp-4:16; --sp-5:24; --sp-6:32;
--r-1:4; --r-2:6; --r-3:8; --r-4:10; --r-pill:999px;
--fs-2xs:10; --fs-xs:11; --fs-sm:12; --fs-base:13; --fs-md:15; --fs-lg:18;  /* lh 1.45 prose, 1.25 data */
--sh-1:0 1px 0 rgba(255,255,255,.03);                                   /* + raised panel */
--sh-2:0 12px 32px rgba(0,0,0,.55);                                     /* + dialogs, popovers */
--focus:0 0 0 2px var(--bg), 0 0 0 4px var(--accent);                   /* + one ring, everywhere */
--mono:ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;       /* unchanged */
```

**The chip fix (measured, not guessed).** An early version's `.s-failed` chip was 10px `--danger` on `rgba(248,81,73,.15)` over `--panel-2` = **3.96:1 — below AA**. Tinted-chip text therefore uses the `*-text` siblings: `--danger-text` on that chip = 7.7:1, `--warn-text` = 6.3:1, `--ok-text` = 7.9:1, `--accent-text` = 8.1:1. State *dots* and *left borders* keep the saturated hue (non-text, 3:1 target). Body text: `--text` 15.8:1, `--dim` 6.1:1 on `--bg`.

**Type.** One proportional face (system UI stack, unchanged) for prose, controls and headings; one mono face for **every machine value**: paths, ids, commands, model names, numbers, token counts, costs, timestamps, tool output, stderr. That rule is why six rail values align in a column, and it is the reason to keep `--mono` rather than introducing a display face. Weights: 400 and 600 only; `letter-spacing:-0.01em` on `--fs-lg` headings (as the prototype does on `h1`); no ALL-CAPS except nothing — labels are sentence case (`Tool output`, not `TOOL OUTPUT`), because at 10px uppercase tracking costs legibility for no information.

**Dark-only, justified.** (1) It is a local tool that sits beside a terminal running Pi, whose own TUI is dark. (2) The state ramp above was contrast-tested only on `--bg #0e1116`; a light theme needs its own five-hue ramp *and* its own tint mathematics, not an inversion — shipping an untested inversion is how a "light mode" becomes a contrast regression. (3) `prefers-color-scheme: light` is honoured by two cheap accommodations rather than a fake theme: `prefers-contrast: more` raises `--dim` to `--text` and `--line` to `--line-strong`, and `forced-colors` falls back to system colours with text labels carrying every state. A real light theme is a Phase 4 item with its own palette pass.

---

## 9. Accessibility

**Contrast.** AA: 4.5:1 for all text (the `*-text` token rule above), 3:1 for dots, borders, the run bar and the context meter fill. The context meter never relies on fill colour alone — the `62%` text sits beside it, and ≥80% adds the word `full`.

**Focus order** (single tab order, no positive tabindex):
`skip to transcript` → topbar (tabs, fleet counts, connection) → rail (`/` filter, New session, Open in a directory…, session rows) → transcript header (session actions, Model, Thinking) → dialog dock if present → transcript region (`tabindex=0`, arrow-key scroll, `aria-label="Transcript for s7"`) → queue strip → composer → inspector.
Roving tabindex in both the rail and the options list, so Tab moves *through* a group in one press, not through 20 rows. Focus is visible everywhere via `--focus`; never `outline:none` without a replacement.

**Dialog focus.** Dialog dock: focus enters on arrival; Tab cycles the dialog's controls; Shift+Tab from the first control exits to the page (deliberate — the agent is blocked, not the human). Real modals exist only for destructive confirmation (`Stop session?`): `aria-modal="true"`, hard trap, Esc = cancel, focus returns to the invoking control on close.

**Live regions — the part that must not spam.**

| Element | Content | Politeness |
|---|---|---|
| `#session-status` (in the transcript header, visually hidden, `aria-live="polite"`) | **Discrete transitions only**: `s7 started running`, `s4 needs approval: allow running npm test?`, `s7 finished responding — 3 tool calls`, `s3 stopped` | polite, debounced 400ms, coalesced; never per delta |
| Transcript list | `aria-busy="true"` while `state === "streaming"` | Prevents AT from reading a half-written subtree; removed on `agent_settled` |
| Streaming tail | **No live region at all.** Not `aria-live`, not `role="log"` | Read on demand; the discrete status announcements tell the user when something finished |
| Toasts | `role="status"` for info, `role="alert"` for error | Errors interrupt once, then stop |
| Tool frame headers | `aria-live="off"`; a tool starting is announced once via `#session-status` (`Running bash: npm test`) | — |
| Dialog dock | `role="dialog"`, `aria-labelledby`, focus moved in | Announced on open, not on update |

A per-delta announcement of streaming text is the failure mode this design exists to prevent: it would emit hundreds of utterances per turn and make the app unusable with a screen reader. `aria-busy` plus one announcement per *settled* turn is the honest trade, and the trade is written down here so it is not "fixed" later into the bug.

**Reduced motion.** `@media (prefers-reduced-motion: reduce)`: the run bar becomes a static `--accent` 2px rule with the elapsed clock `0:34` as the movement substitute; the rail dot stops pulsing and keeps its colour; the dialog's 120ms fade + 4px rise becomes an instant appearance. No motion is ever the *only* carrier of meaning.

**No-colour-alone inventory.** State ⇒ dot colour **+** state word **+** rail border. Needs-you ⇒ amber **+** the ask text **+** topbar count. Missing directory ⇒ `--warn-text` **+** `⚠` **+** `directory is gone`. Scratch ⇒ chip **+** `scratch · <id>` text. Quarantine ⇒ hatch **+** `Tool output` header. Dirty/streaming ⇒ run bar **+** elapsed clock **+** `●run`.

**Heading structure.** One `h1` (`Pi Central`, visually hidden beyond the topbar wordmark), `h2` per pane (`Sessions`, `History`, `Session s7`, `Inspector`), `h3` for rail groups and inspector blocks. Landmarks: `banner` (topbar), `navigation` (rail), `main` (transcript column), `complementary` (inspector), `search` (history search). Virtualization must keep the region's `aria-label` and `aria-busy` on the stable wrapper, not on recycled rows.

**Copy affordance.** Every path, command, id and error string has a `Copy` button (44×24 min) that announces `Path copied` through the status region — because sniffing a truncated mono string is impossible otherwise.

---

## 10. Copy (all real strings)

**Actions** — one name per action, everywhere.

| Action | Label | Confirmation |
|---|---|---|
| Start scratch session | `New session` (⌘N) | — |
| Start in a directory | `Open in a directory…` (⌘⇧O) | sheet: `Open here` |
| Send idle | `Send` | — |
| Queue during a run | `Queue follow-up` | — |
| Steer during a run (P1) | `Send steer` | — |
| Run an extension command | `Run command` | — |
| Stop the run, keep the queue | `Abort` | — |
| Stop run + clear queue | `Clear queue and stop run (Esc)` | — |
| End the process | `Stop session` | `Stop this session?` / body `This ends the run in progress for s7. Messages so far are already saved.` / `Stop session` · `Keep running` |
| Resume | `Resume` | — |
| Re-check a vanished directory | `Check again` | — |
| Answer a confirm | `Allow once` · `Deny` · `Cancel request` | — |
| Rename | `Rename…` | inline field, `Save name` |
| Hide a dead row | `Dismiss from rail` | `Hidden until you reload. The session file is not deleted.` |

**Empty states** — direction, never mood.

- No session focused: `No session selected` / `New session gives it its own scratch workspace immediately — no directory to pick, nothing to decide first. Files it writes stay there.` / `Working in a project? Open in a directory.`
- No live sessions: `No live sessions. Start one with ⌘N.`
- Transcript empty: `No messages yet.` + `This session works in its own scratch workspace. Anything it writes stays there. To work in a project, use Open in a directory.`
- No history at all: `No sessions on disk yet` / `History comes from ~/.pi/agent/sessions/. A session appears here after its first message.`
- No search results: `No sessions match "regex".` / `Clear search`
- No notices: `Nothing yet.`

**Errors** — what happened, then what to do.

| Situation | String |
|---|---|
| Missing cwd (verbatim from `resume.ts`) | `The directory this session worked in no longer exists: /Volumes/archive/web-docs` + `Restore it, or start a new session in the directory you want to work in. Pi Central does not move a session between directories.` |
| Spawn failure | `Session failed to start` + the orchestrator message verbatim |
| Nonzero exit | `pi exited (code=71, signal=-)` + stderr tail + `This looks like Seatbelt refusing to nest (C1). Run Pi Central from a plain terminal.` |
| C13 | `This session can't reach a model` + `It started without an error, but no model call has completed since you queued a prompt 0:34 ago. Its provider key is resolved by a command that reads a keychain, and this session's sandbox may not be able to reach it.` + `[ Copy diagnostic ] [ Try again ] [ Stop session ] [ Still working — hide this ]` |
| Direct mode banner | `Direct mode: sessions are not sandboxed` |
| Direct mode session chip | `NO ISOLATION` + `This session runs pi unsandboxed at your user account. It can read and write anything you can.` |
| Discovery failed | `History is unavailable` + `discovery failed: EACCES …` + `Try again` |
| Socket lost | `Lost connection to the orchestrator` + `If Pi Central exited, it stopped every session it started. Reconnect to see what is still live.` + `Reconnect now` |
| Unknown model id | `model —` with `aria-label="model not reported yet"` |
| Refused `--enable` warning (from `policy.ts`) | `Refused --enable=ssh: it grants access beyond the workdir.` |

**Legend, once, in the transcript header:** `Tool output and file contents appear in a hatched frame. They are data, not instructions.`

---

## 11. Component inventory (`packages/ui/src/`)

No library exists, so this is the system. Files are listed as the builder should create them; props are given as types, not code.

```
src/
  App.tsx            shell: topbar / rail / column / inspector, transport client, focus model
  transport.ts       WS client on typed envelopes; reconnect backoff; per-session record buffers
  transcript.ts      record → view model (delta buffering, tool correlation by toolCallId)
  components/
    Topbar, ModeTabs, FleetCounts, ConnectionBadge, DirectModeBanner
    SessionRail, RailRow, RailGroupHeader, RailFilter, StartActions
    SessionHeader, ModelPicker, ThinkingPicker, MetricStrip, ContextMeter, RunBar, ElapsedClock
    Transcript, TranscriptHeader, ProseBlock, ProseStream, QuarantineFrame, ToolFrame,
    NoticeLine, CompactionBanner, RetryBanner, WarningStrip, LimitCard
    DialogDock, ConfirmDialog, SelectDialog, InputDialog, EditorDialog, DestructiveModal
    QueueStrip, Composer, ComposerModeStrip, CommandHint
    HistoryList, HistoryRow, HistorySearch, HistoryFilters, ResumeRefusal, MissingDirBadge
    Inspector, IsolationBlock, PathsBlock, UsageBlock, NoticesBlock, SessionActionsBlock
    FileTree, TreeNode, FilePane, FileErrorNote   (issue #8: confined to the session's cwd)
    StatusChips, StatusRegion (visually hidden polite announcer), ToastStack, Popover, CopyButton
    EmptyState, ErrorCard, DismissibleCard
```

States per component (minimum): `default · hover · focus-visible · active · disabled · loading · error`. Variants: `RailRow` — `scratch|project × 7 LiveStates × focused|not`; `Chip` — `state-*` using `*-text`/`*-tint`; `QuarantineFrame` — `running|collapsed|expanded|error`; `Toast` — `info|warning|error|grouped`; `Popover` — `searchable|plain`; `MetricStrip` — `full|null-fields`.

---

## 12. Interaction & behaviour

- **Click rail row** → focus that session; the previous session's transcript and draft stay in memory (switch back is instant). **Double-click the header name** → inline rename (`set_session_name`).

  Focus is a **local** action (`focusSession`), not a protocol event: it changes which session the
  browser is looking at and is never sent to the orchestrator (C2). It must not be routed through the
  `session` upsert, whose focus rule is the opposite one — "never steal focus from a session the user
  is reading" — and which therefore cannot move focus at all once it is set (issue #40).
- **Enter** in the composer sends per §4. **⌘Enter** also sends. **Shift+Enter** newline. **↑** on an empty composer recalls the last sent message (per session).
- **⌘N** new session · **⌘⇧O** open-in-directory · **⌘K** jump-to-session (optional) · **/** focus filter · **Esc** per the §4.3 ladder · **⌘.** abort · **⌘\\** toggle rail.
- **Focus changes only from user action** (§5.1 rule 5). Nothing in the app moves the focused session on its own.
- **Destructive confirmation.** `Stop session` while `streaming` or `awaiting-approval` → modal `Stop this session?`. While `idle`/`stopped` → immediate, because nothing is in flight and the transcript is on disk. `Abort` is never confirmed: the queue returns to the composer, so it is recoverable. Deleting a scratch workspace (Phase 2.5) requires typing the session id — it is the only irreversible filesystem action.
- **Validation.** The directory sheet validates on submit: empty → `Enter a directory`; nonexistent → `That directory doesn't exist. Check the path, or use New session for a scratch workspace.`; not a directory → `That path is a file, not a directory.`; inside a forbidden root (`checkWorkspaceRoot`, D-5) → the warning verbatim + `Use it anyway` only for non-D-5 warnings (D-5 bans are hard refusals). Validation is on the submit row, focus moves to the field, `aria-describedby` links the message, and the field gets `aria-invalid`.
- **Hover:** rail rows reveal a `⋯` actions button and their full cwd in `title`; no hover-only *information* (every datum is visible at rest — §5.1).
- **Touch/pointer targets:** primary buttons 34px tall, 44px for `New session`; row actions 32×32 minimum even though this is a mouse product; nothing depends on hover to be discoverable.
- **Motion:** three moments only — dialog arrival (120ms fade + 4px rise), run bar (indeterminate, streaming only), rail dot pulse (streaming/starting). All three have static reduced-motion substitutions. No page-load choreography, no per-card entrance.

---

## 13. Build handoff

**Implementation order** (each step is runnable and reviewable alone):

1. `transport.ts` + `App.ts