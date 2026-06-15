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
import { resolveFramedTransport, type FramedTransport } from "../door/transport.ts";

export interface WithKeeperClientDeps {
  /** Override the resolved endpoint (default: {@link resolveKeeperEndpoint}). */
  endpoint?: KeeperEndpoint | undefined;
  /** Transport factory from a door address (default {@link resolveFramedTransport}); tests inject. */
  makeTransport?: ((endpoint: string) => FramedTransport) | undefined;
}

/**
 * Run `fn` with an {@link IsolatedKeeperClient} dialing the resolved keeper door.
 * The transport (`FramedTransport`) is structurally assignable to the client's
 * narrower `KeeperTransport`, so one factory serves the unix-socket (pod) and
 * `host:port` (macOS gateway) cases unchanged.
 */
export async function withKeeperClient<T>(
  fn: (client: IsolatedKeeperClient) => Promise<T>,
  deps: WithKeeperClientDeps = {},
): Promise<T> {
  const endpoint = deps.endpoint ?? resolveKeeperEndpoint();
  const makeTransport = deps.makeTransport ?? resolveFramedTransport;
  const client = new IsolatedKeeperClient(makeTransport(endpoint.socket));
  return fn(client);
}
