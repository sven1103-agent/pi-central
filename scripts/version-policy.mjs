/**
 * The version policy, as pure functions (issue #53).
 *
 * ## Why the rules live here and not in the CLI
 *
 * `check-version.mjs` walks the repository and exits non-zero; neither is testable without spawning
 * a process against a fixture tree. Everything that DECIDES is therefore a pure function over text
 * passed in, and the CLI is a thin wrapper: read the files, call these, print the result. The tests
 * in `version-policy.test.mjs` exercise the decisions with in-memory fixtures, so a rule that
 * quietly stops ruling fails a test instead of silently passing CI.
 *
 * ## The four failures this policy names
 *
 *   1. **Manifests disagree.** The root `package.json` declares; the private workspace manifests
 *      must match. None of the workspaces is published, so their numbers mean nothing — agreement
 *      is the whole requirement. `package-lock.json` is checked separately because it records the
 *      versions too and `npm ci` fails when it disagrees, which surfaces on the next machine rather
 *      than the author's.
 *   2. **Prose states the CURRENT version.** A version literal in a Markdown file cannot be kept in
 *      step with a manifest by any tool. The only honest options are to derive it (`--version`
 *      reads the manifest) or to omit it. Older versions are a different matter: documents record
 *      what shipped when, and that record is history, not a claim about today. So the rule is
 *      narrow on purpose — it bans *the current version*, not *all version numbers*.
 *   3. **A README states any version at all.** READMEs are the first thing a stranger reads, so a
 *      stale number there is the most expensive kind. Third-party versions are included in the ban
 *      because they drift too: a README claiming "verified against Pi 1.4.0" is wrong the moment Pi
 *      ships, and the honest phrasing points at the document that tracks it.
 *
 * ## What is deliberately NOT banned
 *
 * Third-party version literals outside a README. `docs/CONSTRAINTS.md` records the verified Pi and
 * Safehouse versions; that is its job, and banning it would make the document useless. Only the
 * CURRENT version is banned in prose, so those records stay accurate as long as they are true.
 */

/**
 * A dotted version that is not part of a longer dotted run.
 *
 * The lookarounds exist for one concrete reason: a naive `\d+\.\d+\.\d+` matches the first three
 * parts of an IPv4 address, so every `127.0.0.1` in the docs was reported as a version claim.
 *
 * Two attempts at the lookahead were both wrong, in opposite directions, and the tests caught each:
 *
 *   - `(?!\d|\.)`, banning any trailing dot or digit, rejected "shipped 0.2.0." — a sentence ending,
 *     which is the commonest prose form of all.
 *   - `(?!\.\d)`, banning only a dot-digit, let `10.20.30.40` match as `10.20.3` by giving back the
 *     trailing digit. A trailing DIGIT has to be banned too, or the engine simply shortens the match.
 *
 * The lookBEHIND bans a preceding digit or dot, so the engine cannot start a match mid-address
 * (`27.0.0` inside `127.0.0.1`).
 *
 * A three-part address such as `10.20.30` is indistinguishable from a version without knowing what
 * the number means, so it is read as a version. That is a known and accepted limit; four-part
 * addresses, which is how IPs are written in this repository, are handled.
 *
 * `v` is optional and is not part of the capture, so `v1.2.3` and `1.2.3` compare as one version.
 */
