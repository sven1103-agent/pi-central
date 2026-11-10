# The desktop app

`npm run install-app` builds Pi Central's desktop shell, signs it, and installs it to `~/Applications/Pi Central.app`.
It needs **no Apple Developer account**, no admin rights, and no network beyond what `npm install` already did.

This is [ADR-0013](decisions/0013-application-shell.md) made concrete: the app is a **launcher**. It carries the
Electron main process and nothing else — no `bin/pi-central.js`, no `dist/ui` — and it starts the Pi Central you installed
with `npm`, then shows that process's loopback UI in a window.

## What you get, and what you do not

| | |
|---|---|
| ✅ A dock icon **with Pi Central's mark** — not Electron's — a window that hides on close, `⌘Q` that asks before stopping your sessions | |
| ✅ Sessions that outlive the app, reattached on the next launch | |
| ✅ An app that can apply Pi Central updates when npm installed it somewhere writable | |
| ❌ **No self-update** for the app bundle itself — bumping Electron means re-running `install-app` | |
| ❌ **No `.dmg`, no notarization** — a Developer ID is required for both, and there is none | |
| ❌ **No App Sandbox** — the orchestrator must spawn `safehouse` (C1) | |

The npm package remains the only distributable. The app is not published anywhere, and the build fails if someone adds a
`dmg`, `notarize` or `publish` target — the failure mode of adding one is a release pipeline that cannot complete, so it is
caught at build time instead.

## Building it

```bash
npm install
npm run install-app
open ~/Applications/Pi Central.app
```

The script refuses to run on anything but macOS arm64, and fails loudly rather than producing a half-signed bundle. It
also audits the artifact after building: if the bundle ever starts carrying product code, or an identifier, or a version
that disagrees with the package, the build stops before installing.

## The icon

The bundle carries Pi Central's mark in `Contents/Resources/icon.icns`, so the dock, ⌘-Tab, the About panel, Finder and
Launchpad all show it. It is built from the one source of the artwork — `packages/ui/src/assets/logo-icon.svg`, the same
file the tab icon and the PWA icons come from — and it is *assembled*, not drawn:

```bash
npm run build:icon     # packages/app/build/icon.png + icon.icns
```

`npm run install-app` runs that itself, so a redrawn logo reaches the bundle without anyone remembering a second command.

**The icon started out as Electron's, and the build said nothing.** `electron-builder` treats *no icon configured* as a
warning and copies the framework's, so the first bundle carried `electron.icns` byte-for-byte — the app launched, the
version was right, and the picture was wrong everywhere. Its absence is now a build-time refusal, and the built bundle's
icon is compared against the Electron distribution this build was given, so "we shipped Electron's icon" cannot happen
silently again.

Two things worth knowing if you touch this:

- **The container is written byte by byte**, not by `iconutil`. On macOS 26.7.2 `iconutil -c icns` reports
  `Invalid Iconset.` for a complete, correctly named set — including one it had just extracted itself from Electron's own
  valid `.icns`. `sips` produces the PNGs and the container is 20 lines of Node; the run ends by reading it back through
  `sips`, so a malformed file fails there rather than in the dock.
- **The mark fills the canvas — do not add a margin.** The first version inset the drawing to 824 of 1024 px, on the
  belief that this was "the macOS content box". Measured on the result: the dock showed a light rounded plate with a
  **grey margin between the plate and the green circle**, because macOS 26 draws the tile and the plate itself and
  expects the artwork to fill it — so the inset landed a second time, inside the system's. Electron's own icon, the
  reference that was available all along, has an opaque box of 922/1024 px. The native macOS 26 form is an `Assets.car`
  built by Icon Composer, which needs Xcode 26 and `icontool`; `xcrun --find icontool` reports *"not a developer tool"*
  on a Command Line Tools machine, so the `.icns` path is what this project can produce.

A development run (`npm run app`) has no bundle of ours — it launches Electron out of `node_modules` — so the shell sets
the dock icon from the generated PNG itself. In a packaged launch it deliberately does **not**, because the bundle is
authoritative and overriding the tile from the same file could only make Finder and the dock disagree.

## Running a development build

`npm run app` runs the shell from the checkout, and it is **isolated by construction** — it cannot touch the installed
app:

| | installed app | `npm run app` |
|---|---|---|
| app name | `Pi Central` | `Pi Central (dev)` |
| state (`userData`) | `~/Library/Application Support/Pi Central` | `…/Pi Central (dev)` |
| orchestrator state | `~/.config/pi-central` | `~/Library/Application Support/pi-central-dev` |
| runtime record | shared | **its own** |

