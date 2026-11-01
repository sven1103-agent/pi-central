/**
 * The rules for images attached to a prompt, and the duplication they must not drift into.
 *
 * ## What these are protecting
 *
 * The composer's half of the clipboard feature, which is where a reader can be told "no" in a way they can act on. The
 * orchestrator's half is `packages/orchestrator/test/prompt-images.test.ts`; this is the same rules applied EARLIER, so
 * the reader is refused before sending rather than after.
 *
 * ## The one thing that must be tested across packages
 *
 * The size cap and the type list exist in both places. That duplication is deliberate — the browser can pre-check, the
 * orchestrator must enforce — and it is only safe if a change to one that is not made to the other FAILS. So the last two
 * tests read both source files and compare the numbers. Text-scanning a constant is a blunt instrument; it is the right one
 * here, because the alternative is two values that agree by memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ENCODED_BYTES,
  addAttachment,
  attachmentBytes,
  canSend,
  imageSupport,
  refuseAttachment,
  removeAttachment,
  toPromptImages,
} from "../src/attachments.ts";

const candidate = (overrides = {}) => ({
  mediaType: "image/png",
  data: "AAAA",
  label: "pasted image",
  ...overrides,
});

test("an image is attached, with a decoded size and its label", () => {
  const result = addAttachment([], candidate({ data: "QUJDREVG" }), "a1");
  assert.equal(result.ok, true);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].id, "a1");
  assert.equal(result.attachments[0].bytes, 6, "decoded bytes, not the base64 length");
  assert.equal(result.attachments[0].label, "pasted image");
});

test("the type is lowercased, so a client's capitalisation cannot decide whether it works", () => {
  const result = addAttachment([], candidate({ mediaType: "IMAGE/PNG" }), "a1");
  assert.equal(result.ok, true);
  assert.equal(result.attachments[0].mediaType, "image/png");
});

test("an unsupported type is refused, and the sentence names it and the alternatives", () => {
  const result = addAttachment([], candidate({ mediaType: "image/tiff" }), "a1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-type");
  const message = refuseAttachment(result.reason, { type: "image/tiff" });
  assert.match(message, /image\/tiff/);
  assert.match(message, /PNG, JPEG, GIF and WebP/);
});

test("an image above the cap is refused with both sizes in the sentence", () => {
  // Sized from the constant rather than a literal, so this test follows the limit instead of pinning a stale number.
  const chars = Math.ceil((MAX_ATTACHMENT_BYTES + 3) / 3) * 4;
  const result = addAttachment([], candidate({ data: "A".repeat(chars) }), "a1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-large");
  assert.match(refuseAttachment(result.reason, { bytes: attachmentBytes("A".repeat(chars)) }), /MB/);
});

test("the cap is on DECODED bytes, not on the base64 length", () => {
  // The off-by-a-third that would make the limit advisory. Base64 is 4 chars per 3 bytes.
  const atLimit = "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4);
  assert.ok(atLimit.length > MAX_ATTACHMENT_BYTES, "the encoded string is longer than the cap");
  assert.equal(attachmentBytes(atLimit), MAX_ATTACHMENT_BYTES, "and decodes to exactly it");
  assert.equal(addAttachment([], candidate({ data: atLimit }), "a1").ok, true, "exactly at the cap is allowed");
  assert.equal(addAttachment([], candidate({ data: `${atLimit}AAAA` }), "a1").ok, false);
});

test("attachmentBytes agrees with the orchestrator's base64Bytes, digit for digit", () => {
  // Both exist because the two packages cannot share a module. Pinning the arithmetic means a padding fix in one shows up
  // as a failing test rather than as a size that disagrees between the chip and the refusal note.
  for (const data of ["", "AAAA", "AAA=", "AA==", "A".repeat(97_500)]) {
    const expected = data.length === 0 ? 0 : Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    assert.equal(attachmentBytes(data), expected, JSON.stringify(data.slice(0, 8)));
  }
});

test("the attachment cap is a COUNT, and the fifth is refused rather than evicting the first", () => {
  /*
   * Adding then trimming would silently drop the first image, and the reader would send a set they did not compose. A
   * refusal is visible; an eviction is not.
   */
  let list = [];
  for (let index = 0; index < MAX_ATTACHMENTS; index += 1) {
    const result = addAttachment(list, candidate(), `a${index}`);
    assert.equal(result.ok, true, `attachment ${index}`);
    list = result.attachments;
  }
  const fifth = addAttachment(list, candidate(), "a9");
  assert.equal(fifth.ok, false);
  assert.equal(fifth.reason, "too-many");
  assert.match(refuseAttachment("too-many"), new RegExp(`${MAX_ATTACHMENTS} images`), "the cap is stated as a number");
});

