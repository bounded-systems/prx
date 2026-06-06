import { describe, expect, test } from "bun:test";

import type { FramedTransport } from "../../src/keeperd/transport.ts";
import type { RunResult } from "../../src/keeperd/lima-exec.ts";
import {
  BeadsUnavailableError,
  resolveBeadsEndpoint,
  withBeadsClient,
  DEFAULT_LOCAL_BEADS_SOCKET,
  DEFAULT_VM_BEADS_SOCKET,
} from "../../src/beadsd/client-factory.ts";

/** A fake env lookup over a fixed map. */
const fakeEnv = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

const okTransport: FramedTransport = async () => ({ status: "ok", result: [] });

describe("resolveBeadsEndpoint", () => {
  test("defaults to a local socket", () => {
    expect(resolveBeadsEndpoint(fakeEnv({}))).toEqual({ kind: "local", socket: DEFAULT_LOCAL_BEADS_SOCKET });
  });

  test("PRX_BEADS_SOCKET overrides the local socket", () => {
    expect(resolveBeadsEndpoint(fakeEnv({ PRX_BEADS_SOCKET: "/run/bd.sock" }))).toEqual({
      kind: "local",
      socket: "/run/bd.sock",
    });
  });

  test("PRX_BEADS_VM selects the Lima VM daemon (+ default vm socket)", () => {
    expect(resolveBeadsEndpoint(fakeEnv({ PRX_BEADS_VM: "myvm" }))).toEqual({
      kind: "lima",
      vm: "myvm",
      vmSocket: DEFAULT_VM_BEADS_SOCKET,
    });
  });

  test("PRX_BEADS_VM_SOCKET overrides the in-VM socket", () => {
    expect(resolveBeadsEndpoint(fakeEnv({ PRX_BEADS_VM: "myvm", PRX_BEADS_VM_SOCKET: "/v/x.sock" }))).toEqual({
      kind: "lima",
      vm: "myvm",
      vmSocket: "/v/x.sock",
    });
  });
});

describe("withBeadsClient — local", () => {
  test("runs fn with a client over the local socket", async () => {
    let seen = false;
    const res = await withBeadsClient(
      async (client) => {
        seen = true;
        return client.query({ kind: "ready" });
      },
      { endpoint: { kind: "local", socket: "/x.sock" }, localTransport: () => okTransport },
    );
    expect(seen).toBe(true);
    expect(res.status).toBe("ok");
  });

  test("a connect-time failure becomes a BeadsUnavailableError with a start hint", async () => {
    const refused: FramedTransport = async () => {
      throw new Error("connect ECONNREFUSED /x.sock");
    };
    await expect(
      withBeadsClient((c) => c.query({ kind: "ready" }), {
        endpoint: { kind: "local", socket: "/x.sock" },
        localTransport: () => refused,
      }),
    ).rejects.toThrow(BeadsUnavailableError);
    await expect(
      withBeadsClient((c) => c.query({ kind: "ready" }), {
        endpoint: { kind: "local", socket: "/x.sock" },
        localTransport: () => refused,
      }),
    ).rejects.toThrow(/prx beads serve/);
  });

  test("a non-connection error propagates unchanged", async () => {
    const boom: FramedTransport = async () => {
      throw new Error("kaboom mid-query");
    };
    await expect(
      withBeadsClient((c) => c.query({ kind: "ready" }), {
        endpoint: { kind: "local", socket: "/x.sock" },
        localTransport: () => boom,
      }),
    ).rejects.toThrow(/kaboom/);
  });
});

describe("withBeadsClient — lima", () => {
  const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

  test("delegates to the Lima channel and runs fn", async () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]): RunResult => {
      calls.push([cmd, ...args]);
      if (cmd === "limactl") return ok("Host lima-myvm\n");
      return ok();
    };
    const res = await withBeadsClient((c) => c.query({ kind: "ready" }), {
      endpoint: { kind: "lima", vm: "myvm", vmSocket: "/tmp/beadsd.sock" },
      lima: { run, exists: () => true, sleep: async () => {}, makeTransport: () => okTransport },
    });
    expect(res.status).toBe("ok");
    // the Lima forward was opened (limactl show-ssh ran)
    expect(calls.some((c) => c[0] === "limactl" && c.includes("show-ssh"))).toBe(true);
  });
});
