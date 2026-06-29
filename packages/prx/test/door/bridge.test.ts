import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AddressInfo,
  type Server,
  type Socket,
  connect,
  createServer,
} from "node:net";

import { BRIDGE_BIND_ADDRESS, runLoopbackBridge } from "../../src/door/bridge.ts";

// A short, unique socket path directly in tmpdir() — mirrors transport.test.ts.
// Unix `sun_path` caps at ~104 bytes, so a flat name (no nested dir) keeps it
// well under the limit regardless of where tmpdir() resolves.
let counter = 0;
function freshSocketPath(): string {
  return join(tmpdir(), `prx-bridge-${process.pid}-${counter++}.sock`);
}

// A throwaway unix-socket "door": every connection echoes back whatever it
// receives. Stands in for a real daemon (keeperd/forge-d) — the bridge is
// frame-transparent, so an echo is a faithful upstream.
function echoDoor(socketPath: string): Promise<Server> {
  const server = createServer((c) => c.pipe(c));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

/** Open a loopback TCP client to `port`, write `payload`, resolve its reply. */
function roundtrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = connect({ host: "127.0.0.1", port }, () => client.write(payload));
    const chunks: Buffer[] = [];
    client.on("data", (d: Buffer) => {
      chunks.push(d);
      // The echo returns exactly as many bytes as we sent — settle once we have them.
      if (Buffer.concat(chunks).length >= payload.length) {
        resolve(Buffer.concat(chunks));
        client.end();
      }
    });
    client.on("error", reject);
  });
}

describe("door loopback bridge (prx-8uf2)", () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const socketPaths: string[] = [];
  // Track each server/socket for teardown; "listen" discriminates Server vs Socket.
  const closers = {
    push(s: Server | Socket): void {
      if ("listen" in s) servers.push(s);
      else sockets.push(s);
    },
  };

  afterEach(() => {
    for (const s of sockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) s.close();
    for (const p of socketPaths.splice(0)) rmSync(p, { force: true });
  });

  function tmpSocket(): string {
    const p = freshSocketPath();
    socketPaths.push(p);
    return p;
  }

  test("forwards bytes transparently between a loopback TCP client and the door socket", async () => {
    const sock = tmpSocket();
    const door = await echoDoor(sock);
    closers.push(door);
    const bridge = await runLoopbackBridge({ port: 0, socketPath: sock });
    closers.push(bridge);

    // A length-prefixed door frame stands in for real traffic: the bridge must
    // not mangle it (it forwards bytes, it does not parse frames).
    const frame = Buffer.from([0x00, 0x00, 0x00, 0x05, ...Buffer.from("hello")]);
    const reply = await roundtrip(portOf(bridge), frame);
    expect(reply.equals(frame)).toBe(true);
  });

  test("binds the loopback interface only — never the wildcard", async () => {
    const sock = tmpSocket();
    const door = await echoDoor(sock);
    closers.push(door);
    const bridge = await runLoopbackBridge({ port: 0, socketPath: sock });
    closers.push(bridge);

    const addr = bridge.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    expect(BRIDGE_BIND_ADDRESS).toBe("127.0.0.1");
    // Defence in depth: it must not be listening on the wildcard interface.
    expect(addr.address).not.toBe("0.0.0.0");
  });

  test("tears the upstream door connection down when the TCP client disconnects", async () => {
    const sock = tmpSocket();
    let upstream: Socket | undefined;
    const closed = new Promise<void>((resolve) => {
      const server = createServer((c) => {
        upstream = c;
        c.pipe(c);
        c.on("close", () => resolve());
      });
      server.listen(sock);
      closers.push(server);
    });

    const bridge = await runLoopbackBridge({ port: 0, socketPath: sock });
    closers.push(bridge);

    const client = connect({ host: "127.0.0.1", port: portOf(bridge) }, () => {
      client.write(Buffer.from("x"));
      // Once the byte is in flight, drop the client — the upstream must follow.
      client.on("data", () => client.destroy());
    });
    closers.push(client);

    await closed; // resolves only if the upstream socket was torn down
    expect(upstream).toBeDefined();
  });
});
