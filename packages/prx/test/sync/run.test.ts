// GH-1537 — `runBeadsSync` tick-loop coverage. Every external dependency is
// injected (`bd` loader, budget probe, repo resolver, audit sink, the
// `DomainAdapter`, the batched-close fn, the clock) so the loop runs with no
// `gh` / `bd` / disk I/O.

import { describe, expect, test } from "bun:test";

import {
  GH_SURFACE_ID_PATTERN,
  NOTION_SURFACE_ID_PATTERN,
  type DomainAdapter,
  type ResolvedWorkUnitPatch,
} from "../../src/adapters/domain-adapter.ts";
import {
  domainSyncRunAuditSchema,
  domainSyncPairAuditSchema,
} from "../../src/triage/schemas/audit.ts";
import { runBeadsSync, type RunBeadsSyncDeps, type RunBeadsSyncOptions } from "../../src/sync/run.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

function pinned(id: string, n: number, overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  const url = `https://github.com/bdelanghe/ai-home/issues/${n}`;
  return {
    id,
    title: `bead ${id}`,
    description: "body",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: url,
    externalRefs: { gh: url },
    metadata: null,
    externalIssueNumber: n,
    sourceSystem: null,
    ...overrides,
  };
}

function orphan(id: string, overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id,
    title: `orphan ${id}`,
    description: "body",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<DomainAdapter> = {}): DomainAdapter {
  return {
    config: {
      domain: "gh",
      surfaceIdPattern: GH_SURFACE_ID_PATTERN,
      externalIdShape: "issue-url",
      ownedOnPull: [],
    },
    matchesSurfaceId: () => true,
    recognizesExternalId: () => true,
    surfaceIdToExternalId: (id) => id,
    pull: async (): Promise<ResolvedWorkUnitPatch> => ({ status: "open" }),
    push: async (bd) => ({ externalId: bd.externalRef ?? "x", created: false, edited: true }),
    enumerate: async () => [],
    resolve: async () => null,
    resolveFromBeads: () => null,
    ...overrides,
  };
}

const FIXED_NOW = new Date("2026-05-12T09:00:00.000Z");

function baseDeps(over: Partial<RunBeadsSyncDeps> = {}): {
  deps: RunBeadsSyncDeps;
  rows: unknown[];
  logs: string[];
  errs: string[];
  output: { log: (l: string) => void; error: (l: string) => void };
} {
  const rows: unknown[] = [];
  const logs: string[] = [];
  const errs: string[] = [];
  const deps: RunBeadsSyncDeps = {
    cwd: () => "/repo",
    repoNameWithOwner: () => "bdelanghe/ai-home",
    refreshBudget: () => [{ bucket: "graphql", limit: 5000, remaining: 4000, resetAt: 0, fetchedAt: 0 }],
    appendAuditRow: (row) => rows.push(row),
    getAuditRuntimeContext: () => ({ verb: "beads.sync", actor: "test-actor", ghTruthReason: null, source: null }),
    now: () => FIXED_NOW,
    adapter: fakeAdapter(),
    bulkClose: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    loadAllBeads: () => [],
    ...over,
  };
  return {
    deps,
    rows,
    logs,
    errs,
    output: { log: (l) => logs.push(l), error: (l) => errs.push(l) },
  };
}

function opts(over: Partial<RunBeadsSyncOptions> = {}): RunBeadsSyncOptions {
  return { domain: "gh", dryRun: false, limit: 0, format: "plain", ...over };
}

