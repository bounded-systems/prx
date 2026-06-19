/**
 * keeperd daemon lifecycle on Lima (GH-201; generalized in GH-228 slice 4a).
 *
 * A thin keeper-typed wrapper over the daemon-agnostic {@link ../lima/lifecycle}:
 * the deploy → start → stop orchestration now lives there (shared with beadsd's
 * {@link ../beadsd/lima}); this module binds the keeper {@link DaemonSpec}
 * (`keeper serve`, `/tmp/keeperd.*`) and owns the keeper-only provenance-key
 * injection — turning a `provenanceKeyFile` into the launch's env-prefix so a
 * push with `ledgerRef` emits a signed `push/v1`.
 *
 * Exports are kept stable (`deployKeeperdBinary`, `startKeeperd`, `stopKeeperd`,
 * `provisionKeeperd`, `KeeperdHandle`, …) so existing callers and tests are
 * untouched.
 */

import {
  deployDaemonBinary,
  provisionDaemon,
  startDaemon,
  stopDaemon,
  type DaemonHandle,
  type DaemonLifecycleDeps,
  type DaemonSpec,
} from "../lima/lifecycle.ts";

/** The keeper daemon: `keeper serve`, defaults at `/tmp/keeperd.*`. */
const KEEPER_SPEC: DaemonSpec = { name: "keeperd", serveCommand: ["keeper", "serve"] };

export type KeeperdLifecycleDeps = DaemonLifecycleDeps;

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
  /** Absolute pidfile the daemon writes its own pid to (default `/tmp/keeperd.pid`). */
  pidfile?: string | undefined;
  /**
   * GH-236 slice 4: absolute path IN the VM to the provenance key file
   * (`ed25519:<b64>`, born in-VM). When set, the launch injects it into the
   * daemon's env (`PRX_PROVENANCE_KEY="$(cat <file>)"`) — from the file, kept out
   * of argv — so a push with `ledgerRef` emits a signed `push/v1`.
   */
  provenanceKeyFile?: string | undefined;
  /** Max ms to wait for the socket to appear (default 5000). */
  readyTimeoutMs?: number | undefined;
}

export interface StopKeeperdOptions {
  vm: string;
  socket?: string | undefined;
  logPath?: string | undefined;
  pidfile?: string | undefined;
}

/** A running keeperd daemon handle. */
export type KeeperdHandle = DaemonHandle;

/** Build the keeper-only env-prefix that injects the in-VM provenance key (from its file, out of argv). */
function provenanceEnvPrefix(provenanceKeyFile?: string): string {
  return provenanceKeyFile !== undefined ? `PRX_PROVENANCE_KEY="$(cat ${provenanceKeyFile})" ` : "";
}

/** Copy a (Linux) prx binary into the VM and make it executable. Returns its VM path. */
export function deployKeeperdBinary(
  opts: DeployKeeperdOptions,
  deps: KeeperdLifecycleDeps = {},
): string {
  return deployDaemonBinary(opts, deps);
}

/**
 * Start keeperd detached in the VM on a unix socket, bound to a keeper clone, and
 * wait until the socket exists. Delegates to {@link startDaemon}; the only
 * keeper-specific bit is the provenance-key env injection.
 */
export async function startKeeperd(
  opts: StartKeeperdOptions,
  deps: KeeperdLifecycleDeps = {},
): Promise<KeeperdHandle> {
  return startDaemon(
    KEEPER_SPEC,
    {
      vm: opts.vm,
      vmBinPath: opts.vmBinPath,
      socket: opts.socket,
      cwd: opts.cwd,
      logPath: opts.logPath,
      pidfile: opts.pidfile,
      envPrefix: provenanceEnvPrefix(opts.provenanceKeyFile),
      readyTimeoutMs: opts.readyTimeoutMs,
    },
    deps,
  );
}

/**
 * Stop keeperd in the VM by its own pidfile and remove its socket/log/pidfile
 * (best-effort; never throws). Delegates to {@link stopDaemon}.
 */
export async function stopKeeperd(
  opts: StopKeeperdOptions,
  deps: KeeperdLifecycleDeps = {},
): Promise<void> {
  return stopDaemon(KEEPER_SPEC, opts, deps);
}

/**
 * Deploy the binary then start the daemon — the one-call equivalent of the spike.
 * Returns a handle whose `stop()` tears the daemon down.
 */
export async function provisionKeeperd(
  opts: DeployKeeperdOptions &
    Pick<
      StartKeeperdOptions,
      "cwd" | "socket" | "logPath" | "pidfile" | "provenanceKeyFile" | "readyTimeoutMs"
    >,
  deps: KeeperdLifecycleDeps = {},
): Promise<KeeperdHandle> {
  return provisionDaemon(
    KEEPER_SPEC,
    {
      vm: opts.vm,
      binaryPath: opts.binaryPath,
      vmBinPath: opts.vmBinPath,
      cwd: opts.cwd,
      socket: opts.socket,
      logPath: opts.logPath,
      pidfile: opts.pidfile,
      envPrefix: provenanceEnvPrefix(opts.provenanceKeyFile),
      readyTimeoutMs: opts.readyTimeoutMs,
    },
    deps,
  );
}
