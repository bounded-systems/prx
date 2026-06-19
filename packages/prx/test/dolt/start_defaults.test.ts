// dolt/start production default seams — the bd/git-backed probe, spawn, ledger
// I/O, deps factory, context resolver, and CLI error path. bd/probe spawns are
// injected; ledger I/O uses temp files; git resolution uses a real (fast) git
// probe against a temp non-repo and the live worktree.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SpawnCaptureResult } from "@bounded-systems/proc";
import {
  bdDelegatingSpawn,
  defaultDoltStartDeps,
  defaultProbe,
  defaultReadLedger,
  defaultWriteLedger,
  resolveDoltContext,
  runDoltStartCli,
} from "../../src/dolt/start.ts";
import type { DoltLedger } from "../../src/dolt/status.ts";

const sp = (r: Partial<SpawnCaptureResult>): typeof import("@bounded-systems/proc").spawnCapture =>
  (() => ({ status: 0, stdout: "", stderr: "", signal: null, ...r })) as never;

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "prx-doltstart-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── defaultProbe ──────────────────────────────────────────────────────────────

describe("defaultProbe", () => {
  test("reachable when bd reports connection_ok + port + database", () => {
    const r = defaultProbe(
      "/c",
      sp({ stdout: JSON.stringify({ connection_ok: true, port: 3307, database: "db" }) }),
    );
    expect(r).toEqual({ reachable: true, port: 3307, database: "db" });
  });
  test("down on a spawn error / non-zero exit", () => {
    expect(defaultProbe("/c", sp({ error: new Error("x") })).reachable).toBe(false);
    expect(defaultProbe("/c", sp({ status: 1 })).reachable).toBe(false);
  });
  test("down on an incomplete or malformed payload", () => {
    expect(
      defaultProbe("/c", sp({ stdout: JSON.stringify({ connection_ok: false }) })).reachable,
    ).toBe(false);
    expect(defaultProbe("/c", sp({ stdout: "{not json" })).reachable).toBe(false);
  });
});

// ── bdDelegatingSpawn ─────────────────────────────────────────────────────────

describe("bdDelegatingSpawn", () => {
  test("parses the PID out of bd's start output", () => {
    expect(
      bdDelegatingSpawn([], "/c", sp({ stdout: "Dolt server started (PID 4242, port 3307)" })),
    ).toEqual({ pid: 4242 });
  });
  test("an 'already running' non-zero exit is tolerated (pid 0)", () => {
    expect(bdDelegatingSpawn([], "/c", sp({ status: 1, stdout: "already running" }))).toEqual({
      pid: 0,
    });
  });
  test("no PID in clean output → pid 0", () => {
    expect(bdDelegatingSpawn([], "/c", sp({ status: 0, stdout: "started" }))).toEqual({ pid: 0 });
  });
  test("a real failure throws", () => {
    expect(() => bdDelegatingSpawn([], "/c", sp({ status: 1, stderr: "boom" }))).toThrow(
      /bd dolt start` failed/,
    );
  });
});

// ── defaultReadLedger / defaultWriteLedger ────────────────────────────────────

describe("dolt ledger I/O", () => {
  const ledger = { dolt_server_id: "id", pid: 9, port: 3307, dsn: "mysql://x" } as DoltLedger & {
    pid: number;
    port: number;
    dsn: string;
  };
  test("read: missing → null, valid → ledger, malformed → null", () => {
    const dir = fresh();
    expect(defaultReadLedger(join(dir, "absent.json"))).toBeNull();
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify(ledger));
    expect(defaultReadLedger(ok)).toMatchObject({ pid: 9, port: 3307 });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(defaultReadLedger(bad)).toBeNull();
  });
  test("write: mkdir -p's the parent and round-trips", () => {
    const path = join(fresh(), "nested", "ledger.json");
    defaultWriteLedger(path, ledger);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(9);
  });
});

// ── defaultDoltStartDeps ──────────────────────────────────────────────────────

describe("defaultDoltStartDeps", () => {
  test("wires the production seams + tunables", () => {
    const deps = defaultDoltStartDeps(() => null);
    expect(deps.probe).toBe(defaultProbe);
    expect(deps.spawnServer).toBe(bdDelegatingSpawn);
    expect(deps.host).toBe("127.0.0.1");
    expect(typeof deps.maxProbes).toBe("number");
  });
});

// ── resolveDoltContext (real git) ─────────────────────────────────────────────

describe("resolveDoltContext", () => {
  test("the live worktree resolves to a context (exercises the real git spawn)", () => {
    const ctx = resolveDoltContext(process.cwd());
    // The worktree has a github origin → reverse-DNS slug resolves.
    expect(ctx?.hostRepoSlug).toMatch(/\//);
  });
});

// ── runDoltStartCli error path (real git, non-repo) ───────────────────────────

describe("runDoltStartCli", () => {
  test("a path that cannot complete start fails closed with exit 1 (plain + json)", async () => {
    // A non-repo path under the test harness still resolves a context but can't
    // complete the start (no live dolt server) — either way the CLI catch arm
    // formats the error and returns 1, in both plain and json.
    const dir = fresh();
    const plain: string[] = [];
    expect(
      await runDoltStartCli({ repoPath: dir, format: "plain" }, { log: (l) => plain.push(l) }),
    ).toBe(1);
    expect(plain[0]!.length).toBeGreaterThan(0);

    const j: string[] = [];
    expect(
      await runDoltStartCli({ repoPath: dir, format: "json" }, { log: (l) => j.push(l) }),
    ).toBe(1);
    expect(JSON.parse(j[0]!).status).toBe("error");
  });
});
