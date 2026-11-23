# Phase 0C — a renderer service with no new shipped dependency

**Status:** ⏳ **NOT STARTED** — this file is the brief, not the result.
**Parent:** Phase 0, which **passed** ([RESULT.md](RESULT.md)). The pixel exists; this asks what we drive it with.
**Issue:** [#276](https://github.com/sven1103-agent/pi-central/issues/276)
**Branch:** `slice/ui-sidecar`

Phase 0 settled the hard question: a Chromium in its own Safehouse profile renders a local page while
non-loopback egress, name resolution and a second loopback port are all refused. What is left is a **vendoring
and surface** question, not a security one — and it is the question that decides whether this slice ships a
`playwright` dependency and whether shape B's driver stems from A or from C.

## Where C sits now

| | **A** — broker + extension | **B** — Playwright MCP | **C** — thin verb server |
|---|---|---|---|
| New shipped dependency | none | none (`npx`) | none |
| Session-side client | ~150 LOC extension, in agent-writable `~/.pi` | Pi (built in) | Pi (built in) |
| Verb set | closed: `shot`/`probe`/`act`/`info` | **25 tools, driver stems** | closed, and small |
| Enforcement lives host-side | yes | **no** — measured, no flag, no auth | yes |
| Extra wire protocol | yes (a second `ws` server) | no | no |

B is retired ([PHASE-0B.md](PHASE-0B.md)): it exposes `browser_evaluate` and `browser_run_code_unsafe`, no
host-side flag withdraws them, and a client that never declares them can still call them with no credentials.
**C is the shape that keeps B's answer to the dependency objection and drops B's driver.** The extension is
the only thing A still buys, and it is the one artefact the agent can rewrite — so not needing it is worth
measuring before choosing A.

## The claim

> A host-side service of roughly two verbs — `capture`, `probe` — driving a browser over CDP, covers what the
> agent needs to see its own UI work, with **no new shipped dependency**, and its tool surface is small *by
> construction* rather than by a filter.

`ws` is already a shipped dependency and is already a WebSocket client library, so CDP-over-WebSocket costs
nothing new. That is the whole economic argument, and it is falsifiable in an afternoon.

## C1 — does the renderer need Playwright at all?

CDP is JSON over a WebSocket. Connect, `Page.navigate`, `Page.captureScreenshot`, `Runtime.evaluate` for the
probe measurements, `Emulation.setDeviceMetricsOverride` for the viewport. Roughly 150–250 lines, and it uses
the client already in `package.json`.

Discover the endpoint without leaving a file behind: launch Chrome with `--remote-debugging-port=0` and read
the port from the `DevToolsActivePort` file **in the sidecar's own profile directory**, or use
`--remote-debugging-pipe` (stdio, no port, no file — the safer option if it works, because a profile directory
under `/var/folders` is readable by every session).

**PASS:** a PNG of the fixture, and a `probe` result naming the deliberately-overflowing element, from a
subscription using only `node:*` and `ws`.
**FAIL:** CDP cannot drive the screenshot path without Playwright's launch flags, or the endpoint cannot be
found without writing a file that other sessions can read.

**Also record what the parity gap is**, because it is the real cost of dropping Playwright and nobody has
measured it: waiting for network idle rather than a fixed timeout, capturing console errors, launching and
tearing down reliably. If those are ~100 lines, C wins on cost. If they are a reimplementation of Playwright's
launch layer, that is the sort of thing that looks cheap for a week.

## C2 — is the surface small by construction?

B's failure was structural: one server, twenty-five verbs, no gate. C must be small in a way a reviewer can
check, not small because a filter ran.

**PASS:** the service exposes **at most four** verbs, and a codemode script calling anything else gets an
error from the *server's* request dispatch — not a tool that was withheld from the model.
**FAIL:** the server forwards arbitrary CDP (`method` as a parameter), which is `browser_evaluate` in a
different costume and is shape B again.

State the falsifier plainly: **if any verb takes a CDP method name or a selector-driven script, C has become B.**
`probe` must return a *verdict* computed host-side from fixed measurements, which is exactly what #276's
question 2 is about: the agent may choose *which* checks, never author the assertions.

## C3 — the grants, with the renderer being the thing that parses untrusted CSS and JS

Phase 0 proved the browser renders under a profile that refuses non-loopback egress. It did not prove the
renderer cannot read the host's credentials, and the composed policy grants some it should not:
`~/.npmrc`, `~/.config/gh`, `~/.gitconfig`, `~/.ssh/config`, and with `playwright-chrome` also
`com.apple.pasteboard.1`.

Start from `--enable=chromium-headless` (which drops the pasteboard and the app-bundle reads; it still carries
`tccd` and the window server, because `chromium-headless.sb` is written for an AppKit-capable browser booting)
and append a deny block: `~/.npmrc`, `~/.config/gh`, `~/.ssh`, the pasteboard if it is still granted, and the
mDNSResponder socket.

**PASS:** every read refused **and** the browser still renders — both halves, one run (C12's shape: a deny that
stops the boot is not a win).
**FAIL:** any read succeeds, or the browser boots only with the deny removed. In the second case record which
grant the deny collided with: that is the honest answer to "what does the renderer need", and cheaper learned
here than in Phase 2.

## C4 — the pinned port is an input, not a constant

Phase 0's port pin makes the fragment per-session: `localhost:<port>` is right for exactly one dev server, and
a fleet has more than one. So the thing that composes C's fragment takes the port as an argument.

**PASS:** two sidecars with fragments rendered from two different ports each reach only their own, in one run.
**FAIL:** a constant port, or a fragment wide enough to cover both (that is `localhost:*`, which returns us to
Phase 0 run 2's unconfined state).

## C5 — cost, measured

For each candidate — `playwright-core`, and CDP-over-`ws` — record: cold-start seconds to first pixel,
resident MB, and the lines of our own code. The comparison that matters is against a user's patience and
against the size of the browser download, not against each other.

```bash
/usr/bin/time -l node cdp-shot.mjs      # resident and wall time, ours
du -sh ~/Library/Caches/ms-playwright/*  # what the user pays either way
```

## If it fails

1. **C1 fails on parity, not on the pixel** — CDP renders, but network-idle/console/launch handling is a
   rewrite. Then use `playwright-core` (not `@playwright/mcp`), keeping C's verb set and host-side
   enforcement: `playwright-core` is a library with no tool surface, so B's defect does not transfer.
2. **C2 fails** — a verb starts taking a CDP method. Stop; that is B with extra steps.
3. **C3 fails** — the renderer cannot boot with the credential denies applied. Then A's broker is not the
   answer either, and the finding belongs in `docs/CONSTRAINTS.md` as a new C-number.

## When it passes

Write the result into this file the way [RESULT.md](RESULT.md) does — status, a table including the failures,
and the exact commands. Then the shape decision is a comparison of three measured rows rather than three
arguments, and `packages/orchestrator` can be touched.
