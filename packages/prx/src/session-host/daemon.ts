/**
 * session-host daemon server (session-substrate slice 4).
 *
 * Binds the session host's unix-socket server: each connection is served by
 * {@link ./serve.serveSessionConnection} against
 * {@link ./handler.handleSessionRequest} bound to `deps`, over the shared
 * {@link ../keeperd/daemon.runFramedServe} (bind + GH-223 pidfile,
 * contract-agnostic) — so keeper's security-sensitive bind code isn't duplicated.
 *
 * This is what `prx session-host serve` runs inside the VM. The proc-backed spawn
 * seams, the Lima deploy (mirroring `lima-keeperd.ts`), and the CLI verb land in
 * slice 5 — they need a live VM to verify.
 */

import { type Server } from "node:net";

import { runFramedServe } from "../keeperd/daemon.ts";
import { type SessionRequest, type SessionResponse } from "./contract.ts";
import { handleSessionRequest, type SessionHostDeps } from "./handler.ts";
import { serveSessionConnection } from "./serve.ts";

export interface SessionHostServeOptions {
  /** Unix socket path the daemon listens on (a stale socket file is cleared). */
  socketPath: string;
  /** When set, the daemon writes its own pid here once listening (removed on close). */
  pidfile?: string | undefined;
  /** The process-control seams (file store + proc spawn in the VM; fakes in tests). */
  deps: SessionHostDeps;
}

/**
 * Bind the session-host unix-socket server. Resolves with the listening `Server`
 * (close it to stop).
 */
export function runSessionHostServe(options: SessionHostServeOptions): Promise<Server> {
  const { socketPath, pidfile, deps } = options;
  const handler = (request: SessionRequest): Promise<SessionResponse> =>
    handleSessionRequest(request, deps);
  return runFramedServe(socketPath, pidfile, (socket) => serveSessionConnection(socket, handler));
}
