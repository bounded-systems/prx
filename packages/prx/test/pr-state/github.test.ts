import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deleteEnv, getEnv, setEnv } from "@bounded-systems/env";
import { registerBdDoorDialer } from "@bounded-systems/bd";

import type {
  BoardStatusResult,
  CommandRunner,
  ProtectMainBranchResult,
} from "../../src/pr-state/github.ts";
import {
  buildParityChain,
  buildSurfaceSyncFromBoard,
  commandForSurfaceSyncAction,
  boardStatus,
  branchProtectionPayloadJsonSchema,
  branchProtectionPayloadSchema,
  checkMainBranchProtection,
  commandEnv,
  effectiveCanonicalIdPattern,
  findFirstSourceOfKind,
  hydrateBeads,
  hydrateIssue,
  loadGithubProjectConfig,
  loadIdentityConfig,
  loadSurfaceSyncConfig,
  loadPrefixRoutingConfig,
  maybeViewBeadsIssue,
  maybeViewIssue,
  parseActionsRunIdFromLink,
  parseCodeBuildIdFromLink,
  parseWorktreeStatus,
  overviewStatus,
  canonicalDoltDatabase,
  parseGithubRepo,
  protectMainBranch,
  repoCheckNames,
  repoNameWithOwner,
  repoStatus,
  remoteCiCheck,
  convertPrToDraft,
  enableAutoMerge,
  fetchPrComments,
  fetchPrSignalInfo,
  markPrReadyForReview,
  mergePullRequest,
  resolvePrNodeId,
  resolvePrReviewThreads,
  resolveFeatureForPrefix,
  syncGitHubIssuesToBeads,
  syncStatus,
  updatePrFromContract,
  withTrace,
  worktreeStatus,
  wtStatus,
} from "../../src/pr-state/github.ts";
import { createTaskContract, writeTaskContract } from "../../src/pr-state/task.ts";
import { ProjectionMiss } from "../../src/pr-state/projection.ts";
import { RepoSlug } from "../../src/dolt/schema.ts";

// GH-2011: stub for `runBeadsSync` (the canonical reconcile that replaced
// the retired `bd github sync --pull-only --prefer-github` shell-out). Mirror
// the real result shape so `syncGitHubIssuesToBeads` reads back ok.
function makeBeadsSyncStub(
  options: {
    exitCode?: number;
    stdoutLine?: string;
    stderrLine?: string;
  } = {},
) {
  let calls = 0;
  const stub = async (
    _opts: unknown,
    output: { log: (line: string) => void; error: (line: string) => void },
  ) => {
    calls += 1;
    if (options.stdoutLine) output.log(options.stdoutLine);
    if (options.stderrLine) output.error(options.stderrLine);
    return {
      exitCode: options.exitCode ?? 0,
      summary: {
        repo: "",
        domain: "gh",
        scanned: 0,
        pinned: 0,
        skipped: 0,
        pulled: 0,
        pushed: 0,
        closedByPull: 0,
        failed: 0,
        pullFailed: 0,
        pullDeferred: 0,
        pushDeferred: 0,
        deferred: 0,
        budgetPaused: false,
        dryRun: false,
        durationMs: 0,
      },
      pairs: [],
    };
  };
  return Object.assign(stub, { calls: () => calls });
}

function makeRepoRoot(): { root: string; worktreePath: string; contractPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pr-state-sync-"));
  const worktreePath = join(root, "branch-worktree");
  const contractDir = join(worktreePath, ".pr", "local");
  mkdirSync(contractDir, { recursive: true });
  const contractPath = join(contractDir, "pr.json");
  return { root, worktreePath, contractPath };
}

function contractJson(state: string, ready = false) {
  return JSON.stringify(
    {
      pr: {
        title: "Sync example",
        ready: {
          value: ready,
          reason: null,
          checked_by: null,
          notes: [],
        },
        lifecycle: {
          state,
          updated_by: null,
          reason: null,
          notes: [],
        },
      },
    },
    null,
    2,
  );
}

type BranchProtectionPayload = ProtectMainBranchResult["payload"];
type RulesetPayload = Record<string, unknown>;

describe("sync-status", () => {
  test("reports when no open PRs exist", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(syncStatus(".", false, runner)).toEqual({
      exitCode: 0,
      lines: ["No open PRs found for @me."],
    });
  });

  test("skips PRs without local worktrees", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return {
          stdout: JSON.stringify([
            { number: 12, headRefName: "feature-branch", title: "Test", isDraft: false, url: "https://example.com" },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return { stdout: "worktree /repo\nbranch refs/heads/other-branch\n\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(syncStatus(".", false, runner)).toEqual({
      exitCode: 0,
      lines: ["SKIP #12 feature-branch: no local worktree for branch"],
    });
  });

  test("skips PRs when the contract is missing", () => {
    const { root, worktreePath } = makeRepoRoot();
    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "git" && cmd.includes("rev-parse")) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return {
          stdout: JSON.stringify([
            { number: 14, headRefName: "feature-branch", title: "Test", isDraft: false, url: "https://example.com" },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return {
          stdout: `worktree ${worktreePath}\nbranch refs/heads/feature-branch\n\n`,
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd.includes("status") && cmd.includes("--porcelain=v1")) {
        return {
          stdout: "## feature-branch...origin/feature-branch\n",
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(syncStatus(root, false, runner)).toEqual({
      exitCode: 0,
      lines: [
        `SKIP #14 feature-branch: missing contract at ${join(worktreePath, ".pr", "local", "pr.json")}`,
      ],
    });
  });

  test("reports dry-run updates when contract wants draft", () => {
    const { root, worktreePath, contractPath } = makeRepoRoot();
    writeFileSync(contractPath, contractJson("drafting", false));

    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "git" && cmd.includes("rev-parse")) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return {
          stdout: JSON.stringify([
            { number: 18, headRefName: "feature-branch", title: "Test", isDraft: false, url: "https://example.com" },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return {
          stdout: `worktree ${worktreePath}\nbranch refs/heads/feature-branch\n\n`,
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(syncStatus(root, false, runner)).toEqual({
      exitCode: 0,
      lines: ["WOULD UPDATE #18 feature-branch: ready -> draft"],
    });
  });

  test("applies draft reversion through gh", () => {
    const { root, worktreePath, contractPath } = makeRepoRoot();
    writeFileSync(contractPath, contractJson("drafting", false));
    const commands: string[] = [];

    const runner: CommandRunner = (cmd) => {
      commands.push(cmd.join(" "));

      if (cmd[0] === "git" && cmd.includes("rev-parse")) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return {
          stdout: JSON.stringify([
            { number: 22, headRefName: "feature-branch", title: "Test", isDraft: false, url: "https://example.com" },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return {
          stdout: `worktree ${worktreePath}\nbranch refs/heads/feature-branch\n\n`,
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "ready") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(syncStatus(root, true, runner)).toEqual({
      exitCode: 0,
      lines: ["UPDATED #22 feature-branch: ready -> draft"],
    });
    expect(commands).toContain("gh pr ready 22 --undo -R owner/repo");
  });

  test("reports already-correct PRs", () => {
    const { root, worktreePath, contractPath } = makeRepoRoot();
    writeFileSync(contractPath, contractJson("ready_for_review", true));

    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "git" && cmd.includes("rev-parse")) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return {
          stdout: JSON.stringify([
            { number: 31, headRefName: "feature-branch", title: "Test", isDraft: false, url: "https://example.com" },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return {
          stdout: `worktree ${worktreePath}\nbranch refs/heads/feature-branch\n\n`,
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(syncStatus(root, false, runner)).toEqual({
      exitCode: 0,
      lines: ["OK #31 feature-branch: current=ready desired=ready"],
    });
  });
});

describe("sync-github-issues-to-beads", () => {
  test("commandEnv removes inherited BEADS_DIR only for bd commands", () => {
    const env = { BEADS_DIR: "/tmp/foreign/.beads", HOME: "/tmp/home" };

    expect(commandEnv(["bd", "context", "--json"], env)).toEqual({ HOME: "/tmp/home" });
    expect(commandEnv(["gh", "repo", "view"], env)).toBe(env);
  });

  test("commandEnv strips TMPDIR/TMP/TEMP/TIRITH_SESSION_ID only for tmux commands (GH-743)", () => {
    const polluted = {
      HOME: "/tmp/home",
      TMPDIR: "/Users/dev/.local/state/wt/worktrees/main/gh_678_pv0/.tmp/bun-tests",
      TMP: "/Users/dev/.local/state/wt/worktrees/main/gh_678_pv0/.tmp/bun-tests",
      TEMP: "/Users/dev/.local/state/wt/worktrees/main/gh_678_pv0/.tmp/bun-tests",
      TIRITH_SESSION_ID: "f456-69e915a7",
    };

    // tmux invocations get TMPDIR/TMP/TEMP/TIRITH_SESSION_ID stripped so the
    // spawned `-L prx` server can't bake in a caller-poisoned TMPDIR.
    expect(commandEnv(["tmux", "-L", "prx", "new-session", "-d"], polluted)).toEqual({
      HOME: "/tmp/home",
    });
    // Absolute-path invocations match on the binary basename.
    expect(commandEnv(["/opt/homebrew/bin/tmux", "has-session", "-t", "x"], polluted)).toEqual({
      HOME: "/tmp/home",
    });
    // Non-tmux commands are unaffected — this env must reach bd, gh, git, etc untouched.
    expect(commandEnv(["gh", "repo", "view"], polluted)).toBe(polluted);
    expect(commandEnv(["git", "status"], polluted)).toBe(polluted);
  });

  test("reports dry-run config update and sync", async () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: "", stderr: "unset", status: 1 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(await syncGitHubIssuesToBeads(".", false, runner)).toEqual({
      exitCode: 0,
      lines: [
        "WOULD UPDATE beads github.repository: unset -> owner/repo",
        "WOULD RUN prx beads sync --domain=gh --dry-run after updating github.repository",
      ],
    });
    expect(commands).toEqual([
      "git -C . rev-parse --show-toplevel|",
      "git -C /repo remote get-url origin|",
      "bd config get github.repository|/repo",
    ]);
  });

  test("applies config update before syncing", async () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: "different/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config set github.repository owner/repo") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state") {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const execCalls: Array<{ subcommand: string; args: string[]; cwd?: string | undefined; state?: string | undefined; role?: string | undefined }> = [];
    const execBdStub = (opts: { subcommand: string; args: string[]; cwd?: string | undefined; state?: string | undefined; role?: string | undefined }) => {
      execCalls.push(opts);
      return { exitCode: 0, stdout: "[]", stderr: "", policy: null };
    };

    const beadsSync = makeBeadsSyncStub();
    expect(await syncGitHubIssuesToBeads(".", true, runner, execBdStub, beadsSync)).toEqual({
      exitCode: 0,
      lines: [
        "UPDATED beads github.repository -> owner/repo",
        "OK beads issue sync applied.",
        "OK GitHub identity is 1:1 between Beads and GitHub.",
      ],
    });
    expect(beadsSync.calls()).toBe(1);
    expect(commands).toEqual([
      "git -C . rev-parse --show-toplevel|",
      "git -C /repo remote get-url origin|",
      "bd config get github.repository|/repo",
      "bd config set github.repository owner/repo|/repo",
      "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state|/repo",
    ]);
    expect(execCalls).toEqual([
      { subcommand: "list", args: ["--all", "--json", "--limit", "0"], cwd: "/repo", state: "planning", role: "planner" },
    ]);
  });

  test("accepts JSON output from bd config get", async () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: JSON.stringify({ key: "github.repository", value: "owner/repo" }), stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state") {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const execBdStub = () => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null });

    const beadsSync = makeBeadsSyncStub({ stdoutLine: "dry-run ok" });
    expect(await syncGitHubIssuesToBeads(".", false, runner, execBdStub, beadsSync)).toEqual({
      exitCode: 0,
      lines: [
        "OK beads github.repository=owner/repo",
        "dry-run ok",
        "OK GitHub identity is 1:1 between Beads and GitHub.",
      ],
    });
    expect(beadsSync.calls()).toBe(1);
    expect(commands).toEqual([
      "git -C . rev-parse --show-toplevel|",
      "git -C /repo remote get-url origin|",
      "bd config get github.repository|/repo",
      "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state|/repo",
    ]);
  });

  // GH-2011: legacy `gh auth token` fallback was tied to the retired
  // `bd github sync` shell-out (the bd binary needed GITHUB_TOKEN to call
  // GitHub's API itself). The canonical reconcile uses the in-tree
  // `defaultRunner` (`gh issue view ...`) which is already authenticated, so
  // no separate token plumbing is needed. The test now just asserts the
  // canonical reconcile runs once and emits its captured output.
  test("syncGitHubIssuesToBeads invokes the canonical reconcile (no separate gh auth token plumbing)", async () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state") {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const execBdStub = () => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null });

    const beadsSync = makeBeadsSyncStub({ stdoutLine: "dry-run ok" });
    expect(await syncGitHubIssuesToBeads(".", false, runner, execBdStub, beadsSync)).toEqual({
      exitCode: 0,
      lines: [
        "OK beads github.repository=owner/repo",
        "dry-run ok",
        "OK GitHub identity is 1:1 between Beads and GitHub.",
      ],
    });
    expect(beadsSync.calls()).toBe(1);
    expect(commands).toEqual([
      "git -C . rev-parse --show-toplevel|",
      "git -C /repo remote get-url origin|",
      "bd config get github.repository|/repo",
      "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state|/repo",
    ]);
  });

  test("plans legacy GitHub-backed beads ids for rename to GH numbers", async () => {
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state") {
        return {
          stdout: JSON.stringify([{ number: 204, title: "Legacy issue", url: "https://github.com/owner/repo/issues/204", state: "OPEN" }]),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const execBdStub = () => ({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          id: "ai-home-1774100044092-173-b15a44dc",
          title: "Legacy issue",
          source_system: "github:https://github.com/owner/repo/issues/204:204",
          external_ref: "https://github.com/owner/repo/issues/204",
        },
      ]),
      stderr: "",
      policy: null,
    });

    const beadsSync = makeBeadsSyncStub({ stdoutLine: "dry-run ok" });
    expect(await syncGitHubIssuesToBeads(".", false, runner, execBdStub, beadsSync)).toEqual({
      exitCode: 1,
      lines: [
        "OK beads github.repository=owner/repo",
        "dry-run ok",
        "WOULD RENAME ai-home-1774100044092-173-b15a44dc -> GH-204",
      ],
    });
  });

  test("renames legacy GitHub-backed beads ids to GH numbers on apply", async () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state") {
        return {
          stdout: JSON.stringify([{ number: 204, title: "Legacy issue", url: "https://github.com/owner/repo/issues/204", state: "OPEN" }]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "bd rename ai-home-1774100044092-173-b15a44dc GH-204") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const execBdStub = () => ({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          id: "ai-home-1774100044092-173-b15a44dc",
          title: "Legacy issue",
          source_system: "github:https://github.com/owner/repo/issues/204:204",
          external_ref: "https://github.com/owner/repo/issues/204",
        },
      ]),
      stderr: "",
      policy: null,
    });

    const beadsSync = makeBeadsSyncStub();
    expect(await syncGitHubIssuesToBeads(".", true, runner, execBdStub, beadsSync)).toEqual({
      exitCode: 0,
      lines: [
        "OK beads github.repository=owner/repo",
        "OK beads issue sync applied.",
        "RENAMED ai-home-1774100044092-173-b15a44dc -> GH-204",
      ],
    });
    expect(commands).toEqual([
      "git -C . rev-parse --show-toplevel|",
      "git -C /repo remote get-url origin|",
      "bd config get github.repository|/repo",
      "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state|/repo",
      "bd rename ai-home-1774100044092-173-b15a44dc GH-204|/repo",
    ]);
  });

  test("surfaces closed beads as duplicate bindings (GH-1592)", async () => {
    // Regression: before GH-1592 the audit loaded beads via `bd list --json`,
    // which excludes closed beads. With the fix it reads the full set
    // (`--all --json --limit 0`) through execBd, so a closed bead that still
    // points at a live GH issue is now visible to the duplicate-binding check.
    const runner: CommandRunner = (cmd, options = {}) => {
      void options;
      if (cmd.join(" ") === "git -C . rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "bd config get github.repository") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh issue list -R owner/repo --state all --limit 500 --json number,title,url,state") {
        return {
          stdout: JSON.stringify([
            { number: 204, title: "Live issue", url: "https://github.com/owner/repo/issues/204", state: "OPEN" },
          ]),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const execCalls: Array<{ subcommand: string; args: string[]; cwd?: string | undefined; state?: string | undefined; role?: string | undefined }> = [];
    const execBdStub = (opts: { subcommand: string; args: string[]; cwd?: string | undefined; state?: string | undefined; role?: string | undefined }) => {
      execCalls.push(opts);
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: "GH-204",
            title: "Live bead",
            status: "open",
            source_system: "github:https://github.com/owner/repo/issues/204:204",
            external_ref: "https://github.com/owner/repo/issues/204",
          },
          {
            id: "ai-home-legacy-204",
            title: "Stale closed bead",
            status: "closed",
            source_system: "github:https://github.com/owner/repo/issues/204:204",
            external_ref: "https://github.com/owner/repo/issues/204",
          },
        ]),
        stderr: "",
        policy: null,
      };
    };

    const beadsSync = makeBeadsSyncStub({ stdoutLine: "dry-run ok" });
    expect(await syncGitHubIssuesToBeads(".", false, runner, execBdStub, beadsSync)).toEqual({
      exitCode: 1,
      lines: [
        "OK beads github.repository=owner/repo",
        "dry-run ok",
        "FAIL GitHub issue #204 is bound to multiple beads issues: GH-204, ai-home-legacy-204",
        "FAIL cannot rename ai-home-legacy-204 -> GH-204: target id already exists",
      ],
    });
    expect(execCalls).toEqual([
      { subcommand: "list", args: ["--all", "--json", "--limit", "0"], cwd: "/repo", state: "planning", role: "planner" },
    ]);
  });
});

describe("protect-main", () => {
  test("returns the branch protection command in dry-run mode", () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "remote" && cmd[4] === "get-url") {
        return { stdout: "https://github.com/bdelanghe/ai-home.git\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = protectMainBranch("/repo", {}, runner);

    expect(result).toMatchObject({
      solo: false,
      repo: "bdelanghe/ai-home",
      branch: "main",
      viewer: "bdelanghe",
      owner: "bdelanghe",
      approvalContributorCount: null,
      requireLastPushApprovalSuppressed: false,
      requiredApprovingReviewCountSuppressed: false,
      apply: false,
      applied: false,
      requireConversationResolution: false,
      requireLastPushApproval: false,
      requiredApprovingReviewCount: 1,
      requireLinearHistory: false,
      requiredStatusChecks: [],
    });
    expect(result.command.join(" ")).toContain("repos/bdelanghe/ai-home/branches/main/protection");
    expect(commands).toEqual([
      "git -C /repo remote get-url origin|",
      "gh api user --jq .login|",
      "gh api repos/bdelanghe/ai-home --jq .owner.type|",
      "git -C /repo rev-parse --show-toplevel|",
      "gh api repos/bdelanghe/ai-home/collaborators?per_page=100|",
    ]);
  });

  test("applies protection when requested", () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "remote" && cmd[4] === "get-url") {
        return { stdout: "https://github.com/bdelanghe/ai-home.git\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method") {
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = protectMainBranch("/repo", {
      apply: true,
      enforceAdmins: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requireLinearHistory: true,
      requiredStatusChecks: ["ci / test", "lint"],
    }, runner);

    expect(result.applied).toBe(true);
    expect(result.enforceAdmins).toBe(true);
    expect(result.requireConversationResolution).toBe(true);
    expect(result.requireLastPushApproval).toBe(true);
    expect(result.requireLinearHistory).toBe(true);
    expect(result.requiredStatusChecks).toEqual(["ci / test", "lint"]);
    expect(commands[4]).toBe("gh api repos/bdelanghe/ai-home/collaborators?per_page=100|");
    expect(commands[5]).toContain("gh api --method PUT");
    expect(commands[5]).toContain("|/repo");
  });

  test("fails when viewer is not the repo owner", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        if (cmd.includes("nameWithOwner")) {
          return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
        }
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "someone-else\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(() => protectMainBranch("/repo", {}, runner)).toThrow(
      "protect-main requires repo ownership: viewer=someone-else owner=bdelanghe repo=bdelanghe/ai-home",
    );
  });

  test("branch protection payload is schema-validated and documented", () => {
    const payload = branchProtectionPayloadSchema.parse({
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: true,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: false,
      lock_branch: false,
      allow_fork_syncing: false,
    });

    expect(payload.required_pull_request_reviews.required_approving_review_count).toBe(1);
    expect(branchProtectionPayloadJsonSchema.required).toContain("required_pull_request_reviews");
    expect(branchProtectionPayloadJsonSchema.properties.required_pull_request_reviews.type).toBe("object");
    expect(branchProtectionPayloadJsonSchema.properties.enforce_admins.type).toEqual(["boolean", "null"]);
    expect(branchProtectionPayloadJsonSchema.properties.required_status_checks.anyOf).toHaveLength(2);
    expect(branchProtectionPayloadJsonSchema.properties.required_status_checks.anyOf[1].properties.contexts).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  test("omits organization-only review restriction fields for user-owned repos", () => {
    let appliedPayload: BranchProtectionPayload | null = null;
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        if (cmd.includes("nameWithOwner")) {
          return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
        }
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method") {
        const payloadPath = cmd[cmd.length - 1]!;
        appliedPayload = JSON.parse(readFileSync(payloadPath, "utf8")) as BranchProtectionPayload;
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = protectMainBranch("/repo", { apply: true }, runner);
    const payload = appliedPayload as unknown as Record<string, unknown>;

    expect(result.ownerType).toBe("User");
    expect(appliedPayload).not.toBeNull();
    expect((payload.required_pull_request_reviews as Record<string, unknown>).dismissal_restrictions).toBeUndefined();
    expect((payload.required_pull_request_reviews as Record<string, unknown>).bypass_pull_request_allowances).toBeUndefined();
    expect(payload.enforce_admins).toBeNull();  });

  test("includes status checks and conversation resolution when requested", () => {
    let appliedPayload: BranchProtectionPayload | null = null;
    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        if (cmd.includes("nameWithOwner")) {
          return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
        }
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method") {
        const payloadPath = cmd[cmd.length - 1]!;
        appliedPayload = JSON.parse(readFileSync(payloadPath, "utf8")) as BranchProtectionPayload;
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    protectMainBranch("/repo", {
      apply: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requireLinearHistory: true,
      requiredStatusChecks: ["ci / test", "lint"],
    }, runner);
    const payload = appliedPayload as unknown as Record<string, unknown>;

    expect(payload.required_conversation_resolution).toBe(true);
    expect((payload.required_pull_request_reviews as Record<string, unknown>).require_last_push_approval).toBe(
      true,
    );
    expect(payload.required_linear_history).toBe(true);
    expect(payload.required_status_checks).toEqual({      strict: true,
      contexts: ["ci / test", "lint"],
    });
  });

  test("loads default desired policy from .prx branch protection spec", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-protect-spec-"));
    mkdirSync(join(root, ".prx", "branch_protection"), { recursive: true });
    writeFileSync(
      join(root, ".prx", "branch_protection", "main.json"),
      JSON.stringify({
        branch: "main",
        protection: {
          required_status_checks: { strict: true, contexts: ["ci"] },
          enforce_admins: true,
          required_pull_request_reviews: {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 1,
            require_last_push_approval: true,
          },
          restrictions: null,
          required_linear_history: true,
          allow_force_pushes: false,
          allow_deletions: false,
          block_creations: false,
          required_conversation_resolution: true,
          lock_branch: false,
          allow_fork_syncing: false,
        },
      }),
    );
    let appliedPayload: BranchProtectionPayload | null = null;
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd[0] === "gh" && cmd[1] === "repo" && cmd.includes("nameWithOwner")) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method") {
        const payloadPath = cmd[cmd.length - 1]!;
        appliedPayload = JSON.parse(readFileSync(payloadPath, "utf8")) as BranchProtectionPayload;
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}|${options.cwd ?? ""}`);
    };

    const result = protectMainBranch(root, { apply: true }, runner);
    const payload = appliedPayload as unknown as Record<string, unknown>;

    expect(result.enforceAdmins).toBe(true);
    expect(result.requireConversationResolution).toBe(true);
    expect(result.requireLastPushApproval).toBe(true);
    expect(result.requireLinearHistory).toBe(true);
    expect(result.requiredStatusChecks).toEqual(["ci"]);
    expect(payload.required_status_checks).toEqual({ strict: true, contexts: ["ci"] });  });

  test("suppresses last-push approval when fewer than two approval-capable contributors exist", () => {
    let appliedPayload: BranchProtectionPayload | null = null;
    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "repo" && cmd.includes("nameWithOwner")) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/collaborators?per_page=100") {
        return {
          stdout: JSON.stringify([{ permissions: { admin: true, push: true } }]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method") {
        const payloadPath = cmd[cmd.length - 1]!;
        appliedPayload = JSON.parse(readFileSync(payloadPath, "utf8")) as BranchProtectionPayload;
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = protectMainBranch("/repo", {
      apply: true,
      requireLastPushApproval: true,
    }, runner);
    const payload = appliedPayload as unknown as Record<string, unknown>;

    expect(result.approvalContributorCount).toBe(1);
    expect(result.requireLastPushApprovalSuppressed).toBe(true);
    expect(result.requiredApprovingReviewCountSuppressed).toBe(true);
    expect(result.requireLastPushApproval).toBe(false);
    expect(result.requiredApprovingReviewCount).toBe(0);
    expect((payload.required_pull_request_reviews as Record<string, unknown>).require_last_push_approval).toBe(
      false,
    );
    expect((payload.required_pull_request_reviews as Record<string, unknown>).required_approving_review_count).toBe(      0,
    );
  });

  test("solo mode disables approval gates even when contributor count is unknown", () => {
    let appliedPayload: BranchProtectionPayload | null = null;
    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "repo" && cmd.includes("nameWithOwner")) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/collaborators?per_page=100") {
        throw new Error("network unavailable");
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method") {
        const payloadPath = cmd[cmd.length - 1]!;
        appliedPayload = JSON.parse(readFileSync(payloadPath, "utf8")) as BranchProtectionPayload;
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = protectMainBranch("/repo", {
      apply: true,
      solo: true,
      requireLastPushApproval: true,
    }, runner);
    const payload = appliedPayload as unknown as Record<string, unknown>;

    expect(result.solo).toBe(true);
    expect(result.approvalContributorCount).toBeNull();
    expect(result.requireLastPushApprovalSuppressed).toBe(false);
    expect(result.requiredApprovingReviewCountSuppressed).toBe(false);
    expect(result.requireConversationResolution).toBe(false);
    expect(result.requireLastPushApproval).toBe(false);
    expect(result.requiredApprovingReviewCount).toBe(0);
    expect((payload.required_pull_request_reviews as Record<string, unknown>).dismiss_stale_reviews).toBe(false);
    expect((payload.required_pull_request_reviews as Record<string, unknown>).require_last_push_approval).toBe(
      false,
    );
    expect((payload.required_pull_request_reviews as Record<string, unknown>).required_approving_review_count).toBe(
      0,
    );
    expect(payload.required_conversation_resolution).toBe(false);  });

  test("creates a managed repository ruleset when requested", () => {
    const commands: string[] = [];
    let appliedPayload: RulesetPayload | null = null;
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd[0] === "gh" && cmd[1] === "repo" && cmd.includes("nameWithOwner")) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/collaborators?per_page=100") {
        return {
          stdout: JSON.stringify([{ permissions: { admin: true, push: true } }]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "-H" && cmd[6] === "repos/bdelanghe/ai-home/rulesets?per_page=100") {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "--method" && cmd[3] === "POST") {
        const payloadPath = cmd[cmd.length - 1]!;
        appliedPayload = JSON.parse(readFileSync(payloadPath, "utf8")) as RulesetPayload;
        return { stdout: "{}", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}|${options.cwd ?? ""}`);
    };

    const result = protectMainBranch("/repo", {
      backend: "ruleset",
      apply: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requiredStatusChecks: ["ci"],
    }, runner);
    const payload = appliedPayload as unknown as Record<string, unknown>;

    expect(result.backend).toBe("ruleset");
    expect(result.solo).toBe(false);
    expect(result.rulesetId).toBeNull();
    expect(result.rulesetName).toBe("prx main branch ruleset");
    expect(result.requireLastPushApproval).toBe(false);
    expect(result.requiredApprovingReviewCount).toBe(0);
    expect(commands).toContain(
      "gh api -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2022-11-28 repos/bdelanghe/ai-home/rulesets?per_page=100|",
    );
    expect(commands.some((cmd) => cmd.includes("gh api --method POST"))).toBe(true);
    expect(appliedPayload).toMatchObject({
      name: "prx main branch ruleset",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
    });
    expect(payload.bypass_actors).toEqual([]);
    expect(payload.rules).toEqual(expect.arrayContaining([      {
        type: "pull_request",
        parameters: expect.objectContaining({
          required_approving_review_count: 0,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
        }),
      },
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci" }],
        },
      },
    ]));
  });
});

