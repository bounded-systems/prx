/**
 * beadsd Lima transport (GH-228, slice 3).
 *
 * A thin beads-typed wrapper over the shared {@link ../lima/channel}: forward the
 * in-VM beadsd socket to the host over Lima SSH and build an
 * {@link IsolatedBeadsClient} over the framed transport. The forward + lifecycle
 * are keeperd's, generalized — beadsd adds no duplicate SSH plumbing, only the
 * beads request type and a temp-dir name prefix.
 *
 * The agent queries the in-VM beads store for exactly the tasks it needs
 * (shallow context); this is the host end of that channel.
 */

import { IsolatedBeadsClient, type BeadsTransport } from "./client.ts";
import {
  openLimaChannel,
  withLimaChannel,
  type LimaChannel,
  type LimaChannelDeps as GenericLimaChannelDeps,
  type LimaChannelOptions,
} from "../lima/channel.ts";
import {
  provisionDaemon,
  stopDaemon,
  type DaemonHandle,
  type DaemonLifecycleDeps,
  type DaemonSpec,
  type DeployDaemonOptions,
  type StartDaemonOptions,
  type StopDaemonOptions,
} from "../lima/lifecycle.ts";

export type { RunResult } from "../lima/channel.ts";

/** beads-typed channel deps (its `makeTransport` yields a {@link BeadsTransport}). */
export type LimaBeadsChannelDeps = GenericLimaChannelDeps<BeadsTransport>;

export type LimaBeadsChannelOptions = LimaChannelOptions;

/** An established host↔VM beadsd forward. */
export type LimaBeadsChannel = LimaChannel<BeadsTransport>;

const NAME_PREFIX = "beadsd-lima-";

/**
 * Establish a Lima-SSH-forwarded unix socket to the in-VM beadsd and return a
 * beads-typed channel over it. Delegates to {@link openLimaChannel}.
 */
export function openLimaBeadsChannel(
  opts: LimaBeadsChannelOptions,
  deps: LimaBeadsChannelDeps = {},
): Promise<LimaBeadsChannel> {
  return openLimaChannel<BeadsTransport>({ ...opts, namePrefix: opts.namePrefix ?? NAME_PREFIX }, deps);
}

/**
 * Open a Lima beadsd channel, run `fn` with an {@link IsolatedBeadsClient} over
 * it, and always close the forward afterward (even on throw).
 */
export async function withLimaBeadsClient<T>(
  opts: LimaBeadsChannelOptions,
  fn: (client: IsolatedBeadsClient) => Promise<T>,
  deps: LimaBeadsChannelDeps = {},
): Promise<T> {
  return withLimaChannel<BeadsTransport, T>(
    { ...opts, namePrefix: opts.namePrefix ?? NAME_PREFIX },
    (transport) => fn(new IsolatedBeadsClient(transport)),
    deps,
  );
}

// ── lifecycle: bring beadsd up/down inside the VM ────────────────────────────
//
// beadsd is read-only (no provenance/signing), so unlike keeperd it injects no
// env-prefix — just the daemon spec over the shared {@link ../lima/lifecycle}.

/** The beads daemon: `beads serve`, defaults at `/tmp/beadsd.*`. */
const BEADS_SPEC: DaemonSpec = { name: "beadsd", serveCommand: ["beads", "serve"] };

export type BeadsdLifecycleDeps = DaemonLifecycleDeps;

/** A running beadsd daemon handle. */
export type BeadsdHandle = DaemonHandle;

/**
 * Deploy the (Linux) prx binary into the VM, then start beadsd detached on a unix
 * socket bound to the in-VM repo clone (its beads DB). Returns a handle whose
 * `stop()` tears it down. Delegates to {@link provisionDaemon}.
 */
export function provisionBeadsd(
  opts: DeployDaemonOptions &
    Pick<StartDaemonOptions, "cwd" | "socket" | "logPath" | "pidfile" | "readyTimeoutMs">,
  deps: BeadsdLifecycleDeps = {},
): Promise<BeadsdHandle> {
  return provisionDaemon(BEADS_SPEC, opts, deps);
}

/** Stop beadsd in the VM by its pidfile and remove its socket/log/pidfile (best-effort). */
export function stopBeadsd(opts: StopDaemonOptions, deps: BeadsdLifecycleDeps = {}): Promise<void> {
  return stopDaemon(BEADS_SPEC, opts, deps);
}
