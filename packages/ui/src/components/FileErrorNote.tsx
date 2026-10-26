/**
 * A file-browser refusal, stated with its reason.
 *
 * Its own module because two components need it — the tree (a directory that would not list) and the
 * document view (a file that would not read) — and because the reason mapping is a decision worth
 * reading on its own.
 *
 * The reason is a closed set from the protocol, so each case is handled rather than printing whatever
 * prose arrived. That matters because the *fix* differs per reason: a binary file is not going to
 * become readable, a permission failure is a `chmod`, an escape is a path bug, and an oversized file
 * is a judgement call. A generic "could not read" would hide all four.
 */

export function FileErrorNote({
  path,
  reason,
  code,
  message,
  depth = 0,
}: {
  path: string;
  reason: string;
  code?: string | undefined;
  message: string;
  depth?: number;
}) {
  return (
    <p
      className="filetree-note filetree-error"
      role="note"
      style={{ paddingLeft: `${depth * 12}px` }}
      title={path === "" ? undefined : path}
    >
      <strong>{reasonLabel(reason)}</strong>
      {/* The orchestrator's message is shown verbatim: it carries the OS code and the sizes, and
          rewording it here would be a second place that could disagree with the first. */}
      <span className="filetree-error-detail">{message}</span>
      {code !== undefined && <span className="filetree-kind">{code}</span>}
    </p>
  );
}

/** A short human label for a refusal reason. The long explanation is the orchestrator's message. */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "escapes-cwd":
      return "Outside the working directory";
    case "absolute-path":
      return "Not a relative path";
    case "invalid-path":
      return "Not a usable path";
    case "too-large":
      return "Too large to read";
    case "binary":
      return "Not a text file";
    case "permission":
      return "Permission denied";
    case "not-found":
      return "Not found";
    case "not-a-directory":
      return "Not a directory";
    case "is-directory":
      return "That is a directory";
    default:
      return "Could not read";
  }
}
