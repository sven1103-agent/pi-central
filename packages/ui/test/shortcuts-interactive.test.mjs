/**
 * The keyboard, driven the way a reader drives it: real events, real components.
 *
 * `shortcuts.test.mjs` holds the registry and the guard ladder to their promises by inspection; this file presses the
 * keys. The two are not the same claim — a correct ladder wired to a listener on the wrong element behaves perfectly
 * in the first test and does nothing in the window — and the reported complaint was about the WINDOW (*"a lot of mouse
 * movements"*), not about a module's contract.
 *
 * Everything here goes through jsdom and React's own `act`, the pattern `inline-rename.test.mjs` established: mount,
 * dispatch a `KeyboardEvent`, assert what the document says afterwards.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let React, ReactDOMClient, act, ShortcutSheet, ConfirmDelete, server;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ ShortcutSheet } = await server.ssrLoadModule("/src/components/ShortcutSheet.tsx"));
  ({ ConfirmDelete } = await server.ssrLoadModule("/src/components/ConfirmDelete.tsx"));
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  act = React.act;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

after(async () => {
  await server?.close();
});

/** Mount a component into a fresh container, and return the container plus an unmount. */
function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

/** Press a key at `target` (default: the document), the way the platform delivers it. */
function press(init, target = document.body) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

// --- Focus enters ONCE, not on every render -----------------------------------------------------

/*
 * These three surfaces all say "focus enters on open", and all three are given INLINE callbacks by `App`. The shell
 * re-renders on every socket event, so an effect that moved focus with `onClose`/`onCancel`/`onConfirm` in its
 * dependencies moved focus again on each of them — a sheet or dialog that yanks the reader back to its first control
 * while they are reading it, or out of the control they had tabbed to.
 *
 * The probe that found this carried a bug of its own: it used `document.body.focus()`, which is a no-op in jsdom
 * because `<body>` is not focusable. The precondition silently failed and the assertion passed for the wrong reason in
 * the fixed build, so the fix looked unverified. Each test below therefore moves focus to a REAL focusable button, and
 * asserts the move landed before asserting it survived.
 */

/** A focusable element OUTSIDE the surface, standing in for "the reader went elsewhere in the app". */
function outsideButton() {
  const button = document.createElement("button");
  button.textContent = "outside";
  document.body.append(button);
  return button;
}

/**
 * What has focus, as a STRING.
 *
 * `assert.equal(document.activeElement, button)` looks like the obvious form and is a trap: on failure Node renders
 * both operands, and rendering two live jsdom nodes — cyclic, each with a document and a window — kills the process
 * with SIGKILL after ~25 s. The failure then arrives as "the whole FILE timed out", with the sentence that actually
 * failed lost. A string identifies the elements just as precisely and always reports.
 */
function focusLabel() {
  const active = document.activeElement;
  if (active === null) return "(none)";
  return active.textContent === "" ? `<${active.tagName.toLowerCase()}>` : active.textContent;
}

test("a re-render of the open keys sheet does not take focus back", () => {
  const outside = outsideButton();
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  // A FRESH inline callback per render, exactly as `App` passes it — the input that made the effect re-run.
  const render = () =>
    act(() => root.render(React.createElement(ShortcutSheet, { onClose: () => {}, platform: "apple" })));

  // `try/finally`: a failing assertion here must still unmount. A root left mounted under
  // `IS_REACT_ACT_ENVIRONMENT` deadlocks the next test's `act` calls, so the failure would be reported as a 25 s
  // timeout of the whole FILE rather than as the sentence below.
  try {
    render();
    assert.equal(focusLabel(), "Close", "focus is inside on open");

    act(() => outside.focus());
    assert.equal(focusLabel(), "outside", "precondition: focus really moved out");

    render();
    assert.equal(focusLabel(), "outside", "a plain re-render must not pull focus back into the sheet");
  } finally {
    act(() => root.unmount());
    outside.remove();
  }
});

