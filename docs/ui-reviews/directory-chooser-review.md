I reviewed `/tmp/ui-review-76/chooser.png` (one capture, dark dashboard, ~1560px wide viewport).

## (a) What is rendered

**Backdrop:** Pi Central dashboard, dimmed behind the modal. Top bar "Sessions | History", right "8 sessions 3 scratch ● connected". Left rail of dimmed session cards with their own scrollbar. Centre pane: a German document ("Bagatellgrenzen im Zuwendungsrecht…", numbered sections 3., 4.). Right pane: "Scratch session scratch idle", "ctx 4%", "$0.1531", model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, "Thinking / high".

**Modal (centred, roughly one third of the viewport width), top to bottom:**
- **Title** "Open in a directory" — the only heading; no close (×).
- **"USED BEFORE"** small uppercase muted label, then a bordered list of four rows. Each row: bold name + small grey path beneath, right-aligned count. Literally: **pi-central-dev** / `~/git/idea-factory/pi-central-dev` / "11 sessions"; **data-manager** / `~/git/data-manager` / "170 sessions"; **sven1103** / `/Users/sven1103` / "68 sessions"; **idea-factory** / (path line sliced off at the panel edge) / "117 sessions". A thin scrollbar sits at the right edge of this list.
- **"Places"** label (same small uppercase style), then three rows: **Home** with `~` right-aligned; **git** with `git/~`; **Projects** with `projects/~`. A scrollbar is also visible at the right edge of this panel. No chevrons, no icons, no hover state.
- Muted one-line note: "Not on this machine: ~/src, ~/dev, ~/code, ~/work".
- A wide text input with a bright blue focus ring and placeholder `/absolute/path/to/project`.
- Footer row: "Open here" and "Cancel" — both rendered as bare text, no filled button.
- Footnote: "The session is sandboxed to this directory, and Pi Central does not change a session's directory later. Start it where the work belongs."

The breadcrumb trail described in the brief is **not visible here**: at rest the browser header reads only "Places", with no separators, no trailing chevron, and no weight difference from "USED BEFORE" — so it does not read as a path at all, let alone a clickable one. No "Use git" button is visible in this state either.

## (b) Defects

- 🔴 **One-way descent, no way back.** Home/git/Projects rows descend; there is no "..", no up-arrow, no back control, no clickable crumb in view. Evidence: the browser card contains only a label and three rows. Once you descend into a folder, nothing on screen returns you.
- 🔴 **No filtering/search.** Neither panel has an input; the only text field takes a full absolute path. Finding a nested folder means scrolling a raw directory listing.
- 🔴 **No affordance that rows are clickable, or what clicking does.** No folder icons, no `›`, no hover styling visible on any row. Worse, per the brief, clicking a *used-before* row immediately starts a session — an irreversible step (the footnote says the directory cannot be changed later) with zero warning of that consequence.
- 🟠 **Section 2's "no orientation" is accurate:** the path is a static label "Places"; the current location, parent, and depth are not shown anywhere.
- 🟠 **Section 1 is half-true:** recents are genuinely one click (`pi-central-dev`, 11 sessions) and the path field accepts anything — but anything not in four recents and not in three roots is unreachable in practice.
- 🟠 **Section 3 accurate:** zero icons in the modal — no folder, repo, home, or drive glyph; the three Places entries are text-only.
- 🟠 **Section 4 accurate:** no dates, no "last used", no sort control, no column headers. The count column ("170 sessions" vs "11 sessions") is the only quantitative cue and it is not sorted by.
- 🟠 **Inconsistent path formatting** breaks scanning: `~/git/idea-factory/…`, `~/git/data-manager`, then an absolute `/Users/sven1103`.
- 🟠 **Webkit-truncated list hides that more exist:** row 4 (`idea-factory`) is cut mid-path with no rounded bottom, no fade, no "more" indicator; the only cue is a very low-contrast 1px scrollbar.
- 🟠 **Three different verbs for one action:** "Open here", (per brief) "Use git", and an implicit click-to-launch on recents.
- 🟡 **No primary button.** "Open here" and "Cancel" are bare text of similar weight; nothing signals commit vs dismiss. "Open here" appears enabled while the field holds only a placeholder.
- 🟡 **Footnote is the loudest sentence in the footer** — a policy sentence about what Pi Central won't let you change, placed directly under the buttons.
- 🟡 **Likely contrast failures:** path sublines, counts, "USED BEFORE"/"Places" labels and the "Not on this machine" note are all very small muted grey on dark navy.
- 🟡 **No keyboard affordances:** no Esc/Cancel hint, no Enter hint, no arrow-key hint, though the field is autofocused and the flow is clearly keyboard-driven.
- 🔵 No close (×) on the modal; only Cancel.
- 🔵 Narrow single column: modal is much narrower than the viewport, forcing two independent nested scrollers inside one dialog.

