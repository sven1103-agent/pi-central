/**
 * The UI sidecar's policy fragment (ADR-0015).
 *
 * A **sibling** of the session fragment, not a variant of it. The sidecar is not an agent: it has no
 * `agentRoot` grant and no keychain grant, because it resolves no provider key and must hold no identity
 * (ADR-0010). What it shares with a session is the *host-credential denies*, and it shares them by
 * calling `renderHostDenies()` rather than restating them.
 *
 * Why that distinction is load-bearing: the Phase 0C spike hand-wrote a four-name deny list and it
 * failed open on the fifth name — `~/.gitconfig` stayed readable while the other three were refused.
 * That is C15c, and a second hand-written list would reproduce it the first time `HOST_DENIES` changed.
 *
 * Two rules here are specific to this process, and both come from a measurement:
 *
 *   1. **Egress is pinned to ONE PORT.** `(remote ip)` rules carry no exemption for loopback, so the
 *      base profile's `(allow network-outbound (remote ip))` is denied and one port is re-allowed.
 *      `(remote ip "127.0.0.1:*")` does not even parse — `sandbox-exec` requires `*` or `localhost` — so
 *      the port, not the address, is the unit of confinement. This is why the port is an argument and
 *      not a constant: it is right for one dev server, and a fleet has more.
 *   2. **mDNSResponder is denied explicitly.** A `(remote ip)` deny filters addresses, not unix sockets,
 *      so the base profile's `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`
 *      survives it and a confined renderer could still emit attacker-visible DNS.
 *
 * The launchd-listener network deny is in the shared block, and it matters more here than for a session:
 * `SSH_AUTH_SOCK` reaches a Safehouse-spawned process by default (C4a), so the variable is not the
 * control — the connect is. A renderer that parses untrusted content must not be able to reach a
 * signing oracle.
 */
import { renderHostDenies } from "./fragment.ts";

/**
 * Denials the *renderer* needs that a session does not get, and the reason is a capability question rather
 * than a boundary one.
 *
 * The base profile grants `(home-literal "/.npmrc")`, `(home-subpath "/.cache/gh")` and
 * `(home-subpath "/.local/share/gh")`, and `HOST_DENIES` names none of them — found by the coverage
 * assertion in `sidecar-fragment.test.ts`, which asked "does any rule deny this path?" rather than "is
 * this rule present?".
 *
 * `~/.npmrc` is the sharp one: it commonly holds `//registry.example/:_authToken=…`. A renderer never runs
 * npm, so denying it costs nothing here. A **session** may legitimately need it to install from a private
 * registry, so this list is deliberately NOT in `HOST_DENIES`: closing it for sessions means provisioning
 * an agent npm token, which is an ADR-0010 decision and not a drive-by edit to a policy fragment.
 */
const RENDERER_ONLY_DENIES: string[] = [
  ";; --- Names the base profile grants and the shared denies do not cover ----------------",
  ";; A prefix, not a literal: `~/.npmrc.local` and friends are read the same way by npm.",
  "(deny file-read*",
  '    (home-prefix "/.npmrc")',
  '    (home-subpath "/.cache/gh")',
  '    (home-subpath "/.local/share/gh")',
  '    (home-subpath "/.local/state/gh")',
  ")",
  "",
];

export interface SidecarFragmentOptions {
  /**
   * The single port egress is confined to — the session's dev server.
   *
   * Required, and validated: a wrong value here is not a weaker policy, it is a policy that either
   * permits nothing (the browser cannot reach the page) or permits another process's listener.
   */
  port: number;
}

/**
 * Render the sidecar's appended fragment. Deterministic: same options, same bytes.
 *
 * @throws if `port` is not an integer in 1..65535. Failing loudly matters because the alternative is a
 *   fragment that composes, applies, and silently blocks the one thing it was written to allow.
 */
export function renderSidecarFragment(options: SidecarFragmentOptions): string {
  const { port } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`sidecar port must be an integer in 1..65535: ${JSON.stringify(port)}`);
  }

  const out: string[] = [
    ";; ---------------------------------------------------------------------------",
    ";; Pi Central — UI sidecar fragment (ADR-0015).",
    ";;",
    ";; Generated; do not edit by hand. Deterministic, so drift is diffable.",
    ";; Appended AFTER Safehouse's generated rules: SBPL is last-match-wins, so these",
    ";; denies override the base policy's broader allows.",
    ";;",
    ";; Purpose: a renderer that reaches exactly one dev server and no credential. It is",
    ";; NOT an agent — no agent root, no keychain, no identity (ADR-0010, ADR-0015 §9).",
    ";;",
    ";; Chromium runs with --no-sandbox here, because Safehouse cannot permit its nested",
    ";; Seatbelt sandbox (see `safehouse --help`). This fragment is therefore the renderer's",
    ";; ONLY confinement: there is no defence in depth behind it.",
    ";; ---------------------------------------------------------------------------",
    "",
  ];

  out.push(...renderHostDenies());
  out.push(...RENDERER_ONLY_DENIES);

  out.push(
    ";; --- Egress: one port, and nothing else -----------------------------------------",
    ";; The `(remote ip)` deny carries no loopback exemption, so one port is re-allowed",
    ";; explicitly. `localhost` is the only spelling SBPL accepts for a host; a v4",
    ";; literal is a parse error.",
    "(deny network-outbound (remote ip))",
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    "",
    ";; A deny on (remote ip) does not reach unix sockets, so name resolution survives it",
    ";; unless the resolver's own socket is denied.",
    "(deny network-outbound",
    '    (literal "/private/var/run/mDNSResponder")',
    ") ",
    "",
    ";; The renderer must not reach a browser control endpoint or a dev-server inspector",
    ";; on another listener. Port-scoped above; this is the belt to that suspender, because",
    ";; a v6 listener on [::1] is a different address from localhost's v4 answer and the",
    ";; Phase 0C measurement found the MCP transport answering on one and not the other.",
    "",
  );

  return out.join("\n");
}