describe("protect-main check", () => {
  test("matches when live protection equals desired protection", () => {
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        if (cmd.includes("nameWithOwner")) {
          return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
        }
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/branches/main/protection") {
        return {
          stdout: JSON.stringify({
            required_status_checks: null,
            enforce_admins: { enabled: true },
            required_pull_request_reviews: {
              dismiss_stale_reviews: true,
              require_code_owner_reviews: false,
              required_approving_review_count: 1,
              require_last_push_approval: true,
            },
            required_linear_history: { enabled: true },
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
            block_creations: { enabled: false },
            required_conversation_resolution: { enabled: true },
            lock_branch: { enabled: false },
            allow_fork_syncing: { enabled: false },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}|${options.cwd ?? ""}`);
    };

    const result = checkMainBranchProtection("/repo", {
      enforceAdmins: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requireLinearHistory: true,
    }, runner);

    expect(result.matches).toBe(true);
  });

  test("matches when live status-check contexts arrive in a different order", () => {
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        if (cmd.includes("nameWithOwner")) {
          return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
        }
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/branches/main/protection") {
        return {
          stdout: JSON.stringify({
            required_status_checks: { strict: true, contexts: ["lint", "ci"] },
            enforce_admins: null,
            required_pull_request_reviews: {
              dismiss_stale_reviews: true,
              require_code_owner_reviews: false,
              required_approving_review_count: 1,
              require_last_push_approval: false,
            },
            required_linear_history: { enabled: false },
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
            block_creations: { enabled: false },
            required_conversation_resolution: { enabled: false },
            lock_branch: { enabled: false },
            allow_fork_syncing: { enabled: false },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}|${options.cwd ?? ""}`);
    };

    const result = checkMainBranchProtection("/repo", {
      requiredStatusChecks: ["ci", "lint"],
    }, runner);

    expect(result.matches).toBe(true);
  });

  test("treats empty live status-check contexts as no required checks", () => {
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        if (cmd.includes("nameWithOwner")) {
          return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
        }
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/branches/main/protection") {
        return {
          stdout: JSON.stringify({
            required_status_checks: { strict: true, contexts: [] },
            enforce_admins: null,
            required_pull_request_reviews: {
              dismiss_stale_reviews: true,
              require_code_owner_reviews: false,
              required_approving_review_count: 1,
              require_last_push_approval: false,
            },
            required_linear_history: { enabled: false },
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
            block_creations: { enabled: false },
            required_conversation_resolution: { enabled: false },
            lock_branch: { enabled: false },
            allow_fork_syncing: { enabled: false },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}|${options.cwd ?? ""}`);
    };

    const result = checkMainBranchProtection("/repo", {}, runner);

    expect(result.live.required_status_checks).toBeNull();
    expect(result.matches).toBe(true);
  });

  test("matches a managed repository ruleset when requested", () => {
    const runner: CommandRunner = (cmd, options = {}) => {
      if (cmd[0] === "gh" && cmd[1] === "repo" && cmd.includes("nameWithOwner")) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
        return { stdout: "bdelanghe\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home") {
        return { stdout: "User\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/collaborators?per_page=100") {
        return {
          stdout: JSON.stringify([{ permissions: { admin: true, push: true } }]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "rev-parse" && cmd[4] === "--show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "-H" && cmd[6] === "repos/bdelanghe/ai-home/rulesets?per_page=100") {
        return {
          stdout: JSON.stringify([
            {
              id: 42,
              name: "prx main branch ruleset",
              target: "branch",
            },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "-H" && cmd[6] === "repos/bdelanghe/ai-home/rulesets/42") {
        return {
          stdout: JSON.stringify(
            {
              id: 42,
              name: "prx main branch ruleset",
              target: "branch",
              enforcement: "active",
              bypass_actors: [],
              conditions: {
                ref_name: {
                  include: ["refs/heads/main"],
                  exclude: [],
                },
              },
              rules: [
                {
                  type: "pull_request",
                  parameters: {
                    dismiss_stale_reviews_on_push: false,
                    require_code_owner_review: false,
                    require_last_push_approval: false,
                    required_approving_review_count: 0,
                    required_review_thread_resolution: false,
                  },
                },
                { type: "deletion" },
                { type: "non_fast_forward" },
                {
                  type: "required_status_checks",
                  parameters: {
                    strict_required_status_checks_policy: true,
                    required_status_checks: [{ context: "ci" }],
                  },
                },
              ],
            },
          ),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}|${options.cwd ?? ""}`);
    };

    const result = checkMainBranchProtection("/repo", {
      backend: "ruleset",
      solo: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requiredStatusChecks: ["ci"],
    }, runner);

    expect(result.backend).toBe("ruleset");
    expect(result.solo).toBe(true);
    expect(result.rulesetId).toBe(42);
    expect(result.requireConversationResolution).toBe(false);
    expect(result.matches).toBe(true);
  });
});

