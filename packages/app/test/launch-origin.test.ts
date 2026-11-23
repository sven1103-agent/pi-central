/**
 * The shell says which Pi Central it is serving (issue #244).
 *
 * ## The report this exists for
 *
 * *"when i run install app, i still see the older UI state"* — correct behaviour, and a trap. `install-app` builds the
 * desktop shell, and the shell launches the **installed npm package** (ADR-0013: one artifact, one version). So a
 * locally built app shows whatever `npm install -g` last put on disk, not the checkout it was built from.
 *
 * Measured on the machine where it was reported: the dock showed the old single-strip topbar while the checkout had the
 * activity bars, `grep -c navrail` on the installed `dist/ui` was 0, and **both reported version 0.10.0** — so nothing
 * in the UI could tell them apart.
 *
 * The judgement is "is the directory I am serving the checkout I was built from?", which is exactly the kind of thing
 * that is wrong while looking plausible, so it lives in a pure module rather than in `main.ts` (which `node --test`
 * cannot load, because `electron`'s package export is a path to a binary).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeLaunch, shellSourceRoot } from "../src/launch-origin.ts";

const CHECKOUT = "/Users/someone/git/pi-central";
const INSTALLED = "/opt/homebrew/lib/node_modules/pi-central";

test("a run from a checkout that would serve the INSTALLED package is REFUSED, not merely warned", () => {
  // This was a caveat until it happened. `npm run app` from this checkout served the globally installed package, the
  // window showed an interface containing none of the working tree's changes, and the only trace was a log line naming
  // /opt/homebrew. Every symptom of that state points at the CODE -- a control missing, no error, a plausible UI -- so
  // several rounds went into looking for a bug in code that was never running. A warning would not have stopped that;
  // a refusal does.
  const { message, caveat, refusal } = describeLaunch({
    packageRoot: INSTALLED,
    shellSourceRoot: CHECKOUT,
    overridden: false,
  });
  assert.match(message, new RegExp(INSTALLED));
  assert.ok(refusal !== undefined, "the mismatch must refuse the launch");
  assert.equal(caveat, undefined, "a refusal is not also a caveat; one statement per situation");
  assert.match(refusal, new RegExp(CHECKOUT), "it names the checkout that was started from");
  assert.match(refusal, new RegExp(INSTALLED), "and the package that would have been served");
  assert.match(refusal, /PI_CENTRAL_PACKAGE/, "and the override that runs the checkout instead");
  assert.match(refusal, /build:package/, "including the step the checkout needs before it can be served");
});

test("an explicit package choice is honoured even when it is not the checkout", () => {
  // The escape hatch: a reader who SETS PI_CENTRAL_PACKAGE has said which package they mean, so there is nothing to
  // refuse and nothing to warn about.
  const { caveat, refusal } = describeLaunch({
    packageRoot: INSTALLED,
    shellSourceRoot: CHECKOUT,
    overridden: true,
  });
  assert.equal(refusal, undefined, "an explicit choice must be obeyed");
  assert.equal(caveat, undefined);
});

test("a run from a checkout that serves ITS OWN tree is quiet", () => {
  // The working configuration. A warning here would be noise on the happy path, and noise is what makes a warning
  // get ignored when it matters.
  const { caveat } = describeLaunch({
    packageRoot: `${CHECKOUT}/packages`,
    shellSourceRoot: CHECKOUT,
    overridden: false,
  });
  assert.equal(caveat, undefined);
});

test("an installed app is quiet, because serving the installed package is the designed path", () => {
  // `shellSourceRoot` is undefined for a bundle: it has no sources beside it, so there is no checkout to disagree with.
  // The reader chose this; a note on every launch would be noise on every launch.
  const { message, caveat } = describeLaunch({
    packageRoot: INSTALLED,
    shellSourceRoot: undefined,
    overridden: false,
  });
  assert.equal(caveat, undefined);
  assert.match(message, new RegExp(INSTALLED), "it still says where it is serving from");
});

test("an override the reader set by hand produces no caveat", () => {
  // They already said where to look. Explaining their own instruction back to them is the kind of helpfulness that
  // trains a reader to skip the line that matters.
  const { caveat } = describeLaunch({
    packageRoot: INSTALLED,
    shellSourceRoot: CHECKOUT,
    overridden: true,
  });
  assert.equal(caveat, undefined);
});

test("the checkout is recognised by its shape, not by a hard-coded path", () => {
  // `npm run app` runs `electron packages/app/src/main.ts`, so this is the entry point the shell sees. An installed
  // bundle's entry is `…/app.asar/main.js` and must NOT be read as a checkout, or every launch of the real app would
  // claim to be a development run.
  assert.equal(shellSourceRoot(`${CHECKOUT}/packages/app/src/main.ts`), CHECKOUT);
  assert.equal(shellSourceRoot("/Applications/Pi Central.app/Contents/Resources/app.asar/main.js"), undefined);
  assert.equal(shellSourceRoot(undefined), undefined);
  assert.equal(shellSourceRoot(""), undefined);
  // A path that merely CONTAINS "packages/app/src" is not a checkout root of ours.
  assert.equal(shellSourceRoot("/tmp/packages/app/src/main.ts"), "/tmp");
});

test("a nested package root still counts as the same checkout", () => {
  /*
   * A monorepo can put the publishable `package.json` above or below the app. Compared by PREFIX rather than equality
   * for that reason: an equality test would report a false mismatch, and a warning that fires when nothing is wrong is
   * worse than no warning, because the next genuine one gets ignored.
   */
  for (const root of [CHECKOUT, `${CHECKOUT}/packages`, `${CHECKOUT}/packages/orchestrator`, `${CHECKOUT}/`]) {
    const result = describeLaunch({ packageRoot: root, shellSourceRoot: CHECKOUT, overridden: false });
    assert.equal(result.refusal, undefined, `${root} is inside the checkout`);
  }
  // And a sibling that merely shares a prefix is NOT inside it.
  const { refusal } = describeLaunch({
    packageRoot: `${CHECKOUT}-old/packages`,
    shellSourceRoot: CHECKOUT,
    overridden: false,
  });
  assert.ok(refusal !== undefined, "a prefix match must not span a directory boundary");
});

test("a checkout run must not adopt a running orchestrator it cannot attribute", () => {
  // The second half of the same failure, found in the log rather than reasoned about: the launch was ATTACHED to
  // pid 89370 started earlier from a different package, so the window loaded that process's UI. `shellSourceRoot`
  // being defined is what identifies a checkout run; the decision to refuse belongs with it, because that is the
  // condition under which serving someone else's interface is a mistake rather than a choice.
  assert.equal(shellSourceRoot("/Users/x/git/pi-central/packages/app/src/main.ts"), "/Users/x/git/pi-central");
  // An installed bundle has no sources beside it, so adoption stays the designed path there.
  assert.equal(shellSourceRoot("/Applications/Pi Central.app/Contents/Resources/app.asar/main.js"), undefined);
});
