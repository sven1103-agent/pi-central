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

**Who this is for.** People who already run `pi` and want more than one session at a time.
Contributors: jump to [Working on this project](#working-on-this-project).

![Pi Central's dashboard: a session rail on the left listing one running, one idle and one stopped
session with their working directories and context burn; the transcript in the middle showing the
assistant's prose, a first-person turn containing a pasted screenshot rendered inline with its type
and size, and a collapsed "Thinking…" group below it; the session panel on the right with the model
and thinking pickers; the composer at the foot with its key hints and an auto-follow toggle; and a
topbar reading two sessions, one running, one scratch and connected.](docs/images/dashboard.png)

<!-- The screenshot predates the activity bars: it still shows the wordmark and the combined
Sessions|History strip in the topbar. Alt text describes the IMAGE, so it is left matching what the
file actually shows; the description of the current layout is in the prose and in DESIGN.md. Retaking
it needs a browser, which the agent sandbox cannot launch. -->

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

The two boxes on top are ordinary and unremarkable. **The three frames below are the design**: the
orchestrator sits *outside* every sandbox, and each `pi` sits *inside* its own, with no frame shared
between them.

That shape is forced by one fact — **Seatbelt does not nest** ([C1](docs/CONSTRAINTS.md)). A process
already inside `sandbox-exec` cannot apply a second profile, so an architecture that hosted sessions
in-process would have no sandbox at all. The orchestrator must live outside and spawn one `safehouse`
invocation per session. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

**Works:** multiple sandboxed sessions in different directories with verified isolation; live transcripts
reconstructed from Pi's delta-only stream; the approval dock answerable for any session; a bounded tool
trace with full traversal; a read-only file tree and image viewer confined to the session's directory;
images shown where they belong in the conversation, including the ones a tool read, and screenshots pasted or
dropped straight into the composer;
history searchable by content, with a clear refusal when a session's directory is gone; a session roster
that survives a restart; agent-scoped credentials with the host's own credentials denied, and commits
signed as the agent when the store is configured to sign.

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
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | The Seatbelt nesting limit and its consequences (C1–C20) |
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
