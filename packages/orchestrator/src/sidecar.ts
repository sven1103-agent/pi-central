/**
 * The sidecar process: four verbs over MCP stdio (ADR-0015).
 *
 * ## Why stdio and not the HTTP transport
 *
 * MCP over stdio is the only transport with no listening socket — so there is no port for another session
 * to find, and no bearer token to protect one with. The orchestrator already spawns this process under the
 * sidecar's Safehouse profile, so the confinement is the profile and the transport is a pipe the kernel
 * made. The alternative (HTTP + token) was measured to be a shared surface: Playwright's own server
 * answered any client with no auth at all (Phase 0B).
 *
 * ## What this process will not do
 *
 * It reads no argument that names a CDP method, a script, an expression, a filesystem path, or a file name.
 * `sidecar-control.ts` enforces the shape and is the only place a request is interpreted; this file is the
 * transport and the lifecycle, and it holds no policy of its own. That split is deliberate: the policy is
 * testable without a browser, and the transport is testable without a policy.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { CdpPage } from "./sidecar-cdp.ts";
import { decideTarget, parseVerb, PROBE_CHECKS, VERB_NAMES, type Refusal } from "./sidecar-control.ts";
import { launchBrowser } from "./sidecar-browser.ts";

export interface SidecarConfig {
  /** The Chrome executable. Fixed at spawn time. */
  executable: string;
  /** The sidecar's profile directory (private; the orchestrator refuses a shared temp root). */
  profileDir: string;
  /**
   * The one origin this sidecar serves.
   *
   * An input, never a constant: egress is pinned to a single port (ADR-0015 §6), so a sidecar is correct
   * for exactly one dev server.
   */
  origin: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The tool list Pi sees. Four entries, matching `VERB_NAMES` exactly.
 *
 * The schemas advertise a closed set — `checks` is an enum, not free text — so a model that reads them
 * learns the shape of the capability rather than discovering it by refusal.
 */
