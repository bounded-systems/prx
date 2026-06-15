/**
 * Door wire framing (extracted from keeperd, GH-201 → prx-8vdr / prx-o92).
 *
 * The transport-agnostic substrate every actor-door shares: a length-prefixed
 * JSON frame codec ({@link encodeFrame} / {@link FrameDecoder}) and a
 * contract-agnostic unix-socket server ({@link runFramedServe}) with the GH-223
 * pidfile lifecycle. keeperd, beadsd, and the session-host all run over this —
 * the framing is identical regardless of the per-door request/response contract.
 *
 * What stays door-specific lives next to each door: the contract schema, the
 * request handler, and the `serveConnection` that validates + dispatches it.
 */

import { createServer, type Server, type Socket } from "node:net";
import { closeSync, constants as FS, existsSync, openSync, rmSync, writeSync } from "node:fs";

// ── wire framing: 4-byte big-endian length prefix + UTF-8 JSON ───────────────

const LENGTH_BYTES = 4;

/** Frame a value as `<uint32 length><json>`. */
export function encodeFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(LENGTH_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder: bytes arrive in arbitrary chunks; `push` returns every
 * complete frame now available (decoded JSON), buffering any partial tail.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (this.buffer.length >= LENGTH_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < LENGTH_BYTES + length) break;
      const json = this.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length).toString("utf8");
      this.buffer = this.buffer.subarray(LENGTH_BYTES + length);
      frames.push(JSON.parse(json));
    }
    return frames;
  }
}

/**
 * Bind a unix-socket server that hands each connection to `onConnection`, with
 * the GH-223 pidfile lifecycle. Contract-agnostic: it owns only the bind + the
 * pidfile (the framing/dispatch is the caller's `onConnection` — e.g.
 * keeperd's `serveConnection`, `serveSessionConnection` for the session
 * host). Resolves with the listening `Server` (close it to stop).
 */
export function runFramedServe(
  socketPath: string,
  pidfile: string | undefined,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  // A leftover socket file from a prior run makes `listen` throw EADDRINUSE.
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  const server = createServer(onConnection);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      if (pidfile !== undefined) {
        // O_NOFOLLOW refuses to follow a pre-planted symlink at this (predictable)
        // path, and 0600 restricts the pidfile — closing the insecure-temp-file
        // vector (CodeQL). O_TRUNC still overwrites a stale *regular* pidfile.
        const fd = openSync(pidfile, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o600);
        try {
          writeSync(fd, `${process.pid}\n`);
        } finally {
          closeSync(fd);
        }
        server.on("close", () => rmSync(pidfile, { force: true }));
      }
      resolve(server);
    });
  });
}
