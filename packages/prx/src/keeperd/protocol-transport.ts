/**
 * A2 of the prx→guest-room convergence (.github-private
 * docs/convergence-prx-claude-box.md): the keeper door's client transport,
 * speaking the published guest-room door protocol instead of prx's bespoke
 * length-prefixed framing (`../door/transport.ts`).
 *
 * The keeper client ({@link ./client.IsolatedKeeperClient}) takes a
 * {@link ./client.KeeperTransport} seam; this builds one that dials the keeper
 * door via guest-room's `call(endpoint, "import-and-push", request)`. The
 * endpoint is a unix path OR a `host:port` TCP target (guest-room ≥0.2.0 parses
 * both), so the macOS/TCP keeper door is preserved.
 *
 * `call` resolves with the response envelope's `result` — the daemon's
 * `KeeperRemoteResponse` — which the client then validates against the wire
 * contract. A transport-level failure (the daemon's method handler threw, or the
 * socket errored) rejects, surfaced by the client as a `KeeperProtocolError`.
 */

import { call } from "@bounded-systems/guest-room/protocol";

import type { KeeperTransport } from "./client.ts";

/**
 * Build a {@link KeeperTransport} over the guest-room door protocol at `endpoint`
 * (unix path or `host:port`). The daemon registers the matching `import-and-push`
 * method via `createDoorHandlers` (see {@link ./daemon.runKeeperServe}).
 */
export function guestRoomKeeperTransport(endpoint: string): KeeperTransport {
  return (request) =>
    call(endpoint, "import-and-push", request as unknown as Record<string, unknown>);
}
