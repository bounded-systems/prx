// GH-1244 — `scout issues` unit + property tests. The verb is exercised
// against a stubbed bd via the `execBd` DI seam so coverage is hermetic
// and stable. Integration coverage (real bd, real .beads/dolt) is gated
// on PRX_INTEGRATION and intentionally out-of-scope for v0.

import { describe, expect, test } from "bun:test";

import {
  extractOwnerRepoFromRef,
  formatScoutIssuesJsonLines,
  runScoutIssues,
  ScoutIssuesError,
  type ScoutIssuesInput,
  type ScoutIssuesRow,
} from "../../src/scout/issues.ts";
import type { BdExecResult } from "@bounded-systems/bd";

type BdRecordFixture = {
  id: string;
  title?: string;
  status?: string;
  priority?: number | null;
  issue_type?: string;
  external_ref?: string | null;
  updated_at?: string | null;
  dependencies?: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
  }>;
};

function bdOk(records: BdRecordFixture[]): typeof import("@bounded-systems/bd").execBd {
  const json = JSON.stringify(
    records.map((r) => ({
      id: r.id,
      title: r.title ?? "stub",
      description: "",
      status: r.status ?? "open",
      priority: r.priority ?? 2,
      issue_type: r.issue_type ?? "task",
      external_ref: r.external_ref ?? null,
      updated_at: r.updated_at ?? null,
      metadata: null,
      ...(r.dependencies ? { dependencies: r.dependencies } : {}),
    })),
  );
  return ((): BdExecResult => ({
    exitCode: 0,
    stdout: json,
    stderr: "",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/bd").execBd;
}

function bdFailed(stderr = "bd: boom"): typeof import("@bounded-systems/bd").execBd {
  return ((): BdExecResult => ({
    exitCode: 1,
    stdout: "",
    stderr,
    policy: null,
  })) as unknown as typeof import("@bounded-systems/bd").execBd;
}

function bdNotFound(): typeof import("@bounded-systems/bd").execBd {
  // `loadAllBeads` rethrows the bd stderr; the `not found` substring is
  // what triggers the BD_NOT_FOUND classification in mapLoaderError.
  return ((): BdExecResult => ({
    exitCode: 127,
    stdout: "",
    stderr: "bd: command not found",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/bd").execBd;
}

function bdBadJson(): typeof import("@bounded-systems/bd").execBd {
  return ((): BdExecResult => ({
    exitCode: 0,
    stdout: "not-json-at-all",
    stderr: "",
    policy: null,
  })) as unknown as typeof import("@bounded-systems/bd").execBd;
}

const defaultDeps: Partial<ScoutIssuesInput> = {
  // Force a known repo filter so cwd/git inference doesn't leak in.
  repo: "bdelanghe/ai-home",
  isMainxWorktree: () => false,
  repoNameWithOwner: () => "bdelanghe/ai-home",
  // Keep ratePoints hermetic by default — opt in per test when checking it.
  readLastFetchPoints: () => null,
  // Scout reports staleness but never fetches; a null watermark keeps the
  // legacy catalog hermetic (staleness reads as "unknown").
  readSubstrateWatermark: () => null,
};

function runWith(records: BdRecordFixture[], extra: Partial<ScoutIssuesInput> = {}) {
  return runScoutIssues({
    ...defaultDeps,
    ...extra,
    execBd: bdOk(records),
  });
}

describe("runScoutIssues — kind/scope parse", () => {
  test("conventional prefix with scope", async () => {
    const result = await runWith([
      {
        id: "ai-home-aaaa",
        title: "feat(prx): scout grep",
        external_ref: "https://github.com/bdelanghe/ai-home/issues/1193",
      },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.kind).toBe("feat");
    expect(result.rows[0]?.scope).toBe("prx");
    expect(result.rows[0]?.ghNumber).toBe(1193);
  });

  test("prefix-only title (no scope)", async () => {
    const result = await runWith([
      { id: "ai-home-bbbb", title: "fix: handle null watermark" },
    ]);
    expect(result.rows[0]?.kind).toBe("fix");
    expect(result.rows[0]?.scope).toBe(null);
  });

  test("no conventional prefix", async () => {
    const result = await runWith([
      { id: "ai-home-cccc", title: "the cli sometimes hangs" },
    ]);
    // The word `the` matches \w+ but the regex also requires a trailing `:`,
    // which a free-form title doesn't have — kind/scope must both be null.
    expect(result.rows[0]?.kind).toBe(null);
    expect(result.rows[0]?.scope).toBe(null);
  });
});

describe("runScoutIssues — state filter", () => {
  test("--state=open drops closed and tombstones", async () => {
    const result = await runWith(
      [
        { id: "a", title: "feat: x", status: "open" },
        { id: "b", title: "feat: y", status: "in_progress" },
        { id: "c", title: "feat: z", status: "closed" },
        { id: "d", title: "feat: t", status: "tombstone" },
      ],
      { state: "open" },
    );
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(result.summary.total).toBe(2);
  });

  test("--state=closed only matches closed", async () => {
    const result = await runWith(
      [
        { id: "a", title: "feat: x", status: "open" },
        { id: "b", title: "feat: y", status: "closed" },
      ],
      { state: "closed" },
    );
    expect(result.rows.map((r) => r.id)).toEqual(["b"]);
  });

  test("--state=all includes open + closed (still drops tombstone)", async () => {
    const result = await runWith(
      [
        { id: "a", status: "open", title: "feat: x" },
        { id: "b", status: "closed", title: "feat: y" },
        { id: "c", status: "tombstone", title: "feat: z" },
      ],
      { state: "all" },
    );
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("runScoutIssues — repo filter", () => {
  test("drops records whose externalRef host/owner/repo doesn't match", async () => {
    const result = await runWith([
      {
        id: "a",
        title: "feat: x",
        external_ref: "https://github.com/bdelanghe/ai-home/issues/1",
      },
      {
        id: "b",
        title: "feat: y",
        external_ref: "https://github.com/demo/demo-web/issues/9",
      },
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(["a"]);
  });

  test("bd-only rows (no external_ref) are included under matching cwd", async () => {
    const result = await runWith([
      { id: "a", title: "feat: bd-only", external_ref: null },
    ]);
    expect(result.rows[0]?.id).toBe("a");
    expect(result.rows[0]?.ghNumber).toBe(null);
  });

  test("INVALID_REPO when --repo not in owner/repo form", async () => {
    let caught: unknown = null;
    try {
      await runScoutIssues({
        ...defaultDeps,
        repo: "garbled",
        execBd: bdOk([]),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutIssuesError);
    expect((caught as ScoutIssuesError).code).toBe("INVALID_REPO");
  });
});

describe("runScoutIssues — query filter", () => {
  test("empty query returns full snapshot", async () => {
    const result = await runWith([
      { id: "a", title: "feat: x" },
      { id: "b", title: "fix: y" },
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.summary.query).toBe("");
  });

  test("substring match (case-insensitive)", async () => {
    const result = await runWith(
      [
        { id: "a", title: "feat(prx): scout grep" },
        { id: "b", title: "feat(prx): scout issues" },
        { id: "c", title: "fix(prx): cli typo" },
      ],
      { query: "scout" },
    );
    expect(result.rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("runScoutIssues — truncation", () => {
  test("max < total → truncated=true", async () => {
    const records: BdRecordFixture[] = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      title: `feat: ${i}`,
    }));
    const result = await runWith(records, { max: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.summary.total).toBe(10);
    expect(result.summary.truncated).toBe(true);
  });

  test("max=0 is rejected as INVALID_MAX", async () => {
    let caught: unknown = null;
    try {
      await runScoutIssues({
        ...defaultDeps,
        max: 0,
        execBd: bdOk([]),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutIssuesError);
    expect((caught as ScoutIssuesError).code).toBe("INVALID_MAX");
  });
});

describe("runScoutIssues — links projection (merge-blocking)", () => {
  test("projects {kind, target} per outgoing dep edge", async () => {
    const result = await runWith([
      {
        id: "ai-home-aaaa",
        title: "feat: source",
        dependencies: [
          {
            issue_id: "ai-home-aaaa",
            depends_on_id: "ai-home-bbbb",
            type: "blocks",
          },
          {
            issue_id: "ai-home-aaaa",
            depends_on_id: "ai-home-cccc",
            type: "related",
          },
        ],
      },
      { id: "ai-home-bbbb", title: "feat: dep1" },
      { id: "ai-home-cccc", title: "feat: dep2" },
    ]);
    const source = result.rows.find((r) => r.id === "ai-home-aaaa");
    expect(source?.links).toHaveLength(2);
    const kinds = source?.links.map((l) => l.kind).sort();
    expect(kinds).toEqual(["blocks", "related"]);
    const targets = source?.links.map((l) => l.target).sort();
    expect(targets).toEqual(["ai-home-bbbb", "ai-home-cccc"]);
  });

  test("records with no edges get links: []", async () => {
    const result = await runWith([{ id: "ai-home-aaaa", title: "feat: x" }]);
    expect(result.rows[0]?.links).toEqual([]);
  });
});

describe("runScoutIssues — empty corpus", () => {
  test("empty bd output → summary-only", async () => {
    const result = await runWith([]);
    expect(result.rows).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });
});

describe("runScoutIssues — failure modes", () => {
  test("bd missing → BD_NOT_FOUND", async () => {
    let caught: unknown = null;
    try {
      await runScoutIssues({ ...defaultDeps, execBd: bdNotFound() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutIssuesError);
    expect((caught as ScoutIssuesError).code).toBe("BD_NOT_FOUND");
  });

  test("bd exits non-zero → BD_FAILED", async () => {
    let caught: unknown = null;
    try {
      await runScoutIssues({ ...defaultDeps, execBd: bdFailed("schema drift") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutIssuesError);
    expect((caught as ScoutIssuesError).code).toBe("BD_FAILED");
  });

  test("bd returns malformed JSON → BD_INVALID_JSON", async () => {
    let caught: unknown = null;
    try {
      await runScoutIssues({ ...defaultDeps, execBd: bdBadJson() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutIssuesError);
    expect((caught as ScoutIssuesError).code).toBe("BD_INVALID_JSON");
  });
});

describe("runScoutIssues — output formatting", () => {
  test("formatScoutIssuesJsonLines emits one record per line + trailing _summary", async () => {
    const result = await runWith([
      {
        id: "ai-home-aaaa",
        title: 'feat(prx): titles with "quotes" and\nnewlines',
        external_ref: "https://github.com/bdelanghe/ai-home/issues/1",
      },
      { id: "ai-home-bbbb", title: "feat: simple" },
    ]);
    const text = formatScoutIssuesJsonLines(result);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(result.rows.length + 1);
    // Round-trip: each row line re-parses back to the same structure.
    for (let i = 0; i < result.rows.length; i++) {
      const reparsed = JSON.parse(lines[i] as string) as ScoutIssuesRow;
      expect(reparsed).toEqual(result.rows[i] as ScoutIssuesRow);
    }
    const summary = JSON.parse(lines[lines.length - 1] as string);
    expect(summary._summary.total).toBe(2);
    expect(summary._summary.state).toBe("open");
  });
});

describe("runScoutIssues — staleness (v0 watermark seam)", () => {
  test("substrateUpdatedAt is null and staleness is unknown until fetch lands", async () => {
    const result = await runWith([{ id: "a", title: "feat: x" }]);
    expect(result.summary.substrateUpdatedAt).toBe(null);
    expect(result.summary.staleness).toBe("unknown");
  });
});

describe("runScoutIssues — staleness report (scout never fetches)", () => {
  // Fixed clock so staleness comparisons are deterministic.
  const NOW = new Date("2026-05-16T12:00:00Z");
  const now = () => NOW;

  test("fresh watermark → staleness 'fresh', reported verbatim", async () => {
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    const result = await runScoutIssues({
      ...defaultDeps,
      now,
      readSubstrateWatermark: () => fresh,
      execBd: bdOk([{ id: "a", title: "feat: x" }]),
      maxStaleness: "24h",
    });
    expect(result.summary.staleness).toBe("fresh");
    expect(result.summary.substrateUpdatedAt).toBe(fresh);
  });

  test("old watermark → staleness 'stale', no refresh attempted", async () => {
    // 25h old > 24h budget → stale. Scout reports it truthfully and does NOT
    // reach for the fetch actor; the watermark reader is called read-only.
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1_000).toISOString();
    let reads = 0;
    const result = await runScoutIssues({
      ...defaultDeps,
      now,
      readSubstrateWatermark: () => {
        reads += 1;
        return stale;
      },
      execBd: bdOk([{ id: "a", title: "feat: x" }]),
      maxStaleness: "24h",
    });
    // A single read of the watermark — no re-read that a refresh would force.
    expect(reads).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.summary.staleness).toBe("stale");
    expect(result.summary.substrateUpdatedAt).toBe(stale);
  });

  test("cold-start (no watermark) → staleness 'unknown'", async () => {
    const result = await runScoutIssues({
      ...defaultDeps,
      now,
      readSubstrateWatermark: () => null,
      execBd: bdOk([{ id: "a", title: "feat: x" }]),
      maxStaleness: "24h",
    });
    expect(result.summary.staleness).toBe("unknown");
    expect(result.summary.substrateUpdatedAt).toBe(null);
  });
});

describe("extractOwnerRepoFromRef (GH-1257)", () => {
  test("parses an issue URL into owner/repo", () => {
    expect(
      extractOwnerRepoFromRef("https://github.com/bdelanghe/ai-home/issues/1193"),
    ).toBe("bdelanghe/ai-home");
  });

  test("returns null for non-GH refs", () => {
    expect(
      extractOwnerRepoFromRef("https://www.notion.so/Some-Page-abc123"),
    ).toBe(null);
  });

  test("returns null for malformed input", () => {
    expect(extractOwnerRepoFromRef("not a url")).toBe(null);
    expect(extractOwnerRepoFromRef("")).toBe(null);
  });

  test("preserves owner/repo when extra path segments follow", () => {
    expect(
      extractOwnerRepoFromRef(
        "https://github.com/bdelanghe/ai-home/issues/1193/comments",
      ),
    ).toBe("bdelanghe/ai-home");
  });
});

describe("runScoutIssues — sourceRepo projection (GH-1257)", () => {
  test("projects owner/repo from GH external refs and null for bd-only", async () => {
    const result = await runScoutIssues({
      ...defaultDeps,
      // Drop the repo filter so cross-repo rows survive the matching stage.
      repo: undefined,
      isMainxWorktree: () => true,
      execBd: bdOk([
        {
          id: "a",
          title: "feat: in-repo",
          external_ref: "https://github.com/bdelanghe/ai-home/issues/1",
        },
        {
          id: "b",
          title: "feat: planning",
          external_ref: "https://github.com/bdelanghe/beads-planning/issues/2",
        },
        { id: "c", title: "feat: bd-only", external_ref: null },
      ]),
    });
    const bySource = new Map<string | null, string[]>();
    for (const row of result.rows) {
      const key = row.sourceRepo;
      const bucket = bySource.get(key);
      if (bucket) bucket.push(row.id);
      else bySource.set(key, [row.id]);
    }
    expect(bySource.get("bdelanghe/ai-home")?.sort()).toEqual(["a"]);
    expect(bySource.get("bdelanghe/beads-planning")?.sort()).toEqual(["b"]);
    expect(bySource.get(null)?.sort()).toEqual(["c"]);
  });

  test("non-GH external refs project as sourceRepo: null", async () => {
    // Drop the repo filter so a Notion-ref'd record survives matchesRepo
    // (which filters un-parseable refs under any explicit --repo).
    const result = await runScoutIssues({
      ...defaultDeps,
      repo: undefined,
      isMainxWorktree: () => true,
      execBd: bdOk([
        {
          id: "a",
          title: "feat: notion-linked",
          external_ref: "https://www.notion.so/Some-Page-abc123",
        },
      ]),
    });
    expect(result.rows[0]?.sourceRepo).toBe(null);
  });
});

describe("runScoutIssues — ratePoints propagation (GH-1257)", () => {
  test("propagates the DI-injected value onto _summary.ratePoints", async () => {
    const result = await runWith([{ id: "a", title: "feat: x" }], {
      readLastFetchPoints: () => 17,
    });
    expect(result.summary.ratePoints).toBe(17);
  });

  test("null reader → _summary.ratePoints is null", async () => {
    const result = await runWith([{ id: "a", title: "feat: x" }], {
      readLastFetchPoints: () => null,
    });
    expect(result.summary.ratePoints).toBe(null);
  });
});
