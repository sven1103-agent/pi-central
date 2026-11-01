/**
 * Images a reader's own message NAMES by path, so the transcript can preview what they meant.
 *
 * ## The problem this solves, measured rather than assumed
 *
 * Of the 5 912 user messages in this machine's session store, **181 name an image file by path** — `@img_6.png shows
 * the latest screenshot…`, `use the ui-reviewer subagent to see and review: @img_7.png`. Today that path renders as
 * literal text in the reader's turn, and the picture appears only if the agent happened to `read` it later, as an entry
 * in a collapsed activity group. The reference and the referent are in different places, usually with a disclosure
 * between them.
 *
 * So the preview belongs in the TURN, next to the sentence that names it. That is a different placement from an image
 * the reader pasted (which is content, and renders inline) and from one a tool returned (which is evidence, and stays
 * inside the activity group). Three sources, three placements, because they answer three different questions:
 *
 *   - pasted        → "this is what I am showing you"
 *   - named by path → "this is the thing I am talking about"
 *   - tool-read     → "this is what the agent looked at"
 *
 * ## Why detection is here and not in the orchestrator
 *
 * Nothing here reads a file. `previewsFor` decides WHICH strings look like image paths; the bytes come from the
 * orchestrator's existing `readFile`, which is already confined to the session's cwd with an 8 MB cap (ADR-0007,
 * `files.ts`). That asymmetry is deliberate: the pattern is a presentation decision (what is worth showing) and the
 * containment is a trust decision (what may be read). Putting the pattern in the orchestrator would put a display
 * heuristic behind a permission boundary, where it would look like a security check and be none.
 *
 * ## Conservative on purpose
 *
 * A false positive costs a failed request and a stated "could not read" note; a false negative costs nothing. So the
 * rules lean toward silence:
 *
 *   - a path must END in an image extension, so `screenshot.png came out wrong` is not a path
 *   - URL schemes and `data:` are refused, because they are not files in the session's directory
 *   - `..` is refused, because the orchestrator would refuse it anyway and asking would be theatre
 *   - duplicates collapse: naming one file twice is one picture
 *   - the list is capped, so a message that dumps a hundred paths cannot queue a hundred reads
 */

/**
 * How many references to preview in one message.
 *
 * Three. A real message names one to three (`@img_6.png shows…`, `@img_8.png captures…`); a fourth is usually a list of
 * files rather than a set of pictures the reader wants drawn, and the per-turn height budget starts to matter there.
 */
export const MAX_PREVIEWS = 3;

/**
 * Extensions worth a request.
 *
 * The same four the transcript will draw (`DISPLAYABLE_IMAGE_TYPES`), kept as extensions rather than MIME types because
 * that is what appears in a path. SVG is absent on purpose: the file viewer can show one, but a preview in a turn is a
 * subresource the reader did not ask for, and an SVG is the one image format that can carry script. Leaving it out
 * costs a reader nothing — the path still renders as text, and the file tree can still open it.
 */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/**
 * One candidate token.
 *
 * The character class is the crux. A path may contain `/ _ - .` and alphanumerics; it must NOT contain whitespace or
 * the punctuation that ends a clause, because `@img_6.png,` and `@img_6.png.` are the two spellings that appear in real
 * prose and neither ends in a literal `png`. Trailing punctuation is therefore trimmed afterwards rather than excluded
 * here — a file may legitimately end in a digit or letter, so the class has to be permissive and the trim has to happen
 * where the grammar is known.
 */
const CANDIDATE = /[A-Za-z0-9_./@-]+/g;

/** Strip the decorations prose adds to a filename: leading `@`, trailing punctuation, surrounding quotes. */
function clean(token: string): string {
  let text = token.replace(/^@+/, "");
  // Trailing sentence punctuation. Iterated, because `@a.png).` should lose both.
  for (;;) {
    const trimmed = text.replace(/[),.;:!?'"\]]+$/, "");
    if (trimmed === text) break;
    text = trimmed;
  }
  return text.replace(/^['"[(]+/, "");
}

/** Is this cleaned token a plausible RELATIVE path to an image in the session's directory? */
function isImagePath(token: string): boolean {
  if (token.length === 0 || token.length > 200) return false;
  const lower = token.toLowerCase();
  if (!IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return false;
  // Not a URL, not an inline payload, not an absolute path: the orchestrator speaks relative paths only, and asking for
  // anything else would produce a refusal the reader cannot act on.
  if (/^[a-z][a-z0-9+.-]*:/i.test(lower)) return false;
  if (lower.startsWith("/") || lower.startsWith("~")) return false;
  // `..` would be refused by the orchestrator's containment check. Refusing it here keeps the request honest rather
  // than theatre, and keeps the refusal note out of the transcript.
  if (lower.split("/").includes("..")) return false;
  return true;
}

/**
 * The image paths a message names, in the order they appear, de-duplicated and capped.
 *
 * Pure: takes text, returns strings. Every caller (and every test) can exercise it without a filesystem.
 */
export function previewsFor(text: string): string[] {
  if (text.length === 0) return [];
  /*
   * A NUL byte ends the scan entirely.
   *
   * Found by a test rather than reasoned about: the candidate pattern's character class excludes NUL, so `a\0b.png`
   * SPLIT into two tokens and the second one — `b.png` — was accepted. That would request a file nobody named, and a
   * filename the reader cannot see is a request they cannot understand. Prose does not contain NUL; a NUL means this is
   * not prose, so nothing in it is a path worth asking for.
   */
  if (text.includes("\u0000")) return [];
  const found: string[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const token = clean(match[0]);
    if (!isImagePath(token)) continue;
    if (found.includes(token)) continue;
    found.push(token);
    if (found.length >= MAX_PREVIEWS) break;
  }
  return found;
}
