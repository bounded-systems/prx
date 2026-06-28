/**
 * ghappd daemon lifecycle on Lima — a thin ghapp-typed wrapper over the
 * daemon-agnostic {@link ../lima/lifecycle} (shared with keeperd/beadsd). It
 * binds the ghapp {@link DaemonSpec} (`ghapp serve`) and owns the ghapp-only
 * credential injection: the App id/installation as plain env, and the App
 * private key from a file via `$(cat …)` so the PEM stays out of argv.
 *
 * ghappd is NOT repo-bound (it holds a key and serves), so `cwd` is a harmless
 * default — the generic launcher passes `--cwd`, and `ghapp serve` accepts but
 * ignores it.
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

/** The ghapp daemon: `ghapp serve`, defaults at `/tmp/ghappd.*`. */
const GHAPP_SPEC: DaemonSpec = { name: "ghappd", serveCommand: ["ghapp", "serve"] };

/** cwd is ignored by ghappd; the launcher requires one, so default it. */
const GHAPP_CWD = "/tmp";

export type GhappdLifecycleDeps = DaemonLifecycleDeps;

export interface DeployGhappdOptions {
  /** Lima instance name. */
  vm: string;
  /** Host path of the (Linux) prx binary. */
  binaryPath: string;
  /** Absolute destination path in the VM (default `/tmp/prx`). */
  vmBinPath?: string | undefined;
}

/** The App credential to inject into the in-VM daemon's env. */
export interface GhappdCredential {
  /** PRX_GH_APP_ID — the App ID or Client ID. */
  appId?: string | undefined;
  /** Absolute path IN the VM to the App private-key PEM (read via `$(cat …)`). */
  appKeyFile?: string | undefined;
  /** PRX_GH_INSTALLATION_ID — required by the daemon (per-bucket; no default). */
  installationId?: string | undefined;
}

export interface StartGhappdOptions extends GhappdCredential {
  vm: string;
  vmBinPath?: string | undefined;
  /** Absolute unix socket ghappd binds INSIDE the VM (default `/tmp/ghappd.sock`). */
  socket?: string | undefined;
  logPath?: string | undefined;
  pidfile?: string | undefined;
  readyTimeoutMs?: number | undefined;
}

export interface StopGhappdOptions {
  vm: string;
  socket?: string | undefined;
  logPath?: string | undefined;
  pidfile?: string | undefined;
}

/** A running ghappd daemon handle. */
export type GhappdHandle = DaemonHandle;

/** Build the ghapp env-prefix: id/installation as plain env, PEM from its file (out of argv). */
function ghappEnvPrefix(cred: GhappdCredential): string {
  const parts: string[] = [];
  if (cred.appId) parts.push(`PRX_GH_APP_ID="${cred.appId}"`);
  if (cred.appKeyFile) parts.push(`PRX_GH_APP_PRIVATE_KEY="$(cat ${cred.appKeyFile})"`);
  if (cred.installationId) parts.push(`PRX_GH_INSTALLATION_ID="${cred.installationId}"`);
  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/** Copy a (Linux) prx binary into the VM and make it executable. Returns its VM path. */
export function deployGhappdBinary(
  opts: DeployGhappdOptions,
  deps: GhappdLifecycleDeps = {},
): string {
  return deployDaemonBinary(opts, deps);
}

/**
 * Start ghappd detached in the VM on a unix socket and wait until the socket
 * exists. Delegates to {@link startDaemon}; the only ghapp-specific bit is the
 * App-credential env injection.
 */
export async function startGhappd(
  opts: StartGhappdOptions,
  deps: GhappdLifecycleDeps = {},
): Promise<GhappdHandle> {
  return startDaemon(
    GHAPP_SPEC,
    {
      vm: opts.vm,
      vmBinPath: opts.vmBinPath,
      socket: opts.socket,
      cwd: GHAPP_CWD,
      logPath: opts.logPath,
      pidfile: opts.pidfile,
      envPrefix: ghappEnvPrefix(opts),
      readyTimeoutMs: opts.readyTimeoutMs,
    },
    deps,
  );
}

/**
 * Stop ghappd in the VM by its own pidfile and remove its socket/log/pidfile
 * (best-effort; never throws). Delegates to {@link stopDaemon}.
 */
export async function stopGhappd(
  opts: StopGhappdOptions,
  deps: GhappdLifecycleDeps = {},
): Promise<void> {
  return stopDaemon(GHAPP_SPEC, opts, deps);
}

/** Deploy the binary then start the daemon — returns a handle whose `stop()` tears it down. */
export async function provisionGhappd(
  opts: DeployGhappdOptions &
    GhappdCredential &
    Pick<StartGhappdOptions, "socket" | "logPath" | "pidfile" | "readyTimeoutMs">,
  deps: GhappdLifecycleDeps = {},
): Promise<GhappdHandle> {
  return provisionDaemon(
    GHAPP_SPEC,
    {
      vm: opts.vm,
      binaryPath: opts.binaryPath,
      vmBinPath: opts.vmBinPath,
      cwd: GHAPP_CWD,
      socket: opts.socket,
      logPath: opts.logPath,
      pidfile: opts.pidfile,
      envPrefix: ghappEnvPrefix(opts),
      readyTimeoutMs: opts.readyTimeoutMs,
    },
    deps,
  );
}