## (c) Ranked blockers to fast navigation, with conventional remedies

1. **No up/back navigation** → breadcrumb with individually clickable segments plus an "up one level" button/`⌘↑`, as in Finder, Windows Explorer, and VS Code's Open Folder.
2. **No type-to-filter in the current folder** → an inline filter box over the listing, arrow keys + Enter, as in GTK/Nautilus, Slack's file picker, and every native open dialog. Currently the only way in is a full absolute path.
3. **No row affordance / ambiguous click meaning** → folder icon + trailing chevron for descend, explicit "Open" button per recent row, hover highlight, and a visible "start session here" button for the currently open folder.
4. **Places is a three-item static menu** → a real left rail of places (Home, git, Projects, workspace roots, drives) with icons and, ideally, counts.
5. **Recents lack time and order** → "last used" column and a sort control (Recent / Name / Sessions), plus showing all recents rather than 3.5.
6. **Two-pane layout** → places rail on the left, filterable listing on the right (classic file-dialog shape) instead of two stacked scrollers in a narrow column.
7. **Normalise paths** to `~/…` everywhere and fix the reversed tilde (see d).
8. **Primary action** → one filled primary ("Open here") plus a plain Cancel, with the footnote moved out of the button row.
9. **Keyboard disclosure** → "Esc to cancel · Enter to open" hint.

## (d) Likely rendering bugs, not design choices

- **Yes, the right column looks like a text-direction fault, not intended copy.** Literally as rendered, top to bottom: `~`, then `git/~`, then `projects/~`. A user expects `~/git` and `~/projects`. What is on the right of "git" is the folder name, with the tilde and slash trailing *after* it — i.e. the abbreviation that should have preceded the name has been pushed to the far side of it. The Home row showing a lone `~` is consistent with the same string (`~`) having nothing to reorder. That is the signature of the string being laid out right-to-left, not of the string being authored as "git~/". I cannot see the DOM, so I cannot prove the cause — but the fact that the *path* hint is reversed while every other string in the modal reads normally LTR is the anomaly worth confirming.
- **The clipped fourth recent row** (path sliced at the container edge, border/rounding missing) reads as a CSS overflow accident rather than a deliberate "peek" affordance.
- **A scrollbar on the Places panel containing three short rows** suggests a fixed height with `overflow: auto` on content that doesn't overflow — paying for a scroller you don't need while two independent scroll regions nest inside one modal.
- **"Open here" / "Cancel" with no button chrome**: either an intentional text-button style that reads as disabled-ish, or unstyled buttons. Worth checking against the app's other buttons (the dashboard's controls are also flat, so this may be convention).

## What to look into

Hover/focus states on rows; what the breadcrumb looks like after descending one and two levels; whether an up control appears mid-navigation; behaviour with an empty path field ("Open here" enabled?); the full 20-item recents list; a folder with long/unicode/non-Latin names (to test the direction bug); a narrow viewport (the modal already looks cramped); keyboard-only traversal; and the same dialog in light mode.

## (e) Verdict

As the *only* way to pick a directory, this is **not fit** — and the fix is restructuring, not restyling. What is on screen is a recents list, a three-item root menu, and a raw path field; there is no browser: no parent navigation, no filtering, no icons, no sort or recency data, and no per-row action that tells you a click will launch an irreversible session. It serves exactly one happy path — a directory in the top four recents or a path you can type from memory — and stalls for everything else. The single highest-impact change is a two-pane file dialog with a places rail plus a filterable listing that has folder icons, a chevron to descend, and an explicit up-one-level/breadcrumb control; keeping the recents list as a sortable section above or beside it preserves the speed this modal already has. The report's five claims each survive the render, though claim 1 should be read as "cannot navigate *beyond* the four recents" rather than "cannot navigate at all".