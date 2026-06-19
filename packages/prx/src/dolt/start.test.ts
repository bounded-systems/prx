import { describe, expect, test } from "bun:test";

import {
  buildServerArgv,
  defaultDeriveDatabase,
  runDoltStart,
  type DoltStartDeps,
} from "./start.ts";
import type { DoltLedger, DoltStatusContext } from "./status.ts";

const ctx: DoltStatusContext = {
  repoRoot: "/repo",
  hostRepoSlug: "bounded-systems/prx",
  commonDir: "/repo/.git",
};

const baseDeps = (over: Partial<DoltStartDeps> = {}): DoltStartDeps => ({
  resolveContext: () => ctx,
  deriveDatabase: defaultDeriveDatabase,
  probe: () => ({ reachable: false, port: null, database: null }),
  spawnServer: () => ({ pid: 4242 }),
  readLedger: () => null,
  writeLedger: () => {},
  sleep: async () => {},
  host: "127.0.0.1",
  port: 3307,
  probeMs: 0,
  maxProbes: 5,
  ...over,
});

describe("runDoltStart engine (DI; no live server)", () => {
  test("spawns, polls to healthy, writes the ledger, returns started", async () => {
    let wrote: (DoltLedger & { pid: number }) | null = null;
    let n = 0;
    const out = await runDoltStart(
      { repo_path: "/repo", detach: true },
      baseDeps({
        probe: () =>
          n++ === 0
            ? { reachable: false, port: null, database: null }
            : { reachable: true, port: 3307, database: "io_github_bounded_systems_prx" },
        spawnServer: () => ({ pid: 4242 }),
        writeLedger: (_p, l) => {
          wrote = l;
        },
      }),
    );
    expect(out.status).toBe("started");
    expect(out.pid).toBe(4242);
    expect(out.port).toBe(3307);
    expect(out.owner).toBe("prx");
    expect(out.dsn).toContain("io_github_bounded_systems_prx");
    expect(wrote!.pid).toBe(4242);
  });

  test("a prx-owned, already-reachable server is not double-started (exists)", async () => {
    const out = await runDoltStart(
      { repo_path: "/repo", detach: true },
      baseDeps({
        probe: () => ({ reachable: true, port: 3307, database: "db" }),
        readLedger: () => ({ dolt_server_id: "x", pid: 999 }),
      }),
    );
    expect(out.status).toBe("exists");
    expect(out.pid).toBe(999);
  });

  test("a reachable-but-unowned server is refused (→ adopt)", async () => {
    let threw = "";
    try {
      await runDoltStart(
        { repo_path: "/repo", detach: true },
        baseDeps({
          probe: () => ({ reachable: true, port: 3307, database: "db" }),
          readLedger: () => null,
        }),
      );
    } catch (e) {
      threw = String(e);
    }
    expect(threw).toContain("adopt");
  });

  test("a spawned server that never becomes healthy throws", async () => {
    let spawned = false;
    let threw = "";
    try {
      await runDoltStart(
        { repo_path: "/repo", detach: true },
        baseDeps({
          spawnServer: () => {
            spawned = true;
            return { pid: 7 };
          },
          maxProbes: 3,
        }),
      );
    } catch (e) {
      threw = String(e);
    }
    expect(spawned).toBe(true);
    expect(threw).toContain("never became reachable");
  });

  test("unresolvable repo context throws", async () => {
    let threw = "";
    try {
      await runDoltStart(
        { repo_path: "/x", detach: true },
        baseDeps({ resolveContext: () => null }),
      );
    } catch (e) {
      threw = String(e);
    }
    expect(threw).toContain("cannot resolve repo context");
  });

  test("argv + database-name defaults (reviewer flags F1/F3)", () => {
    expect(buildServerArgv("/d", "127.0.0.1", 3307)).toEqual([
      "dolt",
      "sql-server",
      "--data-dir",
      "/d",
      "--host",
      "127.0.0.1",
      "--port",
      "3307",
    ]);
    expect(defaultDeriveDatabase("bounded-systems/prx")).toBe("io_github_bounded_systems_prx");
  });
});
