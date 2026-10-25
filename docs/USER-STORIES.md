# User stories

What users need from Pi Central, and why. Stories are grouped by theme; each carries
acceptance criteria and, where the architecture constrains the answer, a pointer to the
relevant constraint or ADR.

The stories came from using the [prototype](../prototype/). They are deliberately written
from the user's side, before deciding how to build them.

**Status:** `proposed` → `accepted` → `built` → `verified`. Nothing here is built yet.

---

## Theme A — Starting work is the critical path

The prototype's hardest moment is its first moment: it asks for an absolute path before it
will do anything. That is a poor greeting, and it exposes an implementation detail (a
working directory, and therefore a sandbox) as a precondition of "hello".

### US-1 — Start a session without choosing a directory
**Status:** proposed · **Theme:** A · **Priority:** high

> As a user, I want to start a session immediately, without pointing at a working
> directory, so that I can begin working in one step.

**Context.** This was the first friction observed in the prototype: the only action
available is a form whose required field is a filesystem path. A user who just wants to ask
a question has to decide where the session should live before knowing whether they want to
keep it.

**Acceptance criteria**

- A single primary action starts a session with no path entry.
- The session is usable immediately: a prompt can be sent on the first interaction.
- The UI states plainly where the session lives, without requiring the user to choose it.
- If the user later wants the session to live somewhere specific, they open a session in
  that directory (US-2, which would have migrated a running session, is rejected by
  [ADR-0008](decisions/0008-no-mid-session-workdir-change.md)).

**Constraint.** A session is bound to a working directory at spawn (C2), and its Safehouse
policy is composed from that directory (ADR-0004). "No directory" therefore cannot mean
"no policy" — it must mean a **default directory that Pi Central owns**. See US-4.

### US-2 — Set the working directory in one step
**Status:** rejected · **Theme:** A · **Priority:** withdrawn

> As a user, I want to change where a session works without restarting it or losing its
> context, so that I can start somewhere convenient and move to the right place once I know
> what I am doing.

**Rejected by [ADR-0008](decisions/0008-no-mid-session-workdir-change.md).** The
working directory is the sole input to the sandbox policy, so changing it mid-session is a
live policy swap — the one operation that lets content already read in the old scope
influence a differently-privileged new scope. The design note below also rested on a false
premise: `cwdOverride` is **not** reachable over RPC.

