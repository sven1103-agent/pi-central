/**
 * All keyboard shortcuts, on one sheet (`⌘/`).
 *
 * ## Why a sheet and not a menu of hints
 *
 * The keys exist either way; what was missing is a place to LOOK. A reader who does not already know that `⌘.`
 * stops a session will never find it, and the alternative — a hint beside every action — spends permanent screen
 * space on every surface to answer a question asked once. This is the same trade `Settings` makes, and it is
 * rendered the same way: the app's one dialog idiom, `Esc` to leave, focus in on open and back to the trigger on
 * close.
 *
 * ## It renders the REGISTRY, not a list of its own
 *
 * `shortcuts.ts` holds the bindings and the words. This file decides only where they go on the page — which is what
 * makes the sheet trustworthy: a shortcut that is not in the registry cannot appear here, and one that is in the
 * registry cannot be missing. The failure this avoids is the ordinary one, where the help is written by hand next to
 * the handler and the two part company at the first new binding.
 *
 * ## Why the chord is a `<kbd>`
 *
 * Because it is a key, and because `forced-colors` draws the box that says so. When a binding has two equivalent
 * chords they are joined by an `aria-hidden` `or`, so a screen reader says the two chords rather than reading the
 * word between them as part of one of them.
 */
import { useEffect, useRef } from "react";
import { detectPlatform, shortcutSections, type Platform } from "../shortcuts.ts";

export function ShortcutSheet({
  onClose,
  /**
   * The notation to print in.
   *
   * Passed rather than detected inside, for the reason every test in this repository exists: `renderToStaticMarkup`
   * runs no effects and no user agent, so a component that read `navigator` itself could only ever be tested in one
   * notation. `App` supplies the detected value.
   */
  platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator.userAgent),
}: {
  onClose: () => void;
  platform?: Platform;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  /*
   * The LATEST `onClose`, read through a ref, so the listener below can be registered once.
   *
   * The shell passes an inline arrow (`onClose={() => { setKeysOpen(false); keysTriggerRef.current?.focus(); }}`), so a
   * dependency on `onClose` makes the effect re-run on every render of `App` — and every socket event re-renders it. An
   * effect that moves focus on each run therefore yanks the reader back to `Close` while they are reading the list, or
   * out of the list entirely if they had tabbed into it. The carried probe that named this defect had a broken
   * precondition of its own (`document.body.focus()` is a no-op, because `<body>` is not focusable), so the defect was
   * confirmed by reverting this fix and watching the real test fail. "The sheet fights the keyboard" is the one thing
   * this surface must not do.
   */
  const closeOf = useRef(onClose);
  closeOf.current = onClose;

  useEffect(() => {
    // Mount-only: focus moves INTO the surface once, so `Esc` works without a click and a keyboard reader is not left
    // behind it. `[]` is the whole point — "on open" is a mount, not an update.
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // `stopPropagation`, because the composer's escape ladder is also on the window: without it one Escape would
      // close this sheet AND stop the focused session's run — two actions for one keystroke.
      event.stopPropagation();
      closeOf.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const sections = shortcutSections(platform);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal keys"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="keys-title">Keyboard shortcuts</h3>
        {/*
          An honest scope, because the first draft of this sentence was "everything the keyboard can do" — which the
          list below is not. It leaves out the platform's own editing keys, the panel's resize arrows, and the
          trace's traversal, all of which work and none of which this app invented. Claiming them would make the sheet
          a promise it cannot keep in step; saying what it is beats a completeness the surface does not have.
        */}
        <p className="keys-lede">
          Every shortcut Pi Central defines. Ordinary keys still work as they do everywhere — typing, arrow keys in
          a field, <kbd>Tab</kbd> between controls. Session actions apply to the <strong>focused</strong> session.
        </p>

        {sections.map((section) => (
          <section key={section.id} className="keys-group">
            <h4>{section.title}</h4>
            <dl className="keys-list">
              {section.rows.map((row) => (
                <div key={row.id} className="keys-row">
                  {/*
                    The keys FIRST, in a fixed-width column, so the eye can scan one column of chords instead of
                    hunting each row's right edge — the reason a shortcut list is readable at all.
                  */}
                  <dt className="keys-chord">
                    {row.keys.map((key, index) => (
                      <span key={key} className="keys-combo">
                        {index > 0 && (
                          <span className="keys-or" aria-hidden="true">
                            or
                          </span>
                        )}
                        <kbd>{key}</kbd>
                      </span>
                    ))}
                  </dt>
                  <dd className="keys-what">
                    {row.label}
                    {row.note !== undefined && <span className="keys-note">{row.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        <div className="dialog-actions">
          <button type="button" className="btn" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