That separation exists because the absence of it caused two destructive incidents:

- `npm run install-app` **deleted a Safari PWA**, because "Add to Dock" writes the web app to
  `~/Applications/Pi Central.app` — the same path this script installed to. The script now refuses to touch a bundle
  whose `CFBundleIdentifier` is not `com.pi-central.app`, and it copies to a staging path and renames, so a failed copy
  leaves the previous installation intact.
- `npm run app` shared `userData` with the installed app, so a dev run could adopt the stable installation's
  orchestrator and **remove its `runtime.json` on quit**.

What is deliberately *shared* is your Pi installation (`~/.pi`) and your agent root (`~/.agent`). A dev build has to test
the real thing, and `resolveAgentRoot` treats `~/.agent` as external and read-only, so redirecting the state root does
not create a second credential store.

**The dev window says so**: its title is `Pi Central (dev)`, and the terminal prints which state directory it is using.

## Keeping your privacy grants across rebuilds

**This is the part that gets skipped, and then gets reported as a bug.** macOS keys privacy permissions (Documents,
Desktop, Downloads) to a binary's *code identity* — its cdhash. An **ad-hoc** signature's cdhash is derived from the
contents, so:

- rebuild the app → new cdhash → macOS sees a different application → **it asks for Documents access again**;
- and again on the next rebuild, forever.

Verified in this repository: signing the same file with different contents produces different cdhashes. That is why the
first rebuild after installing feels like a regression and is not one.

**The fix is a one-time self-signed certificate, and it is free.** It gives the app a stable identity, so the cdhash stops
changing and the grants survive.

1. Open **Keychain Access** → *Keychain Access* menu → **Certificate Assistant** → **Create a Certificate…**
2. Name it something recognisable, e.g. `Pi Central Dev`.
3. **Identity Type: Self Signed Root**. **Certificate Type: Code Signing**.
4. Create it (it goes in your *login* keychain), then build with it:

```bash
PI_CENTRAL_SIGN_IDENTITY="Pi Central Dev" npm run install-app
```

The script uses that identity when the variable is set. Without the variable it looks for any valid code-signing identity
on the machine; with neither, it signs ad-hoc and **says so**, including the caveat above — because "my permissions reset
after every rebuild" is otherwise indistinguishable from a defect in this app.

To check which identity a built app carries:

```bash
codesign -dv ~/Applications/Pi Central.app 2>&1 | grep -E "Identifier|Authority|Signature"
```

`Signature=adhoc` means the grants will not survive a rebuild. An `Authority=` line naming your certificate means they
will.

## Gatekeeper, and why there is no downloadable `.app`

`spctl -a ~/Applications/Pi Central.app` **fails**, and that is the expected state:

```
Pi Central.app: internal error in Code Signing subsystem
```

Gatekeeper's assessment is about **notarization**, which needs a paid Apple Developer account. What makes the app run
anyway is that **a bundle produced locally is not quarantined**: `npm`, `git`, `curl`, Homebrew and `cp` do not set
`com.apple.quarantine`, and macOS only assesses a bundle that carries it. So an app you built on this machine runs, and a
copy sent to another machine may be refused.

### The two routes that used to exist, and what happened to them

This section previously named two supported ways to get the app onto another Mac. **One of them no longer exists**, and
it is worth stating plainly rather than leaving a dead instruction:

| route | status |
|---|---|
| **build it there** — `npm install && npm run install-app` | ✅ still works. No quarantine, so no Gatekeeper assessment. |
| **a Homebrew tap or cask** | ❌ **closed.** Homebrew ended support for any cask that fails a Gatekeeper check on **1 September 2026**, and removed `--no-quarantine`. A cask can no longer carry an un-notarized app to a reader. |

So there is **no route from "I want this app" to a working bundle** that avoids notarization. Shipping a `.app` to
strangers needs a Developer ID and a notarization step; neither exists here. That is a decision recorded in
[ADR-0013](decisions/0013-application-shell.md), and the question of whether to change it is tracked as an issue rather
than as a wish.

**What this does not block.** The app is for people who have the checkout — it is a power-user surface over a package
they installed themselves. Everyone else gets the same dock icon and standalone window by **adding the web app to their
dock** (Safari: *File → Add to Dock*), which needs no checkout, no signature and no Gatekeeper conversation. The README's
install section is the place to start.

