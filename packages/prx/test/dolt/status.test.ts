// GH-2154: `prx dolt status` makes port connectivity the source of truth.
//
// The incident: `bd dolt status` reports "not running" because it inspects a
// per-worktree dolt path that does not exist for the shared server, while the
// server on :3308 is in fact reachable. A session that trusts that false
// negative spawns a duplicate server. These tests pin that the canonical
// `prx dolt status` decides up/down from `bd dolt show` connectivity — never
// from a pid/path heuristic — and surfaces the unpushed-commit stranding
// signal.

import { describe, expect, test } from "bun:test";

import {
  runDoltStatus,
  computeDoltServerId,
  type DoltLedger,
  type DoltStatusContext,
  type DoltStatusDeps,
  type DoltStatusSpawnResult,
} from "../../src/dolt/status.ts";
import { StatusOutput } from "../../src/dolt/schema.ts";

const CTX: DoltStatusContext = {
  repoRoot: "/repo",
  hostRepoSlug: "com.github/bdelanghe/ai-home",
  commonDir: "/repo/.git",
};

const SHOW_UP: DoltStatusSpawnResult = {
  status: 0,
  stdout: JSON.stringify({ port: 3308, database: "ai_home", connection_ok: true }),
};
const SHOW_DOWN: DoltStatusSpawnResult = {
  // The external `bd dolt show` errors / reports no connection when the
  // per-worktree path it inspects is missing.
  status: 0,
  stdout: JSON.stringify({ connection_ok: false }),
};

function makeDeps(opts: {
  show: DoltStatusSpawnResult;
  sql?: DoltStatusSpawnResult;
  ledger?: DoltLedger | null;
  pidAlive?: boolean;
}): { deps: DoltStatusDeps; logs: string[]; calls: string[] } {
  const logs: string[] = [];
  const calls: string[] = [];
  const deps: DoltStatusDeps = {
    spawn: (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "bd") return opts.show;
      if (file === "dolt") return opts.sql ?? { status: 1, stderr: "no sql stub" };
      return { status: 1, stderr: `unexpected spawn: ${file}` };
    },
    env: { BEADS_DIR: "/should/be/stripped", PATH: "/usr/bin" },
    resolveContext: () => CTX,
    readDoltLedger: () => opts.ledger ?? null,
    pidAlive: () => opts.pidAlive ?? false,
  };
  return { deps, logs, calls };
}

function run(deps: DoltStatusDeps, logs: string[]): StatusOutput {
  const exit = runDoltStatus(
    { repoPath: "/repo", format: "json" },
    { log: (l) => logs.push(l), error: () => {} },
    deps,
  );
  expect(exit).toBe(0);
  const out = StatusOutput.parse(JSON.parse(logs.join("\n")));
  return out;
}

