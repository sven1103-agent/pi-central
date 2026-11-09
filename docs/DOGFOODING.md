# Using Pi Central to develop Pi Central

Yes — and it is worth doing, because the fastest way to find this tool's problems is to depend on
it. But **not from the checkout you are working in.** This document explains what breaks, and what
to do instead.

## What breaks if you run it from the checkout an agent is editing

Three failures, in the order you would hit them.

**1. The UI you are using gets replaced by the UI being edited.** `npm run ui:dev` runs Vite's dev
server, which watches `packages/ui/src` and hot-reloads the browser. An agent editing a component
therefore reloads the interface out from under you — and mid-edit that means a syntax-error
overlay instead of a dashboard.

This one is now **avoidable**: the orchestrator serves a built UI itself (issue #24), so
`npm run ui:build && npm run server` gives a dashboard with no watcher at all. The dev server is
still the right tool for editing the UI deliberately, with `npm run server -- --no-ui` on the other
side.

**2. A branch switch desynchronises the two halves.** The UI and the orchestrator share
`@pi-central/protocol`, and Vite resolves it to the protocol source on disk. If the checkout moves
to another branch, the UI is built from branch B while the running orchestrator is branch A. The
mismatch is *detected* — the client compares `PROTOCOL_VERSION` on `hello` and reports a protocol
mismatch rather than silently misrendering — but a detected mismatch is still a broken dashboard.

That detection only works if the version was **bumped when the wire changed**, and that is the step
that gets missed: adding a kind breaks nothing locally, because the author's UI and orchestrator are
the same commit. Issue #8 added five kinds (`listFiles`, `readFile`, `files`, `file`, `fileError`)
and left `PROTOCOL_VERSION` at 1, so the handshake agreed and the real complaint arrived later and
elsewhere — `bad control: unknown kind 'listFiles'` on the first expanded directory. If you see an
unknown kind, the fix is to **restart the orchestrator** (see #3 above) so both halves are one
commit; if the restart does not clear it, the version was not bumped and both halves need updating.
`packages/protocol/test/wire-surface.test.ts` now pins the kind set against the version so this
cannot recur silently.

**3. If the agent breaks the orchestrator, you lose the tool you need to fix it.** Node caches
ESM modules after loading them, so a running orchestrator mostly survives edits to its source. The
next *restart* is the problem: it loads whatever is on disk. If that does not start, Pi Central is
unavailable precisely when you want it to supervise the repair.

There is a fourth, quieter one: two writers on one checkout. Two sessions editing the same working
tree lose each other's changes in ways neither can see.

**5. Every one of those presents as "the fix did not work".** That is the expensive symptom, and the
question it raises — *is the UI I am looking at the code I just built?* — has two answers, in two
places. Neither is on the main surface, deliberately: a commit hash in the product's chrome is a dev
artefact in a shipped UI, and released applications keep this in About for the same reason.

| question | where to look |
|---|---|
| What is the tab **running**? | **Settings → This build**: the commit and build time of the UI in this tab. |
| What is the orchestrator **serving**? | The startup log: `UI build: assets/index-<hash>.js (built …)`. |

If those disagree with what you just built, the page is stale — hard-reload it, and if that does not
change the stamp, the orchestrator is serving an old `dist/`.

Three things are worth knowing about how to read that:

- **The commit, not the version.** `pi-central --version` reports the *package* version, which is the
  same for every build of it — which is exactly why it cannot answer this question. (The version number
  is deliberately not written down here; see `docs/RELEASING.md` for why prose must not state it.)
- **A rebuild does not update an open tab.** `index.html` is `no-cache` and hashed assets are
  `immutable`, so the *server* is right, but a page that has already fetched its entry bundle keeps it
  for the life of the tab. Hard-reload.
- **Installed as a PWA** (issue #119), the same applies and more so: the service worker never caches
  `index.html`, but a worker update lands on the next launch rather than mid-session, on purpose — see
  the note in `public/sw.js` about `skipWaiting`. The page does reload itself when it comes back into
  view and it knows it is stale (#213), which covers the dock-icon-click case #184 was filed for; a
  window that was on screen the whole time still needs the banner's Reload button, because nothing told
  it anything had changed.

## Pi Central now says so

This used to be advice you had to have read. Pointing a session at the running checkout is now
surfaced twice: the "Open in a directory" sheet warns as you type the path, and the warning stays on
the session row afterwards. It names the three consequences above rather than just the condition,
and it does **not** block — you may have a good reason, and the point is to inform the decision
rather than to make it.

There is one case it deliberately stays quiet about: a **sibling clone** (`pi-central-dev` beside
`pi-central`) is the recommended setup and is protected by the sandbox, so warning about it would
train you to dismiss the warning. If the running installation cannot identify its own directory, the
startup banner says so — an unidentifiable path is reported as unknown, never as safe.

## What to do

**Run Pi Central from one checkout. Let agents work in another.**

```bash
cd ~/git/idea-factory
git clone git@github.com:sven1103-agent/pi-central.git pi-central-dev

# from the STABLE checkout, the one no agent may touch
cd pi-central && npm install && npm run ui:build && npm run server
```

One process, one URL. Add `npm run ui:dev` only when you are deliberately editing the stable
checkout's UI, and start the server with `--no-ui` in that case so the two do not both claim `/`.

Then `⌘⇧O` and point a session at `~/git/idea-factory/pi-central-dev`.

A session is sandboxed to its working directory, so an agent in `pi-central-dev` **cannot write to
`pi-central` at all**. Sibling directories are denied — that is the property
[`verify-three.ts`](../packages/orchestrator/verify-three.ts) checks with twelve cross-directory
probes, not an assumption. With no dev server running on the stable checkout, nothing replaces the
UI you are using.

## Use a clone, not a worktree

A worktree looks like the tidy answer — one repository, several checkouts — and safehouse supports
it. When the working directory resolves to a linked worktree root, safehouse grants
**read-write** on that worktree's *shared git common dir*, because git commands cannot work
otherwise. Two consequences follow, and both are the reason to prefer a clone:

- **The agent can rewrite the repository's refs.** Sharing `.git` means sharing `refs/`, the object
  store, and worktree bookkeeping. An isolated file tree with a shared ref store is not isolation
  of the repository.
- **Sibling worktrees are readable.** Safehouse's default worktree integration leaves other
  worktrees' *files* read-only rather than invisible, so one session can read another's checkout.

A clone shares nothing: its own `.git`, its own `node_modules`, its own everything.

## The git side is already guarded

Even in a separate clone, an agent pushing to the shared repository cannot reach `main`. The
branch ruleset requires a pull request and both CI checks, and bypass actors are empty, so the
rules bind administrators too. An agent's work therefore *has* to arrive as a slice:

```
git push  ->  remote: - Changes must be made through a pull request.
```

That is the useful half of dogfooding: the agent developing Pi Central must use the workflow Pi
Central's own repository enforces.

Note that a session commits as the **agent identity** (`~/.agent`), not as you. All sessions share
one agent identity by design — see [ADR-0010](decisions/0010-agent-credential-identity.md).

## Rules that keep this working

1. **One writer per checkout.** Never point two sessions at the same clone.
2. **The stable checkout is for running, not for editing.** Make changes through a slice, merge,
   then `git pull` in the stable checkout and restart.
3. **Expect a restart after merging a protocol change.** The UI and orchestrator must come from the
   same commit; a running pair cannot span a protocol change.
4. **Do not run `npm run server` from an agent's checkout** while the stable one is running. Port
   `8787` is taken, and the failure is an `EADDRINUSE` that looks like a bug in the agent's work.

## "I rebuilt, but nothing changed"

Two causes, and neither is a stale build — the build itself is reliable. Check them in this order.

### 1. You are looking at a globally installed copy

`npm install -g pi-central` puts a complete copy at, for example,
`/opt/homebrew/lib/node_modules/pi-central`, with its **own** pre-built `dist/ui`. `pi-central` on
`PATH` runs that one. A `npm run ui:build` inside a checkout changes nothing it can see.

```bash
which pi-central        # if this is not your checkout, that is the answer
npm root -g             # where the global copy lives
grep -o 'tool-marker-summary:hover{[^}]*}' "$(npm root -g)"/pi-central/dist/ui/assets/*.css
```

Compare that last line against the same grep run on the built CSS in the checkout (`dist` is
gitignored, so it exists only after a build). If they differ, you are running the wrong one. Serve
the checkout instead:

```bash
npm run ui:build && npm run server
```

…and open the URL **that command prints**. A tab already open from the global install is a different
origin and will keep showing the old UI.

### 2. You are on `main`, and the change is on a branch

Anything not yet merged does not exist on `main`. This is easy to get wrong because a slice is
reviewed by checking it out, so "check it out" means "switch branches":

```bash
git log --oneline -1        # which commit am I actually on?
git branch --show-current   # and therefore which slice
```

### Read the banner — it answers this without any of the above

`npm run server` prints the identity of the bundle it is serving:

```
  UI build: assets/index-KF2xCvYb.js
```

and **Settings → About** prints the same value for the tab you have open. If those two disagree, the
tab is running a different build from the one on disk — which is exactly the situation above, stated
before you go looking for it. Both come from issue #114.

## Verifying what quitting means (issue #216)

One command, from a **plain terminal** (not an agent's sandbox — Seatbelt does not nest, C1):

```bash
npm run verify:lifecycle
```

It starts a real orchestrator the way the shell does, starts two sessions, and walks the whole `⌘Q` sequence through
the **same decision functions the app calls**. It prints one line per acceptance criterion and ends with how many
passed. Three outcomes, and the difference matters:

| | meaning |
|---|---|
| `PASS` | the criterion holds against a real process |
| `FAIL` | it does not, and the script exits non-zero |
| `CANNOT` | the fact could not be obtained **here** — never counted as a pass |

`CANNOT` appears for two environmental reasons, both of which a plain terminal fixes: `/bin/ps` is refused (C16), or
sessions reach `failed` because safehouse cannot run inside another sandbox (C1). If you see three `CANNOT`s, that is
what happened — not a defect.

**What it cannot check, and the two clicks that can.** It does not launch Electron, so these are still yours:

1. `npm run app`, start two sessions, leave unsent text in one composer.
2. `⌘Q`. The dialog must list **both** sessions with their directories, with **Keep sessions running** highlighted.
   Press `Escape`: nothing is stopped and the terminal says `quit cancelled; nothing was stopped`.
3. `⌘Q` → **Keep sessions running**. Quit, run `npm run app` again. The terminal must print
   *`the recorded orchestrator (pid N, port N) is running and serving Pi Central's UI…`* and must **not** print
   *`reopened 2 sessions from the last run`*.
4. `⌘Q` → **Stop them and quit**. Reopen. Now it **must** print `reopened 2 sessions from the last run`.

Steps 3 and 4 together are the whole slice: 3 proves *adopt*, 4 proves *restore*. Either alone is ambiguous, because a
shell that always restarts looks identical to one that always restores.

The script already covers criterion 8's mechanism (a seeded `open-sessions.json` is reopened, and each entry keeps its
mode); what step 4 adds is that it happens for **your** sessions after a real quit.

## Applying a real update from the app (issue #217)

The automated tests drive the whole sequence with a stubbed installer, and `update-live.test.ts` runs a **real**
`npm install --global` into a temporary prefix. Neither can prove the thing the slice exists for, so this is the
one manual pass:

1. Publish or install an older version than the checkout: `npm install -g pi-central@<older>`.
2. `npm run app`, start two sessions, then **Pi Central → Check for Updates…**. It must say *up to date* (the
   checkout's version is not published), which is itself the check.
3. Install the current checkout globally: `npm install -g .` Then **Check for Updates…** again — it should report
   the version it found.
4. **Update Pi Central…**. The dialog must name the two live sessions and state that they will be restarted, with
   **Cancel** as the default. Cancel: nothing is stopped.
5. Do it again and confirm. Paste back:
   - the version before (`pi-central --version`),
   - the version after,
   - the line `Pi Central: update respawning — starting <v>`, and
   - what npm printed (visible in the terminal, or in the failure panel if it failed).

The claim being made is that the app replaced its own binary while two sessions were open and came back on the new
version. That is exactly the claim that must not rest on a mock.

**Check the refusal first, because this machine will hit it.** `npm run app` from a checkout that was
`npm install -g`'d into `/opt/homebrew/lib/node_modules` should refuse to update and say the directory is not
writable. That is correct, not a defect: `npm prefix -g` is `/opt/homebrew` because node is a Homebrew formula, the
tree is owner-only, and `pi-central` is not a formula — so no package manager actually owns it and this app may not
replace it either. To exercise the update path for real, install into a prefix you own:

```bash
npm install -g --prefix ~/.npm-global .    # then put ~/.npm-global/bin on PATH
npm run app
```

The owner check is what makes that distinction, and `installation-owner.test.ts` covers the four shapes it refuses
(Homebrew, version manager, linked working copy, read-only prefix).

**The two failures worth provoking once**, because they are the ones a real npm produces and a stub cannot:

- Point the update at a version that does not exist (`npm view` a typo'd tag) and confirm the app reports the
  install failure with npm's message, rather than a blank window.
- Run it as a user whose global prefix is not writable — on this machine `/opt/homebrew/lib/node_modules` is
  owner-only, so a plain non-sudo `npm install -g` gives `EACCES`, and the panel should say so in one sentence.

## Known rough edges

These are filed rather than worked around, because they are the difference between "possible" and
"pleasant":

- **A warning when a session's working directory contains a Pi Central installation** would turn
  failures 2–4 above into something stated up front, rather than a dashboard that mysteriously
  stops working.

Failure 1 above is resolved rather than filed: the orchestrator serves the built UI itself
(issue #24), so `npm run ui:build && npm run server` gives a dashboard with no file watcher.
