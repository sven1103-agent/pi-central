/**
 * What the sidecar will agree to do (ADR-0015 §2, §7, §8).
 *
 * This module is deliberately pure: no process, no socket, no browser. It holds the two decisions that
 * make the sidecar safe rather than merely convenient, and both are decisions a reviewer can read in one
 * screen:
 *
 *   1. **Which URLs may be opened at all.** Registered loopback dev-server origins, nothing else.
 *      `file:`, `chrome:`, `data:`, `javascript:` and any `https:` host are refused with a structured
 *      error. This is the real boundary — what was dangerous about giving an agent a browser was never the
 *      screenshot, it was a *logged-in* session with the user's cookies and network position.
 *   2. **What a verb may be asked to do.** A closed union of four verbs, none of which accepts a CDP method
 *      name, a selector-driven script, or an arbitrary expression. A verb that took one would be
 *      `browser_evaluate` in a different costume — which is precisely why the Playwright MCP server was
 *      rejected (Phase 0B: 25 tools, `browser_evaluate` callable by any client, no auth, no host-side
 *      narrowing).
 *
 * The absence of a parameter is the control. `parseVerb` returns a discriminated union, so a caller cannot
 * reach the CDP layer with anything this module did not name.

/** A refusal the model is allowed to see. Structured, so it is not mistaken for a crash. */
export interface Refusal {
  kind: "refused";
  reason:
    | "origin-not-registered"
    | "scheme-not-allowed"
    | "not-loopback"
    | "unknown-verb"
    | "bad-argument";
  /** One sentence naming what to do, not merely what failed. */
  message: string;
}

export interface AllowedTarget {
  kind: "allowed";
  url: string;
  origin: string;
}

export type TargetDecision = AllowedTarget | Refusal;

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** The loopback host spellings a dev server may legitimately answer on. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Decide whether the sidecar may open a URL.
 *
 * `registered` is the set of origins this sidecar was started for — one per session, because egress is
 * pinned to one port (ADR-0015 §5). The check is against the *parsed* origin, never a string prefix:
 * `http://localhost:4173.evil.com` starts with `http://localhost:4173` and is a different host.
 *
 * Every branch returns a `Refusal` rather than throwing, because a refusal is a normal answer the model
 * should be able to read and act on.
 */
export function decideTarget(raw: string, registered: ReadonlySet<string>): TargetDecision {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: "refused", reason: "bad-argument", message: `not a URL: ${JSON.stringify(raw)}` };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    // Named explicitly: `file:` reads the disk as the user, `chrome:` reaches the browser's own UI, and
    // `javascript:`/`data:` execute caller-supplied script in an origin we are pretending is inert.
    return {
      kind: "refused",
      reason: "scheme-not-allowed",
      message: `only http and https reach the browser; ${parsed.protocol} is refused`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(`[${host}]`)) {
    return {
      kind: "refused",
      reason: "not-loopback",
      message: `the sidecar reaches loopback only; ${host} is refused`,
    };
  }

  if (!registered.has(parsed.origin)) {
    const known = [...registered].sort().join(", ") || "(none)";
    return {
      kind: "refused",
      reason: "origin-not-registered",
      message: `this sidecar serves ${known}; ${parsed.origin} is not registered`,
    };
  }

  return { kind: "allowed", url: parsed.toString(), origin: parsed.origin };
}

/** The closed verb set. A fourth verb is a decision; a fifth needs an ADR amendment. */
export const VERB_NAMES = ["capture", "probe", "act", "info"] as const;
export type VerbName = (typeof VERB_NAMES)[number];

export interface CaptureVerb {
  kind: "capture";
  url: string;
  /** Crop to a region, which is the escalation path: the full page is the expensive default. */
  clip?: { x: number; y: number; width: number; height: number } | undefined;
  fullPage: boolean;
}

export interface ProbeVerb {
  kind: "probe";
  url: string;
  /**
   * WHICH checks to run, never how they work.
   *
   * The agent may choose from a fixed battery (ADR-0015 §3, #276 open question 2). It cannot pass a
   * selector-driven assertion, a script, or a threshold — so "broken" stays a property the sidecar
   * defines. That is the difference between a reviewer and a defendant.
   */
  checks?: readonly ProbeCheck[];
  viewport: { width: number; height: number };
}

export const PROBE_CHECKS = ["overflow", "contrast", "overlap", "console"] as const;
export type ProbeCheck = (typeof PROBE_CHECKS)[number];

export interface InfoVerb {
  kind: "info";
}

