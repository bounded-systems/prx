/**
 * Lima in-VM daemon registry (GH-228, slice 4b).
 *
 * The single enumeration of the daemons `prx lima` can bring up/down/inspect:
 * keeperd (the git-write/signing daemon) and beadsd (the read-only beads query
 * daemon). Each entry adapts the daemon's own provision/stop (its keeper-/beads-
 * typed lifecycle wrapper over the shared {@link ./lifecycle}) to one uniform
 * {@link LimaUpOptions}/{@link LimaDownOptions} shape, and carries the metadata
 * the `daemons`/`status` verbs and the `--daemon` selector read.
 */

import { provisionBeadsd, stopBeadsd } from "../beadsd/lima.ts";
import { provisionKeeperd, stopKeeperd } from "../keeperd/lima-keeperd.ts";
import { isDaemonSocketUp, type DaemonHandle, type DaemonLifecycleDeps } from "./lifecycle.ts";

/** Uniform `up` options across daemons (provenanceKeyFile is honored only by signing daemons). */
export interface LimaUpOptions {
  vm: string;
  binaryPath: string;
  cwd: string;
  socket?: string | undefined;
  /** keeper-only; ignored by daemons that do not sign. */
  provenanceKeyFile?: string | undefined;
}

/** Uniform `down` options across daemons. */
export interface LimaDownOptions {
  vm: string;
  socket?: string | undefined;
}

/** A daemon `prx lima` manages, with its metadata + uniform provision/stop. */
export interface LimaDaemon {
  /** The `--daemon` selector value, e.g. `keeper` / `beads`. */
  readonly key: string;
  /** The daemon name (matches its DaemonSpec.name): `keeperd` / `beadsd`. */
  readonly name: string;
  /** Default in-VM unix socket. */
  readonly socket: string;
  /** Whether the daemon carries a provenance/signing key (keeper yes, beads no). */
  readonly signing: boolean;
  provision(opts: LimaUpOptions, deps?: DaemonLifecycleDeps): Promise<DaemonHandle>;
  stop(opts: LimaDownOptions, deps?: DaemonLifecycleDeps): Promise<void>;
}

/** The registered in-VM daemons, in canonical order. */
export const LIMA_DAEMONS: readonly LimaDaemon[] = [
  {
    key: "keeper",
    name: "keeperd",
    socket: "/tmp/keeperd.sock",
    signing: true,
    provision: (o, deps) =>
      provisionKeeperd(
        {
          vm: o.vm,
          binaryPath: o.binaryPath,
          cwd: o.cwd,
          ...(o.socket !== undefined ? { socket: o.socket } : {}),
          ...(o.provenanceKeyFile !== undefined ? { provenanceKeyFile: o.provenanceKeyFile } : {}),
        },
        deps,
      ),
    stop: (o, deps) => stopKeeperd({ vm: o.vm, ...(o.socket !== undefined ? { socket: o.socket } : {}) }, deps),
  },
  {
    key: "beads",
    name: "beadsd",
    socket: "/tmp/beadsd.sock",
    signing: false,
    provision: (o, deps) =>
      provisionBeadsd(
        {
          vm: o.vm,
          binaryPath: o.binaryPath,
          cwd: o.cwd,
          ...(o.socket !== undefined ? { socket: o.socket } : {}),
        },
        deps,
      ),
    stop: (o, deps) => stopBeadsd({ vm: o.vm, ...(o.socket !== undefined ? { socket: o.socket } : {}) }, deps),
  },
];

/** The `--daemon` selector vocabulary (`keeper | beads | all`). */
export const LIMA_DAEMON_KEYS: readonly string[] = LIMA_DAEMONS.map((d) => d.key);

/**
 * Resolve a `--daemon` selector to the daemons it names: a specific key, or
 * `all`/undefined → every daemon. Throws on an unknown key.
 */
export function selectLimaDaemons(selector?: string): LimaDaemon[] {
  if (selector === undefined || selector === "all") return [...LIMA_DAEMONS];
  const found = LIMA_DAEMONS.find((d) => d.key === selector);
  if (!found) {
    throw new Error(`unknown daemon '${selector}': choose ${LIMA_DAEMON_KEYS.join(" | ")} | all`);
  }
  return [found];
}

/** A daemon's liveness in the VM (its socket present or not). */
export interface LimaDaemonStatus {
  key: string;
  name: string;
  socket: string;
  up: boolean;
}

/** Probe each daemon's socket in the VM and report up/down. */
export function limaDaemonStatuses(
  vm: string,
  daemons: readonly LimaDaemon[],
  deps: DaemonLifecycleDeps = {},
): LimaDaemonStatus[] {
  return daemons.map((d) => ({
    key: d.key,
    name: d.name,
    socket: d.socket,
    up: isDaemonSocketUp(vm, d.socket, deps),
  }));
}