describe("repo-checks", () => {
  test("lists deduplicated check names from the branch head sha", () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd[0] === "git" && cmd[1] === "-C" && cmd[3] === "remote" && cmd[4] === "get-url") {
        return { stdout: "https://github.com/bdelanghe/ai-home.git\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/branches/main") {
        return { stdout: "abc123\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "repos/bdelanghe/ai-home/commits/abc123/check-runs") {
        return { stdout: "lint\nci / test\nlint\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(repoCheckNames("/repo", {}, runner)).toEqual({
      repo: "bdelanghe/ai-home",
      branch: "main",
      sha: "abc123",
      checks: ["ci / test", "lint"],
    });
    expect(commands).toEqual([
      "git -C /repo remote get-url origin|",
      "gh api repos/bdelanghe/ai-home/branches/main --jq .commit.sha|/repo",
      "gh api repos/bdelanghe/ai-home/commits/abc123/check-runs --jq .check_runs[].name|/repo",
    ]);
  });
});

describe("parseGithubRepo", () => {
  test("parses ssh, https, and ssh:// origin URLs with and without .git", () => {
    expect(parseGithubRepo("git@github.com:bdelanghe/ai-home.git")).toBe("bdelanghe/ai-home");
    expect(parseGithubRepo("git@github.com:bdelanghe/ai-home")).toBe("bdelanghe/ai-home");
    expect(parseGithubRepo("https://github.com/bdelanghe/ai-home.git")).toBe("bdelanghe/ai-home");
    expect(parseGithubRepo("https://github.com/bdelanghe/ai-home")).toBe("bdelanghe/ai-home");
    expect(parseGithubRepo("ssh://git@github.com/bdelanghe/ai-home.git")).toBe("bdelanghe/ai-home");
    expect(parseGithubRepo("ssh://git@github.com/bdelanghe/ai-home")).toBe("bdelanghe/ai-home");
  });

  test("preserves owner/repo casing", () => {
    expect(parseGithubRepo("git@github.com:BDeLanghe/AI-Home.git")).toBe("BDeLanghe/AI-Home");
  });

  test("returns null for non-github hosts and unparseable URLs", () => {
    expect(parseGithubRepo("git@gitlab.com:bdelanghe/ai-home.git")).toBeNull();
    expect(parseGithubRepo("https://example.com/bdelanghe/ai-home.git")).toBeNull();
    expect(parseGithubRepo("https://github.com/bdelanghe")).toBeNull();
    expect(parseGithubRepo("not a url")).toBeNull();
    expect(parseGithubRepo("")).toBeNull();
  });
});

describe("canonicalDoltDatabase (E0 of GH-1685)", () => {
  test("derives reverse-DNS io_github_<owner>_<repo>, sanitizing hyphens/case", () => {
    expect(canonicalDoltDatabase("git@github.com:bounded-systems/prx.git")).toBe(
      "io_github_bounded_systems_prx",
    );
    expect(canonicalDoltDatabase("https://github.com/bounded-systems/prx")).toBe(
      "io_github_bounded_systems_prx",
    );
    // matches the live on-disk shape for an existing shared-server db
    expect(canonicalDoltDatabase("git@github.com:pushd/supply-plan-design.git")).toBe(
      "io_github_pushd_supply_plan_design",
    );
    // uppercase origin collapses to lowercase canonical
    expect(canonicalDoltDatabase("https://github.com/BDeLanghe/AI-Home")).toBe(
      "io_github_bdelanghe_ai_home",
    );
  });

  test("output validates against the schema's DoltDatabaseName pattern", () => {
    const name = canonicalDoltDatabase("https://github.com/bounded-systems/prx");
    expect(name).not.toBeNull();
    expect(RepoSlug.safeParse(name).success).toBe(true);
  });

  test("returns null for non-github origins and unparseable URLs", () => {
    expect(canonicalDoltDatabase("git@gitlab.com:bdelanghe/ai-home.git")).toBeNull();
    expect(canonicalDoltDatabase("not a url")).toBeNull();
    expect(canonicalDoltDatabase("")).toBeNull();
  });
});

describe("repoNameWithOwner", () => {
  test("derives owner/repo from a github.com origin without spawning gh", () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(repoNameWithOwner("/repo", runner)).toBe("bdelanghe/ai-home");
    expect(commands).toEqual(["git -C /repo remote get-url origin|"]);
  });

  test("falls back to gh repo view when origin is not a github.com URL", () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "git@gitlab.com:bdelanghe/ai-home.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "gh repo view --json nameWithOwner --jq .nameWithOwner") {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(repoNameWithOwner("/repo", runner)).toBe("bdelanghe/ai-home");
    expect(commands).toEqual([
      "git -C /repo remote get-url origin|",
      "gh repo view --json nameWithOwner --jq .nameWithOwner|/repo",
    ]);
  });

  test("falls back to gh repo view when there is no origin remote", () => {
    const commands: string[] = [];
    const runner: CommandRunner = (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      if (cmd.join(" ") === "git -C /repo remote get-url origin") {
        return { stdout: "", stderr: "error: No such remote 'origin'", status: 2 };
      }
      if (cmd.join(" ") === "gh repo view --json nameWithOwner --jq .nameWithOwner") {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(repoNameWithOwner("/repo", runner)).toBe("bdelanghe/ai-home");
    expect(commands).toEqual([
      "git -C /repo remote get-url origin|",
      "gh repo view --json nameWithOwner --jq .nameWithOwner|/repo",
    ]);
  });
});

