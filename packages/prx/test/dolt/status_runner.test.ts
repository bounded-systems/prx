// dolt/status — the `prx dolt status` lifecycle classifier. Fully injectable
// (spawn / resolveContext / readDoltLedger / pidAlive), so the connectivity
// probe, unpushed count, and every lifecycle verdict are covered without a live
// bd/dolt/git.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeDoltServerId,
  defaultResolveContext,
  runDoltStatus,
  type DoltLedger,
  type DoltStatusContext,
  type DoltStatusDeps,
  type DoltStatusSpawn,
} from "../../src/dolt/status.ts";

type R = { status: number | null; stdout?: string; stderr?: string; error?: Error };

const ctx: DoltStatusContext = {
  repoRoot: "/repo",
  hostRepoSlug: "owner/repo",
  commonDir: "/repo/.git",
};

const reachableShow = JSON.stringify({ connection_ok: true, port: 3307, database: "db" });

// Route by tool: bd dolt show (probe), dolt sql (unpushed), git (resolveContext).
const spawnFor = (resp: {
  show?: Partial<R>;
  sql?: Partial<R>;
  git?: (args: string[]) => Partial<R>;
}): DoltStatusSpawn =>
  ((file: string, args: string[]) => {
    if (file === "bd" && args[0] === "dolt" && args[1] === "show")
      return { status: 0, stdout: "", stderr: "", ...resp.show };
    if (file === "dolt" && args[0] === "sql")
      return { status: 0, stdout: "", stderr: "", ...resp.sql };
    if (file === "git" && resp.git) return { status: 0, stdout: "", stderr: "", ...resp.git(args) };
    return { status: 1, stdout: "", stderr: "" };
  }) as never;

const sink = () => {
  const logs: string[] = [];
  return { out: { log: (l: string) => logs.push(l), error: () => {} }, logs };
};

const run = (deps: DoltStatusDeps, format: "plain" | "json" = "plain") => {
  const s = sink();
  const code = runDoltStatus({ repoPath: "/repo", format }, s.out, deps);
  return { code, log: s.logs[0] ?? "" };
};

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "prx-dolt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── defaultResolveContext ─────────────────────────────────────────────────────

describe("defaultResolveContext", () => {
  const env = {} as NodeJS.ProcessEnv;
  const gitSpawn = (h: (args: string[]) => Partial<R>): DoltStatusSpawn =>
    ((_f: string, args: string[]) => ({ status: 0, stdout: "", stderr: "", ...h(args) })) as never;

  test("resolves repoRoot/commonDir/slug from git", () => {
    const r = defaultResolveContext(
      gitSpawn((args) => {
        if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
          return { status: 0, stdout: "/repo\n" };
        if (args[0] === "rev-parse" && args.includes("--git-common-dir"))
          return { status: 0, stdout: ".git\n" };
        if (args[0] === "remote")
          return { status: 0, stdout: "https://github.com/owner/repo.git\n" };
        return { status: 1 };
      }),
      env,
      "/repo",
    );
    expect(r).toEqual({
      repoRoot: "/repo",
      hostRepoSlug: "io.github/owner/repo",
      commonDir: "/repo/.git",
    });
  });

  test("null when toplevel / common-dir / origin / non-github cannot resolve", () => {
    expect(
      defaultResolveContext(
        gitSpawn(() => ({ status: 1 })),
        env,
        "/x",
      ),
    ).toBeNull(); // no toplevel
    expect(
      defaultResolveContext(
        gitSpawn((a) =>
          a.includes("--show-toplevel") ? { status: 0, stdout: "/r" } : { status: 1 },
        ),
        env,
        "/x",
      ),
    ).toBeNull(); // no common-dir
    const noOrigin = gitSpawn((a) =>
      a[0] === "rev-parse"
        ? { status: 0, stdout: a.includes("--git-common-dir") ? "/r/.git" : "/r" }
        : { status: 1 },
    );
    expect(defaultResolveContext(noOrigin, env, "/x")).toBeNull(); // no origin
    const nonGh = gitSpawn((a) =>
      a[0] === "remote"
        ? { status: 0, stdout: "git@gitlab.com:o/r.git" }
        : a.includes("--git-common-dir")
          ? { status: 0, stdout: "/r/.git" }
          : { status: 0, stdout: "/r" },
    );
    expect(defaultResolveContext(nonGh, env, "/x")).toBeNull(); // non-github host
  });
});

// ── runDoltStatus lifecycle matrix ────────────────────────────────────────────