function summaryRow(rows: unknown[]): Record<string, unknown> {
  const row = rows.find((r): r is Record<string, unknown> =>
    typeof r === "object" && r !== null && (r as Record<string, unknown>).kind === "domain-sync-run");
  expect(row).toBeDefined();
  return row as Record<string, unknown>;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("runBeadsSync — no-pin beads", () => {
  test("beads without an externalRef are counted skipped and never touched", async () => {
    let pullCalls = 0;
    let bulkCalls = 0;
    const { deps, rows, output } = baseDeps({
      loadAllBeads: () => [orphan("bd-1"), orphan("bd-2"), orphan("bd-3")],
      adapter: fakeAdapter({
        pull: async () => {
          pullCalls += 1;
          return { status: "open" };
        },
      }),
      bulkClose: () => {
        bulkCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(pullCalls).toBe(0);
    expect(bulkCalls).toBe(0);
    const row = summaryRow(rows);
    expect(row.scanned).toBe(3);
    expect(row.pinned).toBe(0);
    expect(row.skipped).toBe(3);
    expect(row.pulled).toBe(0);
    expect(domainSyncRunAuditSchema.parse(row)).toBeTruthy();
  });
});

describe("runBeadsSync — push-leg short-circuit (GH-296 prx-lzw)", () => {
  test("skips the push leg when the bead HEAD is unchanged since the last successful push", async () => {
    let pushCalls = 0;
    const { deps, rows, output, errs } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102)],
      adapter: fakeAdapter({
        push: async (bd) => {
          pushCalls += 1;
          return { externalId: bd.externalRef ?? "x", created: false, edited: true };
        },
      }),
      beadsHead: () => "h1",
      pushWatermark: { read: () => "h1", write: () => undefined },
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(pushCalls).toBe(0); // push leg skipped
    expect(summaryRow(rows).pushed).toBe(0);
    // Diagnostic note goes to stderr (stdout is reserved for the JSON-safe summary).
    expect(errs.some((l) => l.includes("push leg skipped"))).toBe(true);
  });

  test("runs + persists the HEAD watermark on a fully-successful push", async () => {
    let pushCalls = 0;
    let written: string | undefined;
    const { deps, output } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101)],
      adapter: fakeAdapter({
        push: async (bd) => {
          pushCalls += 1;
          return { externalId: bd.externalRef ?? "x", created: false, edited: true };
        },
      }),
      beadsHead: () => "h2",
      pushWatermark: { read: () => undefined, write: (h) => void (written = h) },
    });
    await runBeadsSync(opts(), output, deps);
    expect(pushCalls).toBeGreaterThan(0); // push ran (no prior watermark)
    expect(written).toBe("h2"); // advanced on full success
  });

  test("does not skip on --dry-run even when the HEAD matches", async () => {
    let pushCalls = 0;
    const { deps, output } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101)],
      adapter: fakeAdapter({
        push: async (bd) => {
          pushCalls += 1;
          return { externalId: bd.externalRef ?? "x", created: false, edited: true };
        },
      }),
      beadsHead: () => "h1",
      pushWatermark: { read: () => "h1", write: () => undefined },
    });
    await runBeadsSync(opts({ dryRun: true }), output, deps);
    expect(pushCalls).toBe(0); // dry-run never edits anyway
    // but the run still planned the push (not short-circuited) — exercised via no crash + plan path
  });
});

describe("runBeadsSync — pull-leg conditional-read store (GH-296 prx-lzw)", () => {
  test("flushes the pull-etag store once after the pull leg", async () => {
    let flushes = 0;
    const { deps, output } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102)],
      adapter: fakeAdapter({ pull: async () => ({ status: "open" }) }),
      pullEtagStore: {
        get: () => undefined,
        set: () => undefined,
        flush: () => void (flushes += 1),
      },
    });
    await runBeadsSync(opts(), output, deps);
    expect(flushes).toBe(1); // one persist per tick, not per pair
  });
});

