# Phase 0C — result: CDP replaces Playwright, and the credential denies are needed

**Status:** ✅ **C1, C2 PASSED** — a pixel and a probe verdict over CDP, `ws` only, 183 lines.
⚠️ **C3 passed on the second attempt** — the first fragment failed open, and that is the finding.
⛔ **`--enable=chromium-headless` is NOT viable with the Chrome app bundle.**
**Issue:** [#276](https://github.com/sven1103-agent/pi-central/issues/276)
**Brief:** [PHASE-0C.md](PHASE-0C.md) · **Harness:** [harness/](harness/)

## C1 — a pixel and a verdict, with no new dependency ✅

[harness/cdp-shot.mjs](harness/cdp-shot.mjs), **183 lines including the fixture, the CDP client and the probe.**

```
PASS  browser exposed a CDP endpoint  -- ws://localhost:64555/devtools/...
PASS  a screenshot came back over CDP  -- 8834 bytes
PASS  probe found the deliberate overflow
      [{"selector":"#wide","kind":"horizontal-overflow","by":1224}]
      verdict: {"viewport":{"width":800,"height":400},"problems":[...]}
```

So the economic argument holds: `Page.navigate`, `Page.captureScreenshot`, `Emulation.setDeviceMetricsOverride`
and one `Runtime.evaluate` with a **fixed expression** are enough for both verbs. `ws` was already a shipped
dependency and already a WebSocket client, so **the slice ships no new dependency**, and Pi being an MCP client
means no extension either. The endpoint is discovered from `DevToolsActivePort` inside the sidecar's own profile
— which must therefore not live in `/var/folders`.

That `Runtime.evaluate` call is the one place C2 could have failed: it takes a **fixed measurement expression**,
not a caller-supplied script or a CDP method name. A verb that accepted either would be `browser_evaluate` in a
different costume, i.e. shape B again.

**Not measured, and this is the real cost:** no network-idle wait, no console-error collection, no launch/teardown
robustness. Today the harness waits for `Page.loadEventFired` or 8 s, whichever is first. Whether that becomes a
handful of lines or a reimplementation of Playwright's launch layer is what C1 was supposed to reveal, and this
run answered the *capability* half only.

## C2 — the surface is small by construction ✅

Four verbs at most, all dispatched host-side; there is no parameter through which a CDP method or a script can be
smuggled. The probe's measurements are computed in the sidecar, which is also the answer to #276's open question 2:
the agent may choose *which* checks, never author the assertions.

## C3 — the first fragment failed open, measured

The first `creds.sb` denied four names. Result:

```
PASS  ~/.npmrc is REFUSED          -- EPERM
PASS  ~/.config/gh is REFUSED      -- EPERM
PASS  ~/.ssh/config is REFUSED     -- EPERM
FAIL  ~/.gitconfig is REFUSED      -- read
```

Three of four, and the failure is exactly the one this repository records as **C15c**: *"the unit of a path
boundary is the directory, not a list of names under it. A name list fails open on the next name nobody
predicted, and the failure is invisible — the rule still reads as protection."* The name list omitted `~/.gitconfig`,
so the renderer could read the host's git identity — including, on macOS, a `credential.helper = !gh auth
git-credential` route to a token. Writing the list by hand in a spike reproduced the production defect within an
hour of the document being read.

The corrected fragment ([harness/creds.sb](harness/creds.sb)) restates the denials `renderPolicyFragment` already
emits: `(home-prefix "/.gitconfig")` rather than a literal, `~/.config/git`, `~/.npmrc` **and** `~/.npm`, the
`~/.ssh` directory, plus the **network** deny for the launchd listener sockets. That restatement is itself a
hazard and the file says so: **the sidecar fragment must be *rendered* by the production function in Phase 2, not
copied from a spike.**

## The finding that changes the design: the ssh-agent socket is reachable

```
INFO  SSH_AUTH_SOCK=/var/run/com.apple.launchd.bHsW1GD3JQ/Listeners
```

Safehouse's sanitized environment carries `SSH_AUTH_SOCK` (C4a), so the variable reaches the sidecar by default.
Every session already has this, so it is not new — but the sidecar is a process that **renders untrusted content**,
and an agent socket is a signing oracle: a page cannot call `socket()` directly, but a compromised renderer inside
the browser can attempt a connect, and the `(remote ip)` egress deny does not touch unix sockets. The network deny
in `creds.sb` is the control. Whether it holds was not asserted by a probe — recorded as open, not as passing.

## `--enable=chromium-headless` is not viable with the app bundle ⛔

```
dyld[83034]: Library not loaded: @executable_path/../Frameworks/Google Chrome Framework.framework/…/libaperitif.dylib
  Reason: tried: '/Applications/Google Chrome.app/…' (blocked by sandbox)
```

The AppKit-era mach grants in `chromium-headless.sb` are necessary but not sufficient: it carries `tccd`,
`dock.server` and `windowserver.active` (1,375 lines against the base 1,178), so it is **not** the lean profile it
looks like — while still lacking the `file-read` grants for the Chrome bundle, which live in `chromium-full`.
Two consequences:

- **The surface discussion was framed wrong.** Dropping to `chromium-headless` does not shrink the desktop grants;
  it removes the clipboard and the app bundle, and breaks the browser. The real lever is the appended deny block,
  not the feature name.
- **A bundled Chromium would change this**, but Phase 0 rendered with the app bundle and that is what the design
  would ship, so the profile stays `playwright-chrome` until a bundled renderer is measured.

## What holds, measured end to end

```
safehouse --workdir=$PWD --enable=playwright-chrome \
  --append-profile=loopback.sb --append-profile=creds.sb \
  -- node shot.mjs --inside-sandbox --no-sandbox
→ 6/6: loopback :4173 answers; :4174 EPERM; non-loopback EPERM; DNS no answer; PNG 800x400
```

The renderer renders **while** confined to one port and denied the host's credentials. That is the composite claim
of this slice, and both halves were measured in one run.

## Open

| Question | How to settle it |
|---|---|
| Does the ssh-agent network deny actually refuse a connect? | a probe that attempts it, not an INFO line |
| Does the renderer need the AppKit grants at all? | a bundled Chromium (`--enable=chromium-headless` plus the bundle path) — the only way to shrink the surface |
| The parity gap: network-idle, console errors, teardown | a second slice of C1, or accept `playwright-core` (a library, no tool surface) |

## Checkpoint A — the sidecar process, driven directly (PASSED)

The whole pipeline except Pi's plumbing: a real MCP handshake over stdio, the policy refusals, a browser
launched on first use, and PNG bytes back.

```
$ node drive-sidecar.mjs --control
PASS  the sidecar answers initialize  -- {"name":"pi-central-sidecar","version":"0"}
PASS  it advertises four verbs  -- act, capture, info, probe
PASS  info reports the origin WITHOUT launching a browser
PASS  an unregistered origin is refused  -- origin-not-registered
PASS  a smuggled CDP method is refused  -- unknown argument "method"
PASS  probe finds the deliberate overflow  -- [{"kind":"horizontal-overflow","selector":"#wide","by":744}]
PASS  capture returns PNG bytes  -- 11708 bytes
7/7 expectations held (control)
```

**The two verbs agree, computed by different paths.** `probe` reports `#wide` overflowing by 744 px (the
bar starts at 24 px, is 2000 px wide, and the viewport is 1280). The PNG shows the same bar clipped at the
viewport edge with a horizontal scrollbar. Neither number was derived from the other, which is the only
reason their agreement is evidence.

The `--as-spawned` variant (under Safehouse, with the rendered fragment) is still `verified/manual` and
unrun: it needs `renderSidecarFragment` output written to a file first.
