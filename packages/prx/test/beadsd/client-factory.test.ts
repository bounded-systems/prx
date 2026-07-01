import { describe, expect, test } from "bun:test";

import type { CommandRunner } from "@bounded-systems/proc";

import type { FramedTransport } from "../../src/door/transport.ts";
import {
  BeadsUnavailableError,
  defaultCanonicalBeadsCwd,
  defaultPodBeadsSocket,
  resolveBeadsEndpoint,
  resolveLocalBeadsCwd,
  withBeadsClient,
  primeHostBeadsDoor,
} from "../../src/beadsd/client-factory.ts";

/** A run() that returns a given git-common-dir. */
const gitRun =
  (commonDir: string): CommandRunner =>
  () => ({ stdout: commonDir + "\n", stderr: "", status: 0 });
const neverExists = () => false;

/** A fake env lookup over a fixed map. */
const fakeEnv = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

const okTransport: FramedTransport = async () => ({ status: "ok", result: [] });
/** No-op auto-start for tests that drive the client over a fake transport. */
const noEnsure = async () => {};

describe("resolveBeadsEndpoint — derived from git-common-dir (prx-z7of)", () => {
  const gitCommonDir = "/bare/my-repo.git";
  const beadsDir = `${gitCommonDir}/.beads`;
  const perRepoSocket = `${beadsDir}/dolt-server.sock`;
  const allPresent = (p: string) => p === beadsDir || p === perRepoSocket;

  test("derives socket from git-common-dir + .beads/", () => {
    expect(
      resolveBeadsEndpoint(fakeEnv({}), { run: gitRun(gitCommonDir), exists: allPresent }),
    ).toEqual({ kind: "local", socket: perRepoSocket });
  });

  test("PRX_BEADS_SOCKET overrides the derived socket (pod routing primes this)", () => {
    expect(
      resolveBeadsEndpoint(fakeEnv({ PRX_BEADS_SOCKET: "/run/prx/doors/slug/beadsd.sock" }), {
        run: gitRun(gitCommonDir),
        exists: allPresent,
      }),
    ).toEqual({ kind: "local", socket: "/run/prx/doors/slug/beadsd.sock" });
  });

  test("PRX_BEADS_SOCKET bypasses derivation entirely (trust the caller)", () => {
    // No .beads/ exists — still works because PRX_BEADS_SOCKET is a complete bypass
    expect(
      resolveBeadsEndpoint(fakeEnv({ PRX_BEADS_SOCKET: "/run/prx/doors/slug/beadsd.sock" }), {
        run: gitRun(gitCommonDir),
        exists: neverExists,
      }),
    ).toEqual({ kind: "local", socket: "/run/prx/doors/slug/beadsd.sock" });
  });

  test(".beads/ exists but socket missing → error with start hint", () => {
    expect(() =>
      resolveBeadsEndpoint(fakeEnv({}), {
        run: gitRun(gitCommonDir),
        exists: (p) => p === beadsDir,
      }),
    ).toThrow(BeadsUnavailableError);
    expect(() =>
      resolveBeadsEndpoint(fakeEnv({}), {
        run: gitRun(gitCommonDir),
        exists: (p) => p === beadsDir,
      }),
    ).toThrow(/prx beads serve/);
  });

  test("repo has no .beads/ → error (not configured)", () => {
    expect(() =>
      resolveBeadsEndpoint(fakeEnv({}), { run: gitRun(gitCommonDir), exists: neverExists }),
    ).toThrow(/not beads-configured/);
  });

  test("not in a git repo → error", () => {
    const notGit: CommandRunner = () => {
      throw new Error("fatal: not a git repository");
    };
    expect(() =>
      resolveBeadsEndpoint(fakeEnv({}), { run: notGit, exists: neverExists }),
    ).toThrow(BeadsUnavailableError);
  });

  // The in-VM (`PRX_BEADS_VM`/Lima) and host-native fallbacks are retired.
  // Pod routing primes PRX_BEADS_SOCKET via primeHostBeadsDoor — no inline pod discovery.

  // prx-d8hc: a normal (non-bare) checkout run from its own root gets a bare
  // relative ".git" from `git rev-parse --git-common-dir` with no format flag
  // — join(".git", ".beads") then misses the real .beads/ (a sibling of
  // .git, not nested under it). Requesting --path-format=absolute fixes it.
  test("prx-d8hc: requests --path-format=absolute so a non-bare checkout resolves correctly", () => {
    const repoRoot = "/home/dev/prx";
    const beadsDir = `${repoRoot}/.beads`;
    const perRepoSocket = `${beadsDir}/dolt-server.sock`;
    const allPresentAtRoot = (p: string) => p === beadsDir || p === perRepoSocket;

    let capturedArgv: string[] | undefined;
    // Mimics real git: relative ".git" WITHOUT the absolute flag, the correct
    // absolute repo root WITH it — the exact difference that caused prx-d8hc.
    const gitLikeRun: CommandRunner = (argv) => {
      capturedArgv = argv;
      const stdout = argv.includes("--path-format=absolute") ? repoRoot : ".git";
      return { stdout: `${stdout}\n`, stderr: "", status: 0 };
    };

    expect(
      resolveBeadsEndpoint(fakeEnv({}), { run: gitLikeRun, exists: allPresentAtRoot }),
    ).toEqual({ kind: "local", socket: perRepoSocket });
    expect(capturedArgv).toEqual(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  });
});

describe("resolveLocalBeadsCwd — which beads `prx beads serve` serves (GH-296)", () => {
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

// prx-82b Slice 2e.4: `ensureLocalBeadsd` (the host auto-start) was removed —
// prx never spawns a host beadsd; the pod owns it. No tests to keep here.

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

  test("no-op when no pod is up (2e.4: reads then fail at resolve, no fallback)", () => {
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

describe("defaultPodBeadsSocket — never primes toward the ambient legacy singleton (ocap)", () => {
  test("registered repo (slug resolved) → checks its OWN per-repo door", () => {
    const socket = defaultPodBeadsSocket({
      repoRoot: () => "/home/dev/supply-plan-design",
      resolvePod: () => ({
        slug: "supply-plan-design",
        name: "prx-supply-plan-design",
        doorDir: "/run/prx/doors/supply-plan-design",
      }),
      exists: (p) => p === "/run/prx/doors/supply-plan-design/beadsd.sock",
    });
    expect(socket).toBe("/run/prx/doors/supply-plan-design/beadsd.sock");
  });

  test("unregistered repo (slug null) → returns null WITHOUT checking the legacy singleton path", () => {
    let checkedPaths: string[] = [];
    const socket = defaultPodBeadsSocket({
      repoRoot: () => "/home/dev/some-ad-hoc-clone",
      resolvePod: () => ({ slug: null, name: "prx-pod", doorDir: "/run/prx/doors" }),
      // Even if something IS listening at the shared singleton path, this must
      // never be consulted for an unregistered cwd — that's the ambient-authority
      // leak (a process for repo A reaching whatever repo B's door happens to serve).
      exists: (p) => {
        checkedPaths.push(p);
        return true;
      },
    });
    expect(socket).toBeNull();
    expect(checkedPaths).toEqual([]);
  });

  test("registered repo but its own per-repo door isn't up → null (no fallback to the singleton)", () => {
    const socket = defaultPodBeadsSocket({
      repoRoot: () => "/home/dev/prx",
      resolvePod: () => ({ slug: "prx", name: "prx-prx", doorDir: "/run/prx/doors/prx" }),
      exists: () => false,
    });
    expect(socket).toBeNull();
  });
});
