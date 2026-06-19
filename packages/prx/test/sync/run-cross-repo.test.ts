// GH-1662 — `runBeadsSyncAcrossRepos` orchestrator coverage. Every external
// dependency (inventory loader, materialize primitive, cursor I/O, the per-
// repo `runBeadsSync`, the audit sink, the clock) is injected so the loop
// runs with no `gh` / `bd` / disk I/O.

import { describe, expect, test } from "bun:test";

import {
  runBeadsSyncAcrossRepos,
  type RunBeadsSyncAcrossReposDeps,
  type RunBeadsSyncAcrossReposOptions,
} from "../../src/sync/run-cross-repo.ts";
import type { BeadsSyncResult, BeadsSyncSummary } from "../../src/sync/run.ts";
import type { IndexedRepoForReconcile } from "../../src/pr-state/repos.ts";
import type { MaterializeResult } from "../../src/pr-state/materialize.ts";
import type { CrossRepoCursor } from "../../src/sync/cross-repo-cursor.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-14T09:00:00.000Z");

function repo(slug: string, owner = "bdelanghe"): IndexedRepoForReconcile {
  return {
    slug,
    nameWithOwner: `${owner}/${slug}`,
    barePath: `/bare/${slug}`,
    bdWorkspacePrefix: slug,
  };
}

function summary(over: Partial<BeadsSyncSummary> = {}): BeadsSyncSummary {
  return {
    repo: "bdelanghe/repo-a",
    domain: "gh",
    scanned: 1,
    pinned: 1,
    skipped: 0,
    pulled: 1,
    pushed: 0,
    closedByPull: 0,
    failed: 0,
    pullFailed: 0,
    pullDeferred: 0,
    pushDeferred: 0,
    deferred: 0,
    budgetPaused: false,
    dryRun: false,
    durationMs: 10,
    ...over,
  };
}

function syncResult(over: Partial<BeadsSyncResult> = {}): BeadsSyncResult {
  return { exitCode: 0, summary: summary(), pairs: [], ...over };
}

function makeMaterialize(
  overrides: Record<string, (() => MaterializeResult) | "throw">,
): (opts: { name: string; dryRun?: boolean | undefined }) => MaterializeResult {
  return ({ name, dryRun }) => {
    const arm = overrides[name];
    if (!arm) {
      return {
        repo: name,
        barePath: `/bare/${name}`,
        action: "noop",
        lastFetchedAtMs: 1,
        dryRun: dryRun === true,
      };
    }
    if (arm === "throw") {
      throw new Error(`fake clone failure for ${name}`);
    }
    return arm();
  };
}

function makeDeps(over: Partial<RunBeadsSyncAcrossReposDeps> = {}): {
  deps: RunBeadsSyncAcrossReposDeps;
  rows: unknown[];
  logs: string[];
  errs: string[];
  output: { log: (l: string) => void; error: (l: string) => void };
  cursorBox: { value: CrossRepoCursor | null };
  perRepoCalls: string[];
} {
  const rows: unknown[] = [];
  const logs: string[] = [];
  const errs: string[] = [];
  const cursorBox: { value: CrossRepoCursor | null } = { value: null };
  const perRepoCalls: string[] = [];
  const deps: RunBeadsSyncAcrossReposDeps = {
    cwd: () => "/repo",
    loadInventory: () => [repo("repo-a"), repo("repo-b")],
    materializeBareRepo: makeMaterialize({}),
    readCursor: () => cursorBox.value,
    writeCursor: (c) => {
      cursorBox.value = c;
    },
    clearCursor: () => {
      cursorBox.value = null;
    },
    runBeadsSync: async (o) => {
      perRepoCalls.push(o.repo ?? "");
      return syncResult({ summary: summary({ repo: o.repo ?? "" }) });
    },
    perRepoDeps: () => ({}),
    appendAuditRow: (row) => rows.push(row),
    getAuditRuntimeContext: () => ({
      verb: "beads.sync",
      actor: "test-actor",
      ghTruthReason: null,
      source: null,
    }),
    now: () => FIXED_NOW,
    ...over,
  };
  return {
    deps,
    rows,
    logs,
    errs,
    output: { log: (l) => logs.push(l), error: (l) => errs.push(l) },
    cursorBox,
    perRepoCalls,
  };
}

