/**
 * Keeper door endpoint resolution (prx-asr) — the client-side reader of the
 * `PRX_KEEPER_*` env the pod projects into a keeperd consumer (see
 * room/pod.ts `doorEnv`). Symmetric to beads' {@link ../beadsd/client-factory}:
 *
 *   - `PRX_KEEPER_DOOR`   present → box mode: route git-writes through the
 *                         keeperd door (the room holds no git authority itself).
 *   - `PRX_KEEPER_SOCKET` the door's transport address (a unix socket on the
 *                         pod's shared tmpfs door fabric, or a host:port).
 *
 * Pure + env-injectable, so the resolution is unit-tested without a daemon. The
 * resolved socket feeds {@link ../door/transport.resolveFramedTransport} to build
 * the {@link ./client.IsolatedKeeperClient}'s transport.
 */

import { getEnv } from "@bounded-systems/env";

/** Default local keeperd socket (override with `PRX_KEEPER_SOCKET`). */
export const DEFAULT_LOCAL_KEEPER_SOCKET = "/tmp/prx-keeperd.sock";

/** The keeperd door endpoint a client dials. */
export interface KeeperEndpoint {
  /** The door's transport address — a unix-socket path or `host:port`. */
  readonly socket: string;
}

/**
 * True when `PRX_KEEPER_DOOR` is set — the box-profile signal that git-writes go
 * through the keeperd door rather than a local keeper. Mirrors `isBdDoorMode`.
 */
export function isKeeperDoorMode(env: typeof getEnv = getEnv): boolean {
  return Boolean(env("PRX_KEEPER_DOOR"));
}

/**
 * Resolve the keeperd endpoint from the environment: `PRX_KEEPER_SOCKET` is the
 * door address the pod projected, falling back to the local default.
 */
export function resolveKeeperEndpoint(env: typeof getEnv = getEnv): KeeperEndpoint {
  return { socket: env("PRX_KEEPER_SOCKET") ?? DEFAULT_LOCAL_KEEPER_SOCKET };
}
