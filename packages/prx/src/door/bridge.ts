/**
 * The door-bridge — phase 1: a loopback TCP→unix forwarder (prx-8uf2).
 *
 * Every actor-door (forge-d / keeperd / beadsd) listens on a UNIX socket. A
 * host/remote caller can't reach it: a macOS host can't connect a unix socket
 * across virtiofs, and there is no TCP listener behind a published port. This
 * forwarder is the host-side edge: a `127.0.0.1`-only TCP listener that, per
 * connection, opens a fresh connection to the door's unix socket and pumps bytes
 * both ways. It is frame-transparent — it does NOT parse door frames; it only
 * moves the edge from unix to TCP.
 *
 * **Phase 1 only — and intentionally minimal.** This edge carries NO
 * authentication. Binding loopback (never `0.0.0.0`) is the whole safety story:
 * it widens door access from the socket's owner to *all local users*, which is
 * acceptable on a single-user dev mac but **not** on a shared/prod host. Phase 2
 * (the real prx-8uf2) puts a signed-grant gate in front of this forward so a
 * non-loopback / cross-host edge can be authenticated; until then the bind stays
 * loopback and the caller opts in explicitly (the `door bridge` verb).
 *
 * See `docs/prx/door-bridge.md`.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * The address the bridge binds — the loopback interface, NEVER the wildcard
 * (`0.0.0.0`). A credential door with no edge auth must not be reachable
 * off-host; loopback is what makes the phase-1 forward safe to ship. This is a
 * constant, not an option, so no caller can widen it by accident.
 */
export const BRIDGE_BIND_ADDRESS = "127.0.0.1";

export interface LoopbackBridgeOptions {
  /** TCP port to listen on (always bound to {@link BRIDGE_BIND_ADDRESS}). */
  readonly port: number;
  /** Target door unix socket path each TCP connection is forwarded to. */
  readonly socketPath: string;
}

/**
 * Pump bytes both ways between an accepted TCP connection (`downstream`) and a
 * fresh connection to the door unix socket (`upstream`), tearing BOTH down when
 * either errors or closes — no half-open leak that would keep the daemon's
 * connection handler (or the caller's event loop) alive. `pipe` carries the data
 * + the `end` (graceful half-close); the explicit `close`/`error` teardown
 * covers the abrupt cases `pipe` does not.
 */
function bridgeConnection(downstream: Socket, socketPath: string): void {
  const upstream = createConnection(socketPath);
  let down = false;
  const teardown = () => {
    if (down) return;
    down = true;
    downstream.destroy();
    upstream.destroy();
  };
  upstream.on("error", teardown);
  downstream.on("error", teardown);
  upstream.on("close", teardown);
  downstream.on("close", teardown);
  downstream.pipe(upstream);
  upstream.pipe(downstream);
}

/**
 * Run the phase-1 loopback door-bridge. Binds a TCP listener on
 * `127.0.0.1:<port>` and frame-transparently forwards every connection to the
 * door at `socketPath`. Resolves with the listening {@link Server} (close it to
 * stop). Rejects if the bind fails (e.g. the port is in use).
 */
export function runLoopbackBridge(opts: LoopbackBridgeOptions): Promise<Server> {
  const server = createServer((downstream) => bridgeConnection(downstream, opts.socketPath));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // listen(port, host) — the host is hardcoded to loopback (see above).
    server.listen(opts.port, BRIDGE_BIND_ADDRESS, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