export const VERSION_PATTERN = /(?<![\d.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?!\d|\.\d)/g;

/** Every version literal in a piece of text, in order, without the leading `v`. */
export function versionsIn(text) {
  return [...text.matchAll(VERSION_PATTERN)].map((match) => match[1]);
}

/**
 * Lines of a Markdown file that state the CURRENT version.
 *
 * `CHANGELOG.md` is exempt because that is where the current version belongs: its `## [x.y.z]`
 * heading IS the release. Every other Markdown file must stay silent.
 *
 * A "line" is reported with its 1-based number and its first 100 characters, because the failure
 * message has to name something a person can open and edit.
 *
 * @param {{path: string, text: string}} file
 * @param {string} currentVersion
 * @returns {{path: string, line: number, version: string, text: string}[]}
 */
export function currentVersionClaims(file, currentVersion) {
  if (isChangelog(file.path)) return [];
  const claims = [];
  for (const [index, line] of file.text.split("\n").entries()) {
    for (const version of versionsIn(line)) {
      if (version === currentVersion) {
        claims.push({ path: file.path, line: index + 1, version, text: line.trim().slice(0, 100) });
      }
    }
  }
  return claims;
}

/**
 * Lines of a README that state ANY version.
 *
 * Exempt: an HTML comment, because a commented-out example or a note to maintainers is not prose a
 * reader sees. Everything else is banned, third-party versions included.
 *
 * @param {{path: string, text: string}} file
 * @returns {{path: string, line: number, version: string, text: string}[]}
 */
export function readmeVersionClaims(file) {
  if (!isReadme(file.path)) return [];
  const claims = [];
  for (const [index, line] of file.text.split("\n").entries()) {
    if (/^\s*<!--/.test(line)) continue;
    for (const version of versionsIn(line)) {
      claims.push({ path: file.path, line: index + 1, version, text: line.trim().slice(0, 100) });
    }
  }
  return claims;
}

/** Is this path a changelog? Matched on the basename so a nested copy is still exempt. */
export function isChangelog(path) {
  return basename(path) === "CHANGELOG.md";
}

/** Is this path a README? Matched on the basename, so nested READMEs are held to the same rule. */
export function isReadme(path) {
  return basename(path) === "README.md";
}

function basename(path) {
  return path.split("/").pop() ?? path;
}

/**
 * The release a version belongs to: `0.2.0-rc.1` -> `0.2.0`. A final version is its own base.
 *
 * Used to decide what documents a pre-release. An RC is a candidate for a release, not a release of
 * its own, so it is documented by that release's notes — which is why the bootstrap does not have to
 * insert a throwaway `## [0.2.0-rc.1]` section into a CHANGELOG that will never mention it again.
 */
export function baseVersion(version) {
  const [base] = String(version).split("-");
  return base ?? String(version);
}

/**
 * Why a version may NOT be published by hand as the first release, or `undefined` if it may.
 *
 * ## The constraint this encodes
 *
 * A trusted publisher is configured **from an existing package's settings page** — `npm help trust`
 * lists "Package must exist: The package you're configuring must already exist on the npm registry"
 * as a prerequisite. So the tag-driven workflow, which publishes over OIDC, cannot perform the FIRST
 * publish: there is no package on which to configure the trust. The first publish has to be manual,
 * and it is the only one that ever will be.
 *
 * ## The two irreversible mistakes
 *
 *   1. **A final version.** npm never allows republishing a version. A hand-published `0.2.0` can
 *      therefore never be published again, so it can never carry a provenance attestation — the
 *      first release would be permanently the one artifact nobody can verify. A pre-release is the
 *      throwaway that claims the name at no cost.
 *   2. **The `latest` tag.** An un-attested artifact must not become what `npm install pi-central`
 *      resolves to.
 *
 * Mistake 1 is checked here. Mistake 2 is structural: the caller passes `--tag next`, so there is no
 * branch in which `latest` could be set. That is the right way round — a rule that cannot be
 * expressed is better than one that must be remembered.
 *
 * `--provenance` is not checked because it is impossible off CI: the attestation is built from the
 * CI provider's OIDC identity, so no local invocation can produce one however it is spelled.
 *
 * @param {string} version
 * @returns {string | undefined} the refusal, or `undefined` when the version may be bootstrapped
 */
export function bootstrapRefusal(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "there is no version to publish";
  }
  // A pre-release is `x.y.z-<something>`. Build metadata alone (`x.y.z+build`) is NOT enough: npm
  // orders it as the release itself, so it would occupy the final version number and the mistake
  // this function exists to prevent would go through.
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)) {
    return (
      `${version} is not a pre-release. The first publish must be a pre-release such as ` +
      `\`0.2.0-rc.1\`, because npm never allows republishing a version — a final version published ` +
      `by hand could never be published again, so it would never carry a provenance attestation. ` +
      `Bump with: npm version <x.y.z>-rc.1 --no-git-tag-version --workspaces --include-workspace-root`
    );
  }
  return undefined;
}

