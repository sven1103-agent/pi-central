/**
 * Pi Central prototype server.
 *
 * Loopback-only HTTP + WebSocket. Serves the UI and relays RPC records.
 *
 * NOT sandboxed by design (ADR-0002/ADR-0007): it spawns the sandboxed agents,
 * and Seatbelt does not nest (C1), so a sandboxed orchestrator could not spawn
 * them at all. It is a user-level app acting for the user, at the user's UID.
 */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { Fleet, type LiveSession } from "./fleet.ts";
import { listHistorical } from "./registry.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(here, "..", "public");
const vendorDir = join(here, "..", "node_modules");
const PORT = Number(process.env.PORT ?? 4319);
const HOST = "127.0.0.1"; // ADR-0005: loopback only

const fleet = new Fleet();

/* ------------------------------------------------------------------ *
 * Sandbox self-check (C1)
 *
 * A trivial sandbox-exec apply fails with EPERM when we are already inside a
 * Seatbelt sandbox. Detecting that is worth more than a paragraph of docs: it
 * is the exact reason the orchestrator must stay outside the boundary.
 * ------------------------------------------------------------------ */
function probeInheritedSandbox(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code !== 0 && /not permitted|EPERM/i.test(err)));
  });
}

/* ------------------------------------------------------------------ *
 * Static serving
 * ------------------------------------------------------------------ */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveFile(res: import("node:http").ServerResponse, path: string): Promise<void> {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      // ADR-0006: strict CSP. No inline/eval, and no network egress from the page.
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const path = url.pathname;

  if (path === "/" || path === "/index.html") return void serveFile(res, join(publicDir, "index.html"));
  if (path === "/app.js") return void serveFile(res, join(publicDir, "app.js"));

  // Vendored UMD builds, served from node_modules so the page needs no network.
  if (path.startsWith("/vendor/")) {
    const name = path.slice("/vendor/".length).replace(/[^a-zA-Z0-9._-]/g, "");
    const map: Record<string, string> = {
      "markdown-it.min.js": join(vendorDir, "markdown-it", "dist", "browser", "markdown-it.umd.min.js"),
      "purify.min.js": join(vendorDir, "dompurify", "dist", "purify.min.js"),
    };
    const target = map[name];
    if (target) return void serveFile(res, target);
  }

  res.writeHead(404).end("not found");
});

/* ------------------------------------------------------------------ *
 * WebSocket protocol
 *
 * Envelopes are typed and direction-scoped (ARCHITECTURE.md "Data planes"):
 *   control  client -> server   (trusted: the user's intent)
 *   event    server -> client   (untrusted: model output, rendered as text)
 * ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

function broadcast(message: unknown): void {
  const text = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) client.send(text);
  }
}

let inheritedSandbox = false;

function snapshot(): unknown {
  return {
    kind: "snapshot",
    inheritedSandbox,
    sessions: fleet.list(),
    historical: listHistorical(40),
  };
}

fleet.on("update", (session: LiveSession) => broadcast({ kind: "session", session }));
fleet.on("event", (payload: unknown) => broadcast({ kind: "event", ...(payload as object) }));

/* ------------------------------------------------------------------ *
 * File navigation — plain fs at the user's UID (ADR-0007)
 *
 * Guardrails are correctness properties, not sandboxing: canonicalize with
 * realpath, then check containment. String prefix checks would fail on "..",
 * on symlinks, and on case-insensitive filesystems.
 * ------------------------------------------------------------------ */
function containedPath(root: string, candidate: string): string {
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(candidate);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error("path escapes the session working directory");
  }
  return realTarget;
}

async function handleFiles(sessionId: string, sub: string): Promise<unknown> {
  const session = fleet.get(sessionId);
  if (!session) throw new Error("unknown session");
  const target = containedPath(session.cwd, join(session.cwd, sub || "."));
  const info = await stat(target);
  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true });
    return {
      kind: "files",
      sessionId,
      path: target,
      entries: entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        .slice(0, 500),
    };
  }
  const MAX = 256 * 1024;
  if (info.size > MAX) throw new Error(`file too large (${info.size} bytes)`);
  const buf = await readFile(target);
  if (buf.subarray(0, 8192).includes(0)) throw new Error("binary file");
  return { kind: "file", sessionId, path: target, text: buf.toString("utf8") };
}

wss.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify(snapshot()));

  socket.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const action = String(msg.action ?? "");
    try {
      switch (action) {
        case "start": {
          const session = fleet.startSession({
            cwd: String(msg.cwd),
            name: msg.name ? String(msg.name) : undefined,
            mode: msg.mode === "sandboxed" ? "sandboxed" : "direct",
            enable: Array.isArray(msg.enable) ? (msg.enable as string[]) : undefined,
          });
          broadcast({ kind: "session", session });
          break;
        }
        case "stop":
          await fleet.stop(String(msg.id));
          break;
        case "prompt": {
          const rpc = fleet.rpc(String(msg.id));
          if (rpc) await rpc.send({ type: "prompt", message: String(msg.message) });
          break;
        }
        case "abort": {
          const rpc = fleet.rpc(String(msg.id));
          if (rpc) await rpc.send({ type: "abort" });
          break;
        }
        case "dialog":
          fleet.answerDialog(String(msg.id), String(msg.dialogId), (msg.answer ?? {}) as never);
          break;
        case "files":
          socket.send(JSON.stringify(await handleFiles(String(msg.id), String(msg.path ?? ""))));
          break;
        default:
          break;
      }
    } catch (err) {
      socket.send(JSON.stringify({ kind: "error", message: (err as Error).message }));
    }
  });

  socket.on("close", () => clients.delete(socket));
});

inheritedSandbox = await probeInheritedSandbox();

server.listen(PORT, HOST, () => {
  const warn = inheritedSandbox
    ? "\n  ⚠  Pi Central is itself running inside a Seatbelt sandbox.\n" +
      "     Seatbelt does not nest (C1), so SANDBOXED sessions will fail to start.\n" +
      "     Use DIRECT mode to explore the UI, or run Pi Central unsandboxed.\n"
    : "";
  console.log(`Pi Central prototype -> http://${HOST}:${PORT}${warn}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void fleet.stopAll().finally(() => process.exit(0));
  });
}