describe("runDoltStatus", () => {
  const ledger: DoltLedger = {
    dolt_server_id: "abc",
    pid: 1234,
    port: 3307,
    dsn: "mysql://x",
  } as DoltLedger;

  test("no resolvable repo context → stopped, exit 1", () => {
    const { code, log } = run({ resolveContext: () => null });
    expect(code).toBe(1);
    expect(log).toMatch(/lifecycle: stopped/);
  });

  test("reachable + prx ledger → healthy, owner prx, unpushed counted", () => {
    const { code, log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => ledger,
      spawn: spawnFor({
        show: { stdout: reachableShow },
        sql: { stdout: JSON.stringify({ rows: [{ n: 3 }] }) },
      }),
    });
    expect(code).toBe(0);
    expect(log).toMatch(/lifecycle: healthy/);
    expect(log).toMatch(/owner:     prx/);
    expect(log).toMatch(/unpushed:  3/);
  });

  test("reachable + no ledger → running/external", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => null,
      spawn: spawnFor({ show: { stdout: reachableShow }, sql: { status: 1 } }), // unpushed query fails → unknown
    });
    expect(log).toMatch(/lifecycle: running/);
    expect(log).toMatch(/owner:     external/);
    expect(log).toMatch(/unpushed:  unknown/);
  });

  test("unreachable + ledger + live pid → running (unhealthy)", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => ledger,
      pidAlive: () => true,
      spawn: spawnFor({ show: { status: 1 } }),
    });
    expect(log).toMatch(/lifecycle: running/);
    expect(log).toMatch(/healthy:   false/);
  });

  test("unreachable + ledger + dead pid → orphaned", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => ledger,
      pidAlive: () => false,
      spawn: spawnFor({ show: { status: 1 } }),
    });
    expect(log).toMatch(/lifecycle: orphaned/);
  });

  test("unreachable + no ledger → stopped", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => null,
      spawn: spawnFor({ show: { status: 1 } }),
    });
    expect(log).toMatch(/lifecycle: stopped/);
  });

  test("probe tolerates malformed show json (→ down)", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => null,
      spawn: spawnFor({ show: { stdout: "{not json" } }),
    });
    expect(log).toMatch(/lifecycle: stopped/);
  });

  test("probe valid-json-but-not-connected → down", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => null,
      spawn: spawnFor({ show: { stdout: JSON.stringify({ connection_ok: false }) } }),
    });
    expect(log).toMatch(/lifecycle: stopped/);
  });

  test("reachable but unpushed query returns malformed json → unknown", () => {
    const { log } = run({
      resolveContext: () => ctx,
      readDoltLedger: () => null,
      spawn: spawnFor({ show: { stdout: reachableShow }, sql: { stdout: "{not json" } }),
    });
    expect(log).toMatch(/lifecycle: running/);
    expect(log).toMatch(/unpushed:  unknown/);
  });

  test("default spawn wrapper runs the real bd/dolt boundary (offline-safe)", () => {
    // No injected spawn → exercises the production spawn arrow via the probe.
    // resolveContext is injected so we don't need a real git repo; bd dolt show
    // is read-only and just reports down when unreachable.
    const s = sink();
    const code = runDoltStatus({ repoPath: "/repo", format: "plain" }, s.out, {
      resolveContext: () => ctx,
      readDoltLedger: () => null,
    });
    expect(code).toBe(0);
    expect(s.logs[0]).toMatch(/lifecycle:/);
  });

  test("json format round-trips the StatusOutput", () => {
    const { log } = run(
      {
        resolveContext: () => ctx,
        readDoltLedger: () => null,
        spawn: spawnFor({ show: { status: 1 } }),
      },
      "json",
    );
    expect(JSON.parse(log).lifecycle).toBe("stopped");
  });
});

// ── defaultReadDoltLedger (via the runDoltStatus default) ─────────────────────

describe("default dolt ledger read", () => {
  // Build the exact ledger path the runner derives, then drive it with the
  // default readDoltLedger (no injection) against a real temp commonDir.
  const ledgerPathFor = (commonDir: string) => {
    const doltPath = join(ctx.repoRoot, ".beads/dolt"); // probe down → no db
    const id = computeDoltServerId(ctx.hostRepoSlug, doltPath);
    return join(commonDir, "info", "dolt", `${id}.json`);
  };

  test("missing ledger file → treated as no ledger (stopped)", () => {
    const commonDir = fresh();
    const s = sink();
    const code = runDoltStatus({ repoPath: "/repo", format: "plain" }, s.out, {
      resolveContext: () => ({ ...ctx, commonDir }),
      spawn: spawnFor({ show: { status: 1 } }),
    });
    expect(code).toBe(0);
    expect(s.logs[0]).toMatch(/lifecycle: stopped/);
  });

  test("a valid ledger file is read by the default reader", () => {
    const commonDir = fresh();
    const p = ledgerPathFor(commonDir);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ dolt_server_id: "abc", pid: 9, port: 3307, dsn: "mysql://x" }),
    );
    const s = sink();
    runDoltStatus({ repoPath: "/repo", format: "plain" }, s.out, {
      resolveContext: () => ({ ...ctx, commonDir }),
      pidAlive: () => false,
      spawn: spawnFor({ show: { status: 1 } }),
    });
    // ledger present + unreachable + dead pid → orphaned.
    expect(s.logs[0]).toMatch(/lifecycle: orphaned/);
  });

  test("a malformed ledger file → treated as absent", () => {
    const commonDir = fresh();
    const p = ledgerPathFor(commonDir);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "{ not json");
    const s = sink();
    runDoltStatus({ repoPath: "/repo", format: "plain" }, s.out, {
      resolveContext: () => ({ ...ctx, commonDir }),
      spawn: spawnFor({ show: { status: 1 } }),
    });
    expect(s.logs[0]).toMatch(/lifecycle: stopped/);
  });
});
