/**
 * The name → grammar-chunk map, and the reason it is its own module.
 *
 * ## Why this is a separate file that is only ever imported dynamically
 *
 * Vite needs a **static** specifier to emit one chunk per grammar — a fully dynamic
 * `import(\`…/${name}\`)` cannot be bundled, so the bundler either inlines everything (defeating the
 * point) or fails. `import.meta.glob` is the tool for that, and it works.
 *
 * What it is not is free. The generated map has one entry per grammar (`"./abap-XXXX.js": () =>
 * import(…)`), and measured in this build that map is **~24 kB of the eager entry chunk** — 265
 * URLs, paid on every page load, to highlight code that most page loads never show. So the map lives
 * here and is reached through a dynamic `import()` in `highlight.ts`: the 24 kB becomes a chunk that
 * is fetched the first time a grammar is actually needed, and never before.
 *
 * That is the same rule as the grammars themselves, applied one level up. The lazy design is only
 * honest if the *index* is lazy too; a lazy loader with an eager index is a bounded saving
 * pretending to be an unbounded one.
 *
 * The path climbs out of the package because npm workspaces hoists `@shikijs/*` to the repository
 * root: `packages/ui/node_modules/` has no copy. A root-relative `/node_modules/…` glob would match
 * nothing here and degrade every language to plain text — a quiet failure that looks like
 * "highlighting just does not work", so a test asserts a real grammar loads rather than only that an
 * unknown one is refused.
 */
export const grammars = import.meta.glob<{ default: unknown }>(
  "../../../node_modules/@shikijs/langs/dist/*.mjs",
);

/** Every grammar this build bundled, as `…/dist/<name>.mjs`. Exported for the tests' assertions. */
export function grammarFiles(): string[] {
  return Object.keys(grammars).sort();
}
