/**
 * keeperd client factory — assemble a live {@link ./client.IsolatedKeeperClient}
 * over the keeper door (prx-asr). This is the seam `keeperd/endpoint.ts` deferred
 * ("the resolved socket feeds resolveFramedTransport to build the client's
 * transport"): {@link ./endpoint.resolveKeeperEndpoint} gives the door address,
 * {@link ../door/transport.resolveFramedTransport} turns it into the framed
 * transport (a unix socket on the pod's shared door fabric, or a `host:port`),
 * and the client wraps it.
 *
 * Foundation only — like beadsd's {@link ../beadsd/client-factory.withBeadsClient}
 * this builds the door client; it does NOT yet route the pipeline's git-writes
 * through it (the caller still injects the client into
 * {@link ./host.runKeeperRemote}). The door transport is one connection per
 * request, so there is no channel to keep open or tear down.
 */

import { IsolatedKeeperClient } from "./client.ts";
import { resolveKeeperEndpoint, type KeeperEndpoint } from "./endpoint.ts";
import { guestRoomKeeperTransport } from "./protocol-transport.ts";
import type { KeeperTransport } from "./client.ts";

export interface WithKeeperClientDeps {
  /** Override the resolved endpoint (default: {@link resolveKeeperEndpoint}). */
  endpoint?: KeeperEndpoint | undefined;
  /**
   * Transport factory from a door address (default {@link guestRoomKeeperTransport},
   * which speaks the guest-room door protocol); tests inject a fake.
   */
  makeTransport?: ((endpoint: string) => KeeperTransport) | undefined;
}

/**
 * Run `fn` with an {@link IsolatedKeeperClient} dialing the resolved keeper door
 * over the guest-room door protocol. The endpoint is a unix socket (pod) or a
 * `host:port` (macOS gateway) — guest-room's `call` handles both.
 */
export async function withKeeperClient<T>(
  fn: (client: IsolatedKeeperClient) => Promise<T>,
  deps: WithKeeperClientDeps = {},
): Promise<T> {
  const endpoint = deps.endpoint ?? resolveKeeperEndpoint();
  const makeTransport = deps.makeTransport ?? guestRoomKeeperTransport;
  const client = new IsolatedKeeperClient(makeTransport(endpoint.socket));
  return fn(client);
}
