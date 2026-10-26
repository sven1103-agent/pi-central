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
import { hasBuiltUi, resolveUiDistDir } from "./static-ui.ts";
import { findOwnPackage, PACKAGE_NAME } from "./package-meta.ts";

interface Options {
  port: number;
  mode: "sandboxed" | "direct";
  /** Skip the sandbox probe. Only for a host without `sandbox-exec` at all (C10). */
  allowUnsandboxedHost: boolean;
  /** The built UI to serve, or `null` to serve the socket only (issue #24). */
  uiDir: string | null;
  /** `--version`: print and exit, without binding a port or touching config. */
  showVersion: boolean;
  /** `--help`: print and exit, likewise. */
  showHelp: boolean;
}

/**
 * The installed version, read from the shipped `package.json`.
 *
 * Never a constant: `--version` must report the version that was actually published, and the whole
 * point of asking is to establish which artifact is running. A restated number could be wrong, and a
 * wrong answer here poisons every bug report that follows it. `findOwnPackage` resolves the package
 * by NAME rather than taking the nearest `package.json`, so running from source does not report
 * `@pi-central/orchestrator`'s version by accident (see `package-meta.ts`).
 */
function versionLine(): string {
  const own = findOwnPackage();
  if (own === undefined) return `${PACKAGE_NAME} (version unknown: no package.json found)`;
  return `${own.name} ${own.version}`;
}

/** What `--help` prints. Deliberately the flags that exist, and nothing aspirational. */
function printHelp(): void {
  console.log(`${versionLine()}\n
Usage: ${PACKAGE_NAME} [options]

Options:
  --port <n>                 Port to listen on (default 8787; 0 asks for any free one)
  --direct                   Start sessions WITHOUT the sandbox (feasibility only)
  --ui-dist <dir>            Serve a built UI from this directory
  --no-ui                    Serve the socket only (use with a dev server)
  --allow-unsandboxed-host   Skip the sandbox probe, for a host with no sandbox-exec (C10)
  --version, -v              Print the version and exit
  --help, -h                 Print this and exit

Pi Central starts sessions with \`pi\` under Agent Safehouse. Run it from a PLAIN terminal:
Seatbelt does not nest, so a sandboxed shell cannot start a sandboxed session (C1).`);
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
  const options: Options = {
    port: DEFAULT_PORT,
    mode: "sandboxed",
    allowUnsandboxedHost: false,
    uiDir: resolveUiDistDir(),
    showVersion: false,
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      options.showVersion = true;
    } else if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
    } else if (arg === "--port") {
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
    } else if (arg === "--ui-dist") {
      const value = argv[++i];
      if (value === undefined || value === "") {
        console.error("--ui-dist expects a directory containing a built UI");
        process.exit(2);
      }
      options.uiDir = value;
    } else if (arg === "--no-ui") {
      // Serve the socket only. Useful when a Vite dev server owns the UI, and when running a
      // second orchestrator beside one that already serves it.
      options.uiDir = null;
    }
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  // Answered before the sandbox probe and before any config is read. `--version` must work in a
  // sandbox, on a host with no Safehouse, and with no home directory — it is the question someone
  // asks when something is already wrong, so it must not be able to fail for the same reason.
  if (options.showVersion) {
    console.log(versionLine());
    return 0;
  }
  if (options.showHelp) {
    printHelp();
    return 0;
  }

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
  const transport = new Transport(supervisor, config, { port: options.port, uiDir: options.uiDir });
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
  // Where Pi Central thinks its own installation is (issue #25). Printed because the per-session
  // warning is SILENT when the path cannot be identified — and "no warning appeared" would otherwise
  // be indistinguishable from "the warning is broken". Saying it once, here, makes the difference
  // between an unidentifiable path and a safe one visible.
  if (config.installationRoot === undefined) {
    console.log(
      `Self-hosting check: could not identify this installation's own directory, so sessions are\n` +
        `  not warned when they point at it. Point a session at a checkout of Pi Central and you may\n` +
        `  still hit the problems in docs/DOGFOODING.md.`,
    );
  } else {
    console.log(`Self-hosting check: this installation is ${config.installationRoot}`);
  }
  console.log("");
  // The UI is served from this same origin (issue #24), so the dashboard needs no second process
  // and no dev server. If it has not been built, say so ONCE here — naming the fix — rather than
  // letting every request answer with the same message.
  const httpUrl = address.url.replace(/^ws/, "http");
  if (options.uiDir === null) {
    console.log(`UI: not served (--no-ui). Use a dev server, or drop the flag to serve a build.`);
  } else if (hasBuiltUi(options.uiDir)) {
    console.log(`Open ${httpUrl} — the UI is served from ${options.uiDir}`);
  } else {
    console.log(
      `No built UI at ${options.uiDir}\n` +
        `  Build it with:  npm run ui:build\n` +
        `  Or serve the socket only with:  --no-ui  (and run npm run ui:dev)`,
    );
  }
  console.log("");
  // The connection detail belongs here rather than in a README the user has to find: if the UI
  // cannot reach this port, nothing else matters. With a served build there is nothing to start —
  // which is the point of issue #24 — so the advice is only printed when a dev server is actually
  // the way to get a UI.
  if (options.uiDir !== null && hasBuiltUi(options.uiDir)) {
    console.log(`Start a session from the UI at ${httpUrl}. Press Ctrl-C to stop every session and exit.`);
  } else if (options.port !== DEFAULT_PORT) {
    console.log(`Non-default port. Start the dev UI with:\n  PI_CENTRAL_WS=${address.url} npm run ui:dev`);
    console.log("");
    console.log("Start a session from the UI. Press Ctrl-C to stop every session and exit.");
  } else {
    console.log(`Start the dev UI in another terminal:  npm run ui:dev`);
    console.log("");
    console.log("Start a session from the UI. Press Ctrl-C to stop every session and exit.");
  }

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
