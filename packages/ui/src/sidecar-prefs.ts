/**
 * The reader's choice for whether a NEW session gets a browser (ADR-0018 §15c).
 *
 * ## Why this is a preference and not a launch flag
 *
 * It was `PI_CENTRAL_SIDECAR=1` and nothing else, which made the environment the only way to turn the feature on. That
 * works in a terminal and fails in exactly the case this product advertises: a dock PWA or a `.app` launched from
 * Finder inherits no shell environment, so the reader could not reach the feature at all and nothing told them why.
 *
 * `PI_CENTRAL_SIDECAR=1` still sets the DEFAULT, so an existing wrapper keeps working and a scripted launch stays
 * declarative. What changes is that the reader can now disagree with it from inside the app.
 *
 * ## Why `localStorage` and not the orchestrator
 *
 * It is the same kind of fact `railPrefs` is: how *this reader* wants a session started, not something derivable from
 * any session. Storing it in the orchestrator would give one machine one answer for every window; a browser preference
 * is per reader.
 *
 * The orchestrator cannot be the authority anyway, and that asymmetry is deliberate: the reader's answer travels with
 * each `start` request as `Control.start.sidecar`, so the app states the choice every time rather than the orchestrator
 * remembering one. A remembered server-side default would be a second answer that can disagree with the switch on
 * screen, which is the class of bug the three-valued `sidecar` field exists to close.
 *
 * ## Validated on read, because `localStorage` outlives upgrades
 *
 * Anything but the two strings below is treated as "no opinion", and no opinion means the installation's default
 * decides. Never `undefined` versus `false` confusion: that ambiguity is what made the picker's checkbox decorative.
 */

export const SIDECAR_PREFS_KEY = "pi-central:session-browser";

/**
 * `undefined` means "no opinion", which is NOT the same as `false`.
 *
 * A reader who never touched the switch must get the installation's default, including when that default arrives from
 * `PI_CENTRAL_SIDECAR=1` after they have already used the app once.
 */
export type SidecarPref = boolean | undefined;

export function parseSidecarPref(raw: string | null): SidecarPref {
  if (raw === "on") return true;
  if (raw === "off") return false;
  return undefined;
}

export function serializeSidecarPref(pref: SidecarPref): string | null {
  if (pref === true) return "on";
  if (pref === false) return "off";
  // Absent means "no opinion", which is stored as absence rather than as a sentinel string.
  return null;
}

/**
 * What a new session should actually get, from the reader's choice and the installation's default.
 *
 * The reader wins when they have an opinion. This is the same precedence the orchestrator applies to a `start` request
 * (`sidecar === false` outranks `config.sidecar`), stated once here so the UI never has to guess — and so the switch can
 * be rendered already showing the answer rather than looking switched off while sessions keep getting browsers.
 */
export function effectiveSidecar(pref: SidecarPref, offered: boolean, installDefault: boolean): boolean {
  if (!offered) return false;
  if (pref !== undefined) return pref;
  return installDefault;
}

/** Read the stored choice, tolerating storage being disabled or the origin being opaque. */
export function readSidecarPref(): SidecarPref {
  try {
    return parseSidecarPref(localStorage.getItem(SIDECAR_PREFS_KEY));
  } catch {
    return undefined;
  }
}

/** Persist the choice. A failure is silent: the session still starts with what the reader just chose. */
export function writeSidecarPref(pref: SidecarPref): void {
  try {
    const raw = serializeSidecarPref(pref);
    if (raw === null) localStorage.removeItem(SIDECAR_PREFS_KEY);
    else localStorage.setItem(SIDECAR_PREFS_KEY, raw);
  } catch {
    // Storage disabled. The switch still works for this window; it just will not remember.
  }
}
