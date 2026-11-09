/**
 * Types for `scripts/app-build/rules.mjs` (issue #218).
 *
 * The rules are plain JavaScript because the build script runs under `node` rather than through the TypeScript build, and a
 * `.mjs` gives no types to the test that imports it. This file is the contract both sides share: the app's test asserts
 * these shapes, and the build script calls them.
 *
 * Kept hand-written and small on purpose. Generating it would tie the build script to the TypeScript build, which is the
 * dependency this split exists to avoid.
 */

export type SigningChoice =
  | { kind: "identity"; identity: string; reason: string }
  | { kind: "adhoc"; reason: string; caveat: string };

export interface BundleIdentity {
  id: string;
  version: string;
}

export const FORBIDDEN_CONFIG_KEYS: readonly string[];
export const FORBIDDEN_DEPENDENCIES: readonly string[];
export const GATEKEEPER_BYPASS_PATTERNS: readonly RegExp[];
export const UNINSTALL_LEFTOVERS: readonly string[];

export function buildConfig(paths: {
  electronVersion: string;
  electronDist: string;
  output: string;
  iconPath: string;
}): Record<string, unknown>;

export function configProblems(config: Record<string, unknown>): string[];

export function chooseSigning(identity: string | undefined, available: readonly string[]): SigningChoice;

export function signArguments(item: string, choice: SigningChoice): string[];

export function signingOrder(appPath: string, existing: (path: string) => boolean): string[];

export function helperApps(appPath: string, existing: (path: string) => boolean): string[];

export function setDirectoryLister(fn: (path: string) => string[]): void;

export function bundleProblems(resources: readonly string[]): string[];

export function identityProblems(identity: BundleIdentity, expectedVersion: string): string[];

export function iconProblems(
  bundle: { iconFile?: string | undefined; iconSha?: string | undefined },
  electronSha: string,
): string[];

export function gatekeeperAdviceProblems(document: string): string[];

export function installPath(home: string): string;

export function destinationDecision(
  existing: { exists: boolean; identifier?: string | undefined },
  ourIdentifier: string,
): { action: "install" | "replace" | "refuse"; reason: string };

export function requiresAdmin(path: string): boolean;
