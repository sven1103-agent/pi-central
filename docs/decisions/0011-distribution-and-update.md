# ADR-0011 — How Pi Central is distributed and updated

- **Status:** Accepted (distribution); the update *application* is decided in principle, implemented in issues #55/#56
- **Date:** 2026-10-26
- **Related:** C1, C10, [ADR-0005](0005-typescript-stack.md), [ADR-0007](0007-filesystem-access-model.md), README principle 9

## Context

Until now Pi Central has only ever been run **from a git checkout**: `npm run server`, with the UI
built by hand and the orchestrator loading TypeScript straight off disk. That has been a real
advantage while the product is being built — there is no build step between an edit and the thing
you are looking at. It also means:

- There was **no artifact** when this record was written. (`README.md` said so at the time: *"Not yet
  published; there is no released artifact."* That line is **now false and has been removed** — the
  package is published, which is exactly what this ADR set out to make possible. Kept here as the
  premise the decision rested on, marked so a reader does not take a quoted claim for a current one.)
- Nothing can say **which version is running**, so "is this the build with the fix?" is unanswerable.
- Picking up a change is a manual `git pull` and restart, so using Pi Central to improve Pi Central
  has a step in the loop the tool cannot own.

Shipping an artifact is what makes the loop closeable. This ADR decides **how it ships**, and the
trust model for the update path that follows from it.

### Two findings that constrain the answer

Both were measured before this record was written, because either could have decided the design.

