import { describe, expect, test } from "bun:test";

import { formatIssueSearchTable, mergeIssueHits } from "../../src/issues/merge.ts";
import type { IssueSearchHit } from "../../src/issues/search.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-xyz",
    title: "bd title",
    description: "bd description",
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

function gh(overrides: Partial<IssueSearchHit> = {}): IssueSearchHit {
  return {
    id: "GH-1",
    state: "OPEN",
    title: "gh thing",
    url: "https://github.com/o/r/issues/1",
    source: "gh",
    ...overrides,
  };
}

function bd(overrides: Partial<IssueSearchHit> = {}): IssueSearchHit {
  return {
    id: "ai-home-aaa",
    state: "open",
    title: "bd thing",
    source: "bd",
    ...overrides,
  };
}

describe("mergeIssueHits", () => {
  test("collapses GH+bd match via externalRef URL into source='both' with beadId", () => {
    const merged = mergeIssueHits(
      [
        gh({
          id: "GH-1186",
          title: "plan view + search",
          url: "https://github.com/o/r/issues/1186",
        }),
      ],
      [bd({ id: "ai-home-aaa", title: "plan view + search" })],
      [
        bead({
          id: "ai-home-aaa",
          title: "plan view + search",
          externalRef: "https://github.com/o/r/issues/1186",
          externalIssueNumber: 1186,
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("GH-1186");
    expect(merged[0]!.source).toBe("both");
    expect(merged[0]!.beadId).toBe("ai-home-aaa");
  });

  test("matches by externalIssueNumber when GH hit has no url", () => {
    const merged = mergeIssueHits(
      [gh({ id: "GH-7", title: "plan thing", url: undefined })],
      [bd({ id: "ai-home-bbb", title: "plan thing" })],
      [
        bead({
          id: "ai-home-bbb",
          title: "plan thing",
          externalRef: null,
          externalIssueNumber: 7,
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("both");
    expect(merged[0]!.beadId).toBe("ai-home-bbb");
  });

  test("GH-only hit passes through as source='gh' with no beadId", () => {
    const merged = mergeIssueHits(
      [gh({ id: "GH-99", title: "lonely gh", url: "u/99" })],
      [],
      [bead({ id: "ai-home-ddd", title: "unrelated" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("GH-99");
    expect(merged[0]!.source).toBe("gh");
    expect(merged[0]!.beadId).toBeUndefined();
  });

  test("bd-only hit passes through as source='bd'", () => {
    const merged = mergeIssueHits(
      [],
      [bd({ id: "ai-home-ccc", title: "alpha-only thing" })],
      [bead({ id: "ai-home-ccc", title: "alpha-only thing" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("ai-home-ccc");
    expect(merged[0]!.source).toBe("bd");
  });

  test("matched bd id is not double-emitted as a standalone bd row", () => {
    const merged = mergeIssueHits(
      [
        gh({
          id: "GH-1",
          url: "https://github.com/o/r/issues/1",
        }),
      ],
      [bd({ id: "ai-home-aaa", title: "gh thing" })],
      [
        bead({
          id: "ai-home-aaa",
          title: "gh thing",
          externalRef: "https://github.com/o/r/issues/1",
          externalIssueNumber: 1,
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("both");
  });

  test("empty bdRecords skips dedupe and just concatenates", () => {
    const merged = mergeIssueHits([gh({ id: "GH-1" })], [bd({ id: "ai-home-aaa" })], []);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.source).toBe("gh");
    expect(merged[1]!.source).toBe("bd");
  });
});

describe("formatIssueSearchTable", () => {
  test("renders the 5-column id/state/source/bd-id/title header", () => {
    const out = formatIssueSearchTable([
      {
        id: "GH-1",
        state: "OPEN",
        title: "t1",
        source: "both",
        beadId: "ai-home-aaaa",
        url: "u1",
      },
    ]);
    const header = out.split("\n")[0]!;
    expect(header.indexOf("id")).toBeLessThan(header.indexOf("state"));
    expect(header.indexOf("state")).toBeLessThan(header.indexOf("source"));
    expect(header.indexOf("source")).toBeLessThan(header.indexOf("bd-id"));
    expect(header.indexOf("bd-id")).toBeLessThan(header.indexOf("title"));
  });

  test("renders bd-id cell as padded blanks for unpromoted rows (column kept stable)", () => {
    const out = formatIssueSearchTable([
      { id: "GH-1", state: "OPEN", title: "t1", source: "gh", url: "u1" },
    ]);
    const lines = out.split("\n");
    // Header still includes `bd-id` column even though no row populates it.
    expect(lines[0]).toContain("bd-id");
    // Row stays five-column: title appears at the right edge, and there is
    // whitespace between `gh` and the title where the bd-id cell sits.
    expect(lines[1]).toContain("t1");
    expect(lines[1]).toMatch(/gh\s{2,}\s+t1$/);
  });

  test("uses dynamic column widths driven by the longest value", () => {
    const out = formatIssueSearchTable([
      {
        id: "ai-home-very-long-id",
        state: "open",
        title: "t1",
        source: "bd",
      },
      {
        id: "GH-1",
        state: "OPEN",
        title: "t2",
        source: "both",
        beadId: "ai-home-aaa",
      },
    ]);
    const lines = out.split("\n");
    // The wider id pushes the `state` column to the same offset in every row.
    // Verify both data rows have their state value at the same column index.
    expect(lines[1]!.indexOf("open")).toBe(lines[2]!.indexOf("OPEN"));
    // bd-id column width is driven by the longest bd id present.
    expect(lines[0]).toContain("bd-id");
    expect(lines[2]).toContain("ai-home-aaa");
  });

  test("stable column order with mixed source rows", () => {
    const out = formatIssueSearchTable([
      {
        id: "GH-1",
        state: "OPEN",
        title: "t1",
        source: "both",
        beadId: "ai-home-aaaa",
        url: "u1",
      },
      { id: "ai-home-bbbb", state: "open", title: "t2", source: "bd" },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("bd-id");
    expect(lines[1]).toContain("GH-1");
    expect(lines[1]).toContain("ai-home-aaaa");
    expect(lines[2]).toContain("ai-home-bbbb");
  });
});
