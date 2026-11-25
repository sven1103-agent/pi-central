# Contributing

Pi Central is a local, single-user tool. Contributions should preserve its two invariants:
**per-session sandboxing** and **an orchestrator that holds no untrusted content**.

## How work is organised

Work is **increments** (GitHub milestones) containing **slices** (issues). The full definition,
including what makes a slice finished, is in [docs/INCREMENTS.md](docs/INCREMENTS.md).

The short version:

1. Pick an issue. Check its **Governing constraints** section and read those first.
2. Its acceptance criteria are the contract. If one of them cannot fail, it is not a criterion —
   fix the issue before writing code.
3. Land it in one pull request, using the repository's PR template.
4. `npm run verify` must pass: typecheck, tests, and documentation references.
5. For a `verified/manual` slice, paste what you looked at. Automated checks passed on every
   defect this project shipped; looking at the result is not optional.

Labels carry the axes that matter: `kind/*` (slice, bug, decision), `area/*`, `verified/*`, and
`priority/*`. They are defined in `scripts/setup-github.mjs` so the taxonomy is reviewable rather
than remembered.

## If you are a coding agent

Read [AGENTS.md](AGENTS.md) first. It covers the rules that are easy to violate without noticing —
above all that the changelog is [a summary, not a transcript](docs/RELEASING.md#the-changelog-is-a-summary-not-a-transcript):
one line per change, with the issue it addresses, and the reasoning in the commit message instead.

## Before you change anything

Read, in this order:

1. [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) — the hard limits (C1–C20). Most "obvious"
   designs are ruled out here.
2. [docs/decisions/](docs/decisions/) — why the architecture looks the way it does.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components and trust boundaries.

## Using Pi Central while developing it

It works, and it is the fastest way to find this tool's problems — but **not from the checkout you
are working in**. Three things break otherwise: Vite hot-reloads the interface you are using, a
branch switch desynchronises UI and orchestrator, and if an agent breaks the orchestrator you lose
the tool you need to fix it.

Run it from one checkout and let agents work in another. The full reasoning, including why a
separate clone beats a git worktree, is in [docs/DOGFOODING.md](docs/DOGFOODING.md).

## Branch rules

`main` is protected by a **ruleset**, and **the rules apply to administrators too** — so a direct
push is refused by design, not by accident:

```
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
remote: ! [remote rejected] main -> main (push declined due to repository rule violations)
```

Land changes through a pull request:

- A pull request is required; **no approving review is required**, because the repository has one
  maintainer and nobody can approve their own work. The gate is CI, not a second person.
- Both checks must pass: **`verify`** (typecheck, tests, documentation references) and
  **`docs-links`**.
- The branch must be **up to date with `main`** before merging, so what was tested is what lands.
- **Linear history**: squash or rebase, no merge commits.
- Force pushes and branch deletion are refused.
- Unresolved review comments block the merge.

The settings live in [.github/ruleset.json](.github/ruleset.json) and are applied by
`node scripts/setup-github.mjs`. That script refuses two silent failure modes: a required check
name no workflow produces (which blocks every merge forever without erroring), and an
`enforcement` of anything other than `active` (which reports as configured while enforcing
nothing).

To relax any of this, change the file and re-apply. It is recorded rather than clicked.

### Why a ruleset and not a classic branch-protection rule

Both are supported and they layer. The reason this repository uses a ruleset is specific:
`GET /repos/{owner}/{repo}/rules/branches/{branch}` — the modern way to ask "what protects this
branch?" — **does not report classic branch protection at all.** A correctly protected branch
therefore reads as *no rules* to anyone checking there, which is exactly the wrong conclusion to
hand someone.

Rulesets also support named bypass actors, should an emergency valve ever be wanted; today there
are none, so the rules bind administrators as well.

## Rules

- **Do not relax sandboxing.** Never pass `--allow-workdir-config-writes`,
  `--allow-profile-writes`, or `--enable=wide-read` for supervised sessions.
- **Never run untrusted content in the orchestrator.** No `eval`, no shell interpolation
  of transcript or file content, no `spawn` of anything not hard-coded. Model output is a
  string for display.
- **Never grant the orchestrator a union of workdirs.** See ADR-0002.
- **Verify constraints, don't assume them.** If you rely on C\\* being true, cite it and,
  where practical, add a test that fails loudly if it stops being true.
- **One live process per `(sessionPath, cwd)`.** See ADR-0004.

## Changing a decision

Do not edit an accepted ADR to say something new. Write a superseding ADR and mark the old
one `Superseded by ADR-NNNN`. Premises can expire: re-verify C1–C8 when Pi or Safehouse
is upgraded.

## Commits

Conventional-ish, imperative subject, lowercase after the type:

```
docs: add session identity ADR
spike: verify per-session profile independence
```

## Verification

Nothing about isolation should be asserted without a test. The Phase 0 harness in
[docs/SANDBOX.md](docs/SANDBOX.md#verification-harness) is the reference: two sessions,
two cwds, cross-access must fail.

## The recording in the README

The dashboard image in `README.md` is a real window, and it is worth keeping that way — a mockup
cannot show the tool trace's durations, a live `responding` state, or the fleet counts. It is an
animated GIF (`docs/images/dashboard.gif`) made from a screen recording, not a still.

**Why a GIF.** GitHub sanitises `<video>` out of a README body, so a repo-relative
`<video src="docs/…mp4">` renders as *nothing*. Five repositories were checked — three different
spellings, including an absolute `raw.githubusercontent.com` URL — and all rendered zero video
elements. Only a GIF is served inline, loops by itself, and needs no player. Measured, not assumed.

**How to record and convert one**

1. Run a session that is **mid-run** (`working`, ideally with a couple of tool calls behind it). A
   finished session shows none of the live states, and an empty one shows nothing at all.
2. Keep the right-hand panel **open** for the recording: it is what carries the model and thinking
   pickers, and the panel is the part of the layout a still cannot explain.
3. Record at whatever size the window naturally is on your display, then **crop to the app window** —
   the browser's own tab strip and address bar are not the product, and a capture of them reads as a
   screenshot of a web page rather than of an app.
4. Save the converted loop as `docs/images/dashboard.gif` — that path is referenced from the README,
   and `check:docs` fails if it stops resolving.

**Converting a `.mov` to a GIF that is worth watching.** A naive `ffmpeg` conversion of a 30-second
UI capture lands near 25 MB. What fits is a short loop at a small frame rate with a shared palette:

```bash
ffmpeg -ss 1.5 -t 14 -i "Screen Recording.mov" \
  -vf "crop=1728:996:34:79,fps=10,scale=1152:-1:flags=lanczos,\
       split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=none" \
  -loop 0 docs/images/dashboard.gif
```

Three choices in that line, each measured rather than copied:

- **`crop`** removes the browser chrome. Find the rectangle once with
  `ffmpeg -i in.mov -vf cropdetect=limit=24:reset=0 -frames:v 60 -f null -` and read the last line;
  cropdetect stops at the window edge, not the tab strip, so drop the remaining toolbar rows by hand.
- **`dither=none`** with a full-frame palette beats `bayer` here: this UI is flat panels and text, so
  ordered dithering only adds moving noise around every glyph. Bayer measured slightly *larger* on the
  same footage (0.72 MB against 0.70 MB) and visibly grainier.

**What actually makes the file big** — the four levers on one crop and one clip, measured:

| Change | Size |
|---|---|
| 14 s, 10 fps, 192 colours, 1152 wide — the shipped loop | **0.70 MB** |
| 12 fps instead of 10 | 0.76 MB |
| 256 colours instead of 192 | 0.74 MB |
| 12 fps at 224 colours | 0.78 MB |
| 1440 wide instead of 1152 | 1.00 MB |
| 20 s instead of 14 | **3.77 MB** |

So frame rate and colour depth barely matter, and **duration is the one that runs away** — not linearly,
because a longer clip is a *busier* clip: the transcript streams in, and each new frame differs from the
last where the earlier ones stood still. Cut seconds before you cut anything else. Width is the second
lever. Keep the loop under about 1 MB.

GitHub serves the GIF at its blob resolution, so a wider one is not sharper in a README column — it is
only heavier.

**The macOS recording filename is gitignored.** A capture lands as `Screen Recording 2026-11-24 at
14.22.39.mov`, with spaces and a capital `S`; `.gitignore` names the `Screenshot*.png` pattern but
*not* `.mov` files, so delete or move the source recording once the GIF is made rather than leaving it
in the working tree. The GIF itself is `docs/images/dashboard.gif`, which is deliberately not ignored.

**Before committing, check the image for things that are not the product**

- **Paths.** Pi Central shortens `$HOME` to `~` in the rail and the header, so a normal window is
  usually fine — but the tool trace prints the *commands* that ran, and those can contain absolute
  paths, hostnames, or repository names that are nobody's business.
- **Session names.** `New session` names are yours. If a screenshot is captured while working on
  something private, rename the session first.
- **Anything else on screen.** The orchestrator binds loopback, so a capture is a capture of your
  machine.

The alt text in the README describes what is *visible* — the rail, the transcript, the tinted
first-person turn, the trace, the collapsed panel. If the layout changes, the alt text is part of the
change: it is the image's content for anyone who cannot see it.
