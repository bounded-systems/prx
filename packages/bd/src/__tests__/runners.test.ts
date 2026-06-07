// The bd capability seam's command wrappers. execBd's spawn and every
// `bd github`/show/admin/duplicates/doctor/merge helper take an injectable
// runner, so the policy gate + result-shaping branches are covered without a
// real bd/gh binary. The two real-spawn paths (defaultBdGithubRunner) use
// harmless commands.

import { describe, expect, test } from "bun:test";

import {
  defaultBdGithubRunner,
  execBd,
  formatBdExecResult,
  runBdAdminCompact,
  runBdDoctorFix,
  runBdDoctorJson,
  runBdDuplicatesDryRun,
  runBdMerge,
  runBdShow,
  type BdExecResult,
  type BdGithubRunner,
  type BdGithubRunResult,
  type BdSpawnFn,
} from "@bounded-systems/bd";
import { blockedSubcommands } from "@bounded-systems/policy";

// ── fakes ───────────────────────────────────────────────────────────────────

const spawnReturning = (r: {
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}): BdSpawnFn =>
  (() => ({ status: 0, signal: null, stdout: "", stderr: "", ...r })) as unknown as BdSpawnFn;

const runnerReturning = (r: Partial<BdGithubRunResult>): BdGithubRunner =>
  () => ({ stdout: "", stderr: "", status: 0, ...r });

// ── execBd ──────────────────────────────────────────────────────────────────

