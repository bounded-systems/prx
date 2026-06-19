import { describe, expect, test } from "bun:test";
import {
  buildGhIssueCreateArgs,
  execGhIssueCreate,
  extractIssueUrl,
  formatGhIssueCreateResult,
  type GhIssueCreateSpawn,
} from "../../src/tools/gh_issue_create.ts";

describe("buildGhIssueCreateArgs", () => {
  test("emits required title + body and skips optional flags when absent", () => {
    expect(buildGhIssueCreateArgs({ title: "spike: x", body: "body" })).toEqual([
      "issue",
      "create",
      "--title",
      "spike: x",
      "--body",
      "body",
    ]);
  });

  test("forwards repo, labels, and assignees", () => {
    expect(
      buildGhIssueCreateArgs({
        title: "t",
        body: "b",
        repo: "owner/repo",
        labels: ["a", "b"],
        assignees: ["u1"],
      }),
    ).toEqual([
      "issue",
      "create",
      "--title",
      "t",
      "--body",
      "b",
      "--repo",
      "owner/repo",
      "--label",
      "a",
      "--label",
      "b",
      "--assignee",
      "u1",
    ]);
  });
});

describe("extractIssueUrl", () => {
  test("returns the URL on the last stdout line", () => {
    expect(
      extractIssueUrl("Creating issue in owner/repo\nhttps://github.com/owner/repo/issues/42"),
    ).toBe("https://github.com/owner/repo/issues/42");
  });

  test("falls back to scanning the full output", () => {
    expect(extractIssueUrl("https://github.com/o/r/issues/7\ntrailing notice line")).toBe(
      "https://github.com/o/r/issues/7",
    );
  });

  test("returns null on empty or non-URL output", () => {
    expect(extractIssueUrl("")).toBeNull();
    expect(extractIssueUrl("creating issue...\ndone")).toBeNull();
  });
});

describe("execGhIssueCreate", () => {
  test("captures stdout, stderr, and parses URL on success", () => {
    const spawn: GhIssueCreateSpawn = (file, args) => {
      expect(file).toBe("gh");
      expect(args[0]).toBe("issue");
      expect(args[1]).toBe("create");
      return {
        status: 0,
        stdout: "Creating issue in owner/repo\nhttps://github.com/owner/repo/issues/100\n",
        stderr: "",
      };
    };
    const result = execGhIssueCreate({ title: "t", body: "b" }, { HOME: "/tmp" }, spawn);
    expect(result.exitCode).toBe(0);
    expect(result.issueUrl).toBe("https://github.com/owner/repo/issues/100");
    expect(result.stderr).toBe("");
  });

  test("returns null URL on non-zero exit", () => {
    const spawn: GhIssueCreateSpawn = () => ({
      status: 1,
      stdout: "",
      stderr: "gh: must specify --repo",
    });
    const result = execGhIssueCreate({ title: "t", body: "b" }, { HOME: "/tmp" }, spawn);
    expect(result.exitCode).toBe(1);
    expect(result.issueUrl).toBeNull();
    expect(result.stderr).toBe("gh: must specify --repo");
  });
});

describe("formatGhIssueCreateResult", () => {
  test("plain success returns the URL", () => {
    expect(
      formatGhIssueCreateResult(
        {
          exitCode: 0,
          stdout: "https://github.com/o/r/issues/1",
          stderr: "",
          issueUrl: "https://github.com/o/r/issues/1",
        },
        "plain",
      ),
    ).toBe("https://github.com/o/r/issues/1");
  });

  test("plain failure returns stderr", () => {
    expect(
      formatGhIssueCreateResult(
        { exitCode: 1, stdout: "", stderr: "boom\n", issueUrl: null },
        "plain",
      ),
    ).toBe("boom");
  });

  test("json format is valid JSON", () => {
    const json = JSON.parse(
      formatGhIssueCreateResult({ exitCode: 0, stdout: "x", stderr: "", issueUrl: "u" }, "json"),
    );
    expect(json.exitCode).toBe(0);
    expect(json.issueUrl).toBe("u");
  });
});
