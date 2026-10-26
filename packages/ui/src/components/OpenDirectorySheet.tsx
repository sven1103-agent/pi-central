/**
 * The directory sheet: naming the path a session will work in.
 *
 * Deliberately a sheet rather than the greeting. The common case is a session with no path (US-1);
 * this exists for the case where the work already has a home.
 *
 * ## Two different things are checked here, and they are different in kind
 *
 * `problem` is a **validation error**: the path cannot be used, and submission is blocked.
 * `hazard` is a **warning**: the path is usable and the consequences are worth knowing, so
 * submission is NOT blocked. Collapsing them would make the app refuse something the user may have
 * a good reason to do — which is the wrong trade for a hazard whose whole purpose is to inform.
 *
 * The hazard uses `ownInstallationWarning` from the shared protocol package, the SAME function the
 * orchestrator calls when it attaches the warning to a session. Two implementations would mean the
 * sheet warning and the rail not (or the reverse), with nothing to reveal the disagreement.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ownInstallationWarning } from "@pi-central/protocol";

export function OpenDirectorySheet({
  installationRoot,
  initialPath = "",
  onClose,
  onOpen,
}: {
  /** Where Pi Central is running from, or `undefined` if it could not be identified (issue #25). */
  installationRoot: string | undefined;
  /** A prefilled path, which a test uses to reach a given state without simulating typing. */
  initialPath?: string;
  onClose: () => void;
  onOpen: (cwd: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmed = path.trim();
  // Client-side validation is advisory only: the orchestrator validates the directory before
  // spawning, and a directory can vanish between the two checks (D-4).
  const problem = useMemo(() => {
    if (trimmed.length === 0) return "Enter a directory.";
    if (!trimmed.startsWith("/")) return "Enter an absolute path, starting with /.";
    return undefined;
  }, [trimmed]);

  /**
   * The self-hosting hazard, evaluated while the path is being typed (issue #25).
   *
   * Advisory and non-blocking: the user may have a good reason, and the warning exists to inform the
   * decision rather than to make it. `problem` gates submission; this deliberately does not.
   *
   * Skipped when the path is already invalid, because a sentence about consequences next to "enter
   * an absolute path" would be noise about something the user cannot act on yet.
   */
  const hazard = useMemo(() => {
    if (problem !== undefined) return undefined;
    return ownInstallationWarning(trimmed, installationRoot);
  }, [trimmed, installationRoot, problem]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-dir-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="open-dir-title">Open in a directory</h3>
        <p style={{ marginBottom: 12 }}>
          The session is sandboxed to this directory. Pi Central does not change a session's
          directory later, so start it where the work belongs.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === undefined) onOpen(trimmed);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={path}
            spellCheck={false}
            placeholder="/absolute/path/to/project"
            aria-label="Working directory"
            aria-invalid={problem !== undefined && path.length > 0}
            onChange={(event) => setPath(event.target.value)}
            style={{
              width: "100%",
              background: "var(--bg)",
              border: "1px solid var(--line-strong)",
              borderRadius: 6,
              padding: "8px 10px",
              color: "var(--text)",
              font: "13px var(--mono)",
            }}
          />
          {problem !== undefined && path.length > 0 && (
            <p style={{ color: "var(--warn-text)", fontSize: 12, margin: "6px 0 0" }}>{problem}</p>
          )}
          {hazard !== undefined && (
            // `role="status"` rather than `alert`: this updates as the user types, and an alert on
            // every keystroke would interrupt a screen reader mid-word. Not an error — the submit
            // button stays enabled, which a test asserts.
            <p className="hazard" role="status">
              <span aria-hidden="true">⚠ </span>
              {hazard}
            </p>
          )}
          <div className="dialog-actions">
            <button type="submit" className="btn" disabled={problem !== undefined}>
              Open here
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
