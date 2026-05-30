// GH-983 — `selectDelegateCandidate` projection tests.
//
// Covers the pure projection (`src/beads/delegate.ts`) over fixture
// `NextWorkResult`s. The CLI wiring (filter parsing, JSON shape,
// enrichment plumbing) is tested in `test/pr-state/cli.test.ts`'s
// `delegate next command` describe block — these tests focus on the
// ranking + filter combinatorics in isolation.

import { describe, expect, test } from "bun:test";

import {
  DelegateNextFiltersSchema,
  formatDelegateNext,
  formatDelegateNextList,
  selectDelegateCandidate,
} from "../../src/beads/delegate.ts";
import type { NextWorkResult } from "../../src/beads/ready.ts";

function fixture(threads: NextWorkResult["threads"]): NextWorkResult {
  return {
    source: "next-work",
    repo: "owner/repo",
    threads,
    cache: {
      queried_at: "2026-05-16T00:00:00.000+00:00",
      stale: false,
      ttl_seconds: 60,
      refreshed: false,
    },
  };
}

const baseCandidate = {
  bd_id: "bd-1",
  gh_issue: 1,
  title: "first",
  priority: 2,
  issue_type: "feature",
  branch: null,
  worktree_path: null,
  status: "open" as const,
  blocked_by: [],
  reason: "ready",
  command: null,
};

describe("DelegateNextFiltersSchema", () => {
  test("accepts empty filters and defaults `all` to false", () => {
    const parsed = DelegateNextFiltersSchema.parse({});
    expect(parsed.all).toBe(false);
    expect(parsed.epic).toBeUndefined();
  });

  test("rejects malformed --epic", () => {
    const result = DelegateNextFiltersSchema.safeParse({ epic: "974" });
    expect(result.success).toBe(false);
  });

  test("accepts well-formed --epic", () => {
    const parsed = DelegateNextFiltersSchema.parse({ epic: "GH-974" });
    expect(parsed.epic).toBe("GH-974");
  });
});

