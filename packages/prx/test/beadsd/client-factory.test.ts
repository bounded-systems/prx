import { describe, expect, test } from "bun:test";

import type { FramedTransport } from "../../src/door/transport.ts";
import {
  BeadsUnavailableError,
  defaultCanonicalBeadsCwd,
  ensureLocalBeadsd,
  resolveBeadsEndpoint,
  resolveLocalBeadsCwd,
  withBeadsClient,
  isHostNativeSocket,
  primeHostBeadsDoor,
  DEFAULT_LOCAL_BEADS_SOCKET,
} from "../../src/beadsd/client-factory.ts";

/** A fake env lookup over a fixed map. */
const fakeEnv = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

const okTransport: FramedTransport = async () => ({ status: "ok", result: [] });
/** No-op auto-start for tests that drive the client over a fake transport. */
const noEnsure = async () => {};

describe("resolveBeadsEndpoint — the read router (prx-82b Slice 2b)", () => {
  test("falls back to the host-native socket when no override + no pod up", () => {
    expect(resolveBeadsEndpoint(fakeEnv({}), { podSocket: () => null })).toEqual({
      kind: "local",
      socket: DEFAULT_LOCAL_BEADS_SOCKET,
    });
  });

  test("PRX_BEADS_SOCKET override wins over the pod (intra-pod + operator)", () => {
    expect(
      resolveBeadsEndpoint(fakeEnv({ PRX_BEADS_SOCKET: "/run/bd.sock" }), {
        podSocket: () => "/run/prx/doors/slug/beadsd.sock",
      }),
    ).toEqual({ kind: "local", socket: "/run/bd.sock" });
  });

  test("routes to the cwd's pod socket when that pod is up (no override)", () => {
    expect(
      resolveBeadsEndpoint(fakeEnv({}), {
        podSocket: () => "/run/prx/doors/io_github_x/beadsd.sock",
      }),
    ).toEqual({ kind: "local", socket: "/run/prx/doors/io_github_x/beadsd.sock" });
  });

  // The in-VM (`PRX_BEADS_VM`/Lima) endpoint was retired for the podman pod
  // (prx-zj8); the endpoint is always a local socket (pod door, override, or the
  // host-native fallback).
});

describe("isHostNativeSocket — auto-start gate (prx-82b Slice 2b)", () => {
  test("only the host-native default socket is auto-startable", () => {
    expect(isHostNativeSocket(DEFAULT_LOCAL_BEADS_SOCKET)).toBe(true);
    expect(isHostNativeSocket("/run/prx/doors/slug/beadsd.sock")).toBe(false);
    expect(isHostNativeSocket("/run/bd.sock")).toBe(false);
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
      resolveLocalBeadsCwd({
        env: fakeEnv({ PRX_BEADS_CWD: "", HOME: "/home/u" }),
        exists: neverExists,
        repoRoot,
      }),
    ).toBe("/repo/clone");
  });

  test("defaultCanonicalBeadsCwd is null without HOME", () => {
    expect(defaultCanonicalBeadsCwd(fakeEnv({}))).toBeNull();
    expect(defaultCanonicalBeadsCwd(fakeEnv({ HOME: "/home/u" }))).toBe(
      "/home/u/.local/state/prx/beads",
    );
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
      {
        endpoint: { kind: "local", socket: "/x.sock" },
        localTransport: () => okTransport,
        ensureUp: noEnsure,
      },
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

describe("primeHostBeadsDoor — host-shell read routing (prx-82b 2e.1)", () => {
  function harness(overrides: { door?: string; podSocket?: string | null }) {
    const set: Record<string, string> = {};
    const env = (k: string) => (k === "PRX_BEADS_DOOR" ? overrides.door : undefined);
    const result = primeHostBeadsDoor({
      env: env as never,
      setEnvVar: ((k: string, v: string) => {
        set[k] = v;
      }) as never,
      podSocket: () => overrides.podSocket ?? null,
    });
    return { result, set };
  }

  test("primes the door to the cwd's pod socket when a pod is up", () => {
    const { result, set } = harness({ podSocket: "/run/prx/doors/slug/beadsd.sock" });
    expect(result).toBe(true);
    expect(set).toEqual({
      PRX_BEADS_DOOR: "beadsd",
      PRX_BEADS_SOCKET: "/run/prx/doors/slug/beadsd.sock",
    });
  });

  test("no-op when no pod is up (host-native fallback stays)", () => {
    const { result, set } = harness({ podSocket: null });
    expect(result).toBe(false);
    expect(set).toEqual({});
  });

  test("no-op when already in a pod/room profile (PRX_BEADS_DOOR set)", () => {
    const { result, set } = harness({ door: "beadsd", podSocket: "/run/prx/doors/x/beadsd.sock" });
    expect(result).toBe(false);
    expect(set).toEqual({});
  });
});