export function toolDefinitions(): ToolDefinition[] {
  const url = { type: "string", description: "A URL on the one loopback origin this sidecar serves." };
  return [
    {
      name: "capture",
      description:
        "Screenshot the registered dev server and return PNG bytes as base64. Writes no file. Prefer " +
        "`probe` first: a screenshot costs thousands of tokens.",
      inputSchema: {
        type: "object",
        properties: {
          url,
          clip: {
            type: "object",
            description: "Optional region to capture instead of the viewport.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["width", "height"],
          },
          fullPage: { type: "boolean", description: "Capture beyond the viewport. Default false." },
        },
        required: ["url"],
      },
    },
    {
      name: "probe",
      description:
        "Measure the page and return a compact JSON verdict: overflow, contrast, overlap, console errors. " +
        "Cheaper than a screenshot and usually enough to tell whether the layout is broken.",
      inputSchema: {
        type: "object",
        properties: {
          url,
          checks: {
            type: "array",
            description: "Which fixed checks to run. Omit for all of them.",
            items: { type: "string", enum: [...PROBE_CHECKS] },
          },
          viewport: {
            type: "object",
            properties: { width: { type: "number" }, height: { type: "number" } },
            required: ["width", "height"],
          },
        },
        required: ["url"],
      },
    },
    {
      name: "act",
      description: "Click one element by CSS selector, then leave the page as it is.",
      inputSchema: {
        type: "object",
        properties: {
          url,
          clickSelector: { type: "string", description: "A CSS selector, for example the id selector for a save button." },
        },
        required: ["url", "clickSelector"],
      },
    },
    {
      name: "info",
      description: "Describe this sidecar: the origin it serves, the checks it offers, and its state.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

/**
 * Answer one request. Split out from the transport so it can be tested without a pipe or a browser.
 *
 * `page` is a thunk because `info` must answer without launching anything — a sidecar that starts a browser
 * to say "I serve localhost:4173" would spend 300 ms and 200 MB to report a constant.
 */
export async function handleRequest(
  config: SidecarConfig,
  page: () => Promise<CdpPage>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const parsed = parseVerb(name, args);
  if (parsed.kind === "refused") return refusal(parsed);
  const verb = parsed.verb;

  if (verb.kind === "info") {
    return text(
      JSON.stringify(
        {
          origin: config.origin,
          verbs: VERB_NAMES,
          checks: PROBE_CHECKS,
          browser: "launched on first use",
        },
        null,
        2,
      ),
    );
  }

  // Everything below reaches the browser, so the target is decided first. A refusal never launches one.
  const target = decideTarget(verb.url, new Set([config.origin]));
  if (target.kind === "refused") return refusal(target);

  const session = await page();
  await session.setViewport(verb.kind === "probe" ? verb.viewport : { width: 1280, height: 800 });
  await session.navigate(target.url, 15_000);

  if (verb.kind === "capture") {
    const shot = await session.capture(verb.clip, verb.fullPage);
    // Bytes out, no path: the CALLER decides where they go (ADR-0015 §9). The sidecar has no write surface.
    return text(`data:image/png;base64,${shot.data}`);
  }

  if (verb.kind === "probe") {
    const verdict = await session.probe(verb.checks ?? PROBE_CHECKS);
    return text(JSON.stringify(verdict, null, 2));
  }

  await session.click(verb.clickSelector);
  return text(`clicked ${JSON.stringify(verb.clickSelector)}`);
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

const refusal = (refusal: Refusal) => ({
  content: [{ type: "text" as const, text: JSON.stringify(refusal) }],
  isError: false,
});

/**
 * Read JSON-RPC lines from stdin, answer on stdout (C7: LF-only framing, never `readline` for protocol).
 *
 * `readline` is used here, and the distinction matters: C7 forbids it for parsing Pi's own session framing,
 * where `U+2028` inside a JSON string would split a record. On this pipe both ends are ours and the only
 * writer is `JSON.stringify`, which never emits a raw line separator. Changing the transport means revisiting
 * that, so it is stated rather than left as an inconsistency.
 */
export async function serve(config: SidecarConfig): Promise<void> {
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let session: CdpPage | undefined;

  const page = async (): Promise<CdpPage> => {
    if (session !== undefined) return session;
    if (browser === undefined) {
      browser = await launchBrowser({
        executable: config.executable,
        profileDir: config.profileDir,
        onLog: (line) => process.stderr.write(`[browser] ${line}\n`),
      });
    }
    session = await CdpPage.open({ url: browser.cdpUrl });
    return session;
  };

  const shutdown = async (): Promise<void> => {
    await session?.close().catch(() => undefined);
    await browser?.stop().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  // The lifetime mechanism (ADR-0015 §11): stdin closing means the orchestrator is gone.
  process.stdin.once("end", () => void shutdown().then(() => process.exit(0)));

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const id = message.id;
    const reply = (result: unknown) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

    if (message.method === "initialize") {
      reply({
        protocolVersion: (message.params?.["protocolVersion"] as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pi-central-sidecar", version: "0" },
      });
      continue;
    }
    if (message.method === "tools/list") {
      reply({ tools: toolDefinitions() });
      continue;
    }
    if (message.method === "tools/call") {
      const params = message.params ?? {};
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      try {
        reply(await handleRequest(config, page, name, args));
      } catch (error) {
        reply({
          content: [{ type: "text", text: `sidecar error: ${(error as Error).message}` }],
          isError: true,
        });
      }
      continue;
    }
    if (id !== undefined) reply({});
  }
  await shutdown();
}

// --- entry point ---------------------------------------------------------------------------
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) {
  const arg = (name: string): string | undefined => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const executable = arg("executable");
  const profileDir = arg("profile");
  const origin = arg("origin");
  if (executable === undefined || profileDir === undefined || origin === undefined) {
    process.stderr.write(
      "usage: sidecar.ts --executable <chrome> --profile <dir> --origin <http://localhost:PORT>\n",
    );
    process.exit(2);
  }
  await serve({ executable, profileDir, origin });
}