function opts(over: Partial<RunBeadsSyncAcrossReposOptions> = {}): RunBeadsSyncAcrossReposOptions {
  return { domain: "gh", dryRun: false, limit: 0, format: "plain", ...over };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("runBeadsSyncAcrossRepos — two-repo full walk", () => {
  test("walks both indexed repos; each per-repo call carries OWNER/REPO and the cursor clears on drain", async () => {
    const { deps, output, cursorBox, perRepoCalls } = makeDeps();
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(result.drained).toBe(true);
    expect(result.budgetPaused).toBe(false);
    expect(result.perRepo).toHaveLength(2);
    expect(perRepoCalls).toEqual(["bdelanghe/repo-a", "bdelanghe/repo-b"]);
    expect(cursorBox.value).toBeNull();
    expect(result.cursorAfter).toBeNull();
  });
});

describe("runBeadsSyncAcrossRepos — mid-repo budget pause", () => {
  test("the first repo's pause pins the cursor at that repo (not the next one)", async () => {
    const perRepoCalls: string[] = [];
    const { deps, output, cursorBox } = makeDeps({
      runBeadsSync: async (o) => {
        perRepoCalls.push(o.repo ?? "");
        if (o.repo === "bdelanghe/repo-a") {
          return syncResult({
            summary: summary({
              repo: o.repo,
              budgetPaused: true,
              scanned: 0,
              pinned: 0,
              pulled: 0,
            }),
          });
        }
        return syncResult({ summary: summary({ repo: o.repo ?? "" }) });
      },
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.budgetPaused).toBe(true);
    expect(result.drained).toBe(false);
    expect(perRepoCalls).toEqual(["bdelanghe/repo-a"]); // never advanced to repo-b
    expect(cursorBox.value).toEqual({
      tickStartedAt: FIXED_NOW.toISOString(),
      nextRepoSlug: "repo-a",
    });
    expect(result.cursorAfter).toEqual(cursorBox.value);
  });

  test("a subsequent tick reads the cursor and resumes at the pinned repo", async () => {
    const cursorBox: { value: CrossRepoCursor | null } = {
      value: { tickStartedAt: "2026-05-14T08:00:00.000Z", nextRepoSlug: "repo-b" },
    };
    const perRepoCalls: string[] = [];
    const { deps, output } = makeDeps({
      readCursor: () => cursorBox.value,
      writeCursor: (c) => {
        cursorBox.value = c;
      },
      clearCursor: () => {
        cursorBox.value = null;
      },
      runBeadsSync: async (o) => {
        perRepoCalls.push(o.repo ?? "");
        return syncResult({ summary: summary({ repo: o.repo ?? "" }) });
      },
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.drained).toBe(true);
    expect(perRepoCalls).toEqual(["bdelanghe/repo-b"]); // resumed at repo-b, did not re-run repo-a
    expect(cursorBox.value).toBeNull();
  });
});

describe("runBeadsSyncAcrossRepos — between-repo budget pause", () => {
  test("repo-a completes; repo-b pauses on its entry-gate; cursor pins at repo-b", async () => {
    const perRepoCalls: string[] = [];
    const { deps, output, cursorBox } = makeDeps({
      runBeadsSync: async (o) => {
        perRepoCalls.push(o.repo ?? "");
        if (o.repo === "bdelanghe/repo-b") {
          return syncResult({
            summary: summary({
              repo: o.repo,
              budgetPaused: true,
              scanned: 0,
              pinned: 0,
              pulled: 0,
            }),
          });
        }
        return syncResult({ summary: summary({ repo: o.repo ?? "" }) });
      },
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.budgetPaused).toBe(true);
    expect(perRepoCalls).toEqual(["bdelanghe/repo-a", "bdelanghe/repo-b"]);
    expect(cursorBox.value).toEqual({
      tickStartedAt: FIXED_NOW.toISOString(),
      nextRepoSlug: "repo-b",
    });
  });
});

describe("runBeadsSyncAcrossRepos — materialize failure", () => {
  test("a failing repo is skipped with an audit row; the rest of the walk continues", async () => {
    const perRepoCalls: string[] = [];
    const { deps, output, rows, errs, cursorBox } = makeDeps({
      materializeBareRepo: makeMaterialize({ "repo-a": "throw" }),
      runBeadsSync: async (o) => {
        perRepoCalls.push(o.repo ?? "");
        return syncResult({ summary: summary({ repo: o.repo ?? "" }) });
      },
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.drained).toBe(true);
    expect(result.reposSkipped).toEqual([
      { slug: "repo-a", error: "fake clone failure for repo-a" },
    ]);
    expect(perRepoCalls).toEqual(["bdelanghe/repo-b"]); // repo-a never reaches runBeadsSync
    const skipRow = rows.find(
      (r): r is Record<string, unknown> =>
        typeof r === "object" &&
        r !== null &&
        (r as Record<string, unknown>).kind === "domain-sync-materialize-failed",
    );
    expect(skipRow).toBeDefined();
    expect(skipRow!.repo).toBe("bdelanghe/repo-a");
    expect(skipRow!.error).toMatch(/fake clone failure/);
    expect(skipRow!.dryRun).toBe(false);
    expect(errs.join("\n")).toMatch(/repo-a/);
    expect(cursorBox.value).toBeNull(); // drained, cursor cleared
  });
});

describe("runBeadsSyncAcrossRepos — dry-run no writes (I-DS6)", () => {
  test("dry-run forwards through to per-repo runs and never writes the cursor", async () => {
    const writeCalls: CrossRepoCursor[] = [];
    const clearCalls: number[] = [];
    let materializeDryRunArg: boolean | undefined;
    const { deps, output, cursorBox } = makeDeps({
      writeCursor: (c) => writeCalls.push(c),
      clearCursor: () => {
        clearCalls.push(1);
      },
      materializeBareRepo: ({ name, dryRun }) => {
        materializeDryRunArg = dryRun;
        return {
          repo: name,
          barePath: `/bare/${name}`,
          action: "noop",
          lastFetchedAtMs: 1,
          dryRun: dryRun === true,
        };
      },
      runBeadsSync: async (o) => {
        // even if a dry-run pass reports budgetPaused, no cursor write happens
        if (o.repo === "bdelanghe/repo-a") {
          return syncResult({
            summary: summary({ repo: o.repo, dryRun: true, budgetPaused: true }),
          });
        }
        return syncResult({ summary: summary({ repo: o.repo ?? "", dryRun: true }) });
      },
    });
    const result = await runBeadsSyncAcrossRepos(opts({ dryRun: true }), output, deps);
    expect(materializeDryRunArg).toBe(true);
    expect(writeCalls).toHaveLength(0); // I-DS6: no cursor write on dry-run
    expect(clearCalls).toHaveLength(0); // I-DS6: no cursor clear on dry-run
    expect(cursorBox.value).toBeNull();
    expect(result.budgetPaused).toBe(true); // observed, but not persisted
    expect(result.cursorAfter).toBeNull();
  });
});

describe("runBeadsSyncAcrossRepos — drained tick clears cursor", () => {
  test("a full successful walk deletes a pre-existing cursor on disk", async () => {
    const cursorBox: { value: CrossRepoCursor | null } = {
      value: { tickStartedAt: "stale", nextRepoSlug: "repo-a" },
    };
    const { deps, output } = makeDeps({
      readCursor: () => cursorBox.value,
      writeCursor: (c) => {
        cursorBox.value = c;
      },
      clearCursor: () => {
        cursorBox.value = null;
      },
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.drained).toBe(true);
    expect(cursorBox.value).toBeNull();
    expect(result.cursorAfter).toBeNull();
  });
});

describe("runBeadsSyncAcrossRepos — empty / missing inventory", () => {
  test("missing inventory exits 1 with an error", async () => {
    const { deps, output, errs } = makeDeps({
      loadInventory: () => null,
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/inventory/);
  });

  test("empty inventory exits 0 (nothing to do, drained)", async () => {
    const { deps, output } = makeDeps({
      loadInventory: () => [],
    });
    const result = await runBeadsSyncAcrossRepos(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(result.drained).toBe(true);
    expect(result.perRepo).toHaveLength(0);
  });
});
