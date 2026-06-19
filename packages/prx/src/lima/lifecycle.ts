/**
 * Generic in-VM daemon lifecycle on Lima (GH-228, slice 4a).
 *
 * The daemon-agnostic deploy → start → stop orchestration, extracted from the
 * keeperd lifecycle (GH-201): cross-compiled Linux prx is copied into the VM,
 * then run detached on a unix socket via its `<daemon> serve` subcommand, with
 * the socket-readiness poll as the success signal. keeperd
 * ({@link ../keeperd/lima-keeperd}) and beadsd ({@link ../beadsd/lima}) both
 * drive their daemon through this one orchestration — a {@link DaemonSpec} names
 * the daemon (its `serve` subcommand + the `/tmp/<name>.*` defaults), and an
 * optional shell env-prefix injects per-daemon secrets (keeper's provenance key)
 * without leaking them into argv.
 *
 * A future `prx lima` enumerates these specs to bring the VM's daemons up/down
 * from one place. All process effects route through the {@link ../door/lima-exec}
 * seam (→ `@bounded-systems/proc`), so the orchestration is unit-tested offline;
 * the live path runs against a real VM.
 */

import { spawnRun, type Run, type RunResult } from "../door/lima-exec.ts";

const DEFAULT_VM_BIN = "/tmp/prx";
const POLL_MS = 50;

/** Identifies a daemon to the generic lifecycle: its name + its in-VM `serve` argv. */
export interface DaemonSpec {
  /** Daemon name, e.g. `keeperd` / `beadsd` — names it in errors + default `/tmp/<name>.*` paths. */
  name: string;
  /** The prx subcommand argv that runs the daemon in-VM, e.g. `["keeper", "serve"]`. */
  serveCommand: readonly string[];
}

