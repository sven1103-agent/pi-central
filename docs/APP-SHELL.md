# The desktop app

`npm run install-app` builds Pi Central's desktop shell, signs it, and installs it to `~/Applications/Pi Central.app`.
It needs **no Apple Developer account**, no admin rights, and no network beyond what `npm install` already did.

This is [ADR-0013](decisions/0013-application-shell.md) made concrete: the app is a **launcher**. It carries the
Electron main process and nothing else — no `bin/pi-central.js`, no `dist/ui` — and it starts the Pi Central you installed
with `npm`, then shows that process's loopback UI in a window.

## What you get, and what you do not

| | |
|---|---|
| ✅ A dock icon, a window that hides on close, `⌘Q` that asks before stopping your sessions | |
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

## Gatekeeper, honestly

`spctl -a ~/Applications/Pi Central.app` **fails**, and that is the accepted state:

```
Pi Central.app: internal error in Code Signing subsystem
```

Gatekeeper's assessment is about *notarization*, which needs a Developer ID this project does not have. What makes the
app run anyway is that **a bundle produced locally is not quarantined** — `npm`, `git`, `curl`, Homebrew and `cp` do not
set `com.apple.quarantine`; a browser download does. So an app you built on this machine runs, and the same app copied to
another machine may be refused.

**Do not disable Gatekeeper, and do not strip the quarantine attribute.** If you want this on another Mac, the supported
routes are:

- **build it there** — one `npm install && npm run install-app`;
- **a Homebrew tap or cask** — installs from a git-backed source and does not set the quarantine attribute.

`xattr -d com.apple.quarantine …`, "right-click → Open", and "allow apps from anywhere" are not instructions this project
gives, and the docs test fails if any of them appear.

## Uninstalling

```bash
rm -rf ~/Applications/Pi Central.app
rm -rf ~/Library/Application\ Support/Pi\ Central   # the app's own runtime record
```

Nothing else is left behind. The app installs into `~/Applications` precisely so that no step needs admin rights and
removal is `rm -rf` with no leftovers.

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
3. **It appears in Launchpad and the dock**, and `rm -rf` removes it completely.