test("a refusal leaves the list UNCHANGED, never partially applied", () => {
  const existing = addAttachment([], candidate(), "a1");
  assert.ok(existing.ok);
  const before = existing.attachments;
  const refused = addAttachment(before, candidate({ mediaType: "image/tiff" }), "a2");
  assert.equal(refused.ok, false);
  assert.deepEqual(before.length, 1, "the caller's list is untouched");
});

test("removing is by id, and an unknown id is a no-op", () => {
  const built = addAttachment(addAttachment([], candidate(), "a1").attachments, candidate(), "a2");
  assert.ok(built.ok);
  assert.deepEqual(removeAttachment(built.attachments, "a1").map((a) => a.id), ["a2"]);
  // A double click must not throw or corrupt the list.
  assert.deepEqual(removeAttachment(built.attachments, "nope").map((a) => a.id), ["a1", "a2"]);
});

test("two pastes of the same screenshot are two attachments", () => {
  /*
   * Identity is a counter, not the content. Keying on content would collapse them into one React key, so the second would
   * be unremovable and the count would lie.
   */
  const one = addAttachment([], candidate(), "a1");
  assert.ok(one.ok);
  const two = addAttachment(one.attachments, candidate(), "a2");
  assert.ok(two.ok);
  assert.equal(two.attachments.length, 2);
  assert.notEqual(two.attachments[0].id, two.attachments[1].id);
});

test("a prompt can be sent with images and NO text, but not with neither", () => {
  // A screenshot with no question is a question. Requiring text would force the reader to type filler to send an image.
  assert.equal(canSend("", []), false, "nothing at all");
  assert.equal(canSend("   ", []), false, "whitespace is not a prompt");
  assert.equal(canSend("", [{ id: "a1" }]), true, "an image alone is a complete prompt");
  assert.equal(canSend("look at this", []), true, "text alone, unchanged");
});

test("imageSupport reads three states, and absent is NOT 'no'", () => {
  /*
   * The middle case is the one that matters. Pi may omit `input` for a model, and treating that as "text only" would
   * remove the feature silently for every model whose catalogue entry lacks the field. The failure mode of
   * "unknown → allowed" is one provider error; the failure mode of "unknown → hidden" is a feature that does not exist.
   */
  assert.equal(imageSupport(undefined), "unknown");
  assert.equal(imageSupport(["text"]), "no");
  assert.equal(imageSupport(["text", "image"]), "yes");
  assert.equal(imageSupport([]), "no", "an empty list is a stated 'no inputs'");
});

test("the wire payload carries only what the model needs", () => {
  // `id`, `bytes` and `label` are composer bookkeeping; sending them would put a client's state into a message.
  const wire = toPromptImages([
    { id: "a1", mediaType: "image/png", data: "AAAA", bytes: 3, label: "pasted image" },
  ]);
  assert.deepEqual(wire, [{ mediaType: "image/png", data: "AAAA" }]);
  assert.deepEqual(Object.keys(wire[0]).sort(), ["data", "mediaType"]);
});

test("the cap and the type list MATCH the orchestrator's, across packages", () => {
  /*
   * The duplication is real: the orchestrator does not ship to the browser, so the constant cannot be imported. What makes
   * it safe is this test reading BOTH files. A change to one that is not made to the other fails here, instead of surfacing
   * as a paste the composer accepts and the orchestrator refuses — the exact class of defect that a duplicated limit
   * always eventually produces.
   */
  const side = readFileSync(new URL("../../orchestrator/src/prompt-images.ts", import.meta.url), "utf8");

  const orchestratorCap = /MAX_PROMPT_IMAGE_BYTES = ([^;]+);/.exec(side)?.[1]?.trim();
  assert.ok(orchestratorCap !== undefined, "the orchestrator's cap is findable");
  // Evaluated rather than string-compared, so `3 * 1024 * 1024` and `3145728` agree.
  assert.equal(MAX_ATTACHMENT_BYTES, Function(`return ${orchestratorCap}`)(), `the two caps must be equal`);

  const types = [...side.matchAll(/"(image\/[a-z]+)"/g)].map((match) => match[1]);
  const orchestratorTypes = [...new Set(types)].filter((type) => !type.includes("svg"));
  assert.deepEqual(
    [...ATTACHMENT_TYPES].sort(),
    orchestratorTypes.sort(),
    "the two allow-lists must be the same four formats",
  );
});

// --- The downscale arithmetic, which is the part a browser would otherwise hide -------------------

