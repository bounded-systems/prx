/**
 * session-host daemon lifecycle on Lima (session-substrate slice 6).
 *
 * Host-side orchestration: copy the Linux prx binary into the VM, run
 * `session-host serve` detached on a unix socket, stop it. Faithfully mirrors
 * keeperd's {@link ../keeperd/lima-keeperd} — same `setsid`/`nohup` detach, same
 * kill-by-pidfile (not `pkill -f`, which self-matches the controlling shell over
 * `limactl shell`), same socket-readiness poll, same offline-testable Run seam
 * (→ `@bounded-systems/proc`). Backgrounding over `limactl shell` (ssh) returns
 * non-zero even on success, so the launch exit is ignored and the socket poll is
 * the sole success signal.
 *
 * The `prx session-host serve` CLI verb the launch invokes, the host↔VM channel
 * (forwarding this socket → a `SessionHostClient`), and the live smoke test land
 * in slice 7.
 */

import { spawnRun, type Run, type RunResult } from "../keeperd/lima-exec.ts";

const DEFAULT_VM_BIN = "/tmp/prx";
const DEFAULT_SOCKET = "/tmp/prx-session-host.sock";
const DEFAULT_LOG = "/tmp/prx-session-host.log";
const DEFAULT_PIDFILE = "/tmp/prx-session-host.pid";
const DEFAULT_STATE_DIR = "/tmp/prx-session-host";
const POLL_MS = 50;

/** Injected effects (default to real process); tests stub them offline. */
export interface SessionHostLifecycleDeps {
  run?: Run | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DeploySessionHostOptions {
  /** Lima instance name. */
  vm: string;
  /** Host path of the (Linux) prx binary. */
  binaryPath: string;
  /** Absolute destination path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
}

export interface StartSessionHostOptions {
  /** Lima instance name. */
  vm: string;
  /** Absolute prx path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
  /** Absolute unix socket the daemon binds INSIDE the VM. */
  socket?: string | undefined;
  /** Dir IN the VM the daemon keeps its session store + logs under. */
  stateDir?: string | undefined;
  /** Absolute daemon log path in the VM. */
  logPath?: string | undefined;
  /** Absolute pidfile the daemon writes its own pid to. */
  pidfile?: string | undefined;
  /** Max ms to wait for the socket to appear (default 5000). */
  readyTimeoutMs?: number | undefined;
}

export interface StopSessionHostOptions {
  vm: string;
  socket?: string | undefined;
  logPath?: string | undefined;
  pidfile?: string | undefined;
}

/** A running session-host daemon handle. */
export interface SessionHostHandle {
  /** Absolute socket path inside the VM (forward it to dial the daemon). */
  readonly socket: string;
  /** Stop the daemon and remove its socket/log/pidfile (best-effort). */
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
export function deploySessionHostBinary(
  opts: DeploySessionHostOptions,
  deps: SessionHostLifecycleDeps = {},
): string {
  const run = deps.run ?? spawnRun;
  const vmBinPath = opts.vmBinPath ?? DEFAULT_VM_BIN;
  requireOk(
    run("limactl", ["copy", opts.binaryPath, `${opts.vm}:${vmBinPath}`]),
    `limactl copy → ${opts.vm}`,
  );
  requireOk(run("limactl", limaShell(opts.vm, `chmod +x ${vmBinPath}`)), `chmod +x ${vmBinPath}`);
  return vmBinPath;
}

/**
 * Start the session-host daemon detached in the VM on a unix socket, and wait
 * until the socket exists. The daemon writes its own `--pidfile`, so a stale
 * instance is cleared by `kill "$(cat <pidfile>)"`.
 */
export async function startSessionHost(
  opts: StartSessionHostOptions,
  deps: SessionHostLifecycleDeps = {},
): Promise<SessionHostHandle> {
  const run = deps.run ?? spawnRun;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const vmBinPath = opts.vmBinPath ?? DEFAULT_VM_BIN;
  const socket = opts.socket ?? DEFAULT_SOCKET;
  const stateDir = opts.stateDir ?? DEFAULT_STATE_DIR;
  const logPath = opts.logPath ?? DEFAULT_LOG;
  const pidfile = opts.pidfile ?? DEFAULT_PIDFILE;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5000;

  const launch =
    `OLD="$(cat ${pidfile} 2>/dev/null)"; [ -n "$OLD" ] && kill "$OLD" 2>/dev/null; ` +
    `rm -f ${socket} ${logPath} ${pidfile}; ` +
    `setsid nohup ${vmBinPath} session-host serve --socket ${socket} --state-dir ${stateDir} --pidfile ${pidfile} </dev/null >${logPath} 2>&1 &`;
  // Backgrounding over `limactl shell` (ssh) returns non-zero even on success —
  // the readiness poll below is the real signal, not this exit.
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
      `session-host socket ${socket} did not appear in ${opts.vm} within ${readyTimeoutMs}ms${log ? `: ${log}` : ""}`,
    );
  }
  return { socket, stop: () => stopSessionHost({ vm: opts.vm, socket, logPath, pidfile }, deps) };
}

/** Stop the daemon by its pidfile and remove its socket/log/pidfile (best-effort). */
export async function stopSessionHost(
  opts: StopSessionHostOptions,
  deps: SessionHostLifecycleDeps = {},
): Promise<void> {
  const run = deps.run ?? spawnRun;
  const socket = opts.socket ?? DEFAULT_SOCKET;
  const logPath = opts.logPath ?? DEFAULT_LOG;
  const pidfile = opts.pidfile ?? DEFAULT_PIDFILE;
  run(
    "limactl",
    limaShell(
      opts.vm,
      `P="$(cat ${pidfile} 2>/dev/null)"; [ -n "$P" ] && kill "$P" 2>/dev/null; rm -f ${socket} ${logPath} ${pidfile}`,
    ),
  );
}

/** Deploy the binary then start the daemon — the one-call provision. */
export async function provisionSessionHost(
  opts: DeploySessionHostOptions & Omit<StartSessionHostOptions, "vmBinPath">,
  deps: SessionHostLifecycleDeps = {},
): Promise<SessionHostHandle> {
  const vmBinPath = deploySessionHostBinary(opts, deps);
  return startSessionHost({ ...opts, vmBinPath }, deps);
}
