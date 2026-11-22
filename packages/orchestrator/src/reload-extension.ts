/**
 * Pi Central's one extension: the `/reload` a subprocess client cannot otherwise reach (issue #274).
 *
 * ## Why an extension exists at all
 *
 * Pi's RPC surface has no reload command. The capability is real — `ctx.reload()` re-reads extensions,
 * skills, prompt templates, themes, MCP servers and context files, and applies tools newly added to
 * `defaultTools` — but its only entry point is `/reload`, a **built-in TUI command**, and Pi excludes
 * built-ins from `get_commands` because they "are handled only in interactive mode and would not execute
 * if sent via `prompt`" (Pi's `rpc-commands.md`). Sending the text `/reload` therefore reaches the MODEL
 * as a user message.
 *
 * Extension commands ARE in `get_commands` and ARE runnable through `prompt` with a `/` prefix, so an
 * extension-registered command is the one route to `ctx.reload()` a subprocess client can take today. The
 * clean alternative — an RPC `reload` command upstream — is recorded in ADR-0015 as where this should end
 * up; it does not exist, so it cannot be the mechanism now.
 *
 * ## What this file is, and what it deliberately is not
 *
 * A STRING, not a file copied from the checkout at spawn time. Three reasons:
 *
 *   1. It must work from the published bundle, where there is no source tree to copy a `.ts` file from
 *      (`scripts/build-package.mjs` ships `bin/pi-central.js` and `dist/ui`, nothing else).
 *   2. It is provisioned into the AGENT directory (`<agentDir>/pi-central/extensions/`), which
 *      `~/.pi`'s own auto-discovery does not scan, so the reader's extensions and Pi Central's cannot
 *      collide by name or be mistaken for each other.
 *   3. Its text is checkable: `reload-extension.test.ts` asserts it registers exactly one command and
 *      calls `ctx.reload()`, so "the button works" is a property of the artifact rather than of a deploy.
 *
 * Plain JavaScript with no imports on purpose. Pi loads extensions with a TypeScript-aware loader, but a
 * `.js` file with no imports cannot fail to resolve a package that is not installed next to it — and this
 * file is installed next to nothing.
 *
 * ## The trust boundary this crosses (docs/SECURITY.md)
 *
 * An extension runs in the Pi process with the same OS permissions as Pi. Provisioning one is therefore a
 * trust decision, not a convenience: Pi Central writes a file that will be executed inside every session.
 * That is why the file is a constant here rather than anything derived from a prompt, a session, or the
 * working directory, and why the command NAME is namespaced: a session that already has a `/reload`
 * command of its own keeps it, because Pi Central never overrides an existing command.
 */

/** The command name, namespaced so it cannot shadow a reader's own `/reload`. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RELOAD_COMMAND = "pi-central:reload";

/** Where the extension is installed, relative to the Pi agent directory. */
export function reloadExtensionRelPath(): string {
  return "pi-central/extensions/reload.js";
}

/**
 * Write the extension into `agentDir`, and return its absolute path — or `undefined` when it cannot be written.
 *
 * ## Why the failure is `undefined` rather than a throw
 *
 * An agent directory can be owned by the reader (`external` ownership, ADR-0010 §5), and Pi Central must never
 * write into a tree it does not own. So provisioning is best-effort: when it fails, the session still starts and
 * the reload control reports that Pi Central's command is not loaded (the `disposition` check in
 * `Supervisor#reload`), which is a stated limitation rather than a session that will not launch.
 *
 * `mkdirSync` 0700 and `writeFileSync` 0600, because this file is executed inside the session: a directory another
 * user could write into would be a way to run code in it, which is the one thing a provisioning step must not
 * become. The content is rewritten on every launch so an upgraded Pi Central cannot leave an older copy behind.
 */
export function provisionReloadExtension(agentDir: string): string | undefined {
  const file = join(agentDir, reloadExtensionRelPath());
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, reloadExtensionSource(), { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * The extension source.
 *
 * `await ctx.reload(); return;` — the return is not tidiness. Pi's own documentation is explicit that code
 * after `await ctx.reload()` still runs from the PRE-reload version and must not assume the old extension
 * state is valid, so the handler is terminal by construction.
 */
export function reloadExtensionSource(): string {
  return `/**
 * Pi Central — reload command. Provisioned by Pi Central; regenerated on every launch and safe to delete
 * (it comes back). One command, one call: see ADR-0015.
 */
export default function (pi) {
  pi.registerCommand("${RELOAD_COMMAND}", {
    description: "Reload extensions, skills, prompt templates, themes, MCP servers and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });
}
`;
}
