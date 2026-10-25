# Using Pi Central to develop Pi Central

Yes — and it is worth doing, because the fastest way to find this tool's problems is to depend on
it. But **not from the checkout you are working in.** This document explains what breaks, and what
to do instead.

## What breaks if you run it from the checkout an agent is editing

Three failures, in the order you would hit them.

**1. The UI you are using gets replaced by the UI being edited.** `npm run ui:dev` runs Vite's dev
server, which watches `packages/ui/src` and hot-reloads the browser. An agent editing a component
therefore reloads the interface out from under you — and mid-edit that means a syntax-error
overlay instead of a dashboard. The orchestrator has no other way to serve a UI: it answers every
HTTP request with `426 Upgrade Required` and speaks WebSocket only, so a built UI has to be served
by something else.

**2. A branch switch desynchronises the two halves.** The UI and the orchestrator share
`@pi-central/protocol`, and Vite resolves it to the protocol source on disk. If the checkout moves
to another branch, the UI is built from branch B while the running orchestrator is branch A. The
mismatch is *detected* — the client compares `PROTOCOL_VERSION` on `hello` and reports a protocol
mismatch rather than silently misrendering — but a detected mismatch is still a broken dashboard.

**3. If the agent breaks the orchestrator, you lose the tool you need to fix it.** Node caches
ESM modules after loading them, so a running orchestrator mostly survives edits to its source. The
next *restart* is the problem: it loads whatever is on disk. If that does not start, Pi Central is
unavailable precisely when you want it to supervise the repair.

There is a fourth, quieter one: two writers on one checkout. Two sessions editing the same working
tree lose each other's changes in ways neither can see.

## What to do

**Run Pi Central from one checkout. Let agents work in another.**

```bash
cd ~/git/idea-factory
git clone git@github.com:sven1103-agent/pi-central.git pi-central-dev

# terminal 1 — from the STABLE checkout, the one no agent may touch
cd pi-central && npm install && npm run server

# terminal 2 — also the stable checkout
cd pi-central && npm run ui:dev
```

Then `⌘⇧O` and point a session at `~/git/idea-factory/pi-central-dev`.

A session is sandboxed to its working directory, so an agent in `pi-central-dev` **cannot write to
`pi-central` at all**. Sibling directories are denied — that is the property
[`verify-three.ts`](../packages/orchestrator/verify-three.ts) checks with twelve cross-directory
probes, not an assumption. The Vite watcher on the stable checkout never fires, so nothing
replaces the UI you are using.

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

## Known rough edges

These are filed rather than worked around, because they are the difference between "possible" and
"pleasant":

- **Serving a built UI from the orchestrator** would remove the file watcher entirely, so editing
  the UI could never disturb the running one.
- **A warning when a session's working directory contains a Pi Central installation** would turn
  failures 1–3 above into something stated up front, rather than a dashboard that mysteriously
  stops working.
