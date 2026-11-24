# ADR-0019 — A preference belongs to the installation, not to a browser origin

- **Status:** Accepted
- **Date:** 2026-11-22
- **Opened by:** issue [#285]
- **Related:** ADR-0013 §4 (the shell never picks a port), ADR-0006 (one origin serves the UI and the socket),
  issue #185 (the orchestrator's state root), issue #265 (the model scope, the preference the report is about),
  [C14](../CONSTRAINTS.md) (a failed read is not an empty result)

## Context

Twelve of this app's settings lived in `localStorage`: the reader's chosen models, the roster's contents and order,
the rail's width and folds, the panel's mode and width, the transcript's size and measure, the trace's prefs and
ordering, the last chooser directory, and the reload bookkeeping. Each was validated on read, each had its own key,
and each was correct.

They were all lost on every launch of the desktop app, and nothing reported it.

The mechanism is three lines of configuration that are each individually right:

| Step | Where |
| --- | --- |
| The shell launches the orchestrator with `--port 0` — the RULE, not a default | `orchestrator-process.ts:194-196, 244` |
| `--port 0` asks the OS for any free port, so the port differs every launch | `server.ts:65` |
| The window loads the UI from `http://127.0.0.1:<that port>` | `main.ts:721-722, 947` |
| `localStorage` is partitioned **per origin**, and an origin includes the port | the browser |

So the store the reader wrote to on Monday was `http://127.0.0.1:51234`, and Tuesday's launch read
`http://127.0.0.1:61802`, which had never seen them. The write succeeded, the read returned `null`, and every parser
did exactly what it was written to do: degrade to its default. The picker offered the full catalogue "as though the
reader had never chosen anything", which was true.

Three facts made this hard to notice, and each is worth stating because they are the reason the bug survived a year:

1. **The CLI and `npm run server` are stable origins.** `pi-central --port 8787` persists preferences perfectly. The
   defect is specific to the shell, which is the surface a reader uses every day — and the surface nobody tests by
   relaunching.
2. **Nothing failed.** No exception, no log line, no empty state that looks wrong. A preference store that is read
   from an empty bucket is indistinguishable from a first run.
3. **"The roster came back reordered" (#270) reads like a sort bug.** The roster was rebuilt from the live sessions
   in spawn order because the stored list was never there. A missing store and a changed order look identical from
   the outside, which is why #285's acceptance criteria ask for the whole set of keys rather than the reported one.

## Decision

**Preferences are kept by the orchestrator, in its own state root, and read and written over the socket**
(`getPrefs` / `setPrefs` controls, `prefs` / `prefsError` events, `PROTOCOL_VERSION` 13).

The orchestrator has the one property a browser origin lacks: its identity does not depend on the port. It serves the
*installation*, and its state root (`~/.config/pi-central`, or the dev tree — `docs/APP-SHELL.md` records the split)
already outlives restarts and updates for the open-session list (#185). Preferences live beside that, in
`preferences.json`.

Concretely:

1. **One store, one file, one writer.** `prefs-store.ts` on the orchestrator side keeps `Record<string, string>` in a
   versioned document, written temp-then-rename. Whole-map writes, because a per-key write is a chance for two
   surfaces to hold different halves of one value and a merge would then have to decide which half wins — and because
   a merge makes a DELETION inexpressible.
2. **The orchestrator validates only what would damage the store** — the key shape, a per-value cap, a total cap, and
   that a value is a string. It does not know what a model reference is. That judgement stays with the module that
   owns the preference (`model-scope.ts`, `rail-prefs.ts`, `panel.ts`, …), where it is also tested, so validation on
   read is **unchanged** and there is still exactly one place each format is decided.
3. **The page keeps a synchronous local copy** (`PrefsStore` in the UI), seeded once at load. Callers stay
   synchronous, so the twelve call sites kept the `localStorage.setItem`-shaped code they had; what changed is where
   the string comes from and goes.
4. **Three homes, chosen once per page, in this order.** The installation when it answers; `localStorage` when the
   peer is too old to have the feature (`supportsPrefs`, so an older orchestrator is not asked a question it would
   answer with `bad control: unknown kind 'getPrefs'`); `localStorage` again when no answer came, so the values the
   reader already had are still there. Within either real home the installation wins, and a key only the old store
   holds is **carried over and written back** — the reader's real preferences from the release before this one, and
   dropping them would punish them for our bug.
5. **A store that cannot persist says so, once.** `memory` (no installation and `localStorage` refusing: private
   mode, a full quota) is stated at load, in Settings and in the error strip. Twelve preferences each reporting the
   same condition would be noise that trains the reader to ignore the strip, so there is one message and a flag that
   never re-arms.

## Consequences

**What this buys.** A model scope chosen in the desktop app is there after a quit, a relaunch and an update, with no
origin-dependent step. So are the roster, the rail, the panel, the transcript, the trace and the chooser. The CLI at
`http://127.0.0.1:8787` and the app now read the SAME map, so the divergence between surfaces is gone rather than
stated. And the twelve writes stopped being twelve separate bets on a browser keeping a value.

**What it costs, stated plainly.**

- **Preferences are per INSTALLATION, not per browser profile.** Two people sharing one machine share one set. A
  reader in two browsers sees one answer. That is a real change in meaning and the reason it is recorded here rather
  than in a comment.
- **A write is now a round trip.** Batched on a 500 ms timer, so a drag is one `setPrefs` rather than forty — but a
  reader who quits within the window loses that one change, and nothing else.
- **Two new wire kinds each way, and a version bump.** A v12 orchestrator is not asked (see point 4), so a reader
  running two versions keeps the per-origin behaviour until both halves are updated — stated in Settings rather than
  left to be discovered on the second launch (`docs/ARCHITECTURE.md`, "The origin is not an identity").
- **The shell's port choice is untouched.** ADR-0013 §4 stands: `--port 0` is still the rule, and
  `orchestrator-process.test.ts` still pins it. The fix went around the port rather than through it, which is the
  only direction that does not reintroduce `EADDRINUSE`.

**A corrupt file is reported, never read as "nothing chosen".** This is the one place forgiveness is wrong: an empty
map means "you have never chosen anything", which is a false statement about the reader's own settings, and it would
invite the next write to replace whatever is really in the file. So `readPrefs` returns a reason
(`unsupported` / `unreadable` / `corrupt`), the page keeps what it holds, and the message says the file was not read
— the same distinction C14 draws about a transcript.

## Alternatives considered, and what each cost

1. **Hard-code 8787 in the shell.** Forbidden, and not mildly: ADR-0013 §4 removed the shell's port choice because
   that is how the `EADDRINUSE` class was made unreachable. Reintroducing it would trade a preference for a class of
   startup failure on a machine where 8787 is busy — a worse defect in exchange for a smaller one.
2. **A fixed port with a bounded retry list, recording which one was used.** Narrows the window and does not close it:
   the origin still changes the day the port is taken, and the preference vanishes exactly then, silently, which is
   the failure mode this ADR exists to end.
3. **Carry `localStorage` across origins** — remember the last port, open the old origin off-screen, read its store,
   re-seed the new one. A second web contents per launch purely to read storage; brittle the first time the old
   origin's child is gone; and it makes every launch depend on the previous one having succeeded.
4. **Serve the UI from a custom protocol (`app://ui`)** with the socket on loopback. A stable, meaningful origin
   forever. Traded away: ADR-0006's same-origin `connect-src 'self'` claim, and every relative URL and fetch in a UI
   of 266 chunks would have to be rechecked. A decision on its own scale, not a slice of this one.
5. **Keep `localStorage` and warn the reader.** Honest, and it leaves the defect in place: the warning would have to
   fire on every launch of the desktop app, which is every launch.

## What would prove this wrong

- **A reader on a fresh install who finds preferences from someone else's session on the same machine.** Then
  per-installation is the wrong granularity and it needs a per-OS-user or per-app-account key.
- **A preference that does not survive a quit immediately after the drag that set it**, more often than the batch
  window explains. Then the flush interval is the problem, not the store.
- **A `preferences.json` that grows without bound, or a write that fails on a full disk and is retried forever.**
  Then the caps are wrong or the failure is not being reported as a failure.
- **A reader whose settings change between two windows of the same installation without either of them being touched.**
  Then a broadcast has crept back in where the answer must be per-asker.
- **#270's reordering surviving this fix.** Then it was a sort rule after all, and the two issues merely overlapped.

[#285]: https://github.com/sven1103-agent/pi-central/issues/285
