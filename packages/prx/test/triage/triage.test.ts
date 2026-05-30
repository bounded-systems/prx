import { describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bdPriorityToLabel,
  classifyIssue,
  computeStaleRowsForGh,
  extractIssueNumber,
  findAxisConflicts,
  findBdStale,
  findBdUntriaged,
  findDrift,
  findReverseOrphans,
  findStaleBeads,
  findStaleProjection,
  formatTriageStatus,
  indexBeadsByIssueNumber,
  isCanonicalDupClose,
  loadAllBeads,
  loadJoinRelevantBeads,
  loadTriageScopedBeads,
  normalizeTitle,
  runStatusActor,
  runTriageStatus,
  type BeadsRecord,
  type ReverseOrphanRow,
  type StaleRow,
  type TriageIssueRow,
  type TriageStatusOptions,
  type TriageStatusResult,
} from "../../src/triage/triage.ts";
import type { LocalRepo } from "../../src/pr-state/repos.ts";
import {
  __resetAuditRuntimeContextForTesting,
  getAuditRuntimeContext,
} from "@bounded-systems/audit-context";
import type { BdExecResult } from "@bounded-systems/bd";
import type { FallbackIssue, GitHubIssueState } from "../../src/pr-state/github.ts";

function makeOptions(overrides: Partial<TriageStatusOptions> = {}): TriageStatusOptions {
  return {
    format: "plain",
    limit: 0,
    includeIntentional: false,
    rateLimit: false,
    // GH-1786 — neutralise the read-time freshness gate for the legacy
    // catalog; the dedicated freshness-gate describe block below opts
    // back in and asserts trigger behavior explicitly.
    maxStaleness: "24h",
    noRefresh: true,
    ...overrides,
  };
}

function issue(overrides: Partial<FallbackIssue>): FallbackIssue {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? "title",
    url: overrides.url ?? "https://github.com/o/r/issues/1",
    labels: overrides.labels,
  };
}

function bead(overrides: Partial<BeadsRecord>): BeadsRecord {
  const externalRef = overrides.externalRef ?? null;
  return {
    id: overrides.id ?? "ai-home-x",
    title: overrides.title ?? "title",
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? null,
    issueType: overrides.issueType ?? "task",
    externalRef,
    externalRefs: overrides.externalRefs ?? {},
    metadata: overrides.metadata ?? null,
    externalIssueNumber: overrides.externalIssueNumber ?? extractIssueNumber(externalRef),
    sourceSystem: overrides.sourceSystem ?? null,
    notes: overrides.notes ?? null,
  };
}

function emptyResult(overrides: Partial<TriageStatusResult> = {}): TriageStatusResult {
  return {
    repo: "o/r",
    canonical: "gh",
    totalOpen: 0,
    totalUntriaged: 0,
    totalReverseOrphans: 0,
    totalDrift: 0,
    totalStale: 0,
    totalAxisConflicts: 0,
    issues: [],
    reverseOrphans: [],
    drift: [],
    stale: [],
    axisConflicts: [],
    ...overrides,
  };
}

describe("extractIssueNumber", () => {
  test("parses a canonical issues URL", () => {
    expect(extractIssueNumber("https://github.com/o/r/issues/42")).toBe(42);
  });

  test("ignores query and fragment suffixes", () => {
    expect(extractIssueNumber("https://github.com/o/r/issues/7?x=1")).toBe(7);
    expect(extractIssueNumber("https://github.com/o/r/issues/9#c1")).toBe(9);
  });

  test("returns null for null/empty/non-issues refs", () => {
    expect(extractIssueNumber(null)).toBeNull();
    expect(extractIssueNumber("")).toBeNull();
    expect(extractIssueNumber("https://example.com/foo")).toBeNull();
    expect(extractIssueNumber("https://github.com/o/r/pull/3")).toBeNull();
  });
});

describe("bdPriorityToLabel", () => {
  test("maps the documented priority numbers", () => {
    expect(bdPriorityToLabel(0)).toBe("critical");
    expect(bdPriorityToLabel(1)).toBe("high");
    expect(bdPriorityToLabel(2)).toBe("medium");
    expect(bdPriorityToLabel(3)).toBe("low");
  });

  test("returns 'unknown' for null or out-of-range priorities", () => {
    expect(bdPriorityToLabel(null)).toBe("unknown");
    expect(bdPriorityToLabel(undefined)).toBe("unknown");
    expect(bdPriorityToLabel(7)).toBe("unknown");
  });
});

describe("normalizeTitle", () => {
  test("collapses whitespace, trims, lowercases", () => {
    expect(normalizeTitle("  Foo   Bar\nBaz  ")).toBe("foo bar baz");
  });

  test("treats compatible NFC variants as equal", () => {
    expect(normalizeTitle("café")).toBe(normalizeTitle("café"));
  });
});