/**
 * Whether an un-attested bootstrap version has become what `npm install` resolves to.
 *
 * Returns a complaint, or `undefined` when `latest` is not the bootstrap version.
 *
 * ## Why this is a check and not a guarantee
 *
 * `bootstrap-publish.mjs` publishes with `--tag next`, and the script, `CHANGELOG.md` AND
 * `docs/RELEASING.md` all called that a *structural* guarantee that the throwaway could never become
 * `latest`. It is not. The failure shape is #46's: a stated guarantee is what stops anyone looking,
 * so a false one is worse than none.
 *
 * **Measured 2026-10-27** by pointing `npm publish --tag next` at a local HTTP stub and reading the
 * request body the client produced:
 *
 * ```
 * "dist-tags":{"next":"0.0.1"}
 * ```
 *
 * That is the whole of it — no `latest`. A second probe, where the stub reported an existing
 * `latest`, produced `"dist-tags":{"next":"0.0.2"}`: the client does not send `latest` even when
 * one exists to preserve. So the client never asks for `latest`, which means any `latest` that
 * appears was created by the **registry**, and no flag in the script can prevent it.
 *
 * Which registry rule fires on a first publish is *not* determinable from this machine, and is
 * deliberately not guessed at here. What is measurable settled the part that decides the design:
 * we cannot fix this client-side, so we check it and warn.
 *
 * @param {Record<string, string>} distTags - as `npm view pi-central dist-tags --json` returns them
 * @param {string} bootstrapVersion
 * @returns {string | undefined}
 */
export function latestPointerProblem(distTags, bootstrapVersion) {
  if (distTags === null || typeof distTags !== "object") return undefined;
  if (distTags.latest !== bootstrapVersion) return undefined;
  return [
    `the registry has set \`latest\` to ${bootstrapVersion}, the throwaway pre-release.`,
    `It carries NO provenance attestation, so a plain \`npm install pi-central\` receives an`,
    `artifact nobody can verify. The publish request never asked for this — see the note above — so`,
    `it cannot be prevented, only corrected and said out loud:`,
    ``,
    `  npm deprecate pi-central@${bootstrapVersion} "Throwaway pre-release without a provenance attestation; use the next stable release."`,
    ``,
    `Then confirm it moved:  npm view pi-central dist-tags`,
  ].join("\n");
}

/**
 * The releases a CHANGELOG records, newest first, with the body of each section.
 *
 * Only `## [x.y.z]` headings count. `## [Unreleased]` is not a release — treating it as one would
 * make "the newest release matches package.json" pass during development, which is exactly when it
 * must not.
 *
 * @param {string} text
 * @returns {{version: string, body: string}[]}
 */
export function changelogReleases(text) {
  const releases = [];
  // `\Z` is not a JavaScript escape — it matches a literal "Z", so the LAST section in the file
  // would never match and a two-release changelog would silently look like a one-release changelog.
  // `(?![\s\S])` is the real end-of-string assertion. Found by a test expecting two releases and
  // getting one.
  const pattern = /^##\s*\[(\d+\.\d+\.\d+[^\]]*)\]([^\n]*)\n([\s\S]*?)(?=^##\s*\[|(?![\s\S]))/gm;
  for (const match of text.matchAll(pattern)) {
    releases.push({ version: match[1].trim(), body: match[3] ?? "" });
  }
  return releases;
}

/**
 * Whether the newest CHANGELOG release documents this version, as a refusal or `undefined`.
 *
 * A pre-release is accepted when its BASE release is the newest section: `0.2.0-rc.1` is a candidate
 * for `0.2.0`, and `## [0.2.0]` is where its notes live. Requiring a throwaway `## [0.2.0-rc.1]`
 * heading instead would mean hand-editing the changelog to publish something the changelog will
 * never mention again — friction that gets a documented process abandoned, and it would also leave
 * the release workflow's notes step failing AFTER a publish had already happened.
 *
 * @param {string[]} releaseVersions newest first
 * @param {string} declared
 * @returns {string | undefined}
 */
