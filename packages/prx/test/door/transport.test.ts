// The bespoke length-prefixed framed transport (`door/transport.ts`) is still
// the wire for beadsd / session-host (the keeper door moved to the guest-room
// protocol in the prx→guest-room convergence, A2). These tests exercise it
// against a GENERIC frame-echo server — decoupled from any one daemon.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FrameDecoder, encodeFrame } from "../../src/door/framing.ts";
import { parseDoorEndpoint, unixSocketTransport } from "../../src/door/transport.ts";

describe("framed transport over a unix socket (generic echo server)", () => {
  let server: Server | undefined;
  let counter = 0;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  function serveEcho(reply: (req: unknown) => unknown): Promise<string> {
    const socketPath = join(tmpdir(), `tx-echo-${process.pid}-${counter++}.sock`);
    server = createServer((sock) => {
      const dec = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        for (const req of dec.push(chunk)) sock.write(encodeFrame(reply(req)));
      });
    });
    return new Promise((resolve) => server!.listen(socketPath, () => resolve(socketPath)));
  }

  test("round-trips one request to one response frame", async () => {
    const path = await serveEcho((req) => ({ echoed: req }));
    const res = await unixSocketTransport(path)({ hello: "world" });
    expect(res).toEqual({ echoed: { hello: "world" } });
  });

  test("rejects when the daemon closes before replying", async () => {
    const socketPath = join(tmpdir(), `tx-close-${process.pid}-${counter++}.sock`);
    server = createServer((sock) => sock.destroy());
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));
    await expect(unixSocketTransport(socketPath)({ a: 1 })).rejects.toThrow();
  });
});

describe("parseDoorEndpoint", () => {
  test("a path is unix", () => {
    expect(parseDoorEndpoint("/run/x.sock")).toEqual({ kind: "unix", path: "/run/x.sock" });
  });
  test("a unix:// prefix is unix", () => {
    expect(parseDoorEndpoint("unix:///run/x.sock")).toEqual({ kind: "unix", path: "/run/x.sock" });
  });
  test("host:port is tcp", () => {
    expect(parseDoorEndpoint("host.containers.internal:3002")).toEqual({
      kind: "tcp",
      host: "host.containers.internal",
      port: 3002,
    });
  });
  test("a tcp:// prefix is tcp", () => {
    expect(parseDoorEndpoint("tcp://localhost:3002")).toEqual({
      kind: "tcp",
      host: "localhost",
      port: 3002,
    });
  });
});
