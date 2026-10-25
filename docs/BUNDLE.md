# UI bundle sizes

Measured with `npm run ui:build`, which is what CI runs and what the orchestrator serves. Numbers
are for the **entry** chunk — everything a page load must fetch before it can render — because that
is the number a user actually pays. A lazy chunk counts only once it has been fetched.

## After issue #4 (syntax highlighting)

Entry chunk: **418.47 kB** (144.36 kB gzip).

## Before issue #4

Entry chunk: **413.43 kB** (142.00 kB gzip).

## The delta, and why it is small

| | before | after | delta |
|---|---|---|---|
| entry | 413.43 kB | 418.47 kB | **+5.04 kB** raw, **+2.36 kB** gzip |

Shiki itself is ~234 kB of machinery (the TextMate core, the JavaScript regex engine, the theme and
the grammar index), and **none of it is in the entry chunk**. It is four lazy chunks:

| chunk | raw |
|---|---|
| `core-*.js` (Shiki core) | 114.20 kB |
| `engine-javascript-*.js` | 59.47 kB |
| `grammar-map-*.js` (the name → chunk index) | 46.24 kB |
| `github-dark-default-*.js` (the theme) | 14.44 kB |

Plus **261 grammar chunks**, one per language, fetched only when that language is first seen.
They are not uniform — the median is 10.7 kB and the largest are `elisp` at 790 kB and `cpp` at
501 kB — which is the argument for lazy loading in one line: a session that shows no code fetches
none of it, and a session that shows TypeScript fetches ~11 kB rather than 8.2 MB.

`dist/` totals **8.7 MB of JS across 266 chunks**. That is a build artifact, not a load: the
orchestrator serves it from disk on the same machine, and a browser fetches what it renders.

## The grammar index had to be made lazy too

Not obvious, and worth recording. Vite needs a **static** specifier to emit one chunk per grammar,
which is what `import.meta.glob` provides. But the generated map has one entry per grammar, and
measured here it is **46 kB of URLs** — so putting it in the entry chunk would have re-imported most
of the cost that lazy grammars were meant to avoid. It lives in its own module (`grammar-map.ts`) and
is reached through a dynamic `import()`.

The first attempt measured the difference: with the glob inline in `highlight.ts` the entry chunk was
**442 kB**; moving it to a lazy module brought it to **418 kB**. A lazy loader with an eager index is
a bounded saving pretending to be an unbounded one.

## How to reproduce

```sh
npm run ui:build
ls -l packages/ui/dist/assets/index-*.js
```
