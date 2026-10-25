/**
 * Pi Central's entry point (Phase 2).
 *
 * Starts the orchestrator and its transport. This process is **deliberately unsandboxed**
 * (ADR-0002): it runs at the user's UID because Seatbelt does not nest (C1), and every
 * session it spawns is confined individually.
 *
 * The one hard precondition is therefore that *this* process is not itself inside a sandbox.
 * That is checked before anything else, because the failure it prevents is not loud: every
 * session would fail to spawn with EPERM and look like a launcher bug.
 */
import { defaultConfig } from "./config.ts";
import { Supervisor } from "./supervisor.ts";
import { Transport } from "./transport.ts";
import { assertNotSandboxed, SandboxedEnvironmentError } from "./sandbox-guard.ts";

interface Options {
  port: number;
  mode: "sandboxed" | "direct";
  /** Skip the sandbox probe. Only for a host without `sandbox-exec` at all (C10). */
  allowUnsandboxedHost: boolean;
}

/**
 * The default port.
 *
 * Fixed rather than ephemeral, because the UI's dev-server proxy has to know where to connect
 * and a random port would mean every `npm run server` needed a matching `PI_CENTRAL_WS`
 * override. A tool that requires two coordinated environment variables before it shows
 * anything is a tool that appears broken on first run. `--port` still overrides, and `--port 0`
 * still asks for an ephemeral port for the tests and for running several orchestrators side by
 * side.
 */
const DEFAULT_PORT = 8787;

function parseArgs(argv: string[]): Options {
  const options: Options = { port: DEFAULT_PORT, mode: "sandboxed", allowUnsandboxedHost: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number(argv[++i]);
      // Accepts 0 explicitly: "give me any free port" is a real request, not a mistake.
      if (Number.isInteger(value) && value >= 0 && value <= 65535) options.port = value;
      else {
        console.error(`--port expects a number between 0 and 65535, got ${String(argv[i])}`);
        process.exit(2);
      }
    } else if (arg === "--direct") {
      options.mode = "direct";
    } else if (arg === "--allow-unsandboxed-host") {
      // Escape hatch for developing the UI on a non-macOS host, where Safehouse cannot run at
      // all (C10). Named explicitly so it can never be enabled by accident.
      options.allowUnsandboxedHost = true;
    }
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  // Check BEFORE binding a port or reading config, so a misinvocation is the first thing the
  // user sees rather than a confusing spawn failure minutes later.
  if (!options.allowUnsandboxedHost) {
    try {
      assertNotSandboxed();
    } catch (error) {
      if (error instanceof SandboxedEnvironmentError) {
        console.error(error.message);
        return 2;
      }
      throw error;
    }
  }

  const config = defaultConfig();
  const supervisor = new Supervisor(config);
  const transport = new Transport(supervisor, config, { port: options.port });
  transport.attach();

  const address = await transport.listen();

  // Machine-readable line first, so a launcher or dev script can parse the port without
  // scraping the human output below.
  console.log(`PI_CENTRAL_URL=${address.url}`);
  console.log(`Pi Central listening on ${address.url}`);
  console.log(`  sessions root: ${config.sessionsRoot}`);
  console.log(`  default workspace: ${config.workspaceRoot}`);
  console.log(`  agent root: ${config.agentRoot}${config.agentRootManaged ? " (managed)" : " (external)"}`);
  console.log(`  isolation: ${options.mode}`);
  console.log("");
  // The UI is a separate process, so the connection detail belongs here rather than in a
  // README the user has to find: if the UI cannot reach this port, nothing else matters.
  if (options.port !== DEFAULT_PORT) {
    console.log(
      `Non-default port. Start the UI with:\n` +
        `  PI_CENTRAL_WS=${address.url} npm run ui:dev`,
    );
    console.log("");
  } else {
    console.log(`Start the UI in another terminal:  npm run ui:dev`);
    console.log("");
  }
  console.log("Start a session from the UI. Press Ctrl-C to stop every session and exit.");

  // An orderly shutdown must close children too, or sandboxed grandchildren outlive us.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // a second Ctrl-C must not re-enter this
    shuttingDown = true;
    console.log(`\n${signal} received; stopping sessions...`);
    // The transport closes first so clients are told, rather than seeing a dead socket with
    // sessions still running behind it.
    await transport.close().catch(() => undefined);
    await supervisor.stopAll().catch(() => undefined);
    console.log("stopped.");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return 0;
}

main().then(
  (code) => {
    // `main` returning 0 means "listening and serving"; the process stays alive on the socket.
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(`Pi Central failed to start: ${(error as Error).message}`);
    process.exit(1);
  },
);
