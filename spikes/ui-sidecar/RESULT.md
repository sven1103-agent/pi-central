# Phase 0 — result: a browser renders under the sidecar's profile, and loopback is confined

**Status:** ✅ **PASSED** (5/5 control, 3/5 under the bare profile — the expected "before" — and 6/6 with
the loopback fragment).
**Issue:** [#276](https://github.com/sven1103-agent/pi-central/issues/276)
**Brief:** [PHASE-0.md](PHASE-0.md) · **Harness:** [harness/shot.mjs](harness/shot.mjs)
**Environment:** macOS, run from a plain (unsandboxed) terminal. Versions are deliberately not recorded
here — `npm run check:version` refuses a Markdown file that states the current one; run
`pi-central --version`, `safehouse --version`, `node --version` for the day of the run.

## Why this mattered

The whole slice rested on one unproven claim: a browser that cannot start **inside** a session's sandbox
will start **outside** it, under its own profile. Every in-session attempt failed, but each failure was one
that `chromium-full.sb` exists to grant, so those runs said nothing about a host-level launch. This is that
launch.

## What ran

Three runs, same harness, same fixture, in this order. The mode flag is required and each run verifies
itself: a `--control` run inside a policy refuses to start.

```bash
cd spikes/ui-sidecar/harness
node shot.mjs --control
safehouse --workdir="$PWD" --enable=playwright-chrome \
  -- node shot.mjs --inside-sandbox --no-sandbox
safehouse --workdir="$PWD" --enable=playwright-chrome --append-profile="$PWD/loopback.sb" \
  -- node shot.mjs --inside-sandbox --no-sandbox
```

## Results

| Check | 1 · control | 2 · sidecar profile | 3 · + loopback fragment |
|---|---|---|---|
| loopback :4173 reachable | PASS | PASS | PASS |
| second loopback port :4174 | — | **reachable** | **REFUSED (`EPERM`)** — the port is pinned, not the address |
| non-loopback host | (baseline: reachable) | **reachable — no confinement** | **REFUSED (`EPERM`)** |
| name resolution | (baseline: works) | **works — no confinement** | **REFUSED (no answer)** |
| browser produced a PNG | PASS | **PASS** | **PASS** |
| PNG dimensions | 800×400 | 800×400 | 800×400 |
| **page visible in the PNG** | **yes** | yes | **yes** |

Run 2's two FAILs are the *point of the run*: they are the "before", and without them run 3's passes
would prove nothing about the fragment. A check that cannot report a wide-open policy cannot report a
closed one either (C15c).

**The composite claim is confirmed.** The browser launches under its own Safehouse profile with
`--enable=playwright-chrome`, renders a real page to a PNG at the requested size, and does so *while*
a non-loopback host, name resolution, **and a second loopback port** are all refused.

The last of those is the one that makes the egress fragment worth having. A pin on `localhost:<port>`
would be decorative if it still admitted every other loopback port — the orchestrator's control socket
lives there, and its transport performs no Origin, Host or token check. Measured: it does not. So a
compromised renderer cannot dial the orchestrator, and the fragment is a boundary rather than a
formality.

## What the screenshots showed

Open, not inferred from dimensions — the harness cannot tell a page from a blank frame and says so.

| Run | Content |
|---|---|
| 1 · control | blue field, white heading, orange block, green bar extending past the right edge with a visible scrollbar |
| 3 · fragment | the same page, same geometry |

The clipped green bar is worth keeping in view: it is deliberate horizontal overflow, so it is evidence
that a `probe`-style verdict is derivable from a render *and* a visible reminder that the reviewer can
see the defect a numbers-only check would miss.

## Findings that change the brief or the design

**1. `--no-sandbox` is mandatory, and the first draft of the brief said the opposite.** `safehouse --help`
states it; `chromium-full.sb` explains why: "Chrome's internal helper sandbox re-init is blocked once
Safehouse is already enforcing the outer Seatbelt sandbox." So the renderer's **only** confinement is the
Safehouse profile. Every deny in the fragment is load-bearing rather than defence in depth, and that
belongs in the issue text.

**2. `(remote ip "127.0.0.1:*")` does not parse.** Measured: `sandbox-exec: host must be * or localhost in
network address` (exit 65). Expressible forms are `localhost:*` and `localhost:<port>`; a v4 literal is not
expressible at all. **The port is the unit of confinement, not the address.**

**3. A `(remote ip …)` deny does not filter unix sockets.** The base profile's
`(allow network-outbound (literal "/private/var/run/mDNSResponder"))` survives it, so it is denied
explicitly in `loopback.sb`. Run 3's DNS refusal is the measurement that the deny took effect.

**4. `--enable=chromium-headless` is not the lean option.** From the composed policies: base 1,178 lines with
no `pasteboard` and no `tccd`; `chromium-headless` 1,375 with `tccd`, `dock.server` and
`windowserver.active`; `playwright-chrome` 1,456, adding `pasteboard.1` and the Chrome app bundle.
`chromium-headless.sb` is written around an AppKit-capable browser booting, so dropping to it removes the
clipboard, not the desktop surface.

## Still open, and what would close it

| Question | How to settle it |
|---|---|
| Which port does the sidecar pin, per session? | each session's dev server is ephemeral, so the fragment is per-session; the shape that composes it must take the port as an input, not a constant |
| Does the renderer need the desktop grants at all? | bisect from `--disable-gpu` upward; if a smaller set renders, the surface shrinks |
| Is `probe` derivable without Playwright? | the next brief (shape C) — a thin host-side verb server driving `playwright-core` directly |

## One thing this does not answer

The sidecar is confined; the *orchestrator* is not. `localhost:<port>` pins a port, not a peer, so whether
a compromised renderer can reach the control socket is a separate measurement, and the transport's absent
Origin/Host/token check is a separate finding. Recording the two together would repeat the mistake this
harness exists to avoid: a check that ran, with its answer discarded.
