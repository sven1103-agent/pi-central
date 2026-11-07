# ADR-0013 — A desktop shell that is a launcher, never the update target

- **Status:** Accepted
- **Date:** 2026-11-07
- **Amends:** [ADR-0011](0011-distribution-and-update.md) (adds a second, non-distributed surface; the npm artifact stays the update unit)
- **Amends against:** the "no Electron/Tauri" line in [STACK.md](../STACK.md), which this record replaces with a stated choice
- **Opened by:** issue #212; slices in issue #213 and Increment 7

## Context

Pi Central is a browser UI over a loopback WebSocket. That has been right: the CSP, the same-origin
socket rule and the DOMPurify pipeline ([ADR-0006](0006-untrusted-markdown-rendering.md)) all depend on
it, and a plain browser stays a supported client for free.

Two costs accumulated.

**One is an affordance gap, and it is measured.** An installed PWA window is *focused, not reloaded*,
when its dock icon is clicked (#184). The stale-page check built for it works — it compares the
fingerprinted bundle the page was loaded from against the one the orchestrator reports serving, and
reloads once — but a window that was **hidden** while the orchestrator was replaced receives no
snapshot, so it came back holding an old bundle with no verdict about it and a banner advising "quit
the app and reopen". #213 closed the reload half of that (ask for a fresh snapshot on return, hold the
reload back if the composer has unsent work). What it cannot close is that **a browser tab has no way
to restart the thing behind it**, and "reopen the app" remains an instruction rather than an action.

**The other is the missing desktop surface**, which is a product observation rather than a defect: no
dock icon that behaves like an app's, no application menu, no native folder dialog — [ADR-0012](0012-directory-chooser.md)
built a placed directory browser precisely because a web page cannot learn the absolute path of what
the OS panel returned, and it exists partly to work around not having one.

### The constraint that decides the shape

**This machine has no Apple Developer account.** No Developer ID, therefore no notarization. Three
facts follow, and they were verified rather than assumed:

1. **An unsigned executable does not run on Apple Silicon** — but an *ad-hoc* signature
   (`codesign -s -`) is free, local, and satisfies that. What is lost is notarization, which matters
   only for a bundle arriving **quarantined** (`com.apple.quarantine`, set by browsers). A bundle
   produced by `npm`, `curl`, `git clone`, Homebrew or `cp` is not quarantined.
2. **`electron-updater` / Squirrel.Mac refuses to apply an update to an unsigned macOS app.** So an
   app that ships as a `.app` and updates itself is not available without the account, and a design
   that depends on it is a design that cannot be built here.
3. **TCC grants are keyed to code identity.** An ad-hoc signature's cdhash changes per build, so every
   rebuild voids the Documents/Desktop grants and re-prompts. A one-time self-signed Code Signing
   certificate fixes it at zero cost.

So: the account is not a nice-to-have that is missing. It is a boundary, and the decision has to live
inside it rather than around it.

## Decision

**Pi Central gains an optional desktop shell that launches the installed npm package and never
distributes product code of its own.** Concretely:

1. **The shell is a launcher.** It carries the Electron main process and no product code: no
   `bin/pi-central.js`, no `dist/ui`. It finds the executables, spawns the package, reads the
   `PI_CENTRAL_URL=` line the orchestrator already prints on bind, and loads that loopback URL in a
   window.
2. **The npm package remains the sole update unit.** ADR-0011's "one artifact, one version", its
   provenance-attested publish, and its detect-freely/apply-on-request split are unchanged. The shell
   is installed once by `npm run install-app` and is not replaced by an update.
3. **Node is the runtime, spawned explicitly** (`node <pkg>/bin/pi-central.js`), not
   `ELECTRON_RUN_AS_NODE=1 process.execPath`. This does not merely avoid a version skew, it removes the
   question: the artifact's `engines.node` is a prerequisite the user already satisfied by installing
   it. (Electron does currently bundle a Node above that floor, so this is a decision about which
   dependency to *rely* on, not a workaround.)
4. **`--port 0`, always.** An ephemeral port makes a stale orchestrator harmless instead of an
   `EADDRINUSE` support case — `startup-error.ts` exists because people hit that one.
5. **The renderer loads `http://127.0.0.1:<port>`**, so `connect-src 'self'`, the same-origin WebSocket
   requirement and the UI's CSP all still hold, and a plain browser remains a supported client of the
   same process.
