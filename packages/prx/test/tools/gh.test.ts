import { describe, expect, test } from "bun:test";
import { execGh, fetchIssueLabels, formatGhExecResult } from "@bounded-systems/gh";

describe("execGh", () => {
  test("blocks groups outside the allowed set", () => {
    const result = execGh(
      { group: "release", subcommand: "list", args: [] },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only pr/issue groups are allowed");
  });

  test("issue group accepts list/view/edit", () => {
    // Policy still applies; but allowlist should accept the group+subcommand
    // pair before policy enforcement. Reject path here is policy, not group.
    const result = execGh(
      { group: "issue", subcommand: "edit", args: ["1"], state: "planning", role: "planner" },
      { HOME: "/tmp" },
    );
    // planner cannot edit, but the rejection is policy-level, not group-level.
    expect(result.stderr).not.toContain("disallowed issue subcommand");
  });

  test("issue group rejects unknown subcommands", () => {
    const result = execGh(
      { group: "issue", subcommand: "delete", args: ["1"] },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown or disallowed issue subcommand");
  });

  test("issue group passes policy for executor in planning", () => {
    const result = execGh(
      { group: "issue", subcommand: "edit", args: ["1"], state: "planning", role: "executor" },
      { HOME: "/tmp" },
    );
    expect(result.policy?.allowed).toBe(true);
  });

  test("blocks hard-blocked subcommands", () => {
    const result = execGh(
      { group: "pr", subcommand: "close", args: [] },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked pr subcommand 'close'");
  });

  test("blocks unknown subcommands", () => {
    const result = execGh(
      { group: "pr", subcommand: "unknown", args: [] },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown or disallowed");
  });

  test("enforces policy for state/role", () => {
    const result = execGh(
      { group: "pr", subcommand: "create", args: [], state: "planning", role: "planner" },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked");
    expect(result.policy?.allowed).toBe(false);
  });

  test("allows pr status for any state/role", () => {
    // This actually calls gh — policy should allow it regardless of execution result
    const result = execGh(
      { group: "pr", subcommand: "status", args: [], state: "planning", role: "planner" },
    );
    expect(result.policy?.allowed).toBe(true);
  });

  test("respects env vars for state and role", () => {
    const result = execGh(
      { group: "pr", subcommand: "create", args: [] },
      { PRX_CAPABILITY_STATE: "planning", PRX_AGENT_ROLE: "planner", HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.policy?.state).toBe("planning");
    expect(result.policy?.role).toBe("planner");
  });
});

describe("formatGhExecResult", () => {
  test("json format is valid JSON", () => {
    const result = execGh(
      { group: "pr", subcommand: "close", args: [] },
      { HOME: "/tmp" },
    );
    const json = JSON.parse(formatGhExecResult(result, "json"));
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toContain("blocked");
  });
});

describe("fetchIssueLabels — GH-1866", () => {
  test("returns aliased map keyed by issue number", () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          i100: {
            labels: {
              nodes: [{ name: "type::bug" }, { name: "priority::high" }],
              pageInfo: { hasNextPage: false },
            },
          },
          i200: {
            labels: {
              nodes: [{ name: "area::prx" }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });
    const result = fetchIssueLabels("owner/repo", [100, 200], {
      rawRunner: () => ({ stdout, stderr: "", status: 0 }),
    });
    expect(result.get(100)).toEqual(["type::bug", "priority::high"]);
    expect(result.get(200)).toEqual(["area::prx"]);
  });

  test("issues exactly one gh api graphql call regardless of issue count", () => {
    let calls = 0;
    let argv: string[] | null = null;
    fetchIssueLabels("owner/repo", [1, 2, 3], {
      rawRunner: (cmd) => {
        calls += 1;
        argv = cmd;
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                i1: { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
                i2: { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
                i3: { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      },
    });
    expect(calls).toBe(1);
    expect(argv).not.toBeNull();
    expect(argv![0]).toBe("gh");
    expect(argv![1]).toBe("api");
    expect(argv![2]).toBe("graphql");
  });

  test("throws on non-zero gh exit", () => {
    expect(() =>
      fetchIssueLabels("owner/repo", [1], {
        rawRunner: () => ({ stdout: "", stderr: "rate limit", status: 1 }),
      }),
    ).toThrow(/exit 1.*rate limit/);
  });

  test("throws on GraphQL errors array", () => {
    expect(() =>
      fetchIssueLabels("owner/repo", [1], {
        rawRunner: () => ({
          stdout: JSON.stringify({ errors: [{ message: "FORBIDDEN" }] }),
          stderr: "",
          status: 0,
        }),
      }),
    ).toThrow(/GraphQL errors/);
  });

  test("throws on unparseable JSON", () => {
    expect(() =>
      fetchIssueLabels("owner/repo", [1], {
        rawRunner: () => ({ stdout: "not json", stderr: "", status: 0 }),
      }),
    ).toThrow(/non-JSON/);
  });

  test("throws when an alias is missing from the response", () => {
    expect(() =>
      fetchIssueLabels("owner/repo", [1, 2], {
        rawRunner: () => ({
          stdout: JSON.stringify({
            data: {
              repository: {
                i1: { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
              },
            },
          }),
          stderr: "",
          status: 0,
        }),
      }),
    ).toThrow(/missing alias i2/);
  });

  test("rejects malformed repo string", () => {
    expect(() => fetchIssueLabels("not-a-repo", [1])).toThrow(/invalid repo/);
  });

  test("empty issue list short-circuits without a runner call", () => {
    let calls = 0;
    const result = fetchIssueLabels("owner/repo", [], {
      rawRunner: () => {
        calls += 1;
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    expect(calls).toBe(0);
    expect(result.size).toBe(0);
  });
});
