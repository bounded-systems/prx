/**
 * Transport-agnostic door dialing (prx-o92).
 *
 * The gap this closes: door clients hardcoded `unixSocketTransport`, so an
 * endpoint like `host.containers.internal:3002` (claude-box TCP / pod mode) was
 * dialed as a unix PATH → "scout dead, net alive". `parseDoorEndpoint` is the one
 * place that decides unix-vs-TCP; `resolveFramedTransport` dials accordingly.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import { encodeFrame, FrameDecoder } from "./daemon.ts";
import { parseDoorEndpoint, resolveFramedTransport } from "./transport.ts";

describe("parseDoorEndpoint", () => {
  test("a path is a unix socket", () => {
    expect(parseDoorEndpoint("/run/scoutd.sock")).toEqual({
      kind: "unix",
      path: "/run/scoutd.sock",
    });
  });

  test("unix:// scheme is a unix socket", () => {
    expect(parseDoorEndpoint("unix:///run/keeperd.sock")).toEqual({
      kind: "unix",
      path: "/run/keeperd.sock",
    });
  });

  test("host:port is TCP (host-gateway, macOS)", () => {
    expect(parseDoorEndpoint("host.containers.internal:3002")).toEqual({
      kind: "tcp",
      host: "host.containers.internal",
      port: 3002,
    });
  });

  test("127.0.0.1:port and localhost:port are TCP (pod-local)", () => {
    expect(parseDoorEndpoint("127.0.0.1:3128")).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 3128,
    });
    expect(parseDoorEndpoint("localhost:3002")).toEqual({
      kind: "tcp",
      host: "localhost",
      port: 3002,
    });
  });

  test("tcp:// scheme is TCP", () => {
    expect(parseDoorEndpoint("tcp://localhost:3002")).toEqual({
      kind: "tcp",
      host: "localhost",
      port: 3002,
    });
  });

  test("a path containing ':' stays unix (leading / wins)", () => {
    expect(parseDoorEndpoint("/tmp/weird:3002")).toEqual({
      kind: "unix",
      path: "/tmp/weird:3002",
    });
  });
});

describe("resolveFramedTransport", () => {
  test("returns a callable transport for both kinds", () => {
    expect(typeof resolveFramedTransport("/run/scoutd.sock")).toBe("function");
    expect(typeof resolveFramedTransport("host.containers.internal:3002")).toBe("function");
  });

  test("dials a real TCP door end-to-end (the previously-broken case)", async () => {
    // A framed echo "door" on an ephemeral TCP port.
    const server = createServer((sock) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          sock.write(encodeFrame({ echo: frame }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    try {
      const transport = resolveFramedTransport(`127.0.0.1:${port}`);
      const reply = await transport({ hello: "tcp" });
      expect(reply).toEqual({ echo: { hello: "tcp" } });
    } finally {
      server.close();
    }
  });
});