export interface ActVerb {
  kind: "act";
  url: string;
  /** The one interaction: click an element the *sidecar* located, then capture. */
  clickSelector: string;
}

export type Verb = CaptureVerb | ProbeVerb | InfoVerb | ActVerb;

export interface ParsedVerb {
  kind: "ok";
  verb: Verb;
}

/**
 * Turn an untrusted `{name, arguments}` pair into a `Verb`, or refuse it.
 *
 * The union below is exhaustive over `VERB_NAMES`, so adding a name without a case is a type error rather
 * than a runtime surprise. Note what no case accepts: a `method`, a `script`, an `expression`, a `code`, or
 * a `cdp` field. `exactKeys` rejects unknown fields instead of ignoring them, because an ignored field is
 * how a `method` reaches a dispatcher that later grows a branch for it.
 */
export function parseVerb(name: string, args: Record<string, unknown>): ParsedVerb | Refusal {
  switch (name as VerbName) {
    case "capture": {
      const bad = exactKeys(args, ["url", "clip", "fullPage"]);
      if (bad) return bad;
      const url = str(args, "url");
      if (url === undefined) return badArg("capture needs a url string");
      const clip = args["clip"] === undefined ? undefined : rect(args["clip"]);
      if (args["clip"] !== undefined && clip === undefined) return badArg("clip must be {x,y,width,height}");
      if (args["fullPage"] !== undefined && typeof args["fullPage"] !== "boolean") {
        return badArg("fullPage must be a boolean");
      }
      return { kind: "ok", verb: { kind: "capture", url, clip, fullPage: args["fullPage"] === true } };
    }
    case "probe": {
      const bad = exactKeys(args, ["url", "checks", "viewport"]);
      if (bad) return bad;
      const url = str(args, "url");
      if (url === undefined) return badArg("probe needs a url string");
      const viewport = args["viewport"] === undefined ? DEFAULT_VIEWPORT : rect(args["viewport"]);
      if (viewport === undefined) return badArg("viewport must be {width,height}");
      const checks = checksArg(args["checks"]);
      if (checks === undefined) {
        return badArg(`checks must be a subset of ${PROBE_CHECKS.join(", ")}`);
      }
      return {
        kind: "ok",
        verb: {
          kind: "probe",
          url,
          checks,
          viewport: { width: viewport.width, height: viewport.height },
        },
      };
    }
    case "act": {
      const bad = exactKeys(args, ["url", "clickSelector"]);
      if (bad) return bad;
      const url = str(args, "url");
      const clickSelector = str(args, "clickSelector");
      if (url === undefined || clickSelector === undefined) {
        return badArg("act needs a url and a clickSelector");
      }
      return { kind: "ok", verb: { kind: "act", url, clickSelector } };
    }
    case "info":
      return { kind: "ok", verb: { kind: "info" } };
    default:
      return {
        kind: "refused",
        reason: "unknown-verb",
        message: `the sidecar offers ${VERB_NAMES.join(", ")}; ${JSON.stringify(name)} is not one`,
      };
  }
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;

function rect(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const num = (key: string, fallback: number): number | undefined =>
    v[key] === undefined ? fallback : typeof v[key] === "number" && Number.isFinite(v[key]) ? (v[key] as number) : undefined;
  const x = num("x", 0);
  const y = num("y", 0);
  const width = num("width", Number.NaN);
  const height = num("height", Number.NaN);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function checksArg(value: unknown): readonly ProbeCheck[] | undefined {
  if (value === undefined) return PROBE_CHECKS;
  if (!Array.isArray(value)) return undefined;
  const out: ProbeCheck[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    if (!(PROBE_CHECKS as readonly string[]).includes(entry)) return undefined;
    out.push(entry as ProbeCheck);
  }
  return out;
}

/**
 * Reject an argument object carrying a key this verb does not name.
 *
 * Ignoring an unknown key is how a `method` or `script` field survives until somebody adds a branch for it.
 * The refusal names the offending key, because a caller sending `method` is telling us something.
 */
function exactKeys(args: Record<string, unknown>, allowed: readonly string[]): Refusal | undefined {
  for (const key of Object.keys(args)) {
    if (allowed.includes(key)) continue;
    return {
      kind: "refused",
      reason: "bad-argument",
      message: `unknown argument ${JSON.stringify(key)}; this verb accepts ${allowed.join(", ")}`,
    };
  }
  return undefined;
}

const badArg = (message: string): Refusal => ({ kind: "refused", reason: "bad-argument", message });
