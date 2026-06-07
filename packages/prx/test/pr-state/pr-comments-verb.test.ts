import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../../src/cli/verbspec.ts";
import {
  prCommentsVerb,
  type PrCommentsDeps,
  type PrCommentsOutput,
} from "../../src/pr-state/pr-comments-verb.ts";

// `prx pr-comments` migrated off cli.ts to a deps-bearing VerbSpec (ADR
// docs/prx/cli-decomposition.md). These drive the CLI path — parse (so the
// `resolve` thread ids merge positionals + repeated `--thread`) → run → render →
// exitCode — with the GitHub reads/writes injected. Routing (`repo pr-comments`
// / `scout comments` + the resolve/show split) is covered by the compiled CLI.

const prFixture = (over: Record<string, unknown> = {}) => ({
  number: 334,
  title: "Signal remote CI before reviewer",
  url: "https://example.com/pr/334",
  isDraft: false,
  baseRefName: "main",
  reviewDecision: null,
  mergeStateStatus: "BLOCKED",
  mergeable: "MERGEABLE",
  autoMergeEnabled: true,
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  repoPath: ".",
  pr: prFixture(),
  reviewAdded: true,
  reviewApproved: false,
  agentReview: true,
  humanReview: false,
  unresolvedThreads: 0,
  threads: [],
  ...over,
});

function runVerb(args: string[], deps: PrCommentsDeps): { rendered: string; exit: number } {
  const input = parseArgs(prCommentsVerb as never, args) as Parameters<typeof prCommentsVerb.run>[0];
  const out = prCommentsVerb.run(input, deps) as PrCommentsOutput;
  return {
    rendered: prCommentsVerb.render!(out, input as never),
    exit: prCommentsVerb.exitCode!(out, input as never),
  };
}

describe("pr-comments verb — show", () => {
  test("plain output + default write path; exits 1 while unresolved", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-pr-comments-"));
    const { rendered, exit } = runVerb(["--repo-path", dir, "--write"], {
      fetchPrComments: () =>
        summary({
          repoPath: dir,
          unresolvedThreads: 1,
          threads: [{ id: "thread-1", isResolved: false, isOutdated: false, path: "a.ts", comments: [] }],
        }) as never,
      resolvePrReviewThreads: () => [] as never,
    });
    const outputPath = join(dir, ".pr", "local", "review-comments.json");
    expect(exit).toBe(1);
    expect(rendered).toContain("pr comments for #334");
    expect(rendered).toContain("unresolved_threads=1");
    expect(rendered).toContain(`saved=${outputPath}`);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ unresolvedThreads: 1, pr: { number: 334 } });
  });

  test("json output; exits 0 when clean", () => {
    const { rendered, exit } = runVerb(["--format", "json", "--pr", "GH-321"], {
      fetchPrComments: () => summary({ repoPath: "/repo", unresolvedThreads: 0, threads: [] }) as never,
      resolvePrReviewThreads: () => [] as never,
    });
    expect(exit).toBe(0);
    expect(JSON.parse(rendered)).toMatchObject({ repoPath: "/repo", unresolvedThreads: 0, pr: { number: 334 } });
  });
});

describe("pr-comments verb — resolve", () => {
  test("resolves specified threads (positional + --thread) and re-reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-pr-comments-resolve-"));
    let seen: string[] = [];
    let fetchCount = 0;
    const { rendered, exit } = runVerb(
      ["--action=resolve", "thread-1", "--thread", "thread-2", "--repo-path", dir, "--write"],
      {
        fetchPrComments: () => {
          fetchCount += 1;
          return (fetchCount === 1
            ? summary({
                repoPath: dir,
                unresolvedThreads: 2,
                threads: [
                  { id: "thread-1", isResolved: false, isOutdated: false, path: "a.ts", comments: [] },
                  { id: "thread-2", isResolved: false, isOutdated: true, path: "b.ts", comments: [] },
                ],
              })
            : summary({ repoPath: dir, unresolvedThreads: 0, threads: [] })) as never;
        },
        resolvePrReviewThreads: (_repoPath, ids) => {
          seen = ids;
          return ids.map((id) => ({ id, isResolved: true })) as never;
        },
      },
    );
    const outputPath = join(dir, ".pr", "local", "review-comments.json");
    expect(seen).toEqual(["thread-1", "thread-2"]);
    expect(exit).toBe(0);
    expect(rendered).toContain("resolved_threads=2");
    expect(rendered).toContain("=== POST-RESOLUTION ===");
    expect(rendered).toContain("unresolved_threads=0");
    expect(rendered).toContain(`saved=${outputPath}`);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ unresolvedThreads: 0 });
  });

  test("--all-unresolved resolves every open thread", () => {
    let seen: string[] = [];
    let fetchCount = 0;
    const { rendered, exit } = runVerb(["--action=resolve", "--all-unresolved", "--format", "json", "--pr", "GH-321"], {
      fetchPrComments: () => {
        fetchCount += 1;
        return (fetchCount === 1
          ? summary({
              unresolvedThreads: 2,
              threads: [
                { id: "thread-1", isResolved: false, isOutdated: false, path: "a.ts", comments: [] },
                { id: "thread-2", isResolved: false, isOutdated: false, path: "b.ts", comments: [] },
              ],
            })
          : summary({ unresolvedThreads: 0, threads: [] })) as never;
      },
      resolvePrReviewThreads: (_repoPath, ids) => {
        seen = ids;
        return ids.map((id) => ({ id, isResolved: true })) as never;
      },
    });
    expect(exit).toBe(0);
    expect(seen).toEqual(["thread-1", "thread-2"]);
    expect(JSON.parse(rendered)).toMatchObject({
      resolvedThreads: [{ id: "thread-1", isResolved: true }, { id: "thread-2", isResolved: true }],
      postResolution: { unresolvedThreads: 0 },
    });
  });

  test("refuses with no ids and no --all-unresolved", () => {
    expect(() =>
      runVerb(["--action=resolve"], {
        fetchPrComments: () => summary() as never,
        resolvePrReviewThreads: () => [] as never,
      }),
    ).toThrow(/at least one thread id or --all-unresolved/);
  });
});