> Deliberately a sentence rather than a link to that section: this file and the README are edited on separate branches,
> and a link to a heading one of them renames fails the docs check on whichever branch merges second. The action is
> named instead, so neither branch can break the other.

**Do not disable Gatekeeper, and do not strip the quarantine attribute.** `xattr -d com.apple.quarantine …`,
"right-click → Open", and "allow apps from anywhere" are not instructions this project gives, and the docs test fails if
any of them appear.

## Uninstalling

```bash
rm -rf ~/Applications/Pi Central.app
rm -rf ~/Library/Application\ Support/Pi\ Central   # the app's own runtime record
```

Nothing else is left behind. The app installs into `~/Applications` precisely so that no step needs admin rights and
removal is `rm -rf` with no leftovers.

## When something goes wrong: the log

A bundle launched from Finder has no terminal, so the app writes its diagnostics to a file:

```
~/Library/Logs/Pi Central/main.log
```

Open it from the app's own menu — **Pi Central → Reveal Log in Finder**, or **Open Log in Console…** — or from a shell:

```bash
tail -50 ~/Library/Logs/Pi\ Central/main.log
```

Every line has a timestamp, a level and the message, so a repeating failure reads as a repeating failure:

```
===== Pi Central started 2026-11-09T15:56:02.898Z =====
2026-11-09 15:56:02.900 LOG   Pi Central: orchestrator at ws://127.0.0.1:51234 (pid 4242)
2026-11-09 15:56:02.901 WARN  Pi Central: leaving the orchestrator running (pid 4242)
```

The file rotates at 1 MiB and keeps three generations, because a failing loop can fill a log in seconds.

**This is the file to attach to a bug report.** It records the launch resolution (which `node`, `pi` and `safehouse` were
found and how), every quit decision, every update attempt, and the reason a child was restarted — the questions that
otherwise need a terminal this app does not have. A dev run (`npm run app`) uses the same log, under
`~/Library/Logs/Pi Central (dev)/`.

## If your `pi` is a shell alias

Some setups put an alias in `.zshrc` rather than installing a program:

```zsh
alias pi='~/.config/sandbox-exec/run-sandboxed.sh'
```

**Pi Central deliberately ignores that alias.** It launches `pi` under Agent Safehouse, which is `sandbox-exec` itself
(C1), so running an alias that wraps `pi` in another sandbox would nest Seatbelt twice and fail with `EPERM`. The app
therefore resolves the **real binary** — `whence -p pi`, which skips aliases, functions and hashed entries — and uses
that.

You will see this in the app's log or in a failure panel, never silently:

```
pi is a shell ALIAS in /bin/zsh (alias pi=…), not a program, so there is no binary to launch. Pi Central runs `pi`
under Agent Safehouse and deliberately does not use the alias: an alias usually wraps the command in its own sandbox,
and Seatbelt does not nest (C1). Install pi as a normal program (or set PI_CENTRAL_PI to its real path — for `pi` the
binary is usually /opt/homebrew/bin/pi, …).
```

If `pi` is *only* an alias on your machine, install the real thing (`npm install -g @earendil-works/pi-coding-agent`, or
whatever your setup uses) or point the app at it directly:

```bash
PI_CENTRAL_PI=/opt/homebrew/bin/pi open ~/Applications/Pi\ Central.app
```

The sandbox your alias provides is not lost: Pi Central applies its own — a per-session Seatbelt profile through
Safehouse, which is stricter than a single wrapper because each session gets its own working-directory grant.

## Why there is no App Sandbox

The app must be able to spawn `safehouse`, which applies a Seatbelt profile to each session. Seatbelt does not nest (C1),
so a sandboxed app cannot be the thing that sandboxes its children. The app is therefore signed **without** the App
Sandbox entitlement and **without** the hardened runtime — the latter is what notarization requires, and adding it would
mean adding Electron's JIT entitlements, which is how an entitlement list becomes a sandbox hole in a launcher.

## What is still manual

Three claims cannot be checked by a test, and they are the ones to verify by hand after a change to the build:

1. **The app starts from Finder** on a machine with no Developer ID.
2. **A grant survives a rebuild** — grant Documents access, rebuild, relaunch, and it is still there (with a
   self-signed identity; with ad-hoc it will not be, by design).
3. **It appears in Launchpad and the dock** — with Pi Central's mark, not Electron's — and `rm -rf` removes it completely.
