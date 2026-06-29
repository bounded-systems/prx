import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Server } from "node:net";

import { doorBridgeVerb, type DoorBridgeDeps } from "../../src/door/bridge-verb.ts";
import type { LoopbackBridgeOptions } from "../../src/door/bridge.ts";

// A fake Server: an EventEmitter we can `emit("close")` to unblock the verb's
// run-until-killed loop, so the test terminates.
function fakeServer(): Server {
  return new EventEmitter() as unknown as Server;
}

describe("door bridge verb (prx-8uf2)", () => {
  test("forwards the requested port/socket to the loopback bridge and logs the caveat", async () => {
    const calls: LoopbackBridgeOptions[] = [];
    const logs: string[] = [];
    const server = fakeServer();
    const deps: DoorBridgeDeps = {
      bridge: (opts) => {
        calls.push(opts);
        return Promise.resolve(server);
      },
      log: (line) => logs.push(line),
    };

    const run = doorBridgeVerb.run({ port: 9998, socket: "/run/prx/doors/ghappd.sock" }, deps);
    // The verb blocks until the server closes — close it so run() resolves.
    queueMicrotask(() => server.emit("close"));
    const result = await run;

    expect(calls).toEqual([{ port: 9998, socketPath: "/run/prx/doors/ghappd.sock" }]);
    expect(result).toEqual({ port: 9998, socket: "/run/prx/doors/ghappd.sock" });
    // The startup line must name the security posture loudly.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("127.0.0.1:9998");
    expect(logs[0]).toContain("UNAUTHENTICATED");
  });
});