describe("update-pr", () => {
  test("dry run reports render, body update, and mode change", () => {
    const { root, contractPath } = makeRepoRoot();
    writeFileSync(contractPath, contractJson("drafting", false));

    const runner: CommandRunner = (cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
        return {
          stdout: JSON.stringify({ number: 41, isDraft: false, title: "Old title", url: "https://example.com" }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(
      updatePrFromContract(root, contractPath, join(root, ".pr", "local", "pr.md"), undefined, false, runner),
    ).toEqual({
      exitCode: 0,
      lines: [
        `WOULD RENDER ${contractPath} -> ${join(root, ".pr", "local", "pr.md")}`,
        "WOULD UPDATE PR #41 title/body from contract",
        "WOULD MARK PR #41 draft",
      ],
    });
  });

  test("apply renders, edits the PR, and marks it ready when needed", () => {
    const { root, contractPath } = makeRepoRoot();
    writeFileSync(contractPath, contractJson("ready_for_review", true));
    const outputPath = join(root, ".pr", "local", "pr.md");
    const commands: string[] = [];
    const renders: string[] = [];

    const runner: CommandRunner = (cmd) => {
      commands.push(cmd.join(" "));
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
        return {
          stdout: JSON.stringify({ number: 55, isDraft: true, title: "Old title", url: "https://example.com" }),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "edit") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "ready") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const renderRunner = (contractArg: string, outputArg: string) => {
      renders.push(`${contractArg} -> ${outputArg}`);
    };

    expect(
      updatePrFromContract(root, contractPath, outputPath, undefined, true, runner, renderRunner),
    ).toEqual({
      exitCode: 0,
      lines: [
        `UPDATED ${outputPath} from ${contractPath}`,
        "UPDATED PR #55 title/body from contract",
        "UPDATED PR #55 draft -> ready",
      ],
    });
    expect(renders).toEqual([`${contractPath} -> ${outputPath}`]);
    expect(commands).toContain(
      "gh pr edit 55 --title Sync example --body-file " +
        outputPath,
    );
    expect(commands).toContain("gh pr ready 55");
  });
});

describe("overview-status", () => {
  test("combines current branch, created-by-you, and local contract state", () => {
    const { root, worktreePath, contractPath } = makeRepoRoot();
    writeFileSync(contractPath, contractJson("ready_for_review", true));

    const runner: CommandRunner = (cmd, options) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "git" && cmd.includes("worktree")) {
        return {
          stdout: `worktree ${worktreePath}\nbranch refs/heads/feature-branch\n\n`,
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 62,
              headRefName: "feature-branch",
              title: "Feature work",
              isDraft: false,
              url: "https://example.com/62",
              reviewDecision: "REVIEW_REQUIRED",
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
              mergeable: "MERGEABLE",
              reviews: [{ state: "APPROVED" }, { state: "COMMENTED" }],
            },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "diff") {
        if (cmd.includes("--name-only")) {
          return {
            stdout: "lib/example.rb\ntest/example_test.rb\n",
            stderr: "",
            status: 0,
          };
        }
        return {
          stdout: [
            "diff --git a/lib/example.rb b/lib/example.rb",
            "--- a/lib/example.rb",
            "+++ b/lib/example.rb",
            "+added line",
            "-removed line",
            "+another added line",
          ].join("\n"),
          stderr: "",
          status: 0,
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view" && options?.check === false) {
        return {
          stdout: JSON.stringify({
            number: 62,
            headRefName: "feature-branch",
            title: "Feature work",
            isDraft: false,
            url: "https://example.com/62",
            reviewDecision: "REVIEW_REQUIRED",
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            mergeable: "MERGEABLE",
            reviews: [{ state: "APPROVED" }, { state: "COMMENTED" }],
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(overviewStatus(root, true, runner)).toEqual({
      repo: "owner/repo",
      currentBranch: {
        number: 62,
        title: "Feature work",
        branch: "feature-branch",
        url: "https://example.com/62",
        draft: false,
        checks: "green",
        review: "review_required",
        approvals: 1,
        mergeable: "mergeable",
        worktree: null,
        diff: {
          files: 2,
          additions: 2,
          deletions: 1,
        },
        local: {
          worktreePath,
          contractPath,
          lifecycle: "ready_for_review",
          mode: "ready",
        },
      },
      createdByYou: [
        {
          number: 62,
          title: "Feature work",
          branch: "feature-branch",
          url: "https://example.com/62",
          draft: false,
          checks: "green",
          review: "review_required",
          approvals: 1,
          mergeable: "mergeable",
          worktree: null,
          diff: {
            files: 2,
            additions: 2,
            deletions: 1,
          },
          local: {
            worktreePath,
            contractPath,
            lifecycle: "ready_for_review",
            mode: "ready",
          },
        },
      ],
    });
  });
});

describe("worktree-status", () => {
  test("parses porcelain branch sync and file buckets", () => {
    const summary = parseWorktreeStatus([
      "## GH-5480...origin/GH-5480 [ahead 2, behind 1]",
      "M  staged_only.rb",
      " M unstaged_only.rb",
      "MM both.rb",
      "?? untracked.rb",
      "UU conflict.rb",
      "!! ignored.log",
    ].join("\n"));

    expect(summary.branch.name).toBe("GH-5480");
    expect(summary.branch.upstream).toBe("origin/GH-5480");
    expect(summary.branch.sync).toBe("diverged");
    expect(summary.branch.ahead).toBe(2);
    expect(summary.branch.behind).toBe(1);
    expect(summary.files.staged).toEqual(["staged_only.rb", "both.rb"]);
    expect(summary.files.unstaged).toEqual(["unstaged_only.rb", "both.rb"]);
    expect(summary.files.untracked).toEqual(["untracked.rb"]);
    expect(summary.files.conflicts).toEqual(["conflict.rb"]);
    expect(summary.files.ignored).toEqual(["ignored.log"]);
    expect(summary.clean).toBe(false);
  });

  test("reads porcelain output through the git command runner", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
        return {
          stdout: "## main...origin/main\n",
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = worktreeStatus("/repo", runner);
    expect(summary.branch.sync).toBe("up_to_date");
    expect(summary.clean).toBe(true);
  });

  test("derives worktree status with symbols and git detail from git porcelain", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout: "worktree /repo/wt1\nHEAD abc123\nbranch refs/heads/GH-5480\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo/wt1 status --porcelain=v1 -b") {
        return {
          stdout: "## GH-5480...origin/GH-5480 [ahead 2]\n M lib/x.rb\n",
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = wtStatus("/repo", true, runner);
    expect(summary.wt_available).toBe(true);
    expect(summary.worktrees).toHaveLength(1);
    expect(summary.worktrees[0]!).toMatchObject({
      branch: "GH-5480",
      integration: "feature",
      clean: false,
      dirty_flags: ["modified"],
      sync: { state: "ahead", ahead: 2, behind: 0 },
      structural: { detached: false, mismatch: false },
      symbols: ["!", "↑"],
      symbol_meanings: ["modified", "ahead"],
      commit: { sha: "abc123" },
      git: {
        clean: false,
        counts: {
          staged: 0,
          unstaged: 1,
        },
      },
    });
  });

  test("reads worktrees via git worktree list --porcelain (no wt binary)", () => {
    const captured: string[][] = [];
    const runner: CommandRunner = (cmd) => {
      captured.push(cmd);
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    wtStatus("/repo", false, runner);
    expect(captured.some((c) => c[0] === "wt")).toBe(false);
    expect(
      captured.some((c) => c.join(" ") === "git -C /repo worktree list --porcelain"),
    ).toBe(true);
  });

  test("marks unavailable when git worktree list fails", () => {
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        throw new Error("not a git repository");
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = wtStatus("/repo", true, runner);
    expect(summary).toEqual({
      source: "wt+git",
      wt_available: false,
      symbols: {
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
      },
      worktrees: [],
    });
  });
});

describe("wt-status cache (GH-705)", () => {
  type Captured = { cmd: string[]; options?: Record<string, unknown> | undefined };

  function makeCountingRunner(captured: Captured[] = []): CommandRunner {
    return (cmd, options) => {
      captured.push({ cmd, options });
      if (cmd.join(" ") === "git -C /repo rev-parse --path-format=absolute --git-common-dir") {
        return { stdout: "/repo/.git\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout: "worktree /repo\nHEAD deadbeef\nbranch refs/heads/main\n\n",
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
  }

  async function withCacheEnv<T>(fn: (cacheDir: string) => T | Promise<T>): Promise<T> {
    const cacheHome = mkdtempSync(join(tmpdir(), "prx-wt-cache-"));
    const savedCacheHome = process.env.XDG_CACHE_HOME;
    const savedDisable = process.env.PRX_WT_CACHE_DISABLE;
    const savedTtl = process.env.PRX_WT_CACHE_TTL_MS;
    process.env.XDG_CACHE_HOME = cacheHome;
    delete process.env.PRX_WT_CACHE_DISABLE;
    delete process.env.PRX_WT_CACHE_TTL_MS;
    try {
      return await fn(cacheHome);
    } finally {
      if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCacheHome;
      if (savedDisable === undefined) delete process.env.PRX_WT_CACHE_DISABLE;
      else process.env.PRX_WT_CACHE_DISABLE = savedDisable;
      if (savedTtl === undefined) delete process.env.PRX_WT_CACHE_TTL_MS;
      else process.env.PRX_WT_CACHE_TTL_MS = savedTtl;
    }
  }

  test("reuses wt list output within TTL", async () => {
    await withCacheEnv(() => {
      const captured: Captured[] = [];
      const runner = makeCountingRunner(captured);

      const first = wtStatus("/repo", false, runner);
      const second = wtStatus("/repo", false, runner);

      expect(second).toEqual(first);
      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(1);
    });
  });

  test("refreshes after TTL expires", async () => {
    await withCacheEnv(async () => {
      process.env.PRX_WT_CACHE_TTL_MS = "1";
      const captured: Captured[] = [];
      const runner = makeCountingRunner(captured);

      wtStatus("/repo", false, runner);
      await new Promise((resolve) => setTimeout(resolve, 10));
      wtStatus("/repo", false, runner);

      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(2);
    });
  });

  test("bypasses cache when PRX_WT_CACHE_DISABLE=1", async () => {
    await withCacheEnv(() => {
      process.env.PRX_WT_CACHE_DISABLE = "1";
      const captured: Captured[] = [];
      const runner = makeCountingRunner(captured);

      wtStatus("/repo", false, runner);
      wtStatus("/repo", false, runner);

      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(2);
      const commonDirProbes = captured.filter(
        (entry) => entry.cmd.join(" ") === "git -C /repo rev-parse --path-format=absolute --git-common-dir",
      );
      expect(commonDirProbes).toHaveLength(0);
    });
  });

  test("separates full vs lite cache entries", async () => {
    await withCacheEnv(() => {
      const captured: Captured[] = [];
      const runner: CommandRunner = (cmd, options) => {
        captured.push({ cmd, options });
        if (cmd.join(" ") === "git -C /repo rev-parse --path-format=absolute --git-common-dir") {
          return { stdout: "/repo/.git\n", stderr: "", status: 0 };
        }
        if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
          return { stdout: "/repo\n", stderr: "", status: 0 };
        }
        if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
          return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
        }
        if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
          return {
            stdout: "worktree /repo\nHEAD deadbeef\nbranch refs/heads/main\n\n",
            stderr: "",
            status: 0,
          };
        }
        throw new Error(`Unexpected command: ${cmd.join(" ")}`);
      };

      wtStatus("/repo", false, runner);
      wtStatus("/repo", true, runner);
      wtStatus("/repo", false, runner);
      wtStatus("/repo", true, runner);

      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(2);
    });
  });

  test("falls through when the cache file is corrupt", async () => {
    await withCacheEnv((cacheHome) => {
      const captured: Captured[] = [];
      const runner = makeCountingRunner(captured);

      wtStatus("/repo", false, runner);
      const cacheDir = join(cacheHome, "prx", "wt-status");
      const files = require("node:fs").readdirSync(cacheDir) as string[];
      expect(files.length).toBeGreaterThan(0);
      const cacheFile = join(cacheDir, files[0]!);
      writeFileSync(cacheFile, "{not valid json");

      const result = wtStatus("/repo", false, runner);
      expect(result.wt_available).toBe(true);
      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(2);
    });
  });

  test("skips caching when git common-dir probe fails", async () => {
    await withCacheEnv((cacheHome) => {
      const captured: Captured[] = [];
      const runner: CommandRunner = (cmd, options) => {
        captured.push({ cmd, options });
        if (cmd.join(" ") === "git -C /repo rev-parse --path-format=absolute --git-common-dir") {
          return { stdout: "", stderr: "not a repository", status: 128 };
        }
        if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
          return { stdout: "/repo\n", stderr: "", status: 0 };
        }
        if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
          return {
            stdout: "worktree /repo\nHEAD deadbeef\nbranch refs/heads/main\n\n",
            stderr: "",
            status: 0,
          };
        }
        throw new Error(`Unexpected command: ${cmd.join(" ")}`);
      };

      wtStatus("/repo", false, runner);
      wtStatus("/repo", false, runner);

      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(2);
      const cacheDir = join(cacheHome, "prx", "wt-status");
      expect(existsSync(cacheDir)).toBe(false);
    });
  });

  test("caches remoteStatus fetch --dry-run via repoStatus", async () => {
    await withCacheEnv(() => {
      const captured: Captured[] = [];
      const runner: CommandRunner = (cmd, options) => {
        captured.push({ cmd, options });
        const joined = cmd.join(" ");
        if (joined === "git -C /repo rev-parse --path-format=absolute --git-common-dir") {
          return { stdout: "/repo/.git\n", stderr: "", status: 0 };
        }
        if (joined === "git -C /repo rev-parse --show-toplevel") {
          return { stdout: "/repo\n", stderr: "", status: 0 };
        }
        if (joined === "git -C /repo status --porcelain=v1 -b") {
          return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
        }
        if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
          return {
            stdout: "worktree /repo\nHEAD deadbeef\nbranch refs/heads/main\n\n",
            stderr: "",
            status: 0,
          };
        }
        if (joined === "git -C /repo fetch --dry-run origin") {
          return { stdout: "", stderr: "", status: 0 };
        }
        if (joined.startsWith("git -C /repo rev-parse --git-path")) {
          return { stdout: ".git/missing\n", stderr: "", status: 0 };
        }
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
          return { stdout: "", stderr: "no PR", status: 1 };
        }
        throw new Error(`Unexpected command: ${joined}`);
      };

      repoStatus("/repo", { includeGitDetails: false, fetch: false }, runner);
      repoStatus("/repo", { includeGitDetails: false, fetch: false }, runner);

      const fetchCalls = captured.filter((entry) =>
        entry.cmd.join(" ") === "git -C /repo fetch --dry-run origin",
      );
      const wtCalls = captured.filter((entry) => entry.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(fetchCalls).toHaveLength(1);
      expect(wtCalls).toHaveLength(1);
    });
  });

  test("rejects cache entries with non-finite writtenAt", async () => {
    await withCacheEnv((cacheHome) => {
      const captured: Captured[] = [];
      const runner = makeCountingRunner(captured);

      wtStatus("/repo", false, runner);
      const cacheDir = join(cacheHome, "prx", "wt-status");
      const files = require("node:fs").readdirSync(cacheDir) as string[];
      const cacheFile = join(cacheDir, files[0]!);
      const entry = JSON.parse(readFileSync(cacheFile, "utf8"));
      entry.writtenAt = "not-a-number";
      writeFileSync(cacheFile, JSON.stringify(entry));

      wtStatus("/repo", false, runner);
      const wtCalls = captured.filter((c) => c.cmd.join(" ") === "git -C /repo worktree list --porcelain");
      expect(wtCalls).toHaveLength(2);
    });
  });
});

describe("repo-status", () => {
  test("composes local, worktree, remote freshness, and current pr", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
        return {
          stdout: "## main...origin/main\n M db/schema.rb\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout: "worktree /repo\nHEAD aaa000\nbranch refs/heads/main\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo fetch --dry-run origin") {
        return {
          stdout: "",
          stderr: "From github.com:demo/demo-web\n   a3b6307..7045aba  main       -> origin/main",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path MERGE_HEAD") {
        return { stdout: ".git/MERGE_HEAD\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path rebase-apply") {
        return { stdout: ".git/rebase-apply\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path rebase-merge") {
        return { stdout: ".git/rebase-merge\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path CHERRY_PICK_HEAD") {
        return { stdout: ".git/CHERRY_PICK_HEAD\n", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") ===
        "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
      ) {
        return {
          stdout: JSON.stringify({
            number: 123,
            isDraft: false,
            title: "PR title",
            url: "https://example.com/pr/123",
            reviewDecision: "APPROVED",
            mergeable: "MERGEABLE",
            reviews: [{ state: "APPROVED" }, { state: "COMMENTED" }],
            statusCheckRollup: { state: "SUCCESS" },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = repoStatus("/repo", { includeGitDetails: true, fetch: false }, runner);
    expect(summary.operation).toBe("none");
    expect(summary.local.clean).toBe(false);
    expect(summary.remote.freshness).toBe("stale");
    expect(summary.remote.fetch_required).toBe(true);
    expect(summary.pr).toMatchObject({
      exists: true,
      number: 123,
      checks: "green",
      review: "approved",
      approvals: 1,
      mergeable: "mergeable",
    });
  });

  test("marks remote freshness unknown when fetch dry-run errors", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
        return {
          stdout: "## main...origin/main\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo fetch --dry-run origin") {
        return { stdout: "", stderr: "network error", status: 1 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path MERGE_HEAD") {
        return { stdout: ".git/MERGE_HEAD\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path rebase-apply") {
        return { stdout: ".git/rebase-apply\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path rebase-merge") {
        return { stdout: ".git/rebase-merge\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo rev-parse --git-path CHERRY_PICK_HEAD") {
        return { stdout: ".git/CHERRY_PICK_HEAD\n", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") ===
        "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
      ) {
        return { stdout: "", stderr: "no pr", status: 1 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = repoStatus("/repo", { includeGitDetails: false }, runner);
    expect(summary.remote.freshness).toBe("unknown");
    expect(summary.remote.fetch_status).toBe("error");
    expect(summary.pr.exists).toBe(false);
  });
});

describe("board-status", () => {
  test("derives board columns from artifacts", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout:
            "worktree /repo/wt1\nHEAD aaa111\nbranch refs/heads/GH-1001\n\n" +
            "worktree /repo/wt2\nHEAD bbb222\nbranch refs/heads/GH-1002\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo/wt1 status --porcelain=v1 -b") {
        return { stdout: "## GH-1001...origin/GH-1001\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo/wt2 status --porcelain=v1 -b") {
        return { stdout: "## GH-1002...origin/GH-1002\n M x.rb\n", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return {
          stdout: JSON.stringify([
            {
              number: 10,
              headRefName: "GH-1001",
              title: "Feature",
              isDraft: false,
              url: "https://example.com/10",
              reviewDecision: "APPROVED",
              statusCheckRollup: { state: "SUCCESS" },
              mergeable: "MERGEABLE",
              reviews: [{ state: "APPROVED" }],
            },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo fetch --dry-run origin") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = boardStatus("/repo", runner);
    expect(summary.repo).toBe("owner/repo");
    expect(summary.remote_freshness).toBe("fresh");
    expect(summary.units).toHaveLength(2);
    expect(summary.units.find((unit) => unit.branch === "GH-1001")).toMatchObject({
      ticket: "GH-1001",
      column: "merge_ready",
      pr: {
        exists: true,
      },
    });
    expect(summary.units.find((unit) => unit.branch === "GH-1002")).toMatchObject({
      ticket: "GH-1002",
      column: "committing",
      pr: {
        exists: false,
      },
    });
  });

  test("tolerates null branch values from wt output", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout: "worktree /repo\nHEAD ccc333\ndetached\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
        return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
      }
      if (
        cmd.join(" ") ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo fetch --dry-run origin") {
        return { stdout: "", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = boardStatus("/repo", runner);
    expect(summary.units).toHaveLength(1);
    expect(summary.units[0]?.branch).toBe("MAIN");
    expect(summary.units[0]?.ticket).toBeNull();
  });

  test("adds remote-only open prs when remote mode is enabled", () => {
    const runner: CommandRunner = (cmd, options) => {
      const rendered = cmd.join(" ");
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout: "worktree /repo\nHEAD ddd444\nbranch refs/heads/main\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
        return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return {
          stdout: JSON.stringify([
            {
              number: 12,
              headRefName: "GH-185",
              title: "Security review",
              isDraft: false,
              url: "https://example.com/12",
              reviewDecision: "REVIEW_REQUIRED",
              statusCheckRollup: { state: "PENDING" },
              mergeable: "MERGEABLE",
              reviews: [],
            },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (
        rendered ===
        "gh pr list --state all --head main --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === "gh issue view 185 --json number,state -R owner/repo") {
        return { stdout: JSON.stringify({ number: 185, state: "OPEN" }), stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  projectItems: {
                    nodes: [{ id: "PVTI_123" }],
                  },
                },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo branch --list -r") {
        return {
          stdout: "  origin/HEAD -> origin/main\n  origin/GH-185\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo branch --format=%(refname:short)") {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo show-ref --verify --quiet refs/heads/main") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo show-ref --verify --quiet refs/heads/GH-185") {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...origin/main") {
        return { stdout: "0\t0\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...refs/heads/main") {
        return { stdout: "0\t0\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...origin/GH-185") {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...refs/heads/GH-185") {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (cmd.join(" ") === "git -C /repo fetch --dry-run origin") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered.includes("rev-list --left-right --count origin/main...local/")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = boardStatus("/repo", { remote: true }, runner);
    expect(summary.units).toHaveLength(2);
    expect(summary.units.find((unit) => unit.branch === "GH-185")).toMatchObject({
      ticket: "GH-185",
      worktree_path: null,
      column: "no_worktree",
      pr: {
        exists: true,
        number: 12,
      },
      status: {
        remote: {
          gh_issue: "dirty",
          beads_issue: "clean",
          project_item: "dirty",
          merge_state: "open",
          ci: "running",
        },
      },
    });
  });

  test("hydrates beads issue status from local task contract when remote mode is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-board-beads-"));
    const worktree = join(root, "GH-190");
    mkdirSync(join(worktree, ".pr", "local"), { recursive: true });
    writeTaskContract(
      join(worktree, ".pr", "local", "task.json"),
      createTaskContract({
        workUnitId: "GH-190",
        worktree,
        beadId: "BEAD-190",
      }),
    );

    const runner: CommandRunner = (cmd, options) => {
      const rendered = cmd.join(" ");
      if (rendered === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} worktree list --porcelain`) {
        return {
          stdout: `worktree ${worktree}\nHEAD eee555\nbranch refs/heads/GH-190\n\n`,
          stderr: "",
          status: 0,
        };
      }
      if (rendered === `git -C ${worktree} status --porcelain=v1 -b`) {
        return { stdout: "## GH-190...origin/GH-190\n", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === "gh issue view 190 --json number,state -R owner/repo") {
        return { stdout: JSON.stringify({ number: 190, state: "OPEN" }), stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  projectItems: {
                    nodes: [],
                  },
                },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      if (rendered === `bd show BEAD-190 --json`) {
        return { stdout: JSON.stringify({ id: "BEAD-190", status: "in_progress" }), stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --list -r`) {
        return { stdout: "  origin/GH-190\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --format=%(refname:short)`) {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} show-ref --verify --quiet refs/heads/GH-190`) {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...origin/GH-190`) {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...refs/heads/GH-190`) {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} fetch --dry-run origin`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state all --head GH-190 --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered.includes("rev-list --left-right --count origin/main...local/")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`Unexpected command: ${rendered}`);
    };

    const summary = boardStatus(root, { remote: true }, runner);
    expect(summary.units[0]).toMatchObject({
      ticket: "GH-190",
      beadId: "BEAD-190",
      status: {
        remote: {
          gh_issue: "dirty",
          beads_issue: "dirty",
          project_item: "clean",
          branch: "dirty",
          pr: "clean",
          merge_state: "clean",
          ci: "unknown",
          problem: "no",
        },
      },
    });
  });

  test("adds remote-only branches with no open pr when remote mode is enabled", () => {
    const runner: CommandRunner = (cmd, options) => {
      const rendered = cmd.join(" ");
      if (cmd.join(" ") === "git -C /repo rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd.join(" ") === "git -C /repo worktree list --porcelain") {
        return {
          stdout: "worktree /repo\nHEAD fff666\nbranch refs/heads/main\n\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo status --porcelain=v1 -b") {
        return { stdout: "## main...origin/main\n", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return {
          stdout: JSON.stringify([]),
          stderr: "",
          status: 0,
        };
      }
      if (
        rendered ===
        "gh pr list --state all --head GH-172 --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return {
          stdout: JSON.stringify([
            {
              number: 187,
              state: "MERGED",
              isDraft: false,
              title: "Protect active worktrees during prx work",
              url: "https://example.com/187",
              headRefName: "GH-172",
            },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (
        rendered ===
        "gh pr list --state all --head main --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state all --head copilot/sub-pr-187 --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === "gh issue view 172 --json number,state -R owner/repo") {
        return { stdout: JSON.stringify({ number: 172, state: "CLOSED" }), stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  projectItems: {
                    nodes: [],
                  },
                },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo branch --list -r") {
        return {
          stdout: "  origin/GH-172\n  origin/main\n  origin/copilot/sub-pr-187\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "git -C /repo branch --format=%(refname:short)") {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo show-ref --verify --quiet refs/heads/main") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo show-ref --verify --quiet refs/heads/GH-172") {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === "git -C /repo show-ref --verify --quiet refs/heads/copilot/sub-pr-187") {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...origin/main") {
        return { stdout: "0\t0\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...refs/heads/main") {
        return { stdout: "0\t0\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...origin/GH-172") {
        return { stdout: "1\t6\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...refs/heads/GH-172") {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...origin/copilot/sub-pr-187") {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      if (rendered === "git -C /repo rev-list --left-right --count origin/main...refs/heads/copilot/sub-pr-187") {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (cmd.join(" ") === "git -C /repo fetch --dry-run origin") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered.includes("rev-list --left-right --count origin/main...local/")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const summary = boardStatus("/repo", { remote: true }, runner);
    expect(summary.units.find((unit) => unit.branch === "GH-172")).toMatchObject({
      ticket: "GH-172",
      worktree_path: null,
      column: "no_worktree",
      pr: {
        exists: false,
      },
      status: {
        remote: {
          gh_issue: "completed",
          beads_issue: "clean",
          project_item: "clean",
          branch: "dirty",
          pr: "completed",
          merge_state: "merged",
          ci: "unknown",
          problem: "yes",
        },
        local: {
          branch: "clean",
          worktree: "clean",
          dir: "missing",
          problem: "no",
        },
      },
    });
    expect(summary.units.find((unit) => unit.branch === "copilot/sub-pr-187")).toMatchObject({
      ticket: null,
      worktree_path: null,
      column: "no_worktree",
      pr: {
        exists: false,
      },
    });
    expect(summary.units.find((unit) => unit.branch === "main")).toBeDefined();
  });

  test("GH-2306: targetBranch scopes remote hydration to a single unit", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-board-target-"));
    const wt100 = join(root, "GH-100");
    const wt200 = join(root, "GH-200");

    const invoked: string[] = [];
    const runner: CommandRunner = (cmd) => {
      const rendered = cmd.join(" ");
      invoked.push(rendered);
      if (rendered === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} worktree list --porcelain`) {
        return {
          stdout:
            `worktree ${wt100}\nHEAD aaa111\nbranch refs/heads/GH-100\n\n` +
            `worktree ${wt200}\nHEAD bbb222\nbranch refs/heads/GH-200\n\n`,
          stderr: "",
          status: 0,
        };
      }
      if (rendered === `git -C ${wt100} status --porcelain=v1 -b`) {
        return { stdout: "## GH-100...origin/GH-100\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${wt200} status --porcelain=v1 -b`) {
        return { stdout: "## GH-200...origin/GH-200\n", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} fetch --dry-run origin`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --list -r`) {
        return { stdout: "  origin/GH-100\n  origin/GH-200\n  origin/main\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --format=%(refname:short)`) {
        return { stdout: "main\nGH-100\nGH-200\n", stderr: "", status: 0 };
      }
      // --- Target (GH-100) remote/local probes — these are expected to fire ---
      if (rendered === "gh issue view 100 --json number,state -R owner/repo") {
        return { stdout: JSON.stringify({ number: 100, state: "OPEN" }), stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }),
          stderr: "",
          status: 0,
        };
      }
      if (
        rendered ===
        "gh pr list --state all --head GH-100 --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...origin/GH-100`) {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...local/GH-100`) {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === `git -C ${root} show-ref --verify --quiet refs/heads/GH-100`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...refs/heads/GH-100`) {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      // GH-914 authorship gate reads (safeRun-wrapped; tolerate by throwing).
      throw new Error(`Unexpected command: ${rendered}`);
    };

    const summary = boardStatus(root, { remote: true, targetBranch: "GH-100" }, runner);

    // Both worktree units are still enumerated — scoping only suppresses the
    // per-unit remote/local probes, not unit existence.
    expect(summary.units).toHaveLength(2);
    const target = summary.units.find((unit) => unit.branch === "GH-100");
    const other = summary.units.find((unit) => unit.branch === "GH-200");
    expect(target?.status).toBeDefined();
    expect(target?.status?.remote.gh_issue).toBe("dirty");
    // The non-target unit is left un-hydrated.
    expect(other).toBeDefined();
    expect(other?.status).toBeUndefined();

    // Positive: the target's remote probe did fire.
    expect(invoked.some((c) => c === "gh issue view 100 --json number,state -R owner/repo")).toBe(true);
    // Zero fanout: no remote/local probe touched the non-target branch.
    expect(invoked.some((c) => c.includes("gh issue view 200"))).toBe(false);
    expect(invoked.some((c) => c.includes("--head GH-200"))).toBe(false);
    expect(invoked.some((c) => c.includes("origin/GH-200"))).toBe(false);
    expect(invoked.some((c) => c.includes("local/GH-200"))).toBe(false);
    expect(invoked.some((c) => c.includes("refs/heads/GH-200"))).toBe(false);
  });

  test("loads parity-chain feature toggles from prx.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-parity-config-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = false",
        "beads_issue = true",
        "project_item = false",
        "merge_state = false",
        "ci = true",
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(loadSurfaceSyncConfig(root, runner)).toEqual({
      features: {
        gh_issue: false,
        beads_issue: true,
        project_item: false,
        merge_state: false,
        ci: true,
      },
    });
  });

  test("buildParityChain uses configured worktree manager for create_worktree actions", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-parity-worktree-manager-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[worktree]",
        'manager = "wt"',
        'command = "/opt/homebrew/bin/wt"',
        "",
        "[parity_chain]",
        "gh_issue = false",
        "beads_issue = false",
        "project_item = false",
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd, options) => {
      const rendered = cmd.join(" ");
      if (rendered === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} worktree list --porcelain`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state all --head GH-220 --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} fetch --dry-run origin`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --list -r`) {
        return { stdout: "  origin/GH-220\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --format=%(refname:short)`) {
        return { stdout: "main\nGH-220\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} show-ref --verify --quiet refs/heads/GH-220`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...refs/heads/GH-220`) {
        return { stdout: "0 1\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...origin/GH-220`) {
        return { stdout: "", stderr: "fatal: bad revision", status: 128 };
      }
      if (rendered.includes("rev-list --left-right --count origin/main...local/")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`Unexpected command: ${rendered}`);
    };

    expect(
      buildParityChain(root, { mode: "backfill", authority: "local", scope: "local" }, runner),
    ).toMatchObject({
      actions: [
        {
          type: "create_worktree",
          branch: "GH-220",
          ticket: "GH-220",
        },
      ],
    });
  });

  test("loads prefix routing config from prx.toml with GH fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-routing-config-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[routing]",
        'BEAD = "beads_issue"',
        'OPS = "gh_issue" # explicit route',
        'SHIP = "project_item" # ignored: not an issue authority',
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const routing = loadPrefixRoutingConfig(root, runner);
    expect(routing).toEqual({
      features: {
        GH: "gh_issue",
        BEAD: "beads_issue",
        OPS: "gh_issue",
      },
    });
    expect(resolveFeatureForPrefix("GH-224", routing)).toBe("gh_issue");
    expect(resolveFeatureForPrefix("BEAD-12", routing)).toBe("beads_issue");
    expect(resolveFeatureForPrefix("SHIP-7", routing)).toBeNull();
    expect(resolveFeatureForPrefix("feature/test", routing)).toBeNull();
    // GH-1766: bd surface ids always route to beads_issue, independent of
    // any prx.toml [routing] table. The canonical axis is encoded in the
    // id shape itself; routing config is for legacy prefixes only.
    expect(resolveFeatureForPrefix("BD-407F177F", routing)).toBe("beads_issue");
    expect(resolveFeatureForPrefix("BD-407f177f", routing)).toBe("beads_issue");
    expect(
      resolveFeatureForPrefix("BD-ai-home-1778515181936-7-edba9d4a", routing),
    ).toBe("beads_issue");
  });

  test("loads github project config from prx.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-project-config-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[project]",
        'owner = "bdelanghe"',
        "number = 1",
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(loadGithubProjectConfig(root, runner)).toEqual({
      owner: "bdelanghe",
      number: 1,
    });
  });

  test("loadGithubProjectConfig returns nulls when prx.toml has no project section", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-project-config-missing-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[worktree]", 'manager = "wt"', ""].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(loadGithubProjectConfig(root, runner)).toEqual({
      owner: null,
      number: null,
    });
  });

  test("loadGithubProjectConfig ignores invalid number values", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-project-config-invalid-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[project]",
        'owner = "bdelanghe"',
        "number = notanumber",
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(loadGithubProjectConfig(root, runner)).toEqual({
      owner: "bdelanghe",
      number: null,
    });
  });

  // GH-1421: [sources.<name>] registry loader tests. Legacy [identity] /
  // [identity.notion] shapes are no longer recognised — the loader hard-fails
  // when it sees them (strict migration; the ai-home overlay coordination PR
  // ships first, then this PR).

  test("loadIdentityConfig synthesizes a default GH source when prx.toml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-missing-"));
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(config.isDefault).toBe(true);
    expect(config.defaultSourceName).toBe("github");
    const effective = effectiveCanonicalIdPattern(config);
    expect(effective.test("GH-123")).toBe(true);
    expect(effective.test("NOTION-34c8ff3a891d80d2a378e3bd4469958c")).toBe(true);
    expect(effective.test("PROD-6688")).toBe(false);
  });

  test("loadIdentityConfig synthesizes a default when no [sources.*] section is present", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-absent-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[worktree]", 'manager = "wt"', ""].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(config.isDefault).toBe(true);
    expect(effectiveCanonicalIdPattern(config).test("GH-123")).toBe(true);
  });

  test("loadIdentityConfig hard-fails on legacy [identity] section", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-legacy-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[identity]",
        'canonical_id_pattern = "^(GH|PROD)-\\\\d+$"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /\[identity\] is no longer supported \(GH-1421\)/,
    );
  });

  test("loadIdentityConfig hard-fails on legacy [identity.notion] section", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-legacy-notion-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[identity.notion]",
        'auth = "rest"',
        'database_id = "db"',
        'id_property = "ID"',
        'title_property = "Name"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /\[identity\.notion\] is no longer supported \(GH-1421\)/,
    );
  });

  test("loadIdentityConfig compiles a [sources.github] block", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-sources-github-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.github]",
        'kind = "github"',
        'canonical_id_pattern = "^(GH|PROD)-\\\\d+$"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(config.isDefault).toBe(false);
    expect(config.defaultSourceName).toBe("github");
    const effective = effectiveCanonicalIdPattern(config);
    expect(effective.test("GH-123")).toBe(true);
    expect(effective.test("PROD-6688")).toBe(true);
    expect(effective.test("RANDOM-1")).toBe(false);
  });

  test("loadIdentityConfig throws a clear error on a malformed canonical_id_pattern regex", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-bad-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.github]",
        'kind = "github"',
        'canonical_id_pattern = "^(GH|PROD"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /\[sources\.github\] canonical_id_pattern is not a valid regex/,
    );
  });

  test("loadIdentityConfig throws when kind is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-no-kind-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[sources.github]", 'canonical_id_pattern = "^GH-\\\\d+$"', ""].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    expect(() => loadIdentityConfig(root, runner)).toThrow(/kind is required/);
  });

  test("loadIdentityConfig throws when kind is unknown", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-bad-kind-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.gitlab]",
        'kind = "gitlab"',
        'canonical_id_pattern = "^GL-\\\\d+$"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /kind must be one of github, notion, beads/,
    );
  });

  test("loadIdentityConfig rejects kind = \"dolt\" pointing at GH-852", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-dolt-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.dolt]",
        'kind = "dolt"',
        'canonical_id_pattern = "^DOLT-\\\\d+$"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    expect(() => loadIdentityConfig(root, runner)).toThrow(/GH-852/);
  });

  test("loadIdentityConfig synthesizes a default when cwd is not inside a git repo", () => {
    const bogusRoot = mkdtempSync(join(tmpdir(), "pr-state-identity-nogit-"));
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${bogusRoot} rev-parse --show-toplevel`) {
        throw new Error("not a git repository");
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(bogusRoot, runner);
    expect(config.isDefault).toBe(true);
    expect(findFirstSourceOfKind(config, "notion")).toBeNull();
  });

  test("loadIdentityConfig parses a notion source alongside a github source", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.github]",
        'kind = "github"',
        'canonical_id_pattern = "^GH-\\\\d+$"',
        "",
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'auth = "rest"',
        'database_id = "abc-123"',
        'id_property = "ID"',
        'title_property = "Name"',
        'status_property = "Status"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    const effective = effectiveCanonicalIdPattern(config);
    expect(effective.test("GH-1")).toBe(true);
    expect(effective.test("PROJECT-6688")).toBe(true);
    const notion = findFirstSourceOfKind(config, "notion");
    expect(notion?.notion).toEqual({
      auth: "rest",
      databaseId: "abc-123",
      idProperty: "ID",
      titleProperty: "Name",
      statusProperty: "Status",
      tokenOpRef: null,
      closedStatuses: [],
    });
  });

  test("loadIdentityConfig accepts a notion-only registry without a github source", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-only-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'database_id = "db"',
        'id_property = "ID"',
        'title_property = "Name"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(config.isDefault).toBe(false);
    expect(findFirstSourceOfKind(config, "notion")?.notion.statusProperty).toBeNull();
  });

  test("loadIdentityConfig throws when [sources.notion] is missing a required key", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-missing-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'database_id = "db"',
        'title_property = "Name"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /id_property is required when auth = "rest"/,
    );
  });

  test("loadIdentityConfig accepts notion source with auth = \"claude-mcp\" and no other keys", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-claude-mcp-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'auth = "claude-mcp"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(findFirstSourceOfKind(config, "notion")?.notion).toEqual({
      auth: "claude-mcp",
      databaseId: null,
      idProperty: null,
      titleProperty: null,
      statusProperty: null,
      tokenOpRef: null,
      closedStatuses: [],
    });
  });

  test("loadIdentityConfig throws on unknown auth value", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-bad-auth-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'auth = "oauth2"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /auth must be "rest", "claude-mcp", or "notion-cli"/,
    );
  });

  test("loadIdentityConfig accepts notion source with auth = \"notion-cli\" and no other keys", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-cli-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJ-\\\\d+$"',
        'auth = "notion-cli"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(findFirstSourceOfKind(config, "notion")?.notion).toEqual({
      auth: "notion-cli",
      databaseId: null,
      idProperty: null,
      titleProperty: null,
      statusProperty: null,
      tokenOpRef: null,
      closedStatuses: [],
    });
  });

  test("loadIdentityConfig parses closed_statuses into a trimmed list (notion-cli)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-closed-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJ-\\\\d+$"',
        'auth = "notion-cli"',
        'id_property = "Task ID"',
        'status_property = "Status"',
        'closed_statuses = "Completed, DNF - Did not Complete"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    const notion = findFirstSourceOfKind(config, "notion")?.notion;
    expect(notion?.idProperty).toBe("Task ID");
    expect(notion?.statusProperty).toBe("Status");
    expect(notion?.closedStatuses).toEqual(["Completed", "DNF - Did not Complete"]);
  });

  test("loadIdentityConfig defaults auth to \"rest\" when absent (back-compat)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-default-auth-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'database_id = "db"',
        'id_property = "ID"',
        'title_property = "Name"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(findFirstSourceOfKind(config, "notion")?.notion.auth).toBe("rest");
  });

  test("loadIdentityConfig parses notion token_op_ref", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-op-ref-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'auth = "claude-mcp"',
        'token_op_ref = "op://Bounded Systems/Notion - internal integration/token"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const config = loadIdentityConfig(root, runner);
    expect(findFirstSourceOfKind(config, "notion")?.notion.tokenOpRef).toBe(
      "op://Bounded Systems/Notion - internal integration/token",
    );
  });

  test("loadIdentityConfig rejects malformed token_op_ref", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-bad-op-ref-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'auth = "claude-mcp"',
        'token_op_ref = "secrets://vault/item/field"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /token_op_ref must be an op:\/\/ URI/,
    );
  });

  test("loadIdentityConfig rejects token_op_ref with too few segments", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-identity-notion-short-op-ref-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.notion]",
        'kind = "notion"',
        'canonical_id_pattern = "^PROJECT-\\\\d+$"',
        'auth = "claude-mcp"',
        'token_op_ref = "op://vault/item"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(() => loadIdentityConfig(root, runner)).toThrow(
      /token_op_ref must be an op:\/\/ URI/,
    );
  });

  describe("loadIdentityConfig ai-home overlay (GH-664)", () => {
    function makeRunner(
      repoRoot: string,
      origin: string | null,
    ): CommandRunner {
      const topLevelCmd = `git -C ${repoRoot} rev-parse --show-toplevel`;
      const remoteCmd = `git -C ${repoRoot} remote get-url origin`;
      return (cmd) => {
        const key = cmd.join(" ");
        if (key === topLevelCmd) {
          return { stdout: `${repoRoot}\n`, stderr: "", status: 0 };
        }
        if (key === remoteCmd) {
          if (origin === null) {
            return { stdout: "", stderr: "no origin", status: 128 };
          }
          return { stdout: `${origin}\n`, stderr: "", status: 0 };
        }
        throw new Error(`Unexpected command: ${key}`);
      };
    }

    // Sets the operator-config root via PRX_OPERATOR_CONFIG_ROOT, clearing the
    // baked var too so an operator env can't leak into the test.
    function withOverlayRoot(overlayRoot: string | null, fn: () => void): void {
      const snap: Record<string, string | undefined> = {};
      for (const k of ["PRX_OPERATOR_CONFIG_ROOT", "BAKED_OPERATOR_CONFIG_ROOT"]) {
        snap[k] = process.env[k];
        delete process.env[k];
      }
      if (overlayRoot !== null) {
        process.env.PRX_OPERATOR_CONFIG_ROOT = overlayRoot;
      }
      try {
        fn();
      } finally {
        for (const [k, v] of Object.entries(snap)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    function writeOverlay(
      aiHome: string,
      owner: string,
      repo: string,
      body: string,
    ): string {
      const dir = join(aiHome, ".prx", "repos", "io.github", owner, repo);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "prx.toml");
      writeFileSync(path, body);
      return path;
    }

    test("skips overlay when PRX_OPERATOR_CONFIG_ROOT points at an empty tree", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-nofile-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-empty-"));
      writeFileSync(
        join(root, "prx.toml"),
        [
          "[sources.github]",
          'kind = "github"',
          'canonical_id_pattern = "^(GH|PROJECT)-\\\\d+$"',
          "",
        ].join("\n"),
      );
      const runner = makeRunner(root, "git@github.com:bdelanghe/ai-home.git");

      withOverlayRoot(aiHome, () => {
        const config = loadIdentityConfig(root, runner);
        expect(effectiveCanonicalIdPattern(config).test("PROJECT-1")).toBe(true);
        expect(findFirstSourceOfKind(config, "notion")).toBeNull();
      });
    });

    test("overlay-only: repo-root prx.toml missing, overlay supplies sources", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-only-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-overlay-only-"));
      writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.github]",
        'kind = "github"',
        "canonical_id_pattern = '^(GH-\\d+|PROD-\\d+)$'",
        "",
        "[sources.notion]",
        'kind = "notion"',
        "canonical_id_pattern = '^PROD-\\d+$'",
        'auth = "claude-mcp"',
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        const config = loadIdentityConfig(root, runner);
        expect(config.isDefault).toBe(false);
        const effective = effectiveCanonicalIdPattern(config);
        expect(effective.test("PROD-6667")).toBe(true);
        expect(effective.test("GH-42")).toBe(true);
        expect(findFirstSourceOfKind(config, "notion")?.notion).toEqual({
          auth: "claude-mcp",
          databaseId: null,
          idProperty: null,
          titleProperty: null,
          statusProperty: null,
          tokenOpRef: null,
          closedStatuses: [],
        });
      });
    });

    test("overlay [sources.<name>] replaces base outright (no per-key merge)", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-merge-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-merge-"));
      writeFileSync(
        join(root, "prx.toml"),
        [
          "[sources.notion]",
          'kind = "notion"',
          'canonical_id_pattern = "^(GH|PROJECT)-\\\\d+$"',
          'auth = "rest"',
          'database_id = "db-xyz"',
          'id_property = "ID"',
          'title_property = "Name"',
          'status_property = "Status"',
          "",
        ].join("\n"),
      );
      writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.notion]",
        'kind = "notion"',
        "canonical_id_pattern = '^(GH|PROJECT)-\\d+$'",
        'auth = "claude-mcp"',
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        const config = loadIdentityConfig(root, runner);
        expect(effectiveCanonicalIdPattern(config).test("PROJECT-9")).toBe(true);
        // Overlay replaces wholesale — base's database_id is gone.
        expect(findFirstSourceOfKind(config, "notion")?.notion).toEqual({
          auth: "claude-mcp",
          databaseId: null,
          idProperty: null,
          titleProperty: null,
          statusProperty: null,
          tokenOpRef: null,
          closedStatuses: [],
        });
      });
    });

    test("reverse-DNS layout: overlay under io.github/<owner>/<repo>/, not flat repo-name", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-layout-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-layout-"));

      const flatDir = join(aiHome, ".prx", "repos", "demo-web");
      mkdirSync(flatDir, { recursive: true });
      writeFileSync(
        join(flatDir, "prx.toml"),
        [
          "[sources.github]",
          'kind = "github"',
          'canonical_id_pattern = "^FLAT-\\\\d+$"',
          "",
        ].join("\n"),
      );

      writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.github]",
        'kind = "github"',
        "canonical_id_pattern = '^RDNS-\\d+$'",
        "",
      ].join("\n"));

      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        const config = loadIdentityConfig(root, runner);
        const effective = effectiveCanonicalIdPattern(config);
        expect(effective.test("RDNS-1")).toBe(true);
        expect(effective.test("FLAT-1")).toBe(false);
      });
    });

    test("overlay parse error surfaces the overlay path, not just 'prx.toml'", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-bad-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-bad-"));
      const overlayPath = writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.github]",
        'kind = "github"',
        "canonical_id_pattern = 42",
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        expect(() => loadIdentityConfig(root, runner)).toThrow(
          new RegExp(`must be a TOML string.*${overlayPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${overlayPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*must be a TOML string`),
        );
      });
    });

    test("BAKED_OPERATOR_CONFIG_ROOT used when PRX_OPERATOR_CONFIG_ROOT is absent", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-baked-"));
      const baked = mkdtempSync(join(tmpdir(), "pr-state-identity-baked-"));
      writeOverlay(baked, "demo", "demo-web", [
        "[sources.github]",
        'kind = "github"',
        "canonical_id_pattern = '^BAKED-\\d+$'",
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      const snap: Record<string, string | undefined> = {};
      for (const k of ["PRX_OPERATOR_CONFIG_ROOT", "BAKED_OPERATOR_CONFIG_ROOT"]) {
        snap[k] = process.env[k];
        delete process.env[k];
      }
      process.env.BAKED_OPERATOR_CONFIG_ROOT = baked;
      try {
        const config = loadIdentityConfig(root, runner);
        expect(effectiveCanonicalIdPattern(config).test("BAKED-42")).toBe(true);
      } finally {
        for (const [k, v] of Object.entries(snap)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    test("no overlay when origin is not a GitHub remote", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-non-gh-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-non-gh-"));
      writeFileSync(
        join(root, "prx.toml"),
        [
          "[sources.github]",
          'kind = "github"',
          'canonical_id_pattern = "^BASE-\\\\d+$"',
          "",
        ].join("\n"),
      );
      writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.github]",
        'kind = "github"',
        "canonical_id_pattern = '^OVERLAY-\\d+$'",
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@gitlab.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        const config = loadIdentityConfig(root, runner);
        const effective = effectiveCanonicalIdPattern(config);
        expect(effective.test("BASE-1")).toBe(true);
        expect(effective.test("OVERLAY-1")).toBe(false);
      });
    });

    test("overlay path-traversal defense: origin segments with `..` / extra segments are rejected", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-traversal-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-traversal-"));
      writeFileSync(
        join(root, "prx.toml"),
        [
          "[sources.github]",
          'kind = "github"',
          'canonical_id_pattern = "^BASE-\\\\d+$"',
          "",
        ].join("\n"),
      );

      const badOrigins = [
        "git@github.com:foo/..",
        "https://github.com/owner/repo/tree/main",
        "https://github.com/just-owner",
      ];

      withOverlayRoot(aiHome, () => {
        for (const origin of badOrigins) {
          const runner = makeRunner(root, origin);
          const config = loadIdentityConfig(root, runner);
          expect(effectiveCanonicalIdPattern(config).test("BASE-1")).toBe(true);
        }
      });
    });

    test("validation errors cite the overlay path when the bad value comes from the overlay", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-attrib-regex-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-attrib-regex-"));
      const overlayPath = writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.github]",
        'kind = "github"',
        "canonical_id_pattern = '^(GH|PROD'",
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        expect(() => loadIdentityConfig(root, runner)).toThrow(
          new RegExp(`is not a valid regex.*\\(at ${overlayPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
        );
      });
    });

    test("'required when auth = rest' error cites the overlay when overlay declares the section", () => {
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-overlay-attrib-required-"));
      const aiHome = mkdtempSync(join(tmpdir(), "pr-state-identity-aihome-attrib-required-"));
      const overlayPath = writeOverlay(aiHome, "demo", "demo-web", [
        "[sources.notion]",
        'kind = "notion"',
        "canonical_id_pattern = '^PROJECT-\\d+$'",
        'database_id = "db"',
        "",
      ].join("\n"));
      const runner = makeRunner(root, "git@github.com:demo/demo-web.git");

      withOverlayRoot(aiHome, () => {
        expect(() => loadIdentityConfig(root, runner)).toThrow(
          new RegExp(`id_property is required when auth = "rest" \\(at ${overlayPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
        );
      });
    });
  });

  test("buildParityChain shell-escapes git create_worktree commands", () => {
    const rootBase = mkdtempSync(join(tmpdir(), "pr-state parity git-"));
    const root = join(rootBase, "repo");
    mkdirSync(root);
    const branch = "feature/it's-ready";
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[worktree]",
        'manager = "git"',
        "",
        "[parity_chain]",
        "gh_issue = false",
        "beads_issue = false",
        "project_item = false",
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd, options) => {
      const rendered = cmd.join(" ");
      if (rendered === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} worktree list --porcelain`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (
        rendered
        === `gh pr list --state all --head ${branch} --limit 1 --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo`
      ) {
        return { stdout: "[]", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} fetch --dry-run origin`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --list -r`) {
        return { stdout: `  origin/${branch}\n`, stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --format=%(refname:short)`) {
        return { stdout: `main\n${branch}\n`, stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} show-ref --verify --quiet refs/heads/${branch}`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...refs/heads/${branch}`) {
        return { stdout: "0 1\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...origin/${branch}`) {
        return { stdout: "", stderr: "fatal: bad revision", status: 128 };
      }
      if (rendered.includes("rev-list --left-right --count origin/main...local/")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`Unexpected command: ${rendered}`);
    };

    expect(
      buildParityChain(root, { mode: "backfill", authority: "local", scope: "local" }, runner),
    ).toMatchObject({
      actions: [
        {
          type: "create_worktree",
          branch,
          ticket: null,
        },
      ],
    });
  });

  test("buildParityChain shell-escapes branch names across action commands", () => {
    const rootBase = mkdtempSync(join(tmpdir(), "pr-state-shell-escape-actions-"));
    const root = join(rootBase, "repo");
    mkdirSync(root);
    const branch = "feature/it's-ready";
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[worktree]",
        'manager = "git"',
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: null,
            branch,
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: true, pr: false, ticket: false },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "clean",
                beads_issue: "clean",
                project_item: "clean",
                branch: "dirty",
                pr: "clean",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "no worktree",
                problem: "no",
              },
            },
            column: "pushed",
            reasons: [],
          },
        ],
      },
      { mode: "full", authority: "local", scope: "all" },
      runner,
    );

    expect(result.actions).toEqual([
      {
        type: "delete_remote_branch",
        remote: "origin",
        branch,
        ticket: null,
        reason: "Remote branch has no issue or PR authority",
      },
      {
        type: "create_worktree",
        branch,
        ticket: null,
        reason: "Local branch exists but no worktree is attached",
      },
      {
        type: "open_pr",
        branch,
        ticket: null,
        reason: "Remote branch exists without an open PR",
      },
    ]);
  });

  test("buildParityChain routes issue authority by work-unit prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-routing-parity-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[routing]",
        'GH = "gh_issue"',
        'BEAD = "beads_issue"',
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-224",
            branch: "GH-224",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "dirty",
                beads_issue: "clean",
                project_item: "clean",
                branch: "missing",
                pr: "clean",
                merge_state: "clean",
                ci: "unknown",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "missing",
                problem: "no",
              },
            },
            column: "no_worktree",
            reasons: [],
          },
          {
            ticket: "BEAD-5",
            beadId: "BEAD-5",
            branch: "BEAD-5",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "clean",
                beads_issue: "dirty",
                project_item: "clean",
                branch: "missing",
                pr: "clean",
                merge_state: "clean",
                ci: "unknown",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "missing",
                problem: "no",
              },
            },
            column: "no_worktree",
            reasons: [],
          },
        ],
      },
      { mode: "backfill", authority: "issue", scope: "all" },
      runner,
    );

    expect(result.units.find((unit) => unit.branch === "GH-224")?.actions).toEqual([
      {
        type: "create_local_branch",
        branch: "GH-224",
        ticket: "GH-224",
        reason: "Issue exists but local branch is missing",
      },
    ]);
    expect(result.units.find((unit) => unit.branch === "BEAD-5")?.actions).toEqual([
      {
        type: "create_local_branch",
        branch: "BEAD-5",
        ticket: "BEAD-5",
        reason: "Issue exists but local branch is missing",
      },
    ]);
  });

  test("buildParityChain --ticket scopes plan to a single work unit (GH-460)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-ticket-filter-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[routing]",
        'GH = "gh_issue"',
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const board: BoardStatusResult = {
      source: "derived-board",
      repo: "owner/repo",
      remote_freshness: "fresh",
      units: [
        {
          ticket: "GH-405",
          branch: "GH-405",
          worktree_path: null,
          pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
          artifacts: { worktree: false, branch: false, pr: false, ticket: true },
          local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
          status: {
            remote: {
              gh_issue: "dirty",
              beads_issue: "clean",
              project_item: "clean",
              branch: "missing",
              pr: "clean",
              merge_state: "clean",
              ci: "unknown",
              problem: "no",
            },
            local: { branch: "clean", worktree: "clean", dir: "missing", problem: "no" },
          },
          column: "no_worktree",
          reasons: [],
        },
        {
          ticket: "GH-441",
          branch: "GH-441",
          worktree_path: null,
          pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
          artifacts: { worktree: false, branch: false, pr: false, ticket: true },
          local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
          status: {
            remote: {
              gh_issue: "dirty",
              beads_issue: "clean",
              project_item: "clean",
              branch: "missing",
              pr: "clean",
              merge_state: "clean",
              ci: "unknown",
              problem: "no",
            },
            local: { branch: "clean", worktree: "clean", dir: "missing", problem: "no" },
          },
          column: "no_worktree",
          reasons: [],
        },
      ],
    };

    const scoped = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "backfill", authority: "issue", scope: "all", ticket: "GH-441" },
      runner,
    );
    expect(scoped.ticket).toBe("GH-441");
    expect(scoped.units).toHaveLength(1);
    expect(scoped.units[0]?.branch).toBe("GH-441");
    expect(scoped.actions.every((action) => action.ticket === "GH-441")).toBe(true);

    const caseInsensitive = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "backfill", authority: "issue", scope: "all", ticket: "gh-441" },
      runner,
    );
    expect(caseInsensitive.ticket).toBe("GH-441");
    expect(caseInsensitive.units).toHaveLength(1);

    const unknown = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "backfill", authority: "issue", scope: "all", ticket: "GH-999" },
      runner,
    );
    expect(unknown.ticket).toBe("GH-999");
    expect(unknown.units).toHaveLength(0);
    expect(unknown.actions).toHaveLength(0);

    const unfiltered = buildSurfaceSyncFromBoard(
      root,
      board,
      { mode: "backfill", authority: "issue", scope: "all" },
      runner,
    );
    expect(unfiltered.ticket).toBeUndefined();
    expect(unfiltered.units).toHaveLength(2);
  });

  test("buildParityChain prunes orphaned local-only branches with completed PR lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-orphan-prune-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    // Simulate an orphaned local branch: no worktree, no open PR, no remote branch,
    // but a completed (merged) PR exists in the branch's history.
    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-336",
            branch: "GH-336",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: true, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: {
                branch: "dirty",
                worktree: "clean",
                dir: "no worktree",
                problem: "yes",
              },
            },
            column: "cleaned",
            reasons: ["orphaned local branch from completed PR lifecycle"],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "local" },
      runner,
    );

    expect(result.actions).toEqual([
      {
        type: "delete_local_branch",
        branch: "GH-336",
        ticket: "GH-336",
        reason: "Completed lifecycle still leaves a local branch without a worktree",
      },
    ]);
  });

  test("buildParityChain emits delete_worktree when PR merged + issue closed but worktree still present (GH-1126)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-prune-worktree-present-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-1048",
            branch: "GH-1048",
            worktree_path: `${root}/gh_1048_a8a`,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: true, branch: true, pr: false, ticket: true },
            local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "present",
                problem: "no",
              },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "local" },
      runner,
    );

    expect(result.actions).toEqual([
      {
        type: "delete_worktree",
        branch: "GH-1048",
        ticket: "GH-1048",
        reason: "PR merged and issue closed but worktree still on disk",
      },
    ]);
    expect(result.units[0]?.disposition).toBe("prune");
    // GH-2147: the clean teardown path carries no blocker.
    expect(result.units[0]?.blockers).toBeUndefined();
  });

  // GH-2147 / ai-home-rh8e9: a completed unit whose worktree is still present
  // but ineligible for delete_worktree (dirty worktree) must surface an
  // explicit blocker instead of a silent zero-action result.
  const completedPresentUnit = (
    overrides: {
      local?: Partial<{ clean: boolean; staged: number; unstaged: number; untracked: number; conflicts: number }>;
    },
  ) => ({
    ticket: "GH-2147",
    branch: "GH-2147",
    worktree_path: "/tmp/gh_2147_xyz",
    pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
    artifacts: { worktree: true, branch: true, pr: false, ticket: true },
    local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ...overrides.local },
    status: {
      remote: {
        gh_issue: "completed", beads_issue: "clean", project_item: "clean",
        branch: "clean", pr: "completed", merge_state: "clean", ci: "clean", problem: "no",
      },
      local: { branch: "clean", worktree: "clean", dir: "present", problem: "no" },
    },
    column: "cleaned" as const,
    reasons: [],
  });

  function pruneFixtureRunner(root: string): CommandRunner {
    return (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
  }

  function pruneCompletedPresent(
    overrides: Parameters<typeof completedPresentUnit>[0],
  ) {
    const root = mkdtempSync(join(tmpdir(), "pr-state-prune-blocker-"));
    writeFileSync(join(root, "prx.toml"), ["[parity_chain]", "gh_issue = true", ""].join("\n"));
    return buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [completedPresentUnit(overrides)],
      },
      { mode: "prune", authority: "issue", scope: "local" },
      pruneFixtureRunner(root),
    );
  }

  test("buildParityChain blocks (not silently) prune of a completed unit with a DIRTY worktree (GH-2147)", () => {
    const result = pruneCompletedPresent({ local: { clean: false, unstaged: 2 } });
    // No destructive action is emitted on operator-dirty state...
    expect(result.actions.some((a) => a.type === "delete_worktree")).toBe(false);
    expect(result.actions.some((a) => a.type === "delete_local_branch")).toBe(false);
    // ...but the operator is told why, not left with a silent no-op.
    expect(result.units[0]?.blockers ?? []).toEqual([
      expect.stringContaining("uncommitted changes"),
    ]);
  });

  test("buildParityChain emits delete_worktree even when classifier returns 'review' due to branch divergence (GH-1126)", () => {
    // Real-world post-merge state for GH-1048: branch ref still exists and
    // diverges from main (because main has advanced past the merge commit),
    // so `localStatusForUnit` flags `local.branch="dirty"`,
    // `local.worktree="dirty"`, `local.problem="yes"`. The classifier short-
    // circuits to "review" on the problem flag — but the emit must still
    // fire because the lifecycle is fully completed and operator state is
    // safe.
    const root = mkdtempSync(join(tmpdir(), "pr-state-prune-realworld-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-1048",
            branch: "GH-1048",
            worktree_path: `${root}/gh_1048_a8a`,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: true, branch: true, pr: false, ticket: true },
            local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "missing",
                pr: "completed",
                merge_state: "merged",
                ci: "passed",
                problem: "no",
              },
              local: {
                branch: "dirty",
                worktree: "dirty",
                dir: "present",
                problem: "yes",
              },
            },
            column: "pushed",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "local" },
      runner,
    );

    expect(result.units[0]?.disposition).toBe("review");
    expect(result.actions).toEqual([
      {
        type: "delete_worktree",
        branch: "GH-1048",
        ticket: "GH-1048",
        reason: "PR merged and issue closed but worktree still on disk",
      },
    ]);
  });

  test("buildParityChain prune does not re-emit delete_worktree once worktree is gone (GH-1126)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-prune-idempotent-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-1048",
            branch: "GH-1048",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "no worktree",
                problem: "no",
              },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "local" },
      runner,
    );

    // After a successful first prune, dir flips to "no worktree". The new
    // delete_worktree emit must NOT fire again — only the existing
    // delete_local_branch path remains, and it idempotently no-ops via
    // continue-on-error if the branch ref is already gone.
    expect(result.actions.find((a) => a.type === "delete_worktree")).toBeUndefined();
  });

  test("buildParityChain skips delete_worktree on dirty local — operator state at risk (GH-1126)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-prune-dirty-local-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-1048",
            branch: "GH-1048",
            worktree_path: `${root}/gh_1048_a8a`,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: true, branch: true, pr: false, ticket: true },
            local: { clean: false, staged: 1, unstaged: 0, untracked: 0, conflicts: 0 },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "present",
                problem: "no",
              },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "local" },
      runner,
    );

    expect(result.actions).toEqual([]);
    expect(result.units[0]?.disposition).toBe("review");
  });

  test("buildParityChain prunes branches off the local buffer remote when PR completed (GH-868)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-buffer-prune-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const bufferPath = `${homedir()}/.local/state/git/buffer/owner/repo.git`;
    const runner: CommandRunner = (cmd) => {
      const joined = cmd.join(" ");
      if (joined === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (joined === `git -C ${root} remote get-url local`) {
        return { stdout: `file://${bufferPath}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-549",
            branch: "GH-549",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                buffer_branch: "dirty",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: {
                branch: "clean",
                worktree: "clean",
                dir: "missing",
                problem: "no",
              },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "remote" },
      runner,
    );

    expect(result.actions).toEqual([
      {
        type: "delete_remote_branch",
        remote: "local",
        branch: "GH-549",
        ticket: "GH-549",
        reason: "PR completed but local buffer remote still carries the branch",
      },
    ]);
  });

  test("buildParityChain skips buffer pruning when no `local` remote is configured (GH-868)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-buffer-no-remote-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      const joined = cmd.join(" ");
      if (joined === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (joined === `git -C ${root} remote get-url local`) {
        return { stdout: "", stderr: "fatal: No such remote 'local'\n", status: 128 };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-549",
            branch: "GH-549",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                buffer_branch: "dirty",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "missing", problem: "no" },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "remote" },
      runner,
    );

    expect(result.actions).toEqual([]);
  });

  test("buildParityChain skips buffer pruning when `local` remote URL is outside the buffer tree (GH-868)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-buffer-outside-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      const joined = cmd.join(" ");
      if (joined === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (joined === `git -C ${root} remote get-url local`) {
        // Hand-rolled `local` remote pointing outside the buffer tree —
        // workflows/local-git-state.md says these must be preserved.
        return { stdout: "file:///tmp/some-other-bare.git\n", stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-549",
            branch: "GH-549",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                buffer_branch: "dirty",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "missing", problem: "no" },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "remote" },
      runner,
    );

    expect(result.actions).toEqual([]);
  });

  // GH-1125 — `--merged-only` discovery filter on `prx prune`. Selects
  // units where the PR is merged but the issue is still open and prepends
  // a `close_issue` action; non-matching units short-circuit with no
  // actions. Strictly additive — without the flag, behavior is unchanged.
  test("buildParityChain `mergedOnly` emits close_issue for merged-PR-but-issue-open units (GH-1125)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-1125-merged-only-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[parity_chain]", "gh_issue = true", ""].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          // Merged PR, issue still open → close_issue should fire.
          {
            ticket: "GH-700",
            branch: "GH-700",
            worktree_path: null,
            pr: { exists: true, number: 1234, title: null, url: null, draft: false, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: true, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "dirty",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "merged",
            reasons: [],
          },
          // Already-closed issue → no close_issue, short-circuited by filter.
          {
            ticket: "GH-701",
            branch: "GH-701",
            worktree_path: null,
            pr: { exists: true, number: 1235, title: null, url: null, draft: false, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: true, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "cleaned",
            reasons: [],
          },
          // Open PR, open issue → not in scope of merged-only at all.
          {
            ticket: "GH-702",
            branch: "GH-702",
            worktree_path: null,
            pr: { exists: true, number: 1236, title: null, url: null, draft: true, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: true, pr: true, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "dirty",
                beads_issue: "clean",
                project_item: "clean",
                branch: "dirty",
                pr: "dirty",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "review",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "all", mergedOnly: true },
      runner,
    );

    const closeActions = result.actions.filter((a) => a.type === "close_issue");
    expect(closeActions).toHaveLength(1);
    expect(closeActions[0]).toMatchObject({
      type: "close_issue",
      issue: 700,
      ticket: "GH-700",
    });
    // shellCommand quotes each arg, so the rendered command interleaves
    // single quotes — match on the unique `'700'` token instead. The command
    // is derived from the intent by the executor (no longer embedded).
    const execCtx = { repoPath: ".", bufferPath: null, worktreeConfig: { manager: "git" as const, command: "git" } };
    const closeCmd = commandForSurfaceSyncAction(closeActions[0]!, execCtx);
    expect(closeCmd).toContain("'gh' 'issue' 'close' '700'");
    expect(closeCmd).toContain("Shipped via #1234");
    expect(closeCmd).toContain("prx prune --merged-only");

    // GH-701 (already closed) and GH-702 (open PR) emit no actions in
    // merged-only mode — the filter short-circuits them.
    const gh701Unit = result.units.find((u) => u.ticket === "GH-701");
    expect(gh701Unit?.actions).toHaveLength(0);
    const gh702Unit = result.units.find((u) => u.ticket === "GH-702");
    expect(gh702Unit?.actions).toHaveLength(0);
  });

  test("buildParityChain without `mergedOnly` does not emit close_issue (regression guard, GH-1125)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-1125-no-merged-only-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[parity_chain]", "gh_issue = true", ""].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-800",
            branch: "GH-800",
            worktree_path: null,
            pr: { exists: true, number: 9000, title: null, url: null, draft: false, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: true, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "dirty",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "merged",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "all" },
      runner,
    );
    expect(result.actions.some((a) => a.type === "close_issue")).toBe(false);
  });

  // GH-1125 — Copilot review (PR #1135). Tighten the `mergedOnly` gate so
  // `close_issue` only emits when we have positive evidence the issue is
  // open: feature enabled AND normalized issue status === "dirty". Issue
  // feature disabled or status unknown must short-circuit, even if the PR
  // is merged.
  test("buildParityChain `mergedOnly` does not emit close_issue when issue feature disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-1125-feature-disabled-"));
    // gh_issue feature off — without authority over the issue we must not
    // attempt to close it.
    writeFileSync(
      join(root, "prx.toml"),
      ["[parity_chain]", "gh_issue = false", ""].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-900",
            branch: "GH-900",
            worktree_path: null,
            pr: { exists: true, number: 9100, title: null, url: null, draft: false, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: true, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "dirty",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "merged",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "all", mergedOnly: true },
      runner,
    );
    expect(result.actions.some((a) => a.type === "close_issue")).toBe(false);
  });

  test("buildParityChain `mergedOnly` does not emit close_issue when issue status is unknown", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-1125-status-unknown-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[parity_chain]", "gh_issue = true", ""].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-901",
            branch: "GH-901",
            worktree_path: null,
            pr: { exists: true, number: 9101, title: null, url: null, draft: false, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: true, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            // gh_issue is a non-canonical string ("unknown") — e.g. when
            // `gh issue view` failed and the resolver fell back to a
            // default. `normalizeIssueStatus` returns "disabled" for any
            // non-canonical value, so without explicit "dirty" we can not
            // assert the issue is open, and `close_issue` must not emit.
            status: {
              remote: {
                gh_issue: "unknown",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "merged",
            reasons: [],
          },
        ],
      },
      { mode: "prune", authority: "issue", scope: "all", mergedOnly: true },
      runner,
    );
    expect(result.actions.some((a) => a.type === "close_issue")).toBe(false);
  });

  test("buildParityChain classifies merged-PR row as prune (GH-872)", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-872-prune-disposition-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = true",
        "",
      ].join("\n"),
    );
    const runner: CommandRunner = (cmd) => {
      if (cmd.join(" ") === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = buildSurfaceSyncFromBoard(
      root,
      {
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [
          {
            ticket: "GH-700",
            branch: "GH-700",
            worktree_path: null,
            pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
            artifacts: { worktree: false, branch: false, pr: false, ticket: true },
            local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
            status: {
              remote: {
                gh_issue: "completed",
                beads_issue: "clean",
                project_item: "clean",
                branch: "clean",
                pr: "completed",
                merge_state: "clean",
                ci: "clean",
                problem: "no",
              },
              local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
            },
            column: "cleaned",
            reasons: [],
          },
        ],
      },
      { mode: "full", authority: "issue", scope: "all" },
      runner,
    );

    expect(result.units[0]?.disposition).toBe("prune");
  });

  test("board remote status honors disabled parity-chain features from prx.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-board-config-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[parity_chain]",
        "gh_issue = false",
        "project_item = false",
        "merge_state = false",
        "",
      ].join("\n"),
    );

    const runner: CommandRunner = (cmd, options) => {
      const rendered = cmd.join(" ");
      if (rendered === `git -C ${root} rev-parse --show-toplevel`) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} worktree list --porcelain`) {
        return {
          stdout: `worktree ${join(root, "GH-190")}\nHEAD bbb111\nbranch refs/heads/GH-190\n\n`,
          stderr: "",
          status: 0,
        };
      }
      if (rendered === `git -C ${join(root, "GH-190")} status --porcelain=v1 -b`) {
        return { stdout: "## GH-190...origin/GH-190\n", stderr: "", status: 0 };
      }
      if (
        rendered ===
        "gh pr list --state open --json number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews -R owner/repo"
      ) {
        return {
          stdout: JSON.stringify([
            {
              number: 10,
              headRefName: "GH-190",
              title: "Feature",
              isDraft: false,
              url: "https://example.com/10",
              reviewDecision: "APPROVED",
              statusCheckRollup: { state: "SUCCESS" },
              mergeable: "MERGEABLE",
              reviews: [],
            },
          ]),
          stderr: "",
          status: 0,
        };
      }
      if (rendered === `git -C ${root} branch --list -r`) {
        return { stdout: "  origin/GH-190\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} branch --format=%(refname:short)`) {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} show-ref --verify --quiet refs/heads/GH-190`) {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...origin/GH-190`) {
        return { stdout: "0\t1\n", stderr: "", status: 0 };
      }
      if (rendered === `git -C ${root} rev-list --left-right --count origin/main...refs/heads/GH-190`) {
        return { stdout: "", stderr: "", status: 1 };
      }
      if (rendered === `git -C ${root} fetch --dry-run origin`) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (rendered.includes("rev-list --left-right --count origin/main...local/")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      throw new Error(`Unexpected command: ${rendered}`);
    };

    const summary = boardStatus(root, { remote: true }, runner);
    expect(summary.units[0]).toMatchObject({
      status: {
        remote: {
          gh_issue: "disabled",
          project_item: "disabled",
          merge_state: "disabled",
          ci: "passed",
        },
      },
    });
  });
});

describe("remote-ci-check", () => {
  test("parses CodeBuild build ids from GitHub check links", () => {
    expect(
      parseCodeBuildIdFromLink(
        "https://console.aws.amazon.com/codebuild/home?region=us-east-1#/builds/WebCodeBuildProject-Xy2MJe7QBRs6:8c0bcb21-6a92-47e9-a62f-59b8829ffd3f/view/new",
      ),
    ).toBe("WebCodeBuildProject-Xy2MJe7QBRs6:8c0bcb21-6a92-47e9-a62f-59b8829ffd3f");
  });

  test("returns failing checks and enriches CodeBuild failures", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (
        cmd.join(" ") === "gh pr checks 16230 --json name,state,link,description" &&
        options?.cwd === "/repo"
      ) {
        return {
          stdout: JSON.stringify([
            {
              name: "continuous-integration/codebuild",
              state: "FAILURE",
              link: "https://console.aws.amazon.com/codebuild/home?region=us-east-1#/builds/WebCodeBuildProject-Xy2MJe7QBRs6:8c0bcb21-6a92-47e9-a62f-59b8829ffd3f/view/new",
              description: "The CodeBuild build has failed",
            },
            {
              name: "lint",
              state: "SUCCESS",
              link: "https://example.com/lint",
              description: "ok",
            },
          ]),
          stderr: "",
          status: 0,
        };
      }

      if (
        cmd.join(" ") ===
        "aws codebuild batch-get-builds --ids WebCodeBuildProject-Xy2MJe7QBRs6:8c0bcb21-6a92-47e9-a62f-59b8829ffd3f --query builds[0].reportArns[0] --output text"
      ) {
        return {
          stdout: "arn:aws:codebuild:us-east-1:123456789012:report-group/ci-report",
          stderr: "",
          status: 0,
        };
      }

      if (
        cmd.join(" ") ===
        "aws codebuild describe-test-cases --report-arn arn:aws:codebuild:us-east-1:123456789012:report-group/ci-report --query testCases[?status==`FAILED`].{name:name,suite:testSuiteName,status:status,message:message,details:statusDetails,duration_ns:durationInNanoSeconds} --output json"
      ) {
        return {
          stdout: JSON.stringify([
            {
              name: "test_lin_loop_item",
              suite: "OrderfulInventoryInquiryAdviceTest",
              status: "FAILED",
              message: null,
              details: "Expected: \"1\" Actual: nil",
              duration_ns: 69930102,
            },
          ]),
          stderr: "",
          status: 0,
        };
      }

      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    const result = remoteCiCheck("/repo", "16230", runner);
    expect(result).toMatchObject({
      repoPath: "/repo",
      pr: "16230",
      failingChecks: [
        {
          name: "continuous-integration/codebuild",
          state: "FAILURE",
          codebuild: {
            buildId: "WebCodeBuildProject-Xy2MJe7QBRs6:8c0bcb21-6a92-47e9-a62f-59b8829ffd3f",
            reportArn: "arn:aws:codebuild:us-east-1:123456789012:report-group/ci-report",
            error: null,
            failures: [
              {
                name: "test_lin_loop_item",
              },
            ],
          },
        },
      ],
    });
  });
});

