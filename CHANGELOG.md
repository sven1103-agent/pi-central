# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

This project's early history was a research spike plus a hard look at what the spike got wrong, so
several entries below record **defects that shipped and were fixed** rather than only features.
They are kept because each one is the reason a constraint or an invariant test exists.

## [Unreleased]

### Changed

- **The right panel is collapsed by default, and the user decides** (issue #75). It had gone from
  `display: none` below 1440px to permanently visible, which was an over-correction: on a normal
  window it took roughly as much room as the transcript, to show material nobody reads while working.
  Session facts and the file browser are special-purpose views, not something to keep in front of you.

  `PanelToggle` now sits in the topbar — where `styles.css` already said the control belonged, when
  the panel became permanent — and its label states the **action** (`Show panel` / `Hide panel`) while
  `aria-expanded` carries the state, because a label that reads as a status gets clicked twice. The
  panel's width and mode survive being hidden, so re-opening returns it where the user left it.

  The stored `collapsed` field is read as `!== false`, so an absent value — anyone who used an earlier
  build — means the new default rather than "expanded"; an `=== true` test would have opened the panel
  for every existing user.

  The panel is not rendered while collapsed rather than rendered at zero width, and
  `.panes.is-collapsed` removes its grid track so hiding the panel does not leave an empty column. The
  `≤1023px` query had to be taught to name `.panes.is-collapsed` too: that selector out-specifies a
  bare `.panes` and would otherwise have won inside the query, leaving a 288px empty track where the
  hidden rail used to be.

### Fixed

- **A release design note claimed a guarantee the registry does not provide, and that claim is what
  stopped anyone checking that it held** (issue #66). Three places — `bootstrap-publish.mjs`,
  `docs/RELEASING.md` and this file — said the bootstrap's hard-coded `--tag next` was a *structural*
  guarantee that the un-attested throwaway could never become what `npm install pi-central` resolves
  to. It is not one: on the first real publish the registry set `latest` to the throwaway, and a
  plain install received an artifact with **no provenance attestation** until the real release landed
  minutes later. The same failure shape as #46's false `~/.ssh` rationale — a stated guarantee is
  what makes a check look unnecessary.

  **The mechanism was measured, not inferred.** Pointing `npm publish --tag next` at a local HTTP
  stub and reading the request body shows the client sends `"dist-tags":{"next":"…"}` and nothing
  else — and, on a second probe where the stub reported an existing `latest`, still no `latest`. So
  the client never *asks* for it, which means the **registry** decides and no flag can prevent it.
  Which registry rule fires on a first publish is not determinable from this machine and is recorded
  as open rather than guessed at.

  Since it cannot be prevented it is checked: `latestPointerProblem` is a tested pure function, the
  bootstrap now reads the dist-tags back after publishing and prints the `npm deprecate` correction
  if `latest` is the throwaway, and verifying `npm view pi-central dist-tags` is now **step 9** of the
  release checklist and part of the workflow's approval notice. A test pins that step and forbids the
  false guarantee from being re-asserted — including in the test whose own *name* carried it.

<!-- Empty at tag time: `scripts/check-version.mjs --release` refuses to release while this holds entries, so a release cannot silently ship undocumented changes. An HTML comment is exempt from that check, which is why this note is here rather than a paragraph. -->

## [0.2.0] — 2026-10-26

The first published release. `0.1.0` was never tagged or published, so it stays the recorded name of
Increment 1 and nothing below is rewritten; this section is what Increment 1's `## [Unreleased]` had
accumulated. Versioning is `npm version <x.y.z> --workspaces --include-workspace-root`, so the root
manifest and the three private workspace manifests cannot disagree.

### Added

- **A release workflow, and one version instead of six claims about it** (issue #53). The shipped
  version was asserted in six places with no mechanism between them — `package.json`, `README.md`
  ("Status: v0.1.0"), a `CHANGELOG.md` heading, and three private workspace manifests — and the
  failure mode was the worst kind: every one of them reads as authoritative, so a disagreement
  produces *confident* documentation rather than an error. `0.1.0` had in fact already been claimed
  twice, once as the package version and once as the name of Increment 1.

  `scripts/check-version.mjs` now runs as part of `npm run verify`, so every pull request and every
  commit to `main` is held to four rules: the four manifests agree; **no prose states the current
  version** (older versions are history, and allowed); **no README states any version at all**,
  including a third party's, because "verified against Pi 1.4.0" is wrong the moment Pi ships; and the
  newest `## [x.y.z]` heading matches the manifest.

  The decisions are pure functions in `scripts/version-policy.mjs` with 28 unit tests, because a
  guard that has quietly become permissive reads exactly like a guard that works. Four bugs were
  caught by those tests rather than by luck, and each is a lesson about writing a checker:

  - `\Z` is not a JavaScript escape, so it matched a literal "Z" and the *last* CHANGELOG section
    never parsed.
  - The first version-literal lookahead banned any trailing dot, which rejected "shipped 0.2.0." — a
    sentence ending, the commonest prose form there is.
  - Banning only a dot-followed-by-digit then let `10.20.30.40` match as `10.20.3`, because the
    engine simply gave the trailing digit back.
  - The lockfile check read `package-lock.json`'s `packages` map as if every entry were ours. It
    maps every installed package, so it demanded that `ws`, `react` and some three hundred others
    all equal our version. Same "too broad" mistake as the regex, one layer down.

  `package-lock.json` is covered because it records the version a fourth time and `npm ci` compares
  it with the manifests: a version bumped without regenerating the lock breaks the build on the
  *next* machine, not the author's, whose `node_modules` is already installed.

- **Publishing is a tag, and it carries a provenance attestation** (issue #53).
  `.github/workflows/release.yml` triggers on a version tag, re-runs every gate on the tagged commit,
  **refuses when the tag and the manifest disagree**, builds, publishes with `--provenance`, and
  creates the GitHub Release whose body is the CHANGELOG section for that version — derived from the
  file by `scripts/release-notes.mjs`, so the release page cannot become a second, worse changelog.

  Authentication is **OIDC, with no stored token**: the workflow declares `id-token: write` and
  references no GitHub secret at all, and a test fails if one is reintroduced. A stored publish token
  is a credential that must be rotated, can be exfiltrated by a compromised dependency, and outlives
  whoever created it. That test scans the workflow as **text**, deliberately — for "is there a secret
  here", broader is correct, and it caught its own documentation twice while being written.

  `npm publish --dry-run` now runs on **every pull request**, so the tarball's file list is reviewed
  before a release rather than at the moment of one, when a stray file can only be deprecated and
  never removed. Release mode (`--release`) additionally refuses to release while `## [Unreleased]`
  holds entries, which is what stops a release shipping undocumented changes.

  [docs/RELEASING.md](docs/RELEASING.md) records the process and the rollback — `npm deprecate` plus
  a patch release, because `npm unpublish` breaks everyone who already resolved the version.

- **The first publish is a manual bootstrap, and it is guarded** (issue #61). The workflow above
  publishes over OIDC, which needs a trusted publisher — and npm only configures one **on a package
  that already exists** (`npm help trust`: *"Package must exist: The package you're configuring must
  already exist on the npm registry"*). So the workflow cannot perform the first publish, and the
  documentation previously glossed that as "claim the package name", which is circular.

  The bootstrap must be a **pre-release**, and that is a correctness requirement rather than a
  preference: npm never allows republishing a version, so a final version published by hand could
  never be published again and could therefore **never carry a provenance attestation** — the first
  release would be permanently the one artifact nobody can verify. `scripts/bootstrap-publish.mjs`
  refuses a final version (the rule is a tested pure function, not prose in a document), refuses
  build metadata on its own because npm orders `x.y.z+build` as the release itself, and hard-codes
  `--tag next` so the un-attested artifact is never *requested* as `latest`.

  That last clause originally claimed the throwaway could never become the install target. It was
  **false** — the registry set `latest` to the pre-release on the first publish anyway — and it is
  corrected in place rather than deleted, because a sentence that reads as a guarantee is exactly
  what stopped anyone checking (issue #66).

  A pre-release is **documented by its base release** (issue #63), so `0.2.0-rc.1` needs no
  `## [0.2.0-rc.1]` heading: it is a candidate for `0.2.0`, and `## [0.2.0]` is where those notes live, with a preamble
  on the Release page saying which version they describe. The alternative — hand-editing the changelog
  to document something it will never mention again — is friction that gets a documented process
  abandoned. The rule is a tested pure function (`releaseNotesRefusal`, `baseVersion`), because prose
  in a document is not a check.

  The release notes are also now generated **before** the publish rather than after. Both steps
  existed either way; only the order decides which failure you get, and generating them last meant a
  version with no CHANGELOG section reached the registry and *then* failed — an artifact that can
  never be re-published, with no Release and a red build. A test asserts the order by position.

  The documented sequence was rehearsed verbatim rather than recalled: the `npm version … -rc.1`
  bump updates all four manifests *and* the lockfile, and the dry run published
  `+ pi-central@0.2.0-rc.1 … with tag next and public access`. `--provenance` is impossible off CI —
  the attestation is built from the CI provider's OIDC identity — which is precisely why the *real*
  release must not be the manual one.

  A defect in issue #53's own test was found by this rehearsal and fixed (issue #63):
  `release-workflow.test.mjs`
  re-implemented the notes lookup as an exact `version === declared` match instead of calling the
  shared rule, so it passed for a final version and broke the instant a pre-release appeared — while
  `release-notes.mjs` was behaving correctly. **A test that disagrees with the code it tests is worse
  than no test**, because the failure points at the code rather than at itself. It now calls
  `releaseNotesRefusal` and asserts only its own business: that the documenting section is not blank.

### Added

- **A release is staged, and a maintainer approves it** (issue #65). `release.yml` used to run a
  direct publish, so the artifact went from the runner to the registry with nothing in between —
  provenance proves *where* a version came from, never that a **person agreed to it**. Anything able
  to influence the workflow could ship a version every user installs.

  The important half is **not** the command. A trusted publisher can be limited to **stage-only**, in
  which case the registry **rejects a direct publish** from that workflow. A workflow that merely
  chose to stage would be decoration, because a compromised one would publish directly instead — so
  staging is enforced at the registry and the workflow cooperates with it. The same setting group has
  *Allow npm dist-tag* **off**, so CI cannot move `latest` on its own and the approver confirms the
  tag. Approval needs **2FA** and is possible only after npm's malware scan completes.

  That change forced a second one: the workflow used to create the GitHub Release *before* anything
  could object, and a staged version is not installable. A live Release would have announced a version
  nobody could install, and a rejected stage would have left it behind. It now creates a **draft**
  carrying the notes, which is published after approval — or deleted, if the stage is rejected.

  The run also says what to do next, because it ends in a state only a human can finish: the approval
  command, that 2FA is required, and that scanning can block it. An operator should not have to read
  the workflow to complete a release.

  A test asserts the **absence** of a direct publish. That is the one check here that is deliberately
  about our own restraint cooperating with a registry rule rather than about behaviour — and it is an
  absence check because `npm stage publish` does not contain the substring it forbids, which is
  asserted so the guard cannot pass by accidental overlap.

  Two things about the setting are documented precisely, because getting them wrong would mean
  relying on a control that is not there. Stage-only binds the **trusted publisher**, so it constrains
  publishes that authenticate as this workflow; a maintainer's token is a different identity and needs
  traditional token access restricted as well. And `npm stage publish` requires **no 2FA** whatever the
  token type, so CI stays non-interactive and the second factor moves to approval — where the decision
  actually is. `docs/RELEASING.md` also now explains `0.0.0-stage`: it is npm's
  *"Temporary package placeholder for staged publishing"*, ~332 bytes and publicly available by
  design, so a maintainer seeing it does not tidy away a documented mechanism.

### Security, and the key denies missed every key that was not
  named `id_*`** (issue #46). Reported by the user asking a live session whether it could read
  `.ssh` — and it listed it. Two independent faults, and the second is the interesting one:

  - The fragment denied `~/.ssh` by three **name patterns** (`id_*`, `*_rsa`, `*_ed25519`). Against
    the real `~/.ssh` those matched seven keys and missed three genuine private keys — `cupserver`,
    `jenkins`, `sven1103-agent-strongbox` — along with `~/.ssh/config` itself, which was left
    readable *on purpose*.
  - That rationale was **false**. The fragment said denying the config "breaks git-over-SSH". It
    does not: the agent's `core.sshCommand` runs `ssh -F <agentRoot>/ssh/config`, and `-F`
    **replaces** the per-user config. Measured — a host defined only in `~/.ssh/config` resolves to
    the *agent's* key through the wrapper, not the user's.

  Where it mattered was narrower and worse than "keys are exposed". The base policy emits the
  workdir grant as `(allow file-read* file-write* (subpath <cwd>))` **before** the fragment, so for
  a session opened on `$HOME` that grant covers the entire home directory and the name list became
  the only control standing there — where it failed open. With a project workdir the same rules
  decided nothing, because `deny default` already covered what the base did not grant.

  `~/.ssh` is now denied **wholesale** — the directory, not a list of names — with the base policy's
  narrower literals restated at matching specificity (SBPL resolves by last-matching rule, and Safehouse's own
  profiles note a more specific filter can beat a broader one regardless of order). The `~/.ssh`
  file deny subsumes the old `~/.ssh/agent` rule; the **network** deny on the launchd `Listeners`
  sockets stays, because a file deny does not cover `connect()` on a unix socket.

  The capability is untouched, and that was measured rather than assumed: with `HOME` pointed at an
  **empty** directory the agent still authenticated to GitHub (`Hi sven1103-agent!`) and produced a
  commit whose signature git verifies as `Good "git" signature for sven1103-agent`. New
  `docs/AGENT-SETUP.md` is the reproducible recipe for provisioning that identity on a fresh
  install, previously undocumented. New constraint **C15c** and **ADR-0010 Amendment 3**.

  The test that would have caught this asserts a **coverage property** — "does any rule deny this
  path?", evaluated against the policy **Safehouse actually composes**, for both a project workdir
  and `$HOME` — instead of matching the text of a rule. The old version passed a test of the latter
  shape: it did emit a deny naming `~/.ssh/agent`.

- **The model picker truncated from the end, losing the identifying part of the name** (issue #42).
  The header showed `litellm/deepseek-` — the raw string clipped by CSS — while `format.ts` already
  contained the opposite rule, with its reasoning written down: *"Middle rather than trailing because
  both ends carry identity."* The rail honoured it; the picker did not. The closed control now shows
  `litellm/deep…4.1-Flash`.

  A native `<select>` renders the selected option's text when closed, so "short when closed, complete
  when open" is not expressible through option text alone — and both halves are required: the header
  is scanned and must stay identifying, while the list is where a model is *chosen*, and an elision
  there is an elision at the moment of decision. The shortened label is therefore a separate
  `aria-hidden` overlay with `pointer-events: none`; the full name stays on the select, in its
  `title`, and in every `<option>`.

- **The quarantine legend was lying about tool output** (issue #43). Every transcript header says
  *"Tool output and file contents appear in a hatched frame. They are data, not instructions."* — but
  the hatch was applied only to `thinking` blocks, so the one surface the legend is *about* rendered
  plain. DESIGN §5.2 is explicit that the frame "carries the security model": it is how a reader tells
  "the assistant said this" from "the agent read this somewhere", and tool output is the most
  attacker-influenced content in the product. Fixed with a purpose-built
  `.trace-detail.is-quarantined` rule rather than by stacking `.quarantine` — both set `background`
  and `.trace-detail` is declared later, so source order would have won and the frame would have been
  **invisible while every test passed**. A test now asserts the frame reaches the DOM *and* that no
  later rule can override it.

- **Clicking a session in the rail did nothing** (issue #40). With several sessions live, selecting
  one left the transcript column showing the previously focused session and no row marked. The rail
  dispatched a `session` **upsert** to switch sessions, and that event's focus rule — "never steal
  focus from one the user is reading" — is deliberate and correct (DESIGN §5), so with focus already
  set it kept the old id. The click refreshed the row's data and moved nothing. Focus is now a
  dedicated `focusSession` **local action**: a view change the browser owns, not a fact the
  orchestrator sends, and never routed through a data event.

- **Agent commits were never signed** (issue #27). ADR-0010 §4 requires it; the adopted agent
  `gitconfig` said `gpgsign = false` with no `signingkey` and no `gpg.format`, so commits were created
  unsigned while the signing key sat right beside them — and nothing reported it, because an unsigned
  commit is well-formed and exits 0. Signing is now audited on the **settings that act on the key**
  (`signing.ts`), not on the key's presence, and `verify-three.ts` asserts from inside a sandboxed
  session that a commit made there **verifies** (`Good "git" signature`) against the agent's own
  `allowed_signers`. `user.signingkey` pointing outside the agent root is reported as a leak of the
  user's identity rather than as a setup step. The fix is produced as explicit `git config` commands,
  not applied: the agent root is user-maintained, so Pi Central instructs rather than rewrites.

### Added

- **A Settings surface: which build is running, and where it keeps things** (issue #58). Three of
  these facts were previously printed **only** to the terminal at startup — sessions root, default
  workspace, agent root — so a user who closed that terminal could not answer *"where are my sessions
  on disk?"* from the app. The version was reported nowhere at all, so *"is this the build with the
  fix?"* was unanswerable from the running process, which is exactly the question releases make
  routine.

  It shows the **orchestrator's** version, read from the `package.json` it was shipped in and taken
  from the snapshot — never a constant in the UI bundle, which can be a stale build. It also shows
  the **wire protocol version** beside the one this UI speaks, because the failure that motivated
  Increment 6 arrived as `unknown kind 'listFiles'` from a connection that had agreed on `hello`;
  both numbers on screen make that class self-diagnosing. Where the orchestrator could not identify
  its own installation, the surface says so rather than staying silent — the same reasoning as issue
  #25, where "no warning appeared" is otherwise indistinguishable from "the warning is broken".

  **It deliberately contains no preference control.** The update-detection toggle belongs on this
  surface but does not appear until #55 makes it work: a control that looks functional and is not is
  worse than its absence. What is there instead is a sentence answering *"why can I not turn this
  on?"* — and a test asserts the absence of any `input`, `checkbox` or `switch`, so the gap cannot be
  closed silently by someone helpfully adding one.

  **A defect found by looking at a screenshot of this surface while every test was green.** The first
  version passed `install?.sessionsRoot ?? "not reported"` into the row and rendered a copy button
  beside it — so the button put the literal string `not reported` on the clipboard. A placeholder is
  not a value, so `Fact` now takes `string | undefined` and derives the placeholder itself, which
  makes the bug **unrepresentable** rather than merely fixed, and a test asserts no copy button exists
  without a value (with a companion test asserting present values *are* copyable, so deleting the
  feature could not pass). The absence is also explained **once** instead of in all six rows, and the
  message distinguishes "the orchestrator has not answered yet" from "this orchestrator is older than
  this UI" — only the second is actionable, and conflating them is how the version skew in issue #8
  stayed confusing.

  Every fact is allowed to be **absent**, and renders as "not reported" rather than a blank or a
  zero — the case an orchestrator older than the field produces, which is why the protocol could add
  it as an optional snapshot field without a version bump (a receiver that does not know it ignores
  it). A snapshot that omits the facts **clears** them rather than merging, because a snapshot is
  authoritative: retaining a previous orchestrator's version would be a stale answer to the one
  question this surface exists to answer.

- **Pi Central is now a package, not only a checkout** (issue #52, ADR-0011). `npm run build:package`
  produces the artifact and `npm pack` shows exactly what ships:

  ```
  bin/pi-central.js   one bundled ESM file — orchestrator + protocol
  dist/ui/            the built UI
  package.json  README.md  LICENSE
  ```

  **No TypeScript is shipped, because none can be.** Importing a `.ts` file from `node_modules`
  fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — Node will not strip types there, and
  npm installs globals there — so a `.ts` entry point is unrunnable however the package is installed.
  Verified with a minimal package before choosing the design.

  The orchestrator is therefore **bundled**, not compiled file-by-file: the sources use 39 explicit
  `.ts` import specifiers (required by `allowImportingTsExtensions`, which itself requires `noEmit`),
  so a `tsc` emit would mean rewriting every one of them or adding a second resolution scheme for the
  published build alone. `esbuild --bundle` follows them as written and emits one file, and the
  inlined sourcemap means a stack trace from a supervised session still points at real TypeScript.

  Three things that were only findable by installing the tarball and running it:

  - **`ws` must not be bundled.** It is CommonJS and calls `require()` internally; bundled into ESM,
    esbuild's `__require` shim **throws at load time**, and because the module graph is eager that
    made even `--version` fail. The workspace build looked perfect. `ws` is now `external` and
    declared, so the package has exactly one runtime dependency.
  - **The UI path was wrong once bundled.** `resolveUiDistDir` derived `../../ui/dist` from the
    module's URL — right for a checkout, and for `bin/pi-central.js` a path *outside the installed
    package*, where it can match a directory belonging to the consumer. Both layouts are now anchored
    to the package root, found by **name** (`pi-central`) rather than by taking the nearest
    `package.json`, which from source is a different package whose version merely agrees today.
  - **Both UI directories can exist at once.** Run `build:package` in a checkout and `dist/ui` sits
    beside `packages/ui/dist`; a fixed preference would serve the stale one, and the symptom is a
    developer rebuilding and seeing no change. The layout the module was loaded from decides.

  `pi-central --version` reads the version from the **shipped** `package.json` and never restates it,
  and `--help` lists the flags that exist. Both answer before the sandbox probe and before any config
  is read, so they work in a sandbox, on a host with no Safehouse, and with no home directory — the
  questions someone asks when something is already wrong.

  Measured: tarball **1.63 MiB** packed / 9.07 MiB unpacked, 273 files, **no `.ts`**; bundle
  232 KiB with the inline sourcemap. Verified by installing the tarball with `--omit=dev` into an
  empty directory: `--version` prints `pi-central 0.1.0`, the app serves its UI from
  `node_modules/pi-central/dist/ui` (`GET /` 200, assets 200), a traversal returns **403**, and the
  **C1 guard still refuses** inside a sandbox — the check that must not be lost to a bundler.

- **A read-only file tree, confined to the session's working directory** (issue #8, ADR-0007). The
  inspector shows the focused session's directory and opens text files, so the answer to "what is
  this agent working on" is a tree rather than a shell command the user runs elsewhere.

  The confinement is the whole feature, and it lives in `orchestrator/src/files.ts` with **no UI
  dependency**: an absolute path, a `..` that escapes, and a symlink whose **target** escapes are all
  refused. Containment is checked by path **segments**, not by string prefix — the prefix form is the
  bug this repository already shipped once in `own-installation.ts`, where `…/read` matched
  `…/readme.md`. The check runs twice: once lexically, so a nonexistent escape is reported as an
  escape rather than as "missing", and again after `realpath`, which is what catches a symlink.

  Three behaviours are stated rather than implied, each because the alternative asserts something
  false:

  - **An oversized file is refused, not truncated**, with both sizes named (`4.2 MB, above the
    256.0 KB limit`). A truncated file rendered as whole is a silently wrong answer.
  - **Binary is detected two ways** — a NUL in the first 8 KB *and* a strict UTF-8 decode — because
    either alone misses a case: NUL alone passes a Latin-1 file that renders as replacement
    characters, and the decode alone rejects it only after the whole buffer is read.
  - **A permission failure reports its errno**, never "missing". The two need different responses,
    and collapsing them is the same defect as a failed transcript read shown as an empty one.

  The same distinction is carried through the whole path. The protocol gained `files`, `file` and
  `fileError`, and `fileError` states **which question failed** (`request: "list" | "read"`) because
  the UI keys a listing and a read by the same path — without it the client would have to guess, and
  a refusal of one could be filed against the other. A refused **listing** becomes an error
  directory, never `loaded: []`: "this directory is empty" and "this directory could not be read"
  are opposite facts. Routing goes through the **supervisor**, not straight to `files.ts`, because it
  is the only component that knows a session's `cwd` — so there is exactly one answer to what a
  session is confined to. An unknown session is refused as such rather than resolved against some
  other root.

  The file text is displayed **inert** (ADR-0006) and the pane is labelled "working directory",
  never "the agent's view": ADR-0007 requires that a browser reading at the user's UID not be
  presented as what the sandboxed agent can see, and the two coincide today only because the scope is
  the workdir.

  Twenty-nine orchestrator tests and seventeen UI tests, all with fixtures under `mkdtemp`. Four
  behaviours were **falsified** before landing: rooting the listing at `process.cwd()`, collapsing a
  refused listing into `loaded: []`, dropping the NUL from the session-key separator (so forgetting
  `s1` would also drop `s10`'s tree), and echoing the *normalized* path where the client had keyed its
  request by the path it sent.

- **Compaction and retry banners** (issue #5). A session that is compacting, retrying, or recovering
  from a provider failure now says so inline instead of appearing to stall. The two retry mechanisms
  are distinguished — `auto_retry` (the provider call failed) and `summarization_retry_*` (a
  summarizer failed while compacting) — because attributing one to the other sends the reader looking
  in the wrong place. An **aborted** compaction says it stopped rather than claiming it compacted, a
  retry states both the attempt and the bound, and nothing claims the turn is over. No notice is a
  live region (a retry updates per attempt, so announcing each would be hostile) or a state change:
  `agent_end` is still not `agent_settled` (C8), and a test asserts a failed retry does not move the
  session out of `streaming`.

- **A session pointed at Pi Central's own installation is warned about** (issue #25). Pointing a
  session at the checkout Pi Central is running from produces a dashboard that mysteriously stops
  working — the UI hot-reloads into a mid-edit error, a branch switch desynchronises the two halves,
  and a broken orchestrator cannot be restarted when it is needed. The warning names those three
  consequences rather than the condition, appears in the "Open in a directory" sheet **before** the
  session exists, and persists on the session row. It is **not** blocking: the user may have a good
  reason. The predicate lives in `@pi-central/protocol` so the sheet and the orchestrator cannot
  disagree, and it does **not** fire for a sibling clone — the setup `docs/DOGFOODING.md`
  recommends. The installation root is derived from the runner's module URL at runtime, never
  configured, because a configured path would be right for exactly one checkout.

- **Fenced code is syntax-highlighted, lazily** (issue #4). Shiki grammars load one at a time, on
  first encounter of a language: a transcript that shows no code fetches none of it, and one that
  shows TypeScript fetches ~11 kB rather than the ~8.2 MB that exists. The name→chunk index had to
  be made lazy as well — measured at 46 kB of URLs, it would otherwise have put most of the saving
  back. **The entry chunk grew by 5.04 kB (2.36 kB gzip)**, measured with `npm run ui:build` and
  recorded in [docs/BUNDLE.md](docs/BUNDLE.md).
  A grammar emits **tokens**, not markup, which the UI renders as React elements; colours become
  CSS **classes** rather than inline styles, so the sanitizer's allow-list did not have to admit
  `style`. That keeps ADR-0006's single `dangerouslySetInnerHTML` site exactly as it was, and the
  invariant test still finds one. An unknown language, an indented fence, and a fence that is still
  streaming all fall back to the code as escaped plain text — never to nothing.

- **`steer`, follow-up, and Esc that returns what it cleared** (issue #3). Both capabilities were
  documented as impossible; they were blocked by Pi Central's own vocabulary, not by Pi — RPC mode
  handles `steer`, `follow_up` and `clear_queue` (and `Command` already carried the first two), so
  only a `Control` variant was missing. The composer's mode strip appears **only** while a run is in
  progress, where the choice is real, and says which of the two will happen; the queued texts are
  listed read-only (there is no per-item removal to offer, so a `×` would be a fake control); and
  Esc clears the queue, stops the run and returns the cleared text to the box. The cleared text is
  merged **below** the draft and only once. The interim "Steer is not available in this build" hint
  is gone.

- **The model picker** (issue #1): the model shown in a session header can now be changed from the
  dashboard. The catalogue comes from `get_available_models`, grouped by provider, with the current
  model marked; choosing one sends `set_model` and the header then shows what **Pi reports back**
  rather than an optimistic guess. Pi validates the choice (an unconfigured provider fails with `No
  API key for <provider>/<model>`) and re-applies the thinking level for the new model, so both are
  re-read after a change. A refusal surfaces as an error naming the reason — never a silent no-op —
  and while a run is streaming the control says the change applies to the *next* turn. New `Control`
  variants (`setModel`, `listModels`, `setThinkingLevel`, `listThinkingLevels`) and matching events;
  the catalogue is request-shaped rather than part of `LiveSession`, because it is hundreds of
  entries that change only with the provider configuration.
- **The thinking-level picker** (issue #2), constrained by the current model: the levels come from
  `get_available_thinking_levels` for *that* model rather than a hardcoded list, and a model switch
  invalidates the list, so a level the new model does not support cannot be selected. The displayed
  level follows Pi — re-applied on a model switch, and updated by `thinking_level_changed` without a
  refresh. `ThinkingPicker.tsx`, tested.
- **The agent credential store is checked for usability at session start** (issue #28). A session
  whose agent identity cannot be used says so, naming which capability and — the part that matters —
  whether it is **not provisioned** (a setup step) or **provisioned but unreachable** (a defect in
  Pi Central). The defect that prompted this produced `failed to read configuration: operation not
  permitted` on a *host* path, which read as "the sandbox is blocking my config" when the agent's own
  config had never been pointed at. `capabilities.ts`, `capabilities.test.ts`; the same facts are
  probed from inside a live session in `verify-three.ts` (C15a).
- **The orchestrator serves the built UI** (`npm run ui:build && npm run server`), so the dashboard
  needs no dev server. One listener answers `/ws` with an upgrade and every other path with
  `packages/ui/dist`, with an SPA fallback. Two consequences beyond convenience: `connect-src
  'self'` in the CSP is same-origin *by construction* rather than by a correctly configured proxy,
  and a Vite file watcher no longer reloads the interface you are using out from under you while
  an agent edits it ([DOGFOODING.md](docs/DOGFOODING.md), issue #24).
- The Content-Security-Policy is now sent as an **HTTP header** as well as a `<meta>` tag. A header
  applies before the document is parsed; the meta tag does not. A test asserts the two are equal,
  so they cannot drift.

### Changed

- **The right pane stopped being "the inspector" and became a panel with modes and a resizable edge**
  (issue #8, reworked after a real window showed the first attempt was unusable). Two screenshots
  settled it. In the first, the document text was clipped **mid-word** — `Notable changes per release.
  Forr…` — with a horizontal scrollbar, because a fixed 320px column is not a readable measure for a
  document. In the second, the file viewer sat at the *bottom* of one long scroll region, below
  `Command` and `Usage`, so reaching a file meant scrolling past every session fact; the transcript
  column beside it was half empty. Three separate faults, all mine:

  - **The wrong region.** A file browser is not a session fact, and `Inspector` had grown to hold both
    — isolation, paths, command, usage, warnings, errors, actions, a tree and a document. The panel now
    has modes (`Session` | `Files`) and takes `children` for its body; it does not know what a session
    or a file is. `Inspector` goes back to session facts only, and a test asserts the file browser is
    not in it so it cannot creep back.
  - **A fixed width.** The panel is now draggable (280px floor, `min(1200, 60vw)` ceiling — a fraction,
    so it can never swallow the transcript), with `←`/`→` nudges, `Home`/`End` jumps, double-click
    reset, and persistence. It is a `role="separator"` with `aria-valuenow/min/max` and
    `aria-valuetext` in pixels.
  - **One scroll column.** The document is now a grid area that fills the remaining height and owns its
    own scrolling. The `max-height: 340px` I had put *inside* an already-scrolling panel — two
    scrollbars fighting over one wheel — is gone, and a test asserts the document does not cap itself.

  Two more consequences. The panel is **no longer hidden** below 1440px: that was defensible while it
  held only reference material, but it now hosts the file browser, and an unreachable pane is worse
  than a narrow one. (The fixed-overlay replacement was itself a bug — it covered the transcript with
  no way to dismiss it — so the panel simply stays a grid column and the resizer is how you make room;
  the `1024–1439` sheet in DESIGN.md is deferred, not silently dropped.) And in `Files` mode the
  layout follows the **panel's** width via a container query rather than the window's, because the
  panel is resizable: a 2560px window can hold a 300px panel, and a viewport query would answer the
  wrong question.

  Entering `Files` widens the panel once, to 720px, and **only** while the user has never dragged it —
  entering at 360px would reproduce the clipped document, but moving a panel the user has placed is
  worse than leaving it narrow.

  Six behaviours were **falsified** before landing: putting the tree back into the Inspector, restoring
  the nested `max-height`, dropping `container-type`, replacing the `@container` query with a viewport
  media query, hiding the panel at narrow widths, and inverting the drag sign. Two of those initially
  passed and were **my tests' fault, not the code's**: the `container-type` assertion matched the same
  phrase inside a CSS *comment*, so it is now asserted against the stylesheet with comments stripped;
  and inverting the clamp order is genuinely a no-op, so a comment claiming "the clamp order matters"
  was false and is corrected. A test a comment can satisfy is not testing the stylesheet.

### Fixed

- **The protocol version was not bumped when the wire changed, so the handshake reported a
  compatibility it did not have** (found by dogfooding issue #8). Adding `listFiles`, `readFile`,
  `files`, `file` and `fileError` left `PROTOCOL_VERSION` at `1`. Both halves announced v1, `hello`
  agreed, and the mismatch surfaced only on the first expanded directory:

  ```
  bad control: unknown kind 'listFiles'
  ```

  That message names an unknown kind — a symptom — for a version skew the version check exists to
  catch. It is the failure mode of a handshake nobody remembers to update: adding a kind breaks
  nothing where it is written, because the author's UI and orchestrator are the same commit, and
  breaks everything on the next machine that has one of each. Bumped to `2`.

  A version number alone would rot the same way, so `packages/protocol/test/wire-surface.test.ts`
  now pins the set of `Control` and `Event` kinds against it **in both directions**: a kind added
  without a bump fails, and a bump without a kind fails. The failure prints the recorded and actual
  kind lists. The union spans are bounded by the next top-level `export` rather than by line numbers,
  which matters concretely — `FileEntry` sits between `Event` and the version and declares
  `kind: "file"`, so a slice that ran long would read a directory entry as an event kind. Three
  falsifications: adding a kind without a bump, bumping the version without changing the surface,
  and renaming a union (which must fail rather than make the guard vacuous). Field-level changes on
  an existing kind are **not** covered, and the test says so rather than implying more.

### Security

- The static handler refuses any request target that resolves outside the served root: a `..`
  segment is denied with a **403** rather than silently normalized, `%2e%2e%2f` is decoded before
  the check, and containment is verified on the canonical path as a backstop. It serves exactly one
  directory and cannot become a static file server for the filesystem.
- Method restriction (`GET`/`HEAD` only) and `X-Content-Type-Options: nosniff` on every response.

## [0.1.0] — first iteration

The premise is proven and the first three layers work end to end. Verified by 342 automated tests,
a live three-session isolation run, and a replay of real session files.

### Added

- **Orchestrator** — session discovery by parsing Pi's session files directly, per-session Safehouse
  policy composition, process supervision, and a custom RPC supervisor with LF-only JSONL framing.
- **Agent credential identity** — agents act as themselves: an agent-owned keychain, git config,
  GitHub config and SSH key, while the host's own git config, GitHub config, ssh-agent and login
  keychain are denied. Provider credentials are treated as a *capability* rather than an identity,
  because Pi resolves them through `!command` indirections.
- **WebSocket transport** over loopback, with a guard that refuses to start inside a sandbox and
  says why.
- **UI** — a session rail ordered by attention, live transcript reconstruction, an approval dock
  that answers any session's dialogs, a bounded and traversable tool trace, and history searchable
  by content.
- **Untrusted-rendering pipeline** — `markdown-it({ html: false })` → DOMPurify → React, with
  exactly one audited insertion point, enforced by test.
- **Documentation as a first-class artifact** — constraints C1–C14, ten ADRs, protocol notes,
  user stories, and an increment plan. `npm run check:docs` verifies every reference resolves.

### Fixed

- Denying `~/.pi/agent/auth.json` made **every** sandboxed session exit `1`, because Pi opens it at
  startup and a policy denial is not the same as absence. The file holds `!command` indirections
  rather than secrets, so the denial protected nothing and broke everything.
- The keychain grant was derived from the agent tree rather than from the provider configuration,
  so a session could start, report idle, and be unable to reach a model.
- A resumed session rendered an **empty transcript**: Pi loads history into the model's context but
  never re-emits it as events.
- One tool call produced **two trace rows**, and the duplicates collided as React keys.
- A cached transcript was replayed on reconnect, **overwriting** a correct one with a stale copy,
  after which a once-only guard prevented recovery.
- Tool calls were appended after the conversation instead of interleaved, burying the agent's
  output under a thousand frames.
- Several values were displayed but not true: a page size shown as a session total, a process
  handle labelled as Pi's session id, idle sessions counted as running, and a permission error
  reported as a missing directory.

### Known limitations

- File navigation is still absent; `steer`, follow-up and Esc-clears-and-returns are now real.
- No syntax highlighting, no compaction or retry banners, no file navigation.
- macOS only. Safehouse has no Linux backend (C10).
- No screenshot of the running UI exists in the repository: the author's environment cannot launch
  a browser inside the sandbox (C1), so layout is verified by rendered markup, which is stronger
  for behaviour and weaker for looks (issue #7).