6. **The shell is ad-hoc signed for local use, and a self-signed identity is documented** so TCC grants
   survive a rebuild. There is no `.dmg`, no notarization step, and no `electron-updater`; the build
   fails loudly if any of those is added, because their failure mode is a release pipeline that cannot
   complete rather than an error at build time.
7. **No credential enters CI.** The release workflow keeps its "no stored token" property: nothing in
   the shell's path needs a signing secret, because nothing is signed with a Developer ID.

The shell is therefore macOS-only, which costs nothing: Safehouse is macOS-only already (C10).

## Consequences

**Positive**

- The update loop closes from inside the app: stop the child, install, verify the version, respawn,
  reload — actions a browser tab structurally cannot take. This is the half of #184 that no amount of
  page-side work could reach.
- Sessions can outlive the window and even the app: close hides, `⌘Q` asks before stopping anything,
  and the next launch reattaches to a still-running orchestrator instead of starting a second one. A
  second orchestrator over the same session file is exactly the branch-point hazard C9 describes, so
  reattaching is a correctness property, not a convenience.
- The desktop surface arrives without moving code: a native folder dialog, an application menu, a dock
  icon, a login item.
- ADR-0011 survives intact. One artifact, one version, one provenance chain, one place that decides what
  runs.

**Negative**

- **The app requires Node and npm on the machine.** Fine for this audience — it is the same prerequisite
  the current install path already has — but it is a requirement, and it must be refused with a
  sentence that names the missing thing rather than failing to spawn.
- **The shell has no self-update.** Bumping Electron means re-running `install-app`. Acceptable for a
  launcher, and honest: versioning it like a config file is better than pretending it is a product.
- **Distribution to strangers is not solved.** Without notarization, a `.app` downloaded through a
  browser meets Gatekeeper, and since macOS 15 the Control-click bypass is gone. The documented routes
  are "build it locally" and a Homebrew tap/cask (both avoid quarantine); "disable Gatekeeper" is
  explicitly not one of them.
- **A second runtime enters the repository**, which is a real cost against ADR-0005's "one runtime"
  argument. Chromium is not free to carry, audit or update.
- **Net new privileged surface.** The renderer is a Chromium window with access to the orchestrator's
  own HTTP surface. It is kept equivalent to a browser tab by explicit window options, an origin-locked
  navigation policy and a deny-all permission handler — each asserted, because "Electron is a browser"
  is the assumption that goes wrong quietly.

## Alternatives considered

- **No shell; fix only the page** (what #213 did). Rejected as the *complete* answer: it closes the
  reload, not the restart, and it delivers no desktop surface. Kept as the first step, on purpose —
  #213 ships independently, and if it removes the pain on its own then this record is a want rather
  than a fix.
- **An Electron app that absorbs the orchestrator and the UI** — one `.app`, updated by
  `electron-updater`. Rejected: it cannot close its own update loop without a Developer ID (fact 2
  above), and it would either break "one artifact, one version" or make the `.app` a second thing with
  a version that can drift.
- **A Tauri shell.** Rejected: it adds Rust to a stack whose entire argument is one runtime, and its
  `App Sandbox` guidance sits badly next to the requirement that the orchestrator run unsandboxed
  (C1, ADR-0002). Nothing it offers is needed at this size.
- **A native folder dialog via `osascript` from the orchestrator**, considered and rejected in
  ADR-0012 on cost. That reasoning is unchanged; it is *newly possible* to revisit from inside a shell,
  and this record does not decide it.
- **A menu-bar-only app (no window).** Rejected for now: the dashboard is the product, and a
  menu-bar-only shell would be a status surface without the thing people use.

## What would prove this wrong

- A GUI-launched app cannot reach `pi` or `safehouse` even through a login-shell lookup, so every start
  fails where the terminal path works.
- Sessions cannot survive `⌘Q` with the orchestrator detached, so the shell kills work on quit —
  strictly worse than the PWA it replaces.
- The updater cannot verify what it installed without a long-lived secret in CI, which would cost
  ADR-0011's "no stored credential" property.
- A self-signed identity does not stop TCC re-prompting, making the app worse at file access than a
  browser tab.

Each is a checkable fact, and each is a criterion on a slice in Increment 7 rather than a sentiment
recorded here.
