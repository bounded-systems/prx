// GH-1510 — tests for the bd-ready query + cache layer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BdReadyCacheSchema,
  BdReadyExplainEnvelopeSchema,
  filterBlocked,
  queryBdGraph,
  queryBdReady,
  type BdRunner,
  type BdReadyCandidate,
} from "../../src/beads/ready.ts";
import type { BdExecOptions } from "@bounded-systems/bd";
import {
  DEFAULT_READY_TTL_SECONDS,
  cacheFilePath,
  getBdReady,
  loadReadyTtlSeconds,
  readCache,
  writeCache,
} from "../../src/beads/ready_cache.ts";

const MIXED_FIXTURE_PATH = new URL("./fixtures/bd-ready-mixed.json", import.meta.url).pathname;
const mixedFixtureRaw = readFileSync(MIXED_FIXTURE_PATH, "utf8");
const mixedFixture = BdReadyExplainEnvelopeSchema.parse(JSON.parse(mixedFixtureRaw));

function fixtureRunner(stdout: string, opts: { failGraph?: boolean } = {}): BdRunner {
  return (call: BdExecOptions) => {
    if (call.subcommand === "ready") {
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (call.subcommand === "dep" && call.args[0] === "list") {
      if (opts.failGraph) return { exitCode: 1, stdout: "", stderr: "boom" };
      const id = call.args[1] ?? "";
      // Synthesize an edge for any id whose candidate has inline blockers in
      // the fixture, so queryBdGraph round-trips end-to-end.
      const candidate = [...mixedFixture.ready, ...mixedFixture.blocked].find((c) => c.id === id);
      const rows = candidate
        ? candidate.blocked_by.map((b) => ({ id: b.id, dependency_type: "blocks" }))
        : [];
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected bd call: ${call.subcommand}` };
  };
}

describe("queryBdReady", () => {
  test("parses --explain --json envelope into typed buckets", () => {
    const result = queryBdReady({ cwd: "/dev/null", runner: fixtureRunner(mixedFixtureRaw) });
    expect(result.ready.map((c) => c.id)).toEqual(["ai-home-r1", "ai-home-r2", "ai-home-child-1"]);
    expect(result.blocked.map((c) => c.id)).toEqual(["ai-home-b1", "ai-home-b2", "ai-home-parent-1"]);
    expect(result.blocked[0]?.blocked_by[0]?.id).toBe("ai-home-r1");
  });

  test("accepts the legacy `bd ready --json` array shape", () => {
    const onlyArray = JSON.stringify(mixedFixture.ready);
    const result = queryBdReady({ cwd: "/dev/null", runner: fixtureRunner(onlyArray) });
    expect(result.ready).toHaveLength(3);
    expect(result.blocked).toHaveLength(0);
  });

  test("returns empty buckets on empty stdout (clean db)", () => {
    const result = queryBdReady({ cwd: "/dev/null", runner: fixtureRunner("") });
    expect(result.ready).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  test("throws on non-zero exit", () => {
    const runner: BdRunner = () => ({ exitCode: 2, stdout: "", stderr: "bd died" });
    expect(() => queryBdReady({ cwd: "/dev/null", runner })).toThrow(/bd ready --explain --json failed/);
  });
});

describe("queryBdGraph", () => {
  test("synthesizes typed edges from per-id `bd dep list` reads", () => {
    const edges = queryBdGraph({
      cwd: "/dev/null",
      runner: fixtureRunner(mixedFixtureRaw),
      ids: ["ai-home-b1", "ai-home-parent-1"],
    });
    expect(edges).toContainEqual({ from: "ai-home-b1", to: "ai-home-r1", kind: "blocks" });
    expect(edges).toContainEqual({ from: "ai-home-parent-1", to: "ai-home-child-1", kind: "blocks" });
  });

  test("propagates bd failures", () => {
    expect(() =>
      queryBdGraph({
        cwd: "/dev/null",
        runner: fixtureRunner(mixedFixtureRaw, { failGraph: true }),
        ids: ["ai-home-b1"],
      }),
    ).toThrow(/bd dep list/);
  });
});

describe("filterBlocked (I-BD1 gate)", () => {
  const openIds = new Set<string>([
    "ai-home-r1",
    "ai-home-r2",
    "ai-home-child-1",
    "ai-home-b1",
    "ai-home-b2",
    "ai-home-parent-1",
  ]);

  test("removes items whose blocked_by intersects open ids", () => {
    const result = filterBlocked(mixedFixture.blocked as BdReadyCandidate[], [], openIds);
    expect(result.map((c) => c.id)).toEqual(["ai-home-b2"]);
  });

  test("keeps items whose only blockers are closed", () => {
    const result = filterBlocked([mixedFixture.blocked[1]!], [], openIds);
    expect(result.map((c) => c.id)).toEqual(["ai-home-b2"]);
  });

  test("supplemental edges (kind=blocks) also gate", () => {
    const candidate = { ...mixedFixture.ready[0]!, blocked_by: [] };
    const filtered = filterBlocked(
      [candidate],
      [{ from: candidate.id, to: "ai-home-r2", kind: "blocks" }],
      openIds,
    );
    expect(filtered).toHaveLength(0);
  });

  test("non-blocks edges (parent-child, relates_to, etc) do not gate", () => {
    const candidate = { ...mixedFixture.ready[0]!, blocked_by: [] };
    const filtered = filterBlocked(
      [candidate],
      [{ from: candidate.id, to: "ai-home-r2", kind: "parent-child" }],
      openIds,
    );
    expect(filtered).toHaveLength(1);
  });
});

describe("ready cache (atomic write + sync-if-stale)", () => {
  let repoPath: string;
  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "bd-ready-cache-"));
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("first call refreshes (no cache) and writes an atomic file", () => {
    const result = getBdReady(repoPath, { runner: fixtureRunner(mixedFixtureRaw), ttlSeconds: 60 });
    expect(result.refreshed).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.cache.ready.map((c) => c.id)).toEqual(["ai-home-r1", "ai-home-r2", "ai-home-child-1"]);

    const path = cacheFilePath(repoPath);
    expect(existsSync(path)).toBe(true);
    // No tmp leftovers — atomic rename wipes them.
    const dirEntries = readdirSync(join(repoPath, ".beads", "cache"));
    expect(dirEntries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // The persisted file parses under the schema.
    BdReadyCacheSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  });

  test("second call within TTL serves cached envelope without hitting bd", () => {
    let bdCalls = 0;
    const wrappedRunner: BdRunner = (call) => {
      bdCalls += 1;
      return fixtureRunner(mixedFixtureRaw)(call);
    };
    getBdReady(repoPath, { runner: wrappedRunner, ttlSeconds: 60 });
    expect(bdCalls).toBe(1);
    const second = getBdReady(repoPath, { runner: wrappedRunner, ttlSeconds: 60 });
    expect(bdCalls).toBe(1);
    expect(second.refreshed).toBe(false);
    expect(second.stale).toBe(false);
  });

  test("stale cache is detected and refreshed (I-BD3 path)", () => {
    // Hand-write a cache file with a queried_at 3600s in the past.
    mkdirSync(join(repoPath, ".beads", "cache"), { recursive: true });
    const stale = {
      run_id: "stale-run",
      queried_at: new Date(Date.now() - 3600_000).toISOString(),
      ttl_seconds: 60,
      ready: [],
      blocked: [],
      edges: [],
    };
    writeFileSync(cacheFilePath(repoPath), JSON.stringify(stale), "utf8");

    const result = getBdReady(repoPath, { runner: fixtureRunner(mixedFixtureRaw), ttlSeconds: 60 });
    expect(result.stale).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.cache.ready).toHaveLength(3);
  });

  test("force=true refreshes even when cache is fresh", () => {
    getBdReady(repoPath, { runner: fixtureRunner(mixedFixtureRaw), ttlSeconds: 3600 });
    let calls = 0;
    const counting: BdRunner = (call) => {
      calls += 1;
      return fixtureRunner(mixedFixtureRaw)(call);
    };
    const result = getBdReady(repoPath, { runner: counting, force: true, ttlSeconds: 3600 });
    expect(calls).toBe(1);
    expect(result.refreshed).toBe(true);
  });

  test("invalid cache JSON is treated as missing", () => {
    mkdirSync(join(repoPath, ".beads", "cache"), { recursive: true });
    writeFileSync(cacheFilePath(repoPath), "not-json {{", "utf8");
    const result = getBdReady(repoPath, { runner: fixtureRunner(mixedFixtureRaw), ttlSeconds: 60 });
    expect(result.refreshed).toBe(true);
  });

  test("I-BD2: writeCache never leaves a partial file when JSON.stringify is OK", () => {
    // Write a valid cache, then list dir — only the final file exists, no
    // stray *.tmp entries.
    writeCache(repoPath, {
      run_id: "r",
      queried_at: new Date().toISOString(),
      ttl_seconds: 60,
      ready: [],
      blocked: [],
      edges: [],
    });
    const entries = readdirSync(join(repoPath, ".beads", "cache"));
    expect(entries).toEqual(["ready.json"]);
    expect(statSync(cacheFilePath(repoPath)).isFile()).toBe(true);
  });

  test("readCache returns null when cache is missing", () => {
    expect(readCache(repoPath)).toBeNull();
  });
});

describe("loadReadyTtlSeconds (prx.toml [beads] ready_ttl_seconds)", () => {
  let repoPath: string;
  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "ready-ttl-toml-"));
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("returns default when prx.toml is missing", () => {
    expect(loadReadyTtlSeconds(repoPath)).toBe(DEFAULT_READY_TTL_SECONDS);
  });

  test("parses an explicit override", () => {
    writeFileSync(
      join(repoPath, "prx.toml"),
      [`[beads]`, `ready_ttl_seconds = 30`, ``].join("\n"),
      "utf8",
    );
    expect(loadReadyTtlSeconds(repoPath)).toBe(30);
  });

  test("ignores non-positive values", () => {
    writeFileSync(
      join(repoPath, "prx.toml"),
      [`[beads]`, `ready_ttl_seconds = 0`, ``].join("\n"),
      "utf8",
    );
    expect(loadReadyTtlSeconds(repoPath)).toBe(DEFAULT_READY_TTL_SECONDS);
  });

  test("ignores entries outside the [beads] section", () => {
    writeFileSync(
      join(repoPath, "prx.toml"),
      [`[worktree]`, `ready_ttl_seconds = 999`, ``].join("\n"),
      "utf8",
    );
    expect(loadReadyTtlSeconds(repoPath)).toBe(DEFAULT_READY_TTL_SECONDS);
  });
});
