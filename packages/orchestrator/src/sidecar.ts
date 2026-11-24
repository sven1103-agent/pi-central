/**
 * The sidecar process: four verbs over MCP streamable HTTP on loopback, behind a bearer token (ADR-0018 §12).
 *
 * ## Why HTTP and not stdio
 *
 * A stdio server is spawned by Pi, so it lands inside the session's sandbox — a child, not a sibling, which C1
 * forbids. HTTP lets the orchestrator own the process and Pi merely connect. The price is a listening socket
 * that every session can reach, so the token is the access control (C5), not hygiene. The token arrives in
 * the environment (`PI_CENTRAL_SIDECAR_TOKEN`), never on the command line.
 *
 * ## What this process will not do
 *
 * It reads no argument that names a CDP method, a script, an expression, a filesystem path, or a file name.
 * `sidecar-control.ts` enforces the shape and is the only place a request is interpreted; this file is the
 * transport and the lifecycle, and it holds no policy of its own. That split is deliberate: the policy is
 * testable without a browser, and the transport is testable without a policy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CdpPage } from "./sidecar-cdp-pipe.ts";
import { decideTarget, parseVerb, PROBE_CHECKS, VERB_NAMES, type Refusal } from "./sidecar-control.ts";
import { launchBrowser } from "./sidecar-browser.ts";

export interface SidecarConfig {
  /** The Chrome executable. Fixed at spawn time. */
  executable: string;
  /** The sidecar's profile directory (private; the orchestrator refuses a shared temp root). */
  profileDir: string;
  /**
   * The bearer token every request must present.
   *
   * Load-bearing, not hygiene: loopback is reachable by every local process (C5), so this is the only thing that
   * distinguishes the session that owns this sidecar from any other process on the machine.
   */
  token: string;
  /** The port to listen on; 0 asks the OS, and the chosen port is printed on stderr. */
  port: number;
  /**
   * The one origin this sidecar serves.
   *
   * An input, never a constant: egress is pinned to a single port (ADR-0018 §6), so a sidecar is correct
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
        "Screenshot the registered dev server. Returns the PNG as an image content block, first in `content`, " +
        "followed by a one-line caption. Writes no file. From a codemode script the image reaches you only if " +
        "the script shows it: `image(result.content[0])`; printing the text alone discards the picture. " +
        "Call the typed function `mcp__pi_central_sidecar__capture({ url })`: the `mcp({ tool })` proxy and the " +
        "`mcp__pi_central_sidecar({ tool })` namespace form return only the caption as a string. " +
        "Prefer `probe` first: a screenshot costs thousands of tokens.",
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
      description:
        "Click one element by CSS selector, then leave the page as it is. The page persists between verbs, " +
        "so the next `probe` or `capture` on the same url shows the state after the click, and a second " +
        "`act` adds to the first rather than reloading it.",
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
): Promise<{ content: ToolContent[]; isError?: boolean }> {
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
  /**
   * One page for the sidecar's life, so a verb's `url` means **"be at this address"**, not
   * "start over".
   *
   * This is the difference between an interaction and a screenshot. Navigating unconditionally left every
   * click on a document that no longer existed: on a page counting loads in `sessionStorage` and clicks in
   * memory, `capture` → `act` → `capture` produced 3 loads and 0 surviving clicks, and a dialog opened with
   * `act` was absent from the next screenshot (issue #288).
   *
   * The comparison is on parsed URLs and lives in the driver, so a trailing slash cannot cause a reload.
   */
  if (!(await session.isAt(target.url))) await session.navigate(target.url, 15_000);

  if (verb.kind === "capture") {
    const shot = await session.capture(verb.clip, verb.fullPage);
    /**
     * An MCP IMAGE content block, not a base64 string in a text block.
     *
     * The difference is the whole user-visible feature. Pi forwards an image block as an image
     * (`image(result.content[0])` reaches the model as an image, per its MCP documentation), so the picture
     * arrives inline in the transcript. Wrapping the same bytes in `data:image/png;base64,…` inside a TEXT
     * block would make the model read a wall of base64 and would render as nothing at all to the user —
     * thousands of tokens spent on a string nobody can see.
     *
     * Still bytes, still no path: the sidecar writes nothing and names no file (ADR-0018 §9). What changes is
     * the TYPE of the block, which is what decides whether a human ends up looking at the picture.
     */
    return {
      content: [
        { type: "image", data: shot.data, mimeType: "image/png" },
        { type: "text", text: "captured the viewport at 1280x800" },
      ],
    };
  }

  if (verb.kind === "probe") {
    const verdict = await session.probe(verb.checks ?? PROBE_CHECKS);
    return text(JSON.stringify(verdict, null, 2));
  }

  await session.click(verb.clickSelector);
  return text(`clicked ${JSON.stringify(verb.clickSelector)}`);
}

/**
 * A block in an MCP `CallToolResult`.
 *
 * `image` is a first-class type in the protocol, and Pi forwards it as an image rather than as text — which is
 * the difference between a picture in the transcript and a wall of base64 nobody can read.
 */
