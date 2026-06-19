import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { RepositoryStore, openRegistry } from "../../src/pr-state/registry_store.ts";
import { adoptRepo, inferRepoFromWorktree } from "../../src/pr-state/repo_adopt.ts";
import { CliError } from "../../src/pr-state/cli-error.ts";
import type { RepoRunner } from "../../src/pr-state/repos.ts";

type RunnerResponse = { stdout: string; stderr: string; status: number };

function makeRunner(map: Map<string, RunnerResponse>): RepoRunner {
  return (cmd, options = {}) => {
    const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
    const r = map.get(key);
    if (!r) {
      return { stdout: "", stderr: `unmocked: ${key}`, status: 1 };
    }
    return r;
  };
}

const WORKTREE = "/wt/main";
const BARE = "/var/git/bare/io.github/bdelanghe/ai-home.git";
const ORIGIN = "https://github.com/bdelanghe/ai-home.git";

function happyPathResponses(): Map<string, RunnerResponse> {
  return new Map([
    [`git rev-parse --git-common-dir|${WORKTREE}`, { stdout: `${BARE}\n`, stderr: "", status: 0 }],
    [`git remote get-url origin|${WORKTREE}`, { stdout: `${ORIGIN}\n`, stderr: "", status: 0 }],
    [
      `git symbolic-ref --short refs/remotes/origin/HEAD|${WORKTREE}`,
      { stdout: "origin/main\n", stderr: "", status: 0 },
    ],
  ]);
}

describe("inferRepoFromWorktree", () => {
  test("returns the canonical repo_id from origin + bare_path + default branch", () => {
    const runner = makeRunner(happyPathResponses());
    const result = inferRepoFromWorktree(WORKTREE, runner);
    expect(result.repo_id).toBe("github.com/bdelanghe/ai-home");
    expect(result.bare_path).toBe(BARE);
    expect(result.remote_url).toBe(ORIGIN);
    expect(result.default_branch).toBe("main");
    expect(result.parsed).toEqual({
      host: "github.com",
      owner: "bdelanghe",
      name: "ai-home",
      fetchUrl: ORIGIN,
    });
  });

  test("falls back to ls-remote when symbolic-ref refs/remotes/origin/HEAD is unset", () => {
    const responses = happyPathResponses();
    responses.set(`git symbolic-ref --short refs/remotes/origin/HEAD|${WORKTREE}`, {
      stdout: "",
      stderr: "fatal: ref ...",
      status: 1,
    });
    responses.set(`git ls-remote --symref origin HEAD|${WORKTREE}`, {
      stdout: "ref: refs/heads/develop\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
      stderr: "",
      status: 0,
    });
    const runner = makeRunner(responses);
    const result = inferRepoFromWorktree(WORKTREE, runner);
    expect(result.default_branch).toBe("develop");
  });

  test("refuses when origin remote is missing", () => {
    const responses = happyPathResponses();
    responses.set(`git remote get-url origin|${WORKTREE}`, {
      stdout: "",
      stderr: "fatal: No such remote: origin",
      status: 2,
    });
    const runner = makeRunner(responses);
    expect(() => inferRepoFromWorktree(WORKTREE, runner)).toThrow(/No `origin` remote/);
  });

  test("refuses when origin URL cannot be parsed", () => {
    const responses = happyPathResponses();
    responses.set(`git remote get-url origin|${WORKTREE}`, {
      stdout: "ftp://nope.example.com/x/y\n",
      stderr: "",
      status: 0,
    });
    const runner = makeRunner(responses);
    expect(() => inferRepoFromWorktree(WORKTREE, runner)).toThrow(/Could not parse origin URL/);
  });

  test("refuses when origin/HEAD is unresolvable via both symref and ls-remote", () => {
    const responses = happyPathResponses();
    responses.set(`git symbolic-ref --short refs/remotes/origin/HEAD|${WORKTREE}`, {
      stdout: "",
      stderr: "fatal: ref ...",
      status: 1,
    });
    responses.set(`git ls-remote --symref origin HEAD|${WORKTREE}`, {
      stdout: "0123456789abcdef0123456789abcdef01234567\tHEAD\n",
      stderr: "",
      status: 0,
    });
    const runner = makeRunner(responses);
    expect(() => inferRepoFromWorktree(WORKTREE, runner)).toThrow(/origin\/HEAD/);
  });
});

describe("adoptRepo", () => {
  test("fresh adopt writes the row, re-run reports already-adopted with the same row", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-adopt-"));
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const store = new RepositoryStore(db);
        const runner = makeRunner(happyPathResponses());

        const first = adoptRepo({
          worktreePath: WORKTREE,
          store,
          runner,
          now: () => new Date("2026-05-15T12:00:00.000Z"),
        });
        expect(first.kind).toBe("adopted");
        expect(first.row.repo_id).toBe("github.com/bdelanghe/ai-home");
        expect(first.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");

        const second = adoptRepo({
          worktreePath: WORKTREE,
          store,
          runner,
          // Different clock — adopted_at must NOT advance.
          now: () => new Date("2027-01-01T00:00:00.000Z"),
        });
        expect(second.kind).toBe("already-adopted");
        expect(second.row.adopted_at).toBe("2026-05-15T12:00:00.000Z");
        expect(store.count()).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("URL mismatch on the same repo_id refuses with a curated error", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-adopt-"));
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const store = new RepositoryStore(db);
        store.upsertRepo({
          repo_id: "github.com/bdelanghe/ai-home",
          bare_path: "/different/bare/path.git",
          remote_url: "https://github.com/bdelanghe/ai-home.git",
          default_branch: "main",
          managed_by: "prx",
          adopted_at: "2025-01-01T00:00:00.000Z",
        });

        const runner = makeRunner(happyPathResponses());
        expect(() =>
          adoptRepo({ worktreePath: WORKTREE, store, runner, now: () => new Date() }),
        ).toThrow(CliError);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
