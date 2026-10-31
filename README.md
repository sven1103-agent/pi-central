<p align="center">
  <img src="assets/pi-central-logo-full-dark-mode.svg" alt="Pi Central" width="420" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-central"><img alt="npm version" src="https://img.shields.io/npm/v/pi-central" /></a>
  <a href="https://www.npmjs.com/package/pi-central"><img alt="npm downloads" src="https://img.shields.io/npm/dm/pi-central" /></a>
  <a href="https://github.com/sven1103-agent/pi-central/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/sven1103-agent/pi-central/actions/workflows/ci.yml/badge.svg" /></a>
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

**Who this is for.** People who already run `pi` and want more than one session at a time.
Contributors: jump to [Working on this project](#working-on-this-project).

**Status: works end to end, verified, and published.** The version is deliberately not written here —
`pi-central --version` reports the version of the package it shipped in. See
[docs/RELEASING.md](docs/RELEASING.md).

## Requirements

Check these first — Pi Central will not run without them, and it is better to know now.

| | Why | Check |
|---|---|---|
| **macOS** | Safehouse (the sandbox) has no Linux backend yet. | `uname` |
| **[Pi](https://pi.dev)** | Pi Central supervises `pi --mode rpc`; it is not a fork of it. | `pi --version` |
| **[Safehouse](https://github.com/earendil-works/safehouse)** | Composes the per-session sandbox profile. | `safehouse --help` |
| **Node ≥ 22** | The orchestrator runs TypeScript directly. | `node --version` |

## Quick start

```bash
npm install --global pi-central   # inert: this package runs no install scripts
npm audit signatures              # verify BEFORE the first run
pi-central
```

It prints the URL it is serving — <http://127.0.0.1:8787> unless you passed `--port`. One process serves
both the UI and the socket, so there is no dev server to start.

> **Run it from a plain terminal.** Not from an editor task, a sandboxed shell, or an agent harness.
> macOS Seatbelt does not nest: `safehouse` applies its policy with `sandbox-exec`, which cannot run
> inside an existing sandbox. Pi Central checks this before binding a port and refuses with an
> explanation rather than failing confusingly later. ([C1](docs/CONSTRAINTS.md))

Once it is running, [install it as an app](#install-it-as-an-app) and you will not need the terminal
again until the next reboot.

### Verify what you installed

`npm audit signatures` checks the **provenance attestation** every release carries — a signed statement,
minted by the release workflow's OIDC identity rather than a stored token, that this tarball came from
this commit via this workflow.

What it does **not** do: it is a check you have to run (npm does not refuse an unattested tarball), and
it answers *"did the publisher produce this?"* — not *"is the publisher trustworthy?"*. Pi Central runs
**outside** the sandbox with your privileges by design, because it is the component that spawns sandboxed
sessions. The attestation tells a tampered tarball from a genuine one; it cannot make a genuine tarball
safe.

`npx pi-central` has no window to check in: it fetches and executes in one step. If you use it, pin an
exact version (`npx pi-central@<version>`, where `<version>` is what `pi-central --version` reports).
The number is not written here on purpose — a README that restates a version goes stale, and
`scripts/check-version.mjs` refuses to let one.

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

The two boxes on top are ordinary and unremarkable. **The three frames below are the design**: the
orchestrator sits *outside* every sandbox, and each `pi` sits *inside* its own, with no frame shared
between them.

That shape is forced by one fact — **Seatbelt does not nest** ([C1](docs/CONSTRAINTS.md)). A process
already inside `sandbox-exec` cannot apply a second profile, so an architecture that hosted sessions
in-process would have no sandbox at all. The orchestrator must live outside and spawn one `safehouse`
invocation per session. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install it as an app

Pi Central is a web app that installs to your dock. Start it once (see [Quick start](#quick-start)),
open <http://127.0.0.1:8787>, then install it from the browser's own menu:

| Browser | How |
|---|---|
| **Safari** | *File → Add to Dock* |
| **Chrome / Edge** | the install icon at the right end of the address bar, or *⋮ → Install page as app* |
| **Firefox** | **not supported** — Mozilla has no PWA install on desktop. The service worker still works; use another browser for the dock icon. |

You get the π mark in the dock and a window with no tab bar or address field.

**It is not an offline app, deliberately.** Every screen is fed by the socket, so if the orchestrator is
not running the installed app says `disconnected` and nothing else. A window that claimed to work
offline would open onto a blank dashboard.

## What works, and what does not

Stated plainly, because a dashboard that overstates itself is worse than one that does less.

**Works:** multiple sandboxed sessions in different directories with verified isolation; live transcripts
reconstructed from Pi's delta-only stream; the approval dock answerable for any session; a bounded tool
trace with full traversal; a read-only file tree and image viewer confined to the session's directory;
history searchable by content, with a clear refusal when a session's directory is gone; a session roster
that survives a restart; agent-scoped credentials with the host's own credentials denied, and commits
signed as the agent when the store is configured to sign.

**Not yet:** no file editing from the browser, no update checking, no export. Each is a tracked issue
rather than a wish.

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
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | The Seatbelt nesting limit and its consequences (C1–C15c) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, trust boundaries, lifecycle |
| [docs/SANDBOX.md](docs/SANDBOX.md) | How Safehouse is invoked per session, and what the policy denies |
| [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md) | Creating the agent identity a session runs as: SSH key, gitconfig, signing, `gh` |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The Pi RPC surface Pi Central depends on |
| [docs/STACK.md](docs/STACK.md) | TypeScript/Node orchestrator, React UI, rendering pipeline |
| [docs/USER-STORIES.md](docs/USER-STORIES.md) | What users need, and the constraints those needs create |
| [docs/PRINCIPLES.md](docs/PRINCIPLES.md) | The nine rules, in full |
| [docs/DOGFOODING.md](docs/DOGFOODING.md) | Using Pi Central to develop Pi Central, and what breaks if you do |
| [docs/RELEASING.md](docs/RELEASING.md) | Cutting a release: the version source, the tag, provenance, rollback |
| [docs/INCREMENTS.md](docs/INCREMENTS.md) · [docs/ROADMAP.md](docs/ROADMAP.md) | How work is sequenced, and the long view |
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