**1. Shipping TypeScript is impossible.** Importing a `.ts` file from `node_modules` fails:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported
for files under node_modules, for "file:///…/node_modules/foo/index.ts"
```

Node deliberately does not strip types under `node_modules`, and npm installs global packages there.
So a published `.ts` entry point is unrunnable however the package is installed. The published
artifact must be **JavaScript**. (Reproduced with a minimal package; the local command is in
issue #52.)

**2. Pi Central makes zero outbound network calls today.** No `fetch`, no `node:https`, no
`net.connect` anywhere in `orchestrator/src`. The product is entirely local. An update check would be
its **first** egress, and it would originate in the **unsandboxed** component (C1) — the
highest-privilege code in the system. That fact, not convenience, is why detection and application
are separate concerns below.

## Decision

### 1. One npm artifact, built by bundling rather than by transpiling

A published package `pi-central` containing exactly:

```
bin/pi-central.js   one bundled ESM file — orchestrator + protocol + their dependencies
dist/ui/            the built UI, as `vite build` wrote it
package.json  README.md  LICENSE
```

The orchestrator is **bundled with `esbuild`**, not compiled file-by-file. The alternative,
`tsc` with emit, is far more invasive than it appears: the sources use explicit `.ts` import
specifiers (required by `allowImportingTsExtensions`, which itself requires `noEmit`), so all 39
such specifiers would need rewriting, or a second resolution scheme introduced for the published
build alone. `esbuild --bundle` follows the `.ts` specifiers as written and emits one file.

Because the module graph is eager, everything in the import chain loads before any argument is
parsed — which is a fact the update path has to respect (see below).

### 2. `ws` is a declared dependency; everything else is bundled

`ws` is CommonJS and calls `require()` internally. Bundled into an ESM output, esbuild emits a
`__require` shim that **throws at load time** — which made even `--version` fail. Found by installing
the tarball and running it; the in-workspace build looked fine.

`ws` is therefore `external` and declared in `dependencies`. The rejected alternatives:

- a `createRequire` banner would keep the dependency count at zero, at the cost of bundling
  CommonJS into the component that runs unsandboxed, and of a shim whose failure mode is a throw;
- emitting CommonJS would give up `import.meta.url`, which `resolveUiDistDir` and `findOwnPackage`
  both depend on.

One runtime dependency, declared, is the honest option.

### 3. Resolution is by NAME and relative to the PACKAGE ROOT, never the module

Two code paths have two layouts and must work in both:

| | from source (a checkout) | from the bundle (a package) |
|---|---|---|
| version | root `package.json` | the package's `package.json` |
| UI | `packages/ui/dist` | `dist/ui` |

Both are resolved **by walking up to the `package.json` whose `name` is `pi-central`**, not by
taking the nearest `package.json` — from source the nearest one belongs to
`@pi-central/orchestrator`, a *different package* whose version merely happens to agree today.

The UI path is then anchored to that package root. The previous single candidate
(`../../ui/dist`, relative to the module) is correct from source and, once bundled into `bin/`,
resolves to `<parent-of-package>/ui/dist` — **outside the installed package**, and therefore a path
that can match a directory belonging to the consumer.

When both directories exist — a checkout where `npm run build:package` has been run — the layout the
module was loaded from decides, so editing the UI cannot silently serve a stale packaged copy.

### 4. The update path: detect freely, apply only on request

**Detection** (#55) is read-only and reports `current`, `latest`, and whether an update exists. It is
governed by the following, each of which is an acceptance criterion rather than a sentiment:

- It is **off unless enabled**, and when off it opens no socket and sends no request. This is the
  product's first outbound call; making it opt-in is a consent decision, not a performance one.
- When enabled it sends **one** request for a dist-tag and caches the answer. Not per render, not per
  session, not per connection.
- The request carries **nothing but the package name**. No session id, no cwd, no machine id, no
  version history — nothing that could turn a version check into telemetry.
- Failure is **silent and non-blocking**. "Could not check for updates" is never worth interrupting
  someone for.

**Application** (#56) replaces the unsandboxed component, so it is the highest-privilege action in
the system and is deliberately the last slice:

- **Never automatic.** There is no code path that updates without an explicit user action.
- The exact version is pinned and the artifact's **provenance attestation verified before anything is
  installed**; a mismatch refuses rather than falling back.
- **Running sessions are respected.** A restart kills them, so the action states how many are running
  and requires confirmation naming them.
- The process must not silently continue on stale code after an update: it says a restart is
  required, and stops reporting the old version as current.
- Nothing is written into the user's **Pi** environment. That is principle 9, and it is unaffected
  here: updating Pi Central is not configuring Pi.

## Consequences

**Positive**

- Pi Central becomes installable, and `--version` reports the version of the artifact that is
  actually running — read from the shipped `package.json`, never restated in code, because a wrong
  answer here poisons every bug report that follows it.
- One build command produces the artifact, and `npm pack --dry-run` makes its contents reviewable
  before a release rather than during one.
- Zero configuration: the bundle finds its own UI and its own version from any working directory.
- The dependency surface stays at one package, in the component that runs unsandboxed.

**Negative**

- A build step now exists between the sources and the artifact. It is one command
  (`npm run build:package`) and the workspace path is untouched, but a stale `dist/ui` is now
  possible, which is exactly the confusion the layout-dependent preference in §3 exists to prevent.
- The bundle inlines `sourcesContent`, so its stack traces work without shipping the `.ts` files.
  That makes the file larger than the code it contains.
- **`--version` loads the whole graph**, because the import chain is eager. It therefore depends on
  `ws` resolving. A dedicated entry point that imports nothing would be more robust; it is not worth
  a second bundle today, and this is recorded so the trade-off is visible rather than accidental.
- An update check is the first outbound egress in a product that has had none. It is opt-in and
  carries nothing, but it is a new class of behaviour for this codebase and deserves scrutiny.

## Alternatives considered

- **Ship TypeScript and require an experimental loader.** Rejected: impossible for `node_modules`
  (finding 1), and asking users to run with a flag is not an install.
- **`tsc` with emit.** Rejected: 39 import specifiers to rewrite, or a second resolution scheme for
  one build, in exchange for nothing bundling does not give.
- **A `createRequire` banner to keep `ws` bundled.** Rejected: it bundles CommonJS into the
  unsandboxed component and its failure mode is a load-time throw.
- **Publish a `pi install`-able Pi package.** Rejected earlier and unchanged: the orchestrator is
  **not** a Pi extension (C1), so it cannot be something that loads inside Pi, and Pi Central ships
  no skill, extension or settings into a user's Pi environment (README principle 9). It is a **peer
  application** that happens to be distributed with npm.
- **Auto-apply updates in the background.** Rejected: it would let the network replace the
  highest-privilege component without a user action. Speed is not worth that, and the detection half
  delivers most of the value on its own.
- **A separate staging directory for the published package.** Rejected: two `package.json` files to
  keep in step, where the version would be the thing that drifts. One manifest, read at runtime, is
  the version's single source.