export function releaseNotesRefusal(releaseVersions, declared) {
  if (releaseVersions.length === 0) {
    return "CHANGELOG.md has no `## [x.y.z]` section, so the release has no notes";
  }
  const newest = releaseVersions[0];
  if (newest === declared) return undefined;
  const base = baseVersion(declared);
  if (base !== declared && newest === base) return undefined;
  return `package.json is ${declared} but the newest CHANGELOG release is ${newest}`;
}

/**
 * The body of `## [Unreleased]`, or `undefined` when the section is absent.
 *
 * Absent is reported as absent rather than as empty: a CHANGELOG with no Unreleased section has
 * nowhere to record the next change, which is a different defect from an empty section and needs a
 * different fix.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function unreleasedBody(text) {
  // Same end-of-string fix as `changelogReleases`: `\Z` would leave an Unreleased section at the
  // very end of the file unmatched, which is the normal case while developing.
  const match = /^##\s*\[Unreleased\][^\n]*\n([\s\S]*?)(?=^##\s*\[|(?![\s\S]))/m.exec(text);
  return match ? match[1] : undefined;
}

/**
 * The lines of an Unreleased section that would ship without notes.
 *
 * Headings and HTML comments are structure, not entries — an empty section usually still holds its
 * `### Added` scaffolding. Everything else counts, including prose paragraphs, because a paragraph
 * describing an unreleased change is exactly the "silently ships undocumented" case.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function unreleasedEntries(body) {
  return body
    .split("\n")
    .filter((line) => !/^\s*$/.test(line) && !/^#{1,6}\s/.test(line) && !/^\s*<!--/.test(line))
    .map((line) => line.trim());
}

/**
 * Version claims inside `package-lock.json`.
 *
 * The lockfile is not a manifest — it is npm's resolved tree — but it records the root version and a
 * version for every workspace, so it is another place the number is asserted. It is checked because
 * a lockfile that disagrees with its manifest is not a cosmetic problem: `npm ci` compares the two
 * and fails when they differ, which turns a forgotten lockfile into a red build on the next machine
 * (and only there, because the author's `node_modules` is already installed).
 *
 * The top-level `version` and `packages[""].version` are the same field duplicated by npm, so only
 * one of them is reported — two complaints for one mistake reads as two mistakes.
 *
 * A malformed lockfile is skipped for the same reason a malformed manifest is: npm's own parse error
 * is better than anything this could say.
 *
 * @param {string} lockText
 * @param {string} declared
 * @returns {string[]}
 */
export function lockfileDisagreements(lockText, declared) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return [];
  }
  const out = [];
  if (typeof lock.version === "string" && lock.version !== declared) {
    out.push(
      `package-lock.json declares ${JSON.stringify(lock.version)} at the top level, expected ${declared}`,
    );
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // `packages` maps EVERY installed package, dependencies included, so it is full of versions
    // that are not ours. Ours are the root (`""`) and the workspaces — every other key is a path
    // under `node_modules`, which is exactly what this skips. Trusting the key's shape rather than
    // comparing against a list of our names is what keeps this from flagging `ws` and `react`.
    if (path === "" || path.startsWith("node_modules/")) continue;
    if (!entry || typeof entry.version !== "string") continue;
    if (entry.version !== declared) {
      out.push(
        `package-lock.json declares ${JSON.stringify(entry.version)} for ${path}, expected ${declared}`,
      );
    }
  }
  return out;
}

/**
 * Every manifest whose `version` disagrees with the declaration.
 *
 * A manifest that fails to parse is skipped, not failed: npm reports a malformed `package.json`
 * with a better message than this script could, and failing here would mask that error behind a
 * confusing one.
 *
 * @param {{path: string, text: string}[]} manifests
 * @param {string} declared
 * @returns {string[]} human-readable disagreements
 */
export function manifestDisagreements(manifests, declared) {
  const out = [];
  for (const manifest of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(manifest.text);
    } catch {
      continue;
    }
    if (parsed.version !== declared) {
      out.push(`${manifest.path} declares ${JSON.stringify(parsed.version)}, expected ${declared}`);
    }
  }
  return out;
}
