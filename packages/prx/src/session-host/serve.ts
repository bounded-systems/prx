/**
 * session-host serve transport (session-substrate slice 2) — the in-VM wire.
 *
 * Wraps the pure handler ({@link ./handler.handleSessionRequest}) in the same
 * length-prefixed-JSON framing keeperd uses ({@link ../keeperd/daemon.encodeFrame}),
 * so the host's {@link ./client.SessionHostClient} reaches it over a unix socket
 * (local now; an `ssh -L`-forwarded VM socket in slice 3). Like keeperd: a frame
 * that fails the contract gets a `bad-request` error response and the daemon
 * stays up — the handler never throws to the socket.
 *
 * Scope: the per-connection wire. The server bind + pidfile lifecycle lands in
 * slice 3 with the Lima deploy (mirroring `lima-keeperd.ts`), composed with the
 * file-backed store + proc-backed spawn — so it isn't duplicated here.
 */

import { type Socket } from "node:net";

import { FrameDecoder, encodeFrame } from "../door/framing.ts";
import { SessionRequestSchema, type SessionRequest, type SessionResponse } from "./contract.ts";
import { handleSessionRequest, type SessionHostDeps } from "./handler.ts";

function badRequest(message: string): SessionResponse {
  return { status: "error", code: "bad-request", message };
}

/**
 * Wire a connected socket to the session handler: decode framed requests,
 * validate each against the contract, run the handler, frame the response back —
 * in arrival order. A frame that fails the contract gets a `bad-request`
 * response (the daemon stays up). Exported so it's testable over any duplex.
 */
export function serveSessionConnection(
  socket: Socket,
  handler: (request: SessionRequest) => Promise<SessionResponse>,
): void {
  const decoder = new FrameDecoder();
  // Serialize responses so multiplexed frames reply in arrival order.
  let chain: Promise<void> = Promise.resolve();
  socket.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.write(encodeFrame(badRequest("unframable bytes on the session channel")));
      return;
    }
    for (const raw of frames) {
      chain = chain.then(async () => {
        const parsed = SessionRequestSchema.safeParse(raw);
        const response: SessionResponse = parsed.success
          ? await handler(parsed.data)
          : badRequest("request failed the session-host wire contract");
        socket.write(encodeFrame(response));
      });
    }
  });
}

/** Bind the session handler to its deps — the per-connection callback for a daemon. */
export function sessionHandler(
  deps: SessionHostDeps,
): (request: SessionRequest) => Promise<SessionResponse> {
  return (request) => handleSessionRequest(request, deps);
}
