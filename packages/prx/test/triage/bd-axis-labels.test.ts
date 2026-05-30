// GH-2382 — the shared bd→external axis-label projection. `issueLabelsFor` /
// `priorityLabelValue` are the single source `prx beads publish`, the GH
// adapter's linked push, and the `prx beads sync` push leg all derive their
// desired label set from; `axisLabelDiff` is the lossless swap core.

import { describe, expect, test } from "bun:test";

import {
  axisLabelDiff,
  ghTypeLabel,
  issueLabelsFor,
  priorityLabelValue,
} from "../../src/triage/bd-axis-labels.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-1",
    title: "t",
    description: "b",
    status: "open",
    priority: 1,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

describe("priorityLabelValue", () => {
  test("0-3 map to the GH rungs", () => {
    expect(priorityLabelValue(0)).toBe("critical");
    expect(priorityLabelValue(1)).toBe("high");
    expect(priorityLabelValue(2)).toBe("medium");
    expect(priorityLabelValue(3)).toBe("low");
  });
  test("P4 backlog clamps to low, null → none (GH-2313)", () => {
    expect(priorityLabelValue(4)).toBe("low");
    expect(priorityLabelValue(null)).toBe("none");
  });
});

describe("ghTypeLabel", () => {
  test("round-trippable types pass through; others coerce to task", () => {
    expect(ghTypeLabel("bug")).toBe("bug");
    expect(ghTypeLabel("epic")).toBe("epic");
    expect(ghTypeLabel("spike")).toBe("task"); // GH-only marker, not in BD_TYPE_ENUM
    expect(ghTypeLabel("story")).toBe("task");
  });
});

describe("issueLabelsFor", () => {
  test("projects type + priority axis labels", () => {
    expect(issueLabelsFor(bead({ issueType: "bug", priority: 0 }))).toEqual([
      "type::bug",
      "priority::critical",
    ]);
  });
});

describe("axisLabelDiff", () => {
  test("priority bump: add the new rung, strip the stale one", () => {
    const diff = axisLabelDiff(
      ["type::task", "priority::low", "area::prx", "needs-triage"],
      ["type::task", "priority::medium"],
    );
    expect(diff.add).toEqual(["priority::medium"]);
    expect(diff.remove).toEqual(["priority::low"]);
  });

  test("preserves foreign + unmanaged-axis labels (area/effort/agent)", () => {
    const diff = axisLabelDiff(
      ["priority::high", "area::beads", "effort::m", "agent::x"],
      ["type::task", "priority::high"],
    );
    expect(diff.add).toEqual(["type::task"]);
    expect(diff.remove).toEqual([]);
  });

  test("never strips GH-only type::spike / type::decision markers", () => {
    const diff = axisLabelDiff(
      ["type::task", "type::spike", "type::decision"],
      ["type::task", "priority::high"],
    );
    expect(diff.add).toEqual(["priority::high"]);
    expect(diff.remove).toEqual([]);
  });

  test("strips a stale bd-enum type when bd type changes", () => {
    const diff = axisLabelDiff(["type::bug", "priority::high"], ["type::task", "priority::high"]);
    expect(diff.add).toEqual(["type::task"]);
    expect(diff.remove).toEqual(["type::bug"]);
  });

  test("in sync → empty diff", () => {
    const diff = axisLabelDiff(["type::task", "priority::high"], ["type::task", "priority::high"]);
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
  });
});