describe("selectDelegateCandidate", () => {
  test("empty input returns empty candidates and no-match reason", () => {
    const result = selectDelegateCandidate(fixture([]));
    expect(result.source).toBe("delegate-next");
    expect(result.candidates).toEqual([]);
    expect(result.reason).toContain("no candidates matched");
    expect(result.suggested_command).toBeNull();
  });

  test("top-1 default returns just the highest-priority candidate", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [
            { ...baseCandidate, bd_id: "bd-low", priority: 3, gh_issue: 10 },
            { ...baseCandidate, bd_id: "bd-hi", priority: 0, gh_issue: 20 },
          ],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
      ]),
    );
    expect(projection.candidates).toHaveLength(1);
    expect(projection.candidates[0]!.bd_id).toBe("bd-hi");
  });

  test("--all returns the full filtered list, sorted by priority then thread", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [{ ...baseCandidate, bd_id: "bd-p2", priority: 2 }],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
        {
          kind: "orphan_cleanup",
          candidates: [{ ...baseCandidate, bd_id: "bd-p1", priority: 1 }],
          recommended_action: "",
          cost_of_context_switch: "low",
          reason: "",
        },
      ]),
      { filters: { all: true } },
    );
    expect(projection.candidates.map((c) => c.bd_id)).toEqual([
      "bd-p1",
      "bd-p2",
    ]);
  });

  test("thread precedence breaks priority ties", () => {
    // orphan_cleanup comes before ready_to_start in DELEGATE_THREAD_PRECEDENCE.
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [{ ...baseCandidate, bd_id: "bd-r1", priority: 1 }],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
        {
          kind: "orphan_cleanup",
          candidates: [{ ...baseCandidate, bd_id: "bd-o1", priority: 1 }],
          recommended_action: "",
          cost_of_context_switch: "low",
          reason: "",
        },
      ]),
      { filters: { all: true } },
    );
    expect(projection.candidates[0]!.thread).toBe("orphan_cleanup");
  });

  test("--priority filters numerically", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [
            { ...baseCandidate, bd_id: "bd-p1", priority: 1 },
            { ...baseCandidate, bd_id: "bd-p3", priority: 3 },
          ],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
      ]),
      { filters: { priority: 3 } },
    );
    expect(projection.candidates).toHaveLength(1);
    expect(projection.candidates[0]!.bd_id).toBe("bd-p3");
  });

  test("--type filters by issue_type", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [
            { ...baseCandidate, bd_id: "bd-bug", issue_type: "bug" },
            { ...baseCandidate, bd_id: "bd-feat", issue_type: "feature" },
          ],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
      ]),
      { filters: { type: "bug" } },
    );
    expect(projection.candidates).toHaveLength(1);
    expect(projection.candidates[0]!.bd_id).toBe("bd-bug");
  });

  test("--area requires enrichment.labelsByBdId", () => {
    const r = fixture([
      {
        kind: "ready_to_start",
        candidates: [
          { ...baseCandidate, bd_id: "bd-prx" },
          { ...baseCandidate, bd_id: "bd-other" },
        ],
        recommended_action: "",
        cost_of_context_switch: "high",
        reason: "",
      },
    ]);

    // Without enrichment → no candidate matches.
    const without = selectDelegateCandidate(r, { filters: { area: "prx" } });
    expect(without.candidates).toHaveLength(0);

    // With enrichment → only the labeled bd_id matches.
    const labelsByBdId = new Map<string, string[]>([
      ["bd-prx", ["area::prx"]],
      ["bd-other", ["area::other"]],
    ]);
    const withEnrichment = selectDelegateCandidate(r, {
      filters: { area: "prx", all: true },
      enrichment: { labelsByBdId },
    });
    expect(withEnrichment.candidates.map((c) => c.bd_id)).toEqual(["bd-prx"]);
  });

  test("--epic requires enrichment.epicChildBdIds", () => {
    const r = fixture([
      {
        kind: "ready_to_start",
        candidates: [
          { ...baseCandidate, bd_id: "bd-child-a" },
          { ...baseCandidate, bd_id: "bd-other" },
        ],
        recommended_action: "",
        cost_of_context_switch: "high",
        reason: "",
      },
    ]);

    const withEnrichment = selectDelegateCandidate(r, {
      filters: { epic: "GH-974", all: true },
      enrichment: { epicChildBdIds: new Set(["bd-child-a"]) },
    });
    expect(withEnrichment.candidates.map((c) => c.bd_id)).toEqual([
      "bd-child-a",
    ]);
  });

  test("preserves thread's typed command when present", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "orphan_cleanup",
          candidates: [
            {
              ...baseCandidate,
              bd_id: "bd-orphan",
              command: "prx worktree-remove GH-1 --delete-branch",
            },
          ],
          recommended_action: "",
          cost_of_context_switch: "low",
          reason: "",
        },
      ]),
    );
    expect(projection.candidates[0]!.suggested_command).toBe(
      "prx worktree-remove GH-1 --delete-branch",
    );
  });

  test("falls back to `prx plan session <bd_id>` for ready_to_start with no command", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [{ ...baseCandidate, bd_id: "bd-r", command: null }],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
      ]),
    );
    expect(projection.candidates[0]!.suggested_command).toBe(
      "prx plan session bd-r",
    );
  });

  test("formatDelegateNext renders the top-1 surface", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [{ ...baseCandidate, bd_id: "bd-r", title: "do the thing" }],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
      ]),
    );
    const out = formatDelegateNext(projection);
    expect(out).toContain("delegate next");
    expect(out).toContain("bd-r");
    expect(out).toContain("do the thing");
    expect(out).toContain("ready_to_start");
  });

  test("formatDelegateNextList renders all candidates", () => {
    const projection = selectDelegateCandidate(
      fixture([
        {
          kind: "ready_to_start",
          candidates: [
            { ...baseCandidate, bd_id: "bd-a" },
            { ...baseCandidate, bd_id: "bd-b" },
          ],
          recommended_action: "",
          cost_of_context_switch: "high",
          reason: "",
        },
      ]),
      { filters: { all: true } },
    );
    const out = formatDelegateNextList(projection);
    expect(out).toContain("2 candidates");
    expect(out).toContain("bd-a");
    expect(out).toContain("bd-b");
  });
});
