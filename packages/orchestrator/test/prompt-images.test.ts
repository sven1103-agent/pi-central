/**
 * Accepting an image on a prompt, and refusing one with a reason.
 *
 * ## What these are protecting
 *
 * The only place untrusted bytes enter a control message. Not a decode — this codebase never decodes an image — but a
 * set of claims the orchestrator must not take from the client: the media type, the size, and the shape of the payload.
 *
 * Every case below is a way a browser (or something that is not a browser) can be wrong, and each refusal is asserted
 * with its SENTENCE rather than its code, because the sentence is what the reader sees and "image refused" with no
 * reason is the kind of message this project treats as a defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROMPT_IMAGE_BYTES,
  PROMPT_IMAGE_TYPES,
  acceptImage,
  acceptImages,
  base64Bytes,
  isBase64,
  refuseImage,
} from "../src/prompt-images.ts";

/** Base64 of `size` decoded bytes, without allocating them: the alphabet repeated, sized to a multiple of 4. */
function payloadOf(size: number): string {
  const chars = Math.ceil(size / 3) * 4;
  return "A".repeat(chars);
}

test("a well-formed PNG is accepted, with the type it was checked against", () => {
  const result = acceptImage({ mediaType: "image/png", data: "iVBORw0KGgo=" });
  assert.equal(result.ok, true);
  assert.equal(result.image.mediaType, "image/png");
  assert.equal(result.image.data, "iVBORw0KGgo=", "the payload is forwarded unchanged");
});

test("the four drawable types are the four accepted ones", () => {
  // The same set the transcript renders. An accepted-but-undrawable type would send something the sender cannot see,
  // which reads as a bug in the feature rather than a decision about formats.
  assert.deepEqual(PROMPT_IMAGE_TYPES, ["image/png", "image/jpeg", "image/gif", "image/webp"]);
  for (const mediaType of PROMPT_IMAGE_TYPES) {
    assert.equal(acceptImage({ mediaType, data: "AAAA" }).ok, true, mediaType);
  }
});

