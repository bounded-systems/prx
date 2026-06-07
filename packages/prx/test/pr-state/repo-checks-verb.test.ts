import { describe, expect, test } from "bun:test";

import {
  repoChecksVerb,
  type RepoChecksDeps,
  type RepoChecksOutput,
} from "../../src/pr-state/repo-checks-verb.ts";

// `prx repo-checks` (a.k.a. `repo checks` / `scout checks`) migrated off cli.ts
// to a deps-bearing VerbSpec (ADR docs/prx/cli-decomposition.md) using the
// `exitCode` projection (no checks ⇒ exit 1). These cover run + render +
// exitCode through the deps seam; routing is covered by the compiled CLI +
// help-all parity.

const run = (
  input: { "repo-path": string; repo?: string; branch: string; format: "plain" | "json" },
  deps: RepoChecksDeps,
): { rendered: string; exit: number } => {
  const out = repoChecksVerb.run(input as never, deps) as RepoChecksOutput;
  return {
    rendered: repoChecksVerb.render!(out, input as never),
    exit: repoChecksVerb.exitCode!(out, input as never),
  };
};

const fixture = (checks: string[]) =>
  ({ repo: "bdelanghe/ai-home", branch: "main", sha: "abc123", checks }) as never;

describe("repo-checks verb", () => {
  test("plain output lists the check names and exits 0", () => {
    const { rendered, exit } = run(
      { "repo-path": ".", branch: "main", format: "plain" },
      { repoCheckNames: () => fixture(["ci / test", "lint"]) },
    );
    expect(exit).toBe(0);
    expect(rendered).toContain("check names for bdelanghe/ai-home @ main");
    expect(rendered).toContain("sha=abc123");
    expect(rendered).toContain("- ci / test");
  });

  test("json output emits the full result", () => {
    const { rendered, exit } = run(
      { "repo-path": ".", branch: "main", format: "json" },
      { repoCheckNames: () => fixture(["ci / test", "lint"]) },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(rendered)).toEqual({
      repo: "bdelanghe/ai-home",
      branch: "main",
      sha: "abc123",
      checks: ["ci / test", "lint"],
    });
  });

  test("no checks resolved exits 1", () => {
    const { exit } = run(
      { "repo-path": ".", branch: "main", format: "plain" },
      { repoCheckNames: () => fixture([]) },
    );
    expect(exit).toBe(1);
  });

  test("passes repo-path/repo/branch through to the reader", () => {
    let seen: { repoPath: string; opts: unknown } | undefined;
    run(
      { "repo-path": "/some/repo", repo: "owner/name", branch: "release", format: "json" },
      {
        repoCheckNames: (repoPath, opts) => {
          seen = { repoPath, opts };
          return fixture(["x"]);
        },
      },
    );
    expect(seen).toEqual({ repoPath: "/some/repo", opts: { repo: "owner/name", branch: "release" } });
  });
});