describe("parseActionsRunIdFromLink", () => {
  test("parses run id from GitHub Actions URL", () => {
    expect(
      parseActionsRunIdFromLink("https://github.com/bdelanghe/ai-home/actions/runs/23458383308/job/68253542877"),
    ).toBe("23458383308");
  });

  test("parses run id without job suffix", () => {
    expect(
      parseActionsRunIdFromLink("https://github.com/owner/repo/actions/runs/12345"),
    ).toBe("12345");
  });

  test("returns null for non-Actions URL", () => {
    expect(
      parseActionsRunIdFromLink("https://console.aws.amazon.com/codebuild/home"),
    ).toBeNull();
  });
});

describe("pr comments", () => {
  test("fetchPrComments returns review thread evidence", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (
        cmd.join(" ") ===
          "gh pr view GH-321 --json number,title,url,isDraft,baseRefName,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,reviews"
        && options?.cwd === "/repo"
      ) {
        return {
          stdout: JSON.stringify({
            number: 334,
            title: "Signal remote CI before reviewer",
            url: "https://example.com/pr/334",
            isDraft: false,
            baseRefName: "main",
            reviewDecision: null,
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            autoMergeRequest: { enabledAt: "2026-03-22T03:32:17Z" },
            reviews: [
              {
                state: "COMMENTED",
                author: { login: "copilot-pull-request-reviewer" },
              },
            ],
          }),
          stderr: "",
          status: 0,
        };
      }

      if (
        cmd.join(" ") === "gh repo view --json nameWithOwner --jq .nameWithOwner"
        && options?.cwd === "/repo"
      ) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }

      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql" && options?.cwd === "/repo") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-1",
                        isResolved: false,
                        isOutdated: false,
                        path: "src/pr-state/task.ts",
                        comments: {
                          nodes: [
                            {
                              author: { login: "copilot-pull-request-reviewer" },
                              body: "Please fix the blocker text.",
                              state: "SUBMITTED",
                              path: "src/pr-state/task.ts",
                              createdAt: "2026-03-22T02:25:18Z",
                              url: "https://example.com/comment/1",
                              outdated: false,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }

      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(fetchPrComments("/repo", "GH-321", runner)).toMatchObject({
      repoPath: "/repo",
      pr: {
        number: 334,
        mergeStateStatus: "BLOCKED",
        mergeable: "MERGEABLE",
        autoMergeEnabled: true,
      },
      reviewAdded: true,
      reviewApproved: false,
      agentReview: true,
      humanReview: false,
      unresolvedThreads: 1,
      threads: [
        {
          id: "thread-1",
          isResolved: false,
        },
      ],
    });
  });

  test("fetchPrSignalInfo uses unresolved threads instead of generic blocked merge state", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (
        cmd.join(" ") ===
          "gh pr view GH-321 --json number,title,url,isDraft,baseRefName,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,reviews"
        && options?.cwd === "/repo"
      ) {
        return {
          stdout: JSON.stringify({
            number: 334,
            title: "Signal remote CI before reviewer",
            url: "https://example.com/pr/334",
            isDraft: false,
            baseRefName: "main",
            reviewDecision: null,
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            autoMergeRequest: null,
            reviews: [],
          }),
          stderr: "",
          status: 0,
        };
      }

      if (
        cmd.join(" ") === "gh repo view --json nameWithOwner --jq .nameWithOwner"
        && options?.cwd === "/repo"
      ) {
        return { stdout: "bdelanghe/ai-home\n", stderr: "", status: 0 };
      }

      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql" && options?.cwd === "/repo") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [],
                  },
                },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }

      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(fetchPrSignalInfo("/repo", "GH-321", runner)).toEqual({
      reviewAdded: false,
      reviewApproved: false,
      agentReview: false,
      humanReview: false,
      commentsResolved: true,
      mergeStateStatus: "BLOCKED",
      mergeable: "MERGEABLE",
      autoMergeEnabled: false,
    });
  });

  test("resolvePrReviewThreads resolves each requested thread with ID-typed graphql mutation", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (cmd, options) => {
      if (options?.cwd !== "/repo") {
        throw new Error(`Unexpected cwd: ${options?.cwd}`);
      }
      seen.push(cmd.join(" "));
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              resolveReviewThread: {
                thread: {
                  isResolved: true,
                },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };

    expect(resolvePrReviewThreads("/repo", ["thread-1", "thread-1", "thread-2"], runner)).toEqual([
      { id: "thread-1", isResolved: true },
      { id: "thread-2", isResolved: true },
    ]);
    expect(seen).toEqual([
      "gh api graphql -f query=mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } } -F id=thread-1",
      "gh api graphql -f query=mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } } -F id=thread-2",
    ]);
  });

  // GH-885: doctor actor GraphQL helpers go through `gh api graphql` rather
  // than `gh pr merge --auto` (blocked at the executor flag layer). Tests
  // verify the right mutation fires with the right inputs.

  test("resolvePrNodeId queries pullRequest(number).id", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (cmd) => {
      seen.push(cmd.join(" "));
      if (cmd[0] === "gh" && cmd[1] === "repo") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: { pullRequest: { id: "PR_NODE_42" } },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    expect(resolvePrNodeId("/repo", 42, runner)).toBe("PR_NODE_42");
    expect(seen.some((s) => s.includes("pullRequest(number:$number)"))).toBeTrue();
    expect(seen.some((s) => s.includes("number=42"))).toBeTrue();
  });

  test("enableAutoMerge calls enablePullRequestAutoMerge mutation with method", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (cmd) => {
      seen.push(cmd.join(" "));
      return {
        stdout: JSON.stringify({
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: {
                id: "PR_NODE_42",
                autoMergeRequest: { enabledAt: "2026-05-02T00:00:00Z", mergeMethod: "SQUASH" },
              },
            },
          },
        }),
        stderr: "",
        status: 0,
      };
    };
    const result = enableAutoMerge("/repo", "PR_NODE_42", "SQUASH", runner);
    expect(result.mergeMethod).toBe("SQUASH");
    const call = seen.join(" ");
    expect(call).toContain("enablePullRequestAutoMerge");
    expect(call).toContain("id=PR_NODE_42");
    expect(call).toContain("method=SQUASH");
  });

  test("markPrReadyForReview calls markPullRequestReadyForReview mutation", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (cmd) => {
      seen.push(cmd.join(" "));
      return {
        stdout: JSON.stringify({
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { id: "PR_NODE_42", isDraft: false },
            },
          },
        }),
        stderr: "",
        status: 0,
      };
    };
    const result = markPrReadyForReview("/repo", "PR_NODE_42", runner);
    expect(result.isDraft).toBeFalse();
    expect(seen.join(" ")).toContain("markPullRequestReadyForReview");
  });

  test("mergePullRequest calls mergePullRequest mutation with method", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (cmd) => {
      seen.push(cmd.join(" "));
      return {
        stdout: JSON.stringify({
          data: {
            mergePullRequest: {
              pullRequest: { id: "PR_NODE_42", merged: true, state: "MERGED" },
            },
          },
        }),
        stderr: "",
        status: 0,
      };
    };
    const result = mergePullRequest("/repo", "PR_NODE_42", "SQUASH", runner);
    expect(result).toEqual({ prNodeId: "PR_NODE_42", merged: true, state: "MERGED" });
    const call = seen.join(" ");
    expect(call).toContain("mergePullRequest(input:");
    expect(call).toContain("id=PR_NODE_42");
    expect(call).toContain("method=SQUASH");
  });

  test("mergePullRequest throws when no pullRequest is returned", () => {
    const runner: CommandRunner = () => ({
      stdout: JSON.stringify({ data: { mergePullRequest: { pullRequest: null } } }),
      stderr: "",
      status: 0,
    });
    expect(() => mergePullRequest("/repo", "PR_NODE_42", "SQUASH", runner)).toThrow(
      /no pull request for PR_NODE_42/,
    );
  });

  test("convertPrToDraft calls convertPullRequestToDraft mutation", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (cmd) => {
      seen.push(cmd.join(" "));
      return {
        stdout: JSON.stringify({
          data: {
            convertPullRequestToDraft: {
              pullRequest: { id: "PR_NODE_42", isDraft: true },
            },
          },
        }),
        stderr: "",
        status: 0,
      };
    };
    const result = convertPrToDraft("/repo", "PR_NODE_42", runner);
    expect(result.isDraft).toBeTrue();
    expect(seen.join(" ")).toContain("convertPullRequestToDraft");
  });

  test("fetchPrComments surfaces structured autoMergeRequest", () => {
    const runner: CommandRunner = (cmd, options) => {
      if (
        cmd.join(" ") ===
          "gh pr view GH-885 --json number,title,url,isDraft,baseRefName,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,reviews"
        && options?.cwd === "/repo"
      ) {
        return {
          stdout: JSON.stringify({
            number: 100,
            title: "Doctor wires up automerge",
            url: "https://example.com/pr/100",
            isDraft: false,
            baseRefName: "main",
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            autoMergeRequest: {
              enabledAt: "2026-05-02T00:00:00Z",
              enabledBy: { login: "doctor-bot" },
              mergeMethod: "SQUASH",
            },
            reviews: [],
          }),
          stderr: "",
          status: 0,
        };
      }
      if (cmd.join(" ") === "gh repo view --json nameWithOwner --jq .nameWithOwner") {
        return { stdout: "owner/repo\n", stderr: "", status: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [] } },
              },
            },
          }),
          stderr: "",
          status: 0,
        };
      }
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    };
    const result = fetchPrComments("/repo", "GH-885", runner);
    expect(result.pr.autoMergeEnabled).toBeTrue();
    expect(result.pr.autoMergeRequest).toEqual({ enabledBy: "doctor-bot", mergeMethod: "SQUASH" });
  });
});

