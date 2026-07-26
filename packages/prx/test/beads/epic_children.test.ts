import { describe, expect, test } from "bun:test";

import { findEpicChildren } from "../../src/beads/epic_children.ts";

describe("findEpicChildren — Front Desk source (GH-1011)", () => {
  const rows = [
    {
      id: "GH-100",
      title: "the epic",
      status: "open",
      external_ref: "https://github.com/bounded-systems/prx/issues/100",
      dependencies: [
        { issue_id: "GH-100", depends_on_id: "GH-2", type: "parent-child" },
        { issue_id: "GH-100", depends_on_id: "GH-1", type: "parent-child" },
        { issue_id: "GH-100", depends_on_id: "GH-9", type: "blocks" }, // not a child
      ],
    },
    { id: "GH-1", title: "child one", status: "open", dependencies: [] },
    { id: "GH-2", title: "child two", status: "closed", dependencies: [] },
    { id: "GH-9", title: "a blocker", status: "open", dependencies: [] },
  ];

  test("enumerates parent-child children (GH-canonical), sorted, with state", () => {
    process.env.PRX_LIST_SOURCE = "frontdesk";
    const out = findEpicChildren("/repo", 100, undefined, () => rows);
    expect(out).toEqual([
      { ghNumber: 1, title: "child one", state: "open" },
      { ghNumber: 2, title: "child two", state: "closed" },
    ]);
  });

  test("empty when the epic GH number is absent", () => {
    process.env.PRX_LIST_SOURCE = "frontdesk";
    expect(findEpicChildren("/repo", 404, undefined, () => rows)).toEqual([]);
  });

  test("ignores non parent-child edges (e.g. blocks)", () => {
    process.env.PRX_LIST_SOURCE = "frontdesk";
    const out = findEpicChildren("/repo", 100, undefined, () => rows);
    expect(out.map((c) => c.ghNumber)).not.toContain(9);
  });
});
