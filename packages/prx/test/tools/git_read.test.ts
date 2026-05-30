import { describe, expect, test } from "bun:test";

import {
  isReadOnlyGitSubcommand,
  runGitRead,
  type GitReadRunner,
} from "../../src/tools/git_read.ts";

// ai-home-mqlno — envelope-first tests for the read-only git capability. Mock
// the runner port; the real execGit conforms later when wired as a dispatch
// target. The contract under test: read-only subcommands run, mutations never do.

function recordingRunner(): { runner: GitReadRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: GitReadRunner = ({ subcommand }) => {
    calls.push(subcommand);
    return { status: 0, stdout: `out:${subcommand}`, stderr: "" };
  };
  return { runner, calls };
}

describe("read-only git allowlist (ai-home-mqlno)", () => {
  test("admits purely-read subcommands", () => {
    for (const s of ["log", "diff", "show", "status", "blame", "rev-parse"]) {
      expect(isReadOnlyGitSubcommand(s)).toBe(true);
    }
  });

  test("rejects mutating / flag-dependent subcommands (deny-by-default)", () => {
    for (const s of [
      "commit", "push", "checkout", "switch", "reset", "merge", "rebase",
      "add", "rm", "clean", "stash", "fetch", "pull", "branch", "tag",
      "remote", "config", "worktree", "restore", "apply",
    ]) {
      expect(isReadOnlyGitSubcommand(s)).toBe(false);
    }
  });
});

describe("runGitRead (ai-home-mqlno)", () => {
  test("runs a read-only subcommand via the port and returns stdout", () => {
    const { runner, calls } = recordingRunner();
    const r = runGitRead({ subcommand: "log", args: ["--oneline", "-5"], cwd: "/repo", runner });
    expect(r).toEqual({ ok: true, stdout: "out:log" });
    expect(calls).toEqual(["log"]);
  });

  test("rejects a mutation WITHOUT invoking the runner", () => {
    const { runner, calls } = recordingRunner();
    const r = runGitRead({ subcommand: "commit", args: ["-m", "x"], cwd: "/repo", runner });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_read_only");
    expect(calls).toEqual([]); // the runner is never reached for a mutation
  });

  test("surfaces a nonzero git exit as exec_failed", () => {
    const failing: GitReadRunner = () => ({ status: 128, stdout: "", stderr: "bad revision" });
    const r = runGitRead({ subcommand: "show", args: ["deadbeef"], cwd: "/repo", runner: failing });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("exec_failed");
      expect(r.detail).toContain("bad revision");
    }
  });
});