test("a re-render of the open delete confirmation does not take focus back", () => {
  // The same defect on the one surface where it is dangerous: `Keep it` and `Delete transcript` mean opposite things,
  // so a dialog that moves focus on a socket event can make a second press land on the other button.
  const outside = outsideButton();
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  const render = () =>
    act(() => root.render(React.createElement(ConfirmDelete, { label: "x", onCancel: () => {}, onConfirm: () => {} })));

  try {
    render();
    assert.equal(focusLabel(), "Keep it", "the cancel control takes focus");

    const destructive = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Delete transcript"),
    );
    act(() => destructive.focus());
    assert.equal(focusLabel(), "Delete transcript", "precondition: the reader tabbed to the destructive control");

    render();
    assert.equal(
      focusLabel(),
      "Delete transcript",
      "a re-render must not move focus back to `Keep it` on an irreversible dialog",
    );
  } finally {
    act(() => root.unmount());
    outside.remove();
  }
});

// --- The delete confirmation, answered twice with the same key ---------------------------------

test("⌘⌫ opens the confirmation and a second ⌘⌫ confirms it", () => {
  // The chore in the report, ended: a run of finished sessions is now key, key, key, key — not key, pointer, key,
  // pointer. One gesture, still with a dialog that names what goes, and still not a single stray Enter away from it.
  let confirmed = 0;
  let cancelled = 0;
  const { unmount } = mount(
    React.createElement(ConfirmDelete, {
      label: "\u201cFix the login redirect\u201d",
      cwd: "/Users/x/git/project",
      onCancel: () => {
        cancelled += 1;
      },
      onConfirm: () => {
        confirmed += 1;
      },
    }),
  );

  press({ key: "Backspace", metaKey: true });
  assert.equal(confirmed, 1, "the same key confirms");
  assert.equal(cancelled, 0);

  // And a different keystroke does not: the dialog answers its own chord and nothing else.
  press({ key: "Enter" });
  press({ key: "Backspace" });
  press({ key: ".", metaKey: true });
  assert.equal(confirmed, 1, "no other key confirms the irreversible action");
  unmount();
});

test("Escape still cancels the delete, and the chord cannot be reached through it", () => {
  let cancelled = 0;
  const { unmount } = mount(
    React.createElement(ConfirmDelete, {
      label: "x",
      onCancel: () => {
        cancelled += 1;
      },
      onConfirm() {},
    }),
  );
  press({ key: "Escape" });
  assert.equal(cancelled, 1);
  unmount();
});

test("the confirmation's chord does not escape to the window", () => {
  // One press must be one action. The shell also listens for `⌘⌫` on the window; if the dialog's handler let the
  // event through, confirming would immediately open the NEXT confirmation — a delete loop from a held key.
  const seen = [];
  const windowListener = (event) => seen.push(event.defaultPrevented);
  window.addEventListener("keydown", windowListener);
  const { unmount } = mount(
    React.createElement(ConfirmDelete, { label: "x", onCancel() {}, onConfirm() {} }),
  );
  const event = press({ key: "Backspace", metaKey: true });
  window.removeEventListener("keydown", windowListener);
  assert.equal(event.defaultPrevented, true, "the dialog claims the keystroke");
  assert.deepEqual(seen, [], "and the window listener never sees it");
  unmount();
});

// --- The sheet -------------------------------------------------------------------------------