describe("runDoltStatus connectivity-as-source-of-truth (GH-2154)", () => {
  test("regression #4: reachable server + missing per-worktree path ⇒ running/healthy", () => {
    // No ledger and no per-worktree dolt path — the exact incident shape that
    // false-negatived. Connectivity alone must drive the verdict.
    const { deps, logs } = makeDeps({ show: SHOW_UP, sql: { status: 0, stdout: JSON.stringify({ rows: [{ n: 0 }] }) } });
    const out = run(deps, logs);
    expect(out.healthy).toBe(true);
    expect(["running", "healthy"]).toContain(out.lifecycle);
    expect(out.port).toBe(3308);
  });

  test("#1/#2: reachable + no ledger ⇒ running/external, pid null (no false negative)", () => {
    const { deps, logs } = makeDeps({ show: SHOW_UP, sql: { status: 0, stdout: JSON.stringify({ rows: [{ n: 2 }] }) } });
    const out = run(deps, logs);
    expect(out.lifecycle).toBe("running");
    expect(out.owner).toBe("external");
    expect(out.healthy).toBe(true);
    expect(out.pid).toBeNull();
    expect(out.dsn).toBe("mysql://root@127.0.0.1:3308/ai_home");
  });

  test("#3: unpushed_commits populated from the live dolt_log count", () => {
    const { deps, logs, calls } = makeDeps({
      show: SHOW_UP,
      sql: { status: 0, stdout: JSON.stringify({ rows: [{ n: 160 }] }) },
    });
    const out = run(deps, logs);
    expect(out.unpushed_commits).toBe(160);
    expect(calls.some((c) => c.startsWith("dolt sql") && c.includes("dolt_log"))).toBe(true);
    // BEADS_DIR is stripped from the spawn env (parity with reconcile).
  });

  test("#3: unpushed_commits is null when the count query fails — verdict unaffected", () => {
    const { deps, logs } = makeDeps({
      show: SHOW_UP,
      sql: { status: 1, stderr: "connection refused" },
    });
    const out = run(deps, logs);
    expect(out.unpushed_commits).toBeNull();
    expect(out.healthy).toBe(true);
    expect(out.lifecycle).toBe("running");
  });

  test("down: unreachable + no ledger ⇒ stopped, unhealthy, unpushed null", () => {
    const { deps, logs } = makeDeps({ show: SHOW_DOWN });
    const out = run(deps, logs);
    expect(out.lifecycle).toBe("stopped");
    expect(out.healthy).toBe(false);
    expect(out.owner).toBeNull();
    expect(out.unpushed_commits).toBeNull();
    expect(out.port).toBeNull();
  });

  test("reachable + ledger ⇒ healthy/prx, pid from ledger", () => {
    const ledger: DoltLedger = { pid: 4242, port: 3308, dsn: "mysql://root@127.0.0.1:3308/ai_home" };
    const { deps, logs } = makeDeps({
      show: SHOW_UP,
      sql: { status: 0, stdout: JSON.stringify({ rows: [{ n: 0 }] }) },
      ledger,
    });
    const out = run(deps, logs);
    expect(out.lifecycle).toBe("healthy");
    expect(out.owner).toBe("prx");
    expect(out.healthy).toBe(true);
    expect(out.pid).toBe(4242);
  });

  test("orphaned: ledger present + unreachable + pid dead ⇒ orphaned", () => {
    const { deps, logs } = makeDeps({
      show: SHOW_DOWN,
      ledger: { pid: 999999, port: 3308 },
      pidAlive: false,
    });
    const out = run(deps, logs);
    expect(out.lifecycle).toBe("orphaned");
    expect(out.owner).toBe("prx");
    expect(out.healthy).toBe(false);
  });

  test("ledger present + unreachable + pid alive ⇒ running, unhealthy (not orphaned)", () => {
    const { deps, logs } = makeDeps({
      show: SHOW_DOWN,
      ledger: { pid: 4242, port: 3308 },
      pidAlive: true,
    });
    const out = run(deps, logs);
    expect(out.lifecycle).toBe("running");
    expect(out.healthy).toBe(false);
  });

  test("dolt_server_id is a stable 12-hex derived id when no ledger overrides it", () => {
    const { deps, logs } = makeDeps({ show: SHOW_UP, sql: { status: 0, stdout: JSON.stringify({ rows: [{ n: 0 }] }) } });
    const out = run(deps, logs);
    const expected = computeDoltServerId(CTX.hostRepoSlug, "/repo/.beads/dolt/ai_home");
    expect(out.dolt_server_id).toBe(expected);
    expect(out.dolt_server_id).toMatch(/^[a-f0-9]{12}$/);
  });

  test("unrecognized repo (no context) ⇒ error, exit 1", () => {
    const logs: string[] = [];
    const exit = runDoltStatus(
      { repoPath: "/not/a/repo", format: "json" },
      { log: (l) => logs.push(l), error: () => {} },
      { resolveContext: () => null },
    );
    expect(exit).toBe(1);
    const out = StatusOutput.parse(JSON.parse(logs.join("\n")));
    expect(out.lifecycle).toBe("stopped");
    expect(out.error).toBeDefined();
  });
});