test("an unsupported type is refused, and the type is NAMED in the sentence", () => {
  const result = acceptImage({ mediaType: "image/tiff", data: "AAAA" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-type");
  const message = refuseImage(result.reason, { type: "image/tiff" });
  assert.match(message, /image\/tiff/, "the reader is told which type was refused");
  assert.match(message, /PNG, JPEG, GIF and WebP/, "…and what would have worked");
});

test("SVG is refused, deliberately", () => {
  // The one image format that can carry script. `<img>` makes it inert, but accepting it here would be a second, weaker
  // decision about the same bytes than the file viewer's — and a provider request is not a place to relax one.
  const result = acceptImage({ mediaType: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-type");
});

test("type comparison is case-insensitive, and the CANONICAL form is forwarded", () => {
  /*
   * `image/PNG` and `image/png` are one format, and a provider may be strict about spelling. Comparing
   * case-insensitively and forwarding the list's spelling means a client's capitalisation cannot decide whether an
   * image works — while the value that reaches Pi is still one of the four, never the client's string.
   */
  const result = acceptImage({ mediaType: "IMAGE/PNG", data: "AAAA" });
  assert.equal(result.ok, true);
  assert.equal(result.image.mediaType, "image/png", "lowercased, not echoed");
});

test("a payload that is not base64 is refused rather than silently discarded", () => {
  /*
   * `Buffer.from(x, "base64")` is famously forgiving: it ignores anything it does not understand, so validating with it
   * would accept `"!!!!"` and forward an EMPTY image — the model would then describe nothing, and the reader would have
   * no way to know the paste was the problem.
   */
  for (const bad of ["!!!!", "AAAA====", "AA AA", "AAA", "AAAA\nAAAA", "data:image/png;base64,AAAA"]) {
    const result = acceptImage({ mediaType: "image/png", data: bad });
    assert.equal(result.ok, false, `should refuse ${JSON.stringify(bad)}`);
    assert.equal(result.reason, "not-base64");
  }
});

test("isBase64 requires padding-correct, multiple-of-four base64", () => {
  assert.equal(isBase64("AAAA"), true);
  assert.equal(isBase64("AAA="), true);
  assert.equal(isBase64("AA=="), true);
  assert.equal(isBase64("AAA"), false, "a length that is not a multiple of four is not base64");
  assert.equal(isBase64(""), false);
  assert.equal(isBase64("A==="), false, "three padding characters cannot occur");
});

test("a data URI prefix is refused, because the field is DATA", () => {
  // The browser has a `data:` URI in hand after `FileReader.readAsDataURL`, so this is the likely mistake rather than an
  // exotic one. Accepting it would forward `data:image/png;base64,` as payload on every image.
  const result = acceptImage({ mediaType: "image/png", data: "data:image/png;base64,AAAA" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-base64");
});

test("an image above the cap is refused, and the sentence quotes both sizes", () => {
  const oversized = payloadOf(MAX_PROMPT_IMAGE_BYTES + 1);
  const result = acceptImage({ mediaType: "image/png", data: oversized });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-large");
  const message = refuseImage(result.reason, { bytes: base64Bytes(oversized) });
  assert.match(message, /MB/, "a size a reader can judge");
  assert.match(message, /downscale it and paste again/, "and what to do about it");
});

test("the cap is on DECODED bytes, not on the base64 length", () => {
  /*
   * The off-by-a-third that would make the limit advisory. Base64 is 4 characters per 3 bytes, so a cap compared against
   * `data.length` accepts an image 33% larger than the number it announces.
   */
  const atLimit = payloadOf(MAX_PROMPT_IMAGE_BYTES);
  assert.ok(atLimit.length > MAX_PROMPT_IMAGE_BYTES, "the encoded string is longer than the cap");
  assert.equal(base64Bytes(atLimit), MAX_PROMPT_IMAGE_BYTES, "and decodes to exactly it");
  assert.equal(acceptImage({ mediaType: "image/png", data: atLimit }).ok, true, "exactly at the cap is allowed");
  assert.equal(acceptImage({ mediaType: "image/png", data: payloadOf(MAX_PROMPT_IMAGE_BYTES + 3) }).ok, false);
});

test("base64Bytes reports the decoded size, exactly", () => {
  assert.equal(base64Bytes(""), 0);
  assert.equal(base64Bytes("AAAA"), 3);
  assert.equal(base64Bytes("AAA="), 2);
  assert.equal(base64Bytes("AA=="), 1);
  // A real screenshot from this machine's store.
  assert.equal(base64Bytes("A".repeat(97_500)), 73_125);
});

test("a malformed entry is refused by name rather than throwing", () => {
  // The value crossed a socket as JSON, so its type is a claim. Each shape below is something a client can send.
  const reasonOf = (raw: unknown) => {
    const result = acceptImage(raw);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
    return result.ok === false ? result.reason : undefined;
  };
  assert.equal(reasonOf(null), "not-an-object");
  assert.equal(reasonOf("image/png"), "not-an-object");
  assert.equal(reasonOf({ data: "AAAA" }), "missing-type");
  assert.equal(reasonOf({ mediaType: "image/png" }), "missing-data");
  assert.equal(reasonOf({ mediaType: "", data: "AAAA" }), "missing-type");
  assert.equal(reasonOf({ mediaType: "image/png", data: "" }), "missing-data");
});

test("a prompt with no images is fine, and so is an absent field", () => {
  assert.deepEqual(acceptImages(undefined), { ok: true, images: [] });
  assert.deepEqual(acceptImages(null), { ok: true, images: [] });
  assert.deepEqual(acceptImages([]), { ok: true, images: [] });
});

test("images are ALL-OR-NOTHING, and the first failure is named", () => {
  /*
   * Accepting three of four would send a message the reader did not write, and they would have no way to know which one
   * went missing — the model simply would not mention it. A refusal is visible; a partial send is not.
   */
  const result = acceptImages([
    { mediaType: "image/png", data: "AAAA" },
    { mediaType: "image/tiff", data: "AAAA" },
    { mediaType: "image/png", data: "AAAA" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.message, /image\/tiff/, "the offending type is named, not just 'images refused'");
});

test("several good images are all accepted, in order", () => {
  const result = acceptImages([
    { mediaType: "image/png", data: "AAAA" },
    { mediaType: "image/jpeg", data: "BBBB" },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.images.map((image) => image.mediaType), ["image/png", "image/jpeg"]);
});

test("a non-list `images` field is refused rather than coerced", () => {
  // `acceptImages("AAAA")` would otherwise iterate a string's characters and accept each one as an image.
  assert.equal(acceptImages("AAAA").ok, false);
  assert.equal(acceptImages({ mediaType: "image/png" }).ok, false);
});

test("the TOTAL encoded payload is capped, because a per-image limit does not bound the whole", () => {
  /*
   * Found by measurement, not by reasoning. One image at the per-image cap encodes to 4.19 MB — inside the transport's
   * 8 MB frame. Four of them is 16.78 MB: `ws` closes the socket with 1009 and the client gets no reply at all, so the
   * reader sees the composer empty itself into a dead connection with no message.
   */
  const chars = Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4;
  const atCap = { mediaType: "image/png", data: "A".repeat(chars) };

  assert.equal(acceptImages([atCap]).ok, true, "one at the cap is inside the frame");
  const four = acceptImages([atCap, atCap, atCap, atCap]);
  assert.equal(four.ok, false, "four is 16.78 MB and must be refused");
  assert.match(four.ok === false ? four.message : "", /limit for one prompt/);
  assert.match(four.ok === false ? four.message : "", /MB/, "the size is stated, so the reader knows what to drop");
});

test("four ordinary screenshots are accepted, because the total is a budget and not a count", () => {
  // A 1568px screenshot is a few hundred KB, so the cap must not become a cap on nothing.
  const ordinary = Array.from({ length: 4 }, () => ({ mediaType: "image/png", data: "A".repeat(400_000) }));
  assert.equal(acceptImages(ordinary).ok, true);
});