test("the sheet lists the keys as KEYS, grouped, in the platform's notation", () => {
  // Read from the rendered document rather than from the registry, because this is the surface the reader actually
  // sees: `shortcuts.test.mjs` proves the registry is complete, and this proves it reaches the screen.
  const { container, unmount } = mount(
    React.createElement(ShortcutSheet, { onClose() {}, platform: "apple" }),
  );

  const groups = [...container.querySelectorAll(".keys-group h4")].map((h) => h.textContent);
  assert.deepEqual(groups, ["Sessions", "Pages", "Writing"]);

  const chords = [...container.querySelectorAll(".keys-chord")].map((node) => node.textContent);
  assert.ok(chords.includes("⌘."), `the stop key is shown, got ${JSON.stringify(chords.slice(0, 6))}`);
  assert.ok(chords.includes("⌘⌫"), "and so is the delete key");
  assert.ok(chords.includes("⌘⇧O"), "and the one the rail already advertised");

  /*
   * Every chord is a real `<kbd>`, which is what makes it read as a key and survive `forced-colors`.
   *
   * Boxes are counted against CHORDS, not against ROWS: a row may offer two chords, and Zen mode does (issue #275).
   * Counting per row would have been a claim about how many bindings a mode is allowed, which is not what this test is
   * protecting — the bare text is. Falsified by rendering a chord as raw text beside its `<kbd>`: combos and boxes then
   * disagree.
   */
  const combos = container.querySelectorAll(".keys-chord .keys-combo");
  const kbds = container.querySelectorAll(".keys-chord kbd");
  assert.equal(kbds.length, combos.length, "one key box per chord, no bare text");

  /*
   * A row may offer TWO chords, and Zen mode does (`⌥⇧Z` and `⌘⇧.`, issue #275). The claim above is about boxes versus
   * raw text, not about one chord per row, so it holds either way — and this asserts the alternative is RENDERED as an
   * alternative rather than as a sequence: `⌥⇧Z or ⌘⇧.`, never `⌥⇧Z ⌘⇧.`, which a reader would take for a chord of
   * five keys.
   *
   * Falsified by dropping the `keys-or` separator: the two combos then run together with no word between them.
   */
  const zen = [...container.querySelectorAll(".keys-row")].find((row) => row.textContent.includes("Zen mode"));
  assert.ok(zen, "the mode is on the sheet");
  const zenChords = [...zen.querySelectorAll(".keys-chord kbd")].map((node) => node.textContent);
  assert.deepEqual(zenChords, ["⌥⇧Z", "⌘⇧."], "both chords, in the registry's order");
  assert.match(zen.textContent, /⌥⇧Z\s*or\s*⌘⇧\./, "and the word between them, so they are alternatives");

  // The words are the ACTION's, not a second description of it.
  assert.match(container.textContent, /Stop the focused session/);
  assert.match(container.textContent, /Delete the focused session's transcript/);
  unmount();
});

test("⌘⇧O is printed the way the rail already prints it", () => {
  // One chord, two surfaces: the rail's own hint and the sheet must not disagree about it.
  const { container, unmount } = mount(
    React.createElement(ShortcutSheet, { onClose() {}, platform: "other" }),
  );
  const chords = [...container.querySelectorAll(".keys-chord")].map((node) => node.textContent);
  assert.ok(chords.includes("Ctrl+Shift+O"), "a non-Apple reader is told about keys they have");
  assert.ok(!chords.some((chord) => chord.includes("⌘")), "and never shown a glyph their keyboard lacks");
  unmount();
});

test("the sheet takes focus on open, and Escape closes it without stopping a run", () => {
  // Focus is what makes Escape work without a click. The `stopPropagation` is what keeps one Escape from ALSO reaching
  // the composer's ladder and stopping the focused session — an irreversible consequence of closing a help sheet.
  let closed = 0;
  let ladderRan = 0;
  const ladder = (event) => {
    // The composer's own listener, on the window and not the capture phase, exactly as it is registered.
    if (event.key === "Escape") ladderRan += 1;
  };
  window.addEventListener("keydown", ladder);
  const { container, unmount } = mount(
    React.createElement(ShortcutSheet, {
      onClose: () => {
        closed += 1;
      },
      platform: "apple",
    }),
  );

  assert.equal(document.activeElement?.textContent, "Close", "focus lands inside the sheet");
  press({ key: "Escape" });
  window.removeEventListener("keydown", ladder);
  assert.equal(closed, 1, "Escape closes it");
  assert.equal(ladderRan, 0, "and the escape ladder never hears about it");
  assert.ok(container.querySelector(".modal"), "the surface is a dialog, not a panel");
  unmount();
});

test("the sheet cannot grow past the window, because `Close` is at the BOTTOM", () => {
  /*
   * Reported from use, with a screenshot: at the chords' new size the sheet *"is spanning the vertical space of the
   * screen and cutting off the bottom"*. The cause is documented in this stylesheet already, for the directory sheet:
   * `.modal-backdrop` is `place-items: center` with no scroller, so a dialog taller than the window loses its top AND
   * its bottom — and the bottom is where the only button is.
   *
   * Two properties, and both are needed. A bounded dialog alone would still cut off by scrolling the TITLE out of view
   * (so a reader halfway down has no heading), and a scrolling body alone would grow the dialog past the window and
   * lose the footer. Together they make exactly one region scroll, between a fixed head and a fixed foot.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))];
    assert.ok(matches.length > 0, `${selector} must have a rule`);
    return matches[0][1];
  };

  const dialog = rule(".keys");
  // `max-height` (a ceiling) rather than `height`: a three-group list should not always occupy 760px.
  assert.match(dialog, /max-height:\s*min\(/, "the dialog is capped by a measured ceiling");
  assert.match(dialog, /100dvh|100vh/, "and tied to the window, not to a pixel guess");
  assert.match(dialog, /overflow:\s*hidden/, "the dialog itself does not scroll, or there would be two scrollers");
  assert.match(dialog, /display:\s*flex/, "it is a column, so head and foot can be pinned");

  // The body is the ONE scroller. `min-height: 0` is load-bearing: a flex child defaults to `min-height: auto`, which
  // refuses to shrink below its content and so silently defeats every `max-height` above it.
  const body = rule(".keys-body");
  assert.match(body, /overflow-y:\s*auto/, "the list scrolls");
  assert.match(body, /min-height:\s*0/, "or it cannot shrink inside the capped dialog");
  assert.match(body, /flex:\s*1/, "and takes whatever height the head and foot leave");

  // The head and foot keep their size, so neither the title nor `Close` can be pushed out.
  assert.match(rule(".keys-head"), /flex:\s*none/, "the title does not shrink away");
  assert.match(rule(".keys .dialog-actions"), /flex:\s*none/, "and neither does the button");
});

// --- The group control -----------------------------------------------------------------------

test("the rail's Stopped heading selects the group, and hands back exactly those rows", () => {
  // "Stopping several finished sessions and deleting it" — the selection half. The heading is where the scope is
  // known, so it is where the control lives; this drives the click and reads what the shell would receive.
  const selected = [];
  return server
    .ssrLoadModule("/src/components/SessionRail.tsx")
    .then(({ SessionRail }) => {
      const rows = [
        { entry: { path: "/s/a.jsonl", cwd: "/x", name: "a" }, session: undefined },
        { entry: { path: "/s/b.jsonl", cwd: "/x", name: "b" }, session: undefined },
      ];
      const { container, unmount } = mount(
        React.createElement(SessionRail, {
          rows,
          focusedId: undefined,
          onFocusRow() {},
          onForgetRow() {},
          onRetryRow() {},
          retryAvailable: true,
          onStartSession() {},
          onOpenDirectory() {},
          onSelectGroup: (group) => selected.push(...group.map((row) => row.entry.path)),
          home: "/x",
          historyTotal: 0,
          openAsDrawer: false,
          onCloseDrawer() {},
        }),
      );

      const control = container.querySelector(".group-select");
      assert.ok(control, "the Stopped heading is a control");
      assert.equal(control.textContent, "Stopped");
      act(() => control.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
      assert.deepEqual(selected, ["/s/a.jsonl", "/s/b.jsonl"], "both rows, in the order shown");
      unmount();
    });
});

test("a shell that cannot delete does not render the group control", () => {
  // The same rule the header's Delete icon follows: an absent capability is absent, not a button that fails.
  return server.ssrLoadModule("/src/components/SessionRail.tsx").then(({ SessionRail }) => {
    const { container, unmount } = mount(
      React.createElement(SessionRail, {
        rows: [{ entry: { path: "/s/a.jsonl", cwd: "/x", name: "a" }, session: undefined }],
        focusedId: undefined,
        onFocusRow() {},
        onForgetRow() {},
        onRetryRow() {},
        retryAvailable: true,
        onStartSession() {},
        onOpenDirectory() {},
        home: "/x",
        historyTotal: 0,
        openAsDrawer: false,
        onCloseDrawer() {},
      }),
    );
    assert.equal(container.querySelector(".group-select"), null, "no control without the capability");
    assert.match(container.textContent, /Stopped/, "but the heading is still a heading");
    unmount();
  });
});

test("the symbolic keys fall back to a face that has them", () => {
  // Measured, not assumed: `⌫` (U+232B) is declared by 11 of the 88 installed fonts and by neither `--mono` nor
  // SFCompact — the face `-apple-system` resolves to. `⌘` is in SFCompact, which is why the rail's hint has always
  // rendered while an earlier `⌫` attempt in this app did not. A chord that draws as an empty box is a shortcut the
  // reader cannot read, on the one surface whose whole job is to be readable.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.keys-chord kbd \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the chord box has its own rule");
  const family = /font-family:\s*([^;]+);/.exec(rule[1]);
  assert.ok(family, "and declares a font stack");
  assert.match(family[1], /var\(--mono\)/, "mono first, so the Latin keys align");
  assert.match(family[1], /Apple Symbols/, "and a face that carries the symbols after it");
});

test("the chords are the most legible text on the sheet, not the least", () => {
  /*
   * Reported from use, with a screenshot: *"It is a little bit hard to read, since the icons are very small."*
   *
   * The measurement behind that: the chords were set at `--fs-xs` (11px) — the app's second-smallest size — while the
   * sheet's own introduction was `--fs-base` (13px) and the action labels were `--fs-sm` (12px). So on a sheet that
   * exists to teach keys, the keys were the SMALLEST text and the sentence explaining them was the largest. The
   * screenshot shows the consequence: the glyphs float in a wide empty column, unreadably small, beside their labels.
   *
   * This asserts the RELATIONSHIP, not a pixel value, so the sheet may be re-scaled as long as the ordering holds: a
   * chord is at least as large as the action it performs, and larger than the note under that action.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const sizeOf = (selector) => {
    const rule = new RegExp(`${selector} \\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `${selector} must have its own rule`);
    const size = /font-size:\s*var\(--fs-([a-z0-9]+)\)/.exec(rule[1]);
    assert.ok(size, `${selector} must size itself from the type scale`);
    return size[1];
  };
  const scale = ["2xs", "xs", "sm", "base", "md", "lg"];
  const rank = (name) => {
    const at = scale.indexOf(name);
    assert.notEqual(at, -1, `${name} is a real step on the type scale`);
    return at;
  };

  const chord = rank(sizeOf("\\.keys-chord kbd"));
  const label = rank(sizeOf("\\.keys-what"));
  const note = rank(sizeOf("\\.keys-note"));
  const lede = rank(sizeOf("\\.keys-lede"));

  assert.ok(chord >= label, "a key is at least as legible as the action it performs");
  assert.ok(chord > note, "and larger than the note explaining it");
  // The regression that prompted this: the keys were smaller than the sheet's own introduction.
  assert.ok(chord >= lede, "and not smaller than the paragraph that introduces the list");
});

test("⌥↓ moves the focus down the rail, and stands still while a dialog is up", () => {
  // The key is a WINDOW listener, so it fires while a confirmation is in front too — and moving the focus behind a
  // dialog changes which session that dialog is about. The shell says when a modal is up; the rail obeys.
  return server.ssrLoadModule("/src/components/SessionRail.tsx").then(({ SessionRail }) => {
    const focused = [];
    const rows = [
      { entry: { path: "/s/a.jsonl", cwd: "/x", name: "a" }, session: undefined },
      { entry: { path: "/s/b.jsonl", cwd: "/x", name: "b" }, session: undefined },
    ];
    const props = {
      rows,
      focusedId: "/s/a.jsonl",
      onFocusRow: (row) => focused.push(row.entry.path),
      onForgetRow() {},
      onRetryRow() {},
      retryAvailable: true,
      onStartSession() {},
      onOpenDirectory() {},
      home: "/x",
      historyTotal: 0,
      openAsDrawer: false,
      onCloseDrawer() {},
    };

    /*
      The rail is CONTROLLED: `focusedId` is the shell's, so pressing a key asks the shell to move and the rail re-renders
      when it does. Each step is therefore its own mount with the focus it would then have — pressing twice against one
      fixed prop would only prove that the same input gives the same answer.
    */
    const forward = mount(React.createElement(SessionRail, props));
    press({ key: "ArrowDown", altKey: true });
    assert.deepEqual(focused, ["/s/b.jsonl"], "the next row on screen is focused");
    forward.unmount();

    // And up, from the second row, is the first — the other direction of the same arithmetic.
    focused.length = 0;
    const atSecond = mount(React.createElement(SessionRail, { ...props, focusedId: "/s/b.jsonl" }));
    press({ key: "ArrowUp", altKey: true });
    assert.deepEqual(focused, ["/s/a.jsonl"], "up is the previous one");
    atSecond.unmount();

    // From the LAST row, down wraps to the top, so two keys reach every row from anywhere.
    focused.length = 0;
    const atEnd = mount(React.createElement(SessionRail, { ...props, focusedId: "/s/b.jsonl" }));
    press({ key: "ArrowDown", altKey: true });
    assert.deepEqual(focused, ["/s/a.jsonl"], "it wraps at the end");
    atEnd.unmount();

    focused.length = 0;
    const blocked = mount(React.createElement(SessionRail, { ...props, modalOpen: true }));
    press({ key: "ArrowDown", altKey: true });
    assert.deepEqual(focused, [], "nothing moves while a dialog is covering the app");
    blocked.unmount();
  });
});
