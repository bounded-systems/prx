import { describe, expect, test } from "bun:test";

import {
  listIssuesByStateFromBeads,
  listOpenIssuesFromBeads,
} from "../../src/triage/issues-from-beads.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";

// Fake `execBd` factory — returns rows as bd's `bd list --json` would, so the
// projection sees the same shape it does in production.
function fakeBdList(rows: unknown[]): (opts: BdExecOptions) => BdExecResult {
  return (opts) => {
    expect(opts.subcommand).toBe("list");
    expect(opts.args).toEqual(["--all", "--json", "--limit", "0"]);
    return {
      exitCode: 0,
      stdout: JSON.stringify(rows),
      stderr: "",
      policy: null,
    };
  };
}

describe("listOpenIssuesFromBeads", () => {
  test("projects bd rows with a GH external_ref into FallbackIssue shape", () => {
    const exec = fakeBdList([
      {
        id: "ai-home-1",
        title: "fix the thing",
        status: "open",
        external_ref: "https://github.com/bdelanghe/ai-home/issues/42",
        labels: ["area::prx", "priority::high"],
      },
    ]);
    const result = listOpenIssuesFromBeads("bdelanghe/ai-home", 0, exec as never);
    expect(result).toEqual([
      {
        number: 42,
        title: "fix the thing",
        url: "https://github.com/bdelanghe/ai-home/issues/42",
        labels: [{ name: "area::prx" }, { name: "priority::high" }],
      },
    ]);
  });

  test("filters out rows whose external_ref points at a different repo", () => {
    const exec = fakeBdList([
      {
        id: "ai-home-1",
        title: "ours",
        status: "open",
        external_ref: "https://github.com/bdelanghe/ai-home/issues/1",
        labels: [],
      },
      {
        id: "other-1",
        title: "theirs",
        status: "open",
        external_ref: "https://github.com/someone-else/repo/issues/9",
        labels: [],
      },
    ]);
    const result = listOpenIssuesFromBeads("bdelanghe/ai-home", 0, exec as never);
    expect(result.map((r) => r.number)).toEqual([1]);
  });

  test("excludes closed bd rows from the open projection", () => {
    const exec = fakeBdList([
      {
        id: "ai-home-1",
        title: "open one",
        status: "open",
        external_ref: "https://github.com/o/r/issues/1",
      },
      {
        id: "ai-home-2",
        title: "closed one",
        status: "closed",
        external_ref: "https://github.com/o/r/issues/2",
      },
    ]);
    const result = listOpenIssuesFromBeads("o/r", 0, exec as never);
    expect(result.map((r) => r.number)).toEqual([1]);
  });

  test("skips bd rows that have no GH external_ref or metadata pin", () => {
    const exec = fakeBdList([
      {
        id: "ai-home-1",
        title: "linked",
        status: "open",
        external_ref: "https://github.com/o/r/issues/1",
      },
      {
        id: "ai-home-2",
        title: "bd-only reverse orphan",
        status: "open",
        external_ref: null,
      },
    ]);
    const result = listOpenIssuesFromBeads("o/r", 0, exec as never);
    expect(result.map((r) => r.number)).toEqual([1]);
  });

  // GH-1538 amendment shape: when `external_ref` is empty, fall through to
  // `metadata.external_refs.gh`. Mirrors `loadAllBeads`'s precedence so the
  // projection stays consistent with the rest of the triage substrate.
  test("falls back to metadata.external_refs.gh when external_ref is empty", () => {
    const exec = fakeBdList([
      {
        id: "ai-home-1",
        title: "via metadata",
        status: "open",
        external_ref: "",
        metadata: {
          external_refs: { gh: "https://github.com/o/r/issues/77" },
        },
      },
    ]);
    const result = listOpenIssuesFromBeads("o/r", 0, exec as never);
    expect(result).toEqual([
      {
        number: 77,
        title: "via metadata",
        url: "https://github.com/o/r/issues/77",
        labels: [],
      },
    ]);
  });

  test("tolerates labels: null and missing labels", () => {
    const exec = fakeBdList([
      {
        id: "ai-home-1",
        title: "no labels",
        status: "open",
        external_ref: "https://github.com/o/r/issues/1",
        labels: null,
      },
      {
        id: "ai-home-2",
        title: "absent labels",
        status: "open",
        external_ref: "https://github.com/o/r/issues/2",
      },
    ]);
    const result = listOpenIssuesFromBeads("o/r", 0, exec as never);
    expect(result.map((r) => r.labels)).toEqual([[], []]);
  });

  test("applies a positive limit and preserves bd's row order", () => {
    const exec = fakeBdList([
      { id: "a", title: "1", status: "open", external_ref: "https://github.com/o/r/issues/1" },
      { id: "b", title: "2", status: "open", external_ref: "https://github.com/o/r/issues/2" },
      { id: "c", title: "3", status: "open", external_ref: "https://github.com/o/r/issues/3" },
    ]);
    const result = listOpenIssuesFromBeads("o/r", 2, exec as never);
    expect(result.map((r) => r.number)).toEqual([1, 2]);
  });

  test("limit <= 0 means no cap (mirrors gh helper's --limit 0 semantics)", () => {
    const exec = fakeBdList([
      { id: "a", title: "1", status: "open", external_ref: "https://github.com/o/r/issues/1" },
      { id: "b", title: "2", status: "open", external_ref: "https://github.com/o/r/issues/2" },
    ]);
    expect(listOpenIssuesFromBeads("o/r", 0, exec as never).map((r) => r.number)).toEqual([1, 2]);
  });

  test("propagates a bd-list failure as a thrown error", () => {
    const exec = (() => ({
      exitCode: 1,
      stdout: "",
      stderr: "bd: no database found",
      policy: null,
    })) as never;
    expect(() => listOpenIssuesFromBeads("o/r", 0, exec)).toThrow("bd: no database found");
  });

  test("rejects bd-list returning non-array JSON", () => {
    const exec = (() => ({
      exitCode: 0,
      stdout: '{"oops": true}',
      stderr: "",
      policy: null,
    })) as never;
    expect(() => listOpenIssuesFromBeads("o/r", 0, exec)).toThrow(
      /expected bd list --json to return an array/,
    );
  });
});