/** Injected effects (default to real process); tests stub them offline. */
export interface DaemonLifecycleDeps {
  run?: Run | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DeployDaemonOptions {
  /** Lima instance name. */
  vm: string;
  /** Host path of the (Linux) prx binary — see `prx-compile --target`. */
  binaryPath: string;
  /** Absolute destination path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
}

export interface StartDaemonOptions {
  /** Lima instance name. */
  vm: string;
  /** Absolute prx path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
  /** Absolute unix socket the daemon binds INSIDE the VM (default `/tmp/<name>.sock`). */
  socket?: string | undefined;
  /** The repo clone (cwd) the daemon runs against. */
  cwd: string;
  /** Absolute daemon log path in the VM (default `/tmp/<name>.log`). */
  logPath?: string | undefined;
  /** Absolute pidfile the daemon writes its own pid to (default `/tmp/<name>.pid`). */
  pidfile?: string | undefined;
  /**
   * Shell env-assignment prefix injected immediately before `setsid nohup` (e.g.
   * `PRX_PROVENANCE_KEY="$(cat <file>)" `). Kept out of argv so a secret never
   * appears in the process list. Empty/undefined ⇒ a bare launch.
   */
  envPrefix?: string | undefined;
  /** Max ms to wait for the socket to appear (default 5000). */
  readyTimeoutMs?: number | undefined;
}

export interface StopDaemonOptions {
  vm: string;
  socket?: string | undefined;
  logPath?: string | undefined;
  pidfile?: string | undefined;
}

/** A running daemon handle. */
export interface DaemonHandle {
  /** Absolute socket path inside the VM (forward it with the Lima channel). */
  readonly socket: string;
  /** Stop the daemon and remove its socket/log/pidfile (best-effort). */
  stop(): Promise<void>;
}

/** Default in-VM paths for a daemon, derived from its name. */
function daemonPaths(name: string): { socket: string; logPath: string; pidfile: string } {
  return { socket: `/tmp/${name}.sock`, logPath: `/tmp/${name}.log`, pidfile: `/tmp/${name}.pid` };
}

/** True iff a daemon's unix socket exists in the VM — a liveness probe (`test -S`). */
export function isDaemonSocketUp(
  vm: string,
  socket: string,
  deps: DaemonLifecycleDeps = {},
): boolean {
  const run = deps.run ?? spawnRun;
  return run("limactl", ["shell", "--workdir", "/", vm, "--", "test", "-S", socket]).status === 0;
}

/** `limactl shell` argv that runs `script` via `sh -c` at a stable workdir. */
function limaShell(vm: string, script: string): string[] {
  return ["shell", "--workdir", "/", vm, "--", "sh", "-c", script];
}

function requireOk(res: RunResult, what: string): void {
  if (res.status !== 0) {
    throw new Error(`${what} failed (${res.status}): ${res.stderr.trim()}`);
  }
}

/** Copy a (Linux) prx binary into the VM and make it executable. Returns its VM path. */
export function deployDaemonBinary(
  opts: DeployDaemonOptions,
  deps: DaemonLifecycleDeps = {},
): string {
  const run = deps.run ?? spawnRun;
  const vmBinPath = opts.vmBinPath ?? DEFAULT_VM_BIN;
  requireOk(
    run("limactl", ["copy", opts.binaryPath, `${opts.vm}:${vmBinPath}`]),
    `limactl copy → ${opts.vm}`,
  );
  requireOk(
    run("limactl", ["shell", "--workdir", "/", opts.vm, "--", "chmod", "+x", vmBinPath]),
    "chmod +x in VM",
  );
  return vmBinPath;
}

/**
 * Start a daemon detached in the VM on a unix socket, bound to a repo clone, and
 * wait until the socket exists. The daemon writes its OWN `--pidfile` (GH-223),
 * so a stale instance is cleared with `kill "$(cat <pidfile>)"` — not `pkill -f`
 * (which would also match the controlling `sh -c` over `limactl shell`).
 * `setsid nohup … </dev/null &` fully detaches the daemon. Backgrounding over
 * `limactl shell` (ssh) returns a non-zero exit even on success, so the launch
 * exit is IGNORED and the socket-readiness poll is the sole success signal.
 */
export async function startDaemon(
  spec: DaemonSpec,
  opts: StartDaemonOptions,
  deps: DaemonLifecycleDeps = {},
): Promise<DaemonHandle> {
  const run = deps.run ?? spawnRun;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const def = daemonPaths(spec.name);
  const vmBinPath = opts.vmBinPath ?? DEFAULT_VM_BIN;
  const socket = opts.socket ?? def.socket;
  const logPath = opts.logPath ?? def.logPath;
  const pidfile = opts.pidfile ?? def.pidfile;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5000;
  const serve = spec.serveCommand.join(" ");

  const launch =
    `OLD="$(cat ${pidfile} 2>/dev/null)"; [ -n "$OLD" ] && kill "$OLD" 2>/dev/null; ` +
    `rm -f ${socket} ${logPath} ${pidfile}; ` +
    `${opts.envPrefix ?? ""}setsid nohup ${vmBinPath} ${serve} --socket ${socket} --cwd ${opts.cwd} --pidfile ${pidfile} </dev/null >${logPath} 2>&1 &`;
  // Backgrounding a daemon over `limactl shell` (ssh) returns non-zero even on
  // success — the readiness poll below is the real signal, not this exit.
  run("limactl", limaShell(opts.vm, launch));

  const socketExists = (): boolean =>
    run("limactl", ["shell", "--workdir", "/", opts.vm, "--", "test", "-S", socket]).status === 0;

  const maxPolls = Math.max(1, Math.ceil(readyTimeoutMs / POLL_MS));
  let ready = socketExists();
  for (let i = 0; i < maxPolls && !ready; i++) {
    await sleep(POLL_MS);
    ready = socketExists();
  }
  if (!ready) {
    const log = run("limactl", limaShell(opts.vm, `cat ${logPath} 2>/dev/null`)).stdout.trim();
    throw new Error(
      `${spec.name} socket ${socket} did not appear in ${opts.vm} within ${readyTimeoutMs}ms${log ? `: ${log}` : ""}`,
    );
  }
  return { socket, stop: () => stopDaemon(spec, { vm: opts.vm, socket, logPath, pidfile }, deps) };
}

/**
 * Stop a daemon in the VM by its own pidfile and remove its socket/log/pidfile
 * (best-effort; never throws). Kills by `kill "$(cat <pidfile>)"`, NOT `pkill -f`
 * — the latter also matches the `sh -c` shell running it over `limactl shell`.
 */
export async function stopDaemon(
  spec: DaemonSpec,
  opts: StopDaemonOptions,
  deps: DaemonLifecycleDeps = {},
): Promise<void> {
  const run = deps.run ?? spawnRun;
  const def = daemonPaths(spec.name);
  const socket = opts.socket ?? def.socket;
  const logPath = opts.logPath ?? def.logPath;
  const pidfile = opts.pidfile ?? def.pidfile;
  run(
    "limactl",
    limaShell(
      opts.vm,
      `P="$(cat ${pidfile} 2>/dev/null)"; [ -n "$P" ] && kill "$P" 2>/dev/null; rm -f ${socket} ${logPath} ${pidfile}`,
    ),
  );
}

/**
 * Deploy the binary then start the daemon — the one-call equivalent of the spike.
 * Returns a handle whose `stop()` tears the daemon down.
 */
export async function provisionDaemon(
  spec: DaemonSpec,
  opts: DeployDaemonOptions &
    Pick<
      StartDaemonOptions,
      "cwd" | "socket" | "logPath" | "pidfile" | "envPrefix" | "readyTimeoutMs"
    >,
  deps: DaemonLifecycleDeps = {},
): Promise<DaemonHandle> {
  const vmBinPath = deployDaemonBinary(opts, deps);
  return startDaemon(
    spec,
    {
      vm: opts.vm,
      vmBinPath,
      cwd: opts.cwd,
      socket: opts.socket,
      logPath: opts.logPath,
      pidfile: opts.pidfile,
      envPrefix: opts.envPrefix,
      readyTimeoutMs: opts.readyTimeoutMs,
    },
    deps,
  );
}
