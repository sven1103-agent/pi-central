# ADR-0015 — A browser sidecar in its own sibling sandbox, driven by four verbs

- **Status:** Proposed — the shape is decided; Phase 2 is not started
- **Date:** 2026-11-22
- **Opened by:** [#276](https://github.com/sven1103-agent/pi-central/issues/276), after three spikes
- **Related:** [ADR-0002](0002-per-session-sandbox.md), [ADR-0007](0007-filesystem-access-model.md),
  [ADR-0010](0010-agent-credential-identity.md)

## Context

A UI slice cannot be closed by the agent that wrote it. `verified/manual` items wait on a human with a
browser, and `docs/ROADMAP.md` records visual review as **blocked by C1**. The cost is not aesthetic: the
agent that wrote a layout defect cannot see it, so the person reviews work that could have been corrected
before it was ever shown.

Two facts made this look impossible, and both are measured:

1. **A browser cannot live inside a session's sandbox.** Seatbelt does not nest (C1), so a session cannot
   apply any policy — not a tuned one, any. Every in-session attempt failed: `chrome-headless-shell` with
   `SEGV_ACCERR`, the full bundle at `Failed to bind() … SingletonSocket`.
2. **Widening the session to fix it buys the wrong capability.** `--enable=playwright-chrome` is not in
   `FORBIDDEN_ENABLE`, so the one-line patch is to pass it. Read what it grants *to the session*:
   `com.apple.pasteboard.1` (the user's clipboard), `com.apple.tccd`, the window server, and read access to
   `/Applications/Google Chrome.app`. That permanently widens every session's surface — and, measured below,
   it still does not produce a pixel from inside.

## What the spikes established

Three, in order, each able to invalidate the next. All run from a plain terminal, because a session cannot
apply a policy.

| Question | Answer | Where |
|---|---|---|
| Does a browser render **outside** a session, in its own profile? | **Yes** — PNG at 800×400 of a real page | Phase 0, 6/6 |
| Is loopback egress confined to the dev server? | **Yes** — a second loopback port returns `EPERM` | Phase 0 |
| Is Playwright's MCP server a cheaper sidecar? | **No** — 25 tools, no host-side narrowing, no auth | Phase 0B |
| Does it need Playwright at all? | **No** — 183 lines of CDP over `ws`, which already ships | Phase 0C |
| Can the renderer read the host's credentials? | **No**, with a *rendered* fragment — see C15c | Phase 0C |

The composite claim, measured in one run: the renderer produces a pixel **while** confined to one port and
denied the host's credentials. A run showing the confinement but not the pixel would be a policy that works
and a feature that does not.

### Three facts that changed the design, each measured rather than reasoned

- **`--no-sandbox` is mandatory.** Safehouse cannot permit Chromium's nested Seatbelt sandbox (`safehouse
  --help` says so; `chromium-full.sb` explains why). So the renderer runs with Chrome's own sandbox
  **disabled**, and its only confinement is the Safehouse profile. Every deny is load-bearing rather than
  defence in depth. A spike brief that said the opposite would have recorded a FAIL over a flag.
- **The port is the unit of confinement, not the address.** `(remote ip "127.0.0.1:*")` does not parse —
  `sandbox-exec` requires `*` or `localhost`. `localhost:<port>` is the only narrow form, which makes the
  fragment **per session**, since each session has its own dev server on its own port.
- **A hand-written deny list failed open.** A four-name fragment left `~/.gitconfig` readable while reporting
  the other three refused. That is C15c reproduced by hand within an hour of it being read: the unit of a
  path boundary is the directory, not a list of names under it.

## Decision

**The orchestrator spawns a browser sidecar as a sibling sandbox — never a child of a session — and drives it
through a fixed verb set over CDP, with no new shipped dependency.**

1. **A sibling, not a wider sandbox.** The orchestrator is unsandboxed by design (ADR-0002) and already
   spawns `safehouse` per session; it spawns a second, differently scoped one beside it. Seatbelt composes
   siblings; it does not nest. Neither sandbox can read the other.
2. **Four verbs, dispatched host-side.** `capture`, `probe`, `act`, `info`. **No verb may accept a CDP method
   name, a selector-driven script, or an arbitrary expression.** `probe` returns a verdict computed in the
   sidecar from fixed measurements. A verb that took a script would be `browser_evaluate` in a different
   costume — which is precisely why the MCP server was rejected.
3. **The tool surface is small by construction, not by filtering.** The agent may choose *which* checks to
   run and never author the assertion. That answers #276's open question 2, and it is the difference between a
   reviewer and a defendant.
4. **Pi is pointed at the sidecar by `--mcp-config`, at a path outside `~/.pi`.** Measured (Phase 0D):
   `pi --mcp-config <file> mcp list` starts the configured server; the same command without the flag does
   not. That placement is load-bearing, not cosmetic — `~/.pi` is writable from inside every session (C6),
   so a design whose MCP configuration lived there would let the agent point Pi at a server of its choosing.
   The flag also has to precede the subcommand: `pi mcp list --mcp-config …` reports "Unknown option",
   which is how a probe nearly concluded the flag did not exist.
5. **`ws` is the only dependency, and it already ships.** CDP is JSON; it travels over a pipe (decision 12),
   not a WebSocket, because the sidecar's own egress rule blocked its connection to its own browser; `Page.navigate`,
   `Page.captureScreenshot`, `Emulation.setDeviceMetricsOverride` and one `Runtime.evaluate` with a fixed
   expression cover both verbs in 183 lines. **No `playwright`, no Pi extension, no second protocol.**
6. **Egress is pinned to one port, per session.** `(deny network-outbound (remote ip))` then re-allow
   `localhost:<port>`, plus an explicit deny for the mDNSResponder socket, which a `(remote ip)` rule does not
   touch. The port is an **input** to the fragment renderer, never a constant.
7. **The fragment is RENDERED by `renderPolicyFragment`, never written by hand.** The deny set is the one that
   already exists for sessions — host gitconfig as a *prefix*, `~/.npm`, `~/.config/gh`, the `~/.ssh`
   directory — plus the launchd-listener network deny, because `SSH_AUTH_SOCK` reaches the sidecar by default
   (C4a) and the variable is not the control.
8. **The URL policy lives in the sidecar.** Registered dev-server origins only; `file://`, `chrome://` and
   arbitrary `https://` are refused with a structured error. Enforcement is host-side because the agent
   cannot rewrite what it cannot reach.
9. **No path parameters.** The sidecar accepts no filesystem path and returns PNG bytes; it generates the
   filename, so a buggy or compromised sidecar cannot overwrite a file of its choosing.
10. **No identity.** No keychain, no `~/.ssh`, no host git or gh config, no login (ADR-0010).
11. **The sidecar dies with its session, by construction and by supervision.** macOS has no parent-death
    signal, so this is code: the sidecar holds the read end of a pipe from the session and exits on EOF, and
    the orchestrator reaps it. `kill -9` of the orchestrator must leave no live browser and no open port.
12. **Pi reaches the sidecar over loopback HTTP with a bearer token; the browser is driven over a pipe.**
    Amends the stdio design of decisions 1 and 4. A stdio MCP server is spawned by Pi inside the session's
    sandbox, where it failed with `Path does not exist` (a denied stat) and would be a child rather than a
    sibling. So the orchestrator spawns the sidecar and `mcp.json` names `http://127.0.0.1:<port>/mcp` with
    `Authorization: Bearer ${PI_CENTRAL_SIDECAR_TOKEN}`. The token is 24 random bytes, checked on every
    request including `initialize`, and forwarded with `--env-pass` because Safehouse rebuilds the
    environment. The port is `47800 + the session's ordinal`, so the orchestrator knows it before the child
    starts. **Consequence: a loopback port is reachable from every session (C5), so the token is the access
    control.** CDP between the sidecar and Chrome uses fds 3 and 4, not a WebSocket.
13. **Agents must call the typed function to receive the image.** Measured at Checkpoint B: through
    `tools.mcp({ tool })` and the `tools.mcp__<server>({ tool })` proxy the result is the caption alone;
    through `tools.mcp__pi_central_sidecar__capture` it carries the image block, shown with
    `image(result.content[0])`. The tool description says so. Whether agents follow it unaided is untested.
14. **Pi Central assigns each session its dev-server port; the agent does not discover it.** The sidecar's egress is
    pinned to one port, and a frontend toolchain cannot know it: Vite and Next default to 5173 and 3000 and move
    to the next free port when it is busy, which in a second session is the *other* session's server. So the
    port is `48000 + the session's ordinal`, above the sidecar's own listen range, and the session is told it
    twice: in the appended system prompt, with the number written in (an instruction the agent must expand
    itself is one it gets wrong), and as `PI_CENTRAL_DEV_PORT`. A server that lands elsewhere is unreachable and
    the refusal says why, rather than a wrong screenshot. `PI_CENTRAL_SIDECAR=1` turns this on; an explicit
    `PI_CENTRAL_SIDECAR_PORT` or a per-session port still overrides it. **Considered and deferred:** letting the
    agent register its own port, which widens what a browser can reach on a loopback every session shares; it
    would need the orchestrator to confirm the port is listened on by a process inside *that* session's tree.
    **Two defects found by running it, now handled.** Session ids restart at `s1`, so a session always preferred
    the same port, and a dev server the previous run's agent left behind still held it: the next sidecar probed that
    stale server and reported `verdict: ok` for a page that overflowed by 720px. So the port is the preferred one
    only if nothing is listening on it, otherwise the next free one in the range. And a dev server an agent
    starts with `&` is not in the session's process group, so teardown never reached it: three were still
    listening after the runs had exited. A port Pi Central *assigned* is therefore reaped when its session stops
    (never an explicit or pinned port, which may be someone's own dev server).

## Consequences

**Positive**

- The agent can see its own UI work, with no human and no new shipped dependency.
- A screenshot becomes the escalation rather than the default: `probe` returns a compact verdict, and an image
  is requested when the verdict is not enough.
- The capability is exactly as wide as the four verbs. Nothing about it is reachable from a session: no origin
  policy the agent can edit, no extension in `~/.pi` to replace.
- It satisfies C1 rather than working around it — the constraint is the reason for the shape.

**Negative, and the honest ones**

- **The renderer's only confinement is one policy file**, because `--no-sandbox` is mandatory. There is no
  defence in depth behind it. If the appended fragment is wrong, the renderer is unbounded at user UID.
- **The parity risk is unmeasured.** 183 lines do the verbs, not Playwright's launch layer: no network-idle
  wait (the harness waits for `Page.loadEventFired` or 8 s), no console-error collection, no proven teardown.
  **Exit condition:** if the CDP client passes ~400 lines, or needs its own launch layer, swap in
  `playwright-core` — a **library** with no tool surface, so the defect that retired the MCP server does not
  transfer — and keep the verbs, the egress and the host-side enforcement unchanged.
- **`--enable=chromium-headless` is not an option with the Chrome app bundle.** Its mach grants are necessary
  but not sufficient; the bundle `file-read` lives in `chromium-full`, so `dyld` aborts with *blocked by
  sandbox*. The surface therefore stays `playwright-chrome` and is narrowed only by the appended deny block —
  which is why the block being rendered rather than hand-written matters more here than anywhere.
- **RSS is unmeasured.** The issue estimated 150–250 MB per sidecar. Per-session is the safe default for
  lifetime and token scoping; if a fleet makes it untenable, the fallback is one process with per-session
  origin scoping inside it, which is weaker.
- **Chrome starts its own updater, and it is confined.** Some launches ran `GoogleUpdater --install`, which tried
  `update.googleapis.com` and then `launchctl asuser 501 … --net-worker`. `spikes/ui-sidecar/harness/escape-probe.mjs`
  runs the real composed policy and shows that a process started through `launchctl asuser` is refused on a
  port outside the policy and cannot write outside the profile, exactly like a direct one, while the same
  command succeeds unsandboxed. **Still unmeasured:** the updater's own request to `update.googleapis.com`
  was never observed to leave the machine, only to fail on its first fetcher; the probe tests loopback ports,
  not the internet.
- **A scratch session has no browser.** No `cwd` means no dev server to reach; the verb reports
  "no browser for this session" rather than spawning something that can reach nothing.

## Alternatives rejected

**Widen the session** (`--enable=playwright-chrome` in `composePolicy`). Rejected on measurement: it grants
the pasteboard, TCC and the window server to every session *permanently*, and still produces no pixel from
inside, because the nesting failure is not a grant.

**Playwright's MCP server as the sidecar.** This was the cheapest-looking option: no broker, no extension, Pi
already speaks MCP. Rejected on measurement — `tools/list` returns 25 tools including `browser_evaluate` and
`browser_run_code_unsafe`; there is no host-side flag to withdraw one; and a client that never *declares*
`browser_evaluate` still *calls* it by naming it in `tools/call` **with no auth header**, and the server
executes. The server is the only enforcement point and it enforces nothing. Not a defect in Playwright: it is
what MCP is without `oauth`, and it generalises — any MCP server Pi Central adds inherits it.

**A Pi extension as the client.** Rejected because the extension would live in `~/.pi/agent/extensions/`,
which is writable from inside a session (C6), and `/reload` exists to pick up changes. An enforcement point
the agent can rewrite is not one. Phase 0C also removed the need for it: Pi is already an MCP client.

**Routing into the existing UI process.** The renderer that draws the dashboard holds a WebSocket that can
issue every control command (ADR-0006). Loading an agent-authored page there would put untrusted content in
the origin that controls every session.

## Verification

| Criterion | Class | How |
|---|---|---|
| A session renders its dev server with no human action | `verified/manual` | one run, the PNG inline |
| `file://`, `chrome://`, an unregistered origin refused | `verified/auto` | the request path, asserting the refusal |
| A hostile client cannot widen what is reachable | `verified/auto` | attempt the widened call, read the refusal |
| The sidecar dies with its session | `verified/auto` | `kill -9` the orchestrator; no browser, no port |
| A scratch session spawns nothing | `verified/auto` | the verb's answer, and the process count |
| `probe` names the offending selector from JSON alone | `verified/manual` | one overflowed render |
| Egress is confined to one port | `verified/manual` | a second loopback port returns `EPERM` |

CI has no `sandbox-exec` (C10), so everything touching a real policy runs in a plain terminal. The harnesses
stay under `spikes/ui-sidecar/harness/`: a spike is not a test, and production assertions belong beside the
code they constrain.
