import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CdpPage } from "../src/sidecar-cdp-pipe.ts";

/**
 * The pipe transport, exercised against synthetic frames.
 *
 * This is the only way to test it without a browser, and the properties worth testing are exactly the ones
 * that bit: where `sessionId` goes, how frames are split, and that a command with no answer fails instead of
 * hanging. Each was a real defect, so each gets an assertion rather than a comment.
 */

/** A fake browser: collects what the client writes, answers what the test tells it to. */
function fakeBrowser() {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const written: string[] = [];
  toBrowser.on("data", (chunk) => written.push(String(chunk)));
  const child = { stdio: [null, null, null, toBrowser, fromBrowser] } as never;
  return {
    child,
    written,
    /** Send one raw frame TO the client. */
    reply: (frame: unknown) => fromBrowser.write(JSON.stringify(frame) + "\0"),
    frames: () => written.join("").split("\0").filter((f) => f !== "").map((f) => JSON.parse(f)),
  };
}

test("sessionId rides the envelope, never inside params", () => {
  // The defect: with `flatten: true`, a sessionId inside `params` addresses the BROWSER target, which has no
  // page methods — and the answer is "'Page.enable' wasn't found", which reads like a version mismatch.
  const browser = fakeBrowser();
  const opened = CdpPage.open({ child: browser.child, timeoutMs: 500 });

  // Answer the two bootstrap calls, then the two enable calls.
  setImmediate(() => browser.reply({ id: 1, result: { targetInfos: [{ type: "page", targetId: "T1" }] } }));
  setTimeout(() => browser.reply({ id: 2, result: { sessionId: "S1" } }), 5);
  setTimeout(() => browser.reply({ id: 3, result: {} }), 10);
  setTimeout(() => browser.reply({ id: 4, result: {} }), 15);

  return opened.then(async (page) => {
    const frames = browser.frames();
    const enable = frames.find((frame) => frame.method === "Page.enable");
    assert.ok(enable !== undefined, "Page.enable must have been sent");
    assert.equal(enable.sessionId, "S1", "the session id belongs in the envelope");
    assert.equal(enable.params.sessionId, undefined, "and MUST NOT be inside params");
    // The bootstrap calls carry no session: Target.* belongs to the browser target.
    assert.equal(frames[0].sessionId, undefined, "Target.getTargets is addressed to the browser");
    await page.close();
  });
});

test("frames are split on NUL, not on newline", () => {
  // A CDP payload can contain a newline inside a string (a page title, a verdict message). Splitting on LF
  // would corrupt it, which is why the separator is the protocol's own.
  const browser = fakeBrowser();
  const opened = CdpPage.open({ child: browser.child, timeoutMs: 500 });
  setImmediate(() => browser.reply({ id: 1, result: { targetInfos: [{ type: "page", targetId: "T1" }] } }));
  setTimeout(() => browser.reply({ id: 2, result: { sessionId: "S1" } }), 5);
  setTimeout(() => browser.reply({ id: 3, result: {} }), 10);
  setTimeout(() => browser.reply({ id: 4, result: {} }), 15);

  return opened.then(async (page) => {
    const shot = page.capture();
    setTimeout(() => {
      browser.reply({ id: 5, result: { data: "aGVsbG8=" } });
    }, 5);
    const result = await shot;
    // The stub data has no newline, so what this proves is that the client RESOLVED — i.e. the NUL split
    // found the frame rather than waiting for a newline that never comes.
    assert.equal(result.data, "aGVsbG8=");
    await page.close();
  });
});

test("a command with no answer fails the call, within the timeout the CALLER asked for", async () => {
  // The failure shape this repository has produced twice: a process that never writes anything and never
  // exits. A timeout turns that into a stated error with the method named in it.
  //
  // The elapsed-time assertion is the part that has teeth. The first version of this test only awaited the
  // rejection, so it passed in 20 SECONDS — the default timeout — because open() ignored the caller's value.
  // A test that reports 20 s for a 60 ms request is telling you something; assert it rather than noticing it.
  const browser = fakeBrowser();
  const started = Date.now();
  const opened = CdpPage.open({ child: browser.child, timeoutMs: 60 });
  setImmediate(() => browser.reply({ id: 1, result: { targetInfos: [{ type: "page", targetId: "T1" }] } }));
  setTimeout(() => browser.reply({ id: 2, result: { sessionId: "S1" } }), 5);
  // Deliberately silent for the enable calls.
  await assert.rejects(opened, /Page\.enable did not answer/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, "the caller's 60 ms timeout must apply; open() took " + elapsed + " ms");
});