describe("indexBeadsByIssueNumber", () => {
  test("only indexes records with a parseable /issues/<n> external_ref", () => {
    const map = indexBeadsByIssueNumber([
      bead({ id: "a", externalRef: "https://github.com/o/r/issues/1" }),
      bead({ id: "b", externalRef: null }),
      bead({ id: "c", externalRef: "https://www.notion.so/abc" }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get(1)?.id).toBe("a");
  });
});

describe("classifyIssue", () => {
  test("flags missing priority, type, and beads-link when no labels and no record", () => {
    const row = classifyIssue(issue({ number: 1, labels: [] }), new Map());
    expect(row.missing).toEqual(["priority", "type", "beads-link"]);
    expect(row.unknownLabels).toEqual([]);
    expect(row.weakSignals).toEqual(["area", "effort"]);
    expect(row.beadsId).toBeNull();
  });

  test("GH-970: priority::none is in-vocab but counts as missing priority (unscored)", () => {
    const row = classifyIssue(
      issue({
        number: 2,
        labels: [{ name: "priority::none" }, { name: "type::task" }],
      }),
      new Map([[2, bead({ id: "ai-home-x", externalRef: "https://github.com/o/r/issues/2" })]]),
    );
    // priority::none is the explicit unscored marker (GH-970); status reports
    // it as missing priority for triage purposes, but it is no longer flagged
    // as an unknown label.
    expect(row.missing).toEqual(["priority"]);
    expect(row.unknownLabels).toEqual([]);
    expect(row.weakSignals).toEqual(["area", "effort"]);
    expect(row.beadsId).toBe("ai-home-x");
  });

  test("flags missing type when only priority is set", () => {
    const row = classifyIssue(
      issue({ number: 3, labels: [{ name: "priority::medium" }] }),
      new Map([[3, bead({ id: "ai-home-y" })]]),
    );
    expect(row.missing).toEqual(["type"]);
    expect(row.unknownLabels).toEqual([]);
    expect(row.weakSignals).toEqual(["area", "effort"]);
  });

  test("flags missing beads-link when no record matches", () => {
    const row = classifyIssue(
      issue({
        number: 4,
        labels: [{ name: "priority::high" }, { name: "type::feature" }],
      }),
      new Map(),
    );
    expect(row.missing).toEqual(["beads-link"]);
    expect(row.unknownLabels).toEqual([]);
    expect(row.beadsId).toBeNull();
  });

  test("GH-1449: multiple known priority labels no longer collapse into missing.priority; surfaced via findAxisConflicts instead", () => {
    const labels = [
      { name: "priority::high" },
      { name: "priority::low" },
      { name: "type::task" },
    ];
    const row = classifyIssue(
      issue({ number: 4, labels }),
      new Map([[4, bead({ id: "ai-home-amb" })]]),
    );
    // The row is fully triaged from the classifier's POV — at least one scored
    // priority is set, a type is set, and the bead link resolves.
    expect(row.missing).toEqual([]);
    expect(row.unknownLabels).toEqual([]);
    // GH-1449: the dual-priority shape is now an axis-conflict, not "missing".
    const conflicts = findAxisConflicts([issue({ number: 4, labels })]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflicts.map((c) => c.axis)).toEqual(["priority"]);
    expect(conflicts[0]!.conflicts[0]!.values.sort()).toEqual(["high", "low"]);
  });

  test("returns empty missing[] and surfaces out-of-vocab labels as unknown", () => {
    const row = classifyIssue(
      issue({
        number: 5,
        labels: [{ name: "priority::low" }, { name: "type::task" }, { name: "agent::architect" }],
      }),
      new Map([[5, bead({ id: "ai-home-z", externalRef: "https://github.com/o/r/issues/5" })]]),
    );
    expect(row.missing).toEqual([]);
    expect(row.unknownLabels).toEqual(["agent::architect"]);
    expect(row.weakSignals).toEqual(["area", "effort"]);
    expect(row.beadsId).toBe("ai-home-z");
  });

  test("priority::low counts as triaged (deliberately deferrable)", () => {
    const row = classifyIssue(
      issue({
        number: 6,
        labels: [{ name: "priority::low" }, { name: "type::task" }],
      }),
      new Map([[6, bead({ id: "ai-home-q", externalRef: "https://github.com/o/r/issues/6" })]]),
    );
    expect(row.missing).toEqual([]);
    expect(row.unknownLabels).toEqual([]);
  });

  test("area::* and effort::* clear the corresponding weakSignals (warn-only)", () => {
    const row = classifyIssue(
      issue({
        number: 7,
        labels: [
          { name: "priority::high" },
          { name: "type::feature" },
          { name: "area::prx" },
          { name: "effort::s" },
        ],
      }),
      new Map([[7, bead({ id: "ai-home-area" })]]),
    );
    expect(row.missing).toEqual([]);
    expect(row.unknownLabels).toEqual([]);
    expect(row.weakSignals).toEqual([]);
  });

  test("only area set → effort surfaces as a single weak signal", () => {
    const row = classifyIssue(
      issue({
        number: 8,
        labels: [
          { name: "priority::medium" },
          { name: "type::feature" },
          { name: "area::prx" },
        ],
      }),
      new Map([[8, bead({ id: "ai-home-only-area" })]]),
    );
    expect(row.missing).toEqual([]);
    expect(row.weakSignals).toEqual(["effort"]);
  });

  test("missing area/effort alone does NOT push the row into `missing` (warn-only contract)", () => {
    const row = classifyIssue(
      issue({
        number: 9,
        labels: [{ name: "priority::medium" }, { name: "type::feature" }],
      }),
      new Map([[9, bead({ id: "ai-home-9" })]]),
    );
    expect(row.missing).toEqual([]);
    expect(row.weakSignals).toEqual(["area", "effort"]);
  });
});

describe("findReverseOrphans", () => {
  test("flags open beads that have no external_ref at all", () => {
    const rows = findReverseOrphans(
      [
        bead({ id: "ai-home-1", externalRef: null, status: "open", priority: 2, issueType: "task" }),
      ],
      false,
    );
    expect(rows).toEqual([
      {
        beadsId: "ai-home-1",
        title: "title",
        status: "open",
        priority: "medium",
        issueType: "task",
        reason: "no-external-ref",
      } as ReverseOrphanRow,
    ]);
  });

  test("does not flag beads with a /issues/<n> external_ref", () => {
    const rows = findReverseOrphans(
      [bead({ id: "ai-home-2", externalRef: "https://github.com/o/r/issues/9" })],
      false,
    );
    expect(rows).toEqual([]);
  });

  test("does not flag beads with a non-GitHub external_ref (intentionally linked elsewhere)", () => {
    const rows = findReverseOrphans(
      [bead({ id: "ai-home-3", externalRef: "https://www.notion.so/abc-page" })],
      false,
    );
    expect(rows).toEqual([]);
  });

  test("does not flag closed beads even when external_ref is missing", () => {
    const rows = findReverseOrphans(
      [bead({ id: "ai-home-4", externalRef: null, status: "closed" })],
      false,
    );
    expect(rows).toEqual([]);
  });

  test("includes in_progress and blocked beads (any non-closed status)", () => {
    const rows = findReverseOrphans(
      [
        bead({ id: "ai-home-5", externalRef: null, status: "in_progress" }),
        bead({ id: "ai-home-6", externalRef: null, status: "blocked" }),
      ],
      false,
    );
    expect(rows.map((r) => r.beadsId)).toEqual(["ai-home-5", "ai-home-6"]);
  });

  test("filters out metadata.bd_only sentinel by default; includes them when --include-intentional", () => {
    const beads = [
      bead({ id: "ai-home-spike", externalRef: null, metadata: { bd_only: true } }),
      bead({ id: "ai-home-real", externalRef: null }),
    ];
    expect(findReverseOrphans(beads, false).map((r) => r.beadsId)).toEqual(["ai-home-real"]);
    expect(findReverseOrphans(beads, true).map((r) => r.beadsId)).toEqual([
      "ai-home-spike",
      "ai-home-real",
    ]);
  });
});

describe("findStaleBeads", () => {
  test("flags an open bead whose linked GH issue is in the closed set", () => {
    const rows = findStaleBeads(
      [
        bead({
          id: "ai-home-9",
          title: "merged but not closed",
          externalRef: "https://github.com/o/r/issues/9",
          status: "open",
          priority: 1,
          issueType: "feature",
        }),
      ],
      new Set([9]),
    );
    expect(rows).toEqual([
      {
        beadsId: "ai-home-9",
        issueNumber: 9,
        url: "https://github.com/o/r/issues/9",
        title: "merged but not closed",
        status: "open",
        priority: "high",
        issueType: "feature",
        reason: "gh-issue-closed",
      } as StaleRow,
    ]);
  });

  test("does not flag a closed bead even when its issue is closed", () => {
    const rows = findStaleBeads(
      [bead({ id: "ai-home-c", externalRef: "https://github.com/o/r/issues/4", status: "closed" })],
      new Set([4]),
    );
    expect(rows).toEqual([]);
  });

  test("does not flag an open bead whose issue is not in the closed set", () => {
    const rows = findStaleBeads(
      [bead({ id: "ai-home-o", externalRef: "https://github.com/o/r/issues/5" })],
      new Set([99]),
    );
    expect(rows).toEqual([]);
  });

  test("does not flag a bead with no GitHub external_ref", () => {
    const rows = findStaleBeads(
      [
        bead({ id: "ai-home-null", externalRef: null }),
        bead({ id: "ai-home-notion", externalRef: "https://www.notion.so/abc" }),
      ],
      new Set([1, 2, 3]),
    );
    expect(rows).toEqual([]);
  });

  test("includes in_progress / blocked beads and emits multiple rows", () => {
    const rows = findStaleBeads(
      [
        bead({ id: "ai-home-1", externalRef: "https://github.com/o/r/issues/1", status: "in_progress" }),
        bead({ id: "ai-home-2", externalRef: "https://github.com/o/r/issues/2", status: "blocked" }),
        bead({ id: "ai-home-3", externalRef: "https://github.com/o/r/issues/3", status: "open" }),
      ],
      new Set([1, 2]),
    );
    expect(rows.map((r) => r.beadsId)).toEqual(["ai-home-1", "ai-home-2"]);
  });
});

describe("findAxisConflicts (GH-1449)", () => {
  test("type::task + type::feature → conflict on type axis", () => {
    const rows = findAxisConflicts([
      issue({
        number: 1,
        labels: [{ name: "type::task" }, { name: "type::feature" }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.number).toBe(1);
    expect(rows[0]!.conflicts).toHaveLength(1);
    expect(rows[0]!.conflicts[0]!.axis).toBe("type");
    expect(rows[0]!.conflicts[0]!.values.sort()).toEqual(["feature", "task"]);
  });

  test("GH-1489: type::task + type::spike → NO conflict (spike is a non-axis marker)", () => {
    const rows = findAxisConflicts([
      issue({
        number: 2,
        labels: [{ name: "type::task" }, { name: "type::spike" }],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("GH-1489: type::feature + type::spike → NO conflict (spike is a non-axis marker)", () => {
    const rows = findAxisConflicts([
      issue({
        number: 3,
        labels: [{ name: "type::feature" }, { name: "type::spike" }],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("type::task + type::feature + type::spike → conflict on type axis (spike excluded from values)", () => {
    const rows = findAxisConflicts([
      issue({
        number: 4,
        labels: [
          { name: "type::task" },
          { name: "type::feature" },
          { name: "type::spike" },
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conflicts).toHaveLength(1);
    expect(rows[0]!.conflicts[0]!.axis).toBe("type");
    expect(rows[0]!.conflicts[0]!.values.sort()).toEqual(["feature", "task"]);
  });

  test("priority::high + priority::low + type::task → conflict on priority axis (and classifier no longer marks missing.priority)", () => {
    const labels = [
      { name: "priority::high" },
      { name: "priority::low" },
      { name: "type::task" },
    ];
    const conflicts = findAxisConflicts([issue({ number: 5, labels })]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflicts.map((c) => c.axis)).toEqual(["priority"]);
    expect(conflicts[0]!.conflicts[0]!.values.sort()).toEqual(["high", "low"]);

    const row = classifyIssue(
      issue({ number: 5, labels }),
      new Map([[5, bead({ id: "ai-home-5", externalRef: "https://github.com/o/r/issues/5" })]]),
    );
    expect(row.missing).toEqual([]);
  });

  test("priority::none + priority::high → NO conflict (none is the explicit unscored marker, excluded from the count)", () => {
    const rows = findAxisConflicts([
      issue({
        number: 6,
        labels: [{ name: "priority::none" }, { name: "priority::high" }],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("area::prx + area::beads → conflict on area axis", () => {
    const rows = findAxisConflicts([
      issue({
        number: 7,
        labels: [{ name: "area::prx" }, { name: "area::beads" }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conflicts).toHaveLength(1);
    expect(rows[0]!.conflicts[0]!.axis).toBe("area");
    expect(rows[0]!.conflicts[0]!.values.sort()).toEqual(["beads", "prx"]);
  });

  test("effort::s + effort::l → conflict on effort axis", () => {
    const rows = findAxisConflicts([
      issue({
        number: 8,
        labels: [{ name: "effort::s" }, { name: "effort::l" }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conflicts).toHaveLength(1);
    expect(rows[0]!.conflicts[0]!.axis).toBe("effort");
    expect(rows[0]!.conflicts[0]!.values.sort()).toEqual(["l", "s"]);
  });

  test("two axes conflicting at once → both appear in conflicts[]", () => {
    const rows = findAxisConflicts([
      issue({
        number: 9,
        labels: [
          { name: "type::task" },
          { name: "type::feature" },
          { name: "area::prx" },
          { name: "area::beads" },
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    const axes = rows[0]!.conflicts.map((c) => c.axis).sort();
    expect(axes).toEqual(["area", "type"]);
  });

  test("out-of-vocab labels do not contribute to any axis count", () => {
    const rows = findAxisConflicts([
      issue({
        number: 10,
        labels: [
          { name: "type::task" },
          { name: "agent::architect" },
          { name: "agent::executor" },
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("a fully-triaged single-axis row → no conflict", () => {
    const rows = findAxisConflicts([
      issue({
        number: 11,
        labels: [
          { name: "type::task" },
          { name: "priority::medium" },
          { name: "area::prx" },
          { name: "effort::s" },
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });
});

describe("findDrift", () => {
  function paired(opts: {
    issueNumber: number;
    ghTitle: string;
    bdTitle: string;
    ghLabels?: string[];
    bdStatus?: string;
    bdPriority?: number | null;
    bdIssueType?: string;
  }) {
    const ref = `https://github.com/o/r/issues/${opts.issueNumber}`;
    return {
      issue: issue({
        number: opts.issueNumber,
        title: opts.ghTitle,
        url: ref,
        labels: (opts.ghLabels ?? []).map((name) => ({ name })),
      }),
      bead: bead({
        id: `ai-home-${opts.issueNumber}`,
        title: opts.bdTitle,
        externalRef: ref,
        status: opts.bdStatus ?? "open",
        priority: opts.bdPriority ?? null,
        issueType: opts.bdIssueType ?? "task",
      }),
    };
  }

  test("returns no rows when all fields agree", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 1,
      ghTitle: "Foo",
      bdTitle: "foo",
      ghLabels: ["type::task", "priority::medium"],
      bdPriority: 2,
      bdIssueType: "task",
    });
    expect(findDrift([bd], [gh])).toEqual([]);
  });

  test("flags title drift after normalization", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 2,
      ghTitle: "Foo Bar",
      bdTitle: "Foo Baz",
    });
    const rows = findDrift([bd], [gh]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.title).toEqual({ gh: "Foo Bar", bd: "Foo Baz" });
  });

  test("flags status drift only when bd is closed and gh is open", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 3,
      ghTitle: "x",
      bdTitle: "x",
      bdStatus: "closed",
    });
    const rows = findDrift([bd], [gh]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.status).toEqual({ gh: "open", bd: "closed" });
  });

  test("flags type drift between bd issue_type and gh type:: label", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 4,
      ghTitle: "x",
      bdTitle: "x",
      ghLabels: ["type::feature"],
      bdIssueType: "task",
    });
    const rows = findDrift([bd], [gh]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.type).toEqual({ gh: "feature", bd: "task" });
  });

  test("flags priority drift between bd numeric priority and gh priority:: label", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 5,
      ghTitle: "x",
      bdTitle: "x",
      ghLabels: ["priority::high"],
      bdPriority: 2,
    });
    const rows = findDrift([bd], [gh]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.priority).toEqual({ gh: "high", bd: "medium" });
  });

  test("does not treat priority::none on GH as drift (untriaged is a forward-orphan condition)", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 6,
      ghTitle: "x",
      bdTitle: "x",
      ghLabels: ["priority::none"],
      bdPriority: 2,
    });
    expect(findDrift([bd], [gh])).toEqual([]);
  });

  test("GH-1532: a lone type::spike paired to bd task is not drift", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 1500,
      ghTitle: "legacy spike",
      bdTitle: "legacy spike",
      ghLabels: ["type::spike"],
      bdIssueType: "task",
    });
    expect(findDrift([bd], [gh])).toEqual([]);
  });

  test("GH-1532: type::spike co-occurring with type::task is not drift in either label order", () => {
    const a = paired({
      issueNumber: 1485,
      ghTitle: "backfilled spike",
      bdTitle: "backfilled spike",
      ghLabels: ["type::spike", "type::task"],
      bdIssueType: "task",
    });
    expect(findDrift([a.bead], [a.issue])).toEqual([]);
    const b = paired({
      issueNumber: 1468,
      ghTitle: "backfilled spike",
      bdTitle: "backfilled spike",
      ghLabels: ["type::task", "type::spike"],
      bdIssueType: "task",
    });
    expect(findDrift([b.bead], [b.issue])).toEqual([]);
  });

  test("GH-1532: a lone type::spike still drifts when bd disagrees with the resolved task", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 1501,
      ghTitle: "x",
      bdTitle: "x",
      ghLabels: ["type::spike"],
      bdIssueType: "feature",
    });
    const rows = findDrift([bd], [gh]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.type).toEqual({ gh: "task", bd: "feature" });
  });

  test("does not flag a beads record with no matching open gh issue", () => {
    const orphan = bead({ id: "ai-home-orphan", externalRef: null });
    expect(findDrift([orphan], [])).toEqual([]);
  });

  test("emits multiple field disagreements in a single drift row", () => {
    const { issue: gh, bead: bd } = paired({
      issueNumber: 7,
      ghTitle: "Apple",
      bdTitle: "Banana",
      ghLabels: ["type::feature", "priority::low"],
      bdIssueType: "task",
      bdPriority: 1,
      bdStatus: "closed",
    });
    const rows = findDrift([bd], [gh]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!.fields).sort()).toEqual(["priority", "status", "title", "type"]);
  });

  // GH-1829: when two bd records share an `external_ref`, a closed sibling
  // carrying the ADR §6 "duplicate of canonical" marker is suppressed iff a
  // sibling on the same external_ref is open. The canonical sibling already
  // mirrors GH state — flagging the dup would be non-actionable.
  describe("GH-1829: §6 canonical-wins suppression", () => {
    const ref = "https://github.com/o/r/issues/1829";
    const sectionSixNotes =
      "duplicate of ai-home-canonical (auto-synced from GH-1829); ADR §6";

    test("closed-as-dup with §6 marker AND open canonical sibling → no drift", () => {
      const dup = bead({
        id: "ai-home-dup",
        title: "title",
        externalRef: ref,
        status: "closed",
        notes: sectionSixNotes,
      });
      const canonical = bead({
        id: "ai-home-canonical",
        title: "title",
        externalRef: ref,
        status: "open",
      });
      const gh = issue({ number: 1829, title: "title", url: ref });
      expect(findDrift([dup, canonical], [gh])).toEqual([]);
    });

    // GH-2378: an externally ASCII-escaped note (e.g. json.dumps default
    // ensure_ascii) stores the literal `§` instead of `§`. The drain must
    // still recognize it as a §6 dup-close and suppress the drift — mirrors the
    // real 19→11 repro where escaped notes blocked drain on 8 records.
    test("escaped `§` (`\\u00a7`) close note with open canonical sibling → no drift", () => {
      const escapedNotes =
        "duplicate of ai-home-canonical (auto-synced from GH-1829); ADR \\u00a76";
      const dup = bead({
        id: "ai-home-dup",
        title: "title",
        externalRef: ref,
        status: "closed",
        notes: escapedNotes,
      });
      const canonical = bead({
        id: "ai-home-canonical",
        title: "title",
        externalRef: ref,
        status: "open",
      });
      const gh = issue({ number: 1829, title: "title", url: ref });
      expect(findDrift([dup, canonical], [gh])).toEqual([]);
    });

    // GH-2375: a §6/dedupe close with no open canonical sibling (the
    // functional-ripple case) used to surface a close-the-GH `status` drift —
    // the false bulk-close signal. A dedupe-close is never a completion signal,
    // so it must no longer contribute `fields.status`, leaving no row here.
    test("closed-as-dup with §6 marker but NO sibling on the same external_ref → no status drift", () => {
      const dup = bead({
        id: "ai-home-dup",
        title: "title",
        externalRef: ref,
        status: "closed",
        notes: sectionSixNotes,
      });
      const gh = issue({ number: 1829, title: "title", url: ref });
      expect(findDrift([dup], [gh])).toEqual([]);
    });

    test("closed bd with open sibling but notes lacks §6 marker → suppressed (GH-2254)", () => {
      // GH-2254: a closed record with NO §6 marker sharing the issue number
      // with an open sibling is a recycled-short-id phantom (or any stale
      // closure). The open sibling is the live canonical, so no false
      // `gh=open / bd=closed` row may be emitted — even though the closed
      // record won the last-wins single-record index slot.
      const dup = bead({
        id: "ai-home-dup",
        title: "title",
        externalRef: ref,
        status: "closed",
        notes: "closed because the team decided to drop this scope",
      });
      const canonical = bead({
        id: "ai-home-canonical",
        title: "title",
        externalRef: ref,
        status: "open",
      });
      const gh = issue({ number: 1829, title: "title", url: ref });
      // Order [canonical, dup] makes the closed record win the last-wins map
      // slot; the re-bind to the open canonical must still suppress the row.
      expect(findDrift([canonical, dup], [gh])).toEqual([]);
    });

    // GH-2375: the exact functional-ripple shape — the §6-closed dup and its
    // canonical sibling both ended up closed, so the GH-1829 whole-row
    // suppression (which requires an *open* canonical) never fires. Order the
    // records so the §6 dup wins the last-wins index slot: its close is a dedupe
    // verdict, not "work shipped", so it must contribute no status drift.
    test("closed bd with §6 marker and sibling that is also closed → no status drift", () => {
      const sibling = bead({
        id: "ai-home-sibling",
        title: "title",
        externalRef: ref,
        status: "closed",
      });
      const dup = bead({
        id: "ai-home-dup",
        title: "title",
        externalRef: ref,
        status: "closed",
        notes: sectionSixNotes,
      });
      const gh = issue({ number: 1829, title: "title", url: ref });
      // [sibling, dup] → the §6 dup wins the last-wins index slot deterministically.
      expect(findDrift([sibling, dup], [gh])).toEqual([]);
    });

    // GH-2375: the legitimate completion-drift path must be preserved. A close
    // whose notes lack the §6/dedupe marker (e.g. "team decided to drop scope")
    // is NOT a dedupe-close, so it still surfaces the close-the-GH status drift.
    test("closed bd with NO §6 marker → still flagged with status drift", () => {
      const closed = bead({
        id: "ai-home-closed",
        title: "title",
        externalRef: ref,
        status: "closed",
        notes: "closed because the team decided to drop this scope",
      });
      const gh = issue({ number: 1829, title: "title", url: ref });
      const rows = findDrift([closed], [gh]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fields.status).toEqual({ gh: "open", bd: "closed" });
    });
  });

  // GH-2254: bd recycles short-ids after a record closes, so a stale closed
  // record can collide on the (domain, external_id) pin of a live one. The
  // drift detector must pair the GH issue with the *open canonical*, never the
  // closed recycled-short-id phantom — surfacing the phantom as
  // `gh=open / bd=closed` drift on 2026-05-28 misled a triage session into
  // closing 5 live issues (GH-138/262/363/1011/2008).
  describe("GH-2254: recycled-short-id phantom suppression", () => {
    const ref = "https://github.com/o/r/issues/2254";
    // Canonical is the auto-synced long-id shape (`bd github sync`); the
    // phantom is a recycled manual short-id with no §6 marker.
    const canonical = bead({
      id: "ai-home-1777496041243-2254-c09ad944",
      title: "bug: short-ids recycle after close",
      externalRef: ref,
      status: "open",
      priority: 1,
      issueType: "bug",
    });
    const phantom = bead({
      id: "ai-home-2p2ki",
      title: "bug: short-ids recycle after close",
      externalRef: ref,
      status: "closed",
      priority: 1,
      issueType: "bug",
      notes: "closed as GH-136/GH-138 dup",
    });
    const gh = issue({
      number: 2254,
      title: "bug: short-ids recycle after close",
      url: ref,
      labels: [{ name: "type::bug" }, { name: "priority::high" }],
    });

    test("open canonical + closed phantom → no status-drift row (phantom first)", () => {
      expect(findDrift([phantom, canonical], [gh])).toEqual([]);
    });

    test("open canonical + closed phantom → no status-drift row (canonical first)", () => {
      expect(findDrift([canonical, phantom], [gh])).toEqual([]);
    });

    test("real field drift on the open canonical is still surfaced (not masked by the phantom)", () => {
      const driftingCanonical = bead({
        ...canonical,
        title: "totally different title",
      });
      const rows = findDrift([phantom, driftingCanonical], [gh]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.beadsId).toBe(driftingCanonical.id);
      expect(rows[0]!.fields.status).toBeUndefined();
      expect(rows[0]!.fields.title).toBeDefined();
    });
  });
});

describe("isCanonicalDupClose", () => {
  const realSection =
    "duplicate of ai-home-canonical (auto-synced from GH-1829); ADR §6";
  // GH-2378: the ASCII-escaped artifact — the literal 6-char `§` that an
  // ensure_ascii JSON round-trip leaves behind in place of a real `§`.
  const escapedSection =
    "duplicate of ai-home-canonical (auto-synced from GH-1829); ADR \\u00a76";

  test("matches the canonical real-`§` close note", () => {
    expect(isCanonicalDupClose(realSection)).toBe(true);
  });

  test("GH-2378: matches the ASCII-escaped `\\u00a7` close note", () => {
    expect(isCanonicalDupClose(escapedSection)).toBe(true);
  });

  test("GH-2378: matches the upper-case escaped `\\u00A7` close note", () => {
    expect(
      isCanonicalDupClose(
        "duplicate of ai-home-canonical; ADR \\u00A76",
      ),
    ).toBe(true);
  });

  test("rejects an unrelated non-dup close note", () => {
    expect(
      isCanonicalDupClose("closed because the team decided to drop this scope"),
    ).toBe(false);
  });

  test("rejects null/empty notes", () => {
    expect(isCanonicalDupClose(null)).toBe(false);
    expect(isCanonicalDupClose(undefined)).toBe(false);
    expect(isCanonicalDupClose("")).toBe(false);
  });
});

describe("loadAllBeads", () => {
  test("parses bd list --json output into BeadsRecord[]", () => {
    const exec = (() =>
      ({
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: "ai-home-1",
            title: "first",
            status: "open",
            priority: 1,
            issue_type: "feature",
            external_ref: "https://github.com/o/r/issues/10",
            metadata: null,
          },
          {
            id: "ai-home-2",
            title: "second",
            status: "closed",
            priority: 2,
            issue_type: "task",
            external_ref: null,
            metadata: { bd_only: true },
          },
        ]),
        stderr: "",
        policy: null,
      } as BdExecResult)) as never;
    const records = loadAllBeads(exec);
    expect(records).toHaveLength(2);
    expect(records[0]!.externalIssueNumber).toBe(10);
    expect(records[1]!.metadata).toEqual({ bd_only: true });
  });

  test("throws on non-zero exit", () => {
    const exec = (() => ({
      exitCode: 1,
      stdout: "",
      stderr: "bd: oops\n",
      policy: null,
    } as BdExecResult)) as never;
    expect(() => loadAllBeads(exec)).toThrow(/bd: oops/);
  });

  // GH-1551: `bd list --all --json --limit 0` can exit non-zero from a
  // *post-listing* dolt auto-sync side-effect while still emitting a complete,
  // valid array on stdout — `loadAllBeads` parses stdout before judging the
  // exit code so the bd leg survives the recoverable failure.
  test("non-zero exit but valid array stdout: warns and returns parsed records", () => {
    const exec = (() =>
      ({
        exitCode: 1,
        stdout: JSON.stringify([
          {
            id: "ai-home-1",
            title: "first",
            status: "open",
            priority: 1,
            issue_type: "feature",
            external_ref: "https://github.com/o/r/issues/10",
            metadata: null,
          },
          {
            id: "ai-home-2",
            title: "second",
            status: "open",
            priority: 2,
            issue_type: "task",
            external_ref: null,
            metadata: null,
          },
        ]),
        stderr: "dolt: push rejected (non-fast-forward)\n",
        policy: null,
      } as BdExecResult)) as never;
    const warnings: string[] = [];
    const records = loadAllBeads(exec, (line) => warnings.push(line));
    expect(records).toHaveLength(2);
    expect(records[0]!.externalIssueNumber).toBe(10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exited non-zero but emitted a valid array");
    expect(warnings[0]).toContain("dolt: push rejected");
  });

  test("non-zero exit with unparseable stdout still throws", () => {
    const exec = (() => ({
      exitCode: 1,
      stdout: "not json",
      stderr: "bd: oops\n",
      policy: null,
    } as BdExecResult)) as never;
    expect(() => loadAllBeads(exec)).toThrow(/bd: oops/);
  });

  // GH-1538: derive `externalRefs` from the post-amendment shape +
  // back-compat from the legacy `external_ref` single-pin.
  function execWith(records: Array<Record<string, unknown>>): typeof import("@bounded-systems/bd").execBd {
    return (() => ({
      exitCode: 0,
      stdout: JSON.stringify(records),
      stderr: "",
      policy: null,
    } as BdExecResult)) as never;
  }

  test("a record with only legacy `external_ref` (GH-shaped) → `externalRefs.gh === external_ref`", () => {
    const records = loadAllBeads(execWith([
      {
        id: "ai-home-1",
        title: "legacy",
        status: "open",
        priority: 1,
        issue_type: "task",
        external_ref: "https://github.com/o/r/issues/10",
        metadata: null,
      },
    ]));
    expect(records[0]!.externalRefs).toEqual({
      gh: "https://github.com/o/r/issues/10",
    });
    expect(records[0]!.externalIssueNumber).toBe(10);
  });

  test("a record with only `metadata.external_refs.notion` → `externalRefs.notion` set; `externalRefs.gh` unset", () => {
    const records = loadAllBeads(execWith([
      {
        id: "ai-home-2",
        title: "notion-pinned",
        status: "open",
        priority: 1,
        issue_type: "task",
        external_ref: null,
        metadata: {
          external_refs: { notion: "https://www.notion.so/abc-page" },
        },
      },
    ]));
    expect(records[0]!.externalRefs).toEqual({
      notion: "https://www.notion.so/abc-page",
    });
    expect(records[0]!.externalIssueNumber).toBeNull();
  });

  test("a record with both legacy `external_ref` (GH) AND `metadata.external_refs.notion` → both keys present", () => {
    const ghUrl = "https://github.com/o/r/issues/1538";
    const notionUrl = "https://www.notion.so/page-1538";
    const records = loadAllBeads(execWith([
      {
        id: "ai-home-3",
        title: "multi-domain",
        status: "open",
        priority: 1,
        issue_type: "task",
        external_ref: ghUrl,
        metadata: { external_refs: { notion: notionUrl } },
      },
    ]));
    expect(records[0]!.externalRefs).toEqual({ gh: ghUrl, notion: notionUrl });
  });

  test("conflict on `gh` slot: legacy `external_ref` wins over divergent `metadata.external_refs.gh`", () => {
    // The recommended precedence: bd-CLI's `bd update --external-ref` writes
    // legacy; the metadata slot is the post-amendment shape. A divergent
    // metadata pin is malformed — legacy wins, plus a warning. Pin the rule
    // so a future code edit can't silently flip it.
    const legacyUrl = "https://github.com/o/r/issues/123";
    const metaUrl = "https://github.com/o/r/issues/456";
    const records = loadAllBeads(execWith([
      {
        id: "ai-home-conflict",
        title: "conflict",
        status: "open",
        priority: 1,
        issue_type: "task",
        external_ref: legacyUrl,
        metadata: { external_refs: { gh: metaUrl } },
      },
    ]));
    expect(records[0]!.externalRefs.gh).toBe(legacyUrl);
  });

  test("malformed `metadata.external_refs` shape (non-string values) is silently skipped", () => {
    // The contract is soft (bd-CLI does not validate it). `loadAllBeads`
    // degrades to "no pin in that domain" rather than throwing.
    const records = loadAllBeads(execWith([
      {
        id: "ai-home-malformed",
        title: "malformed",
        status: "open",
        priority: 1,
        issue_type: "task",
        external_ref: null,
        metadata: {
          external_refs: { gh: 42, notion: "", jira: "  " },
        },
      },
    ]));
    expect(records[0]!.externalRefs).toEqual({});
  });

  test("a non-GH-shaped legacy `external_ref` (e.g. Notion URL) does NOT promote into `externalRefs.gh`", () => {
    // Preserves the existing `findReverseOrphans` contract — a non-GH
    // `external_ref` means the bead is intentionally linked elsewhere.
    const records = loadAllBeads(execWith([
      {
        id: "ai-home-notion-only",
        title: "notion-as-legacy",
        status: "open",
        priority: 1,
        issue_type: "task",
        external_ref: "https://www.notion.so/page-abc",
        metadata: null,
      },
    ]));
    expect(records[0]!.externalRefs).toEqual({});
  });
});

describe("loadJoinRelevantBeads (GH-1573)", () => {
  test("invokes bd sql with --json and the scoped SELECT (planning/planner)", () => {
    let captured: { subcommand: string; args: string[]; state?: string; role?: string } | null = null;
    const exec = ((opts: { subcommand: string; args: string[]; state?: string; role?: string }) => {
      captured = opts;
      return { exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult;
    }) as never;
    loadJoinRelevantBeads(exec);
    expect(captured).not.toBeNull();
    expect(captured!.subcommand).toBe("sql");
    expect(captured!.args).toContain("--json");
    expect(captured!.state).toBe("planning");
    expect(captured!.role).toBe("planner");
    const query = captured!.args.find((arg) => arg.toUpperCase().startsWith("SELECT"));
    expect(query).toBeDefined();
    expect(query!).toContain("FROM issues");
    // `description` is the largest column and the whole point of GH-1573 is
    // to stop fetching it on the per-decision hot path.
    expect(query!).not.toContain("description");
    // The WHERE clause must keep closed beads that still carry a GH link, so
    // `findDrift`'s bd-closed ↔ gh-open arm stays detectable.
    expect(query!).toContain("external_ref IS NOT NULL");
  });

  test("parses bd sql --json rows into BeadsRecord[] (metadata is a JSON string)", () => {
    const exec = (() =>
      ({
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: "ai-home-1",
            title: "first",
            status: "open",
            priority: 1,
            issue_type: "feature",
            external_ref: "https://github.com/o/r/issues/10",
            metadata: "null",
          },
          {
            // bd sql returns metadata as a JSON-encoded string, not the parsed
            // object that bd list --json hands back.
            id: "ai-home-2",
            title: "second",
            status: "open",
            priority: 2,
            issue_type: "task",
            external_ref: null,
            metadata: "{\"bd_only\":true}",
          },
        ]),
        stderr: "",
        policy: null,
      } as BdExecResult)) as never;
    const records = loadJoinRelevantBeads(exec);
    expect(records).toHaveLength(2);
    expect(records[0]!.id).toBe("ai-home-1");
    expect(records[0]!.externalIssueNumber).toBe(10);
    // description must default to "" since we don't fetch it.
    expect(records[0]!.description).toBe("");
    expect(records[1]!.metadata).toEqual({ bd_only: true });
  });

  test("throws on non-zero exit", () => {
    const exec = (() => ({
      exitCode: 1,
      stdout: "",
      stderr: "bd sql: syntax error\n",
      policy: null,
    } as BdExecResult)) as never;
    expect(() => loadJoinRelevantBeads(exec)).toThrow(/bd sql: syntax error/);
  });

  test("throws on malformed JSON stdout", () => {
    const exec = (() => ({
      exitCode: 0,
      stdout: "not json",
      stderr: "",
      policy: null,
    } as BdExecResult)) as never;
    expect(() => loadJoinRelevantBeads(exec)).toThrow(/returned invalid JSON/);
  });

  test("throws on row shape drift (missing id)", () => {
    const exec = (() => ({
      exitCode: 0,
      stdout: JSON.stringify([{ title: "no id here" }]),
      stderr: "",
      policy: null,
    } as BdExecResult)) as never;
    expect(() => loadJoinRelevantBeads(exec)).toThrow(/row shape drift/);
  });
});

describe("loadTriageScopedBeads (GH-1691)", () => {
  type Tmp = { root: string; beadsDir: string; cleanup: () => void };
  function makeBeadsDir(metadata: object | null): Tmp {
    const root = mkdtempSync(join(tmpdir(), "triage-scoped-"));
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    if (metadata !== null) {
      writeFileSync(join(beadsDir, "metadata.json"), JSON.stringify(metadata));
    }
    return {
      root,
      beadsDir,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  test("embedded-mode workspace falls back to bd list --all --json", () => {
    const tmp = makeBeadsDir({ dolt_mode: "embedded", dolt_database: "io_github_test_embedded" });
    try {
      const captured: Array<{ subcommand: string; args: string[] }> = [];
      const exec = ((opts: { subcommand: string; args: string[] }) => {
        captured.push({ subcommand: opts.subcommand, args: opts.args });
        if (opts.subcommand === "sql") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "'bd sql' is not yet supported in embedded mode",
            policy: null,
          } as BdExecResult;
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "ai-home-1",
              title: "first",
              description: "long desc",
              status: "open",
              priority: 1,
              issue_type: "feature",
              external_ref: "https://github.com/o/r/issues/10",
              metadata: null,
            },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult;
      }) as never;

      const warnings: string[] = [];
      const records = loadTriageScopedBeads(tmp.beadsDir, exec, (line) => warnings.push(line));

      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe("ai-home-1");
      expect(captured.some((c) => c.subcommand === "sql")).toBe(false);
      expect(captured.some((c) => c.subcommand === "list")).toBe(true);
      expect(warnings.some((w) => /GH-1691/.test(w))).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  test("per-project workspace uses scoped bd sql projection", () => {
    const tmp = makeBeadsDir({ dolt_mode: "per-project", dolt_database: "io_github_test_pp" });
    try {
      const captured: Array<{ subcommand: string; args: string[] }> = [];
      const exec = ((opts: { subcommand: string; args: string[] }) => {
        captured.push({ subcommand: opts.subcommand, args: opts.args });
        return { exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult;
      }) as never;

      const warnings: string[] = [];
      loadTriageScopedBeads(tmp.beadsDir, exec, (line) => warnings.push(line));

      expect(captured.some((c) => c.subcommand === "sql")).toBe(true);
      expect(captured.some((c) => c.subcommand === "list")).toBe(false);
      expect(warnings).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });

  test("missing metadata.json defaults to per-project (scoped) read", () => {
    const tmp = makeBeadsDir(null);
    try {
      const captured: Array<{ subcommand: string }> = [];
      const exec = ((opts: { subcommand: string }) => {
        captured.push({ subcommand: opts.subcommand });
        return { exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult;
      }) as never;

      loadTriageScopedBeads(tmp.beadsDir, exec);
      expect(captured.some((c) => c.subcommand === "sql")).toBe(true);
      expect(captured.some((c) => c.subcommand === "list")).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("formatTriageStatus", () => {
  test("renders JSON exactly as the result", () => {
    const result = emptyResult({
      totalOpen: 1,
      totalUntriaged: 1,
      issues: [{ number: 1, title: "t", url: "u", labels: [], beadsId: null, missing: ["priority"], unknownLabels: [], weakSignals: [] }],
    });
    expect(JSON.parse(formatTriageStatus(result, "json"))).toEqual(result);
  });

  test("plain output reports clean queue when nothing is flagged (GH-1449: short-circuit includes axisConflicts)", () => {
    const result = emptyResult({ totalOpen: 12 });
    expect(formatTriageStatus(result, "plain")).toBe(
      "All 12 open issues in o/r are triaged with no reverse orphans, pair drift, stale beads, or axis conflicts.",
    );
  });

  test("GH-1449: plain headline shows · N axis-conflict and renders the Axis Conflicts section", () => {
    const result = emptyResult({
      totalOpen: 4,
      totalAxisConflicts: 1,
      axisConflicts: [
        {
          number: 1449,
          title: "GH issue with dual type labels",
          url: "https://github.com/o/r/issues/1449",
          conflicts: [{ axis: "type", values: ["task", "feature"] }],
        },
      ],
    });
    const text = formatTriageStatus(result, "plain");
    expect(text).toContain(
      "0 untriaged · 0 reverse-orphan · 0 drift · 0 stale · 1 axis-conflict in o/r (4 open)",
    );
    expect(text).toContain("Axis Conflicts (1):");
    expect(text).toContain("GH-1449");
    expect(text).toContain("type: task, feature");
  });

  test("GH-1449: all-clear short-circuit still fires when totalAxisConflicts === 0 alongside zeroes", () => {
    const result = emptyResult({ totalOpen: 7 });
    // Pin the *exact* short-circuit headline so a regression in the boolean
    // (e.g. forgetting the `&& totalAxisConflicts === 0` arm) is caught.
    const text = formatTriageStatus(result, "plain");
    expect(text).toBe(
      "All 7 open issues in o/r are triaged with no reverse orphans, pair drift, stale beads, or axis conflicts.",
    );
  });

  test("plain output renders four sections with the count header", () => {
    const issues: TriageIssueRow[] = [
      { number: 7, title: "thing", url: "u", labels: [], beadsId: null, missing: ["priority", "type"], unknownLabels: [], weakSignals: [] },
    ];
    const reverseOrphans: ReverseOrphanRow[] = [
      {
        beadsId: "ai-home-rev",
        title: "private spike",
        status: "open",
        priority: "medium",
        issueType: "task",
        reason: "no-external-ref",
      },
    ];
    const stale: StaleRow[] = [
      {
        beadsId: "ai-home-77",
        issueNumber: 77,
        url: "https://github.com/o/r/issues/77",
        title: "merged but not closed",
        status: "open",
        priority: "high",
        issueType: "feature",
        reason: "gh-issue-closed",
      },
    ];
    const result = emptyResult({
      totalOpen: 5,
      totalUntriaged: issues.length,
      totalReverseOrphans: reverseOrphans.length,
      totalDrift: 1,
      totalStale: stale.length,
      issues,
      reverseOrphans,
      drift: [
        {
          issueNumber: 99,
          beadsId: "ai-home-99",
          fields: { title: { gh: "Foo", bd: "Bar" } },
        },
      ],
      stale,
    });
    const text = formatTriageStatus(result, "plain");
    expect(text).toContain(
      "1 untriaged · 1 reverse-orphan · 1 drift · 1 stale · 0 axis-conflict in o/r (5 open)",
    );
    expect(text).toContain("Untriaged (1):");
    expect(text).toContain("Reverse Orphans (1):");
    expect(text).toContain("Drift (1):");
    expect(text).toContain("Stale (1):");
    expect(text).toContain("ai-home-rev");
    expect(text).toContain("GH-99 ↔ ai-home-99");
    expect(text).toContain('title: gh="Foo"  bd="Bar"');
    expect(text).toContain("ai-home-77  GH-77");
    expect(text).toContain("→ GH issue closed; bead still open");
  });

  test("plain header shows · 0 stale and no Stale section when nothing is stale", () => {
    const result = emptyResult({
      totalOpen: 3,
      totalUntriaged: 1,
      issues: [
        { number: 1, title: "t", url: "u", labels: [], beadsId: null, missing: ["priority"], unknownLabels: [], weakSignals: [] },
      ],
    });
    const text = formatTriageStatus(result, "plain");
    expect(text).toContain(
      "1 untriaged · 0 reverse-orphan · 0 drift · 0 stale · 0 axis-conflict in o/r (3 open)",
    );
    expect(text).not.toContain("Stale (");
    expect(text).not.toContain("Axis Conflicts (");
  });

  test("plain output appends [unknown-labels: …] when row carries out-of-vocab labels", () => {
    const result = emptyResult({
      totalOpen: 1,
      totalUntriaged: 1,
      issues: [
        {
          number: 9,
          title: "legacy",
          url: "u",
          labels: ["priority::none", "type::task", "agent::architect"],
          beadsId: null,
          missing: ["priority"],
          unknownLabels: ["priority::none", "agent::architect"],
          weakSignals: [],
        },
      ],
    });
    const text = formatTriageStatus(result, "plain");
    expect(text).toContain("[missing: priority]");
    expect(text).toContain("[unknown-labels: priority::none, agent::architect]");
  });

  test("plain output appends [weak: …] when row carries weakSignals", () => {
    const result = emptyResult({
      totalOpen: 1,
      totalUntriaged: 1,
      issues: [
        {
          number: 11,
          title: "feat: x",
          url: "u",
          labels: ["priority::medium"],
          beadsId: null,
          missing: ["type", "beads-link"],
          unknownLabels: [],
          weakSignals: ["area", "effort"],
        },
      ],
    });
    const text = formatTriageStatus(result, "plain");
    expect(text).toContain("[missing: type, beads-link]");
    expect(text).toContain("[weak: area, effort]");
  });
});

describe("runTriageStatus", () => {
  test("uses --repo when provided and skips repoNameWithOwner", () => {
    let resolveCalls = 0;
    const logs: string[] = [];
    const exitCode = runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: ((repo: string) => {
          expect(repo).toBe("o/r");
          return [
            { number: 10, title: "needs priority", url: "https://github.com/o/r/issues/10", labels: [{ name: "type::task" }] },
          ] as FallbackIssue[];
        }) as never,
        repoNameWithOwner: (() => {
          resolveCalls++;
          return "wrong/repo";
        }) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(resolveCalls).toBe(0);
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.repo).toBe("o/r");
    expect(result.totalUntriaged).toBe(1);
    expect(result.issues[0]!.missing).toEqual(["priority", "beads-link"]);
  });

  test("falls back to repoNameWithOwner(cwd) when --repo is omitted", () => {
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        repoNameWithOwner: ((cwd: string) => {
          expect(cwd).toBe("/repo");
          return "owner/inferred";
        }) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never,
        cwd: () => "/repo",
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.repo).toBe("owner/inferred");
  });

  test("calls bd sql with the planning/planner policy override and a scoped SELECT (GH-1573)", () => {
    const bdCalls: Array<{ subcommand: string; args: string[]; state?: string; role?: string }> = [];
    runTriageStatus(
      makeOptions({ repo: "o/r" }),
      { log: () => undefined, error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: ((opts: { subcommand: string; args: string[]; state?: string; role?: string }) => {
          bdCalls.push(opts);
          return { exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult;
        }) as never,
      },
    );
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.subcommand).toBe("sql");
    expect(bdCalls[0]!.args).toContain("--json");
    expect(bdCalls[0]!.state).toBe("planning");
    expect(bdCalls[0]!.role).toBe("planner");
    // Scoped projection: `description` is the largest column and triage never
    // reads it, so it must not appear in the SELECT. The WHERE clause must
    // keep closed beads that still carry a GH link (drift / stale detection
    // depends on them).
    const query = bdCalls[0]!.args.find((arg) => arg.toUpperCase().startsWith("SELECT"));
    expect(query).toBeDefined();
    expect(query!).toContain("id");
    expect(query!).toContain("title");
    expect(query!).toContain("status");
    expect(query!).toContain("priority");
    expect(query!).toContain("issue_type");
    expect(query!).toContain("external_ref");
    expect(query!).toContain("metadata");
    expect(query!).not.toContain("description");
    expect(query!).toContain("external_ref IS NOT NULL");
  });

  test("filters out fully-triaged issues from the report", () => {
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          {
            number: 1,
            title: "good",
            url: "https://github.com/o/r/issues/1",
            labels: [{ name: "priority::medium" }, { name: "type::task" }],
          },
          {
            number: 2,
            title: "bad",
            url: "https://github.com/o/r/issues/2",
            labels: [{ name: "priority::none" }, { name: "type::task" }],
          },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-1", title: "good", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/1" },
            { id: "ai-home-2", title: "bad", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/2" },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.totalOpen).toBe(2);
    expect(result.totalUntriaged).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.number).toBe(2);
    expect(result.issues[0]!.missing).toEqual(["priority"]);
  });

  test("populates reverseOrphans and drift in the integrated payload", () => {
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          {
            number: 100,
            title: "Foo",
            url: "https://github.com/o/r/issues/100",
            labels: [{ name: "priority::medium" }, { name: "type::task" }],
          },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            // paired but title drift
            { id: "ai-home-100", title: "Bar", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/100" },
            // reverse orphan
            { id: "ai-home-rev", title: "lonely", status: "open", priority: 2, issue_type: "task", external_ref: null },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.totalReverseOrphans).toBe(1);
    expect(result.reverseOrphans[0]!.beadsId).toBe("ai-home-rev");
    expect(result.totalDrift).toBe(1);
    expect(result.drift[0]!.fields.title).toEqual({ gh: "Foo", bd: "Bar" });
    expect(result.totalUntriaged).toBe(0);
  });

  test("flags a stale bead when its linked GH issue is in the closed list", () => {
    let closedCalls = 0;
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        listIssuesByState: ((repo: string, state: string) => {
          closedCalls += 1;
          expect(repo).toBe("o/r");
          expect(state).toBe("closed");
          return [{ number: 999, title: "merged", url: "https://github.com/o/r/issues/999", labels: [] }] as FallbackIssue[];
        }) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-999", title: "merged", status: "open", priority: 1, issue_type: "feature", external_ref: "https://github.com/o/r/issues/999" },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(closedCalls).toBe(1);
    expect(result.totalStale).toBe(1);
    expect(result.stale[0]!.beadsId).toBe("ai-home-999");
    expect(result.stale[0]!.issueNumber).toBe(999);
    expect(result.stale[0]!.reason).toBe("gh-issue-closed");
  });

  test("does not flag a candidate bead when its issue is absent from the closed list", () => {
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        listIssuesByState: (() => [] as FallbackIssue[]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-999", title: "merged", status: "open", priority: 1, issue_type: "feature", external_ref: "https://github.com/o/r/issues/999" },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.totalStale).toBe(0);
    expect(result.stale).toEqual([]);
  });

  test("skips the closed-issue fetch when every open bead maps to an open issue (zero candidates)", () => {
    let closedCalls = 0;
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          { number: 100, title: "Foo", url: "https://github.com/o/r/issues/100", labels: [{ name: "priority::medium" }, { name: "type::task" }] },
        ]) as never,
        listIssuesByState: (() => {
          closedCalls += 1;
          return [] as FallbackIssue[];
        }) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: "ai-home-100", title: "Foo", status: "open", priority: 2, issue_type: "task", external_ref: "https://github.com/o/r/issues/100" },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(closedCalls).toBe(0);
    expect(result.totalStale).toBe(0);
  });

  test("GH-1449: surfaces dual-axis labels in axisConflicts and out of missing.priority", () => {
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          {
            number: 1449,
            title: "dual priority",
            url: "https://github.com/o/r/issues/1449",
            labels: [
              { name: "priority::high" },
              { name: "priority::low" },
              { name: "type::task" },
            ],
          },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "ai-home-1449",
              title: "dual priority",
              status: "open",
              priority: 1,
              issue_type: "task",
              external_ref: "https://github.com/o/r/issues/1449",
            },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.totalAxisConflicts).toBe(1);
    expect(result.axisConflicts).toHaveLength(1);
    expect(result.axisConflicts[0]!.number).toBe(1449);
    expect(result.axisConflicts[0]!.conflicts[0]!.axis).toBe("priority");
    expect(result.axisConflicts[0]!.conflicts[0]!.values.sort()).toEqual(["high", "low"]);
    // The row is NOT also flagged as missing-priority — it has a scored value,
    // just an inconsistent set of them. The two semantic categories are now
    // separate per GH-1449.
    expect(result.totalUntriaged).toBe(0);
    expect(result.issues).toEqual([]);
  });

  test("respects includeIntentional by default-excluding bd_only sentinel records", () => {
    // GH-1573: `bd sql --json` returns the `metadata` column as a JSON-encoded
    // string (the raw DB form), not the parsed object that `bd list --json`
    // hands back. `loadJoinRelevantBeads` parses it inline.
    const stdout = JSON.stringify([
      { id: "ai-home-spike", title: "spike", status: "open", priority: 2, issue_type: "task", external_ref: null, metadata: "{\"bd_only\":true}" },
    ]);
    const exec = (() =>
      ({ exitCode: 0, stdout, stderr: "", policy: null } as BdExecResult)) as never;

    const logsDefault: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logsDefault.push(l), error: () => undefined },
      { listOpenIssues: (() => []) as never, execBd: exec },
    );
    expect((JSON.parse(logsDefault[0]!) as TriageStatusResult).totalReverseOrphans).toBe(0);

    const logsInclude: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json", includeIntentional: true }),
      { log: (l) => logsInclude.push(l), error: () => undefined },
      { listOpenIssues: (() => []) as never, execBd: exec },
    );
    expect((JSON.parse(logsInclude[0]!) as TriageStatusResult).totalReverseOrphans).toBe(1);
  });

  test("propagates a bd list failure as a thrown error", () => {
    expect(() =>
      runTriageStatus(
        makeOptions({ repo: "o/r" }),
        { log: () => undefined, error: () => undefined },
        {
          listOpenIssues: (() => []) as never,
          execBd: (() => ({ exitCode: 1, stdout: "", stderr: "bd: oops\n", policy: null } as BdExecResult)) as never,
        },
      ),
    ).toThrow(/bd: oops/);
  });
});

describe("runTriageStatus + --rate-limit", () => {
  test("flag absent → no rateLimit field, no refresh/estimate calls", () => {
    let refreshCalls = 0;
    let estimateCalls = 0;
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never,
        refreshBudget: ((() => {
          refreshCalls += 1;
          return null;
        }) as never),
        estimateSweepCost: ((() => {
          estimateCalls += 1;
          return { perBucket: { core: 0, graphql: 0, search: 0 }, sample: { calls: 0, avg: 2 } };
        }) as never),
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.rateLimit).toBeUndefined();
    expect(refreshCalls).toBe(0);
    expect(estimateCalls).toBe(0);
  });

  test("flag set → snapshots + estimate populated; queueSize sums all three queues", () => {
    const snapshots = [
      { bucket: "core" as const, limit: 5000, remaining: 4994, resetAt: 1700000000000, fetchedAt: 0 },
      { bucket: "graphql" as const, limit: 5000, remaining: 4823, resetAt: 1700000000000, fetchedAt: 0 },
      { bucket: "search" as const, limit: 30, remaining: 29, resetAt: 1700000000000, fetchedAt: 0 },
    ];
    let receivedQueue = -1;
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "json", rateLimit: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => [
          // 2 untriaged
          { number: 1, title: "x", url: "u", labels: [] },
          { number: 2, title: "y", url: "u", labels: [] },
        ]) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            // 1 reverse orphan
            { id: "ai-home-rev", title: "lonely", status: "open", priority: 2, issue_type: "task", external_ref: null },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
        refreshBudget: (() => snapshots) as never,
        estimateSweepCost: ((queueSize: number) => {
          receivedQueue = queueSize;
          return {
            perBucket: { core: 0, graphql: 6, search: 0 },
            sample: { calls: 18, avg: 2.0 },
          };
        }) as never,
      },
    );
    const result = JSON.parse(logs[0]!) as TriageStatusResult;
    expect(result.rateLimit).toBeDefined();
    expect(result.rateLimit!.snapshots).toEqual(snapshots);
    expect(result.rateLimit!.estimate.sample.avg).toBe(2.0);
    // 2 untriaged + 1 reverse orphan + 0 drift = 3
    expect(receivedQueue).toBe(3);
  });

  test("plain output appends GitHub budget block when rateLimit set", () => {
    const logs: string[] = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", format: "plain", rateLimit: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never,
        refreshBudget: (() =>
          [
            { bucket: "core", limit: 5000, remaining: 4994, resetAt: 1700000000000, fetchedAt: 0 },
            { bucket: "graphql", limit: 5000, remaining: 4823, resetAt: 1700000000000, fetchedAt: 0 },
            { bucket: "search", limit: 30, remaining: 29, resetAt: 1700000000000, fetchedAt: 0 },
          ]) as never,
        estimateSweepCost: (() => ({
          perBucket: { core: 0, graphql: 0, search: 0 },
          sample: { calls: 0, avg: 2 },
        })) as never,
      },
    );
    const text = logs.join("\n");
    expect(text).toContain("GitHub budget:");
    expect(text).toContain("graphql:  4823/5000");
    expect(text).toMatch(/Estimated sweep cost: ~0 GraphQL points \(cold sample, fallback avg 2\.0 pts\/issue\)/);
  });
});

// GH-1602: `runStatusActor` is the one triage verb that intentionally keeps gh
// as the source of truth (forward-orphan / drift / stale all need an
// authoritative GH-side answer). Pin that the two residual gh calls are made
// inside `withGhTruthReason` with the load-bearing reason, so the rate-limit
// audit log distinguishes a justified comparator from an accidental gh
// fallback the GH-1602 refactor missed.
describe("runStatusActor — withGhTruthReason on residual gh comparators (GH-1602)", () => {
  function emptyExecBd(): never {
    return ((): BdExecResult => ({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
      policy: null,
    })) as never;
  }

  test("tags the open-issue read with drift-comparator", () => {
    __resetAuditRuntimeContextForTesting();
    let observedReason: string | null | undefined = "unset";
    runStatusActor(makeOptions({ repo: "o/r", format: "json" }), {
      listOpenIssues: ((_repo: string, _limit: number) => {
        observedReason = getAuditRuntimeContext().ghTruthReason;
        return [] as FallbackIssue[];
      }) as never,
      listIssuesByState: (() => [] as FallbackIssue[]) as never,
      execBd: emptyExecBd(),
    });
    expect(observedReason).toBe("drift-comparator");
    // The wrapper restores the prior value on exit.
    expect(getAuditRuntimeContext().ghTruthReason).toBeNull();
  });

  test("tags the closed-issue lookup with stale-comparator", () => {
    __resetAuditRuntimeContextForTesting();
    let observedReason: string | null | undefined = "unset";
    runStatusActor(makeOptions({ repo: "o/r", format: "json" }), {
      // An open issue paired with an open bead pointing at a *different* gh
      // number forces resolveClosedIssueNumbers to do the closed-list fetch
      // (candidates.size > 0).
      listOpenIssues: (() => [
        {
          number: 100,
          title: "Foo",
          url: "https://github.com/o/r/issues/100",
          labels: [{ name: "priority::medium" }, { name: "type::task" }],
        },
      ]) as never,
      listIssuesByState: ((_repo: string, state: GitHubIssueState, _limit: number) => {
        observedReason = getAuditRuntimeContext().ghTruthReason;
        expect(state).toBe("closed");
        return [] as FallbackIssue[];
      }) as never,
      execBd: (() =>
        ({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "ai-home-999",
              title: "merged",
              status: "open",
              priority: 1,
              issue_type: "feature",
              external_ref: "https://github.com/o/r/issues/999",
            },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
    });
    expect(observedReason).toBe("stale-comparator");
    expect(getAuditRuntimeContext().ghTruthReason).toBeNull();
  });
});

// GH-1449: axis-exclusivity plumbing through `runStatusActor` on canonical=gh.
// The unit-level pure-helper coverage lives in `describe("findAxisConflicts")`;
// this test pins the snapshot wiring (`totalAxisConflicts` + `axisConflicts`)
// so a regression in the actor entrypoint surfaces here, not just at the CLI.
describe("runStatusActor — axis-conflicts plumbing (GH-1449)", () => {
  test("emits axisConflicts and totalAxisConflicts in the snapshot for a dual-axis issue", () => {
    const result = runStatusActor(makeOptions({ repo: "o/r", format: "json" }), {
      listOpenIssues: (() => [
        {
          number: 1449,
          title: "dual axis",
          url: "https://github.com/o/r/issues/1449",
          labels: [
            { name: "type::task" },
            { name: "type::feature" },
            { name: "priority::medium" },
          ],
        },
      ]) as never,
      execBd: (() => ({
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: "ai-home-1449",
            title: "dual axis",
            status: "open",
            priority: 2,
            issue_type: "task",
            external_ref: "https://github.com/o/r/issues/1449",
          },
        ]),
        stderr: "",
        policy: null,
      } as BdExecResult)) as never,
    });
    expect(result.snapshot.totalAxisConflicts).toBe(1);
    expect(result.snapshot.axisConflicts).toHaveLength(1);
    expect(result.snapshot.axisConflicts[0]!.number).toBe(1449);
    expect(result.snapshot.axisConflicts[0]!.conflicts[0]!.axis).toBe("type");
  });
});

// GH-1710: canonical-axis branch. Verifies the bd-canonical projection drops
// reverse-orphan + drift buckets, redefines open/untriaged/stale against
// bd-only state, and makes zero GH calls (catastrophe surfaces as an
// exception if it does — `listOpenIssues` is unset in deps).
describe("canonical=bd triage status (GH-1710)", () => {
  function bdCanonicalRepo(overrides: Partial<LocalRepo> = {}): LocalRepo {
    return {
      name: "demo-repo",
      commonDir: "/bare/io.github/demo/demo-repo.git",
      kind: "bare",
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [],
      primaryRemote: {
        name: "origin",
        url: "git@github.com:demo/demo-repo.git",
        githubRepo: "demo/demo-repo",
      },
      upstreamRemote: null,
      canonical: "bd",
      ...overrides,
    };
  }

  function bdBead(overrides: Partial<BeadsRecord>): BeadsRecord {
    return {
      id: overrides.id ?? "supply-plan-1",
      title: overrides.title ?? "feat(plan): scope graphsync",
      description: overrides.description ?? "",
      status: overrides.status ?? "open",
      priority: overrides.priority ?? null,
      issueType: overrides.issueType ?? "",
      externalRef: overrides.externalRef ?? null,
      externalRefs: overrides.externalRefs ?? {},
      metadata: overrides.metadata ?? null,
      externalIssueNumber: overrides.externalIssueNumber ?? null,
      sourceSystem: overrides.sourceSystem ?? null,
      updatedAt: overrides.updatedAt ?? null,
    };
  }

  function makeExecBdReturningBeads(records: BeadsRecord[]) {
    return ((_args: unknown, _env?: unknown) => {
      const stdout = JSON.stringify(
        records.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          status: r.status,
          priority: r.priority,
          issue_type: r.issueType,
          external_ref: r.externalRef,
          source_system: r.sourceSystem,
          metadata: r.metadata,
          updated_at: r.updatedAt,
          dependencies: [],
        })),
      );
      return { exitCode: 0, stdout, stderr: "", policy: null } as BdExecResult;
    }) as never;
  }

  test("findBdUntriaged flags beads missing priority or issueType", () => {
    const rows = findBdUntriaged(
      [
        bdBead({ id: "a", priority: null, issueType: "feature" }), // missing priority
        bdBead({ id: "b", priority: 1, issueType: "" }), // missing type
        bdBead({ id: "c", priority: null, issueType: "" }), // missing both
        bdBead({ id: "d", priority: 2, issueType: "task" }), // fully triaged
        bdBead({ id: "e", priority: null, issueType: "", status: "closed" }), // closed, skipped
      ],
      false,
    );
    expect(rows.map((r) => r.beadsId)).toEqual(["a", "b", "c"]);
    expect(rows[0]!.missing).toEqual(["priority"]);
    expect(rows[1]!.missing).toEqual(["type"]);
    expect(rows[2]!.missing).toEqual(["priority", "type"]);
  });

  test("findBdUntriaged honors metadata.bd_only unless includeIntentional is set", () => {
    const records = [
      bdBead({ id: "memo", priority: null, issueType: "", metadata: { bd_only: true } }),
    ];
    expect(findBdUntriaged(records, false)).toEqual([]);
    expect(findBdUntriaged(records, true).map((r) => r.beadsId)).toEqual(["memo"]);
  });

  test("findBdStale flags open beads older than thresholdDays", () => {
    const now = new Date("2026-05-14T00:00:00Z");
    const records = [
      bdBead({ id: "fresh", updatedAt: "2026-05-13T00:00:00Z" }), // 1d
      bdBead({ id: "stale", updatedAt: "2026-03-01T00:00:00Z" }), // 74d
      bdBead({ id: "no-ts" }), // null updatedAt, skipped
      bdBead({ id: "closed", status: "closed", updatedAt: "2026-03-01T00:00:00Z" }),
    ];
    const rows = findBdStale(records, 30, now, false);
    expect(rows.map((r) => r.beadsId)).toEqual(["stale"]);
    expect(rows[0]!.daysSince).toBeGreaterThanOrEqual(30);
  });

  test("runStatusActor makes zero GH calls on canonical=bd", () => {
    const ghCalls: string[] = [];
    const records = [
      bdBead({ id: "a", priority: null, issueType: "feature", updatedAt: "2026-05-13T00:00:00Z" }),
      bdBead({ id: "b", priority: 1, issueType: "task", updatedAt: "2026-01-01T00:00:00Z" }),
    ];
    const result = runStatusActor(makeOptions({ format: "json" }), {
      cwd: () => "/some/cwd",
      localRepoForCwd: () => bdCanonicalRepo(),
      execBd: makeExecBdReturningBeads(records),
      listOpenIssues: ((..._args: unknown[]) => {
        ghCalls.push("listOpenIssues");
        return [];
      }) as never,
      listIssuesByState: ((..._args: unknown[]) => {
        ghCalls.push("listIssuesByState");
        return [];
      }) as never,
      now: () => new Date("2026-05-14T00:00:00Z"),
    });
    expect(ghCalls).toEqual([]);
    expect(result.snapshot.canonical).toBe("bd");
    expect(result.snapshot.totalOpen).toBe(2);
    expect(result.snapshot.totalReverseOrphans).toBe(0);
    expect(result.snapshot.totalDrift).toBe(0);
    expect(result.snapshot.bdUntriaged?.length).toBe(1);
    expect(result.snapshot.bdStale?.length).toBe(1);
  });

  test("formatTriageStatus canonical=bd suppresses reverse-orphan and drift lines (plain)", () => {
    const out = formatTriageStatus(
      {
        repo: "demo/demo-repo",
        canonical: "bd",
        totalOpen: 3,
        totalUntriaged: 1,
        totalReverseOrphans: 0,
        totalDrift: 0,
        totalStale: 1,
        totalAxisConflicts: 0,
        issues: [],
        reverseOrphans: [],
        drift: [],
        stale: [],
        axisConflicts: [],
        bdUntriaged: [
          {
            beadsId: "spd-1",
            title: "feat: foo",
            status: "open",
            priority: "unknown",
            issueType: "",
            missing: ["priority", "type"],
          },
        ],
        bdStale: [
          {
            beadsId: "spd-2",
            title: "fix: bar",
            status: "open",
            priority: "high",
            issueType: "bug",
            lastTouched: "2025-12-01T00:00:00Z",
            daysSince: 165,
          },
        ],
      },
      "plain",
    );
    expect(out).not.toContain("reverse-orphan");
    expect(out).not.toContain("drift");
    expect(out).toContain("bd-canonical");
    expect(out).toContain("Untriaged (1)");
    expect(out).toContain("Stale (1)");
    expect(out).toContain("spd-1");
    expect(out).toContain("spd-2");
  });

  test("formatTriageStatus canonical=bd happy-path headline (all triaged)", () => {
    const out = formatTriageStatus(
      {
        repo: "demo/demo-repo",
        canonical: "bd",
        totalOpen: 5,
        totalUntriaged: 0,
        totalReverseOrphans: 0,
        totalDrift: 0,
        totalStale: 0,
        totalAxisConflicts: 0,
        issues: [],
        reverseOrphans: [],
        drift: [],
        stale: [],
        axisConflicts: [],
        bdUntriaged: [],
        bdStale: [],
      },
      "plain",
    );
    expect(out).toContain("All 5 open beads in demo/demo-repo (bd-canonical) are triaged");
  });

  test("canonical=bd: runStatusActor and findAxisConflicts emit no axis-conflict rows (substrate has no labels)", () => {
    const records = [
      bdBead({ id: "spd-1", priority: 1, issueType: "feature" }),
    ];
    const result = runStatusActor(makeOptions({ format: "json" }), {
      cwd: () => "/some/cwd",
      localRepoForCwd: () => bdCanonicalRepo(),
      execBd: makeExecBdReturningBeads(records),
      listOpenIssues: ((..._args: unknown[]) => {
        throw new Error("listOpenIssues must not be called on canonical=bd");
      }) as never,
      listIssuesByState: ((..._args: unknown[]) => {
        throw new Error("listIssuesByState must not be called on canonical=bd");
      }) as never,
      now: () => new Date("2026-05-14T00:00:00Z"),
    });
    expect(result.snapshot.canonical).toBe("bd");
    expect(result.snapshot.totalAxisConflicts).toBe(0);
    expect(result.snapshot.axisConflicts).toEqual([]);
  });
});

describe("findStaleProjection", () => {
  function bdCanonicalRepo(): LocalRepo {
    return {
      name: "demo-repo",
      commonDir: "/bare/io.github/demo/demo-repo.git",
      kind: "bare",
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [],
      primaryRemote: {
        name: "origin",
        url: "git@github.com:demo/demo-repo.git",
        githubRepo: "demo/demo-repo",
      },
      upstreamRemote: null,
      canonical: "bd",
    };
  }

  test("gh-canonical: returns stale rows from the resolveClosedIssueNumbers + findStaleBeads pipeline", () => {
    const closedListCalls: Array<{ repo: string; state: string }> = [];
    const result = findStaleProjection(
      { repo: "o/r" },
      {
        cwd: () => "/some/cwd",
        listOpenIssues: (() => []) as never,
        listIssuesByState: ((repo: string, state: string) => {
          closedListCalls.push({ repo, state });
          return [
            { number: 999, title: "merged", url: "https://github.com/o/r/issues/999", labels: [] },
          ] as FallbackIssue[];
        }) as never,
        execBd: (() => ({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "ai-home-999",
              title: "merged",
              status: "open",
              priority: 1,
              issue_type: "feature",
              external_ref: "https://github.com/o/r/issues/999",
            },
          ]),
          stderr: "",
          policy: null,
        } as BdExecResult)) as never,
      },
    );
    expect(result.canonical).toBe("gh");
    expect(result.repo).toBe("o/r");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.beadsId).toBe("ai-home-999");
    expect(result.rows[0]!.issueNumber).toBe(999);
    expect(result.rows[0]!.reason).toBe("gh-issue-closed");
    expect(closedListCalls).toHaveLength(1);
    expect(closedListCalls[0]).toEqual({ repo: "o/r", state: "closed" });
  });

  test("bd-canonical: short-circuits to empty rows without any GH call", () => {
    const ghCalls: string[] = [];
    const bdCalls: string[] = [];
    const result = findStaleProjection(
      {},
      {
        cwd: () => "/some/cwd",
        localRepoForCwd: () => bdCanonicalRepo(),
        listOpenIssues: ((..._args: unknown[]) => {
          ghCalls.push("listOpenIssues");
          return [];
        }) as never,
        listIssuesByState: ((..._args: unknown[]) => {
          ghCalls.push("listIssuesByState");
          return [];
        }) as never,
        execBd: ((opts: { subcommand: string }) => {
          bdCalls.push(opts.subcommand);
          return { exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult;
        }) as never,
      },
    );
    expect(result.canonical).toBe("bd");
    expect(result.rows).toEqual([]);
    expect(result.repo).toBe("demo/demo-repo");
    expect(ghCalls).toEqual([]);
    expect(bdCalls).toEqual([]);
  });
});

describe("computeStaleRowsForGh", () => {
  test("delegates to resolveClosedIssueNumbers + findStaleBeads against pre-loaded state (zero double-fetch)", () => {
    let listByStateCalls = 0;
    const allBeads: BeadsRecord[] = [
      bead({
        id: "ai-home-999",
        title: "merged",
        externalRef: "https://github.com/o/r/issues/999",
      }),
      bead({
        id: "ai-home-100",
        title: "still-open",
        externalRef: "https://github.com/o/r/issues/100",
      }),
    ];
    const openIssues: FallbackIssue[] = [
      issue({ number: 100, url: "https://github.com/o/r/issues/100" }),
    ];
    const listByState = ((repo: string, state: string) => {
      listByStateCalls += 1;
      expect(repo).toBe("o/r");
      expect(state).toBe("closed");
      return [
        { number: 999, title: "merged", url: "https://github.com/o/r/issues/999", labels: [] },
      ] as FallbackIssue[];
    }) as never;
    const rows = computeStaleRowsForGh(allBeads, openIssues, "o/r", 1000, listByState);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beadsId).toBe("ai-home-999");
    expect(rows[0]!.issueNumber).toBe(999);
    expect(rows[0]!.reason).toBe("gh-issue-closed");
    expect(listByStateCalls).toBe(1);
  });

  test("tags the closed-issue lookup with 'stale-comparator' (audit-context preserved across extraction)", () => {
    __resetAuditRuntimeContextForTesting();
    let observedReason: string | null | undefined = "unset";
    const allBeads: BeadsRecord[] = [
      bead({
        id: "ai-home-999",
        externalRef: "https://github.com/o/r/issues/999",
      }),
    ];
    const openIssues: FallbackIssue[] = [];
    const listByState = ((_repo: string, _state: string) => {
      observedReason = getAuditRuntimeContext().ghTruthReason;
      return [{ number: 999, title: "merged", url: "u", labels: [] }] as FallbackIssue[];
    }) as never;
    computeStaleRowsForGh(allBeads, openIssues, "o/r", 1000, listByState);
    expect(observedReason).toBe("stale-comparator");
  });

  test("empty open-issue + zero candidates: returns empty without consulting listByState", () => {
    let listByStateCalls = 0;
    const allBeads: BeadsRecord[] = [
      bead({
        id: "ai-home-100",
        externalRef: "https://github.com/o/r/issues/100",
      }),
    ];
    const openIssues: FallbackIssue[] = [
      issue({ number: 100, url: "https://github.com/o/r/issues/100" }),
    ];
    const listByState = ((..._args: unknown[]) => {
      listByStateCalls += 1;
      return [] as FallbackIssue[];
    }) as never;
    const rows = computeStaleRowsForGh(allBeads, openIssues, "o/r", 1000, listByState);
    expect(rows).toEqual([]);
    expect(listByStateCalls).toBe(0);
  });
});

// GH-1786 — read-time freshness gate for `prx triage status`. Mirrors the
// scout/issues coverage matrix; both verbs share the same gate primitives
// in `../../src/fetch/freshness-gate.ts` so the contracts must line up.
describe("runTriageStatus — read-time freshness gate (GH-1786)", () => {
  const NOW = new Date("2026-05-16T12:00:00Z");
  const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
  const STALE = new Date(NOW.getTime() - 25 * 60 * 60 * 1_000).toISOString();

  function bdEmpty() {
    return (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null } as BdExecResult)) as never;
  }

  test("cache-hit (fresh): refresher is NOT called", () => {
    const refreshCalls: Array<{ repo: string | undefined }> = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", noRefresh: false, maxStaleness: "24h" }),
      { log: () => undefined, error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: bdEmpty(),
        readSubstrateWatermark: () => FRESH,
        refreshSubstrate: (args) => {
          refreshCalls.push(args);
          return { ok: true };
        },
        now: () => NOW,
      },
    );
    expect(refreshCalls).toHaveLength(0);
  });

  test("cache-miss (stale): refresher IS called once with the resolved repo", () => {
    const refreshCalls: Array<{ repo: string | undefined; cwd: string }> = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", noRefresh: false, maxStaleness: "24h" }),
      { log: () => undefined, error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: bdEmpty(),
        readSubstrateWatermark: () => STALE,
        refreshSubstrate: (args) => {
          refreshCalls.push(args);
          return { ok: true };
        },
        now: () => NOW,
      },
    );
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.repo).toBe("o/r");
  });

  test("cold-start (unknown): missing watermark triggers a refresh", () => {
    const refreshCalls: Array<{ repo: string | undefined }> = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", noRefresh: false, maxStaleness: "24h" }),
      { log: () => undefined, error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: bdEmpty(),
        readSubstrateWatermark: () => null,
        refreshSubstrate: (args) => {
          refreshCalls.push(args);
          return { ok: true };
        },
        now: () => NOW,
      },
    );
    expect(refreshCalls).toHaveLength(1);
  });

  test("fetch-failure passthrough: stale read continues + reason logs to stderr", () => {
    const errLines: string[] = [];
    const exitCode = runTriageStatus(
      makeOptions({ repo: "o/r", noRefresh: false, maxStaleness: "24h", format: "json" }),
      { log: () => undefined, error: (l) => errLines.push(l) },
      {
        listOpenIssues: (() => []) as never,
        execBd: bdEmpty(),
        readSubstrateWatermark: () => STALE,
        refreshSubstrate: () => ({
          ok: false,
          reason: "fetch BUDGET_EXHAUSTED: graphql bucket empty",
        }),
        now: () => NOW,
      },
    );
    expect(exitCode).toBe(0);
    expect(errLines.some((l) => /BUDGET_EXHAUSTED/.test(l))).toBe(true);
  });

  test("--no-refresh opt-out: refresher never called regardless of age", () => {
    const refreshCalls: Array<{ repo: string | undefined }> = [];
    runTriageStatus(
      makeOptions({ repo: "o/r", noRefresh: true, maxStaleness: "24h" }),
      { log: () => undefined, error: () => undefined },
      {
        listOpenIssues: (() => []) as never,
        execBd: bdEmpty(),
        readSubstrateWatermark: () => STALE,
        refreshSubstrate: (args) => {
          refreshCalls.push(args);
          return { ok: true };
        },
        now: () => NOW,
      },
    );
    expect(refreshCalls).toHaveLength(0);
  });

  test("runStatusActor mirrors the gate (parity with the CLI entry)", () => {
    const refreshCalls: Array<{ repo: string | undefined }> = [];
    runStatusActor(
      makeOptions({ repo: "o/r", noRefresh: false, maxStaleness: "24h" }),
      {
        listOpenIssues: (() => []) as never,
        execBd: bdEmpty(),
        readSubstrateWatermark: () => STALE,
        refreshSubstrate: (args) => {
          refreshCalls.push(args);
          return { ok: true };
        },
        now: () => NOW,
      },
    );
    expect(refreshCalls).toHaveLength(1);
  });
});