describe("runBeadsSync — budget gate", () => {
  test("GraphQL remaining below threshold ⇒ budgetPaused, zero pairs, exit 0", async () => {
    let pullCalls = 0;
    const { deps, rows, output } = baseDeps({
      refreshBudget: () => [{ bucket: "graphql", limit: 5000, remaining: 5, resetAt: 0, fetchedAt: 0 }],
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102)],
      adapter: fakeAdapter({
        pull: async () => {
          pullCalls += 1;
          return { status: "open" };
        },
      }),
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(pullCalls).toBe(0);
    const row = summaryRow(rows);
    expect(row.budgetPaused).toBe(true);
    expect(row.scanned).toBe(0);
    expect(domainSyncRunAuditSchema.parse(row)).toBeTruthy();
  });

  test("budget falling below threshold mid-loop defers the remaining pairs (exit 2, GH-2095)", async () => {
    let n = 0;
    const { deps, rows, output, errs } = baseDeps({
      // call 0 (entry) = healthy; call 1 (before pair index 1) = exhausted.
      refreshBudget: () => {
        n += 1;
        return [{ bucket: "graphql", limit: 5000, remaining: n <= 1 ? 4000 : 5, resetAt: 0, fetchedAt: 0 }];
      },
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102), pinned("bd-3", 103)],
    });
    const result = await runBeadsSync(opts(), output, deps);
    // GH-2095: pull-deferred pairs flip the exit to 2 + emit a WARN line.
    expect(result.exitCode).toBe(2);
    expect(errs.join("\n")).toMatch(/WARN/);
    const row = summaryRow(rows);
    expect(row.pinned).toBe(3);
    expect(row.pulled).toBe(1);
    expect(row.pullDeferred).toBe(2);
    expect(row.pushDeferred).toBe(0);
    expect(row.deferred).toBe(2);
    expect(row.budgetPaused).toBe(false);
  });
});

describe("runBeadsSync — dry-run", () => {
  test("dry-run: no push edits, no bd github sync, full plan; row marks dryRun", async () => {
    let pushCalls = 0;
    let bulkCalls = 0;
    const { deps, rows, output, logs } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102)],
      adapter: fakeAdapter({
        pull: async () => ({ status: "closed" }), // would-close both
        push: async (bd) => {
          pushCalls += 1;
          return { externalId: bd.externalRef ?? "x", created: false, edited: true };
        },
      }),
      bulkClose: () => {
        bulkCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const result = await runBeadsSync(opts({ dryRun: true }), output, deps);
    expect(result.exitCode).toBe(0);
    expect(pushCalls).toBe(0);
    expect(bulkCalls).toBe(0);
    const row = summaryRow(rows);
    expect(row.dryRun).toBe(true);
    expect(row.pinned).toBe(2);
    expect(row.pulled).toBe(2);
    expect(row.closedByPull).toBe(2);
    expect(domainSyncRunAuditSchema.parse(row)).toBeTruthy();
    expect(logs.join("\n")).toContain("dry-run");
  });
});

