import { describe, expect, test } from "bun:test";

import type { FramedTransport } from "../../src/keeperd/transport.ts";
import type { RunResult } from "../../src/keeperd/lima-exec.ts";
import {
  BeadsUnavailableError,
  defaultCanonicalBeadsCwd,
  ensureLocalBeadsd,
  resolveBeadsEndpoint,
  resolveLocalBeadsCwd,
  withBeadsClient,
  DEFAULT_LOCAL_BEADS_SOCKET,
  DEFAULT_VM_BEADS_SOCKET,
} from "../../src/beadsd/client-factory.ts";

/** A fake env lookup over a fixed map. */
const fakeEnv = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

const okTransport: FramedTransport = async () => ({ status: "ok", result: [] });
/** No-op auto-start for tests that drive the client over a fake transport. */
const noEnsure = async () => {};

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

describe("resolveLocalBeadsCwd — which beads the local daemon serves (GH-296)", () => {
  const neverExists = () => false;
  const alwaysExists = () => true;
  const repoRoot = () => "/repo/clone";

  test("PRX_BEADS_CWD wins (explicit canonical clone)", () => {
    expect(
      resolveLocalBeadsCwd({
        env: fakeEnv({ PRX_BEADS_CWD: "/canon/beads", HOME: "/home/u" }),
        exists: alwaysExists,
        repoRoot,
      }),
    ).toBe("/canon/beads");
  });

  test("falls back to the well-known ~/.local/state/prx/beads when it exists", () => {
    expect(
      resolveLocalBeadsCwd({ env: fakeEnv({ HOME: "/home/u" }), exists: alwaysExists, repoRoot }),
    ).toBe("/home/u/.local/state/prx/beads");
  });

  test("falls back to the repo root when no override and no canonical clone", () => {
    expect(
      resolveLocalBeadsCwd({ env: fakeEnv({ HOME: "/home/u" }), exists: neverExists, repoRoot }),
    ).toBe("/repo/clone");
  });

  test("ignores an empty PRX_BEADS_CWD", () => {
    expect(
      resolveLocalBeadsCwd({ env: fakeEnv({ PRX_BEADS_CWD: "", HOME: "/home/u" }), exists: neverExists, repoRoot }),
    ).toBe("/repo/clone");
  });

  test("defaultCanonicalBeadsCwd is null without HOME", () => {
    expect(defaultCanonicalBeadsCwd(fakeEnv({}))).toBeNull();
    expect(defaultCanonicalBeadsCwd(fakeEnv({ HOME: "/home/u" }))).toBe("/home/u/.local/state/prx/beads");
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
      { endpoint: { kind: "local", socket: "/x.sock" }, localTransport: () => okTransport, ensureUp: noEnsure },
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
        ensureUp: noEnsure,
      }),
    ).rejects.toThrow(BeadsUnavailableError);
    await expect(
      withBeadsClient((c) => c.query({ kind: "ready" }), {
        endpoint: { kind: "local", socket: "/x.sock" },
        localTransport: () => refused,
        ensureUp: noEnsure,
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
        ensureUp: noEnsure,
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

describe("ensureLocalBeadsd", () => {
  test("no-op when already up (does not spawn)", async () => {
    let spawned = 0;
    await ensureLocalBeadsd(
      { socket: "/s.sock", cwd: "/repo" },
      { isUp: async () => true, spawn: () => (spawned++, { pid: 1 }), sleep: async () => {} },
    );
    expect(spawned).toBe(0);
  });

  test("spawns `prx beads serve` against the repo, then waits until ready", async () => {
    let up = false;
    const spawns: string[][] = [];
    await ensureLocalBeadsd(
      { socket: "/s.sock", cwd: "/repo" },
      {
        isUp: async () => up, // down until the spawn flips it
        spawn: (cmd) => {
          spawns.push(cmd);
          up = true;
          return { pid: 42 };
        },
        sleep: async () => {},
      },
    );
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual([
      "prx",
      "beads",
      "serve",
      "--socket",
      "/s.sock",
      "--cwd",
      "/repo",
      "--pidfile",
      "/s.sock.pid",
    ]);
  });

  test("throws BeadsUnavailableError if it never becomes ready", async () => {
    await expect(
      ensureLocalBeadsd(
        { socket: "/s.sock", cwd: "/repo", readyTimeoutMs: 100 },
        { isUp: async () => false, spawn: () => ({ pid: 1 }), sleep: async () => {} },
      ),
    ).rejects.toThrow(BeadsUnavailableError);
  });
});
