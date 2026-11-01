# AGENTS.md

Instructions for coding agents working in this repository. Human contributors should read
[CONTRIBUTING.md](CONTRIBUTING.md); this file exists because an agent will otherwise do the
reasonable-looking thing and be wrong.

---

## The changelog is a summary, not a transcript

**One line per change, and the issue number it addresses.**

```markdown
### Fixed

- Open sessions are reopened at the next start, in their recorded directories and modes ([#185]).
- A process that never started no longer makes shutdown wait forever ([#185]).
```

Then one reference block at the end of the file:

```markdown
[#185]: https://github.com/sven1103-agent/pi-central/issues/185
```

### The rules, precisely

1. **One line per change.** Not one paragraph per change, and not one section per thought. If a
   change needs two lines, consider whether it is two changes.
2. **Reference the issue** with `([#N])` when one exists, placed on the bullet's **first** line —
   `scripts/changelog-links.test.mjs` only scans lines that start with `- `, so a reference on a
   continuation line reads as an undefined number and fails the check.
3. **No rationale, no history, no measurements, no falsification lists.** The changelog answers
   *"what changed between these versions"*. It does not answer *"why is it like this"*.
4. **No bare `#N`.** Always `[#N]` plus a definition, and the definition must point at the **kind**
   of object the number actually is (`/issues/` for an issue, `/pull/` for a PR). GitHub serves
   `/issues/N` for a pull request too, so a wrong kind still clicks through.
5. **Reference-style links, never inline.** Inline URLs pushed entries to 325 characters.

### Where the reasoning goes instead

Everything the changelog is not allowed to contain is still worth writing down — just elsewhere:

| What | Where |
| --- | --- |
| Why the change is shaped this way | the **commit message** |
| The full argument, alternatives rejected, evidence | the **PR body** |
| A decision with lasting architectural weight | a new **ADR** in `docs/decisions/` |
| A hard limit discovered by breaking it | **`docs/CONSTRAINTS.md`** (C1–C15) |
| How a defect escaped and what now prevents it | the **test's own header comment** |

The commit message is the natural home for a paragraph like *"the worker applied the inverse of the
server's rule…"*. That is exactly the content that used to bloat the changelog.

### Why this is written down twice

The rule already lived in [docs/RELEASING.md](docs/RELEASING.md#the-changelog-is-a-summary-not-a-transcript),
and the `Unreleased` section still grew to 1,795 lines for 68 changes — 1,915 characters per entry —
because the rule was in a file nobody reads while appending an entry. A released changelog that has
to be compressed again is the signal that this section was ignored.

---

## Also worth knowing before you start

These are the mistakes that are cheap to avoid and expensive to find:

- **Read `docs/CONSTRAINTS.md` first** (C1–C15). Most "obvious" designs are ruled out there, and the
  constraint usually explains why in one paragraph.
- **`npm run verify` must pass** (typecheck + tests + doc references + version agreement). Adding a
  `[#N]` definition without a reference, or a reference without a definition, fails it.
- **A new test must be able to fail.** This repository's norm is to state the falsification: revert
  the fix, watch the named test fail. A test that passes either way is not evidence.
- **Do not write comments that restate the code.** The existing comments explain decisions and
  measured failures; match that density, and put a paragraph-long explanation in the commit message
  rather than above a ten-line function.
- **Never state the current version in prose**, and never a version in a README. `npm run
  check:version` enforces it — point at `docs/RELEASING.md` instead.
- **One writer per working directory.** Do not run Pi Central from a checkout an agent is editing;
  see [docs/DOGFOODING.md](docs/DOGFOODING.md).
