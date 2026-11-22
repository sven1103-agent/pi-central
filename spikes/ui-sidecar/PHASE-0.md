# Phase 0 — can a browser run at all, outside a session's sandbox?

**Status:** ⏳ **NOT STARTED** — this file is the brief, not the result.
**Issue:** [#276](https://github.com/sven1103-agent/pi-central/issues/276)
**Branch:** `slice/ui-sidecar`
**Environment measured so far:** macOS, Pi Central and Agent Safehouse and `node` at the versions named
by `pi-central --version`, `safehouse --version`, `node --version` on the day of the run. Do not copy a
version into this file — `npm run check:version` refuses a Markdown file that states the current one.

This exists because the whole slice rests on one unproven claim. Do this first, and do it from a
**plain terminal** — not from a Pi Central session, not from an editor task, not from any sandbox.
C1 means a session cannot apply a policy at all, so a spike run inside one measures nothing.

## The claim

A browser process, spawned **by the orchestrator** (unsandboxed) under its **own** Safehouse profile,
renders a local page to a PNG. Not "a policy composes", and not "the binary starts": a file with pixels
in it, at a size that matches the page.

## Why it is not already known

Measured from inside a supervised session ([#276](https://github.com/sven1103-agent/pi-central/issues/276)),
the browser cannot start. Every one of these was tried and failed:

| Attempt | Outcome |
|---|---|
| `sandbox-exec` / `safehouse` from inside a session | `sandbox_apply: Operation not permitted` (C1) |
| `chrome-headless-shell --no-sandbox --headless --dump-dom` | `Received signal 11 SEGV_ACCERR 000000000010` |
| … with `--headless=old`, `--single-process`, `--disable-gpu`, `--use-angle=swiftshader`, `--disable-crashpad` | same SEGV in every variant |
| Chrome for Testing (full bundle) | furthest: `chrome_crashpad_handler: --database is required`, then `Failed to bind() …/SingletonSocket: Operation not permitted` |
| Playwright `firefox` / `webkit` | launch timeout, no pixels |

**But those runs were inside a sandbox that cannot nest**, so they do not answer the question. The
SingletonSocket and crashpad failures are precisely what `chromium-full.sb` and `chromium-headless.sb`
exist to grant, and Safehouse's own `playwright-chrome.sb` sets `PLAYWRIGHT_MCP_SANDBOX=false` on the
assumption that a browser launched *by the host* works. The next run must be from outside.

## Run it

The harness is under version control at [harness/shot.mjs](harness/shot.mjs), with its fixture
([harness/page.html](harness/page.html)) and the fragment ([harness/loopback.sb](harness/loopback.sb)).
It serves the page itself, so nothing else needs starting. **Three runs, in this order, on purpose:**

```bash
cd spikes/ui-sidecar/harness

# 1. The baseline. No policy. If the browser cannot render HERE, the defect is Chromium, not the
#    profile, and runs 2 and 3 answer nothing.
node shot.mjs --control

# 2. The sidecar's profile as Safehouse composes it. Expect the two egress checks to FAIL to be
#    denied -- that is the "before" of the fragment, and it is what makes run 3 meaningful.
safehouse --workdir="$PWD" --enable=playwright-chrome \
  -- node shot.mjs --inside-sandbox --no-sandbox

# 3. Same, with the loopback fragment. Now non-loopback and DNS must be REFUSED.
safehouse --workdir="$PWD" --enable=playwright-chrome --append-profile="$PWD/loopback.sb" \
  -- node shot.mjs --inside-sandbox --no-sandbox
```

Use the state root, **not `/tmp`**: `/tmp` and `/var/folders` are granted read/write to every session by
the base profile, so a fixture there cannot demonstrate confinement.

The mode flag is required and each run checks it against reality. A `--control` run that is in fact
sandboxed refuses to start, because it would report an outer sandbox's behaviour as Chromium's — the one
mistake this check exists to prevent. The first draft of the harness had that flaw; it is named here
because it is the shape the second draft would have had too.

### What each result means

| Run | Check | PASS means |
|---|---|---|
| 1 | a PNG exists, 800×400 | Chromium can render at all on this machine |
| 2 | a PNG exists **under the profile** | the sidecar's sandbox can host the renderer — **this is the claim** |
| 2 | non-loopback reachable, DNS resolves | the "before": the base profile has no egress confinement |
| 3 | both REFUSED | the appended fragment decides, not the base policy |
| 3 | a PNG still exists | the confinement did not cost the capability (C12's shape) |

**Open the PNG in run 1 and run 3.** A blank frame or a page of tofu is a FAIL even though a file
exists, and the harness cannot tell — it checks dimensions, not content.

**`--no-sandbox` is required under Safehouse** and is passed above for that reason. `safehouse --help`
states it; `chromium-full.sb` explains why ("Chrome's internal helper sandbox re-init is blocked once
Safehouse is already enforcing the outer Seatbelt sandbox"). An earlier version of this file said the
opposite, which would have turned a pass into a recorded FAIL and re-opened the design over a flag.

## Check 2 — the loopback confinement holds

Append a fragment **after** Safehouse's rules (SBPL is last-match-wins), and put it under
version control as a fixture rather than retyping it:

The fragment is [harness/loopback.sb](harness/loopback.sb). Two corrections to the version this brief
first carried, both measured on this machine rather than reasoned about:

```scheme
(deny  network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:4173"))
(deny  network-outbound (literal "/private/var/run/mDNSResponder"))
```

- **`(remote ip "127.0.0.1:*")` does not parse.** `sandbox-exec` refuses it with *"host must be `*` or
  `localhost` in network address"* (exit 65). The expressible forms are `localhost:*` (every port) and
  `localhost:<port>` (one). A v4 literal is not expressible at all — which also means **the port is the
  unit of confinement, not the address.**
- **A `(remote ip …)` deny does not touch unix sockets.** So the base profile's
  `(allow network-outbound (literal "/private/var/run/mDNSResponder"))` survives it, and a confined
  renderer could still emit attacker-visible DNS. It is denied explicitly above, and the harness reports
  which way it actually behaves rather than which way it was assumed to.

**PASS:** a page on `http://localhost:<port>` renders **and** a non-loopback connection and a name
resolution both fail, in the same process, same run.
**FAIL:** both succeed (the deny did not take effect — an ordering or specificity problem, the C15c
lesson), both fail (the allow was shadowed), or the browser only renders when the fragment is removed.

Assert both directions in one process. Two separate runs cannot distinguish "denied" from "not tried",
which is the mistake C15c records.

One thing this check cannot establish, and a later shape depends on it: `localhost:<port>` is a **pin on
the port, not on the peer**. The orchestrator's own control socket is on loopback too, so if it listens on
a port the sidecar may reach, a confined renderer can dial it — and the transport performs no Origin, Host
or token check. Record the orchestrator's port and whether the fragment's single allowed port excludes it;
if the answer is "no", that is a finding for the issue, not a detail for later.

## If it fails

Do not start writing the broker. In order:

1. **Explicit crashpad** — supply `--database` for `chrome_crashpad_handler`, and/or disable the crash
   reporter. If the crash is crashpad-only, this is a configuration answer.
2. **Swap the renderer** — evaluate an offscreen renderer that is not Chromium (a WebKit-based
   screenshotter, or a headless renderer already inside the toolchain). The design's security properties
   do not depend on the renderer being Chromium; only `probe`'s computed-style checks do, and they can
   be re-derived from whatever eventually works.
3. **Re-open the decision** — if no browser will start under *any* host-level profile, then the slice is
   blocked by something stronger than C1, and #276 should be closed as `blocked/upstream` with the
   measurement recorded in `docs/CONSTRAINTS.md` (a new C-number), because the finding is worth more
   than the slice.

## When it passes

Write the result into this file the way `spikes/phase-0/RESULT.md` does — status, what ran, a table of
observed outcomes including the failures, and the exact commands — then link it from the issue. Only
after that is it worth proposing the broker's shape, and only then should `packages/orchestrator` be
touched.

Keep `npm run verify` green: this file adds no code, so the only obligation is that nothing else on the
branch breaks.
