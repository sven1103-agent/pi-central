<p align="center">
  <img src="assets/pi-central-logo-full-dark-mode.svg" alt="Pi Central" width="420" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-central"><img alt="npm version" src="https://img.shields.io/npm/v/pi-central" /></a>
  <a href="https://www.npmjs.com/package/pi-central"><img alt="npm downloads" src="https://img.shields.io/npm/dm/pi-central" /></a>
  <a href="https://github.com/sven1103-agent/pi-central/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/sven1103-agent/pi-central/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/sven1103-agent/pi-central/security/code-scanning"><img alt="dependency vulnerabilities" src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/sven1103-agent/pi-central/badges/vulnerabilities.json" /></a>
  <img alt="node version" src="https://img.shields.io/node/v/pi-central" />
  <img alt="license" src="https://img.shields.io/npm/l/pi-central" />
</p>

**A local dashboard for running several [Pi](https://pi.dev) coding-agent sessions at once — each in its
own working directory, each inside its own sandbox.** /paɪ ˈsɛntrəl/

`pi` gives you one process, one session, one directory. Pi Central is the fleet you were missing:

- **See them all.** One rail with every session's state, cost and context burn — instead of three
  terminals and three scrollbacks.
- **Answer them from one place.** The approval dock handles `confirm`, `select`, `input` and `editor`
  for whichever session is blocked.
- **Keep them apart.** Each session gets its own Safehouse sandbox for its own directory. They cannot
  read each other's files.
- **Let the agent see its own work.** Give a session a browser in a sandbox of its own, and it screenshots
  the page it just built instead of asking you to check it —
  [four verbs, no script](#see-what-the-agent-built--without-a-human-squinting-at-it).

**Who this is for.** People who already run `pi` and want more than one session at a time.
Contributors: jump to [Working on this project](#working-on-this-project).

![An eight-second loop of the real dashboard. The rail on the left holds a new-session button and
three groups: *Demo Session 1* under "Running 1" with its green working badge, its scratch workspace,
session number and context burn; a second scratch session under "Idle 1"; and "Stopped 37" folded
shut. In the transcript the assistant's prose streams in — a heading, then numbered sections of a
story arriving line by line, with the *Thinking…* group above it. On the right the session panel
carries the provider, model and thinking pickers; the composer at the foot has its key hints and an
auto-follow toggle; and the topbar reads 2 sessions · 1 running · 2 scratch · connected.](docs/images/dashboard.gif)

**Status: works end to end, verified, and published.** The version is deliberately not written here —
`pi-central --version` reports the version of the package it shipped in. See
[docs/RELEASING.md](docs/RELEASING.md).

## Requirements

Check these first — Pi Central will not run without them, and it is better to know now.

| | Why | Check |
|---|---|---|
| **macOS** | Safehouse (the sandbox) has no Linux backend yet. | `uname` |
| **[Pi](https://pi.dev)** | Pi Central supervises `pi --mode rpc`; it is not a fork of it. | `pi --version` |
| **[Safehouse](https://agent-safehouse.dev)** | Composes the per-session sandbox profile. | `safehouse --help` |
| **Node ≥ 22** | The orchestrator runs TypeScript directly. | `node --version` |

Optional: **Google Chrome** (or another Chromium), for
[letting a session see what it built](#see-what-the-agent-built--without-a-human-squinting-at-it). Nothing
else needs it, and `PI_CENTRAL_BROWSER` points at a different binary.

## Install

```bash
npm install --global pi-central
pi-central
```

Open the URL it prints — <http://127.0.0.1:8787> unless you passed `--port`. That is the whole
installation: one process serves both the UI and the socket, so there is no dev server, no config file
and no service to start.

Optional next steps: [add it to your dock](#in-your-dock), or [run it as a native app](#as-a-native-app).

> **Run it from a plain terminal** — not from an editor task, a sandboxed shell or an agent harness.
> macOS Seatbelt does not nest, so `safehouse` cannot apply its policy inside an existing sandbox. Pi
> Central checks this before binding a port and refuses with an explanation ([C1](docs/CONSTRAINTS.md)).

### Verify the download

```bash
npm audit signatures       # the provenance attestation matches the tarball
pi-central --version       # the version you actually have
```

`npm audit signatures` checks the attestation every release carries — a signed statement, minted by the
release workflow's OIDC identity rather than a stored token, that this tarball came from this commit via
this workflow. It does **not** refuse an unattested tarball (npm shows a badge; enforcement is yours),
and it answers *"did the publisher produce this?"* rather than *"is the publisher trustworthy?"* — Pi
Central runs outside the sandbox with your privileges by design, so this tells a tampered tarball from a
genuine one and cannot make a genuine one safe. Why `npx pi-central` cannot be verified this way, and why
it should be pinned, is in [docs/RELEASING.md](docs/RELEASING.md).

## Why it exists

`pi` has no fleet concept. One process owns one session and one directory: sessions are JSONL files under
`~/.pi/agent/sessions/`, RPC mode is a long-lived child speaking JSONL over stdio, and there is **no
daemon, no attach protocol, no socket registry, no port**.

So three repositories means three terminals, three scrollbacks, and no single place to see what is
running, what is waiting for approval, or how much context each session has burned.

## How it works

![Pi Central's architecture: a browser UI talks over a loopback WebSocket to an orchestrator, which
runs outside any sandbox and spawns one pi process per session, each inside its own Safehouse
sandbox drawn as a separate dashed frame.](assets/architecture.svg)

The two boxes on top are ordinary. **The three frames below are the design**: the orchestrator sits
*outside* every sandbox, and each `pi` sits *inside* its own, with no frame shared between them.

That shape is forced by one fact — **Seatbelt does not nest** ([C1](docs/CONSTRAINTS.md)). A process
already inside `sandbox-exec` cannot apply a second profile, so an architecture that hosted sessions
in-process would have no sandbox at all. The orchestrator must live outside and spawn one `safehouse`
invocation per session. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Zen mode, when the conversation is all you want

The dashboard gives the fleet half the window because watching several sessions is the point. Reading
one of them is the other half, and it wants the whole window. **Zen mode** (the app calls it *reading
focus*) steps the describing surfaces aside and leaves the conversation: the rail folds to a column of
icons, the session panel collapses to a slim *Details* tab on the trailing edge that opens on hover or
focus, and the composer's permanent hint line folds away — the keys it carried move to the field's own
`title`, so nothing is dropped, only moved.

![The dashboard in Zen mode: everything that describes the fleet has stepped aside. The rail is
narrowed to a column of icons — the mark, a menu, the new-session button, a reload — with no session
list in it; the prose runs as a centred column with the width of the window to itself; the session
panel has collapsed to a slim *Details* tab on the trailing edge, showing the state dot and "1%", with
the panel's own icons stacked beneath it. The composer is still at the foot as a bare field: its key
hints are gone, though *Compact context*, *Reload resources* and *auto-follow on* remain. The topbar
keeps the product mark and a green connection dot and drops the fleet
counts.](docs/images/zen-mode.png)

**What it does not touch is the point.** Nothing that *is* the conversation is governed by the mode — not
the lane, not the measure, not the scroller, not the composer's field. And nothing is lost: the session's
identity, model, thinking level, meter, cost and controls are all still in the *Details* tab, so the mode
is a change of frame rather than a subtraction. Warnings, the approval dock, the queue rail and the error
strip stay put — they are decisions, not descriptions.

`⌥⇧Z` toggles it, beside `⌘⇧.`; the Shift is what keeps it clear of `⌘.`, which stops the run. The full
reasoning, including the four boundaries the mode is held to by test rather than by taste, is
[ADR-0016](docs/decisions/0016-rail-visibility.md).

## See what the agent built — without a human squinting at it

**Your agent writes a page, then guesses whether it looks right.** It is inside a Safehouse sandbox, and
Seatbelt does not nest ([C1](docs/CONSTRAINTS.md)): it can start a dev server, but it cannot start a browser to
look at one. So it hands you a layout you have to check, and the review you were supposed to be doing turns
into a bug report.

Pi Central gives the session **eyes of its own** — a real Chrome, in a sandbox of its own, that the agent calls
as a tool. It takes the screenshot, reads the layout, fixes the overflow, and asks again. No human in the loop
until the picture is worth looking at.

![How a session reaches its browser: the orchestrator spawns two sibling sandboxes, an agent on the left
running pi and its dev server on port 48001, and a renderer on the right running Chrome and listening on port
47801, with a gap between the two frames so neither can read the other. The only connection is one wire
labelled MCP over HTTP with a bearer token on every request. Below, the whole surface the agent can ask for:
four chips reading capture, probe, act and info, and no script, no CDP method, no file path.](assets/ui-sidecar.svg)

### Turn it on

**Settings → Session browser →** *Preview its work in a browser*. Where a browser is present the switch is there;
where it is not, it names the path it looked at instead of failing silently. Then tick the box in the directory
picker, or let the setting cover every new session. For a scripted launch, `PI_CENTRAL_SIDECAR=1` sets the same
default — the in-app switch overrides it either way, and it exists because a dock PWA inherits no shell
environment at all.

Nothing else to wire: the session is told its dev port (`PI_CENTRAL_DEV_PORT`, `48000` plus its session
number), runs its dev server there, and reaches the sidecar at a port the operating system assigned it — Pi Central
writes the `--mcp-config` file that names it once the sidecar is listening. The port is not predictable by design:
a sidecar must be reachable at exactly one address, and deriving that address from a session number collided with
sidecars left over from earlier launches.

### Four verbs, and no fifth

The agent does not get a browser. It gets a **closed set of four operations**, dispatched host-side by the
orchestrator — never by the renderer, and never by anything inside the session's sandbox.

| Tool | What it answers | What it cannot do |
|---|---|---|
| **`capture`** | the page as a PNG, arriving in the transcript as an *image*, not a description of one | open any origin but this session's dev server |
| **`probe`** | a compact verdict: horizontal and vertical overflow, contrast, overlap, console errors — with the offending selector named | take a selector and an assertion of its own |
| **`act`** | one real mouse click at the centre of an element it located, by CSS selector | type, upload a file, evaluate script, or run a second action in the same call |
| **`info`** | which origin it serves, which checks it offers, whether it is up | answer without a browser for the session that asked |

**No verb accepts a CDP method, an expression, a script, or a filesystem path.** A general-purpose browser
driver behind a permission prompt is the permission prompt doing all the work. The absence of the parameter
is the control. A `probe` returns what the *sidecar* measured, so "broken" stays a
property of the page rather than an opinion the agent authored.

`act` keeps the page it clicked. The sidecar has one page for its life, so a verb's `url` means *"be at this
address"*, not *"start over"*: `act` then `capture` shows the dialog the click opened, `act` then `act`
accumulates, and `probe` → `act` → `probe` measures before and after
([#288](https://github.com/sven1103-agent/pi-central/issues/288)).

### How it is wired

The session reaches its browser over **MCP on loopback**, with a random bearer token per session checked on
every request — including the handshake. Loopback is reachable by every process on the machine
([C5](docs/CONSTRAINTS.md)), so the token is the boundary rather than hygiene. The port is assigned by the
kernel, not derived from the session number, and the token travels in the environment so no secret is written
to a file that outlives the session.

A screenshot reaches the model as an **image block** rather than a caption or base64 in a text block. That is
the whole user-visible difference: the agent can look at a colour, a gap, or an overflow that no text diff
would show. The rail row says `browser :48005` while it runs, so you can see the process without asking the agent
whether it has one.

### Why not just run Playwright's MCP server?

We tried that first. Our server is not more careful; the difference is **where the decision is made**:

| | Playwright's MCP server | This sidecar |
|---|---|---|
| What the agent gets | **the browser** — 25 tools, including one that runs arbitrary JavaScript in the page | **four verbs** — the browser is a detail behind them |
| Where the limit lives | inside a server we do not own | a `switch` in the orchestrator, in your checkout |
| Can the limit be bypassed? | **yes** | nothing to bypass: the verb set *is* the narrowing |

A server that offers *the browser* has to be protected by a filter, and a filter is not enforcement when the
client can name the tool directly. A server that offers *four verbs* needs no filter, because it has no wider
door to draw a lock on.

**The measurement that settles it.** There is no allow-list: the server cannot be asked to withdraw a
dangerous tool. A session can still call one anyway — `tools/call browser_evaluate`, naming it directly and
sending **no auth header** — and it returns **200**. The server is the only enforcement point and it enforces
nothing, so "exclude the dangerous tools" is a lock drawn on the outside of the door.

That is also why what an attacker gains matters in three specific ways, named and graded below.

**What it costs us.** Parity. No network-idle wait, no rich console collection, no interaction beyond a single
click — for "fill this form, then pick that option", Playwright wins on capability. The dev-server port is also
predictable (`48000` plus the session number), so a squatter there can feed the renderer a page it did not
serve; every design that binds a loopback port shares that gap.

#### What is measured, and what is inferred

The tool count, the unauthenticated `tools/call` answering 200, the 401s and the closed verb set are
**measured**. The three scenarios below are not.

- **The confused deputy** — **inferred**: a session hands the browser a path it was itself denied, and the
  browser, running as you, reads it. Against four verbs there is no path to take.
- **The neighbouring session** — **inferred**: a compromised session scans loopback for another session's
  browser. Against four verbs it meets a per-session token.
- **The injected instruction** — **inferred**: a page under review tells the model to call a tool. Against
  four verbs there is no such tool to name.

The row-by-row grading is in
[docs/UI-SIDECAR-DESIGN-OPTIONS.md](docs/UI-SIDECAR-DESIGN-OPTIONS.md#what-is-measured-and-what-is-inferred).

### What it is not

The renderer runs with `--no-sandbox`, because Safehouse requires it, so the appended fragment is its only
confinement. That fragment is narrow on purpose: outbound traffic is pinned to **exactly one port** — this
session's dev server — with the rest of loopback and mDNS denied. It cannot reach the internet: `curl` to a
Google update host fails to resolve inside a session while the same request from the host answers 404. It holds
no agent identity, and cannot read your `~/.ssh`, git config, `gh` credentials or `~/.npmrc` — nor Pi's own
transcripts, so a browser in one session cannot read another's conversation. Stopping the session stops the
browser and deletes its config, policy and profile.

On a machine with no browser, the control is not shown rather than shown and inert. The `--no-sandbox`
concession and the alternatives are in [ADR-0018](docs/decisions/0018-ui-sidecar.md) and
[docs/UI-SIDECAR-DESIGN-OPTIONS.md](docs/UI-SIDECAR-DESIGN-OPTIONS.md).

## In your dock

Pi Central is a web app. Start it once (see [Install](#install)), open <http://127.0.0.1:8787>, then add
it to your dock from the browser's own menu:

| Browser | How |
|---|---|
| **Safari** | *File → Add to Dock* |
| **Chrome / Edge** | the install icon at the right end of the address bar, or *⋮ → Install page as app* |
| **Firefox** | **not supported** — Mozilla has no PWA install on desktop. The service worker still works; use another browser for the dock icon. |

You get the π mark in the dock and a window with no tab bar or address field. It is **not offline**,
deliberately: every screen is fed by the socket, so with the orchestrator down the app says
`disconnected` rather than showing a blank dashboard.

## As a native app

Optional: a real `.app` in `~/Applications` that keeps your sessions running when you quit.

```bash
git clone https://github.com/sven1103-agent/pi-central && cd pi-central
npm install && npm run install-app
```

No Apple Developer account and no admin rights. It is a **launcher**, not a second copy — it starts the
npm-installed package and shows its UI, so the npm package stays the only thing that is updated. The
signing identity that keeps macOS privacy grants across rebuilds, and what Gatekeeper will and will not
do, are in [docs/APP-SHELL.md](docs/APP-SHELL.md).

## What works, and what does not

Stated plainly, because a dashboard that overstates itself is worse than one that does less.

**Works:** several sandboxed sessions in different directories, with verified isolation; live transcripts
rebuilt from Pi's delta-only stream; the approval dock answerable for any session; a bounded tool trace you
can traverse; a read-only file tree and image viewer confined to the session's directory; images where they
belong in the conversation, including ones a tool read, plus screenshots pasted or dropped into the composer;
history searchable by content, with a clear refusal when a session's directory is gone; a roster that survives
a restart; agent-scoped credentials with the host's own denied, and commits signed as the agent.

**Not yet:** no file editing from the browser, no update checking, no export. The image size caps are derived from the
transport's frame limit rather than tuned against real reading. Each is a tracked issue rather than a wish.

## Working on this project

Work is organised as **increments** (GitHub milestones) containing **slices** (issues). A slice is sized
to land in one pull request and to be verifiable on its own. See
[docs/INCREMENTS.md](docs/INCREMENTS.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

```bash
npm install && npm run ui:build && npm run server   # from a checkout
npm test            # unit + component tests, all packages
npm run typecheck   # two configs: Node libs and DOM libs cannot share one
npm run check:docs  # every reference in every Markdown file resolves
npm run check:version # one version, declared once
```

Serving the built UI from the orchestrator is not only convenience: a Vite dev server watches
`packages/ui/src`, so an agent editing a component would reload the interface you are using out from
under you. For hot reload, run the dev server deliberately — see
[docs/DOGFOODING.md](docs/DOGFOODING.md).

### Keyboard

| Key | Action |
|---|---|
| `⌘N` | New session in an app-owned scratch workspace — no directory to choose |
| `⌘⇧O` | Open in a directory (the secondary path) |
| `Enter` | Send, or queue while a run is in progress |
| `Esc` | Answer an open dialog → close a popover → stop the run. Never clears your draft |

**Settings** shows which build is running, which protocol it speaks, where Pi Central keeps sessions,
workspaces and the agent root, and how to verify the install.

## Documentation

| Document | What it covers |
|---|---|
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | The Seatbelt nesting limit and its consequences (C1–C21) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, trust boundaries, lifecycle |
| [docs/SANDBOX.md](docs/SANDBOX.md) | How Safehouse is invoked per session, and what the policy denies |
| [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md) | Creating the agent identity a session runs as: SSH key, gitconfig, signing, `gh` |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The Pi RPC surface Pi Central depends on |
| [docs/STACK.md](docs/STACK.md) | TypeScript/Node orchestrator, React UI, rendering pipeline |
| [docs/USER-STORIES.md](docs/USER-STORIES.md) | What users need, and the constraints those needs create |
| [docs/PRINCIPLES.md](docs/PRINCIPLES.md) | The nine rules, in full |
| [docs/DOGFOODING.md](docs/DOGFOODING.md) | Using Pi Central to develop Pi Central, and what breaks if you do |
| [docs/RELEASING.md](docs/RELEASING.md) | Cutting a release: the version source, the tag, provenance, rollback |
| [docs/SECURITY.md](docs/SECURITY.md) | What the vulnerability scan covers, where results appear, and the gate |
| [docs/INCREMENTS.md](docs/INCREMENTS.md) · [docs/ROADMAP.md](docs/ROADMAP.md) | How work is sequenced, and the long view |
| [docs/UI-SIDECAR-DESIGN-OPTIONS.md](docs/UI-SIDECAR-DESIGN-OPTIONS.md) | The session browser: four verbs vs a containerised MCP server, with diagrams |
| [ADR-0018](docs/decisions/0018-ui-sidecar.md) | The session browser: why a sibling sandbox, four verbs, and one port |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [packages/ui/DESIGN.md](packages/ui/DESIGN.md) | The UI design system, as implemented |

## Principles

Three that explain most decisions. The full nine are in [docs/PRINCIPLES.md](docs/PRINCIPLES.md).

1. **Isolation is the feature.** Never trade per-session sandboxing for convenience.
2. **Never state something false.** A displayed value that is wrong is a defect, not a cosmetic issue.
3. **A peer, not a configurator.** Pi Central writes nothing into your Pi environment — no skills, no
   extensions, no settings.

## License

MIT — see [LICENSE](LICENSE).