describe("withTrace — PRX_TRACE runner wedge (GH-2074 PR-1 .1.4)", () => {
  let savedTrace: string | undefined;
  let origErr: typeof process.stderr.write;
  let errChunks: string[];

  beforeEach(() => {
    savedTrace = getEnv("PRX_TRACE");
    deleteEnv("PRX_TRACE");
    errChunks = [];
    origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origErr;
    if (savedTrace === undefined) deleteEnv("PRX_TRACE");
    else setEnv("PRX_TRACE", savedTrace);
  });

  test("PRX_TRACE=1: emits one JSONL record per command and returns the inner result", () => {
    setEnv("PRX_TRACE", "1");
    const calls: string[][] = [];
    const inner: CommandRunner = (cmd) => {
      calls.push(cmd);
      return { stdout: "ok", stderr: "", status: 0 };
    };
    const traced = withTrace(inner);

    const result = traced(["gh", "issue", "view", "1960", "--json", "state"]);

    // Pass-through: the wrapped runner still ran and its result is unchanged.
    expect(calls).toEqual([["gh", "issue", "view", "1960", "--json", "state"]]);
    expect(result).toEqual({ stdout: "ok", stderr: "", status: 0 });

    const lines = errChunks.join("").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.kind).toBe("gh-issue-view");
    expect(record.target).toBe("1960");
    expect(typeof record.ms).toBe("number");
  });

  test("PRX_TRACE unset: no emission, runner result passes through unchanged", () => {
    const inner: CommandRunner = () => ({ stdout: "x", stderr: "", status: 0 });
    const traced = withTrace(inner);

    const result = traced(["bd", "show", "ai-home-udqx2.4", "--json"]);

    expect(result).toEqual({ stdout: "x", stderr: "", status: 0 });
    expect(errChunks.join("")).toBe("");
  });
});

