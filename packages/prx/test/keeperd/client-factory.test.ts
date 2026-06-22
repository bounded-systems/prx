// withKeeperClient — assembles resolveKeeperEndpoint → resolveFramedTransport →
// IsolatedKeeperClient (prx-asr). The transport is injected so this is offline.

import { describe, expect, test } from "bun:test";

import type { FramedTransport } from "../../src/door/transport.ts";
import { withKeeperClient } from "../../src/keeperd/client-factory.ts";
import { IsolatedKeeperClient } from "../../src/keeperd/client.ts";

describe("withKeeperClient", () => {
  test("dials the injected endpoint's socket and runs fn with a keeper client", async () => {
    let dialed = "";
    const makeTransport = (endpoint: string): FramedTransport => {
      dialed = endpoint;
      return async () => ({});
    };
    const client = await withKeeperClient(async (c) => c, {
      endpoint: { socket: "/run/prx/doors/keeperd.sock" },
      makeTransport,
    });
    expect(dialed).toBe("/run/prx/doors/keeperd.sock");
    expect(client).toBeInstanceOf(IsolatedKeeperClient);
  });

  test("a host:port endpoint flows through unchanged (pod-local / gateway)", async () => {
    let dialed = "";
    const makeTransport = (endpoint: string): FramedTransport => {
      dialed = endpoint;
      return async () => ({});
    };
    await withKeeperClient(async (c) => c, {
      endpoint: { socket: "localhost:3002" },
      makeTransport,
    });
    expect(dialed).toBe("localhost:3002");
  });

  test("defaults resolve from the env + real transport factory (no connection until used)", async () => {
    // No deps: exercises the `?? resolveKeeperEndpoint` / `?? guestRoomKeeperTransport`
    // fallbacks. fn never calls the client, so the transport never connects.
    const client = await withKeeperClient(async (c) => c);
    expect(client).toBeInstanceOf(IsolatedKeeperClient);
  });
});