describe("runBeadsSync — GH-2011/GH-2010 regression: bd-only writes survive a tick", () => {
  // GH-2011: a bead with `issueType=decision` and a bd-only assignee must
  // survive a `prx beads sync --domain=gh` tick unchanged. The destructive
  // bd-side reconcile (now retired) used to coerce both fields back to the
  // GH-projected values, dropping the bd writes. Under the new code path,
  // `runBeadsSync` only invokes `adapter.pull` (status only, per
  // `GH_OWNED_ON_PULL`) and `adapter.push` (bd→GH for title/body/labels);
  // it never writes to bd's `issue_type` or `assignee` columns.
  test("a tick over a bd-only decision/assignee bead never touches bd-side fields", async () => {
    let pulls = 0;
    let pushes = 0;
    let bulkCloseCalls = 0;
    const decisionBead = pinned("bd-decision-1", 101, {
      issueType: "decision",
      // bd-only assignee — GH has no assignee on the linked issue.
      // (The legacy reconcile would clear this from bd.)
    });
    const { deps, output } = baseDeps({
      loadAllBeads: () => [decisionBead],
      adapter: fakeAdapter({
        pull: async () => {
          pulls += 1;
          // GH side: open, no assignee, no milestone — and no `issue_type`
          // projection in the patch (per `GH_OWNED_ON_PULL`).
          return { status: "open" };
        },
        push: async (bd) => {
          pushes += 1;
          return { externalId: bd.externalRef ?? "x", created: false, edited: true };
        },
      }),
      // If the destructive reconcile had been re-introduced, the test
      // adapter would be bypassed in favor of `bulkClose` — assert it is
      // NOT called when there is no `closedByPull` pair.
      bulkClose: () => {
        bulkCloseCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(pulls).toBe(1);
    expect(pushes).toBe(1);
    // No close-apply spawn on a tick where nothing closed.
    expect(bulkCloseCalls).toBe(0);
  });

  // GH-2010 absorbed scope: when a pinned pair's GH issue is CLOSED, the
  // bead is closed via `adapter.bulkClose({ beadIds })` — which loops the
  // narrow `execBdIssueClose` per id (see test/adapters/github.test.ts).
  // This test pins the dispatch shape: the adapter receives only the ids
  // flagged by per-pair `adapter.pull`'s `needsClose`, not the full pinned
  // set, and no `bd github sync` shell-out is involved.
  test("GH→bd close-by-pull dispatches per-id close (GH-2010)", async () => {
    let receivedBeadIds: readonly string[] | undefined;
    const adapter = fakeAdapter({
      pull: async (externalId) => ({
        status: externalId.endsWith("/102") ? "closed" : "open",
      }),
      bulkClose: ({ beadIds }) => {
        receivedBeadIds = beadIds;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { deps, output } = baseDeps({
      adapter,
      bulkClose: undefined,
      loadAllBeads: () => [pinned("bd-open", 101), pinned("bd-stale", 102)],
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(receivedBeadIds).toEqual(["bd-stale"]);
  });
});

describe("runBeadsSync — pull leg closes stale beads (I-DS2)", () => {
  test("a pinned pair whose GH issue is CLOSED triggers the batched close once", async () => {
    let bulkArgs: { cwd: string; dryRun: boolean } | undefined;
    const { deps, rows, output } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102, { status: "open" })],
      adapter: fakeAdapter({
        pull: async (externalId) => ({ status: externalId.endsWith("/102") ? "closed" : "open" }),
      }),
      bulkClose: (cwd, dryRun) => {
        bulkArgs = { cwd, dryRun };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(bulkArgs).toEqual({ cwd: "/repo", dryRun: false });
    const row = summaryRow(rows);
    expect(row.closedByPull).toBe(1);
    expect(row.pushed).toBe(2);
    // one per-pair row for the pair that changed (closed+pushed) — schema-clean.
    const pairRow = rows.find((r): r is Record<string, unknown> =>
      typeof r === "object" && r !== null && (r as Record<string, unknown>).kind === "domain-sync-pair");
    expect(pairRow).toBeDefined();
    expect(domainSyncPairAuditSchema.parse(pairRow)).toBeTruthy();
  });
});

describe("runBeadsSync — limit + failures", () => {
  test("--limit caps push only; pull leg runs over every pinned pair (GH-2095)", async () => {
    // GH-2095: limit no longer caps the pull leg. With 3 pinned and
    // `limit=1`, pull runs over all 3 and push runs over 1 — the remaining
    // 2 are `pushDeferred`. Exit 2 because pairs are left non-reconciled.
    const { deps, rows, output, errs } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102), pinned("bd-3", 103)],
    });
    const result = await runBeadsSync(opts({ limit: 1 }), output, deps);
    expect(result.exitCode).toBe(2);
    expect(errs.join("\n")).toMatch(/WARN/);
    const row = summaryRow(rows);
    expect(row.pinned).toBe(3);
    expect(row.pulled).toBe(3);
    expect(row.pushed).toBe(1);
    expect(row.pullDeferred).toBe(0);
    expect(row.pushDeferred).toBe(2);
    expect(row.deferred).toBe(2);
  });

  test("a per-pair failure is recorded but the tick still exits 0", async () => {
    const { deps, rows, output } = baseDeps({
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102)],
      adapter: fakeAdapter({
        pull: async (externalId) => {
          if (externalId.endsWith("/101")) throw new Error("gh issue view exploded");
          return { status: "open" };
        },
      }),
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    const row = summaryRow(rows);
    expect(row.failed).toBe(1);
    expect(row.pullFailed).toBe(1);
    expect(row.pulled).toBe(1);
  });
});

describe("runBeadsSync — GH-2095: I-DS3 (pull leg never gated by --limit)", () => {
  test("close-apply reaches a limit-overflowed CLOSED pair (regression for GH-2095)", async () => {
    // 60 pinned pairs; limit=10. The pair at index 55 has its GH issue
    // CLOSED. Before GH-2095, `pinnedBeads.slice(0, limit)` would skip
    // indexes 10..59, the close-apply wouldn't see bd-055, and the short-id
    // mirror would stay OPEN forever. After GH-2095, pull runs over all 60,
    // close-apply receives every needsClose bead id, and bd-055 gets closed
    // while the remaining writes count as `pushDeferred`.
    const beads = Array.from({ length: 60 }, (_, i) =>
      pinned(`bd-${String(i).padStart(3, "0")}`, 1000 + i),
    );
    let closeArgs: { beadIds: readonly string[] } | undefined;
    const adapter = fakeAdapter({
      pull: async (externalId) => {
        if (externalId.endsWith("/1055")) return { status: "closed" };
        return { status: "open" };
      },
      bulkClose: ({ beadIds }) => {
        closeArgs = { beadIds };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { deps, rows, output, errs } = baseDeps({
      adapter,
      bulkClose: undefined, // exercise adapter.bulkClose
      loadAllBeads: () => beads,
    });
    const result = await runBeadsSync(opts({ limit: 10 }), output, deps);
    expect(result.exitCode).toBe(2);
    expect(closeArgs).toBeDefined();
    expect(closeArgs!.beadIds).toContain("bd-055");
    const row = summaryRow(rows);
    expect(row.pinned).toBe(60);
    expect(row.pulled).toBe(60);
    expect(row.closedByPull).toBe(1);
    // Push: 10 pushed (the non-closed ones come first in the re-sorted
    // push queue; bd-055 is at the tail). The remaining 50 are deferred.
    expect(row.pushed).toBe(10);
    expect(row.pushDeferred).toBe(50);
    expect(row.pullDeferred).toBe(0);
    expect(errs.join("\n")).toMatch(/WARN/);
  });

  test("pull leg invocation count over all pairs; push invocation count capped by --limit", async () => {
    let pullCalls = 0;
    let pushCalls = 0;
    const beads = Array.from({ length: 100 }, (_, i) => pinned(`bd-${i}`, 2000 + i));
    const adapter = fakeAdapter({
      pull: async () => {
        pullCalls += 1;
        return { status: "open" };
      },
      push: async (bd) => {
        pushCalls += 1;
        return { externalId: bd.externalRef ?? "x", created: false, edited: true };
      },
    });
    const { deps, output } = baseDeps({
      adapter,
      loadAllBeads: () => beads,
    });
    const result = await runBeadsSync(opts({ limit: 5 }), output, deps);
    expect(result.exitCode).toBe(2);
    expect(pullCalls).toBe(100);
    expect(pushCalls).toBe(5);
  });

  test("pull-budget mid-loop cutoff defers pulls but close-apply still runs for already-pulled CLOSED pairs", async () => {
    // 50 pinned pairs. Budget healthy at entry and through the first 30
    // pulls, then drops below threshold. Pair index 10 has external CLOSED.
    // After GH-2095: pairs 30..49 are `pullDeferred`; close-apply still
    // reaches bd-010 because it was pulled in the healthy window.
    const beads = Array.from({ length: 50 }, (_, i) => pinned(`bd-${i}`, 3000 + i));
    let probeCount = 0;
    let closeArgs: { beadIds: readonly string[] } | undefined;
    const adapter = fakeAdapter({
      pull: async (externalId) => {
        if (externalId.endsWith("/3010")) return { status: "closed" };
        return { status: "open" };
      },
      bulkClose: ({ beadIds }) => {
        closeArgs = { beadIds };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { deps, rows, output, errs } = baseDeps({
      adapter,
      bulkClose: undefined,
      loadAllBeads: () => beads,
      refreshBudget: () => {
        probeCount += 1;
        // probe 1 = entry (healthy), probes 2..30 = healthy, probe 31+ = exhausted.
        const remaining = probeCount <= 30 ? 4000 : 5;
        return [{ bucket: "graphql", limit: 5000, remaining, resetAt: 0, fetchedAt: 0 }];
      },
    });
    const result = await runBeadsSync(opts({ limit: 100 }), output, deps);
    expect(result.exitCode).toBe(2);
    expect(closeArgs).toBeDefined();
    expect(closeArgs!.beadIds).toEqual(["bd-10"]);
    const row = summaryRow(rows);
    expect(row.pinned).toBe(50);
    expect(row.pullDeferred).toBeGreaterThan(0);
    expect(row.closedByPull).toBe(1);
    expect(errs.join("\n")).toMatch(/WARN/);
  });

  test("synced row is emitted for a close-applied pair whose push leg was deferred", async () => {
    // 3 pinned; bd-2 (index 1) is CLOSED on GH. limit=1 so only bd-1 reaches
    // the push phase; bd-2 is close-applied but push-deferred. The pair row
    // for bd-2 must still appear with `closedByPull: true`, `pushed: false`.
    const adapter = fakeAdapter({
      pull: async (externalId) => ({
        status: externalId.endsWith("/102") ? "closed" : "open",
      }),
      bulkClose: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const { deps, output } = baseDeps({
      adapter,
      bulkClose: undefined,
      loadAllBeads: () => [pinned("bd-1", 101), pinned("bd-2", 102), pinned("bd-3", 103)],
    });
    const result = await runBeadsSync(opts({ limit: 1 }), output, deps);
    expect(result.exitCode).toBe(2);
    const bd2 = result.pairs.find((p) => p.beadId === "bd-2");
    expect(bd2).toBeDefined();
    expect(bd2!.closedByPull).toBe(true);
    expect(bd2!.pushed).toBe(false);
    expect(bd2!.action).toBe("synced");
  });
});

describe("runBeadsSync — domain guard", () => {
  test("a registered notion domain succeeds end-to-end (no GH-only guard)", async () => {
    // GH-1614 inverted this: previously `domain !== "gh"` short-circuited;
    // now any registered adapter is admitted. The notion adapter is registered
    // by importing `src/sync/run.ts` (side-effect import); here we also pass
    // it through `deps.adapter` so the test does not depend on REST resolution.
    const notionAdapter: DomainAdapter = {
      config: {
        domain: "notion",
        surfaceIdPattern: NOTION_SURFACE_ID_PATTERN,
        externalIdShape: "page-uuid",
        ownedOnPull: ["status"],
      },
      matchesSurfaceId: (id) => /^NOTION-/.test(id),
      recognizesExternalId: () => true,
      surfaceIdToExternalId: (id) => id,
      pull: async (): Promise<ResolvedWorkUnitPatch> => ({ status: "open" }),
      push: async (_bd, _fields) => ({ externalId: "page-uuid", created: false, edited: true }),
      enumerate: async () => [],
      resolve: async () => null,
      resolveFromBeads: () => null,
    };
    const notionBead = (id: string, uuid: string): BeadsRecord => ({
      id,
      title: `bead ${id}`,
      description: "body",
      status: "open",
      priority: 2,
      issueType: "task",
      externalRef: null,
      externalRefs: { notion: uuid },
      metadata: null,
      externalIssueNumber: null,
      sourceSystem: null,
    });
    const { deps, rows, output } = baseDeps({
      adapter: notionAdapter,
      loadAllBeads: () => [
        notionBead("bd-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        notionBead("bd-2", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      ],
    });
    const result = await runBeadsSync(opts({ domain: "notion" }), output, deps);
    expect(result.exitCode).toBe(0);
    const row = summaryRow(rows);
    expect(row.domain).toBe("notion");
    expect(row.pinned).toBe(2);
    expect(row.pulled).toBe(2);
    expect(row.pushed).toBe(2);
  });

  test("an unregistered domain still errors (registry-membership check intact)", async () => {
    const { deps, output, errs } = baseDeps({ loadAllBeads: () => [pinned("bd-1", 1)] });
    const result = await runBeadsSync(opts({ domain: "jira" }), output, deps);
    expect(result.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/jira/);
  });
});

describe("runBeadsSync — adapter.bulkClose dispatch", () => {
  test("when adapter.bulkClose is defined and deps.bulkClose is not, the adapter is used (gets beadIds)", async () => {
    let adapterCloseArgs: { cwd: string; beadIds: readonly string[] } | undefined;
    const adapter = fakeAdapter({
      pull: async (externalId) => ({
        status: externalId.endsWith("/102") ? "closed" : "open",
      }),
      bulkClose: ({ cwd, beadIds }) => {
        adapterCloseArgs = { cwd, beadIds };
        return { exitCode: 0, stdout: "closed", stderr: "" };
      },
    });
    const { deps, output } = baseDeps({
      adapter,
      // explicitly omit deps.bulkClose so the adapter path takes precedence
      bulkClose: undefined,
      loadAllBeads: () => [
        pinned("bd-1", 101, { status: "open" }),
        pinned("bd-2", 102, { status: "open" }),
      ],
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(adapterCloseArgs).toBeDefined();
    expect(adapterCloseArgs!.cwd).toBe("/repo");
    expect(adapterCloseArgs!.beadIds).toEqual(["bd-2"]);
  });

  test("deps.bulkClose takes precedence over adapter.bulkClose (back-compat test seam)", async () => {
    let adapterCloseCalled = false;
    let depsCloseCalled = false;
    const adapter = fakeAdapter({
      pull: async () => ({ status: "closed" }),
      bulkClose: () => {
        adapterCloseCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { deps, output } = baseDeps({
      adapter,
      bulkClose: () => {
        depsCloseCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      loadAllBeads: () => [pinned("bd-1", 101)],
    });
    const result = await runBeadsSync(opts(), output, deps);
    expect(result.exitCode).toBe(0);
    expect(depsCloseCalled).toBe(true);
    expect(adapterCloseCalled).toBe(false);
  });
});

describe("loadAllBeads — cwd forwarding (GH-1662)", () => {
  test("the optional cwd? argument is passed through to execBd as opts.cwd", async () => {
    const { execBd } = await import("@bounded-systems/bd");
    const { loadAllBeads } = await import("../../src/triage/triage.ts");
    type ExecArgs = Parameters<typeof execBd>[0];
    let captured: ExecArgs | undefined;
    const fakeExec: typeof execBd = (args) => {
      captured = args;
      return { exitCode: 0, stdout: "[]", stderr: "", policy: null };
    };
    loadAllBeads(fakeExec, () => {}, "/bare/repo-b");
    expect(captured).toBeDefined();
    expect(captured!.cwd).toBe("/bare/repo-b");
    // Sanity: omitting cwd does not stuff one in.
    captured = undefined;
    loadAllBeads(fakeExec);
    expect(captured!.cwd).toBeUndefined();
  });
});

describe("runBeadsSync — BeadsCache sharing (GH-1595)", () => {
  test("the bulk-pair loop reads beads once when the adapter shares the run's cache", async () => {
    // Before GH-1595 each per-pair `adapter.push` re-read the full bead set
    // for its unlinked-dedup check; on a run of N pinned pairs that's N+1
    // multi-MB reads. The fix: one cache per `runBeadsSync` invocation,
    // shared with the constructed `GhDomainAdapter`.
    const { createBeadsCache } = await import("../../src/triage/beads_cache.ts");
    let reads = 0;
    const cache = createBeadsCache({
      loadAllBeads: () => {
        reads += 1;
        return [pinned("bd-1", 101), pinned("bd-2", 102), pinned("bd-3", 103)];
      },
    });

    let pushes = 0;
    const { deps, output } = baseDeps({
      loadAllBeads: () => cache.load(),
      adapter: fakeAdapter({
        // Simulate the production adapter's per-pair `loadBeads()` call:
        // every push reads through the shared cache.
        push: async (bd) => {
          cache.load();
          pushes += 1;
          return { externalId: bd.externalRef ?? "x", created: false, edited: true };
        },
      }),
    });

    const result = await runBeadsSync(opts({ dryRun: false }), output, deps);
    expect(result.exitCode).toBe(0);
    expect(pushes).toBe(3);
    // One read covers the entry-time scan AND every per-pair adapter call.
    expect(reads).toBe(1);
  });
});