describe("execBd", () => {
  test("bd admin admits only 'compact'", () => {
    const r = execBd({ subcommand: "admin", args: ["cleanup"] }, {}, spawnReturning({}));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/admits only 'compact'/);
  });

  test("bd admin with missing subarg reports <missing>", () => {
    const r = execBd({ subcommand: "admin", args: [] }, {}, spawnReturning({}));
    expect(r.stderr).toMatch(/<missing>/);
  });

  test("bd admin compact passes the gate and spawns (planner)", () => {
    const r = execBd(
      { subcommand: "admin", args: ["compact"], state: "planning", role: "planner" },
      {},
      spawnReturning({ status: 0, stdout: "compacted" }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("compacted");
  });

  test("rejects every policy-blocked subcommand (single source of truth)", () => {
    // The bd wrapper no longer keeps a second blocked list; policy's
    // `BLOCKED.bd` is authoritative and enforced via isBlocked. This pins both
    // the set and the behavior, so a future divergence trips here.
    const blocked = blockedSubcommands("bd");
    expect([...blocked].sort()).toEqual(
      ["archive", "close", "delete", "export", "import"],
    );
    for (const sub of blocked) {
      const r = execBd({ subcommand: sub, args: [] }, {}, spawnReturning({ status: 0, stdout: "should-not-run" }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/blocked subcommand/);
      expect(r.stdout).toBe("");
    }
  });

  test("bd sql injects --readonly before the caller args", () => {
    const seen: string[][] = [];
    const spy: BdSpawnFn = ((cmd: string[]) => {
      seen.push(cmd);
      return { status: 0, signal: null, stdout: "[]", stderr: "" };
    }) as unknown as BdSpawnFn;
    execBd(
      { subcommand: "sql", args: ["SELECT 1"], state: "planning", role: "planner" },
      {},
      spy,
    );
    expect(seen[0]).toEqual(["bd", "sql", "--readonly", "SELECT 1"]);
  });
});

// ── formatBdExecResult ────────────────────────────────────────────────────────

describe("formatBdExecResult", () => {
  const failed: BdExecResult = { exitCode: 1, stdout: "", stderr: "bd-safe: nope", policy: null };
  test("json renders the whole result", () => {
    expect(JSON.parse(formatBdExecResult(failed, "json"))).toEqual(failed);
  });
  test("plain surfaces stderr on failure", () => {
    expect(formatBdExecResult(failed, "plain")).toBe("bd-safe: nope");
  });
  test("plain returns stdout on success", () => {
    const ok: BdExecResult = { exitCode: 0, stdout: "rows\n", stderr: "", policy: null };
    expect(formatBdExecResult(ok, "plain")).toBe("rows");
  });
});

// ── defaultBdGithubRunner (real spawn) ────────────────────────────────────────

describe("defaultBdGithubRunner", () => {
  test("returns stdout for a clean command", () => {
    const r = defaultBdGithubRunner(["echo", "hi"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });
  test("maps a spawn error (missing binary) to a failure", () => {
    const r = defaultBdGithubRunner(["bd-definitely-not-a-real-binary-xyz"]);
    expect(r.status).not.toBe(0);
  });
});

// ── runBdShow ─────────────────────────────────────────────────────────────────

describe("runBdShow", () => {
  test("ok on a well-formed single-record array", () => {
    const r = runBdShow("GH-1", "/tmp", runnerReturning({ stdout: JSON.stringify([{ id: "GH-1", title: "t" }]) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.id).toBe("GH-1");
  });
  test("fails on non-zero exit", () => {
    const r = runBdShow("GH-1", "/tmp", runnerReturning({ status: 2, stderr: "boom" }));
    expect(r.ok).toBe(false);
  });
  test("fails on unparseable JSON", () => {
    const r = runBdShow("GH-1", "/tmp", runnerReturning({ stdout: "not json" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stderr).toMatch(/failed to parse JSON/);
  });
  test("fails on an empty array (no record)", () => {
    const r = runBdShow("GH-1", "/tmp", runnerReturning({ stdout: "[]" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stderr).toMatch(/no record/);
  });
  test("fails on a schema mismatch", () => {
    const r = runBdShow("GH-1", "/tmp", runnerReturning({ stdout: JSON.stringify([{ id: 123 }]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stderr).toMatch(/schema mismatch/);
  });
});

// ── runBdAdminCompact ─────────────────────────────────────────────────────────

describe("runBdAdminCompact", () => {
  test("empty id list yields exit 0 and no rows", () => {
    const r = runBdAdminCompact("/tmp", { dryRun: false, ids: [] }, runnerReturning({}));
    expect(r).toEqual({ exitCode: 0, results: [] });
  });
  test("aggregates per-id rows and reports the worst exit (dry-run)", () => {
    const calls: string[][] = [];
    const runner: BdGithubRunner = (cmd) => {
      calls.push(cmd);
      return { stdout: "", stderr: "", status: cmd.includes("bad") ? 3 : 0 };
    };
    const r = runBdAdminCompact("/tmp", { dryRun: true, ids: ["ok", "bad"] }, runner);
    expect(r.exitCode).toBe(3);
    expect(r.results).toHaveLength(2);
    expect(calls[0]).toContain("--dry-run");
  });
});

// ── runBdDuplicatesDryRun ─────────────────────────────────────────────────────

describe("runBdDuplicatesDryRun", () => {
  const cluster = { target: { beadsId: "a" }, sources: [{ beadsId: "b" }] };
  test("non-zero exit returns no clusters", () => {
    const r = runBdDuplicatesDryRun("/tmp", runnerReturning({ status: 1, stderr: "x" }));
    expect(r.clusters).toEqual([]);
    expect(r.exitCode).toBe(1);
  });
  test("unparseable JSON fails closed", () => {
    const r = runBdDuplicatesDryRun("/tmp", runnerReturning({ stdout: "nope" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/failed to parse JSON/);
  });
  test("accepts a bare array and normalizes it", () => {
    const r = runBdDuplicatesDryRun("/tmp", runnerReturning({ stdout: JSON.stringify([cluster]) }));
    expect(r.exitCode).toBe(0);
    expect(r.clusters).toHaveLength(1);
  });
  test("accepts a { clusters } envelope", () => {
    const r = runBdDuplicatesDryRun("/tmp", runnerReturning({ stdout: JSON.stringify({ clusters: [cluster] }) }));
    expect(r.clusters[0]!.target.beadsId).toBe("a");
  });
  test("schema mismatch fails closed", () => {
    const r = runBdDuplicatesDryRun("/tmp", runnerReturning({ stdout: JSON.stringify({ clusters: [{ target: {} }] }) }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/schema mismatch/);
  });
});

// ── runBdDoctorJson / runBdDoctorFix ──────────────────────────────────────────

describe("runBdDoctor", () => {
  test("doctor json: non-zero exit returns the empty report", () => {
    const r = runBdDoctorJson("/tmp", runnerReturning({ status: 1, stderr: "x" }));
    expect(r.report.total).toBe(0);
  });
  test("doctor json: unparseable output fails closed", () => {
    const r = runBdDoctorJson("/tmp", runnerReturning({ stdout: "nope" }));
    expect(r.stderr).toMatch(/failed to parse JSON/);
  });
  test("doctor json: schema mismatch fails closed", () => {
    const r = runBdDoctorJson("/tmp", runnerReturning({ stdout: JSON.stringify({ total: -5 }) }));
    expect(r.stderr).toMatch(/schema mismatch/);
  });
  test("doctor json: a well-formed report parses", () => {
    const r = runBdDoctorJson("/tmp", runnerReturning({ stdout: JSON.stringify({ total: 2, fixable: 1, issues: [] }) }));
    expect(r.exitCode).toBe(0);
    expect(r.report.total).toBe(2);
  });
  test("doctor --fix routes through the same parser", () => {
    const r = runBdDoctorFix("/tmp", runnerReturning({ stdout: JSON.stringify({}) }));
    expect(r.exitCode).toBe(0);
  });
});

// ── runBdMerge ────────────────────────────────────────────────────────────────

describe("runBdMerge", () => {
  test("refuses an empty sources list", () => {
    const r = runBdMerge("/tmp", { target: "t", sources: [] }, runnerReturning({}));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/empty sources/);
  });
  test("non-zero exit returns the fallback payload", () => {
    const r = runBdMerge("/tmp", { target: "t", sources: ["s"] }, runnerReturning({ status: 4, stderr: "x" }));
    expect(r.exitCode).toBe(4);
    expect(r.result.applied).toBe(false);
  });
  test("parses bd's JSON payload on success", () => {
    const r = runBdMerge(
      "/tmp",
      { target: "t", sources: ["s"] },
      runnerReturning({ stdout: JSON.stringify({ target: "t", sources: ["s"], applied: true }) }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.result.applied).toBe(true);
  });
  test("falls back to caller intent when stdout is empty (dry-run)", () => {
    const r = runBdMerge("/tmp", { target: "t", sources: ["s"], dryRun: true }, runnerReturning({ stdout: "" }));
    expect(r.exitCode).toBe(0);
    // dryRun → applied defaults to false in the fallback.
    expect(r.result.applied).toBe(false);
  });
  test("keeps the fallback when success stdout is non-JSON", () => {
    const r = runBdMerge("/tmp", { target: "t", sources: ["s"] }, runnerReturning({ stdout: "Merged 1 issue." }));
    expect(r.exitCode).toBe(0);
    // non-dry-run fallback → applied true.
    expect(r.result.applied).toBe(true);
  });
});
