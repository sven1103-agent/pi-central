# Phase 0B — is Pi's MCP plumbing a cheaper sidecar than a bespoke broker?

**Status:** ⛔ **B4 FAILED — B is retired as specified.** B0–B3, B5, B6 unrun (need a plain terminal).
**Parent:** Phase 0 ([PHASE-0.md](PHASE-0.md)) — same unproven claim, a different plumbing choice.
**Issue:** [#276](https://github.com/sven1103-agent/pi-central/issues/276)
**Branch:** `slice/ui-sidecar`

Phase 0 asks whether a browser can start at all outside a session's sandbox. This asks a second,
independent question, and it can be answered from the same shell:

> If the orchestrator spawns **`@playwright/mcp`** as a sibling under its own profile, and Pi connects to
> it as an ordinary MCP client, do we get a pixel **without** losing the controls that make the bespoke
> broker safe?

It is worth the shell time because it removes the two things the other shape costs: a second server
protocol, and a Pi extension that lives in a directory the agent can rewrite.

## The two shapes

| | **A** — broker + extension | **B** — MCP server, Pi as client |
|---|---|---|
| Sidecar server | `ws` (already shipped) + ~500 LOC broker | `npx @playwright/mcp` — no product code |
| Session-side client | ~150 LOC Pi extension, in agent-writable `~/.pi` | **Pi itself** |
| New shipped dependency | none | none (an `npx`ed host tool, like `safehouse` and `pi`) |
| Verb set | closed: `shot`, `probe`, `act`, `info` | the server's whole surface |
| URL policy owner | the broker, host-side | **none** — the server's own README says its origin lists are not a security boundary |

B is only acceptable if the row that differs — "the whole surface" — can be narrowed from the *host*
side. That is check B4, and it is the one that can retire B.

## B4 — FAILED, measured without a browser (run first, moved here because it is the answer)

The check asks whether the host can narrow the server's tool surface. It cannot, and the failure is not a
missing option. Measured against `@playwright/mcp@0.0.86` (tarball 97 KB, an 11-line `cli.js` that shims
straight into `playwright-core`'s bundled MCP implementation) on this machine:

| Question | Method | Result |
|---|---|---|
| Does the server withdraw a tool on request? | `README` §options, exhaustive | **no such option.** `--blocked-origins` exists for URLs; there is no `--allowed-tools`, no `--blocked-tools` |
| What does it expose | `tools/list` over streamable HTTP | **25 tools**, including `browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload` |
| Can a client narrow it? | `--exclude-tools`, `--tools` | yes, in-session only — cosmetic, and the agent owns that space |
| **Can a session bypass a client-side narrowing?** | `tools/call browser_evaluate` with **no auth header** | **yes — `200`, the server executed and answered** |

That last row is the one that ends the argument, and it did not need a browser: a client that never
declares `browser_evaluate` still reaches it, because **the server is the only enforcement point and it
enforces nothing**. `--exclude-tools` in Pi is presentation. Whatever narrows B must be host-side and
argument-blind, which is what `--isolated` does for the whole browser: no cookies, no storage, no
identity.

So B is not "shape A minus the broker". It is a general browser driver reachable by every session that
can see the port — which, at one UID with no auth on the transport, is every session. Two consequences
that outlive this spike:

- **Any MCP server added to Pi Central in future inherits this property.** MCP has an experimental
  `oauth` mode, and that is the only mechanism in the protocol for "this client may call this tool".
  It is the same finding as C6's `~/.pi` writability, one layer up: **enforcement that lives in Pi's
  configuration lives in the agent's writable space.** Worth a C-number when it is confirmed with
  `oauth`, not before.
- **What survives is a smaller B.** `--isolated --output-dir` plus a port-scoped egress fragment is a
  real answering service, and it fails only on the driver *verbs*. That is the seed of **C** below.

### What the run also established, cheaply

- **The server is IPv6-only.** `http://127.0.0.1:8931/mcp` → **connection refused (000)**;
  `http://localhost:8931/mcp` and `http://[::1]:8931/mcp` → `200`. Two things follow, and both matter:
  a v4-only loopback egress rule would have produced a false FAIL, and a browser told to visit
  `http://127.0.0.1:<devport>` reaching a dev server on `::1` is the S5 port-scoping question in a new
  form.
- **It answers on every interface-shaped spelling with no credentials**, and starts a *persistent* Chrome
  from `/Applications` by default (not bundled Chromium) — `--isolated` prevents the profile, not the app.
- Transport is `/mcp` (streamable HTTP) with a legacy `/sse` alias, so Pi's "SSE is rejected" rule is not
  a blocker — worth knowing, because it was my first guess at a kill-switch.

## What is already measured, so this run does not redo it

Composed on macOS with the installed Safehouse, `safehouse --stdout --workdir=… --enable=…`:

| `--enable` | Policy lines | Notable grants |
|---|---|---|
| (none) | 1,178 | `pasteboard` and `tccd` absent |
| `chromium-headless` | 1,375 | `com.apple.tccd`, `tccd.system`, `dock.server`, `windowserver.active`, `appkit.xpc.openAndSavePanelService` |
| `playwright-chrome` | 1,456 | the above, **plus** `com.apple.pasteboard.1`, `/Applications/Google Chrome.app`, `MachPortRendezvousServer` |

Two facts that follow, and both were assumptions until measured:

- **The "lean" feature is not lean.** `chromium-headless.sb` is written around an AppKit-capable
  browser booting, so it already carries the window server and TCC. Dropping to it removes the
  clipboard and the app-bundle reads; it does not remove the desktop surface.
- **`--no-sandbox` is mandatory on every one of them.** `safehouse --help` states it, and
  `chromium-full.sb` explains why: *"Chrome's internal helper sandbox re-init is blocked once Safehouse is
  already enforcing the outer Seatbelt sandbox."* So the renderer's only confinement is the Safehouse
  profile — every deny in check B2 is load-bearing, not defence in depth.

Both shapes inherit these. Run from a **plain terminal**, not from a session, an editor task, or any
sandbox — C1 means a spike run inside one measures nothing (this document was written from such a
session, which is why it contains no measurements of its own).

## B0 — a pixel exists, with the flag the design had wrong

```bash
mkdir -p "$HOME/.config/pi-central/sidecar" && cd "$HOME/.config/pi-central/sidecar"
# a real page, served locally
python3 -m http.server 4173 --bind 127.0.0.1 &
```

Launch the server **with `--no-sandbox` and without it**, and record both:

```bash
safehouse --workdir="$PWD" --enable=playwright-chrome \
  -- sh -c 'npx -y @playwright/mcp@0.0.86 --headless --isolated --no-sandbox \
              --browser chromium --viewport-size 1280x800 --port 8931 --output-dir ./out'
```

Use the state root, **not `/tmp`**: `/tmp` and `/var/folders` are granted read/write to every session by
the base profile (`config.ts`'s D-5 note says so), so a fixture there cannot demonstrate confinement.

**PASS:** a navigation to `http://127.0.0.1:4173` returns a screenshot whose bytes are a PNG of that page.
**FAIL:** the SEGV, the `SingletonSocket` bind, or `chrome_crashpad_handler: --database is required`.
Record the error verbatim and go to "If it fails".

**Also record what B0 cannot ask:** whether text is legible. No `chromium-gpu` and no `keychain` means no
`security` binary and no font-service access, which in practice means screenshots of local pages can come
back as boxes. If the PNG is a page of tofu, the *renderer choice* is wrong even though the check passed —
that is a Phase 0B finding, not a formatting detail.

## B1 — the config seam does not depend on a file the agent can rewrite

Shape B lives or dies here. `pi --help` lists `--mcp-config <path>`, and **Pi's documentation does not
mention it** — so its precedence over `~/.pi/agent/mcp.json` is an assumption, and an untested seam in
the one place where being wrong is invisible.

Why it matters: `~/.pi` is granted `file-read* file-write*` to every session (C6). A design whose
isolation depends on an entry in `~/.pi/agent/mcp.json` is a design whose isolation the agent can edit —
the same defect #276 already identifies for `~/.pi/agent/extensions/`, one file over.

```bash
before=$(find "$HOME/.pi/agent" -type f -exec shasum {} \; | sort)
safehouse --workdir=/some/project -- <start pi with --mcp-config "/abs/path/mcp.json">
after=$(find "$HOME/.pi/agent" -type f -exec shasum {} \; | sort)
[ "$before" = "$after" ] && echo "PASS: nothing in ~/.pi was touched"
```

**PASS:** the session's tools include `mcp__playwright__*` **and** no file under `~/.pi/agent` changed.
**FAIL:** the tools appear only after writing `~/.pi/agent/mcp.json`; or the session does not see the
config file at all, because it lives outside the session's reachable set (C15a) — put the config in a
place the fragment grants, and say where.

Note the ordering trap: verify the *absence* first. A `--mcp-config` that silently loses to the user file
would pass a check that only looks for the tools.

## B2 — the sibling profile is a boundary, argued from refusals

B0 proves a pixel; it does not prove the browser is confined. Run the assertions **from inside the same
sandbox the browser is in**, with the fragment applied:

```scheme
(deny file-read* file-write* (home-literal "/.npmrc") (home-subpath "/.config/gh") (home-subpath "/.ssh"))
(deny mach-lookup (global-name "com.apple.pasteboard.1") (global-name "com.apple.tccd"))
```

```bash
safehouse --workdir="$PWD" --enable=playwright-chrome --append-profile=./sidecar.sb \\
  -- sh -c 'node -e "require(\"fs\").readFileSync(process.env.HOME+\"/.npmrc\")" ; …and a pasteboard read…'
```

**PASS:** every read is refused **and** the browser still launches and renders. Both halves, one run —
and the second half is the point. A deny that stops the browser booting is not a win (C12's shape).
**FAIL:** any read succeeds, or the browser only boots with the deny removed. In the second case, record
which grant the deny collided with: that is the real answer to "what does the browser need", and it is
cheaper to learn here than in Phase 2.

Named falsifiers, because a coverage property needs them (C15c): `~/.npmrc` (holds the npm token),
`~/.config/gh` (the host's gh config), `~/.ssh/config`, and the pasteboard.

## B3 — how wide is loopback, really

The URL policy is the one control shape A has and B does not. Test the sharp version:

```scheme
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:4173"))
```

- Navigate to `http://127.0.0.1:4173` — **must succeed** (the spelling matters: `127.0.0.1:*` is a parse
  error on this machine, `localhost:*` is all ports, and `localhost:<port>` is the only narrow form).
- Navigate to `http://localhost:<the orchestrator's port>` — **must fail**.
- Make the same request to the orchestrator's port over a websocket upgrade — **must fail**.

**PASS:** 1 succeeds, 2 and 3 fail, in one run. **FAIL:** 1 fails (the allow was shadowed, C15c's
ordering lesson) or 3 succeeds.

If 3 succeeds, the egress fragment is not a boundary for this shape at all: the sidecar sits behind the
same portless allow the orchestrator listens on, and a page that can reach it can reach every session's
control socket — which in shape B is a *general browser driver*, not a fixed verb set. That outcome does
not merely weaken B; it argues for the broker being the thing that holds the token, whatever the transport.

## B4 — can the host narrow the tool surface? (the check that can retire B)

`--tools` keeps every MCP tool callable from codemode unless an entry starts with `mcp__`, and
`--exclude-tools 'mcp__*'` removes them after all other selection. Si the question is whether a
*host-side* flag can do the same:

```bash
# the server, started by the orchestrator, with evaluate withdrawn
-- ... --blocked-tools browser_evaluate   # (confirm the exact flag against 0.0.86 before relying on it)
# the session, narrowed by Pi
pi --exclude-tools 'mcp__playwright__browser_evaluate'
```

Then, from a **codemode script** — not from the tool list, which is cosmetic:

```js
try { await tools["mcp__playwright__browser_run_code"]({ code: "return 1" }); return "REACHABLE"; }
catch (e) { return "refused: " + e.message; }
```

**PASS:** the call is refused by the server, not only hidden from the list.
**FAIL:** it succeeds — then `--exclude-tools` is presentation, not control, and the only version of B
that is safe from a page-driven instruction is `--no-mcp`, which is not B.

State the falsifier plainly: **if the surface cannot be narrowed host-side, B is a browser driver in the
agent's hands and the closed verb set stops existing.** That is a decision, not a defect to patch
afterwards.

## B5 — the bearer token, and whether anyone else can present it

A URL-shaped MCP server is loopback-reachable by every session, and MCP has no unix-socket transport
(`command` is stdio, `url` is HTTP), so the token is the whole boundary. Everything runs at one UID,
so measure rather than assume:

```bash
# from a second, unrelated sandbox: can the token and port be found?
grep -rl "posix" "$HOME/.pi/agent/mcp.json" 2>/dev/null; ps -o command= -p <sidecar pid>
```

**PASS:** the token is not readable from a session and the port is not discoverable — say exactly where it
lives and what closes it.
**FAIL:** a session reads it out of the agent config, or off the process's own argv (which
`ps -o command=` prints, and which `/tmp`-based discovery would also expose).

A FAIL here is not fatal to B, but it is fatal to *B alone*: an `ask`-style verb the agent can call would
then need a transport Pi cannot speak, which means running both A and B. Record it, because "one sidecar
or two" is a Phase 2 decision this can settle.

## B6 — cost, measured instead of estimated

The numbers this shape is competing on, taken on the same machine:

```bash
du -sh ~/Library/Caches/ms-playwright/*        # the download, not the package
/usr/bin/time -l npx -y @playwright/mcp@0.0.86 --version   # cold start
```

Record: cold-start seconds (against Pi's 10 s first-prompt wait for servers with `direct` tools),
resident MB per sidecar, the download the user pays, and **the pinned version**. `@playwright/mcp`
0.0.86 depends on `playwright`/`playwright-core` **1.66.0-alpha-2026-11-18**, an alpha — so "pin it and
update deliberately" needs a named version, and a supply-chain answer that the other shape does not need.

## If it fails

1. **B4 fails** — the surface cannot be narrowed. Then shape A ships, and the a11y-snapshot idea in B is
   harvested into `probe` (it is a better artifact than the CSS-overflow verdict the issue proposes).
2. **B1 fails but B4 passes** — Pi cannot be pointed at a config outside `~/.pi`. The fix is a decision
   about `~/.pi`'s write grant (a new C-number), not a hack with the path.
3. **B4 and B1 both pass, B3 fails** — B works but the egress fragment does not confine it. Then the
   broker survives as the token holder and B replaces only the session-side extension. That is a real
   outcome, and it should be written down as one, not smoothed into "B won".

## When it passes

Write the result into this file the way `spikes/phase-0/RESULT.md` does — status, a table of observed
outcomes including the failures, and the exact commands — then link it from the issue. Only then is it
worth choosing between A and B, and only then should `packages/orchestrator` be touched.

## Two hazards in running this

**Do not `pkill -f` the command line above.** A pattern you typed in the same shell matches your own
shell, and a probe that cannot tell "I killed it" from "the name matched" is the C16 family in a new
place. Stop by PID; assert "no browser process" by comparing port-holder sets taken before and after,
the way Phase 0 asserted absence from outside the sandbox.

**A session may be running while you spike.** One writer per working directory (AGENTS.md); use a
separate worktree, as the issue's Follow-up already sets up.
