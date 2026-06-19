// fetchIssueLabels — GraphQL label fetch with an injected raw `gh` runner, plus
// the pure formatGhExecResult renderer. The runner seam lets us drive the
// response-shape failure branches (missing repository / missing labels.nodes /
// >50-label truncation) with no real gh spawn.

import { describe, expect, test } from "bun:test";

import { fetchIssueLabels, formatGhExecResult, type GhExecResult } from "@bounded-systems/gh";
import type { CommandResult } from "@bounded-systems/proc";

const ok = (body: unknown): CommandResult => ({
  stdout: JSON.stringify(body),
  stderr: "",
  status: 0,
});

describe("fetchIssueLabels", () => {
  test("short-circuits to an empty map for no issue numbers", () => {
    let called = false;
    const out = fetchIssueLabels("o/n", [], {
      rawRunner: () => {
        called = true;
        return ok({});
      },
    });
    expect(out.size).toBe(0);
    expect(called).toBe(false);
  });

  test("collects label names per issue on a well-formed response", () => {
    const out = fetchIssueLabels("bounded-systems/prx", [1, 2], {
      rawRunner: () =>
        ok({
          data: {
            repository: {
              i1: {
                labels: {
                  nodes: [{ name: "bug" }, { name: "p2" }],
                  pageInfo: { hasNextPage: false },
                },
              },
              i2: { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
            },
          },
        }),
    });
    expect(out.get(1)).toEqual(["bug", "p2"]);
    expect(out.get(2)).toEqual([]);
  });

  test("warns and truncates when an issue reports >50 labels", () => {
    const out = fetchIssueLabels("o/n", [7], {
      rawRunner: () =>
        ok({
          data: {
            repository: {
              i7: { labels: { nodes: [{ name: "x" }], pageInfo: { hasNextPage: true } } },
            },
          },
        }),
    });
    // The hasNextPage warning path still returns the first-page names.
    expect(out.get(7)).toEqual(["x"]);
  });

  test("throws when data.repository is absent", () => {
    expect(() => fetchIssueLabels("o/n", [1], { rawRunner: () => ok({ data: {} }) })).toThrow(
      /missing data\.repository/,
    );
  });

  test("throws when an alias is missing labels.nodes", () => {
    expect(() =>
      fetchIssueLabels("o/n", [1], {
        rawRunner: () => ok({ data: { repository: { i1: { labels: {} } } } }),
      }),
    ).toThrow(/missing labels\.nodes/);
  });

  test("rejects a malformed repo slug", () => {
    expect(() => fetchIssueLabels("noslash", [1], { rawRunner: () => ok({}) })).toThrow(
      /invalid repo/,
    );
  });
});

describe("formatGhExecResult", () => {
  const failed: GhExecResult = {
    exitCode: 1,
    stdout: "",
    stderr: "gh-safe: blocked",
    policy: null,
  };

  test("json renders the whole result", () => {
    const out = formatGhExecResult(failed, "json");
    expect(JSON.parse(out)).toEqual(failed);
  });

  test("plain surfaces stderr on a failed call", () => {
    expect(formatGhExecResult(failed, "plain")).toBe("gh-safe: blocked");
  });

  test("plain returns stdout on success", () => {
    const okResult: GhExecResult = { exitCode: 0, stdout: "#123\n", stderr: "", policy: null };
    expect(formatGhExecResult(okResult, "plain")).toBe("#123");
  });
});