test("fit only ever SHRINKS, and keeps the aspect ratio", async () => {
  /*
   * Upscaling a small image to the target edge would add bytes and no information, and a 40px icon sent as 1568px is the
   * kind of "helpful" resizing that makes a chip's stated size look wrong.
   */
  const { fit } = await import("../src/paste.ts");

  assert.deepEqual(fit(800, 600, 1568), { width: 800, height: 600 }, "already small: untouched");
  assert.deepEqual(fit(1568, 900, 1568), { width: 1568, height: 900 }, "exactly at the edge: untouched");

  const wide = fit(4000, 1000, 1568);
  assert.equal(Math.max(wide.width, wide.height), 1568, "the long edge lands on the target");
  assert.ok(Math.abs(wide.width / wide.height - 4) < 0.01, "and the ratio survives");

  const tall = fit(1000, 4000, 1568);
  assert.equal(Math.max(tall.width, tall.height), 1568);
  assert.ok(Math.abs(tall.height / tall.width - 4) < 0.01);

  // A ratio that does not divide evenly must not produce a zero edge — a 0-height canvas throws.
  const thin = fit(10_000, 3, 1568);
  assert.ok(thin.height >= 1, `no zero dimension, got ${thin.width}x${thin.height}`);
  assert.deepEqual(fit(0, 0, 1568), { width: 0, height: 0 }, "an unmeasured image reports nothing, rather than NaN");
});

test("TARGET_EDGE is Pi's own resize default, so nothing is lost that the model would have used", async () => {
  // Pi's documented profile caps at 1568. Downscaling to it is lossless IN EFFECT: the model would have seen 1568 either
  // way, and the difference is bytes, not information.
  const { TARGET_EDGE } = await import("../src/paste.ts");
  assert.equal(TARGET_EDGE, 1568);
});

test("four images at the per-image cap are REFUSED, because the total would close the socket", () => {
  /*
   * The defect this locks down, found by measuring rather than reasoning.
   *
   * A per-image cap of 3 MB decoded encodes to 4.19 MB of base64, comfortably inside the transport's 8 MB frame. FOUR of
   * them is 16.78 MB, so `ws` closes the socket with 1009 and the client gets no reply at all — the composer would empty
   * itself into a dead connection with no message. A limit on each part does not bound the whole.
   */
  const chars = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
  const atCap = { mediaType: "image/png", data: "A".repeat(chars), label: "big" };

  const one = addAttachment([], atCap, "a1");
  assert.equal(one.ok, true, "one at the cap is fine — it encodes to 4.19 MB");

  const two = addAttachment(one.attachments, atCap, "a2");
  assert.equal(two.ok, false, "two at the cap is 8.4 MB encoded, over the 6 MB budget");
  assert.equal(two.reason, "batch-too-large");
  assert.match(refuseAttachment(two.reason, { bytes: 8_400_000 }), /limit for one prompt/);
});

test("small images still fill all four slots, because the total is a budget not a count", () => {
  // A screenshot downscaled to 1568px is a few hundred KB, so four ordinary images must be allowed — otherwise the cap
  // would be a cap on nothing.
  let list = [];
  for (let index = 0; index < MAX_ATTACHMENTS; index += 1) {
    const result = addAttachment(list, { mediaType: "image/png", data: "A".repeat(400_000), label: `s${index}` }, `a${index}`);
    assert.equal(result.ok, true, `attachment ${index} (~300 KB decoded)`);
    list = result.attachments;
  }
  assert.equal(list.length, MAX_ATTACHMENTS);
});

test("the TOTAL budget matches the orchestrator's, across packages", () => {
  // Same argument as the per-image cap: the orchestrator is the authority and cannot be imported, so a test reads both.
  const side = readFileSync(new URL("../../orchestrator/src/prompt-images.ts", import.meta.url), "utf8");
  const value = /MAX_PROMPT_IMAGES_ENCODED_BYTES = ([^;]+);/.exec(side)?.[1]?.trim();
  assert.ok(value !== undefined, "the orchestrator's total budget is findable");
  assert.equal(MAX_TOTAL_ENCODED_BYTES, Function(`return ${value}`)(), "the two totals must be equal");
});

test("only a REFUSAL reaches the composer's notice strip, never a success", () => {
  /*
   * Corrected from use: "below the composer users see 'x images sent', which is not required, since they see it in the
   * transcript anyway."
   *
   * Right. The chips vanishing IS the confirmation — they were the thing that said "these are attached", so their
   * absence says "these are gone from the composer" — and the message then appears in the transcript with the images in
   * it, one line below. A notice restating that was a third confirmation for one fact, in the one strip that is permanent
   * screen space.
   *
   * A refusal still belongs there, and this assertion is about the RULE rather than about the wording: a refusal is the
   * only outcome the reader cannot see anywhere else. Nothing appeared in the composer, and nothing appeared in the
   * transcript, so the strip is the single place it can be said.
   */
  const side = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const strip = /if \(sent && images\.length > 0\) \{([\s\S]{0,600}?)\n                \}/.exec(side)?.[1] ?? "";
  assert.ok(strip.length > 0, "the clear-on-send block is findable");
  assert.match(strip, /setAttachments/, "it clears the attachments");
  assert.ok(!/setAttachNotice/.test(strip), "and says NOTHING — no 'n images sent'");

  // The refusal path still sets one, so the strip is not dead code.
  assert.match(side, /setAttachNotice\(/, "a refusal still notifies");
  assert.match(side, /refuseAttachment\(/, "…through the shared sentence");
});
