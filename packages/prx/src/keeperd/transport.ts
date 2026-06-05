/**
 * keeperd socket transport (GH-201, slice 3a).
 *
 * The concrete {@link ./client.KeeperTransport} the host's
 * {@link ./client.IsolatedKeeperClient} runs over: frame a request onto a
 * connected socket, read exactly one response frame, done. It is the wire end
 * of the contract — the daemon's {@link ./daemon.serveConnection} is the other.
 *
 * The socket is obtained through an injected `openConnection` seam, so the SAME
 * transport serves three setups unchanged:
 *   - a local unix socket (tests, and a daemon on the same host),
 *   - an `ssh -L` / `limactl`-forwarded unix socket bridged to the in-VM
 *     keeperd (slice 3b — the isolated-VM deployment),
 *   - any other duplex a caller wires up.
 *
 * One request ⇒ one connection ⇒ one response: simple, and it means a hung or
 * half-closed daemon surfaces as a rejected promise rather than a wedged client.
 */

import { connect, type Socket } from "node:net";

import { type KeeperTransport } from "./client.ts";
import { FrameDecoder, encodeFrame } from "./daemon.ts";

/**
 * Build a {@link KeeperTransport} from a factory that opens a fresh connection
 * to keeperd. Each call connects, writes the framed request once connected,
 * resolves with the first decoded response frame, then closes. A socket error,
 * an unframable reply, or a close-before-response all reject.
 */
export function socketTransport(openConnection: () => Socket): KeeperTransport {
  return (request) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = openConnection();
      const decoder = new FrameDecoder();
      let settled = false;

      const settleOk = (value: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(value);
        // Fully tear the connection down (not a half-close): one request ⇒ one
        // connection, and a lingering half-open socket would keep the caller's
        // event loop — and the daemon's connection handler — alive.
        socket.destroy();
      };
      const settleErr = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
        socket.destroy();
      };

      socket.on("connect", () => socket.write(encodeFrame(request)));
      socket.on("data", (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch (err) {
          settleErr(new Error(`keeperd sent an unframable reply: ${String(err)}`));
          return;
        }
        if (frames.length > 0) settleOk(frames[0]);
      });
      socket.on("error", (err: Error) => settleErr(err));
      socket.on("close", () =>
        settleErr(new Error("keeperd closed the connection before sending a response")),
      );
    });
}

/** A {@link KeeperTransport} over a unix-domain socket at `socketPath`. */
export function unixSocketTransport(socketPath: string): KeeperTransport {
  return socketTransport(() => connect(socketPath));
}