**What replaces it:** starting a session in the right place is cheap
([US-1](#us-1--start-a-session-without-choosing-a-directory)), so the answer is a new
session there, not a migrated one. Context does not carry over, and that cost is accepted.

<details>
<summary>Original story, retained for the record</summary>

**Context.** The prototype can only set the directory at spawn. A user who starts in the
default directory and then realizes the work belongs in a repository has to abandon the
session.

**Acceptance criteria**

- A directory can be chosen from the UI: a recent list, a picker, or a typed path.
- Choosing a directory **re-establishes the session's sandbox** for that directory; the
  previous policy is not silently retained.
- Conversation context carries over, so the user does not repeat themselves.
- The UI makes clear that isolation changed, and to what.
- A directory that does not exist, or is not readable, is refused with a clear message
  before anything is spawned.

**Design note.** Because the policy is derived from the directory, this is not merely a
setting change: it is a re-spawn with a new policy. Pi supports the two building blocks:

- **Resume with a new cwd** — `switch_session` accepts a `cwdOverride`; the runtime reopens
  with the session header's cwd otherwise (C2). *This is incorrect; see ADR-0008.*
- **Continue in another directory** — `SessionManager.forkFrom(sourcePath, targetCwd, …)`
  copies the history into a session whose header carries the new cwd. Verified in
  `dist/core/session-manager.js:1374`.

Which one US-2 uses is an open design question, not a user-facing one. The user-facing
requirement is only: context survives, and isolation follows the new directory.

</details>

### US-3 — The default directory is owned by the app
**Status:** proposed · **Theme:** A · **Priority:** high

> As a user, I want the default working directory to belong to Pi Central, so that
> throwaway sessions do not scatter files into my home directory or my real projects.

**Context.** If "start without a path" silently defaulted to `$HOME` or the current shell
directory, the sandbox would grant write access to a large, important tree. That is both
surprising and unsafe: a scratch question should not hold a policy over the user's home.

**Acceptance criteria**

- The default directory is a dedicated, app-owned location, not `$HOME` and not the
  orchestrator's cwd.
- Its Safehouse policy grants only that directory — a scratch session cannot write to the
  user's home or projects.
- Sessions created there are visibly marked as scratch/default, so they are never confused
  with a session working in a real project.
- The location is configurable and reported by the UI.
- Deleting a default session's files is offered as an explicit action; nothing is deleted
  implicitly.

**Suggested default.** `~/.local/share/pi-central/workspaces/<session-id>/` or similar.
Exact path is an [open question](OPEN-QUESTIONS.md).

**Constraint.** The base Safehouse profile grants `/tmp` and `/var/folders` globally, and
grants `~/.pi` read/write to every session (C6). The default workspace must **not** be
under any of those, or "owned by the app" would be a fiction and a cross-session leak would
be possible.

---

## Theme B — History is an asset, not an archive

The prototype lists recent sessions on disk but cannot open them. It shows 40 rows of
tantalizing history that do nothing when clicked. History that cannot be resumed is just a
log file.

### US-4 — See past sessions, richly
**Status:** proposed · **Theme:** B · **Priority:** high

> As a user, I want to find a past session by what it was about, not by its filename or
> timestamp, so that I can pick up work I abandoned.

**Context.** The prototype shows the first user message and a timestamp. Real history needs
more: which project it belonged to, how much work it contains, whether it is still active,
and how to search it.

**Acceptance criteria**

- Sessions are browsable and searchable by content, not just by name or date.
- Each entry shows its project/working directory, when it was last touched, its size, and
  its opening request.
- Sessions from all projects are reachable in one place, since discovery reads every
  project directory under `~/.pi/agent/sessions/` (ADR-0009)
- A session that Pi Central started can be live; one only on disk is history. The
  distinction is visible at a glance (see C3: Pi has no attach protocol).

### US-5 — Continue a past session
**Status:** proposed · **Theme:** B · **Priority:** high

> As a user, I want to continue a session I started earlier, with its full context, so that
> I do not have to reconstruct what I was doing.

**Context.** This is the counterpart to US-1: starting fast is only useful if the work can
be found and resumed later.

**Acceptance criteria**

- Selecting a historical session resumes it with its conversation intact.
- The resumed session's sandbox is composed for **its own recorded working directory**, not
  the orchestrator's and not the last-used directory.
- The user can see which directory a session will resume in before confirming.
- If that directory no longer exists, the UI explains this and offers a choice: **cancel**,
  or resume in the recorded directory once it is restored. It must not fail with a raw
  error, and it must not silently retarget ([ADR-0008](decisions/0008-no-mid-session-workdir-change.md)).

**Design note — the missing-directory case is a real trap.** Pi's behavior differs by mode,
verified in `dist/main.js:558`:

- **interactive** → Pi prompts: "continue in current cwd" or cancel
- **print / JSON / RPC** → Pi writes `MissingSessionCwdError` to stderr and **exits 1**

Because Pi Central drives Pi in **RPC mode**, resuming a session whose directory was
deleted or renamed (a finished worktree, an unmounted volume, a moved checkout) makes Pi
exit rather than adapt. Pi Central must therefore check the recorded cwd itself *before*
spawning, and present the choice in the UI. Discovery alone is not enough — the cwd must be
validated at resume time, not at list time.

### US-6 — Name and organize sessions
**Status:** proposed · **Theme:** B · **Priority:** medium

> As a user, I want to name sessions and group them by what they belong to, so that the
> list stays meaningful as it grows.

**Acceptance criteria**

- A session can be named or renamed from the UI (`set_session_name` exists for this).
- Unnamed sessions get a useful generated label rather than a UUID.
- Sessions group by project by default.
- Void/stale sessions can be dismissed from the view without deleting the underlying file.

---

## Derived requirements

These fell out of the stories and constrain the design.

| # | Requirement | Bears on |
|---|---|---|
| D-1 | Every session has a policy before it spawns; "no directory" resolves to an app-owned default | US-1, US-3, ADR-0004 |
| D-2 | Changing the working directory is **not** supported; a session's directory is fixed at spawn | US-2 (rejected), ADR-0008, C2 |
| D-3 | ~~Conversation context survives a directory change~~ — obsolete with US-2 rejected | US-2 (rejected) |
| D-4 | The recorded cwd is validated before every resume | US-5, C2 |
| D-5 | The default workspace is outside `$HOME` proper, `/tmp`, and `~/.pi` | US-3, C6 |
| D-6 | Live (spawned by Pi Central) and historical (on disk) sessions are distinguished | US-4, C3 |

## Open questions raised by these stories

1. **Default workspace location and lifetime.** Where does it live, and when are its files
   cleaned up? A session in a scratch directory is still an on-disk session that appears in
   discovery forever.
2. **Cross-project resume.** Should a session recorded in `/repo-a` be resumable while the
   dashboard is "focused" on `/repo-b`? This follows from C2 (each resume is its own
   process) but has UI consequences.
3. **Directory change mechanics.** **Resolved and rejected:** Pi Central does not change
   a session's working directory. `cwdOverride` is not available over RPC, and automatic
   `forkFrom` is a live policy swap that leaks a session file. See
   [ADR-0008](decisions/0008-no-mid-session-workdir-change.md).
4. **Bulk cleanup.** How does a user retire 40 stale sessions? Per-session dismissal (US-6)
   is one answer; is anything more needed?
