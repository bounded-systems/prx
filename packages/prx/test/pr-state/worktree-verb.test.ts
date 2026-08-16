import { describe, expect, test } from "bun:test";

import {
  worktreeVerb,
  worktreesVerb,
  type RenderedOutput,
  type WorktreeDeps,
  type WorktreesDeps,
} from "../../src/pr-state/worktree-verb.ts";

// `prx worktree` / `prx worktrees` migrated off cli.ts to deps-bearing
// VerbSpecs (ADR docs/prx/cli-decomposition.md). These inject the status reader
// (WorktreeDeps / WorktreesDeps) straight into `run` — the seam that replaced
// the CliDeps worktreeStatus injection. Routing is covered by the compiled CLI.

const codes = {
  " ": "unmodified",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  "?": "untracked",
  "!": "ignored",
};

const runWorktree = (
  input: { "repo-path": string; format: "plain" | "json" },
  deps: WorktreeDeps,
): string => (worktreeVerb.run(input as never, deps) as RenderedOutput).rendered;

const runWorktrees = (
  input: { "repo-path": string; format: "plain" | "json"; "include-git-details": boolean },
  deps: WorktreesDeps,
): string => (worktreesVerb.run(input as never, deps) as RenderedOutput).rendered;

describe("worktree verb", () => {
  test("plain output summarizes branch sync + dirty counts", () => {
    const out = runWorktree(
      { "repo-path": ".", format: "plain" },
      {
        worktreeStatus: () =>
          ({
            branch: {
              name: "GH-5480",
              detached: false,
              noCommits: false,
              upstream: "origin/GH-5480",
              ahead: 0,
              behind: 0,
              diverged: false,
              sync: "up_to_date",
            },
            files: {
              staged: [],
              unstaged: ["db/schema.rb"],
              untracked: [],
              ignored: [],
              conflicts: [],
            },
            counts: { staged: 0, unstaged: 1, untracked: 0, ignored: 0, conflicts: 0 },
            clean: false,
            codes,
          }) as never,
      },
    );
    expect(out).toContain("branch=GH-5480 sync=up_to_date");
    expect(out).toContain("worktree=dirty staged=0 unstaged=1 untracked=0 conflicts=0");
  });

  test("json output emits the status object", () => {
    const out = runWorktree(
      { "repo-path": ".", format: "json" },
      {
        worktreeStatus: () =>
          ({
            branch: {
              name: "main",
              detached: false,
              noCommits: false,
              upstream: "origin/main",
              ahead: 1,
              behind: 0,
              diverged: false,
              sync: "ahead",
            },
            files: {
              staged: ["lib/a.rb"],
              unstaged: [],
              untracked: [],
              ignored: [],
              conflicts: [],
            },
            counts: { staged: 1, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            clean: false,
            codes,
          }) as never,
      },
    );
    expect(JSON.parse(out)).toMatchObject({
      branch: { name: "main", sync: "ahead" },
      counts: { staged: 1 },
      clean: false,
    });
  });

  test("passes the repo path through to the status reader", () => {
    let seen = "";
    runWorktree(
      { "repo-path": "/some/repo", format: "json" },
      {
        worktreeStatus: (repoPath) => {
          seen = repoPath;
          return {
            branch: {
              name: "x",
              detached: false,
              noCommits: false,
              upstream: null,
              ahead: 0,
              behind: 0,
              diverged: false,
              sync: "up_to_date",
            },
            files: { staged: [], unstaged: [], untracked: [], ignored: [], conflicts: [] },
            counts: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            clean: true,
            codes,
          } as never;
        },
      },
    );
    expect(seen).toBe("/some/repo");
  });
});

const wtSymbols = {
  "!": "modified",
  "?": "untracked",
  "↑": "ahead",
  "↓": "behind",
  "↕": "diverged",
  "✗": "would_conflict",
  "⊂": "integrated",
  "⚑": "branch_worktree_mismatch",
  "–": "same_commit",
  "|": "has_upstream",
};

describe("worktrees verb", () => {
  test("plain output renders the worktrunk status with symbols", () => {
    const out = runWorktrees(
      { "repo-path": ".", format: "plain", "include-git-details": true },
      {
        wtStatus: () =>
          ({
            source: "wt+git",
            wt_available: true,
            symbols: wtSymbols,
            worktrees: [
              {
                branch: "GH-5480",
                path: "/repo/wt",
                integration: "ahead",
                clean: false,
                dirty_flags: ["modified"],
                sync: { ahead: 1, behind: 0, state: "ahead" },
                structural: {
                  detached: false,
                  mismatch: true,
                  states: ["branch_worktree_mismatch"],
                },
                symbols: ["!", "↑", "⚑"],
                symbol_meanings: ["modified", "ahead", "branch_worktree_mismatch"],
                git: {
                  branch: {
                    name: "GH-5480",
                    detached: false,
                    noCommits: false,
                    upstream: "origin/GH-5480",
                    ahead: 1,
                    behind: 0,
                    diverged: false,
                    sync: "ahead",
                  },
                  files: {
                    staged: [],
                    unstaged: ["x.rb"],
                    untracked: [],
                    ignored: [],
                    conflicts: [],
                  },
                  counts: { staged: 0, unstaged: 1, untracked: 0, ignored: 0, conflicts: 0 },
                  clean: false,
                  codes,
                },
                commit: { sha: "abc", message: "msg" },
              },
            ],
          }) as never,
      },
    );
    expect(out).toContain("Worktrunk status");
    expect(out).toContain("GH-5480 (ahead)");
    expect(out).toContain("symbols: ! ↑ ⚑ (modified, ahead, branch_worktree_mismatch)");
  });

  test("json output emits the status object and honors include-git-details", () => {
    let seenDetails: boolean | undefined;
    const out = runWorktrees(
      { "repo-path": ".", format: "json", "include-git-details": true },
      {
        wtStatus: (_repoPath, includeGitDetails) => {
          seenDetails = includeGitDetails;
          return {
            source: "wt+git",
            wt_available: true,
            symbols: wtSymbols,
            worktrees: [],
          } as never;
        },
      },
    );
    expect(seenDetails).toBe(true);
    expect(JSON.parse(out)).toMatchObject({ source: "wt+git", wt_available: true, worktrees: [] });
  });

  test("render returns the raw rendered text", () => {
    const out: RenderedOutput = { rendered: "y" };
    expect(
      worktreesVerb.render!(out, {
        "repo-path": ".",
        format: "plain",
        "include-git-details": true,
      } as never),
    ).toBe("y");
  });
});
