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

import { FrameDecoder, encodeFrame } from "./framing.ts";

/**
 * A framed request/response channel: send one value, get the daemon's first
 * decoded reply frame back. Request-agnostic on purpose — the framing is the
 * same length-prefixed JSON regardless of contract, so the keeperd client
 * ({@link ./client.KeeperTransport}) and the session-host client both run over
 * it. (Assignable to the narrower {@link ./client.KeeperTransport}.)
 */
export type FramedTransport = (request: unknown) => Promise<unknown>;

/**
 * Build a {@link FramedTransport} from a factory that opens a fresh connection
 * to the daemon. Each call connects, writes the framed request once connected,
 * resolves with the first decoded response frame, then closes. A socket error,
 * an unframable reply, or a close-before-response all reject.
 */
export function socketTransport(openConnection: () => Socket): FramedTransport {
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

/** A {@link FramedTransport} over a unix-domain socket at `socketPath`. */
export function unixSocketTransport(socketPath: string): FramedTransport {
  return socketTransport(() => connect(socketPath));
}

/**
 * A {@link FramedTransport} over a TCP socket at `host:port`. The host-gateway
 * case (podman `host.containers.internal:PORT`, macOS) and the pod-local case
 * (`localhost:PORT` in a shared netns) both land here — the door is reachable
 * over TCP where a unix socket can't cross a VM/virtiofs hop.
 */
export function tcpSocketTransport(host: string, port: number): FramedTransport {
  return socketTransport(() => connect({ host, port }));
}

/** A door endpoint, parsed from the launcher's env string. */
export type DoorEndpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number };

/**
 * Parse a door endpoint string into its transport kind — the ONE place that
 * decides unix-vs-TCP, so every door client is transport-agnostic (prx-o92):
 *
 *   "/run/scoutd.sock"                  → unix  (a path)
 *   "unix:///run/scoutd.sock"           → unix
 *   "host.containers.internal:3002"     → tcp   (host-gateway, macOS)
 *   "127.0.0.1:3128" / "localhost:3002" → tcp   (pod-local)
 *   "tcp://localhost:3002"              → tcp
 *
 * A leading "/" always means a unix path, so a socket path that happens to
 * contain ":" stays unix.
 */
export function parseDoorEndpoint(endpoint: string): DoorEndpoint {
  const stripped = endpoint.replace(/^unix:\/\//, "");
  if (!stripped.startsWith("/")) {
    const m = stripped.replace(/^tcp:\/\//, "").match(/^([^/\s]+):(\d{1,5})$/);
    if (m) return { kind: "tcp", host: m[1]!, port: Number(m[2]) };
  }
  return { kind: "unix", path: stripped };
}

/**
 * Build a {@link FramedTransport} from an endpoint string, choosing unix or TCP
 * via {@link parseDoorEndpoint}. This is what lets one door client speak to a
 * mounted socket (Linux/pod) OR a host-gateway / pod-local TCP port (macOS) with
 * no per-door code — the heart of the actor-door transport unification.
 */
export function resolveFramedTransport(endpoint: string): FramedTransport {
  const ep = parseDoorEndpoint(endpoint);
  return ep.kind === "tcp" ? tcpSocketTransport(ep.host, ep.port) : unixSocketTransport(ep.path);
}