type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
      browser = launchBrowser({
        executable: config.executable,
        profileDir: config.profileDir,
        onLog: (line) => process.stderr.write(`[browser] ${line}\n`),
      });
    }
    // The child's fd 3/4, not a URL: the control channel is a pipe, so there is no port for the sidecar's own
    // egress rule to deny (measured — that is exactly how the WebSocket transport failed under the policy).
    session = await CdpPage.open({ child: browser.child });
    return session;
  };

  const shutdown = async (): Promise<void> => {
    await session?.close().catch(() => undefined);
    await browser?.stop().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  // The lifetime mechanism (ADR-0018 §11): stdin closing means the orchestrator is gone.
  process.stdin.once("end", () => void shutdown().then(() => process.exit(0)));

  /**
   * One MCP message in, one result out — no transport knowledge.
   *
   * Separate from both carriers on purpose: the protocol handling is identical over stdio and over HTTP, and it
   * is the part with the security decisions (`handleRequest` owns the verb set and the URL policy). Keeping it
   * out of the transport is what let the transport change without touching the policy.
   */
  const dispatch = async (
    message: { id?: number | string; method?: string; params?: Record<string, unknown> },
  ): Promise<{ reply?: unknown; notification?: boolean }> => {
    if (message.method === "initialize") {
      return {
        reply: {
          protocolVersion: (message.params?.["protocolVersion"] as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "pi-central-sidecar", version: "0" },
        },
      };
    }
    if (message.method === "tools/list") {
      return { reply: { tools: toolDefinitions() } };
    }
    if (message.method === "tools/call") {
      const params = message.params ?? {};
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      try {
        return { reply: await handleRequest(config, page, name, args) };
      } catch (error) {
        return {
          reply: {
            content: [{ type: "text", text: `sidecar error: ${(error as Error).message}` }],
            isError: true,
          },
        };
      }
    }
    // Notifications carry no id and expect no reply.
    if (message.id === undefined) return { notification: true };
    return { reply: {} };
  };

  /**
   * MCP over streamable HTTP on loopback (ADR-0018 §1, amended).
   *
   * **Why not stdio, which was built first and is gone.** A stdio MCP server is spawned BY PI, so it inherits
   * the session's sandbox: it becomes a child of the session rather than a sibling, which is the one
   * arrangement ADR-0018 forbids and C1 makes impossible. Measured: it failed with `Path does not exist`,
   * which is what a DENIED stat looks like — the reader-side processes cannot see their own policy, profile
   * or code from inside the session.
   *
   * HTTP puts the process where the design always said it goes: the orchestrator spawns it as a sibling, and
   * Pi merely connects. The cost is that a loopback endpoint is reachable by every session, so the bearer
   * token below is load-bearing rather than hygiene. That is an honest trade, stated rather than hidden.
   */
  const server = createServer((request, response) => void onRequest(request, response));

  const onRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }

    /**
     * The token is checked on EVERY request, including `initialize`.
     *
     * Loopback is not a boundary (C5): any local process can connect, so the token is the only thing
     * distinguishing the session that owns this sidecar from any other. A missing or wrong token gets 401 with
     * no detail, because naming which part was wrong helps only an attacker.
     */
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${config.token}`) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized\n");
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "text/plain", allow: "POST" });
      response.end("this endpoint accepts POST only\n");
      return;
    }

    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      // A bounded body: the verbs take small arguments, and an unbounded read is a memory hole.
      if (body.length > 1_000_000) {
        response.writeHead(413, { "content-type": "text/plain" });
        response.end("request too large\n");
        return;
      }
    }

    let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }

    let outcome: { reply?: unknown; notification?: boolean };
    try {
      outcome = await dispatch(message);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: (error as Error).message },
        }),
      );
      return;
    }

    if (outcome.notification === true) {
      response.writeHead(202);
      response.end();
      return;
    }
    // `application/json` rather than an SSE stream: this transport answers one request with one result, and
    // pretending to stream would make the client wait for an end that never comes.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: outcome.reply }));
  };

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(config.port, "127.0.0.1", () => done());
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : config.port;
  // Printed so the orchestrator can log the real port when it asked for 0. On stderr: stdout is not a channel
  // here any more, and a line on the wrong stream would be invisible.
  process.stderr.write(`sidecar listening on 127.0.0.1:${bound} origin=${config.origin}\n`);

  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  // The lifetime mechanism (ADR-0018 §11): the orchestrator holds our stdin, and closing it means it is gone.
  process.stdin.once("end", () => void shutdown().then(() => process.exit(0)));
  process.stdin.resume();
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
  // The FLAG wins, and the variable is the fallback. That order is load-bearing, not stylistic.
  //
  // The orchestrator both sets the variable and forwards it with `--env-pass`, so in production the two agree. If
  // the variable won, then any process able to influence the sidecar's environment could substitute the token and
  // have the orchestrator's own config point at a sidecar opened by someone else — and it would look like a
  // working session. A measured test asserts the launch token is the accepted one with a conflicting variable set.
  const token = arg("token") ?? process.env["PI_CENTRAL_SIDECAR_TOKEN"];
  const port = Number(arg("port") ?? "0");
  if (executable === undefined || profileDir === undefined || origin === undefined || token === undefined) {
    process.stderr.write(
      "usage: pi-central-sidecar --executable <chrome> --profile <dir> --origin <http://localhost:PORT> " +
        "--token <secret> [--port N]\n",
    );
    process.exit(2);
  }
  await serve({ executable, profileDir, origin, token, port });
}