describe("GH-2083 (.3.2) — view seams read a hydrated projection, never an inline shell-out", () => {
  let savedCacheHome: string | undefined;
  let savedDisable: string | undefined;

  beforeEach(() => {
    savedCacheHome = getEnv("XDG_CACHE_HOME");
    savedDisable = getEnv("PRX_WT_CACHE_DISABLE");
    setEnv("XDG_CACHE_HOME", mkdtempSync(join(tmpdir(), "prx-proj-seam-")));
    deleteEnv("PRX_WT_CACHE_DISABLE");
    deleteEnv("PRX_PROJECTION_DISABLE");
  });
  afterEach(() => {
    if (savedCacheHome === undefined) deleteEnv("XDG_CACHE_HOME");
    else setEnv("XDG_CACHE_HOME", savedCacheHome);
    if (savedDisable === undefined) deleteEnv("PRX_WT_CACHE_DISABLE");
    else setEnv("PRX_WT_CACHE_DISABLE", savedDisable);
    deleteEnv("PRX_PROJECTION_DISABLE");
  });

  function recordingRunner(
    handlers: Array<{ match: (cmd: string[]) => boolean; result: { stdout: string; stderr: string; status: number } }>,
  ): { runner: CommandRunner; calls: string[] } {
    const calls: string[] = [];
    const runner: CommandRunner = (cmd) => {
      calls.push(cmd.join(" "));
      for (const h of handlers) if (h.match(cmd)) return h.result;
      return { stdout: "", stderr: "", status: 1 };
    };
    return { runner, calls };
  }

  const ghOk = { match: (c: string[]) => c[0] === "gh" && c[1] === "issue" && c[2] === "view", result: { stdout: JSON.stringify({ number: 2083, state: "OPEN" }), stderr: "", status: 0 } };
  const bdOk = { match: (c: string[]) => c[0] === "bd" && c[1] === "show", result: { stdout: JSON.stringify({ id: "ai-home-udqx2.9", status: "open" }), stderr: "", status: 0 } };

  test("read seams take no CommandRunner — pure over the hydrated projection", () => {
    const { runner } = recordingRunner([ghOk, bdOk]);
    hydrateIssue("owner/repo", "GH-2083", runner);
    hydrateBeads("/repo", "ai-home-udqx2.9", runner);
    expect(maybeViewIssue("owner/repo", "GH-2083")).toEqual({ number: 2083, state: "OPEN" });
    expect(maybeViewBeadsIssue("/repo", "ai-home-udqx2.9")).toEqual({ id: "ai-home-udqx2.9", status: "open" });
  });

  test("an un-hydrated read raises ProjectionMiss — never falls back to a shell-out", () => {
    expect(() => maybeViewIssue("owner/repo", "GH-9999")).toThrow(ProjectionMiss);
    expect(() => maybeViewBeadsIssue("/repo", "ai-home-absent")).toThrow(ProjectionMiss);
  });

  test("prx-zbsi: in the box profile the bd show read routes through the door, not the local runner", () => {
    const prev = getEnv("PRX_BEADS_DOOR");
    setEnv("PRX_BEADS_DOOR", "host.sock");
    const dialedSubs: string[] = [];
    registerBdDoorDialer((opts) => {
      dialedSubs.push(opts.subcommand);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ id: "ai-home-door1", status: "open" }),
        stderr: "",
        policy: null,
      };
    });
    let innerCalled = false;
    const runner: CommandRunner = () => {
      innerCalled = true;
      return { stdout: "", stderr: "", status: 1 };
    };
    try {
      hydrateBeads("/repo", "ai-home-door1", runner);
      expect(dialedSubs).toEqual(["show"]);
      expect(innerCalled).toBe(false);
      expect(maybeViewBeadsIssue("/repo", "ai-home-door1")).toEqual({
        id: "ai-home-door1",
        status: "open",
      });
    } finally {
      registerBdDoorDialer(undefined);
      if (prev === undefined) deleteEnv("PRX_BEADS_DOOR");
      else setEnv("PRX_BEADS_DOOR", prev);
    }
  });

  test("hydrateIssue is fresh-or-fetch: a second hydrate is a cache hit (no re-run)", () => {
    const { runner, calls } = recordingRunner([ghOk]);
    hydrateIssue("owner/repo", "GH-2083", runner);
    hydrateIssue("owner/repo", "GH-2083", runner);
    expect(calls.filter((c) => c.startsWith("gh issue view")).length).toBe(1);
  });

  test("PRX_WT_CACHE_DISABLE=1 forces re-fetch but reads still work (kill-switch ≠ broken reads)", () => {
    setEnv("PRX_WT_CACHE_DISABLE", "1");
    const { runner, calls } = recordingRunner([ghOk]);
    hydrateIssue("owner/repo", "GH-2083", runner);
    hydrateIssue("owner/repo", "GH-2083", runner);
    expect(calls.filter((c) => c.startsWith("gh issue view")).length).toBe(2);
    expect(maybeViewIssue("owner/repo", "GH-2083")).toEqual({ number: 2083, state: "OPEN" });
  });

  test("a gh miss hydrates view:null (deterministic) — read returns null, no fallback shell-out", () => {
    const { runner, calls } = recordingRunner([{ match: (c) => c[0] === "gh", result: { stdout: "", stderr: "not found", status: 1 } }]);
    hydrateIssue("owner/repo", "GH-404", runner);
    expect(maybeViewIssue("owner/repo", "GH-404")).toBeNull();
    expect(calls.filter((c) => c.startsWith("gh issue view")).length).toBe(1);
  });
});
