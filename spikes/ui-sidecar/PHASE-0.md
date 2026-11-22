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

## Check 1 — a pixel exists

From a plain terminal, with a real page being served (any local app; `python3 -m http.server` is enough):

```bash
mkdir -p /tmp/sidecar /tmp/sidecar-profile
safehouse --workdir=/tmp/sidecar \
          --enable=playwright-chrome \
          -- node /tmp/sidecar/shot.mjs
```

where `shot.mjs` launches Chromium through Playwright and writes `/tmp/sidecar/out.png`.

**PASS:** `out.png` exists, is a valid PNG, and shows the page rather than a blank frame.
**FAIL:** the SEGV, the SingletonSocket bind, or a crashpad `--database is required` — then record the
error verbatim and **stop**; the renderer choice changes (see "If it fails" below).

Note the flag sequence matters: the browser gets **its own** profile, so do **not** pass `--no-sandbox`
here. `--no-sandbox` was only ever needed because a session's sandbox cannot host Chromium's inner one,
and this process is not inside a session.

## Check 2 — the loopback confinement holds

Append a fragment **after** Safehouse's rules (SBPL is last-match-wins), and put it under
version control as a fixture rather than retyping it:

```scheme
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:*") (remote ip "127.0.0.1:*"))
```

```bash
safehouse --workdir=/tmp/sidecar --append-profile=/tmp/sidecar/loopback.sb -- node /tmp/sidecar/shot.mjs
```

**PASS:** a page on `http://127.0.0.1:<port>` renders **and** any request to a non-loopback host (a
plain `https://example.com` beacon is enough) fails, in the same process, same run.
**FAIL:** either both succeed (the deny did not take effect — probably an ordering or specificity
problem, the C15c lesson) or both fail (the allow was shadowed).

Assert both directions in one process. Two separate runs cannot distinguish "denied" from "not tried",
which is the mistake C15c records.

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
