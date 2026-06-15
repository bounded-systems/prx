/**
 * keeperd client endpoint — where the host's {@link ./client.IsolatedKeeperClient}
 * dials the keeper door (prx-asr; the ADR §4 "keeperd endpoint env" prerequisite
 * in `docs/prx/oci-substrate.md`).
 *
 * This is the keeper analog of beadsd's {@link ../beadsd/client-factory.resolveBeadsEndpoint}:
 * the per-repo pod projects `PRX_KEEPER_SOCKET` (the keeper door socket) into the
 * consumer room's env via {@link ../room/pod.podRoomEnv}, and this resolver is the
 * canonical reader of it. `PRX_KEEPER_VM` selects the Lima daemon instead (the
 * {@link ./lima-transport} path), matching how keeperd is reached today.
 *
 * Foundation only: this defines the endpoint *contract* the pod's door env feeds.
 * The wrapper that turns a resolved endpoint into a live `IsolatedKeeperClient`
 * — a local unix-socket door ({@link ../door/transport.unixSocketTransport}) vs
 * the Lima channel ({@link ./lima-transport.withLimaKeeperClient}) — is the
 * follow-on slice; the transport machinery for both already exists.
 */

import { getEnv } from "@bounded-systems/env";

/** Where keeperd lives: a local unix socket (the pod door), or a Lima VM daemon. */
export type KeeperEndpoint =
  | { readonly kind: "local"; readonly socket: string }
  | { readonly kind: "lima"; readonly vm: string; readonly vmSocket: string };

/** Default local keeperd socket (override with `PRX_KEEPER_SOCKET`). */
export const DEFAULT_LOCAL_KEEPER_SOCKET = "/tmp/prx-keeperd.sock";
/** Default in-VM keeperd socket (matches the keeperd Lima default `/tmp/keeperd.sock`). */
export const DEFAULT_VM_KEEPER_SOCKET = "/tmp/keeperd.sock";

/**
 * Resolve the keeperd endpoint from the environment: `PRX_KEEPER_VM` selects the
 * Lima VM daemon (`PRX_KEEPER_VM_SOCKET` overrides its in-VM socket); otherwise a
 * local socket (`PRX_KEEPER_SOCKET` overrides the default) — the pod door case.
 */
export function resolveKeeperEndpoint(env: typeof getEnv = getEnv): KeeperEndpoint {
  const vm = env("PRX_KEEPER_VM");
  if (vm) {
    return { kind: "lima", vm, vmSocket: env("PRX_KEEPER_VM_SOCKET") ?? DEFAULT_VM_KEEPER_SOCKET };
  }
  return { kind: "local", socket: env("PRX_KEEPER_SOCKET") ?? DEFAULT_LOCAL_KEEPER_SOCKET };
}
