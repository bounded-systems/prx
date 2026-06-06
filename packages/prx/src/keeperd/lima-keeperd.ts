/**
 * keeperd daemon lifecycle on Lima (GH-201, slice 3b).
 *
 * The host-side orchestration that turns the proven spike — cross-compile a
 * Linux prx, copy it into the VM, run `keeper serve` detached on a socket — into
 * callable steps. It pairs with the sibling drivers:
 *   - {@link ./lima-transport} forwards the socket this daemon listens on,
 *   - the executor spec (GH-211) owns the VM the binary runs in.
 *
 * deploy → start (bound to a keeper repo clone) → stop. All process effects route
 * through the {@link ./lima-exec} seam (→ `@bounded-systems/proc`), so the
 * orchestration is unit-tested offline; the live path runs against a real VM.
 */

import { spawnRun, type Run, type RunResult } from "./lima-exec.ts";

const DEFAULT_VM_BIN = "/tmp/prx";
const DEFAULT_SOCKET = "/tmp/keeperd.sock";
const DEFAULT_LOG = "/tmp/keeperd.log";
const POLL_MS = 50;

/** Injected effects (default to real process); tests stub them offline. */
export interface KeeperdLifecycleDeps {
  run?: Run | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DeployKeeperdOptions {
  /** Lima instance name. */
  vm: string;
  /** Host path of the (Linux) prx binary — see `prx:build:linux-arm64`. */
  binaryPath: string;
  /** Absolute destination path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
}

export interface StartKeeperdOptions {
  /** Lima instance name. */
  vm: string;
  /** Absolute prx path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
  /** Absolute unix socket keeperd binds INSIDE the VM (default `/tmp/keeperd.sock`). */
  socket?: string | undefined;
  /** The keeper repo clone (cwd) the daemon imports + pushes from. */
  cwd: string;
  /** Absolute daemon log path in the VM (default `/tmp/keeperd.log`). */
  logPath?: string | undefined;
  /** Max ms to wait for the socket to appear (default 5000). */
  readyTimeoutMs?: number | undefined;
}

export interface StopKeeperdOptions {
  vm: string;
  socket?: string | undefined;
  logPath?: string | undefined;
}

/** A running keeperd daemon handle. */
export interface KeeperdHandle {
  /** Absolute socket path inside the VM (forward it with {@link ./lima-transport}). */
  readonly socket: string;
  /** Stop the daemon and remove its socket/log (best-effort). */
  stop(): Promise<void>;
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
export function deployKeeperdBinary(opts: DeployKeeperdOptions, deps: KeeperdLifecycleDeps = {}): string {
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
 * Start keeperd detached in the VM on a unix socket, bound to a keeper clone, and
 * wait until the socket exists. `setsid nohup … &` fully detaches the daemon so
 * it survives the launching shell; a stale daemon/socket is cleared first.
 */
export async function startKeeperd(
  opts: StartKeeperdOptions,
  deps: KeeperdLifecycleDeps = {},
): Promise<KeeperdHandle> {
  const run = deps.run ?? spawnRun;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const vmBinPath = opts.vmBinPath ?? DEFAULT_VM_BIN;
  const socket = opts.socket ?? DEFAULT_SOCKET;
  const logPath = opts.logPath ?? DEFAULT_LOG;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5000;

  const launch =
    `pkill -f 'prx keeper serve' 2>/dev/null || true; rm -f ${socket} ${logPath}; ` +
    `setsid nohup ${vmBinPath} keeper serve --socket ${socket} --cwd ${opts.cwd} >${logPath} 2>&1 &`;
  requireOk(run("limactl", limaShell(opts.vm, launch)), "keeperd launch");

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
      `keeperd socket ${socket} did not appear in ${opts.vm} within ${readyTimeoutMs}ms${log ? `: ${log}` : ""}`,
    );
  }
  return { socket, stop: () => stopKeeperd({ vm: opts.vm, socket, logPath }, deps) };
}

/** Stop keeperd in the VM and remove its socket/log (best-effort; never throws). */
export async function stopKeeperd(opts: StopKeeperdOptions, deps: KeeperdLifecycleDeps = {}): Promise<void> {
  const run = deps.run ?? spawnRun;
  const socket = opts.socket ?? DEFAULT_SOCKET;
  const logPath = opts.logPath ?? DEFAULT_LOG;
  run("limactl", limaShell(opts.vm, `pkill -f 'prx keeper serve' 2>/dev/null || true; rm -f ${socket} ${logPath}`));
}

/**
 * Deploy the binary then start the daemon — the one-call equivalent of the spike.
 * Returns a handle whose `stop()` tears the daemon down.
 */
export async function provisionKeeperd(
  opts: DeployKeeperdOptions & Pick<StartKeeperdOptions, "cwd" | "socket" | "logPath" | "readyTimeoutMs">,
  deps: KeeperdLifecycleDeps = {},
): Promise<KeeperdHandle> {
  const vmBinPath = deployKeeperdBinary(opts, deps);
  return startKeeperd(
    {
      vm: opts.vm,
      vmBinPath,
      cwd: opts.cwd,
      socket: opts.socket,
      logPath: opts.logPath,
      readyTimeoutMs: opts.readyTimeoutMs,
    },
    deps,
  );
}