describe("listIssuesByStateFromBeads", () => {
  test("state=open returns non-closed rows (mirrors --state open)", () => {
    const exec = fakeBdList([
      {
        id: "a",
        title: "open one",
        status: "open",
        external_ref: "https://github.com/o/r/issues/1",
      },
      {
        id: "b",
        title: "closed one",
        status: "closed",
        external_ref: "https://github.com/o/r/issues/2",
      },
    ]);
    const result = listIssuesByStateFromBeads("o/r", "open", 0, exec as never);
    expect(result.map((r) => r.number)).toEqual([1]);
  });

  test("state=closed returns only closed rows", () => {
    const exec = fakeBdList([
      {
        id: "a",
        title: "open one",
        status: "open",
        external_ref: "https://github.com/o/r/issues/1",
      },
      {
        id: "b",
        title: "closed one",
        status: "closed",
        external_ref: "https://github.com/o/r/issues/2",
      },
    ]);
    const result = listIssuesByStateFromBeads("o/r", "closed", 0, exec as never);
    expect(result.map((r) => r.number)).toEqual([2]);
  });

  test("state=all returns both open and closed rows", () => {
    const exec = fakeBdList([
      {
        id: "a",
        title: "open one",
        status: "open",
        external_ref: "https://github.com/o/r/issues/1",
      },
      {
        id: "b",
        title: "closed one",
        status: "closed",
        external_ref: "https://github.com/o/r/issues/2",
      },
    ]);
    const result = listIssuesByStateFromBeads("o/r", "all", 0, exec as never);
    expect(result.map((r) => r.number)).toEqual([1, 2]);
  });
});
