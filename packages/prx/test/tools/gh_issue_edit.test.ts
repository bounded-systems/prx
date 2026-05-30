// GH-2382 — `execGhIssueEdit` is the single allowed `gh issue edit` surface
// (the bd→GH issue-mutation chokepoint). Mirrors gh_issue_close.test.ts.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildGhIssueEditArgs,
  execGhIssueEdit,
  formatGhIssueEditResult,
  hasGhIssueEdit,
  type GhIssueEditSpawn,
} from "../../src/tools/gh_issue_edit.ts";
import {
  __resetRateLimitCacheForTesting,
  configureRateLimit,
} from "@bounded-systems/github-budget";

beforeEach(() => {
  __resetRateLimitCacheForTesting();
  configureRateLimit({});
});

describe("buildGhIssueEditArgs", () => {
  test("emits issue/edit/N with no flags when nothing to change", () => {
    expect(buildGhIssueEditArgs({ number: 42 })).toEqual(["issue", "edit", "42"]);
  });

  test("comma-joins labels, repeats assignees, appends --repo last", () => {
    expect(
      buildGhIssueEditArgs({
        number: 7,
        title: "T",
        body: "B",
        addLabels: ["priority::medium", "type::task"],
        removeLabels: ["priority::low"],
        addAssignees: ["alice", "bob"],
        removeAssignees: ["carol"],
        repo: "o/r",
      }),
    ).toEqual([
      "issue",
      "edit",
      "7",
      "--title",
      "T",
      "--body",
      "B",
      "--add-label",
      "priority::medium,type::task",
      "--remove-label",
      "priority::low",
      "--add-assignee",
      "alice",
      "--add-assignee",
      "bob",
      "--remove-assignee",
      "carol",
      "--repo",
      "o/r",
    ]);
  });

  test("drops empty label entries", () => {
    expect(buildGhIssueEditArgs({ number: 1, addLabels: ["", ""] as string[] })).toEqual([
      "issue",
      "edit",
      "1",
    ]);
  });
});

describe("hasGhIssueEdit", () => {
  test("false for a bare edit, true once any mutating flag is present", () => {
    expect(hasGhIssueEdit({ number: 1 })).toBe(false);
    expect(hasGhIssueEdit({ number: 1, addLabels: [""] })).toBe(false);
    expect(hasGhIssueEdit({ number: 1, title: "x" })).toBe(true);
    expect(hasGhIssueEdit({ number: 1, removeLabels: ["priority::low"] })).toBe(true);
    expect(hasGhIssueEdit({ number: 1, addAssignees: ["a"] })).toBe(true);
  });
});

describe("execGhIssueEdit", () => {
  test("spawns gh with the built argv and returns captured output", () => {
    let seen: string[] | undefined;
    const spawn: GhIssueEditSpawn = (_file, args) => {
      seen = args;
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const result = execGhIssueEdit(
      { number: 5, title: "Renamed", repo: "o/r" },
      { HOME: "/tmp" },
      spawn,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(seen).toEqual(["issue", "edit", "5", "--title", "Renamed", "--repo", "o/r"]);
  });

  test("non-zero exit surfaces stderr", () => {
    const spawn: GhIssueEditSpawn = () => ({ status: 1, stdout: "", stderr: "boom" });
    const result = execGhIssueEdit({ number: 1, title: "x" }, { HOME: "/tmp" }, spawn);
    expect(result.exitCode).toBe(1);
    expect(formatGhIssueEditResult(result, "plain")).toBe("boom");
  });
});
