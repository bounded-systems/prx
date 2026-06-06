import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CommandRunner as GithubCommandRunner,
  WtStatusResult,
} from "../../src/pr-state/github.ts";
import { commandForSurfaceSyncAction } from "../../src/pr-state/github.ts";
import { RepoAddError, writeRepoInventoryIndex } from "../../src/pr-state/repos.ts";
import type { RepoInventory, RepoInventoryConfig } from "../../src/pr-state/repos.ts";
import { consumeArtifact } from "../../src/pipeline/edge.ts";
import { workUnitSourceEdge, pinWorkUnitSource } from "../../src/pipeline/source-pin.ts";
// GH-2098: brand the mock `rawState` fixtures (plain-string literals standing
// in for validated raw state) at the single cast point per block.
import type { RawStateV1 } from "@bounded-systems/machine-schema";
import type { DomainStateV1 } from "../../src/pr-state/domain_state.ts";
import {
  assertWorktreeOnNamedBranch,
  autoRebaseOnSessionOpen,
  buildInitialPrContract,
  canonicalBeadsDatabaseName,
  canonicalBeadsRepoIdFromRemote,
  checkPrxBinaryUpstream,
  checkWorkUnitChain,
  checkWorkUnitIssue,
  checkWorkUnitSession,
  CliError,
  ensureBeadsInitSetup,
  findSavedClaudeSession,
  findSavedCodexSession,
  findBeadsIssuesByGithubIssue,
  formatBeadsIssueMatches,
  ensureLocalRuntimeArtifacts,
  initContract,
  interactiveTimeoutMs,
  applyParityChainActions,
  findWorktreeByDirectoryPrefix,
  materializeWorkUnitBranch,
  parseCommand,
  prepareMainxWorktree,
  pruneStaleRemoteRefs,
  runBeadsInit,
  resolveWorkUnitLaunchCwd,
  assertLaunchCwdNotMainx,
  runCli as runCliDirect,
  closeSession,
  reviewVerb,
} from "../../src/pr-state/cli.ts";
import {
  prxSessionNotProjectedLocallyEnvelope,
  type PrxSessionNotProjectedLocallyDetails,
} from "../../src/machine/session_open.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import { loadWorkspaceConfig } from "../../src/pr-state/github.ts";
import { buildIdentityFromLegacy } from "./identity-helpers.ts";

function beadRecord(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-x",
    title: "stub",
    description: "",
    status: "open",
    priority: null,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}
import { parseSessionLockPid, removeWorktree } from "../../src/pr-state/github.ts";
import { deriveInfo, loadContract } from "../../src/pr-state/contract.ts";
import { createTaskContract, loadTaskContract, writeTaskContract } from "../../src/pr-state/task.ts";
import { runtimeRequiredFields } from "../../src/machine/runtime_output.ts";
import { taskAgentRoles } from "../../src/machine/runtime_profiles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const pkgRoot = resolve(repoRoot, "packages", "prx");
const scriptPath = join(pkgRoot, "scripts/pr_state.ts");
const prxSafePath = join(pkgRoot, "scripts/prx-safe");

/**
 * ai-home-8zr6: after `seedRemoteBranch` guarantees origin/<id> exists,
 * `materializeWorkUnitBranch` fetches the remote ref and invokes
 * `ensureWorkUnitBranchAndUpstream` to create a local tracking branch.
 * This helper returns the matching spawn result for any of the git calls
 * that flow produces, or null if the call is unrelated.
 */
function mockEnsureWorkUnitBranchFlow(
  repoRoot: string,
  id: string,
  file: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } | null {
  if (file !== "git") return null;
  const argsStr = args.join(" ");
  if (argsStr === `-C ${repoRoot} fetch origin +refs/heads/${id}:refs/remotes/origin/${id}`) {
    return { status: 0, stdout: "", stderr: "" };
  }
  if (argsStr === `-C ${repoRoot} rev-parse --verify --quiet refs/heads/${id}`) {
    return { status: 1, stdout: "", stderr: "" };
  }
  if (argsStr === `-C ${repoRoot} branch -r --list */${id}`) {
    return { status: 0, stdout: `  origin/${id}\n`, stderr: "" };
  }
  if (argsStr === `-C ${repoRoot} rev-parse --verify --quiet refs/remotes/origin/${id}`) {
    return { status: 0, stdout: "", stderr: "" };
  }
  if (argsStr === `-C ${repoRoot} branch --track ${id} origin/${id}`) {
    return { status: 0, stdout: "", stderr: "" };
  }
  return null;
}

function makeContractFile(state = "drafting", ready = false) {
  const dir = mkdtempSync(join(tmpdir(), "pr-state-cli-"));
  const contractPath = join(dir, "pr.json");
  writeFileSync(
    contractPath,
    JSON.stringify(
      {
        pr: {
          title: "CLI Example",
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
    ),
  );
  return contractPath;
}

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", scriptPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

// GH-2140: the lifted `--from=notion|beads` × GH-id guard in
// validateWorkSessionEntry gates on a LOCAL worktree view (`wtStatus`) rather
// than the remote board, so it can reject before any `gh pr list` / remoteStatus
// fetch. The guard only reads `wt_available` + `worktrees[].branch`; cast through
// unknown so tests don't have to build full NormalizedWtState/symbol fixtures.
function localWtView(branches: string[]): WtStatusResult {
  return {
    source: "wt+git",
    wt_available: branches.length > 0,
    worktrees: branches.map((branch) => ({ branch })),
  } as unknown as WtStatusResult;
}

function issueBackedWorkDeps(workUnitIds: string | string[]) {
  const ids = Array.isArray(workUnitIds) ? workUnitIds : [workUnitIds];
  return {
    // GH-519: session-open runs git fetch --prune origin before the parity
    // chain evaluates. In mocked-world tests we stub it out so tmpdir
    // scenarios don't shell out to a real remote.
    pruneStaleRemoteRefs: () => {},
    // GH-1983: bypass the detached-HEAD preflight by default — see comment
    // in noOpWorktreeLockDeps for the CI-only TMPDIR-override rationale.
    // Tests exercising the refusal explicitly override with the real helper.
    assertWorktreeOnNamedBranch: () => null,
    // GH-678: session-open drives a tmux spawn/attach under the mux
    // persistence layer. Fixtures need a benign mux runner (and a
    // benign attach runner) so tests don't shell out to real tmux.
    // Tests that want to assert on tmux IPC override muxRunner via
    // `captureMuxInvocations()` instead.
    muxRunner: benignMuxRunner,
    attachRunner: (() => ({ stdout: "", stderr: "", status: 0 })) as GithubCommandRunner,
    boardStatus: () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: ids.map((workUnitId) => ({
          ticket: workUnitId,
          branch: workUnitId,
          worktree_path: `/repo/${workUnitId}`,
          pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
          artifacts: { worktree: true, branch: true, pr: false, ticket: true },
          local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
          status: {
            remote: {
              gh_issue: "dirty",
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
              dir: "present",
              problem: "no",
            },
          },
          column: "pushed" as const,
          reasons: [],
        })),
    }),
    buildParityChain: () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: ids.map((workUnitId) => ({ branch: workUnitId, ticket: workUnitId, actions: [] })),
      actions: [],
    }),
  };
}

/**
 * Benign tmux runner for session-open tests that don't want to inspect the
 * mux wiring. Models `has-session` as "absent" so the spawn path fires,
 * and every other tmux IPC call as exit 0 with empty stdout. Tests that DO
 * want to inspect tmux invocations override `muxRunner` directly.
 */
const benignMuxRunner: GithubCommandRunner = (cmd) => {
  if (cmd[0] !== "tmux") {
    return { stdout: "", stderr: "", status: 0 };
  }
  // Skip "-L prx" (args 1, 2) to find the verb at arg 3.
  const verb = cmd[3];
  if (verb === "has-session") {
    return { stdout: "", stderr: "", status: 1 };
  }
  return { stdout: "", stderr: "", status: 0 };
};

const noOpWorktreeLockDeps = {
  lockWorktree: () => {},
  unlockWorktree: () => {},
  // muxRunner / attachRunner come in via issueBackedWorkDeps below, which
  // also injects the GH-1983 detached-HEAD preflight stub.
  ...issueBackedWorkDeps(["GH-5431", "GH-5480", "GH-7777", "GH-171"]),
};

/**
 * Captures tmux invocations for session-open tests that want to inspect the
 * bootstrap_command (i.e. the claude/codex invocation the agent pane would run).
 * Wraps `benignMuxRunner` so the runner still returns sane pane ids, but also
 * records every call and exposes a getter for the send-keys text that landed
 * on the agent pane.
 */
function captureMuxInvocations(): {
  runner: GithubCommandRunner;
  invocations: string[][];
  bootstrapCommand(): string | null;
  rawBootstrapCommand(): string | null;
  newSessionCwd(): string | null;
} {
  const invocations: string[][] = [];
  const runner: GithubCommandRunner = (cmd, options) => {
    invocations.push([...cmd]);
    return benignMuxRunner(cmd, options);
  };
  const rawBootstrap = (): string | null => {
    // GH-767: single-pane layout sends the bootstrap to the session's
    // only pane. Shape is `tmux -L prx send-keys -t <session> <cmd> Enter`
    // → cmd[6].
    const sendKeys = invocations.find((inv) => inv[3] === "send-keys");
    return sendKeys ? sendKeys[6] ?? null : null;
  };
  return {
    runner,
    invocations,
    rawBootstrapCommand: rawBootstrap,
    bootstrapCommand() {
      // GH-780: when the bootstrap exceeds MAX_CANON on Darwin, `prx session
      // open` writes it to .pr/local/runtime/bootstrap.sh and sends a short
      // POSIX `. <path>` line through tmux send-keys instead. Dereference the
      // wrapper transparently so existing assertions still see the full
      // claude invocation.
      const raw = rawBootstrap();
      if (!raw) return null;
      const match = raw.match(/^\.\s+(\S+)\s*$/);
      if (!match || !match[1]) return raw;
      const sessionCwd = (() => {
        const newSession = invocations.find((inv) => inv[3] === "new-session");
        if (!newSession) return null;
        const cIdx = newSession.indexOf("-c");
        return cIdx >= 0 ? newSession[cIdx + 1] ?? null : null;
      })();
      const filePath = match[1];
      const absolute = sessionCwd && !filePath.startsWith("/")
        ? join(sessionCwd, filePath)
        : filePath;
      try {
        return readFileSync(absolute, "utf8").replace(/\n+$/, "");
      } catch {
        return raw;
      }
    },
    newSessionCwd() {
      const newSession = invocations.find((inv) => inv[3] === "new-session");
      if (!newSession) return null;
      const cIdx = newSession.indexOf("-c");
      return cIdx >= 0 ? newSession[cIdx + 1] ?? null : null;
    },
  };
}

function repoInventoryConfigFixture() {
  return {
    repoRoot,
    bareRoot: "/Users/dev/.local/share/git/bare",
    roots: ["/Users/dev/.local/share/git/bare"],
    everywhereRoots: ["/Users/dev/.local/share/git/bare", "/Users/dev/.local/share"],
    globalConfigPath: `${repoRoot}/.config/prx/repos/config.json`,
    configPath: `${repoRoot}/.prx/repos/config.json`,
    indexPath: `${repoRoot}/.prx/repos/index.json`,
  };
}

function protectMainBranchResultFixture(overrides: Record<string, unknown> = {}) {
  return {
    backend: "branch-protection" as const,
    repo: "bdelanghe/ai-home",
    branch: "main",
    viewer: "bdelanghe",
    owner: "bdelanghe",
    ownerType: "User",
    rulesetId: null,
    rulesetName: null,
    solo: false,
    apply: false,
    applied: false,
    approvalContributorCount: 1,
    requireLastPushApprovalSuppressed: false,
    requiredApprovingReviewCountSuppressed: false,
    enforceAdmins: false,
    requireConversationResolution: false,
    requireLastPushApproval: false,
    requiredApprovingReviewCount: 1,
    requireLinearHistory: false,
    requiredStatusChecks: [],
    payload: {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false,
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: false,
      lock_branch: false,
      allow_fork_syncing: false,
    },
    command: ["gh", "api", "--method", "PUT", "repos/bdelanghe/ai-home/branches/main/protection"],
    ...overrides,
  };
}

function checkMainBranchProtectionResultFixture(overrides: Record<string, unknown> = {}) {
  return {
    backend: "branch-protection" as const,
    repo: "bdelanghe/ai-home",
    branch: "main",
    viewer: "bdelanghe",
    owner: "bdelanghe",
    ownerType: "User",
    rulesetId: null,
    rulesetName: null,
    solo: false,
    approvalContributorCount: 1,
    requireLastPushApprovalSuppressed: false,
    requiredApprovingReviewCountSuppressed: false,
    enforceAdmins: false,
    requireConversationResolution: false,
    requireLastPushApproval: false,
    requiredApprovingReviewCount: 1,
    requireLinearHistory: false,
    requiredStatusChecks: [],
    desired: protectMainBranchResultFixture().payload,
    live: protectMainBranchResultFixture().payload,
    matches: true,
    ...overrides,
  };
}

describe("pr_state cli", () => {
  // GH-261: headless `plan`/`plan session` now requires `<unit>:source@pinned`
  // (the issue is handed in as input; the planner never hydrates). The
  // plan-session plumbing tests below all drive GH-5431, so seed its source in
  // a temp CAS once. Real flows pin via intake/scout upstream.
  let prevCasRootForPlan: string | undefined;
  beforeAll(async () => {
    prevCasRootForPlan = process.env.PRX_CAS_ROOT;
    process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "cli-test-source-"));
    await pinWorkUnitSource("GH-5431", {
      id: "GH-5431",
      title: "linear-backed work unit (test fixture)",
      body: "Seeded source for the plan-session plumbing tests.",
      state: "open",
      url: null,
      source: "github",
    });
  });
  afterAll(() => {
    if (prevCasRootForPlan === undefined) delete process.env.PRX_CAS_ROOT;
    else process.env.PRX_CAS_ROOT = prevCasRootForPlan;
  });

  test("help prints the registry-backed overview surface (GH-976)", () => {
    // Per `docs/prx/help-surface.md` §5/§6 the overview is identity + the
    // canonical six promoted commands + pointers. The 'Grouped by domain'
    // block, the long flag-laden `prx session open` row, and the
    // 'Transitional aliases' footer all moved to help-all (or away entirely).
    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath, "--help"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("prx");
    expect(stdout).toContain("Work-unit identity: GH-NNN");
    expect(stdout).toContain("Primary workflow:");
    // Canonical six (registry §6.2; GH-1166: bare-session retired, slots
    // renamed to `prx next` and `prx plan handoff`):
    expect(stdout).toContain("prx tui");
    expect(stdout).toContain("prx plan session");
    expect(stdout).toContain("prx next");
    expect(stdout).toContain("prx do");
    expect(stdout).toContain("prx review");
    expect(stdout).toContain("prx plan handoff");
    // Footer pointers:
    expect(stdout).toContain("prx help-all");
    expect(stdout).toContain("prx <cmd> --help");
    // Removed by IA cleanup — must NOT reappear:
    expect(stdout).not.toContain("Grouped by domain");
    expect(stdout).not.toContain("Transitional aliases");
    expect(stdout).not.toContain("prx sprint init");
    expect(stdout).not.toContain("prx protect-main");
  });

  test("help-all prints the registry-backed sitemap (GH-976)", () => {
    // §7: four domain clusters. §8: deprecations in their own section, not
    // mixed into the namespaced surface. Internal entries (`sprint`, `task`,
    // `role`, `spec`, …) are hidden.
    const result = runCli(["help-all"]);
    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("full command catalog");
    // Domain headers, in order:
    const stateIdx = stdout.indexOf("State:");
    const workIdx = stdout.indexOf("Work units:");
    const repoIdx = stdout.indexOf("Repo plumbing:");
    const sysIdx = stdout.indexOf("System:");
    const depIdx = stdout.indexOf("Deprecated spellings:");
    expect(stateIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(workIdx);
    expect(workIdx).toBeLessThan(repoIdx);
    expect(repoIdx).toBeLessThan(sysIdx);
    expect(sysIdx).toBeLessThan(depIdx);
    // Representative leaves from each domain:
    expect(stdout).toContain("prx model show");
    expect(stdout).toContain("prx plan session");
    // prx-rgr: the relocated claude launcher is a work-units leaf.
    expect(stdout).toContain("prx claude");
    expect(stdout).toContain("prx repo protect-main");
    expect(stdout).toContain("prx home update");
    // GH-1166: retired bare-session reads have canonical homes:
    expect(stdout).toContain("prx phase");
    expect(stdout).toContain("prx snapshot");
    expect(stdout).toContain("prx statusline");
    expect(stdout).toContain("prx actions");
    expect(stdout).toContain("prx worktree refresh");
    // Deprecations surface in §8 section only. prx-rgr: `prx session open` /
    // `prx session plan` are retired (no longer registered); `prx open` /
    // `prx work` remain deprecation aliases.
    const tail = stdout.slice(depIdx);
    expect(tail).not.toContain("prx session open");
    expect(tail).toContain("prx open");
    expect(tail).toContain("prx work");
    // Internal entries hidden (§7 demotion):
    expect(stdout).not.toContain("prx sprint init");
  });

  test("commands alias prints the same catalog as help-all", () => {
    const all = runCli(["help-all"]);
    const alias = runCli(["commands"]);
    expect(all.exitCode).toBe(0);
    expect(alias.exitCode).toBe(0);
    expect(new TextDecoder().decode(all.stdout)).toBe(new TextDecoder().decode(alias.stdout));
  });

  test("work --help prints the session redirect map (prx-rgr)", () => {
    const result = runCli(["work", "--help"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    // prx-rgr: `prx session` is retired; the help is now a redirect map to the
    // canonical entries.
    expect(stdout).toContain("prx session (retired)");
    expect(stdout).toContain("prx plan session");
    expect(stdout).toContain("prx plan agent");
    expect(stdout).toContain("prx claude");
  });

  test("work GH-198 --help also prints the session redirect map (prx-rgr)", () => {
    const result = runCli(["work", "GH-198", "--help"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("prx session (retired)");
    expect(stdout).toContain("prx plan session");
  });

  test("--version prints a git-sha-based version", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath, "--version"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout).trim();
    expect(stdout).toMatch(/^git-[0-9a-f]{12}$|^git-unknown$/);
  });

  test("version subcommand prints the same version shape", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["version"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toMatch(/^git-[0-9a-f]{12}$|^git-unknown$/);
  });

  test("--version uses BAKED_GIT_SHA when set, even outside a git repo", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath, "--version"],
      cwd: "/tmp",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BAKED_GIT_SHA: "abc123def456" },
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout).trim();
    expect(stdout).toBe("git-abc123def456");
  });

  test("--version prefers BAKED_GIT_SHA over runtime git detection", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath, "--version"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BAKED_GIT_SHA: "deadbeef0000" },
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout).trim();
    expect(stdout).toBe("git-deadbeef0000");
  });

  function initTempGitRepo(prefix: string): string {
    const tmp = mkdtempSync(join(tmpdir(), prefix));
    Bun.spawnSync({ cmd: ["git", "init", tmp], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", tmp, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", tmp, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", tmp, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
    return tmp;
  }

  // prx-ktw: the `checkVersionUpstream` (local-checkout vs origin/main) tests
  // were removed with the function — `prx --version` is release-based now and
  // no longer reports repo-checkout distance.

  // prx-1ab: the binary self-check is release-based — it compares the baked
  // release tag to the newest local `v*` tag, not commit distance from
  // origin/main (which advanced every merged PR, so a just-released binary
  // always looked "behind").
  function tagRepo(prefix: string, tags: string[]): string {
    const tmp = initTempGitRepo(prefix);
    Bun.spawnSync({ cmd: ["git", "-C", tmp, "commit", "--allow-empty", "-m", "base"], stdout: "pipe", stderr: "pipe" });
    for (const t of tags) {
      // Annotated + unsigned: the dev/CI git config can force annotation
      // (`git tag <name>` → "no tag message?") and signing; `-m` + the inline
      // config make tag creation deterministic regardless of environment.
      Bun.spawnSync({
        cmd: ["git", "-C", tmp, "-c", "tag.gpgSign=false", "tag", "-m", t, t],
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    return tmp;
  }

  test("checkPrxBinaryUpstream flags a newer release than the baked version", () => {
    const tmp = tagRepo("prx-binary-behind-", ["v0.1.10", "v0.1.11", "v0.1.12"]);
    const result = checkPrxBinaryUpstream(tmp, "v0.1.10");
    expect(result).not.toBeNull();
    expect(result!.current).toBe("v0.1.10");
    expect(result!.latest).toBe("v0.1.12");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("checkPrxBinaryUpstream returns null when the baked version is the newest release", () => {
    const tmp = tagRepo("prx-binary-uptodate-", ["v0.1.10", "v0.1.12"]);
    expect(checkPrxBinaryUpstream(tmp, "v0.1.12")).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("checkPrxBinaryUpstream returns null when the baked version is unset (dev mode)", () => {
    // Dev mode: `bun run scripts/pr_state.ts` with no baked release version.
    expect(checkPrxBinaryUpstream(process.cwd(), undefined)).toBeNull();
    expect(checkPrxBinaryUpstream(process.cwd(), "")).toBeNull();
  });

  test("checkPrxBinaryUpstream returns null when the baked version is ahead of / unknown to local tags", () => {
    // The binary's tag isn't among the local release tags (newer, or local tags
    // are stale) — can't conclude it's behind, so stay silent.
    const tmp = tagRepo("prx-binary-ahead-", ["v0.1.10", "v0.1.12"]);
    expect(checkPrxBinaryUpstream(tmp, "v0.2.0")).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("checkPrxBinaryUpstream returns null outside a git repo", () => {
    expect(checkPrxBinaryUpstream("/tmp", "deadbeefcafe")).toBeNull();
  });

  test("checkPrxBinaryUpstream returns null when bakedSha is unknown to the repo", () => {
    // A sha from a different repo/build that this repo has no object for —
    // rev-list will fail, and we stay silent rather than scaring the user.
    const tmp = initTempGitRepo("prx-binary-unknown-sha-");
    Bun.spawnSync({ cmd: ["git", "-C", tmp, "commit", "--allow-empty", "-m", "head"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", tmp, "update-ref", "refs/remotes/origin/main", "HEAD"], stdout: "pipe", stderr: "pipe" });

    expect(checkPrxBinaryUpstream(tmp, "0000000000000000000000000000000000000000")).toBeNull();

    rmSync(tmp, { recursive: true, force: true });
  });

  test("prx session open emits a stderr warning when checkPrxBinaryUpstream reports a stale binary", async () => {
    // GH-528: end-to-end — the injected precheck fires via CliDeps and the
    // user sees a single warning line before the rest of session open runs.
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-binary-stale-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open","GH-5431", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...noOpWorktreeLockDeps,
        checkPrxBinaryUpstream: () => ({ current: "v0.1.10", latest: "v0.1.12" }),
        resolveWorkUnitCwd: () => cwd,
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(errors.some((line) =>
      line.includes("prx v0.1.10")
      && line.includes("newer release v0.1.12"),
    )).toBe(true);
  });

  test("prx session open is silent about the binary when checkPrxBinaryUpstream returns null", async () => {
    // Regression guard: no stale-binary line should appear when the binary
    // is up-to-date (or the check can't run).
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-binary-fresh-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    await runCliDirect(
      ["open","GH-5431", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...noOpWorktreeLockDeps,
        checkPrxBinaryUpstream: () => null,
        resolveWorkUnitCwd: () => cwd,
      },
    );
    process.chdir(previousCwd);

    expect(errors.some((line) => line.includes("prx binary is"))).toBe(false);
  });

  test("prx session open invokes hydrateBeads against the resolved launchCwd", async () => {
    // GH-647: session open must own dolt-db hydration for its target
    // worktree — otherwise claude launches with a MCP pointing at an
    // empty dolt server and every bd call inside the session fails.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-hydrate-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const hydrateCalls: Array<{ cwd?: string | undefined }> = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          hydrateBeads: (opts = {}) => {
            hydrateCalls.push({ cwd: opts.cwd });
            return {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "io_github_bdelanghe_ai_home",
              message: "beads: io_github_bdelanghe_ai_home already hydrated, skipping",
              exitCode: 0,
            };
          },
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(0);
    expect(hydrateCalls).toEqual([{ cwd }]);
  }, 15000);

  test("prx session open surfaces hydrate hydrated on stderr", async () => {
    // Happy path: after a successful fresh clone, hydrate returns
    // `status: "hydrated"` — session open echoes the message so the
    // operator can see that the target worktree just got its dolt db.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-hydrate-ok-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          hydrateBeads: () => ({
            status: "hydrated",
            doltRemote: "https://doltremoteapi.dolthub.com/example/repo",
            doltDatabase: "example_db",
            message: "beads: hydrated example_db from https://doltremoteapi.dolthub.com/example/repo",
            exitCode: 0,
          }),
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(errors.some((line) => line.includes("beads: hydrated example_db"))).toBe(true);
  }, 15000);

  test("prx session open surfaces hydrate clone-failed on stderr without aborting", async () => {
    // Clone failures (stale DoltHub token, offline, etc.) are logged but
    // must not block session entry — matches the lenient post-switch hook
    // semantics in src/beads/hydrate.ts.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-hydrate-fail-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          hydrateBeads: () => ({
            status: "clone-failed",
            doltRemote: "https://doltremoteapi.dolthub.com/example/repo",
            doltDatabase: "example_db",
            message: "beads: clone failed for https://doltremoteapi.dolthub.com/example/repo",
            exitCode: 0,
          }),
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(0);
    expect(errors.some((line) => line.includes("beads: clone failed"))).toBe(true);
  }, 15000);

  test("prx session open surfaces unexpected hydrate exceptions as warnings without aborting", async () => {
    // Defense in depth: if hydrateBeads throws (e.g., fs permission
    // error from mkdirSync), session open must log a warning and
    // continue — not let a beads side-effect block agent launch.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-hydrate-throw-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          hydrateBeads: () => {
            throw new Error("EACCES: permission denied, mkdir '.beads/dolt'");
          },
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(0);
    expect(errors.some((line) => line.includes("beads hydration failed unexpectedly") && line.includes("EACCES"))).toBe(true);
  }, 15000);

  test("prx session open stays silent when hydrate skips (no .beads, no metadata, already-hydrated)", async () => {
    // Regression guard: the only hydrate statuses that warrant stderr
    // output are "hydrated" (informational) and "clone-failed" (warning).
    // Skip statuses are silent.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-hydrate-skip-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          hydrateBeads: () => ({
            status: "skipped-no-metadata",
            doltRemote: null,
            doltDatabase: null,
            message: "beads: no readable .beads/metadata.json, skipping",
            exitCode: 0,
          }),
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(errors.some((line) => line.includes("beads:"))).toBe(false);
  }, 15000);

  test("prx session open emits a rebased line and no advisory warning when auto-rebase succeeds", async () => {
    // GH-704: clean rebase path — session open should announce "rebased N
    // commits onto origin/main" and NOT emit the old advisory warning.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-auto-rebase-ok-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const lines: string[] = [];
    const errors: string[] = [];
    let hydrateCalls = 0;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: (line) => lines.push(line), error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "rebased", behind: 3 }),
          hydrateBeads: () => {
            hydrateCalls += 1;
            return {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "example_db",
              message: "beads: already hydrated",
              exitCode: 0,
            };
          },
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(lines.some((line) => line.includes("rebased 3 commits onto origin/main"))).toBe(true);
    expect(errors.some((line) => line.includes("warning: branch is"))).toBe(false);
    expect(hydrateCalls).toBe(1);
  }, 15000);

  test("prx session open singularizes the rebased line for behind === 1", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-auto-rebase-singular-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const lines: string[] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: (line) => lines.push(line), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "rebased", behind: 1 }),
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(lines.some((line) => line.includes("rebased 1 commit onto origin/main"))).toBe(true);
  }, 15000);

  test("prx session open reports conflict resolution steps but still completes session open", async () => {
    // GH-704: on rebase conflict we leave the rebase in progress and
    // continue with hydrate / runtime artifacts so the agent lands in the
    // worktree ready to resolve.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-auto-rebase-conflict-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    let hydrateCalls = 0;
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({
            status: "conflict",
            conflicts: ["src/foo.ts", "src/bar.ts"],
          }),
          hydrateBeads: () => {
            hydrateCalls += 1;
            return {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "example_db",
              message: "beads: already hydrated",
              exitCode: 0,
            };
          },
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(0);
    expect(errors.some((line) => line.includes("rebase onto origin/main hit conflicts"))).toBe(true);
    expect(errors.some((line) => line.includes("src/foo.ts"))).toBe(true);
    expect(errors.some((line) => line.includes("src/bar.ts"))).toBe(true);
    expect(errors.some((line) => line.includes("git rebase --continue"))).toBe(true);
    expect(hydrateCalls).toBe(1);
  }, 15000);

  test("prx session open is silent when auto-rebase reports up_to_date", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-auto-rebase-uptodate-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const lines: string[] = [];
    const errors: string[] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: (line) => lines.push(line), error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "up_to_date" }),
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(lines.some((line) => line.includes("rebased"))).toBe(false);
    expect(errors.some((line) => line.includes("warning: branch is"))).toBe(false);
    expect(errors.some((line) => line.includes("auto-rebase skipped"))).toBe(false);
  }, 15000);

  test("prx session open surfaces the skip reason on stderr when auto-rebase skips", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-auto-rebase-skipped-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    let hydrateCalls = 0;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({
            status: "skipped",
            reason: "dirty worktree",
          }),
          hydrateBeads: () => {
            hydrateCalls += 1;
            return {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "example_db",
              message: "beads: already hydrated",
              exitCode: 0,
            };
          },
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(errors.some((line) =>
      line.includes("auto-rebase skipped") && line.includes("dirty worktree"),
    )).toBe(true);
    expect(hydrateCalls).toBe(1);
  }, 15000);

  test("prx session open refuses when launch worktree is on detached HEAD (plain mode)", async () => {
    // GH-1983: detached HEAD anchors the plan against an unnamed ref and
    // silently skips auto-rebase. The preflight in primePlanSession must
    // refuse before any rebase / hydrate work, with a structured stderr
    // hint and a non-zero exit.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-detached-plain-"));
    Bun.spawnSync({ cmd: ["git", "init", "-b", "main", cwd], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "commit", "--allow-empty", "-m", "init"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "checkout", "--detach", "HEAD"], stdout: "pipe", stderr: "pipe" });

    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const errors: string[] = [];
    let rebaseCalls = 0;
    let hydrateCalls = 0;
    let exitCode: number;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["open","GH-5431", "--dry-run"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          // GH-1983: noOpWorktreeLockDeps stubs the preflight to () => null
          // so most tests bypass it; here we override with the real helper
          // to actually exercise the refusal path against the detached worktree.
          assertWorktreeOnNamedBranch,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => {
            rebaseCalls += 1;
            return { status: "up_to_date" };
          },
          hydrateBeads: () => {
            hydrateCalls += 1;
            return {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "example_db",
              message: "beads: already hydrated",
              exitCode: 0,
            };
          },
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(exitCode).not.toBe(0);
    expect(errors.some((line) => line.includes("refusing to open plan session"))).toBe(true);
    expect(errors.some((line) => line.includes("detached HEAD"))).toBe(true);
    expect(errors.some((line) => line.includes("GH-5431"))).toBe(true);
    expect(errors.some((line) => line.includes("checkout GH-5431"))).toBe(true);
    expect(rebaseCalls).toBe(0);
    expect(hydrateCalls).toBe(0);
  }, 15000);

  test("prx session open emits the detached-HEAD refusal payload on stdout in --format=json mode", async () => {
    // GH-1983: machine-readable refusal payload. JSON mode emits the
    // structured DetachedHeadRefusal record on stdout so callers can branch
    // on `reason: "detached_head"` without parsing the warning string.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-detached-json-"));
    Bun.spawnSync({ cmd: ["git", "init", "-b", "main", cwd], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "commit", "--allow-empty", "-m", "init"], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", cwd, "checkout", "--detach", "HEAD"], stdout: "pipe", stderr: "pipe" });

    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const lines: string[] = [];
    let exitCode: number;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["open","GH-5431", "--dry-run", "--format", "json"],
        { log: (line) => lines.push(line), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          // GH-1983: override the noOp stub with the real helper so the
          // refusal payload reflects the real detached-HEAD state.
          assertWorktreeOnNamedBranch,
          resolveWorkUnitCwd: () => cwd,
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(exitCode).not.toBe(0);
    const payloadLine = lines.find((line) => line.includes('"reason"'));
    expect(payloadLine).toBeDefined();
    const payload = JSON.parse(payloadLine!);
    expect(payload.status).toBe("blocked");
    expect(payload.reason).toBe("detached_head");
    expect(payload.expectedBranch).toBe("GH-5431");
    expect(payload.launchCwd).toBe(cwd);
    expect(payload.recoveryHint).toContain("checkout GH-5431");
  }, 15000);

  test("autoRebaseOnSessionOpen rebases a local branch onto origin/main against a real bare remote", () => {
    // GH-704: integration-style happy path with a real remote so we exercise
    // the fetch → diverge → rebase flow end-to-end.
    const remote = mkdtempSync(join(tmpdir(), "prx-auto-rebase-remote-"));
    const local = mkdtempSync(join(tmpdir(), "prx-auto-rebase-local-"));
    try {
      Bun.spawnSync({ cmd: ["git", "init", "--bare", remote], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "init", "-b", "main", local], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "remote", "add", "origin", remote], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "base"], stdout: "pipe", stderr: "pipe" });
      const baseSha = new TextDecoder().decode(
        Bun.spawnSync({ cmd: ["git", "-C", local, "rev-parse", "HEAD"], stdout: "pipe" }).stdout,
      ).trim();
      Bun.spawnSync({ cmd: ["git", "-C", local, "push", "-u", "origin", "main"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "remote-only-1"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "remote-only-2"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "push", "origin", "main"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "checkout", "-b", "GH-704-test", baseSha], stdout: "pipe", stderr: "pipe" });

      const result = autoRebaseOnSessionOpen(local);
      if (result.status !== "rebased") {
        throw new Error(`expected rebased, got ${JSON.stringify(result)}`);
      }
      expect(result.behind).toBe(2);

      const divergence = new TextDecoder().decode(
        Bun.spawnSync({
          cmd: ["git", "-C", local, "rev-list", "--left-right", "--count", "HEAD...origin/main"],
          stdout: "pipe",
        }).stdout,
      ).trim();
      expect(divergence).toBe("0\t0");
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  }, 30000);

  test("autoRebaseOnSessionOpen with skipFetch=true does not contact the remote", () => {
    // GH-704: when the caller has already fetched (session-open's
    // pruneStaleRemoteRefs), auto-rebase should rebase against the cached
    // origin/main ref without performing a second network fetch. We simulate
    // "no remote" after caching origin/main so a second fetch would fail — if
    // the helper still rebases cleanly, skipFetch is honored.
    const remote = mkdtempSync(join(tmpdir(), "prx-auto-rebase-skipfetch-remote-"));
    const local = mkdtempSync(join(tmpdir(), "prx-auto-rebase-skipfetch-local-"));
    try {
      Bun.spawnSync({ cmd: ["git", "init", "--bare", remote], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "init", "-b", "main", local], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "remote", "add", "origin", remote], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "base"], stdout: "pipe", stderr: "pipe" });
      const baseSha = new TextDecoder().decode(
        Bun.spawnSync({ cmd: ["git", "-C", local, "rev-parse", "HEAD"], stdout: "pipe" }).stdout,
      ).trim();
      Bun.spawnSync({ cmd: ["git", "-C", local, "push", "-u", "origin", "main"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "remote-only"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "push", "origin", "main"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "checkout", "-b", "feat", baseSha], stdout: "pipe", stderr: "pipe" });
      // Break the remote so a fetch would fail. If skipFetch is honored,
      // rebase still proceeds against the cached origin/main ref.
      rmSync(remote, { recursive: true, force: true });

      const result = autoRebaseOnSessionOpen(local, { skipFetch: true });
      if (result.status !== "rebased") {
        throw new Error(`expected rebased with skipFetch, got ${JSON.stringify(result)}`);
      }
      expect(result.behind).toBe(1);
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  }, 30000);

  test("autoRebaseOnSessionOpen returns skipped (not conflict) when rebase fails without unmerged paths", () => {
    // GH-704 (Copilot feedback): rebase can fail for reasons other than
    // merge conflicts (missing upstream, hook error, etc.). Those must not
    // surface as "conflict" — the resolution guidance would be wrong.
    // Setup: a feat branch with a real divergence from origin/main, then a
    // pre-rebase hook that exits non-zero so git rebase fails cleanly
    // without producing unmerged paths.
    const local = mkdtempSync(join(tmpdir(), "prx-auto-rebase-hook-fail-"));
    try {
      Bun.spawnSync({ cmd: ["git", "init", "-b", "main", local], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "base"], stdout: "pipe", stderr: "pipe" });
      const baseSha = new TextDecoder().decode(
        Bun.spawnSync({ cmd: ["git", "-C", local, "rev-parse", "HEAD"], stdout: "pipe" }).stdout,
      ).trim();
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "remote-only"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "update-ref", "refs/remotes/origin/main", "HEAD"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "checkout", "-b", "feat", baseSha], stdout: "pipe", stderr: "pipe" });
      // Install a pre-rebase hook that always fails.
      const hookPath = `${local}/.git/hooks/pre-rebase`;
      writeFileSync(hookPath, "#!/bin/sh\necho 'pre-rebase hook rejected' 1>&2\nexit 1\n", { mode: 0o755 });

      const result = autoRebaseOnSessionOpen(local, { skipFetch: true });
      if (result.status !== "skipped") {
        throw new Error(`expected skipped, got ${JSON.stringify(result)}`);
      }
      expect(result.reason).toContain("git rebase failed");
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }, 30000);

  test("autoRebaseOnSessionOpen recovers a stale index.lock and still rebases (prx-0yf)", () => {
    // The live foot-gun: a crashed sibling git left an index.lock behind, so the
    // rebase aborts with "Unable to create '<path>/index.lock': File exists" and
    // session-open warns "auto-rebase skipped". With lock recovery the stale lock
    // is cleared + the rebase retried, so a clean divergence still rebases.
    // lockHolders is injected ([] = unheld) so recovery does not depend on lsof.
    const local = mkdtempSync(join(tmpdir(), "prx-auto-rebase-stale-lock-"));
    try {
      Bun.spawnSync({ cmd: ["git", "init", "-b", "main", local], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "base"], stdout: "pipe", stderr: "pipe" });
      const baseSha = new TextDecoder().decode(
        Bun.spawnSync({ cmd: ["git", "-C", local, "rev-parse", "HEAD"], stdout: "pipe" }).stdout,
      ).trim();
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "remote-only"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "update-ref", "refs/remotes/origin/main", "HEAD"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "checkout", "-b", "feat", baseSha], stdout: "pipe", stderr: "pipe" });
      // Plant a stale lock exactly where git would create it.
      const lockPath = join(local, ".git", "index.lock");
      writeFileSync(lockPath, "");

      const result = autoRebaseOnSessionOpen(local, {
        skipFetch: true,
        lockRecovery: { lockHolders: () => [] }, // unheld ⇒ safe to clear
      });
      if (result.status !== "rebased") {
        throw new Error(`expected rebased after lock recovery, got ${JSON.stringify(result)}`);
      }
      expect(result.behind).toBe(1);
      expect(existsSync(lockPath)).toBe(false); // the stale lock was cleared
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }, 30000);

  test("autoRebaseOnSessionOpen skips with 'protected branch' when on main", () => {
    const remote = mkdtempSync(join(tmpdir(), "prx-auto-rebase-protected-remote-"));
    const local = mkdtempSync(join(tmpdir(), "prx-auto-rebase-protected-local-"));
    try {
      Bun.spawnSync({ cmd: ["git", "init", "--bare", remote], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "init", "-b", "main", local], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.name", "test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "user.email", "test@test"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "config", "commit.gpgsign", "false"], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "remote", "add", "origin", remote], stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync({ cmd: ["git", "-C", local, "commit", "--allow-empty", "-m", "init"], stdout: "pipe", stderr: "pipe" });

      const result = autoRebaseOnSessionOpen(local);
      if (result.status !== "skipped") {
        throw new Error(`expected skipped, got ${JSON.stringify(result)}`);
      }
      expect(result.reason).toContain("protected branch");
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  }, 30000);

  test("prx session open routes the rebased line to stderr in --format=json mode", async () => {
    // GH-704 (Copilot feedback): the rebased line on stdout corrupts the
    // machine-readable JSON payload emitted later. In json mode it must go
    // to stderr instead.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-auto-rebase-json-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const lines: string[] = [];
    const errors: string[] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["open","GH-5431", "--dry-run", "--format", "json"],
        { log: (line) => lines.push(line), error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "rebased", behind: 2 }),
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(lines.some((line) => line.includes("rebased 2 commits onto origin/main"))).toBe(false);
    expect(errors.some((line) => line.includes("rebased 2 commits onto origin/main"))).toBe(true);
  }, 15000);

  test("interactiveTimeoutMs returns undefined for plain format (interactive sessions are not timed out)", () => {
    expect(interactiveTimeoutMs("plain", 30000)).toBeUndefined();
  });

  test("interactiveTimeoutMs returns the policy timeout for json format (automated runs are timed out)", () => {
    expect(interactiveTimeoutMs("json", 30000)).toBe(30000);
  });

  test("open sends the canonical work-unit runtime profile into the tmux agent pane and materializes local runtime files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["open", "gh-5431"],
      {
        log: () => {},
        error: () => {},
      },
      {
        ...issueBackedWorkDeps("GH-5431"),
        muxRunner: mux.runner,
        attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
        resolveWorkUnitCwd: () => cwd,
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    // GH-834: canonical entry routes through session-open-claude (direct-exec).
    // No send-keys; claude argv lands in the new-session trailing tokens.
    const sendKeys = mux.invocations.filter((inv) => inv[3] === "send-keys");
    expect(sendKeys).toHaveLength(0);
    const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
    expect(newSession).toBeDefined();
    const nIdx = newSession!.indexOf("-n");
    const afterWindow = newSession!.slice(nIdx + 2);
    // GH-685 interactive shape: no bound-agent flags, no --print.
    expect(afterWindow[0]).toBe("claude");
    expect(afterWindow).toContain("--permission-mode");
    expect(afterWindow).toContain("plan");
    expect(afterWindow).toContain("--append-system-prompt");
    expect(afterWindow).toContain("--strict-mcp-config");
    expect(afterWindow).toContain("--mcp-config");
    // GH-1147: plan profile passes --allowedTools / --disallowedTools as
    // capability-layer enforcement.
    expect(afterWindow).toContain("--allowedTools");
    expect(afterWindow).toContain("--disallowedTools");
    expect(afterWindow).not.toContain("--agent");
    expect(afterWindow).not.toContain("--agents");
    expect(afterWindow).not.toContain("--tools");
    expect(afterWindow).not.toContain("--json-schema");
    expect(afterWindow).not.toContain("--output-format");
    expect(afterWindow).not.toContain("--print");
    // Session CWD is what resolveWorkUnitCwd returned; asserts the
    // `new-session -c <cwd>` path the tmux driver emits.
    expect(mux.newSessionCwd()).toBe(cwd);
    // Runtime artifacts are still generated (consumed by automation paths:
    // agent-smoke, task run, role start — not by the interactive profile).
    expect(existsSync(join(cwd, ".pr/local/runtime/agents.json"))).toBe(true);
    expect(existsSync(join(cwd, ".pr/local/runtime/mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".pr/local/runtime/output.schema.json"))).toBe(true);
    const agentsConfig = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/agents.json"), "utf8"));
    const outputSchema = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/output.schema.json"), "utf8"));
    expect(agentsConfig["GH-5431"].prompt).toContain("xstate-system-ts");
    expect(agentsConfig["GH-5431"].prompt).toContain("Zod schemas");
    expect(agentsConfig["GH-5431"].prompt).toContain("JSON schema boundaries");
    expect(outputSchema.type).toBe("object");
    expect(outputSchema.properties.workUnitId.pattern).toBe(
      "^(GH-\\d+|NOTION-([0-9a-fA-F]{32}|\\d+)|BD-[0-9A-F]{8}|BD-[a-z][a-z0-9-]*-\\d{13,}-\\d+-[0-9a-f]{8})$",
    );
    expect(outputSchema.properties.phase.enum).toContain("ready_to_merge");
    expect(outputSchema.properties.parityChain).toBeDefined();
    expect(outputSchema.properties.modelBoundary).toBeDefined();
    expect(outputSchema.properties.implementationPlan).toBeDefined();
    expect(outputSchema.properties.verification).toBeDefined();
    expect(outputSchema.properties.role.enum).toEqual(taskAgentRoles);
    expect(outputSchema.required).toEqual([...runtimeRequiredFields]);
  });

  test("session open-claude exec's claude as pane PID 1 via new-session trailing argv (GH-819)", async () => {
    // GH-819: open-claude skips the shell + bootstrap.sh send-keys
    // indirection. The tmux `new-session` call itself carries the claude
    // argv as trailing tokens, so tmux execs claude directly and the
    // pane's PID 1 is claude — no shell parent.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-open-claude-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    let exitCode: number;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      const mux = captureMuxInvocations();
      exitCode = await runCliDirect(
        ["claude", "GH-5431"],
        { log: () => {}, error: () => {} },
        {
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      expect(exitCode).toBe(0);

      // No send-keys replay — the whole point.
      const sendKeys = mux.invocations.filter((inv) => inv[3] === "send-keys");
      expect(sendKeys).toHaveLength(0);

      // new-session carries the claude argv as trailing shell-command tokens.
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2); // after `-n worktree`
      expect(afterWindow[0]).toBe("claude");
      expect(afterWindow).toContain("--permission-mode");
      expect(afterWindow).toContain("plan");
      expect(afterWindow).toContain("--append-system-prompt");
      expect(afterWindow).toContain("--strict-mcp-config");
      expect(afterWindow).toContain("--name");
      expect(afterWindow).toContain("GH-5431");
      // Negative: none of the automation-shape flags leak into the interactive argv.
      expect(afterWindow).not.toContain("--agent");
      expect(afterWindow).not.toContain("--agents");
      expect(afterWindow).not.toContain("--tools");
      expect(afterWindow).not.toContain("--print");

      // remain-on-exit=failed: pane sticks around as [exited] only on
      // non-zero claude exit; clean /exit closes the pane (GH-856).
      const remainOnExit = mux.invocations.find(
        (inv) => inv[3] === "set-window-option" && inv.includes("remain-on-exit"),
      );
      expect(remainOnExit).toBeDefined();
      expect(remainOnExit!).toContain("failed");

      // session CWD is the resolved launchCwd.
      expect(mux.newSessionCwd()).toBe(cwd);

      // Runtime artifacts are still generated (MCP config, agents.json, etc.).
      expect(existsSync(join(cwd, ".pr/local/runtime/mcp.json"))).toBe(true);
      // bootstrap.sh is still written as a side artifact for manual replay,
      // even though the pane itself does not source it.
      expect(existsSync(join(cwd, ".pr/local/runtime/bootstrap.sh"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }
  }, 15000);

  test("session open-claude --dry-run prints the interactive runtime profile without spawning tmux (GH-819)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-open-claude-dry-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const logs: string[] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      const mux = captureMuxInvocations();
      const exitCode = await runCliDirect(
        ["claude", "GH-5431", "--dry-run"],
        { log: (line) => logs.push(line), error: () => {} },
        {
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          resolveWorkUnitCwd: () => cwd,
        },
      );
      expect(exitCode).toBe(0);
      // No tmux IPC at all under --dry-run.
      expect(mux.invocations).toHaveLength(0);
      // The printed profile matches the same interactive shape used by
      // `session open` (claude, --permission-mode plan, etc.).
      const combined = logs.join("\n");
      expect(combined).toContain("claude");
      expect(combined).toContain("--permission-mode");
      expect(combined).toContain("plan");
      expect(combined).toContain("--append-system-prompt");
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }
  }, 15000);

  test("work alias emits a deprecation warning on stderr before launching", async () => {
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-deprecation-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const exitCode = await runCliDirect(
      ["work", "gh-5431"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        ...issueBackedWorkDeps("GH-5431"),
        resolveWorkUnitCwd: () => cwd,
        lockWorktree: () => {},
        unlockWorktree: () => {},
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(errors.some((line) => line.includes("deprecated") && line.includes("prx work"))).toBe(true);
    expect(errors.some((line) => line.includes("session open"))).toBe(true);
  });

  describe("prx open (session entry)", () => {
    // `runCli` spawns `bun run scripts/pr_state.ts` — same entrypoint as production `prx` / `bun run pr-state`.

    test("open --help prints the same session help as work --help", () => {
      const openResult = runCli(["open", "--help"]);
      const workResult = runCli(["work", "--help"]);
      expect(openResult.exitCode).toBe(0);
      expect(workResult.exitCode).toBe(0);
      const openStdout = new TextDecoder().decode(openResult.stdout);
      const workStdout = new TextDecoder().decode(workResult.stdout);
      expect(openStdout).toBe(workStdout);
      // prx-rgr: both print the retired-session redirect map.
      expect(openStdout).toContain("prx session (retired)");
      expect(openStdout).toContain("prx plan session");
    });

    test("open GH-198 --help prints the session redirect map when id precedes --help", () => {
      const result = runCli(["open", "GH-198", "--help"]);
      expect(result.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(result.stdout);
      expect(stdout).toContain("prx session (retired)");
      expect(stdout).toContain("prx claude");
    });

    test("open subcommand runs through scripts/pr_state.ts and rejects invalid ids", () => {
      const result = runCli(["open", "!!!"]);
      expect(result.exitCode).toBe(1);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toContain("open must match CANONICAL-ID format");
    });

    test("help in a non-git tmpdir does not fail (canonical-ID helpers are lazy)", () => {
      // GH-594 review feedback: runCli must not eagerly call `git rev-parse`
      // for help/version/other non-repo commands. Running `prx help` outside
      // any git repo should print help cleanly.
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-help-nogit-"));
      const result = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath, "help"],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(result.stdout);
      expect(stdout).toContain("prx tui");
      expect(stdout).toContain("Primary workflow:");
    });

    test("open PROD-6688 is rejected with default prx.toml (no [identity] section)", () => {
      // GH-594 baseline: without a configured canonical_id_pattern, non-GH
      // prefixes must still be rejected with the existing error shape.
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-default-"));
      Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root });
      const result = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath, "open", "PROD-6688"],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(1);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toContain("must match CANONICAL-ID format");
    });

    test("open PROD-<n> passes the parse gate when prx.toml sets canonical_id_pattern", () => {
      // GH-594: per-repo pluggable canonical-ID pattern unblocks demo-web and
      // other non-GitHub-Issues-canonical repos. GH-1421: the pattern is now
      // declared on a [sources.<name>] block; the parse gate must accept
      // PROD-6688 once the registry includes a matching pattern.
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-product-"));
      Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root });
      writeFileSync(
        join(root, "prx.toml"),
        [
          "[sources.github]",
          'kind = "github"',
          'canonical_id_pattern = "^(GH|PROD)-\\\\d+$"',
          "",
        ].join("\n"),
      );
      const result = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath, "open", "PROD-6688", "--dry-run", "--format", "json"],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).not.toContain("must match CANONICAL-ID format");
    });

    test("open surfaces malformed canonical_id_pattern regex from prx.toml", () => {
      // GH-594: a typoed regex in prx.toml should fail loud rather than
      // silently fall back — users want to catch their config errors.
      const root = mkdtempSync(join(tmpdir(), "pr-state-identity-malformed-"));
      Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root });
      writeFileSync(
        join(root, "prx.toml"),
        [
          "[sources.github]",
          'kind = "github"',
          'canonical_id_pattern = "^(GH|PROD"',
          "",
        ].join("\n"),
      );
      const result = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath, "open", "GH-1"],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(1);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toContain("canonical_id_pattern is not a valid regex");
    });

    test("open does not emit work deprecation on stderr when launching", async () => {
      const errors: string[] = [];
      const cwd = mkdtempSync(join(tmpdir(), "pr-state-open-no-depr-"));
      const previousCwd = process.cwd();
      process.chdir(cwd);
      const exitCode = await runCliDirect(
        ["open", "gh-5431"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          lockWorktree: () => {},
          unlockWorktree: () => {},
          execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
        },
      );
      process.chdir(previousCwd);

      expect(exitCode).toBe(0);
      expect(errors.some((line) => line.includes("deprecated"))).toBe(false);
    });

    test("open produces the claude dry-run json profile", async () => {
      // prx-rgr: the old `prx session <id>` shorthand arm of this comparison is
      // retired (it errors now). `prx open` keeps the parseSessionOpenCommand
      // behavior and resolves to the claude runtime profile under --dry-run.
      const logs: string[] = [];
      const cwd = mkdtempSync(join(tmpdir(), "pr-state-open-dry-json-"));
      const previousCwd = process.cwd();
      process.chdir(cwd);
      const code = await runCliDirect(
        ["open", "GH-5431", "--dry-run", "--format", "json"],
        {
          log: (line) => logs.push(line),
          error: () => {},
        },
        {
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      process.chdir(previousCwd);
      expect(code).toBe(0);
      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]!) as { command?: string };
      expect(parsed.command).toBe("claude");
    });

    test("invalid work unit id for open surfaces the open label in the error", async () => {
      const errors: string[] = [];
      const exitCode = await runCliDirect(
        ["open", "!!!"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        noOpWorktreeLockDeps,
      );
      expect(exitCode).toBe(1);
      expect(errors.some((line) => line.includes("open must match CANONICAL-ID format"))).toBe(true);
    });
  });

  test("session open propagates the tmux attach exit status (GH-678)", async () => {
    // Replaces the prior "work releases the worktree lock when runtime
    // execution fails" test: under the tmux persistence layer (GH-678)
    // session-open no longer holds a git worktree lock around an inner
    // execRuntime call. The mux session's presence on the socket is the
    // liveness signal instead (Slice 3a). This test asserts the post-mux
    // invariant: whatever tmux attach returns is what `prx session open`
    // returns.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-attach-"));
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["open", "GH-5431"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...issueBackedWorkDeps("GH-5431"),
        resolveWorkUnitCwd: () => cwd,
        attachRunner: () => ({ status: 130, stdout: "", stderr: "" }),
      },
    );

    expect(exitCode).toBe(130);
  });

  test("work --check prints machine-derived task status without launching runtime", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-check-"));
    const worktree = join(cwd, "GH-5431");
    mkdirSync(join(worktree, ".pr", "local"), { recursive: true });
    writeTaskContract(
      join(worktree, ".pr", "local", "task.json"),
      createTaskContract({
        workUnitId: "GH-5431",
        worktree,
      }),
    );

    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--check"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        ...issueBackedWorkDeps("GH-5431"),
        inspectSessionOpenState: () => ({
          workUnitId: "GH-5431",
          localBranch: "present",
          remoteBranch: "present",
          worktreePath: worktree,
          taskContract: "present",
          task: loadTaskContract(join(worktree, ".pr", "local", "task.json")),
        }),
        resolveWorkUnitCwd: () => {
          throw new Error("--check must not resolve/materialize the worktree");
        },
        execRuntime: () => {
          throw new Error("work --check must not launch runtime");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("workUnit=GH-5431");
    expect(logs[0]!).toContain("localBranch=present");
    expect(logs[0]!).toContain(`worktreePath=${worktree}`);
    expect(logs[0]!).toContain("taskContract=present");
    expect(logs[0]!).toContain("machine=planning");
    expect(logs[0]!).toContain("handoff=blocked");
  });

  test("work --check reports missing task contract without failing (GH-549)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-check-missing-"));
    const worktree = join(cwd, "GH-5480");
    mkdirSync(worktree, { recursive: true });

    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-5480", "--check"],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
      {
        ...issueBackedWorkDeps("GH-5480"),
        inspectSessionOpenState: () => ({
          workUnitId: "GH-5480",
          localBranch: "present",
          remoteBranch: "present",
          worktreePath: worktree,
          taskContract: "missing",
        }),
        resolveWorkUnitCwd: () => {
          throw new Error("--check must not resolve/materialize the worktree");
        },
        execRuntime: () => {
          throw new Error("work --check must not launch runtime");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("workUnit=GH-5480");
    expect(logs[0]!).toContain("taskContract=missing");
  });

  test("work --check reports remote-only branch state without materializing (GH-549)", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-5431", "--check"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        ...issueBackedWorkDeps("GH-5431"),
        inspectSessionOpenState: () => ({
          workUnitId: "GH-5431",
          localBranch: "absent",
          remoteBranch: "present",
          worktreePath: null,
          taskContract: "not-applicable",
        }),
        materializeWorktree: () => {
          throw new Error("--check must not materialize a worktree");
        },
        resolveWorkUnitCwd: () => {
          throw new Error("--check must not resolve the worktree");
        },
        execRuntime: () => {
          throw new Error("work --check must not launch runtime");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("workUnit=GH-5431");
    expect(logs[0]!).toContain("localBranch=absent");
    expect(logs[0]!).toContain("remoteBranch=present");
    expect(logs[0]!).toContain("worktreePath=none");
    expect(logs[0]!).toContain("taskContract=not-applicable");
  });

  test("work --check emits JSON inspection report with --format=json (GH-549)", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-5431", "--check", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        ...issueBackedWorkDeps("GH-5431"),
        inspectSessionOpenState: () => ({
          workUnitId: "GH-5431",
          localBranch: "absent",
          remoteBranch: "absent",
          worktreePath: null,
          taskContract: "not-applicable",
        }),
        resolveWorkUnitCwd: () => {
          throw new Error("--check must not resolve the worktree");
        },
        execRuntime: () => {
          throw new Error("work --check must not launch runtime");
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as {
      workUnitId: string;
      localBranch: string;
      remoteBranch: string;
      worktreePath: string | null;
      taskContract: string;
      taskStatus: unknown;
    };
    expect(parsed.workUnitId).toBe("GH-5431");
    expect(parsed.localBranch).toBe("absent");
    expect(parsed.remoteBranch).toBe("absent");
    expect(parsed.worktreePath).toBeNull();
    expect(parsed.taskContract).toBe("not-applicable");
    expect(parsed.taskStatus).toBeNull();
  });

  test("ensureLocalRuntimeArtifacts never writes a beads MCP server (GH-1587)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-mcp-artifacts-"));

    // No Notion auth → mcp.json is an empty server map and the status object
    // reports no MCP servers. The `beads` actor is `kind: cli`; prx sessions
    // reach it via `prx tools bd` / the `bd-safe` wrapper, never an MCP server.
    const status = ensureLocalRuntimeArtifacts("GH-5431", cwd, { notionIdentity: null });

    const agents = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/agents.json"), "utf8"));
    const parsed = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/mcp.json"), "utf8"));
    const outputSchema = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/output.schema.json"), "utf8"));
    expect(status).toEqual({ mcpServers: [] });
    expect(parsed).toEqual({ mcpServers: {} });
    expect(parsed.mcpServers.beads).toBeUndefined();
    expect(agents["GH-5431"].prompt).toContain("executor agent");
    expect(agents["GH-5431-planner"].prompt).toContain("planner agent");
    expect(agents["GH-5431-tester"].prompt).toContain("tester agent");
    expect(agents["GH-5431-reviewer"].prompt).toContain("reviewer agent");
    expect(outputSchema.properties.modelBoundary.properties.actors.items.enum).toContain("executor_agent");
  });

  test("ensureLocalRuntimeArtifacts injects notion MCP server when auth is notion-cli", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-mcp-notion-cli-"));
    const status = ensureLocalRuntimeArtifacts("PROJ-1", cwd, {
      notionIdentity: { auth: "notion-cli", databaseId: null, idProperty: null, titleProperty: null, statusProperty: null, tokenOpRef: null },
    });
    const parsed = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/mcp.json"), "utf8"));
    expect(parsed.mcpServers.notion).toEqual({ type: "http", url: "https://mcp.notion.com/mcp" });
    expect(parsed.mcpServers.beads).toBeUndefined();
    expect(status).toEqual({ mcpServers: ["notion"] });
  });

  test("ensureLocalRuntimeArtifacts injects notion MCP server when auth is claude-mcp", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-mcp-claude-mcp-"));
    ensureLocalRuntimeArtifacts("PROD-1", cwd, {
      notionIdentity: { auth: "claude-mcp", databaseId: null, idProperty: null, titleProperty: null, statusProperty: null, tokenOpRef: null },
    });
    const parsed = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/mcp.json"), "utf8"));
    expect(parsed.mcpServers.notion).toEqual({ type: "http", url: "https://mcp.notion.com/mcp" });
  });

  test("ensureLocalRuntimeArtifacts does not inject notion MCP server when auth is rest", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-mcp-rest-"));
    ensureLocalRuntimeArtifacts("GH-1", cwd, {
      notionIdentity: { auth: "rest", databaseId: null, idProperty: null, titleProperty: null, statusProperty: null, tokenOpRef: null },
    });
    const parsed = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/mcp.json"), "utf8"));
    expect(parsed.mcpServers.notion).toBeUndefined();
  });

  test("ensureLocalRuntimeArtifacts does not inject notion MCP server when notionIdentity is null", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-mcp-no-notion-"));
    ensureLocalRuntimeArtifacts("GH-1", cwd, {
      notionIdentity: null,
    });
    const parsed = JSON.parse(readFileSync(join(cwd, ".pr/local/runtime/mcp.json"), "utf8"));
    expect(parsed.mcpServers.notion).toBeUndefined();
  });

  test("work --prompt keeps print-mode flags and appends --print prompt (GH-678: via tmux agent-pane bootstrap)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-prompt-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--prompt", "summarize current state"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        muxRunner: mux.runner,
        resolveWorkUnitCwd: () => cwd,
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    const bootstrap = mux.bootstrapCommand();
    expect(bootstrap).not.toBeNull();
    expect(bootstrap!).toContain("--json-schema");
    expect(bootstrap!).toContain("--output-format");
    expect(bootstrap!).toContain("--print");
    expect(bootstrap!).toContain("summarize current state");
    expect(bootstrap!).not.toContain("--continue");
  });

  test("work --agent codex launches the codex runner (GH-678: via tmux agent-pane bootstrap)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-codex-"));
    const codexHome = mkdtempSync(join(tmpdir(), "pr-state-codex-home-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--agent", "codex"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => cwd,
        muxRunner: mux.runner,
      },
    );
    process.env.CODEX_HOME = previousCodexHome;

    expect(exitCode).toBe(0);
    const bootstrap = mux.bootstrapCommand();
    expect(bootstrap).not.toBeNull();
    // The command is `codex` launched as the agent-pane bootstrap.
    expect(bootstrap!).toMatch(/(^|\s)codex(\s|$)/);
    expect(bootstrap!).toContain("-s");
    expect(bootstrap!).toContain("workspace-write");
    expect(bootstrap!).toContain("-a");
    expect(bootstrap!).toContain("on-request");
    expect(bootstrap!).toContain("GH-5431");
  });

  test("findSavedCodexSession returns the newest session for the worktree", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "pr-state-find-codex-session-"));
    const launchCwd = "/repo/GH-5431";
    mkdirSync(join(codexHome, "sessions", "2026", "04", "17"), { recursive: true });
    writeFileSync(
      join(codexHome, "sessions", "2026", "04", "17", "rollout-older.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019-old",
          cwd: launchCwd,
          timestamp: "2026-04-17T10:00:00.000Z",
        },
      })}\n`,
    );
    writeFileSync(
      join(codexHome, "sessions", "2026", "04", "17", "rollout-newer.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019-new",
          cwd: launchCwd,
          timestamp: "2026-04-17T11:00:00.000Z",
        },
      })}\n`,
    );

    expect(findSavedCodexSession("GH-5431", launchCwd, codexHome)).toEqual({
      id: "019-new",
      cwd: launchCwd,
      timestamp: "2026-04-17T11:00:00.000Z",
    });
  });

  test("work --agent codex resumes the saved session for the worktree (GH-678: via tmux agent-pane bootstrap)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-codex-resume-"));
    const codexHome = mkdtempSync(join(tmpdir(), "pr-state-work-codex-home-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    mkdirSync(join(codexHome, "sessions", "2026", "04", "17"), { recursive: true });
    writeFileSync(
      join(codexHome, "sessions", "2026", "04", "17", "rollout-2026-04-17T11-00-00-019abc.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019abc",
          cwd,
          timestamp: "2026-04-17T11:00:00.000Z",
        },
      })}\n`,
    );

    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--agent", "codex"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => cwd,
        muxRunner: mux.runner,
      },
    );
    process.env.CODEX_HOME = previousCodexHome;

    expect(exitCode).toBe(0);
    const bootstrap = mux.bootstrapCommand();
    expect(bootstrap).not.toBeNull();
    expect(bootstrap!).toContain("resume");
    expect(bootstrap!).toContain("-s");
    expect(bootstrap!).toContain("workspace-write");
    expect(bootstrap!).toContain("-a");
    expect(bootstrap!).toContain("on-request");
    expect(bootstrap!).toContain("019abc");
    expect(bootstrap!).toContain("GH-5431");
  });

  test("work rejects non execution-grade agents", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--agent", "copilot"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        ...noOpWorktreeLockDeps,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Execution workflows currently support: claude, codex");
  });

  test("agent-smoke runs compliance checks for execution-grade agents", async () => {
    const logs: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-agent-smoke-"));
    const executed: Array<{ command: string; args: string[] }> = [];

    const exitCode = await runCliDirect(
      ["agent-smoke", "GH-5431", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => cwd,
        ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
        execRuntime: (profile) => {
          executed.push({ command: profile.command, args: profile.args });
          const prompt = profile.args[profile.args.length - 1] ?? "";
          if (typeof prompt === "string" && prompt.includes("echo:hello")) {
            return { status: 0, stdout: "{\"status\":\"success\",\"data\":{\"echo\":\"hello\"},\"meta\":{\"latency_ms\":1}}", stderr: "" };
          }
          if (typeof prompt === "string" && prompt.includes("Return EXACT JSON")) {
            return { status: 0, stdout: "{\"status\":\"success\",\"data\":{\"echo\":\"hello\"},\"meta\":{\"latency_ms\":1}}", stderr: "" };
          }
          if (typeof prompt === "string" && prompt.includes("wait 60 seconds then respond")) {
            return { status: 124, stdout: "", stderr: "timed out" };
          }
          return { status: 1, stdout: "", stderr: "unexpected prompt" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(executed).toHaveLength(6);
    expect(new Set(executed.map((entry) => entry.command))).toEqual(new Set([
      "claude",
      "codex",
    ]));
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.workUnitId).toBe("GH-5431");
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.map((entry: { agent: string }) => entry.agent)).toEqual([
      "claude",
      "codex",
    ]);
    expect(parsed.results.every((entry: { compliant: boolean }) => entry.compliant)).toBeTrue();
    expect(parsed.policy.allowed_agents).toEqual(["claude", "codex"]);
    expect(parsed.results[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.results[0]!.output_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("role start launches a role-specific Gemini profile", () => {
    let executed: { command: string; args: string[]; env?: Record<string, string> | undefined } | null = null;
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-start-gemini-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );

    const exitCode = runCliDirect(
      ["role", "start", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "planner", "--agent", "gemini"],
      {
        log: () => {},
        error: () => {},
      },
      {
        execRuntime: (profile) => {
          executed = {
            command: profile.command,
            args: profile.args,
            env: profile.env,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.command).toBe("gemini");
    expect(executed!.env?.PRX_AGENT_ROLE).toBe("planner");
    expect(executed!.args[0]).toBe("-p");
    expect(executed!.args[1]).toContain("/plan");
    expect(executed!.args[1]).toContain("planner agent");
  });

  test("role start rejects executor until planner confirmations are true", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-start-executor-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );
    const before = readFileSync(taskPath, "utf8");

    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["role", "start", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "executor"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        execRuntime: () => {
          throw new Error("executor should not start when confirmations are missing");
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "Cannot start executor:",
      "- spec not synced",
      "- scope not confirmed",
      "- success criteria not confirmed",
    ]);
    expect(readFileSync(taskPath, "utf8")).toBe(before);
  });

  test("work --agent codex --prompt uses codex exec with schema output (GH-678: via tmux agent-pane bootstrap)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-codex-prompt-"));

    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--agent", "codex", "--prompt", "summarize current state"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => cwd,
        muxRunner: mux.runner,
      },
    );

    expect(exitCode).toBe(0);
    const bootstrap = mux.bootstrapCommand();
    expect(bootstrap).not.toBeNull();
    expect(bootstrap!).toMatch(/(^|\s)codex(\s|$)/);
    expect(bootstrap!).toContain("exec");
    expect(bootstrap!).toContain("-s");
    expect(bootstrap!).toContain("workspace-write");
    expect(bootstrap!).toContain("--output-schema");
    expect(bootstrap!).toContain(".pr/local/runtime/output.schema.json");
    expect(bootstrap!).toContain("--json");
    expect(bootstrap!).toContain("summarize current state");
  });

  test("work --dry-run prints the exact executed command", async () => {
    const logs: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-dry-run-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--dry-run"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        ...issueBackedWorkDeps("GH-5431"),
        execRuntime: () => {
          throw new Error("should not execute in dry-run mode");
        },
        resolveWorkUnitCwd: () => cwd,
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("claude");
    // GH-685: default claude path is now the interactive profile (no bound-agent flags).
    expect(logs[0]!).toContain("--permission-mode");
    expect(logs[0]!).toContain("plan");
    expect(logs[0]!).toContain("--append-system-prompt");
    expect(logs[0]!).not.toContain("--json-schema");
    expect(logs[0]!).not.toContain("--agent");
    expect(logs[0]!).not.toContain(".pr/local/runtime/agents.json");
  });

  test("session plan default: non-interactive --print shape, no --continue, no TTY wait", async () => {
    let executed: { command: string; args: string[]; cwd?: string | undefined } | null = null;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-plan-default-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session","GH-5431"],
        {
          log: () => {},
          error: () => {},
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => {
            throw new Error("non-interactive path must not probe for a prior claude session");
          },
          execRuntime: (profile, _format, runtimeCwd) => {
            executed = { command: profile.command, args: profile.args, cwd: runtimeCwd };
            return { status: 0, stdout: "## Plan\n- step\n", stderr: "" };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(executed).not.toBeNull();
      expect(executed!.command).toBe("claude");
      expect(executed!.args).toContain("--print");
      expect(executed!.args).toContain("--output-format");
      expect(executed!.args).toContain("text");
      expect(executed!.args).toContain("--permission-mode");
      expect(executed!.args).toContain("plan");
      expect(executed!.args).toContain("--append-system-prompt");
      expect(executed!.args).toContain("--strict-mcp-config");
      expect(executed!.args).toContain("--mcp-config");
      expect(executed!.args).not.toContain("--continue");
      expect(executed!.args).not.toContain("--agent");
      expect(executed!.args).not.toContain("--agents");
      expect(executed!.args).not.toContain("--tools");
      expect(executed!.args).not.toContain("--allowedTools");
      expect(executed!.args).not.toContain("--json-schema");
      const promptIdx = executed!.args.indexOf("--append-system-prompt");
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(executed!.args[promptIdx + 1]).toContain("planner");
      expect(executed!.args[promptIdx + 1]).toContain("GH-5431");
      const userPrompt = executed!.args[executed!.args.length - 1] ?? "";
      expect(userPrompt).toContain("GH-5431");
      expect(userPrompt.toLowerCase()).toContain("plan");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // prx-rgr: the `prx session plan --interactive` inline-execRuntime tests were
  // removed — that path is unreachable now (`prx session plan` is retired, and
  // canonical `prx plan session --interactive` routes through the tmux pane via
  // parseSessionOpenCommand, covered by the `prx open` / `prx claude` tests).

  test("session plan --dry-run prints the resolved profile without executing", async () => {
    const logs: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-plan-dry-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session","GH-5431", "--dry-run"],
        {
          log: (line) => logs.push(line),
          error: () => {},
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => {
            throw new Error("should not execute in dry-run mode");
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(logs[0]!).toContain("claude");
      expect(logs[0]!).toContain("--permission-mode");
      expect(logs[0]!).toContain("plan");
      expect(logs[0]!).not.toContain("--continue");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("session plan emits a framed diagnostic when claude exits non-zero", async () => {
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-plan-fail-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session","GH-5431"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => ({ status: 1, stdout: "", stderr: "boom from claude" }),
        },
      );
      expect(exitCode).toBe(1);
      const framed = errors.find((line) => line.startsWith("prx plan session: claude exited"));
      expect(framed).toBeDefined();
      expect(framed!).toContain("boom from claude");
      expect(framed!).toContain("mode=print");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("session plan requires a work-unit id", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "session"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      { ...noOpWorktreeLockDeps },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("prx plan session requires a work-unit id");
  });

  // GH-1164: `prx plan session` (canonical) defaults to the non-interactive
  // print path, chaining stdout into `prx plan save --slot draft` so the
  // planner-handoff artifact lands in the CAS slot `prx implement agent` consumes.
  // GH-1982: the deprecated alias `prx session plan` now matches the chain
  // behavior — see the alias / canonical tests further down for parity.
  test("plan session (canonical) default: non-interactive print + saves draft slot via runPlanSave", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    let executed: { args: string[] } | null = null;
    let saved: { unit: string; slot: string; content: string } | null = null;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-chain-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431"],
        {
          log: (line) => logs.push(line),
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (profile, _format, _runtimeCwd) => {
            executed = { args: profile.args };
            return {
              status: 0,
              stdout: "## Scope\n- do the thing\n",
              stderr: "",
            };
          },
          runPlanSave: async (input) => {
            saved = {
              unit: input.unit,
              slot: input.slot,
              content: typeof input.content === "string" ? input.content : input.content.toString("utf8"),
            };
            return { sha: "deadbeef", ref: `${input.unit}:plan@${input.slot}`, body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(executed).not.toBeNull();
      expect(executed!.args).toContain("--print");
      expect(executed!.args).toContain("--permission-mode");
      expect(saved).not.toBeNull();
      expect(saved!.unit).toBe("GH-5431");
      expect(saved!.slot).toBe("draft");
      expect(saved!.content).toContain("## Scope");
      // prx-j4a: the result is now emitted to stdout, framed input→output.
      const planLine = logs.find((line) => line.includes("plan: GH-5431"));
      expect(planLine).toBeDefined();
      expect(planLine!).toContain("→ GH-5431:plan@draft");
      expect(planLine!).toContain("validated=true");
      // The plan body is the output artifact in the slot (asserted above via
      // `saved.content`) — it is NOT dumped to stdout anymore (prx-j4a).
      expect(logs.some((line) => line.includes("## Scope"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session (canonical) --interactive: opts into tmux session and skips runPlanSave chain", async () => {
    let executed: { args: string[] } | null = null;
    let saveCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-interactive-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        // `--skip-preflight` keeps the GH-1239 preflight from shelling out
        // to `gh issue view` in the mocked-world fixture; orthogonal to the
        // chain assertion this test is exercising.
        ["plan", "session", "GH-5431", "--interactive", "--skip-preflight"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (profile) => {
            executed = { args: profile.args };
            return { status: 0, stdout: "## Scope\n- x\n", stderr: "" };
          },
          runPlanSave: async () => {
            saveCalls += 1;
            return { sha: "deadbeef", ref: "GH-5431:plan@draft", body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] };
          },
        },
      );
      expect(exitCode).toBe(0);
      // `--interactive` routes through the session-open-claude direct-exec
      // path (tmux pane PID 1) — no --print, no runPlanSave chain.
      expect(saveCalls).toBe(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      // Interactive path may go through tmux without calling execRuntime
      // directly (mux runner handles spawn). If execRuntime *was* called,
      // assert the interactive (no --print) shape; either way no chain ran.
      const ex = executed as { args: string[] } | null;
      if (ex) {
        expect(ex.args).not.toContain("--print");
      }
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // GH-2014: --background skips attachMuxSession and prints a re-entry hint
  test("plan session (canonical) --background: skips tmux attach + emits re-entry hint", async () => {
    let attachCalls = 0;
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-background-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-2014", "--interactive", "--skip-preflight", "--background"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-2014"),
          muxRunner: mux.runner,
          attachRunner: () => {
            attachCalls += 1;
            return { stdout: "", stderr: "", status: 0 };
          },
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
        },
      );
      expect(exitCode).toBe(0);
      // The mux session must still be spawned (so a follow-up re-entry can
      // reuse it) — `--background` only suppresses the attach step.
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      expect(attachCalls).toBe(0);
      const hint = errors.find((line) => line.includes("session booted in background"));
      expect(hint).toBeDefined();
      expect(hint).toContain("prx plan session GH-2014");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // GH-2014: --detached is a typed refusal pointing at --background
  test("plan session (canonical) --detached: typed refusal pointing at --background", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "session", "GH-2014", "--detached"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        ...noOpWorktreeLockDeps,
      },
    );
    expect(exitCode).not.toBe(0);
    const refusal = errors.find((line) => line.includes("--detached") && line.includes("--background"));
    expect(refusal).toBeDefined();
  });

  test("plan session (canonical) default: empty stdout skips draft save with a stderr warning", async () => {
    const errors: string[] = [];
    let saveCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-empty-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
          runPlanSave: async () => {
            saveCalls += 1;
            return { sha: "deadbeef", ref: "GH-5431:plan@draft", body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(saveCalls).toBe(0);
      const warning = errors.find((line) =>
        line.startsWith("prx plan session:") && line.includes("no plan content"),
      );
      expect(warning).toBeDefined();
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session (canonical) default: shape-failing body still persists — validated_ok=false narrated, exit 0 (GH-2028)", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-refusal-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431"],
        {
          log: (line) => logs.push(line),
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => ({
            status: 0,
            stdout: "no scope section here\n",
            stderr: "",
          }),
          // GH-2028: persist-on-failure — the save no longer throws; it lands
          // the body with validated_ok=false so the operator can recover it.
          runPlanSave: async () => ({
            sha: `sha256:${"a".repeat(64)}`,
            ref: "GH-5431:plan@draft",
            body_sha: `sha256:${"b".repeat(64)}`,
            envelope_sha: `sha256:${"a".repeat(64)}`,
            validated_ok: false,
            diagnostics: [
              { code: "no-scope", path: "## Scope", message: "missing ## Scope section" },
            ],
          }),
        },
      );
      expect(exitCode).toBe(0);
      // prx-j4a: real state is surfaced via the emitted result — the draft slot
      // WAS saved (never "not saved"); validated=false routes the operator to the
      // viewer rather than dumping diagnostics.
      const planLine = logs.find((line) => line.includes("plan:"));
      expect(planLine).toBeDefined();
      expect(planLine!).toContain("validated=false");
      expect(planLine!).toContain("view: prx plan show");
      expect(logs.concat(errors).join("\n")).not.toContain("not saved");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session --check --format json on not-yet-materialized branch emits JSON envelope to stderr (GH-2067)", async () => {
    // GH-2067: the not-yet-materialized branch threw a plain-text CliError
    // before this fix, so `--format json` consumers (canonical=bd hydration
    // smoke, automated retry branches) couldn't parse the result. The
    // throw-site / envelope shape is exercised at the unit level in
    // test/machine/session_open.test.ts (prxSessionNotProjectedLocallyEnvelope);
    // this test pins the catch-site interception at the CLI layer that
    // promotes the envelope to a stderr JSON blob. We drive the throw via
    // the validateGitHubIssue seam (the deps surface for readGitHubIssue
    // inside checkWorkUnitChain) — the catch interception is keyed on the
    // CliError carrying `details`, not on which throw-site produced it.
    const errors: string[] = [];
    const resolvedFixture = {
      id: "BD-AAAAAAAA",
      title: "supply_plan_output: add filters",
      body: null,
      state: "open" as const,
      url: "https://example.test/BD-AAAAAAAA",
      source: "beads" as const,
    };
    const envelope = prxSessionNotProjectedLocallyEnvelope("BD-AAAAAAAA", resolvedFixture);
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-not-projected-json-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-9999", "--check", "--format", "json"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          pruneStaleRemoteRefs: () => {},
          boardStatus: () => ({
            source: "derived-board" as const,
            repo: "owner/repo",
            remote_freshness: "fresh" as const,
            units: [],
          }),
          buildParityChain: () => ({
            source: "surface-sync" as const,
            repo: "owner/repo",
            mode: "full" as const,
            authority: "issue" as const,
            scope: "all" as const,
            apply: false,
            units: [],
            actions: [],
          }),
          validateGitHubIssue: () => {
            throw new CliError(envelope.message, 1, envelope);
          },
        },
      );

      expect(exitCode).toBe(1);
      const jsonBlob = errors.find((line) => line.trim().startsWith("{"));
      expect(jsonBlob).toBeDefined();
      const parsed = JSON.parse(jsonBlob!) as {
        error: PrxSessionNotProjectedLocallyDetails;
        exitCode: number;
      };
      expect(parsed.error.code).toBe("PRX_SESSION_NOT_PROJECTED_LOCALLY");
      expect(parsed.error.workUnitId).toBe("BD-AAAAAAAA");
      expect(parsed.error.source).toBe("beads");
      expect(parsed.error.title).toBe("supply_plan_output: add filters");
      expect(parsed.error.url).toBe("https://example.test/BD-AAAAAAAA");
      expect(parsed.error.message).toContain("has no local parity-chain unit yet");
      expect(parsed.error.suggestedNextCommands).toEqual([
        "prx chain backfill --authority issue --scope all",
        "prx plan agent BD-AAAAAAAA --create",
      ]);
      expect(parsed.exitCode).toBe(1);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session --check on not-yet-materialized branch keeps plain-text stderr unchanged (GH-2067)", async () => {
    // Mirror of the JSON envelope test above — verifies the catch
    // interception skips when --format is plain. handleRunCliError emits
    // the prose message unchanged, byte-for-byte with pre-2067 stderr.
    const errors: string[] = [];
    const resolvedFixture = {
      id: "BD-AAAAAAAA",
      title: "supply_plan_output",
      body: null,
      state: "open" as const,
      url: "https://example.test/BD-AAAAAAAA",
      source: "beads" as const,
    };
    const envelope = prxSessionNotProjectedLocallyEnvelope("BD-AAAAAAAA", resolvedFixture);
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-not-projected-plain-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-9999", "--check"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          pruneStaleRemoteRefs: () => {},
          boardStatus: () => ({
            source: "derived-board" as const,
            repo: "owner/repo",
            remote_freshness: "fresh" as const,
            units: [],
          }),
          buildParityChain: () => ({
            source: "surface-sync" as const,
            repo: "owner/repo",
            mode: "full" as const,
            authority: "issue" as const,
            scope: "all" as const,
            apply: false,
            units: [],
            actions: [],
          }),
          validateGitHubIssue: () => {
            throw new CliError(envelope.message, 1, envelope);
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(errors.some((line) => line.includes("Cannot open PRX session for BD-AAAAAAAA"))).toBe(true);
      expect(errors.some((line) => line.includes("has no local parity-chain unit yet"))).toBe(true);
      expect(errors.every((line) => !line.trim().startsWith("{"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session (canonical) --dry-run: prints profile and skips runPlanSave chain", async () => {
    const logs: string[] = [];
    let saveCalls = 0;
    let executed = false;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-dryrun-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--dry-run"],
        {
          log: (line) => logs.push(line),
          error: () => {},
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => {
            executed = true;
            throw new Error("should not execute in dry-run");
          },
          runPlanSave: async () => {
            saveCalls += 1;
            return { sha: "deadbeef", ref: "GH-5431:plan@draft", body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(executed).toBe(false);
      expect(saveCalls).toBe(0);
      expect(logs[0]!).toContain("--print");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session (canonical) accepts --create / --no-verify / --from / --skip-preflight flags at parse time", async () => {
    const errors: string[] = [];
    let executed = false;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-flags-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        [
          "plan",
          "session",
          "GH-5431",
          "--create",
          "--from",
          "github",
          "--no-verify",
          "--skip-preflight",
          "--dry-run",
        ],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          materializeWorktree: () => {},
          execRuntime: () => {
            executed = true;
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(executed).toBe(false);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // GH-1825: `--timeout` is opt-in (no baked-in default) and `--resume-from-draft`
  // continues a previously cancelled run by threading the prior partial capture
  // into the planner prompt.
  test("plan session --timeout=30s threads 30000ms watchdog into the executor", async () => {
    let capturedTimeoutMs: number | undefined;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-timeout-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--timeout=30s"],
        {
          log: () => {},
          error: () => {},
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (_profile, _format, _runtimeCwd, timeoutMs) => {
            capturedTimeoutMs = timeoutMs;
            return { status: 0, stdout: "## Scope\n- x\n", stderr: "" };
          },
          runPlanSave: async (input) => ({ sha: "deadbeef", ref: `${input.unit}:plan@${input.slot}`, body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] }),
        },
      );
      expect(exitCode).toBe(0);
      expect(capturedTimeoutMs).toBe(30_000);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session --timeout=5m threads 300000ms watchdog into the executor", async () => {
    let capturedTimeoutMs: number | undefined;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-timeout-min-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--timeout=5m"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (_p, _f, _c, timeoutMs) => {
            capturedTimeoutMs = timeoutMs;
            return { status: 0, stdout: "## Scope\n- x\n", stderr: "" };
          },
          runPlanSave: async (input) => ({ sha: "deadbeef", ref: `${input.unit}:plan@${input.slot}`, body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] }),
        },
      );
      expect(exitCode).toBe(0);
      expect(capturedTimeoutMs).toBe(300_000);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session without --timeout passes no watchdog to the executor (no baked-in default)", async () => {
    let executorCalls = 0;
    let capturedTimeoutMs: number | undefined | "unset" = "unset";
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-no-timeout-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (_p, _f, _c, timeoutMs) => {
            executorCalls += 1;
            capturedTimeoutMs = timeoutMs;
            return { status: 0, stdout: "## Scope\n- x\n", stderr: "" };
          },
          runPlanSave: async (input) => ({ sha: "deadbeef", ref: `${input.unit}:plan@${input.slot}`, body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] }),
        },
      );
      expect(exitCode).toBe(0);
      expect(executorCalls).toBe(1);
      expect(capturedTimeoutMs).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session --timeout=abc rejects with a parse error", async () => {
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-timeout-bad-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--timeout=abc"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
        },
      );
      expect(exitCode).not.toBe(0);
      expect(errors.some((line) => line.includes("--timeout"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // prx-rgr: removed "session plan --interactive --timeout is rejected" — the
  // guard only fired on the retired `prx session plan --interactive` legacy verb
  // (canonical `prx plan session --interactive` routes through a different
  // parser), so it is now unreachable.

  test("plan session --resume-from-draft threads the prior partial into the planner user prompt", async () => {
    const partial = "## Scope (partial draft)\n- prior step 1\n- prior step 2\n";
    let executed: { args: string[] } | null = null;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-resume-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--resume-from-draft"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          runPlanLoad: async (input) => ({
            sha: "deadbeef",
            content: Buffer.from(partial, "utf8"),
            slot: input.slot,
            fellBackToDraft: false,
            validated_ok: true,
            diagnostics: [],
          }),
          execRuntime: (profile) => {
            executed = { args: profile.args };
            return { status: 0, stdout: "## Scope\n- full plan\n", stderr: "" };
          },
          runPlanSave: async (input) => ({ sha: "cafebabe", ref: `${input.unit}:plan@${input.slot}`, body_sha: "cafebabe", envelope_sha: "cafebabe", validated_ok: true, diagnostics: [] }),
        },
      );
      expect(exitCode).toBe(0);
      expect(executed).not.toBeNull();
      const userPrompt = executed!.args[executed!.args.length - 1] ?? "";
      expect(userPrompt).toContain("Continue drafting the implementation plan for GH-5431");
      expect(userPrompt).toContain("prior step 1");
      expect(userPrompt).toContain("prior step 2");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session --resume-from-draft against a missing draft slot raises a typed refusal", async () => {
    const errors: string[] = [];
    let executorCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-resume-missing-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--resume-from-draft"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          runPlanLoad: async (input) => {
            const { PlanRefNotFound } = await import("../../src/plan-store/verbs.ts");
            throw new PlanRefNotFound(input.unit, input.slot);
          },
          execRuntime: () => {
            executorCalls += 1;
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(exitCode).not.toBe(0);
      expect(executorCalls).toBe(0);
      expect(errors.some((line) => line.includes("no draft slot for GH-5431"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("plan session --resume-from-draft against an empty draft slot raises a typed refusal", async () => {
    const errors: string[] = [];
    let executorCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-resume-empty-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431", "--resume-from-draft"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          runPlanLoad: async (input) => ({
            sha: "deadbeef",
            content: Buffer.from("   \n  ", "utf8"),
            slot: input.slot,
            fellBackToDraft: false,
            validated_ok: true,
            diagnostics: [],
          }),
          execRuntime: () => {
            executorCalls += 1;
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(exitCode).not.toBe(0);
      expect(executorCalls).toBe(0);
      expect(errors.some((line) => line.includes("is empty"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("alias `prx session plan` fires the runPlanSave chain (GH-1982 footgun fix)", async () => {
    // GH-1982: alias path now sets `invokedViaPlanSession: true` so the
    // print-mode stdout chains into the `<UoW>:plan@draft` CAS slot — the
    // same slot `prx implement` consumes. Previously the alias silently
    // dropped the save, leaving operators with an empty draft.
    let saveCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-plan-alias-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session","GH-5431"],
        {
          log: () => {},
          error: () => {},
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => ({ status: 0, stdout: "## Scope\n- x\n", stderr: "" }),
          runPlanSave: async () => {
            saveCalls += 1;
            return { sha: "deadbeef", ref: "GH-5431:plan@draft", body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(saveCalls).toBe(1);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // prx-rgr: removed "alias `prx session plan` emits PRX_SESSION_PLAN_ALIAS_HINT"
  // — `prx session plan` is retired (it errors now), so the alias hint can no
  // longer fire. The canonical no-hint behavior is still asserted below.

  test("canonical `prx plan session` does NOT emit the alias hint (GH-1982)", async () => {
    const { PRX_SESSION_PLAN_ALIAS_HINT } = await import(
      "../../src/machine/session_open.ts"
    );
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-session-canonical-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session", "GH-5431"],
        {
          log: () => {},
          error: (line) => errors.push(line),
        },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: () => ({ status: 0, stdout: "## Scope\n- x\n", stderr: "" }),
          runPlanSave: async () => ({ sha: "deadbeef", ref: "GH-5431:plan@draft", body_sha: "deadbeef", envelope_sha: "deadbeef", validated_ok: true, diagnostics: [] }),
        },
      );
      expect(exitCode).toBe(0);
      expect(errors).not.toContain(PRX_SESSION_PLAN_ALIAS_HINT);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("findSavedClaudeSession detects a non-empty jsonl under ~/.claude/projects/<slug>/", () => {
    const home = mkdtempSync(join(tmpdir(), "pr-state-claude-home-"));
    const launchCwd = "/repo/worktrees/gh_999_x";
    const slug = "-repo-worktrees-gh_999_x";
    const projectDir = join(home, ".claude", "projects", slug);
    mkdirSync(projectDir, { recursive: true });
    expect(findSavedClaudeSession(launchCwd, home)).toBe(false);
    writeFileSync(join(projectDir, "abc.jsonl"), "{}\n");
    expect(findSavedClaudeSession(launchCwd, home)).toBe(true);
  });

  test("session open --agent claude (no prompt) routes through the direct-exec path — no send-keys replay (GH-834)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-claude-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["open","GH-5431", "--agent", "claude"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
        },
      );
      expect(exitCode).toBe(0);
      // GH-834: canonical entry now forwards to the session-open-claude
      // runner, so tmux execs claude directly (pane PID 1) and no
      // `. .pr/local/runtime/bootstrap.sh` line is typed via send-keys.
      const sendKeys = mux.invocations.filter((inv) => inv[3] === "send-keys");
      expect(sendKeys).toHaveLength(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2); // after `-n <window>`
      expect(afterWindow[0]).toBe("claude");
      // GH-685 interactive shape: --permission-mode plan + --append-system-prompt,
      // no bound-agent / --print flags. GH-1147: plan profile now adds
      // --allowedTools / --disallowedTools for toolset-layer enforcement.
      expect(afterWindow).toContain("--permission-mode");
      expect(afterWindow).toContain("plan");
      expect(afterWindow).toContain("--append-system-prompt");
      expect(afterWindow).toContain("--strict-mcp-config");
      expect(afterWindow).toContain("--mcp-config");
      expect(afterWindow).toContain("--allowedTools");
      expect(afterWindow).toContain("--disallowedTools");
      expect(afterWindow).not.toContain("--continue");
      expect(afterWindow).not.toContain("--agent");
      expect(afterWindow).not.toContain("--agents");
      expect(afterWindow).not.toContain("--tools");
      expect(afterWindow).not.toContain("--json-schema");
      expect(afterWindow).not.toContain("--output-format");
      expect(afterWindow).not.toContain("--print");
      // GH-1147: planner-role prompt carries both the role binding and the
      // work-unit identity through --append-system-prompt's argument.
      const appendIdx = afterWindow.indexOf("--append-system-prompt");
      expect(appendIdx).toBeGreaterThanOrEqual(0);
      const systemPrompt = afterWindow[appendIdx + 1]!;
      expect(systemPrompt).toContain("planner");
      expect(systemPrompt).toContain("GH-5431");
      // bootstrap.sh is still written as a side artifact for manual replay.
      expect(existsSync(join(cwd, ".pr/local/runtime/bootstrap.sh"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("session open GH-<id> (no flags) routes through the direct-exec path — claude is the default agent (GH-834)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-default-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["open","GH-5431"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
        },
      );
      expect(exitCode).toBe(0);
      const sendKeys = mux.invocations.filter((inv) => inv[3] === "send-keys");
      expect(sendKeys).toHaveLength(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2);
      expect(afterWindow[0]).toBe("claude");
      expect(afterWindow).toContain("--append-system-prompt");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("session open --agent claude (no prompt) resume appends --continue on the pane argv (GH-834)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-claude-resume-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["open","GH-5431", "--agent", "claude"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => true,
        },
      );
      expect(exitCode).toBe(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2);
      expect(afterWindow).toContain("--continue");
      expect(afterWindow).not.toContain("--agent");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("session open --agent claude --prompt stays on the print-mode automation path (bound-agent flags intact)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-claude-prompt-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["open","GH-5431", "--agent", "claude", "--prompt", "hi"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      expect(exitCode).toBe(0);
      const bootstrap = mux.bootstrapCommand();
      expect(bootstrap).not.toBeNull();
      // Print-mode: agents.json bound flags are present, and --print <prompt> is appended.
      expect(bootstrap!).toContain("--agent ");
      expect(bootstrap!).toContain("--tools ");
      expect(bootstrap!).toContain("--print");
      expect(bootstrap!).toContain(" hi");
      expect(bootstrap!).not.toContain("--append-system-prompt");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("session open --plan PATH suffixes the system prompt with 'Execute the plan at <path>.' (GH-1044)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-plan-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["open","GH-5431", "--plan", "/tmp/plan.md"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
        },
      );
      expect(exitCode).toBe(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2);
      const appendIdx = afterWindow.indexOf("--append-system-prompt");
      expect(appendIdx).toBeGreaterThanOrEqual(0);
      const systemPrompt = afterWindow[appendIdx + 1]!;
      expect(systemPrompt.endsWith("Execute the plan at /tmp/plan.md.")).toBe(true);
      // GH-1147: canonical session-open builds the planner profile (read-only
      // allowlist); operator ratchets to Edit/Write from inside claude.
      expect(systemPrompt).toContain("planner");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("session open --plan combined with --check is rejected as a CliError (GH-1044)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-plan-check-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const errors: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["open","GH-5431", "--plan", "/tmp/plan.md", "--check"],
        { log: () => {}, error: (m: string) => errors.push(m) },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      expect(exitCode).not.toBe(0);
      expect(errors.join("\n")).toContain("--plan is only supported on the canonical claude path");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("prx implement agent GH-<id> --plan PATH dispatches through session-open-claude with plan injected (GH-1044)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-plan-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431", "--plan", "/tmp/plan.md", "--interactive"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
        },
      );
      expect(exitCode).toBe(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2);
      expect(afterWindow[0]).toBe("claude");
      const appendIdx = afterWindow.indexOf("--append-system-prompt");
      expect(appendIdx).toBeGreaterThanOrEqual(0);
      const systemPrompt = afterWindow[appendIdx + 1]!;
      expect(systemPrompt.endsWith("Execute the plan at /tmp/plan.md.")).toBe(true);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("prx implement agent --headless --dry-run resolves the headless SDK profile (step 2b-i)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-headless-dry-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const logs: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431", "--plan", "/tmp/plan.md", "--headless", "--dry-run", "--format", "json"],
        { log: (l) => logs.push(l), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
        },
      );
      expect(exitCode).toBe(0);
      const profile = JSON.parse(logs.join("\n"));
      expect(profile.command).toBe("claude");
      expect(profile.interaction).toBe("headless");
      expect(profile.agentRuntime).toBe("sdk");
      expect(profile.sdkSpec.permissionMode).toBe("acceptEdits");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("prx implement agent --headless runs the SDK job and spawns no tmux session (step 2b-i)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-headless-run-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const logs: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431", "--plan", "/tmp/plan.md", "--headless"],
        { log: (l) => logs.push(l), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          // The headless branch routes through executeAgentProfile; the
          // execRuntime seam stands in for the SDK so the test stays offline.
          execRuntime: () => ({ status: 0, stdout: "implemented", stderr: "" }),
        },
      );
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain("implemented");
      // Headless = no tmux: no new-session was spawned.
      expect(mux.invocations.find((inv) => inv[3] === "new-session")).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("prx implement agent default runs the headless SDK job in-process, no tmux (step 2b-ii)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-default-headless-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const logs: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431", "--plan", "/tmp/plan.md"],
        { log: (l) => logs.push(l), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          // Default (no --interactive) runs the headless SDK job in-process and
          // awaits it; the execRuntime seam stands in for the SDK offline.
          execRuntime: () => ({ status: 0, stdout: "implemented", stderr: "" }),
        },
      );
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain("implemented");
      // Default is no longer tmux: nothing spawned a session.
      expect(mux.invocations.find((inv) => inv[3] === "new-session")).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("prx implement agent GH-<id> without --plan auto-primes from the saved draft slot (GH-1238)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-noplan-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const planBody = "## Scope\n\n- Implement the thing.\n";
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431", "--interactive"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          runPlanShow: async () => ({
            unit: "GH-5431",
            slot: "draft" as const,
            sha: "fakesha" as never,
            size: planBody.length,
            body: Buffer.from(planBody),
            validated_ok: true,
            diagnostics: [],
          }),
        },
      );
      expect(exitCode).toBe(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2);
      // GH-1287: when claude supports --append-system-prompt-file (typical case
      // on this dev machine), the auto-primed body is written to disk and
      // passed by path. Read the file to verify the body. Otherwise (older
      // claude binaries / CI), the fallback path inlines a short directive that
      // tells the agent to load the plan via dispatch (GH-1530 PR-6).
      const fileFlagIdx = afterWindow.indexOf("--append-system-prompt-file");
      if (fileFlagIdx >= 0) {
        const promptPath = afterWindow[fileFlagIdx + 1]!;
        const fileBody = readFileSync(promptPath, "utf8");
        expect(fileBody).not.toContain("Execute the plan at");
        expect(fileBody).toContain("Implement the thing.");
        expect(fileBody).toContain("Saved plan (slot=draft):");
        expect(afterWindow).not.toContain("--append-system-prompt");
      } else {
        const inlineIdx = afterWindow.indexOf("--append-system-prompt");
        expect(inlineIdx).toBeGreaterThanOrEqual(0);
        const inline = afterWindow[inlineIdx + 1]!;
        expect(inline).toContain("prx implement dispatch --actor=plan -- show GH-5431");
        expect(inline).not.toContain("Implement the thing.");
      }
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  test("prx implement agent refuses to attach when called from inside a plan-mode tmux session (GH-1172)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-refuse-"));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const previousCtx = process.env.PRX_SESSION_CONTEXT;
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    // Simulate "we are running inside a plan-mode tmux session" — the
    // session-entry machine sets PRX_SESSION_CONTEXT=plan when it dispatches
    // OPEN_PLAN_SESSION, and the operator's TTY carries TMUX from tmux itself.
    process.env.TMUX = "/tmp/fake-tmux,1,0";
    process.env.PRX_SESSION_CONTEXT = "plan";
    const errors: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      // Refuses with the same status code prune-session uses for its
      // self-destruct guard, and emits a fresh-shell handoff.
      expect(exitCode).toBe(2);
      const errorBlob = errors.join("\n");
      expect(errorBlob).toContain("refused");
      expect(errorBlob).toContain("Run from a fresh shell");
      expect(errorBlob).toContain("prx implement agent GH-5431");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previousCtx === undefined) delete process.env.PRX_SESSION_CONTEXT;
      else process.env.PRX_SESSION_CONTEXT = previousCtx;
    }
  });

  test("prx implement agent opens an implement-tagged tmux session distinct from plan (GH-1172)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-tagged-"));
    const previousCwd = process.cwd();
    const previousCtx = process.env.PRX_SESSION_CONTEXT;
    delete process.env.PRX_SESSION_OPEN;
    delete process.env.PRX_SESSION_CONTEXT;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const planBody = "## Scope\n\n- Implement the thing.\n";
    try {
      const exitCode = await runCliDirect(
        ["implement", "agent", "GH-5431", "--interactive"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          // GH-1238: provide a draft slot so auto-prime succeeds; this test
          // is about tmux tagging and the executor allow/deny shape, not
          // the refusal contract.
          runPlanShow: async () => ({
            unit: "GH-5431",
            slot: "draft" as const,
            sha: "fakesha" as never,
            size: planBody.length,
            body: Buffer.from(planBody),
            validated_ok: true,
            diagnostics: [],
          }),
        },
      );
      expect(exitCode).toBe(0);
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
      // The session name carries the `-implement` mode suffix so it coexists
      // with a same-worktree plan session.
      const sIdx = newSession!.indexOf("-s");
      const sessionName = newSession![sIdx + 1]!;
      expect(sessionName.endsWith("-implement")).toBe(true);
      // The pane argv also pins claude `--name GH-5431` so /resume picks it up.
      const nIdx = newSession!.indexOf("-n");
      const afterWindow = newSession!.slice(nIdx + 2);
      expect(afterWindow[0]).toBe("claude");
      // The implement profile must enable Edit/Write at the flag layer —
      // that's the bug GH-1172 fixes.
      const allowedIdx = afterWindow.indexOf("--allowedTools");
      expect(allowedIdx).toBeGreaterThanOrEqual(0);
      const allowedTools = afterWindow[allowedIdx + 1]!.split(",");
      expect(allowedTools).toContain("Edit");
      expect(allowedTools).toContain("Write");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
      if (previousCtx === undefined) delete process.env.PRX_SESSION_CONTEXT;
      else process.env.PRX_SESSION_CONTEXT = previousCtx;
    }
  }, 15000);

  test("prx implement <id> (flat, GH-1981) rejects with removal error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-flat-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const errors: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement", "GH-5431"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      expect(exitCode).not.toBe(0);
      expect(errors.join("\n")).toContain(
        "prx implement: removed; use prx implement agent [GH-N]",
      );
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("prx implement (bare, GH-1981) rejects with removal error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-bare-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const errors: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
        },
      );
      expect(exitCode).not.toBe(0);
      expect(errors.join("\n")).toContain(
        "prx implement: removed; use prx implement agent [GH-N]",
      );
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("prx implement session GH-<id> emits deprecation hint and dispatches canonical handler (GH-1981)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-implement-session-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const planBody = "## Scope\n\n- Implement the thing.\n";
    const errors: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["implement", "session", "GH-5431", "--interactive"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          muxRunner: mux.runner,
          attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          runPlanShow: async () => ({
            unit: "GH-5431",
            slot: "draft" as const,
            sha: "fakesha" as never,
            size: planBody.length,
            body: Buffer.from(planBody),
            validated_ok: true,
            diagnostics: [],
          }),
        },
      );
      expect(exitCode).toBe(0);
      expect(errors.join("\n")).toContain(
        "prx implement session is deprecated; use `prx implement agent [GH-NNN]`.",
      );
      // Canonical handler still ran: a tmux new-session was issued.
      const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
      expect(newSession).toBeDefined();
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  }, 15000);

  // prx-rgr: removed "session plan --interactive --format json → plain" — the
  // interactive inline-execRuntime path is unreachable now (retired `prx session
  // plan`); canonical `prx plan session --interactive` routes through the tmux
  // pane (parseSessionOpenCommand), not localRuntimeExecutor.

  test("session plan default --format json captures stdout (executor format 'json') since there is no TTY to protect", async () => {
    const capturedFormats: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-plan-print-json-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session","GH-5431", "--format", "json"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (_profile, format) => {
            capturedFormats.push(format);
            return { status: 0, stdout: "## Plan\n", stderr: "" };
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(capturedFormats).toEqual(["json"]);
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  test("session plan --emit-file captures stdout and writes the plan to disk", async () => {
    const capturedFormats: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-plan-emit-"));
    const previousCwd = process.cwd();
    delete process.env.PRX_SESSION_OPEN;
    process.chdir(cwd);
    try {
      const exitCode = await runCliDirect(
        ["plan", "session","GH-5431", "--emit-file", ".prx/plans/GH-5431.md"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          ...issueBackedWorkDeps("GH-5431"),
          resolveWorkUnitCwd: () => cwd,
          findSavedClaudeSession: () => false,
          execRuntime: (_profile, format) => {
            capturedFormats.push(format);
            return { status: 0, stdout: "## Plan\n- step 1\n- step 2\n", stderr: "" };
          },
          writeFile: (path, content) => {
            writes.push({ path, content });
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(capturedFormats).toEqual(["json"]);
      expect(writes.length).toBe(1);
      expect(writes[0]!.path.endsWith(".prx/plans/GH-5431.md")).toBe(true);
      expect(writes[0]!.content).toBe("## Plan\n- step 1\n- step 2\n");
    } finally {
      process.chdir(previousCwd);
      delete process.env.PRX_SESSION_OPEN;
    }
  });

  // prx-rgr: removed "session plan rejects --emit-file combined with
  // --interactive" — that guard lived in parseSessionPlanCommand, which the
  // canonical `prx plan session --interactive` bypasses (the --interactive fork
  // re-routes to parseSessionOpenCommand before the guard), so it is unreachable.

  test("work reports valid agent values when --agent is invalid", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--agent", "nope"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        ...noOpWorktreeLockDeps,
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Invalid value for --agent: nope");
    expect(errors[0]).toContain("claude");
    expect(errors[0]).toContain("codex");
    expect(errors[0]).toContain("copilot");
    expect(errors[0]).toContain("cursor");
    expect(errors[0]).toContain("gh-copilot");
  });

  test("work rejects stream-json for copilot", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--agent", "copilot", "--io-format", "stream-json"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        ...noOpWorktreeLockDeps,
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Execution workflows currently support: claude, codex");
  });

  test("desktop --dry-run prints the exact Codex Desktop command", () => {
    const logs: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-open-dry-run-"));

    const exitCode = runCliDirect(
      ["desktop", "GH-5431", "--dry-run"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        execOpen: () => {
          throw new Error("should not execute in dry-run mode");
        },
        resolveWorkUnitCwd: () => cwd,
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("codex");
    expect(logs[0]!).toContain("app");
    expect(logs[0]!).toContain(cwd);
  });

  test("desktop launches Codex Desktop in the resolved worktree", () => {
    let executed: { command: string; args: string[]; cwd?: string | undefined } | null = null;
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-open-launch-"));

    const exitCode = runCliDirect(
      ["desktop", "GH-5431"],
      {
        log: () => {},
        error: () => {},
      },
      {
        resolveWorkUnitCwd: () => cwd,
        execOpen: (command, args, launchCwd) => {
          executed = {
            command,
            args,
            cwd: launchCwd,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!).toEqual({      command: "codex",
      args: ["app", cwd],
      cwd,
    });
  });

  test("desktop uses the current worktree directory name when no id is provided", () => {
    let executed: { args: string[] } | null = null;
    const parent = mkdtempSync(join(tmpdir(), "pr-state-open-parent-"));
    const cwd = join(parent, "GH-7777");
    mkdirSync(cwd, { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const exitCode = runCliDirect(
      ["desktop"],
      {
        log: () => {},
        error: () => {},
      },
      {
        resolveWorkUnitCwd: (workUnitId) => {
          expect(workUnitId).toBe("GH-7777");
          return cwd;
        },
        execOpen: (_command, args) => {
          executed = { args };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.args).toEqual(["app", cwd]);  });

  test("desktop falls back to the current workspace when cwd is not canonical", () => {
    let executed: { args: string[]; cwd?: string | undefined } | null = null;
    // Use /tmp directly: bun test overrides TMPDIR to inside the project root,
    // which is a git repo. These tests need a cwd that is NOT inside any git repo.
    const parent = mkdtempSync(join("/tmp", "pr-state-open-noncanonical-parent-"));
    const cwd = join(parent, "repox-clean");
    mkdirSync(cwd, { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const exitCode = runCliDirect(
      ["desktop"],
      {
        log: () => {},
        error: () => {},
      },
      {
        resolveWorkUnitCwd: () => {
          throw new Error("should not resolve via wt for current-workspace fallback");
        },
        execOpen: (_command, args, launchCwd) => {
          executed = { args, cwd: launchCwd };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.args).toEqual(["app", realpathSync(cwd)]);
    expect(realpathSync(executed!.cwd ?? "")).toBe(realpathSync(cwd));  });

  test("spec init creates the local task contract", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-spec-init-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431", "--format", "json"],
      {
        log: () => {},
        error: () => {},
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(existsSync(taskPath)).toBeTrue();
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    expect(task.identity.workUnitId).toBe("GH-5431");
    expect(task.rolePlan.currentRole).toBe("planner");
  });

  test("task sync marks the task as synced and confirmed when flags are set", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-task-sync-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );

    const logs: string[] = [];
    const exitCode = runCliDirect(
      [
        "task",
        "sync",
        "--task",
        taskPath,
        "--work-unit-id",
        "GH-5431",
        "--bead-id",
        "BEAD-123",
        "--confirm-scope",
        "--confirm-success",
        "--format",
        "json",
      ],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.task.confirmations.specSynced).toBeTrue();
    expect(parsed.task.confirmations.scopeConfirmed).toBeTrue();
    expect(parsed.task.confirmations.successCriteriaConfirmed).toBeTrue();
    expect(parsed.task.identity.beadId).toBe("BEAD-123");
  });

  test("role start launches a role-specific codex profile", () => {
    let executed: { command: string; args: string[]; env?: Record<string, string> | undefined } | null = null;
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-start-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );

    const exitCode = runCliDirect(
      ["role", "start", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "planner", "--agent", "codex"],
      {
        log: () => {},
        error: () => {},
      },
      {
        execRuntime: (profile) => {
          executed = {
            command: profile.command,
            args: profile.args,
            env: profile.env,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.command).toBe("codex");
    expect(executed!.env?.PRX_AGENT_ROLE).toBe("planner");
    expect(executed!.args).toContain("GH-5431");
    expect(executed!.args.join(" ")).toContain("planner agent");
  });

  test("role start launches a role-specific Copilot profile", () => {
    let executed: { command: string; args: string[]; env?: Record<string, string> | undefined } | null = null;
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-start-copilot-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );

    const exitCode = runCliDirect(
      ["role", "start", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "planner", "--agent", "copilot"],
      {
        log: () => {},
        error: () => {},
      },
      {
        execRuntime: (profile) => {
          executed = {
            command: profile.command,
            args: profile.args,
            env: profile.env,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.command).toBe("gh");
    expect(executed!.env?.PRX_AGENT_ROLE).toBe("planner");
    expect(executed!.args).toEqual([
      "copilot",
      "--",
      "-i",
      expect.stringContaining("planner agent"),
    ]);
  });

  test("role start launches a role-specific Cursor Agent profile", () => {
    let executed: { command: string; args: string[]; env?: Record<string, string> | undefined } | null = null;
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-start-cursor-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );

    const exitCode = runCliDirect(
      ["role", "start", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "planner", "--agent", "cursor"],
      {
        log: () => {},
        error: () => {},
      },
      {
        execRuntime: (profile) => {
          executed = {
            command: profile.command,
            args: profile.args,
            env: profile.env,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.command).toBe("cursor-agent");
    expect(executed!.env?.PRX_AGENT_ROLE).toBe("planner");
    expect(executed!.args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--trust",
      expect.stringContaining("planner agent"),
    ]);
  });

  test("role start launches a role-specific Claude agent prompt", () => {
    let executed: { command: string; args: string[]; env?: Record<string, string> | undefined } | null = null;
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-start-claude-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );

    const exitCode = runCliDirect(
      ["role", "start", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "planner", "--agent", "claude"],
      {
        log: () => {},
        error: () => {},
      },
      {
        execRuntime: (profile) => {
          executed = {
            command: profile.command,
            args: profile.args,
            env: profile.env,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.command).toBe("claude");
    expect(executed!.args).toContain("GH-5431-planner");
    expect(executed!.env?.PRX_AGENT_ROLE).toBe("planner");
  });

  test("role complete advances the current role automatically", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-role-complete-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );
    runCliDirect(
      ["task", "sync", "--task", taskPath, "--work-unit-id", "GH-5431", "--confirm-scope", "--confirm-success"],
      { log: () => {}, error: () => {} },
    );

    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["role", "complete", "--task", taskPath, "--work-unit-id", "GH-5431", "--role", "planner", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.task.rolePlan.currentRole).toBe("executor");
  });

  test("task run launches the next eligible role automatically", () => {
    let executed: { args: string[]; env?: Record<string, string> | undefined } | null = null;
    const root = mkdtempSync(join(tmpdir(), "pr-state-task-run-"));
    const cwd = join(root, "GH-5431");
    mkdirSync(cwd);
    const taskPath = join(cwd, ".pr", "local", "task.json");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    runCliDirect(
      ["spec", "init", "--task", taskPath, "--work-unit-id", "GH-5431"],
      { log: () => {}, error: () => {} },
    );
    runCliDirect(
      ["task", "sync", "--task", taskPath, "--work-unit-id", "GH-5431", "--confirm-scope", "--confirm-success"],
      { log: () => {}, error: () => {} },
    );

    const exitCode = runCliDirect(
      ["task", "run", "--task", taskPath, "--work-unit-id", "GH-5431", "--agent", "claude"],
      {
        log: () => {},
        error: () => {},
      },
      {
        execRuntime: (profile) => {
          executed = { args: profile.args, env: profile.env };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.args).toContain("GH-5431-planner");
    expect(executed!.env?.PRX_AGENT_ROLE).toBe("planner");
  });

  test("work emits the runtime-artifact MCP status in json mode and never warns about a beads MCP server (GH-1587)", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-json-"));

    const exitCode = await runCliDirect(
      ["open","GH-5431", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => cwd,
        ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
        execRuntime: () => ({
          status: 0,
          stdout: "",
          stderr: "",
        }),
      },
    );

    expect(exitCode).toBe(0);
    // GH-1587: no `beads` MCP server is provisioned, so the old "Beads MCP
    // unavailable: …" advisory is never emitted.
    expect(errors.some((line) => line.includes("Beads MCP"))).toBe(false);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.runtimeArtifacts).toEqual({ mcpServers: [] });
    expect(parsed.policy.allowed_agents).toEqual(["claude", "codex"]);
    // GH-678 D1: telemetry + appendExecutionLog were removed from session-open
    // because the agent no longer runs as a child of this process (it runs
    // inside the tmux agent pane's bootstrap_command). The new JSON shape
    // carries `mux` info instead.
    expect(parsed.telemetry).toBeUndefined();
    expect(parsed.mux).toEqual({
      socket: "prx",
      session: expect.any(String),
      state: "absent",
      paneCommand: expect.any(Array),
    });
  });

  test("work uses the current worktree directory name when no id is provided (GH-678: via tmux agent-pane bootstrap)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pr-state-worktree-parent-"));
    const cwd = join(parent, "GH-7777");
    mkdirSync(cwd, { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["work"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        muxRunner: mux.runner,
        resolveWorkUnitCwd: () => cwd,
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    // GH-834: routes through session-open-claude; work-unit id threads into
    // the --append-system-prompt arg in the new-session direct-exec argv.
    const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
    expect(newSession).toBeDefined();
    const nIdx = newSession!.indexOf("-n");
    const afterWindow = newSession!.slice(nIdx + 2);
    const appendIdx = afterWindow.indexOf("--append-system-prompt");
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(afterWindow[appendIdx + 1]).toContain("GH-7777");
  });

  test("work launches from the resolved switched worktree path (GH-678: tmux session-path matches)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-launch-"));
    const launchCwd = join(cwd, "GH-5480");
    mkdirSync(launchCwd, { recursive: true });

    const mux = captureMuxInvocations();
    const exitCode = await runCliDirect(
      ["open", "GH-5480"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => launchCwd,
        muxRunner: mux.runner,
      },
    );

    expect(exitCode).toBe(0);
    // GH-678 Slice 2: tmux driver passes -c <launchCwd> on `new-session`, so
    // the session is anchored to the resolved worktree path.
    expect(mux.newSessionCwd()).toBe(launchCwd);
    expect(existsSync(join(launchCwd, ".pr/local/runtime/agents.json"))).toBe(true);
  });

  test("work fails loudly when worktree resolution detects a branch/worktree mismatch", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["open","GH-5480"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: () => {
          throw new Error(
            "wt switch left GH-5480 in a branch/worktree mismatch. current path: /repo/GH-5477 expected path: /repo/GH-5480",
          );
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("branch/worktree mismatch");
    expect(errors[0]).toContain("GH-5480");
  });

  test("resolveWorkUnitLaunchCwd returns the matched worktree path from git porcelain", () => {
    const runnerCalls: string[] = [];
    const porcelain = "worktree /repo/GH-5480\nHEAD abc123\nbranch refs/heads/GH-5480\n\n";
    const resolved = resolveWorkUnitLaunchCwd(
      "GH-5480",
      "/repo/current",
      (file, args) => {
        if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
      () => false,
      (cmd) => {
        runnerCalls.push(cmd.join(" "));
        if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        if (cmd.join(" ") === "git -C /repo/root worktree list --porcelain") {
          return { status: 0, stdout: porcelain, stderr: "" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      },
    );

    expect(resolved).toBe("/repo/GH-5480");
    expect(runnerCalls).toContain("git -C /repo/root worktree list --porcelain");
  });

  // ai-home-ozbjp / I-WS5 (launch boundary): never launch a work-unit session
  // in the read-only mainx replica. "Never work off mainx."
  test("assertLaunchCwdNotMainx throws for a mainx path, passes a sibling worktree", () => {
    expect(() => assertLaunchCwdNotMainx("/repo/root/mainx", "GH-5480")).toThrow(
      /read-only mainx replica/,
    );
    expect(assertLaunchCwdNotMainx("/repo/root/GH-5480", "GH-5480")).toBe(
      "/repo/root/GH-5480",
    );
  });

  test("resolveWorkUnitLaunchCwd refuses to hand back the mainx replica (ai-home-ozbjp)", () => {
    // The resolved worktree's directory basename is `mainx` → fail closed
    // rather than spawn an agent against the shared replica.
    const porcelain =
      "worktree /repo/root/mainx\nHEAD abc123\nbranch refs/heads/GH-5480\n\n";
    expect(() =>
      resolveWorkUnitLaunchCwd(
        "GH-5480",
        "/repo/current",
        (file, args) => {
          if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
            return { status: 0, stdout: "/repo/root\n", stderr: "" };
          }
          throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
        },
        () => false,
        (cmd) => {
          if (cmd.join(" ") === "git -C /repo/root worktree list --porcelain") {
            return { status: 0, stdout: porcelain, stderr: "" };
          }
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        },
      ),
    ).toThrow(/mainx replica/);
  });

  test("resolveWorkUnitLaunchCwd falls back to git worktree list when wt list fails with no-upstream error", () => {
    const porcelain = [
      "worktree /repo/root",
      "HEAD abc123def456abc1",
      "branch refs/heads/main",
      "",
      "worktree /repo/GH-379",
      "HEAD def456abc123def4",
      "branch refs/heads/GH-379",
      "",
    ].join("\n");

    const resolved = resolveWorkUnitLaunchCwd(
      "GH-379",
      "/repo/current",
      (file, args) => {
        if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        if (file === "wt" && args.join(" ") === "list --format=json") {
          return { status: 128, stdout: "", stderr: "fatal: branch 'GH-379' has no upstream information" };
        }
        throw new Error(`unexpected: ${file} ${args.join(" ")}`);
      },
      () => false,
      (cmd) => {
        if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        if (cmd.join(" ") === "git -C /repo/root worktree list --porcelain") {
          return { status: 0, stdout: porcelain, stderr: "" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      },
    );

    expect(resolved).toBe("/repo/GH-379");
  });

  test("resolveWorkUnitLaunchCwd materializes a missing worktree then re-reads it from git", () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    let listCount = 0;
    const resolved = resolveWorkUnitLaunchCwd(
      "GH-196",
      "/repo/current",
      (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        if (file === "git" && args.join(" ") === "-C /repo/root fetch origin") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "git" && args.join(" ") === "-C /repo/root worktree list --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "git" && args.join(" ").startsWith("-C /repo/root worktree add")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "git" && args.join(" ") === "-C /repo/mainx checkout --detach origin/main") {
          return { status: 0, stdout: "", stderr: "" };
        }
        // GH-512: resolveWorkUnitLaunchCwd checks if branch already exists before materializing
        if (file === "git" && args.join(" ") === "-C /repo/root show-ref --verify --quiet refs/heads/GH-196") {
          return { status: 1, stdout: "", stderr: "" };
        }
        // seedRemoteBranch calls (GH-427)
        if (file === "git" && args.join(" ") === "-C /repo/root ls-remote --heads origin GH-196") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "git" && args.join(" ") === "-C /repo/root rev-parse origin/main") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        if (file === "git" && args.join(" ") === "-C /repo/root push origin abc123:refs/heads/GH-196") {
          return { status: 0, stdout: "", stderr: "" };
        }
        // ai-home-8zr6: ensureWorkUnitBranchAndUpstream fetch + local-tracking.
        const ensureResult = mockEnsureWorkUnitBranchFlow("/repo/root", "GH-196", file, args);
        if (ensureResult !== null) return ensureResult;
        // Default config is still wt, so materializeWorkUnitBranch attaches via wt switch.
        if (file === "wt" && args.join(" ") === "switch --yes --no-hooks GH-196") {
          expect(options.cwd).toBe("/repo/root");
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")} (cwd=${options.cwd})`);
      },
      () => false,
      (cmd) => {
        if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        // listResolvedWorktrees reads git porcelain: empty before materialize, populated after.
        if (cmd.join(" ") === "git -C /repo/root worktree list --porcelain") {
          listCount += 1;
          return listCount === 1
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 0, stdout: "worktree /repo/GH-196\nHEAD abc123\nbranch refs/heads/GH-196\n\n", stderr: "" };
        }
        if (cmd.join(" ").includes("repo view")) {
          return { status: 0, stdout: "owner/repo\n", stderr: "" };
        }
        if (cmd.join(" ").includes("issue view 196")) {
          return { status: 0, stdout: JSON.stringify({ number: 196, title: "Issue", state: "OPEN" }), stderr: "" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      },
    );

    expect(resolved).toBe("/repo/GH-196");
    expect(listCount).toBe(2);
    const fileArgs = calls.map(({ file, args }) => ({ file, args }));
    expect(fileArgs).toContainEqual({ file: "git", args: ["-C", "/repo/root", "fetch", "origin"] });
  });

  test("findWorktreeByDirectoryPrefix matches Worktrunk-named dirs for a canonical work unit id", () => {
    // GH-521: Worktrunk names work-unit worktrees `<prefix>_<num>_<suffix>`
    // (e.g., `gh_515_azi` for GH-515). Directory-prefix matching lets us
    // reuse such a worktree when the branch has drifted away from the id.
    const entries = [
      { branch: "main", path: "/worktrees/main", states: [] },
      { branch: "main", path: "/worktrees/gh_515_azi", states: ["branch_worktree_mismatch"] },
      { branch: "GH-600", path: "/worktrees/gh_600_xyz", states: [] },
    ];
    expect(findWorktreeByDirectoryPrefix(entries, "GH-515")?.path).toBe("/worktrees/gh_515_azi");
    expect(findWorktreeByDirectoryPrefix(entries, "GH-600")?.path).toBe("/worktrees/gh_600_xyz");
  });

  test("findWorktreeByDirectoryPrefix returns undefined when no directory matches", () => {
    const entries = [
      { branch: "main", path: "/worktrees/main", states: [] },
      { branch: "GH-100", path: "/worktrees/gh_100_abc", states: [] },
    ];
    expect(findWorktreeByDirectoryPrefix(entries, "GH-515")).toBeUndefined();
  });

  test("findWorktreeByDirectoryPrefix requires the numeric suffix boundary (gh_5 must not match gh_515_*)", () => {
    // Guard against loose prefix matching: `gh_5_` must not match `gh_515_azi`.
    const entries = [
      { branch: "main", path: "/worktrees/gh_515_azi", states: [] },
    ];
    expect(findWorktreeByDirectoryPrefix(entries, "GH-5")).toBeUndefined();
    expect(findWorktreeByDirectoryPrefix(entries, "GH-515")?.path).toBe("/worktrees/gh_515_azi");
  });

  test("resolveWorkUnitLaunchCwd reuses a directory-prefix-matched worktree without materializing", () => {
    // GH-521: core repro — worktree `gh_515_azi` exists but its branch drifted
    // to `main` (no local GH-515 branch). Previously this fell through to
    // materialization. The directory-prefix match short-circuits it: we return
    // the matched worktree's path without materializing.
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const porcelain = [
      "worktree /repo/root",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /worktrees/gh_515_azi",
      "HEAD bbb222",
      "branch refs/heads/main",
      "",
    ].join("\n");
    const resolved = resolveWorkUnitLaunchCwd(
      "GH-515",
      "/repo/current",
      (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")} (cwd=${options.cwd})`);
      },
      () => false,
      (cmd) => {
        if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        if (cmd.join(" ") === "git -C /repo/root worktree list --porcelain") {
          return { status: 0, stdout: porcelain, stderr: "" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      },
    );

    expect(resolved).toBe("/worktrees/gh_515_azi");
    expect(calls.some((c) => c.file === "wt")).toBe(false);
    expect(calls.some((c) => c.args.join(" ").includes("worktree add"))).toBe(false);
  });

  test("pruneStaleRemoteRefs runs git -C <root> fetch --prune origin", () => {
    // GH-519: session open must drop stale origin/GH-NNN refs before the
    // parity chain evaluates, so a deleted-on-remote branch doesn't trigger
    // a delete_remote_branch action against a ref that's already gone.
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const spawn = (file: string, args: string[], options: { cwd: string; encoding: "utf8" }) => {
      calls.push({ file, args, cwd: options.cwd });
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root fetch --prune origin") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")}`);
    };

    pruneStaleRemoteRefs("/repo/current", spawn);

    const fetchCall = calls.find((c) => c.file === "git" && c.args.includes("fetch"));
    expect(fetchCall?.args).toEqual(["-C", "/repo/root", "fetch", "--prune", "origin"]);
    expect(fetchCall?.cwd).toBe("/repo/root");
  });

  test("pruneStaleRemoteRefs swallows fetch failure so session open is not aborted", () => {
    // Best-effort contract: network errors or detached/sandbox runs must not
    // abort `prx session open`. The worst case (stale refs remain) is a
    // misleading parity-chain action, not a crash.
    const spawn = (file: string, args: string[], _options: { cwd: string; encoding: "utf8" }) => {
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root fetch --prune origin") {
        return { status: 128, stdout: "", stderr: "fatal: could not read from remote" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")}`);
    };

    expect(() => pruneStaleRemoteRefs("/repo/current", spawn)).not.toThrow();
  });

  test("prx session open invokes pruneStaleRemoteRefs BEFORE the parity chain", async () => {
    // GH-519: ordering matters — the prune must happen before buildParityChain
    // observes remote state. Otherwise the chain still sees the stale ref.
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-session-open-prune-order-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const order: string[] = [];

    const deps = issueBackedWorkDeps("GH-5431");
    const buildParityChainOriginal = deps.buildParityChain;

    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-5431", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...deps,
        // GH-1983: bypass the detached-HEAD preflight on CI (see comment in
        // noOpWorktreeLockDeps for the TMPDIR-override rationale).
        assertWorktreeOnNamedBranch: () => null,
        pruneStaleRemoteRefs: () => { order.push("prune"); },
        buildParityChain: (...args: Parameters<typeof buildParityChainOriginal>) => {
          order.push("parityChain");
          return buildParityChainOriginal(...args);
        },
        resolveWorkUnitCwd: () => cwd,
        lockWorktree: () => {},
        unlockWorktree: () => {},
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );
    process.chdir(previousCwd);

    if (exitCode !== 0) {
      throw new Error(`session open --dry-run failed: ${errors.join("; ")}`);
    }
    expect(exitCode).toBe(0);
    expect(order[0]).toBe("prune");
    const parityIndex = order.indexOf("parityChain");
    expect(parityIndex).toBeGreaterThan(0);
    expect(order.indexOf("prune")).toBeLessThan(parityIndex);
  });

  test("materializeWorkUnitBranch fetches origin then creates the worktree — never mutates mainx (GH-2366)", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const spawn = (file: string, args: string[], options: { cwd: string; encoding: "utf8" }) => {
      calls.push({ file, args });
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root fetch origin") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root worktree list --porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root show-ref --verify --quiet refs/heads/TASK-5480") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ").startsWith("-C /repo/root worktree add")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/mainx checkout --detach origin/main") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")} (cwd=${options.cwd})`);
    };

    materializeWorkUnitBranch(
      "TASK-5480",
      "/repo/current",
      spawn,
      (cmd) => {
        if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
          return { status: 0, stdout: "/repo/root\n", stderr: "" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      },
    );

    expect(calls.some((c) => c.file === "git" && c.args.join(" ") === "-C /repo/root fetch origin")).toBe(true);
    // GH-2366: the materialize path must NOT detach/clobber the shared mainx
    // worktree — it only fetches + adds the work-unit worktree.
    expect(calls.some((c) => c.file === "git" && c.args.join(" ") === "-C /repo/mainx checkout --detach origin/main")).toBe(false);
    expect(calls.some((c) => c.file === "git" && c.args.join(" ").startsWith("-C /repo/root worktree add"))).toBe(true);
    expect(calls.some((c) => c.file === "wt")).toBe(false);
  });

  test("prepareMainxWorktree refuses a dirty mainx with a clear message — no destructive checkout (GH-2366)", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const spawn = (file: string, args: string[], _options: { cwd: string; encoding: "utf8" }) => {
      calls.push({ file, args });
      const joined = args.join(" ");
      if (file === "git" && joined === "rev-parse --show-toplevel") return { status: 0, stdout: "/repo/root\n", stderr: "" };
      if (file === "git" && joined === "-C /repo/root fetch origin") return { status: 0, stdout: "", stderr: "" };
      if (file === "git" && joined === "-C /repo/root worktree list --porcelain") return { status: 0, stdout: "worktree /repo/mainx\n", stderr: "" };
      if (file === "git" && joined === "-C /repo/mainx status --porcelain") return { status: 0, stdout: " M src/foo.ts\n", stderr: "" };
      if (file === "git" && joined === "-C /repo/mainx checkout --detach origin/main") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected: ${file} ${joined}`);
    };

    // Dirty mainx → clear refusal (not git's cryptic "resolve your current index").
    expect(() => prepareMainxWorktree("/repo/current", spawn)).toThrow(/uncommitted changes/);
    // The destructive checkout must NOT run when the tree is dirty.
    expect(calls.some((c) => c.args.join(" ") === "-C /repo/mainx checkout --detach origin/main")).toBe(false);
  });

  test("materializeWorkUnitBranch validates GH issue before preparing mainx", () => {
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const spawn = (file: string, args: string[], options: { cwd: string; encoding: "utf8" }) => {
      spawnCalls.push({ file, args });
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root fetch origin") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root worktree list --porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/root show-ref --verify --quiet refs/heads/GH-171") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ").startsWith("-C /repo/root worktree add")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === "-C /repo/mainx checkout --detach origin/main") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")} (cwd=${options.cwd})`);
    };
    const runnerCalls: string[][] = [];
    const runner = (cmd: string[], _options?: { cwd?: string; check?: boolean }) => {
      if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      runnerCalls.push(cmd);
      if (cmd.join(" ").includes("repo view")) {
        return { status: 0, stdout: "owner/repo\n", stderr: "" };
      }
      if (cmd.join(" ").includes("issue view 171")) {
        return { status: 0, stdout: JSON.stringify({ number: 171, title: "Test issue", state: "OPEN" }), stderr: "" };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };

    materializeWorkUnitBranch("GH-171", "/repo/current", spawn, runner);

    expect(runnerCalls.some((c) => c.includes("issue") && c.includes("171"))).toBe(true);
    expect(spawnCalls.some((c) => c.file === "git" && c.args.join(" ").includes("fetch origin"))).toBe(true);
    expect(spawnCalls.some((c) => c.file === "git" && c.args.join(" ").startsWith("-C /repo/root worktree add"))).toBe(true);
  });

  test("materializeWorkUnitBranch validates routed beads issue before running mainx", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pr-state-routing-beads-"));
    writeFileSync(
      join(repoRoot, "prx.toml"),
      ['[routing]', 'GH = "beads_issue"', ""].join("\n"),
    );
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const spawn = (file: string, args: string[], options: { cwd: string; encoding: "utf8" }) => {
      spawnCalls.push({ file, args });
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
      if (file === "git" && args.join(" ") === `-C ${repoRoot} fetch origin`) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === `-C ${repoRoot} worktree list --porcelain`) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ") === `-C ${repoRoot} show-ref --verify --quiet refs/heads/GH-5480`) {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ").startsWith(`-C ${repoRoot} worktree add`)) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args.join(" ").includes("checkout --detach origin/main")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")} (cwd=${options.cwd})`);
    };
    const runnerCalls: string[][] = [];
    const runner = (cmd: string[], _options?: { cwd?: string; check?: boolean }) => {
      runnerCalls.push(cmd);
      if (cmd.join(" ") === `git -C ${repoRoot} rev-parse --show-toplevel`) {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
      if (cmd.join(" ") === "bd show GH-5480 --json") {
        return { status: 0, stdout: JSON.stringify({ status: "open" }), stderr: "" };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };

    materializeWorkUnitBranch("GH-5480", repoRoot, spawn, runner);

    expect(runnerCalls.some((c) => c.join(" ") === "bd show GH-5480 --json")).toBe(true);
    expect(runnerCalls.some((c) => c[0] === "gh")).toBe(false);
    expect(spawnCalls.some((c) => c.file === "git" && c.args.join(" ").includes("fetch origin"))).toBe(true);
    expect(spawnCalls.some((c) => c.file === "git" && c.args.join(" ").startsWith(`-C ${repoRoot} worktree add`))).toBe(true);
  });

  test("materializeWorkUnitBranch throws when GH issue validation fails", () => {
    const spawn = (file: string, args: string[], _options: { cwd: string; encoding: "utf8" }) => {
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")}`);
    };
    const runner = (cmd: string[], _options?: { cwd?: string; check?: boolean }) => {
      if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      if (cmd.join(" ").includes("repo view")) {
        return { status: 0, stdout: "owner/repo\n", stderr: "" };
      }
      if (cmd.join(" ").includes("issue view 999")) {
        return { status: 1, stdout: "", stderr: "issue not found" };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };

    expect(() => materializeWorkUnitBranch("GH-999", "/repo/current", spawn, runner)).toThrow(/issue.*999.*not found/);
  });

  test("materializeWorkUnitBranch throws when routed beads issue validation fails", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pr-state-routing-beads-missing-"));
    writeFileSync(
      join(repoRoot, "prx.toml"),
      ['[routing]', 'GH = "beads_issue"'].join("\n"),
    );
    const spawn = (file: string, args: string[], _options: { cwd: string; encoding: "utf8" }) => {
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")}`);
    };
    const runner = (cmd: string[], _options?: { cwd?: string; check?: boolean }) => {
      if (cmd.join(" ") === `git -C ${repoRoot} rev-parse --show-toplevel`) {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
      if (cmd.join(" ") === "bd show GH-999 --json") {
        return { status: 1, stdout: "", stderr: "bead not found" };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };

    expect(() => materializeWorkUnitBranch("GH-999", repoRoot, spawn, runner)).toThrow(/GH-999.*not found/);
  });

  test("materializeWorkUnitBranch rejects closed GH issues", () => {
    const spawn = (file: string, args: string[], _options: { cwd: string; encoding: "utf8" }) => {
      if (file === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      throw new Error(`unexpected: ${file} ${args.join(" ")}`);
    };
    const runner = (cmd: string[], _options?: { cwd?: string; check?: boolean }) => {
      if (cmd.join(" ") === "git -C /repo/root rev-parse --show-toplevel") {
        return { status: 0, stdout: "/repo/root\n", stderr: "" };
      }
      if (cmd.join(" ").includes("repo view")) {
        return { status: 0, stdout: "owner/repo\n", stderr: "" };
      }
      if (cmd.join(" ").includes("issue view 171")) {
        return { status: 0, stdout: JSON.stringify({ number: 171, title: "Closed issue", state: "CLOSED" }), stderr: "" };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };

    expect(() => materializeWorkUnitBranch("GH-171", "/repo/current", spawn, runner)).toThrow(/issue authority is not active/i);
  });

  test("checkWorkUnitIssue validates open GH issues", () => {
    const runner = (cmd: string[], _options?: { cwd?: string; check?: boolean }) => {
      if (cmd.join(" ").includes("repo view")) {
        return { status: 0, stdout: "owner/repo\n", stderr: "" };
      }
      if (cmd.join(" ").includes("issue view 227")) {
        return { status: 0, stdout: JSON.stringify({ number: 227, title: "Issue", state: "OPEN" }), stderr: "" };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };

    expect(checkWorkUnitIssue("GH-227", "/repo/current", runner)).toEqual({
      workUnitId: "GH-227",
      repo: "owner/repo",
      issue: { number: 227, title: "Issue", state: "OPEN" },
      checked: true,
      valid: true,
      reason: "open",
    });
  });

  test("checkWorkUnitIssue rejects non-GH work units", () => {
    expect(() => checkWorkUnitIssue("BEAD-123")).toThrow(/canonical work unit identity must be GitHub-backed/i);
  });

  test("findBeadsIssuesByGithubIssue filters by source_system and external_ref (open + closed)", () => {
    // GH-1595: the resolver now consumes the converged `loadAllBeads` reader
    // (passed as a loader closure), so the test drives the typed
    // `BeadsRecord[]` shape that the production reader produces.
    let loaderCalls = 0;
    const loader = () => {
      loaderCalls += 1;
      return [
        beadRecord({
          id: "ai-home-aaa",
          title: "Linked via source_system",
          sourceSystem: "github:204",
          status: "open",
        }),
        beadRecord({
          id: "ai-home-bbb",
          title: "Linked via external_ref",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/204",
          externalIssueNumber: 204,
          status: "in_progress",
        }),
        beadRecord({
          id: "ai-home-ddd",
          title: "Linked via external_ref but closed",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/204",
          externalIssueNumber: 204,
          status: "closed",
        }),
        beadRecord({
          id: "ai-home-ccc",
          title: "Different issue",
          sourceSystem: "github:205",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/205",
          externalIssueNumber: 205,
          status: "open",
        }),
      ];
    };

    expect(findBeadsIssuesByGithubIssue(204, loader)).toEqual([
      {
        id: "ai-home-aaa",
        title: "Linked via source_system",
        source_system: "github:204",
        external_ref: null,
        status: "open",
      },
      {
        id: "ai-home-bbb",
        title: "Linked via external_ref",
        source_system: null,
        external_ref: "https://github.com/bdelanghe/ai-home/issues/204",
        status: "in_progress",
      },
      // GH-1589 regression: a closed bead linked to the issue must still be
      // returned — the loader reads `bd list --all --json --limit 0`.
      {
        id: "ai-home-ddd",
        title: "Linked via external_ref but closed",
        source_system: null,
        external_ref: "https://github.com/bdelanghe/ai-home/issues/204",
        status: "closed",
      },
    ]);
    expect(loaderCalls).toBe(1);
  });

  test("findBeadsIssuesByGithubIssue propagates loader errors", () => {
    // GH-1595: parse + transport errors now live in `loadAllBeads`; the
    // resolver is a pure filter over the parsed `BeadsRecord[]` so we assert
    // that loader exceptions propagate verbatim.
    const loader = () => {
      throw new Error("beads issue: bd list --json returned invalid JSON");
    };

    expect(() => findBeadsIssuesByGithubIssue(204, loader)).toThrow(
      /bd list --json returned invalid JSON/i,
    );
  });

  test("formatBeadsIssueMatches id mode emits one short-id per line", () => {
    const matches = [
      { id: "ai-home-aaa", title: "first", status: "open" },
      { id: "ai-home-bbb", title: "second", status: "in_progress" },
    ];
    expect(formatBeadsIssueMatches(204, matches, "id")).toBe("ai-home-aaa\nai-home-bbb");
    expect(formatBeadsIssueMatches(204, [], "id")).toBe("");
  });

  test("beads-issue --format=id command emits canonical short-id on match", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["beads", "issue", "GH-204", "--format", "id"],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
      {
        findBeadsIssuesByGithubIssue: () => [
          {
            id: "ai-home-aaa",
            title: "Linked via source_system",
            source_system: "github:204",
            external_ref: null,
            status: "open",
          },
          {
            id: "ai-home-bbb",
            title: "Linked via external_ref",
            source_system: null,
            external_ref: "https://github.com/bdelanghe/ai-home/issues/204",
            status: "in_progress",
          },
        ],
      },
    );

    expect(exitCode).toBe(0);
    expect(logs).toEqual(["ai-home-aaa\nai-home-bbb"]);
    expect(errors).toEqual([]);
  });

  test("beads-issue --format=id writes empty stdout + no-match message to stderr on no match", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["beads", "issue", "GH-1458", "--format", "id"],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
      {
        findBeadsIssuesByGithubIssue: () => [],
      },
    );

    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["No Beads issues linked to GitHub issue #1458."]);
  });

  test("beads publish <bd-id> dispatches to runBeadsPublish with parsed defaults", () => {
    const captured: Array<{ bdId: string; repo?: string | undefined; dryRun: boolean; noAdopt: boolean; format: string }> = [];
    const exitCode = runCliDirect(
      ["beads", "publish", "ai-home-abc"],
      { log: () => {}, error: () => {} },
      {
        runBeadsPublish: (opts) => {
          captured.push({
            bdId: opts.bdId,
            repo: opts.repo,
            dryRun: opts.dryRun,
            noAdopt: opts.noAdopt,
            format: opts.format,
          });
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured).toEqual([
      { bdId: "ai-home-abc", repo: undefined, dryRun: false, noAdopt: false, format: "plain" },
    ]);
  });

  test("beads publish threads --repo / --dry-run / --no-adopt / --format json", () => {
    const captured: Array<{ bdId: string; repo?: string | undefined; dryRun: boolean; noAdopt: boolean; format: string }> = [];
    const exitCode = runCliDirect(
      ["beads", "publish", "ai-home-abc", "--repo", "owner/repo", "--dry-run", "--no-adopt", "--format", "json"],
      { log: () => {}, error: () => {} },
      {
        runBeadsPublish: (opts) => {
          captured.push({
            bdId: opts.bdId,
            repo: opts.repo,
            dryRun: opts.dryRun,
            noAdopt: opts.noAdopt,
            format: opts.format,
          });
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured).toEqual([
      { bdId: "ai-home-abc", repo: "owner/repo", dryRun: true, noAdopt: true, format: "json" },
    ]);
  });

  test("beads with no subcommand lists publish in the error hint", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(["beads"], { log: () => {}, error: (l) => errors.push(l) });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("publish");
  });

  test("beads publish GH-123 → exit 1 with the intake-mirror hint", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["beads", "publish", "GH-123"],
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
    );
    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("prx intake mirror GH-123");
  });

  test("check-issue command prints stable JSON", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["check-issue", "GH-227", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        checkWorkUnitIssue: () => ({
          workUnitId: "GH-227",
          repo: "owner/repo",
          issue: { number: 227, title: "Issue", state: "OPEN" },
          checked: true,
          valid: true,
          reason: "open",
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({
      workUnitId: "GH-227",
      repo: "owner/repo",
      issue: { number: 227, title: "Issue", state: "OPEN" },
      checked: true,
      valid: true,
      reason: "open",
    });
  });

  test("check-issue command reports invalid issue state", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["check-issue", "GH-230"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        checkWorkUnitIssue: () => {
          throw new Error("Cannot start work for GH-230: GitHub issue #230 is CLOSED, so issue authority is not active.");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("issue authority is not active");
  });

  test("checkWorkUnitSession passes when no matching worktree exists", () => {
    expect(checkWorkUnitSession("GH-227", "/repo", () => [])).toEqual({
      workUnitId: "GH-227",
      worktreePath: null,
      lockReason: null,
      checked: true,
      valid: true,
      reason: "no_matching_worktree",
    });
  });

  test("checkWorkUnitSession blocks when matching worktree is locked", () => {
    expect(() =>
      checkWorkUnitSession("GH-227", "/repo", () => [
        {
          path: "/repo/GH-227",
          branch: "GH-227",
          head: null,
          detached: false,
          locked: true,
          lockReason: "prx session runtime active for GH-227",
        },
      ])
    ).toThrow(/active worktree session is already running/i);
  });

  test("checkWorkUnitSession blocks when locked and pid is alive (GH-591)", () => {
    expect(() =>
      checkWorkUnitSession(
        "GH-227",
        "/repo",
        () => [
          {
            path: "/repo/GH-227",
            branch: "GH-227",
            head: null,
            detached: false,
            locked: true,
            lockReason: "prx session runtime active for GH-227 (pid 1234)",
          },
        ],
        { isPidAlive: () => true, unlock: () => {} },
      )
    ).toThrow(/active worktree session is already running/i);
  });

  test("checkWorkUnitSession reclaims stale pid lock and logs (GH-591)", () => {
    const unlockCalls: string[] = [];
    const logs: string[] = [];
    const result = checkWorkUnitSession(
      "GH-227",
      "/repo",
      () => [
        {
          path: "/repo/GH-227",
          branch: "GH-227",
          head: null,
          detached: false,
          locked: true,
          lockReason: "prx session runtime active for GH-227 (pid 99233)",
        },
      ],
      {
        isPidAlive: (pid) => {
          expect(pid).toBe(99233);
          return false;
        },
        unlock: (path) => {
          unlockCalls.push(path);
        },
        log: (line) => logs.push(line),
      },
    );

    expect(unlockCalls).toEqual(["/repo/GH-227"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!).toContain("reclaimed stale prx session lock");
    expect(logs[0]!).toContain("pid 99233");
    expect(result).toEqual({
      workUnitId: "GH-227",
      worktreePath: "/repo/GH-227",
      lockReason: "prx session runtime active for GH-227 (pid 99233)",
      checked: true,
      valid: true,
      reason: "no_active_session",
    });
  });

  test("parseSessionLockPid accepts canonical prx session locks (GH-591)", () => {
    expect(parseSessionLockPid("prx session runtime active for GH-227 (pid 42)")).toBe(42);
    expect(parseSessionLockPid("prx session runtime active for feature-path (pid 99233)")).toBe(99233);
  });

  test("parseSessionLockPid rejects foreign reasons and malformed input (GH-591)", () => {
    expect(parseSessionLockPid(null)).toBeNull();
    expect(parseSessionLockPid("")).toBeNull();
    expect(parseSessionLockPid("manual operator lock")).toBeNull();
    expect(parseSessionLockPid("some tool (pid 1234) holding lock")).toBeNull();
    expect(parseSessionLockPid("prx session runtime active for GH-227 (pid 0)")).toBeNull();
    expect(parseSessionLockPid("prx session runtime active for GH-227")).toBeNull();
  });

  test("checkWorkUnitSession blocks on locks without parseable pid (GH-591)", () => {
    const probe = (_pid: number) => {
      throw new Error("probe should not run for reasons without a pid");
    };
    expect(() =>
      checkWorkUnitSession(
        "GH-227",
        "/repo",
        () => [
          {
            path: "/repo/GH-227",
            branch: "GH-227",
            head: null,
            detached: false,
            locked: true,
            lockReason: "manual lock from operator",
          },
        ],
        { isPidAlive: probe, unlock: () => {} },
      )
    ).toThrow(/active worktree session is already running/i);
  });

  test("check-session command prints stable JSON", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["check-session", "GH-227", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        checkWorkUnitSession: () => ({
          workUnitId: "GH-227",
          worktreePath: "/repo/GH-227",
          lockReason: null,
          checked: true,
          valid: true,
          reason: "no_active_session",
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({
      workUnitId: "GH-227",
      worktreePath: "/repo/GH-227",
      lockReason: null,
      checked: true,
      valid: true,
      reason: "no_active_session",
    });
  });

  test("check-session command reports active session", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["check-session", "GH-227"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        checkWorkUnitSession: () => {
          throw new Error("Cannot start work for GH-227: an active worktree session is already running at /repo/GH-227: prx session runtime active for GH-227.");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("active worktree session");
  });

  test("checkWorkUnitChain allows missing units for pre-switch creation", async () => {
    await expect(checkWorkUnitChain(
      "GH-227",
      "/repo",
      true,
      () => ({
        source: "derived-board",
        repo: "owner/repo",
        remote_freshness: "fresh",
        units: [],
      }),
      () => ({
        source: "surface-sync",
        repo: "owner/repo",
        mode: "full",
        authority: "issue",
        scope: "all",
        apply: false,
        units: [],
        actions: [],
      }),
      // GH-935: epic-label guard reads the GH issue up front; provide a stub
      // so the test does not shell out to `gh issue view`.
      () => ({ number: 227, title: "Pre-switch", state: "OPEN", labels: [] }),
    )).resolves.toEqual({
      workUnitId: "GH-227",
      create: true,
      unitExists: false,
      issueAuthorityActive: null,
      pruneActions: [],
      backfillActions: [],
      checked: true,
      valid: true,
      reason: "missing_unit_allowed",
    });
  });

  // GH-230: on `--create` for a GitHub unit, the chain ROOT `<unit>:source@pinned`
  // must be pinned from the issue body — previously only non-GH units were pinned,
  // so the headless planner got an empty sourceBody and fabricated scope.
  test("checkWorkUnitChain pins <unit>:source@pinned for a GitHub unit on --create (GH-230)", async () => {
    const prevCasRoot = process.env.PRX_CAS_ROOT;
    process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "gh-230-source-pin-"));
    try {
      await checkWorkUnitChain(
        "GH-230",
        "/repo",
        true,
        () => ({
          source: "derived-board",
          repo: "owner/repo",
          remote_freshness: "fresh",
          units: [],
        }),
        () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "full",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [],
          actions: [],
        }),
        // GH issue stub WITH a body — this is the source authority the planner
        // must consume instead of fabricating.
        () => ({
          number: 230,
          title: "Planner ignores issue body",
          state: "OPEN",
          body: "The headless planner confabulates scope from its system prompt.",
          url: "https://github.com/owner/repo/issues/230",
          labels: [],
        }),
      );

      const pinned = await consumeArtifact(workUnitSourceEdge, "GH-230");
      expect(pinned.missing).toBeUndefined();
      expect(pinned.value?.source).toBe("github");
      expect(pinned.value?.title).toBe("Planner ignores issue body");
      expect(pinned.value?.body).toBe(
        "The headless planner confabulates scope from its system prompt.",
      );
    } finally {
      if (prevCasRoot === undefined) delete process.env.PRX_CAS_ROOT;
      else process.env.PRX_CAS_ROOT = prevCasRoot;
    }
  });

  test("checkWorkUnitChain errors when no resolver is configured for a non-GH id", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => null;
    await expect(checkWorkUnitChain(
      "PROJECT-6637",
      "/repo",
      false,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
    )).rejects.toThrow("no issue-authority resolver is configured");
  });

  test("checkWorkUnitChain names the Notion ticket and suggests --from=notion when the resolver resolves open", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => ({
        id: "PROJECT-6637",
        title: "Foo bar",
        body: null,
        state: "open" as const,
        url: "https://notion.so/abc",
        source: "notion" as const,
      }),
    });
    let caught: unknown;
    try {
      await checkWorkUnitChain("PROJECT-6637", "/repo", false, board, parity, undefined, loadIdentity, buildResolver);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("Foo bar");
    expect(message).toContain("https://notion.so/abc");
    // The materialize hint points at the canonical plan entry with a bare
    // `--create` (the source is auto-resolved); `--from` is no longer emitted.
    expect(message).toContain("--create");
    expect(message).toContain("prx plan agent");
    expect(message).not.toContain("--from=notion");
  });

  test("checkWorkUnitChain reports closed state without suggesting --create", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => ({
        id: "PROJECT-6637",
        title: "Foo bar",
        body: null,
        state: "closed" as const,
        url: "https://notion.so/abc",
        source: "notion" as const,
      }),
    });
    let caught: unknown;
    try {
      await checkWorkUnitChain("PROJECT-6637", "/repo", false, board, parity, undefined, loadIdentity, buildResolver);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("is closed");
    expect(message).toContain("Reopen in notion");
    expect(message).not.toContain("--create --from=notion");
  });

  // GH-870: --create --from=notion validates the resolver-backed source
  // before allowing materialization, so closed/missing Notion tickets are
  // caught at the same gate that runs without --create.
  test("checkWorkUnitChain allows create + from=notion when the Notion ticket resolves open", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    let resolverCalls = 0;
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => {
        resolverCalls += 1;
        return {
          id: "PROJECT-6637",
          title: "Foo bar",
          body: null,
          state: "open" as const,
          url: "https://notion.so/abc",
          source: "notion" as const,
        };
      },
    });
    await expect(checkWorkUnitChain(
      "PROJECT-6637",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "notion",
    )).resolves.toMatchObject({ valid: true, reason: "missing_unit_allowed" });
    expect(resolverCalls).toBe(1);
  });

  describe("prx-jcb — artifact-native local projection (in-toto)", () => {
    const emptyBoard = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const emptyParity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|prx)-/ });
    const beadsResolver = () => ({
      name: "beads" as const,
      fetch: async () => ({
        id: "prx-0v5",
        title: "task: README is out of date",
        body: null,
        state: "open" as const,
        url: "bd://prx-0v5",
        source: "beads" as const,
      }),
    });

    test("accepts a beads unit when a plan artifact already links it locally", async () => {
      // The GH board has no row for prx-0v5, but a CAS plan artifact exists — the
      // artifact graph IS the projection, so entry is allowed (no board re-probe).
      const hasPlan = async () => true;
      await expect(
        checkWorkUnitChain(
          "prx-0v5",
          "/repo",
          false,
          emptyBoard,
          emptyParity,
          undefined,
          loadIdentity,
          beadsResolver,
          undefined,
          undefined,
          undefined,
          hasPlan,
        ),
      ).resolves.toMatchObject({
        valid: true,
        reason: "artifact_projected",
        unitExists: true,
      });
    });

    test("still refuses (NotProjectedLocally) when no artifact links the unit", async () => {
      // No plan in CAS and no board row → genuinely not projected; the original
      // refusal stands (now accurate rather than misleading).
      const noPlan = async () => false;
      await expect(
        checkWorkUnitChain(
          "prx-0v5",
          "/repo",
          false,
          emptyBoard,
          emptyParity,
          undefined,
          loadIdentity,
          beadsResolver,
          undefined,
          undefined,
          undefined,
          noPlan,
        ),
      ).rejects.toThrow("has no local parity-chain unit yet");
    });
  });

  test("checkWorkUnitChain rejects create + from=notion when the Notion ticket is closed", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => ({
        id: "PROJECT-6637",
        title: "Foo bar",
        body: null,
        state: "closed" as const,
        url: "https://notion.so/abc",
        source: "notion" as const,
      }),
    });
    await expect(checkWorkUnitChain(
      "PROJECT-6637",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "notion",
    )).rejects.toThrow("is closed");
  });

  test("checkWorkUnitChain rejects create + from=notion when no resolver is configured", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => null;
    await expect(checkWorkUnitChain(
      "PROJECT-6637",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "notion",
    )).rejects.toThrow("no issue-authority resolver is configured");
  });

  // GH-2090: --create --from=beads validates the bd-backed source before
  // allowing materialization, mirroring the --from=notion arm above.
  test("checkWorkUnitChain allows create + from=beads when the bd record resolves open", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|BD)-[0-9A-Fa-f]+$/ });
    let resolverCalls = 0;
    const buildResolver = () => ({
      name: "beads" as const,
      fetch: async () => {
        resolverCalls += 1;
        return {
          id: "BD-AAAAAAAA",
          title: "bd-backed unit",
          body: null,
          state: "open" as const,
          url: null,
          source: "beads" as const,
        };
      },
    });
    await expect(checkWorkUnitChain(
      "BD-AAAAAAAA",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "beads",
    )).resolves.toMatchObject({ valid: true, reason: "missing_unit_allowed" });
    expect(resolverCalls).toBe(1);
  });

  test("checkWorkUnitChain rejects create + from=beads when no resolver is configured", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|BD)-[0-9A-Fa-f]+$/ });
    const buildResolver = () => null;
    await expect(checkWorkUnitChain(
      "BD-AAAAAAAA",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "beads",
    )).rejects.toThrow("no issue-authority resolver is configured");
  });

  // GH-2152: exercises the STANDALONE-caller path — checkWorkUnitChain invoked
  // directly with a GH-shaped id + "beads". In the live `session`/`plan session`
  // command flow this arm is shadowed by the lifted guard (GH-2140) covered at
  // the `work --check ... --from=beads` test below; this case keeps the
  // defense-in-depth arm honest for direct callers.
  test("checkWorkUnitChain rejects create + from=beads for GitHub canonical IDs (standalone caller)", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^GH-\d+$/, isDefault: true });
    let resolverBuilt = 0;
    const buildResolver = () => {
      resolverBuilt += 1;
      return null;
    };
    await expect(checkWorkUnitChain(
      "GH-2090",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "beads",
    )).rejects.toThrow("--from=beads is not valid for GitHub work unit IDs (GH-2090)");
    // GH-870 defensive skip applies to from=beads too: no GH fetch, no
    // resolver build before the rejection lands.
    expect(resolverBuilt).toBe(0);
  });

  test("checkWorkUnitChain resolves the source once on plain create to pin it (prx-pl2)", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    let resolverCalls = 0;
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => {
        resolverCalls += 1;
        return {
          id: "PROJECT-6637",
          title: "Foo bar",
          body: null,
          state: "closed" as const,
          url: "https://notion.so/abc",
          source: "notion" as const,
        };
      },
    });
    await expect(checkWorkUnitChain(
      "PROJECT-6637",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
    )).resolves.toMatchObject({ valid: true, reason: "missing_unit_allowed" });
    // prx-pl2: plain create now resolves the source ONCE to FOD-pin
    // `<unit>:source@pinned` (the impure→pure boundary the planner consumes).
    // A closed/erroring source is swallowed (best-effort) but still probed once.
    expect(resolverCalls).toBe(1);
  });

  test("checkWorkUnitChain surfaces resolver errors with source name and cause", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => {
        throw new Error("notion-search returned not_found");
      },
    });
    let caught: unknown;
    try {
      await checkWorkUnitChain("PROJECT-6637", "/repo", false, board, parity, undefined, loadIdentity, buildResolver);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("notion lookup failed");
    expect(message).toContain("notion-search returned not_found");
    expect(message).toContain("prx check-issue PROJECT-6637");
  });

  test("checkWorkUnitChain skips the resolver for GH ids (regression guard)", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const readGh = () => ({ number: 123, title: "Open issue", state: "OPEN" });
    let resolverBuilt = 0;
    const buildResolver = () => {
      resolverBuilt += 1;
      return null;
    };
    const result = await checkWorkUnitChain(
      "GH-123",
      "/repo",
      false,
      board,
      parity,
      readGh,
      () => buildIdentityFromLegacy({ canonicalIdPattern: /^GH-\d+$/, isDefault: true }),
      buildResolver,
    );
    expect(result.issueAuthorityActive).toBe(true);
    expect(result.reason).toBe("missing_unit_allowed");
    expect(resolverBuilt).toBe(0);
  });

  // GH-914: when a Notion-backed canonical id has a remote branch authored by
  // a teammate, the action enumerator (tested separately in
  // github_parity_authorship.test.ts) drops `delete_remote_branch` — so
  // checkWorkUnitChain sees an empty pruneActions list and resolves cleanly
  // instead of throwing the destructive remediation error. The mocked parity
  // result here mirrors that filtered output.
  test("checkWorkUnitChain adopts a teammate-authored remote branch instead of throwing", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [
        {
          ticket: null,
          branch: "PROJECT-6637",
          worktree_path: null,
          pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
          artifacts: { worktree: false, branch: true, pr: false, ticket: true },
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
            local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
          },
          remote_branch_author: {
            name: "Other Operator",
            email: "other@example.com",
            isOperator: false,
          },
          column: "pushed" as const,
          reasons: [],
        },
      ],
    });
    // Post-gate parity result: foreign-author branch yields no prune action.
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: "PROJECT-6637", ticket: null, actions: [] }],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => ({
        id: "PROJECT-6637",
        title: "Foo",
        body: null,
        state: "open" as const,
        url: "https://notion.so/abc",
        source: "notion" as const,
      }),
    });

    const result = await checkWorkUnitChain(
      "PROJECT-6637",
      "/repo",
      true,
      board,
      parity,
      undefined,
      loadIdentity,
      buildResolver,
      "notion",
    );
    expect(result.valid).toBe(true);
    expect(result.pruneActions).toEqual([]);
    expect(result.unitExists).toBe(true);
  });

  // GH-914: when the remote branch is operator-authored (or authorship is
  // unknown), the existing destructive remediation continues to fire — the
  // helper must not blanket-disable prune for legitimate operator cleanup.
  test("checkWorkUnitChain still throws prune remediation for operator-authored prune actions", async () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [
        {
          ticket: null,
          branch: "PROJECT-9999",
          worktree_path: null,
          pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
          artifacts: { worktree: false, branch: true, pr: false, ticket: true },
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
            local: { branch: "clean", worktree: "clean", dir: "no worktree", problem: "no" },
          },
          remote_branch_author: {
            name: "Operator",
            email: "me@example.com",
            isOperator: true,
          },
          column: "pushed" as const,
          reasons: [],
        },
      ],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [
        {
          branch: "PROJECT-9999",
          ticket: null,
          actions: [
            {
              type: "delete_remote_branch" as const,
              remote: "origin" as const,
              branch: "PROJECT-9999",
              ticket: null,
              reason: "Remote branch has no issue or PR authority",
              command: "git push origin --delete PROJECT-9999",
            },
          ],
        },
      ],
      actions: [],
    });
    const loadIdentity = () => buildIdentityFromLegacy({ canonicalIdPattern: /^(GH|PROJECT)-\d+$/ });
    const buildResolver = () => ({
      name: "notion" as const,
      fetch: async () => ({
        id: "PROJECT-9999",
        title: "Foo",
        body: null,
        state: "open" as const,
        url: "https://notion.so/abc",
        source: "notion" as const,
      }),
    });
    let caught: unknown;
    try {
      await checkWorkUnitChain(
        "PROJECT-9999",
        "/repo",
        true,
        board,
        parity,
        undefined,
        loadIdentity,
        buildResolver,
        "notion",
      );
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("parity-chain cleanup is required first");
    expect(message).toContain("delete_remote_branch");
    // Operator-authored: the destructive remediation IS the right next step.
    expect(message).toContain("`prx chain prune --authority issue --scope all`");
  });

  // GH-924: refuse session entry when a unit's lifecycle is already terminal
  // and the worktree is still on disk (parity chain emits no prune action in
  // that case, so the existing pruneActions gate doesn't catch it).
  function unitCompleteBoard(workUnitId: string, overrides: {
    merge_state?: string;
    gh_issue?: string;
    beads_issue?: string;
    pr?: string;
  }): {
    source: "derived-board";
    repo: string;
    remote_freshness: "fresh";
    units: Array<{
      ticket: string;
      branch: string;
      worktree_path: string;
      pr: { exists: boolean; number: number | null; title: string | null; url: string | null; draft: boolean | null; checks: null; review: null; approvals: null; mergeable: null };
      artifacts: { worktree: boolean; branch: boolean; pr: boolean; ticket: boolean };
      local: { clean: boolean; staged: number; unstaged: number; untracked: number; conflicts: number };
      status: {
        remote: { gh_issue: string; beads_issue: string; project_item: string; branch: string; pr: string; merge_state: string; ci: string; problem: string };
        local: { branch: string; worktree: string; dir: string; problem: string };
      };
      column: "merged";
      reasons: string[];
    }>;
  } {
    return {
      source: "derived-board",
      repo: "owner/repo",
      remote_freshness: "fresh",
      units: [{
        ticket: workUnitId,
        branch: workUnitId,
        worktree_path: `/repo/${workUnitId}`,
        pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
        artifacts: { worktree: true, branch: true, pr: false, ticket: true },
        local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
        status: {
          remote: {
            gh_issue: overrides.gh_issue ?? "dirty",
            beads_issue: overrides.beads_issue ?? "clean",
            project_item: "clean",
            branch: "clean",
            pr: overrides.pr ?? "clean",
            merge_state: overrides.merge_state ?? "clean",
            ci: "clean",
            problem: "no",
          },
          local: { branch: "clean", worktree: "clean", dir: "present", problem: "no" },
        },
        column: "merged",
        reasons: [],
      }],
    };
  }

  test("checkWorkUnitChain refuses session entry when PR is merged + issue closed + worktree present (GH-924)", async () => {
    const board = () => unitCompleteBoard("GH-888", {
      merge_state: "merged",
      gh_issue: "completed",
      pr: "completed",
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: "GH-888", ticket: "GH-888", actions: [] }],
      actions: [],
    });
    await expect(checkWorkUnitChain(
      "GH-888",
      "/repo",
      false,
      board,
      parity,
    )).rejects.toThrow(/work unit is complete.*PR merged.*GitHub issue closed/s);
    await expect(checkWorkUnitChain(
      "GH-888",
      "/repo",
      false,
      board,
      parity,
    )).rejects.toThrow(/prx prune --ticket GH-888/);
  });

  test("checkWorkUnitChain refuses when PR was closed unmerged + issue closed (GH-924)", async () => {
    const board = () => unitCompleteBoard("GH-742", {
      merge_state: "closed",
      gh_issue: "completed",
      pr: "completed",
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: "GH-742", ticket: "GH-742", actions: [] }],
      actions: [],
    });
    await expect(checkWorkUnitChain(
      "GH-742",
      "/repo",
      false,
      board,
      parity,
    )).rejects.toThrow(/PR closed/);
  });

  test("checkWorkUnitChain refuses when only the GitHub issue is closed (GH-924)", async () => {
    const board = () => unitCompleteBoard("GH-101", {
      merge_state: "open",
      gh_issue: "completed",
      pr: "dirty",
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: "GH-101", ticket: "GH-101", actions: [] }],
      actions: [],
    });
    await expect(checkWorkUnitChain(
      "GH-101",
      "/repo",
      false,
      board,
      parity,
    )).rejects.toThrow(/GitHub issue closed/);
  });

  test("checkWorkUnitChain still allows session entry for an active unit (GH-924 regression guard)", async () => {
    const board = () => unitCompleteBoard("GH-202", {
      merge_state: "open",
      gh_issue: "dirty",
      pr: "dirty",
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: "GH-202", ticket: "GH-202", actions: [] }],
      actions: [],
    });
    const result = await checkWorkUnitChain(
      "GH-202",
      "/repo",
      false,
      board,
      parity,
    );
    expect(result.valid).toBe(true);
    expect(result.unitExists).toBe(true);
    expect(result.reason).toBe("ok");
  });

  // GH-1152: bd schema drift surfaces as a non-blocking chain-check reason
  // when the probe reports drift; the operator unblocks via `prx chain
  // repair-bd`. Existing `ok` and `backfill_allowed` paths take precedence.
  test("checkWorkUnitChain reports bd_schema_drift_detected when the probe sees drift", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "chain-drift-")));
    try {
      mkdirSync(join(tmp, ".beads"), { recursive: true });
      const board = () => unitCompleteBoard("GH-1152", {
        merge_state: "open",
        gh_issue: "dirty",
        pr: "dirty",
      });
      const parity = () => ({
        source: "surface-sync" as const,
        repo: "owner/repo",
        mode: "full" as const,
        authority: "issue" as const,
        scope: "all" as const,
        apply: false,
        units: [{ branch: "GH-1152", ticket: "GH-1152", actions: [] }],
        actions: [],
      });
      const probe = () =>
        ({
          status: "drift_detected" as const,
          errorClass: "started_at_missing" as const,
          rawStderr: 'column "started_at" could not be found',
        });
      const result = await checkWorkUnitChain(
        "GH-1152",
        tmp,
        false,
        board,
        parity,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        probe,
      );
      expect(result.reason).toBe("bd_schema_drift_detected");
      expect(result.bdSchemaProbe?.status).toBe("drift_detected");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // GH-935: `prx session open` must refuse before worktree creation when the
  // resolved GH issue is a `type::epic`. Children are sourced from beads
  // parent-child edges (GH-891 epic content layer is authoritative). The four
  // cases below match the issue's acceptance criteria.
  describe("checkWorkUnitChain epic refusal (GH-935)", () => {
    const board = () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [],
    });
    const parity = () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [],
      actions: [],
    });
    const epicIssue = (number: number) => () => ({
      number,
      title: "Test epic",
      state: "OPEN",
      labels: [{ name: "type::epic" }, { name: "priority::medium" }],
    });

    test("pure epic with two open children refuses with both listed", async () => {
      const readEpicChildren = () => [
        { ghNumber: 902, title: "A.2 — Warp profile", state: "open" as const },
        { ghNumber: 903, title: "A.3 — tmux profile", state: "open" as const },
      ];
      let caught: unknown;
      try {
        await checkWorkUnitChain(
          "GH-899",
          "/repo",
          true,
          board,
          parity,
          epicIssue(899),
          undefined,
          undefined,
          undefined,
          readEpicChildren,
        );
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("Cannot open PRX session for GH-899");
      expect(message).toContain("type::epic");
      expect(message).toContain("Open a child instead");
      expect(message).toContain("GH-902");
      expect(message).toContain("GH-903");
      expect(message).toContain("[open]");
    });

    test("epic with closed-only children still refuses, listing each as closed", async () => {
      const readEpicChildren = () => [
        { ghNumber: 401, title: "A.1 — done", state: "closed" as const },
        { ghNumber: 402, title: "A.2 — also done", state: "closed" as const },
      ];
      let caught: unknown;
      try {
        await checkWorkUnitChain(
          "GH-400",
          "/repo",
          true,
          board,
          parity,
          epicIssue(400),
          undefined,
          undefined,
          undefined,
          readEpicChildren,
        );
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("Cannot open PRX session for GH-400");
      expect(message).toContain("GH-401");
      expect(message).toContain("GH-402");
      expect(message).toContain("[closed]");
      expect(message).not.toContain("[open]");
    });

    test("non-epic task does not refuse — current behavior preserved", async () => {
      const taskIssue = () => ({
        number: 935,
        title: "Test task",
        state: "OPEN",
        labels: [{ name: "type::feature" }, { name: "priority::medium" }],
      });
      let epicChildrenCalls = 0;
      const readEpicChildren = () => {
        epicChildrenCalls += 1;
        return [];
      };
      const result = await checkWorkUnitChain(
        "GH-935",
        "/repo",
        true,
        board,
        parity,
        taskIssue,
        undefined,
        undefined,
        undefined,
        readEpicChildren,
      );
      expect(result.valid).toBe(true);
      expect(result.reason).toBe("missing_unit_allowed");
      expect(epicChildrenCalls).toBe(0);
    });

    test("issue with stripped (no type::epic) labels does not refuse", async () => {
      const noLabelsIssue = () => ({
        number: 935,
        title: "Test task",
        state: "OPEN",
        labels: [],
      });
      const result = await checkWorkUnitChain(
        "GH-935",
        "/repo",
        true,
        board,
        parity,
        noLabelsIssue,
        undefined,
        undefined,
        undefined,
        () => [],
      );
      expect(result.valid).toBe(true);
    });

    test("epic with no parent-child edges in beads still refuses, with hint", async () => {
      let caught: unknown;
      try {
        await checkWorkUnitChain(
          "GH-555",
          "/repo",
          true,
          board,
          parity,
          epicIssue(555),
          undefined,
          undefined,
          undefined,
          () => [],
        );
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("Cannot open PRX session for GH-555");
      expect(message).toContain("type::epic");
      expect(message).toContain("No children are registered in beads");
      expect(message).toContain("bd dep add --type=parent-child");
    });

    test("still refuses with CliError when readEpicChildren throws (bd unavailable)", async () => {
      const readEpicChildren = () => {
        throw new Error("bd: command not found");
      };
      let caught: unknown;
      try {
        await checkWorkUnitChain(
          "GH-777",
          "/repo",
          true,
          board,
          parity,
          epicIssue(777),
          undefined,
          undefined,
          undefined,
          readEpicChildren,
        );
      } catch (error) {
        caught = error;
      }
      // The bd failure must NOT escape — operator should still get the
      // intended epic-refusal message, just with the empty-children hint.
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("Cannot open PRX session for GH-777");
      expect(message).toContain("type::epic");
      expect(message).toContain("No children are registered in beads");
      expect(message).not.toContain("bd: command not found");
    });
  });

  test("check-chain command prints stable JSON", async () => {
    const logs: string[] = [];
    const exitCode = await await runCliDirect(
      ["check-chain", "GH-227", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        checkWorkUnitChain: async () => ({
          workUnitId: "GH-227",
          create: true,
          unitExists: true,
          issueAuthorityActive: true,
          pruneActions: [],
          backfillActions: ["create_worktree"],
          checked: true,
          valid: true,
          reason: "backfill_allowed",
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({
      workUnitId: "GH-227",
      create: true,
      unitExists: true,
      issueAuthorityActive: true,
      pruneActions: [],
      backfillActions: ["create_worktree"],
      checked: true,
      valid: true,
      reason: "backfill_allowed",
    });
  });

  test("check-chain command reports cleanup requirement", async () => {
    const errors: string[] = [];
    const exitCode = await await runCliDirect(
      ["check-chain", "GH-227"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        checkWorkUnitChain: async () => {
          throw new Error("Cannot start work for GH-227: parity-chain cleanup is required first (delete_remote_branch). Run `prx chain prune --authority issue --scope all` and retry.");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("cleanup is required first");
  });

  test("work --create calls materializeWorktree before resolving cwd", async () => {
    const calls: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-create-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open", "GH-171", "--create"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        materializeWorktree: (workUnitId) => { calls.push(`materialize:${workUnitId}`); },
        resolveWorkUnitCwd: (workUnitId) => { calls.push(`resolve:${workUnitId}`); return cwd; },
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["materialize:GH-171", "resolve:GH-171"]);
  });

  test("work --create --no-verify forwards noVerify to materializeWorktree", async () => {
    const calls: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-create-no-verify-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open", "GH-171", "--create", "--no-verify"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        materializeWorktree: (workUnitId, launchCwd, noVerify) => {
          calls.push(`materialize:${workUnitId}:${launchCwd}:${String(noVerify)}`);
        },
        resolveWorkUnitCwd: () => cwd,
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toContain("materialize:GH-171:");
    expect(calls[0]!).toEndWith(":true");
  });

  // GH-870: --from selects which resolver-backed source materializes a unit
  // whose canonical id has no GH/beads parity yet (e.g. PROJ-* via Notion).
  // The error message in src/machine/session_open.ts:99 already promises this
  // flag; these tests pin its parsing surface and pre-create gating.
  test("work --create --from=notion accepts the source selector", async () => {
    const calls: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-from-notion-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open", "GH-171", "--create", "--from", "notion"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        // GH-2140: a local parity unit already exists, so the lifted --from guard
        // must skip and the source selector is accepted (moot --from on an
        // existing unit — the GH-870 accept-when-unit-exists contract).
        wtStatus: () => localWtView(["GH-171"]),
        materializeWorktree: (workUnitId) => { calls.push(`materialize:${workUnitId}`); },
        resolveWorkUnitCwd: (workUnitId) => { calls.push(`resolve:${workUnitId}`); return cwd; },
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["materialize:GH-171", "resolve:GH-171"]);
  });

  test("work --from rejects unknown values", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--create", "--from", "linear"],
      { log: () => {}, error: (line) => errors.push(line) },
      { ...noOpWorktreeLockDeps },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Invalid value for --from: linear");
    expect(errors[0]).toContain("github");
    expect(errors[0]).toContain("notion");
  });

  test("work --from without --create is rejected", async () => {
    const errors: string[] = [];

    const exitCode = await runCliDirect(
      ["open", "GH-5431", "--from", "notion"],
      { log: () => {}, error: (line) => errors.push(line) },
      { ...noOpWorktreeLockDeps },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("--from requires --create");
  });

  test("work --check threads --from=notion through validateWorkSessionEntry before any IO (GH-870, GH-2120)", async () => {
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-check-from-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open","GH-9999", "--check", "--create", "--from", "notion"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...noOpWorktreeLockDeps,
        // GH-2140: no local parity unit exists, so the lifted --from guard rejects
        // at the front of validateWorkSessionEntry using only the local worktree
        // view — before the remote board fetch (gh pr list + remoteStatus). If
        // boardStatus runs, the guard regressed back behind the GH fetch.
        wtStatus: () => localWtView([]),
        boardStatus: () => {
          throw new Error("boardStatus must not run before the --from guard");
        },
        inspectSessionOpenState: () => {
          throw new Error("--check must not reach inspectSessionOpenState when probe rejects");
        },
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(1);
    // prx-rgr: invoked via `prx open` now (the retired `prx session open`
    // emitted no hint); `prx open` prepends a one-line deprecation hint, so the
    // --from guard message is found in the error stream rather than at [0].
    const fromError = errors.find((l) => l.includes("--from=notion"));
    expect(fromError).toBeDefined();
    expect(fromError!).toContain("GH-9999");
  });

  test("work --check threads --from=beads through validateWorkSessionEntry before any IO (GH-870, GH-2113)", async () => {
    const errors: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-check-from-beads-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open","GH-9999", "--check", "--create", "--from", "beads"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...noOpWorktreeLockDeps,
        // GH-2140: beads sibling of the notion case above — no local parity unit,
        // so reject from the local worktree view before any remote board fetch.
        wtStatus: () => localWtView([]),
        boardStatus: () => {
          throw new Error("boardStatus must not run before the --from guard");
        },
        inspectSessionOpenState: () => {
          throw new Error("--check must not reach inspectSessionOpenState when probe rejects");
        },
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(1);
    // prx-rgr: `prx open` prepends a deprecation hint; find the --from guard line.
    const fromError = errors.find((l) => l.includes("--from=beads"));
    expect(fromError).toBeDefined();
    expect(fromError!).toContain("GH-9999");
  });

  test("work --no-verify forwards noVerify to resolveWorkUnitCwd", async () => {
    const calls: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-resolve-no-verify-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    const exitCode = await runCliDirect(
      ["open", "GH-171", "--no-verify"],
      { log: () => {}, error: () => {} },
      {
        ...noOpWorktreeLockDeps,
        resolveWorkUnitCwd: (workUnitId, launchCwd, noVerify) => {
          calls.push(`resolve:${workUnitId}:${launchCwd}:${String(noVerify)}`);
          return cwd;
        },
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toContain("resolve:GH-171:");
    expect(calls[0]!).toEndWith(":true");
  });

  test("work fails clearly when cwd is not a canonical worktree name and no id is passed", async () => {
    const errors: string[] = [];
    // Use /tmp directly: bun test overrides TMPDIR to inside the project root (a git repo).
    const cwd = mkdtempSync(join("/tmp", "pr-state-noncanonical-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const exitCode = await runCliDirect(
      ["work"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("canonical issue-backed work unit id");
    expect(errors[0]).toContain("canonical worktree directory name");
  });

  test("work rejects current-workspace fallback when cwd is not issue-backed", async () => {
    let executed: { command: string; args: string[]; cwd?: string | undefined } | null = null;
    const errors: string[] = [];
    // Use /tmp directly: bun test overrides TMPDIR to inside the project root (a git repo).
    const cwd = mkdtempSync(join("/tmp", "pr-state-work-codex-noncanonical-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const exitCode = await runCliDirect(
      ["open","--agent", "codex"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        resolveWorkUnitCwd: () => {
          throw new Error("should not resolve via wt for current-workspace fallback");
        },
        lockWorktree: () => {
          throw new Error("should not lock when using current-workspace fallback");
        },
        unlockWorktree: () => {
          throw new Error("should not unlock when using current-workspace fallback");
        },
        execRuntime: (profile, _format, launchCwd) => {
          executed = {
            command: profile.command,
            args: profile.args,
            cwd: launchCwd,
          };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    process.chdir(previousCwd);

    expect(exitCode).toBe(1);
    expect(executed).toBeNull();
    expect(errors[0]).toContain("canonical issue-backed work unit id");
  });

  test("work rejects non-GitHub canonical work-unit IDs", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","TASK-171"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {},
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("must match CANONICAL-ID format");
    expect(errors[0]).toContain("GH-456");
  });

  test("work bootstraps an open GH issue even when no parity-chain unit exists yet (GH-678: mux spawn on resolved cwd)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-work-gh-bootstrap-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const calls: string[] = [];
    const mux = captureMuxInvocations();

    const exitCode = await runCliDirect(
      ["open", "GH-171"],
      { log: () => {}, error: () => {} },
      {
        pruneStaleRemoteRefs: () => {},
        // GH-1983: bypass the detached-HEAD preflight (see comment in
        // noOpWorktreeLockDeps for the CI-only TMPDIR-override reason).
        assertWorktreeOnNamedBranch: () => null,
        boardStatus: () => ({
          source: "derived-board",
          repo: "owner/repo",
          remote_freshness: "fresh",
          units: [],
        }),
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "full",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [],
          actions: [],
        }),
        validateGitHubIssue: () => ({ number: 171, title: "Open issue", state: "OPEN" }),
        resolveWorkUnitCwd: (workUnitId) => {
          calls.push(`resolve:${workUnitId}`);
          return cwd;
        },
        muxRunner: mux.runner,
        attachRunner: () => ({ stdout: "", stderr: "", status: 0 }),
      },
    );

    process.chdir(previousCwd);

    expect(exitCode).toBe(0);
    expect(calls).toContain("resolve:GH-171");
    // GH-678: the post-resolve action is spawning a tmux session with the
    // resolved cwd as the session's base directory.
    expect(mux.newSessionCwd()).toBe(cwd);
    // GH-834: routes through session-open-claude; work-unit id is in the
    // --append-system-prompt arg on the new-session direct-exec argv.
    const newSession = mux.invocations.find((inv) => inv[3] === "new-session");
    expect(newSession).toBeDefined();
    const nIdx = newSession!.indexOf("-n");
    const afterWindow = newSession!.slice(nIdx + 2);
    const appendIdx = afterWindow.indexOf("--append-system-prompt");
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(afterWindow[appendIdx + 1]).toContain("GH-171");
  });

  test("work rejects closed GH issues before bootstrapping a missing unit", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-171"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        boardStatus: () => ({
          source: "derived-board",
          repo: "owner/repo",
          remote_freshness: "fresh",
          units: [],
        }),
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "full",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [],
          actions: [],
        }),
        validateGitHubIssue: () => ({ number: 171, title: "Closed issue", state: "CLOSED" }),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Cannot open PRX session for GH-171");
    expect(errors[0]).toContain("is closed");
  });

  const inactiveAuthorityFixture = (
    ghIssue: string,
    beadsIssue: string,
    dir: string,
  ) => ({
    boardStatus: () => ({
      source: "derived-board" as const,
      repo: "owner/repo",
      remote_freshness: "fresh" as const,
      units: [
        {
          ticket: "GH-171",
          branch: "GH-171",
          worktree_path: dir === "present" ? "/repo/GH-171" : null,
          pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
          artifacts: { worktree: dir === "present", branch: true, pr: false, ticket: true },
          local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
          status: {
            remote: {
              gh_issue: ghIssue,
              beads_issue: beadsIssue,
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
              dir,
              problem: "no",
            },
          },
          column: "pushed" as const,
          reasons: [],
        },
      ],
    }),
    buildParityChain: () => ({
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "full" as const,
      authority: "issue" as const,
      scope: "all" as const,
      apply: false,
      units: [{ branch: "GH-171", ticket: "GH-171", actions: [] }],
      actions: [],
    }),
  });

  // GH-924: closed-issue is now treated as a *completed* lifecycle (the
  // canonical teardown verb is `prx prune`), not as a missing-authority error.
  // The old `describeInactiveIssueAuthority` path still applies for unknown /
  // disabled authority states (see "work surfaces which authority is
  // unreachable" below).
  test("work surfaces unit-complete refusal when GH issue is closed and worktree present", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-171"],
      { log: () => {}, error: (line) => errors.push(line) },
      inactiveAuthorityFixture("completed", "clean", "present"),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("work unit is complete");
    expect(errors[0]).toContain("GitHub issue closed");
    expect(errors[0]).toContain("prx prune --ticket GH-171");
    expect(errors[0]).toContain("prx delegate next");
  });

  test("work surfaces unit-complete refusal when closed issue leaves a branch without a worktree", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-171"],
      { log: () => {}, error: (line) => errors.push(line) },
      inactiveAuthorityFixture("completed", "clean", "no worktree"),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("work unit is complete");
    expect(errors[0]).toContain("GitHub issue closed");
    expect(errors[0]).toContain("prx prune --ticket GH-171");
  });

  test("work surfaces which authority is unreachable when issue view fails", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-171"],
      { log: () => {}, error: (line) => errors.push(line) },
      inactiveAuthorityFixture("unknown", "disabled", "present"),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("unreachable");
    expect(errors[0]).toContain("gh_issue=unknown");
    expect(errors[0]).toContain("prx worktree-remove GH-171 --delete-branch");
  });

  test("work fails when parity chain requires prune before launch", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-171"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        boardStatus: () => ({
          source: "derived-board",
          repo: "owner/repo",
          remote_freshness: "fresh",
          units: [
            {
              ticket: "GH-171",
              branch: "GH-171",
              worktree_path: "/repo/GH-171",
              pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
              artifacts: { worktree: true, branch: true, pr: false, ticket: true },
              local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
              status: {
                remote: {
                  gh_issue: "dirty",
                  beads_issue: "clean",
                  project_item: "clean",
                  branch: "dirty",
                  pr: "completed",
                  merge_state: "clean",
                  ci: "clean",
                  problem: "yes",
                },
                local: {
                  branch: "clean",
                  worktree: "clean",
                  dir: "present",
                  problem: "no",
                },
              },
              column: "pushed",
              reasons: [],
            },
          ],
        }),
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "full",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [
            {
              branch: "GH-171",
              ticket: "GH-171",
              actions: [
                {
                  type: "delete_remote_branch",
                  branch: "GH-171",
                  ticket: "GH-171",
                  reason: "cleanup",
                  command: "git push origin --delete GH-171",
                },
              ],
            },
          ],
          actions: [],
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("cleanup is required first");
    expect(errors[0]).toContain("prx chain prune --authority issue --scope all");
  });

  test("work auto-resolves backfill instead of blocking (GH-512)", async () => {
    // Previously this test asserted that session open blocked with
    // "parity-chain backfill is required first".  GH-512 removed that gate:
    // backfill actions are now resolved automatically by resolveWorkUnitLaunchCwd.
    // We verify that the old error is NOT emitted.
    const errors: string[] = [];
    await runCliDirect(
      ["open","GH-171"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        boardStatus: () => ({
          source: "derived-board",
          repo: "owner/repo",
          remote_freshness: "fresh",
          units: [
            {
              ticket: "GH-171",
              branch: "GH-171",
              worktree_path: null,
              pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
              artifacts: { worktree: false, branch: true, pr: false, ticket: true },
              local: { clean: null, staged: null, unstaged: null, untracked: null, conflicts: null },
              status: {
                remote: {
                  gh_issue: "dirty",
                  beads_issue: "clean",
                  project_item: "clean",
                  branch: "clean",
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
              column: "no_worktree",
              reasons: [],
            },
          ],
        }),
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "full",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [
            {
              branch: "GH-171",
              ticket: "GH-171",
              actions: [
                {
                  type: "create_worktree",
                  branch: "GH-171",
                  ticket: "GH-171",
                  reason: "Local branch exists but no worktree is attached",
                  command: "git worktree add ../GH-171 GH-171",
                },
              ],
            },
          ],
          actions: [],
        }),
        // Provide resolveWorkUnitCwd so session open can proceed past validation
        resolveWorkUnitCwd: () => "/repo/GH-171",
        ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
        execRuntime: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );

    // Session open should NOT block with the old backfill error — it may still
    // fail downstream (e.g. on fake paths) but the validation gate is gone.
    const backfillError = errors.find((e) => e.includes("parity-chain backfill is required first"));
    expect(backfillError).toBeUndefined();
  });

  test("work fails clearly when remote board status cannot be read", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["open","GH-171"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        boardStatus: () => {
          throw new Error("gh api rate limit");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Failed to read remote board status");
    expect(errors[0]).toContain("prx chain status --remote");
    expect(errors[0]).toContain("gh auth status");
    expect(errors[0]).toContain("gh api rate limit");
  });

  test("runtime-profile prints the canonical work-unit claude template", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("claude");
    expect(logs[0]!).toContain("--strict-mcp-config");
    expect(logs[0]!).toContain("--setting-sources");
    expect(logs[0]!).toContain("project,local");
    expect(logs[0]!).toContain("--tools");
    expect(logs[0]!).toContain("Read,Edit,Bash");
    expect(logs[0]!).toContain("--allowedTools");
    expect(logs[0]!).not.toContain("--json-schema");
    expect(logs[0]!).not.toContain("--output-format");
  });

  test("runtime-profile --interactive matches the interactive executed profile", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--interactive", "--work-unit-id", "GH-5431"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain(".pr/local/runtime/agents.json");
    expect(logs[0]!).toContain("--continue");
    expect(logs[0]!).toContain(`Bash(${prxSafePath}:*)`);
    expect(logs[0]!).not.toContain("--json-schema");
    expect(logs[0]!).not.toContain("--output-format");
  });

  test("runtime-profile --automation shows the print-oriented automation profile", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--automation", "--work-unit-id", "GH-5431"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("--json-schema");
    expect(logs[0]!).toContain("--output-format");
    expect(logs[0]!).toContain("--no-session-persistence");
  });

  test("runtime-profile supports json output with provided work-unit values", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--agent", "gh-5195", "--work-unit-id", "gh-5195", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.profile).toBe("work-unit");
    expect(parsed.command).toBe("claude");
    expect(parsed.args).toContain("--agent");
    expect(parsed.args).toContain("GH-5195");
    expect(parsed.args).not.toContain("--worktree");
    expect(parsed.allowedActors).toContain("beads");
    expect(parsed.allowedActors).toContain("prx");
    expect(parsed.sourcesOfTruth).toMatchObject({
      agents: "generated",
      mcp: "project-only",
    });
    expect(parsed.sourcesOfTruth.connectors).toEqual([]);
    expect(parsed.trustTiers.tierC_ambient).toContain("claude.ai connectors");
  });

  test("runtime-profile stream-json adds input-format stream-json", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--automation", "--work-unit-id", "GH-5195", "--io-format", "stream-json", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.args).toContain("--input-format");
    expect(parsed.args).toContain("stream-json");
    expect(parsed.args).toContain("--output-format");
    expect(parsed.args).toContain("stream-json");
  });

  test("runtime-profile dev mode returns simplified profile", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      [
        "runtime-profile",
        "--profile",
        "work-unit",
        "--mode",
        "dev",
        "--work-unit-id",
        "GH-5195",
        "--format",
        "json",
      ],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.mode).toBe("dev");
    expect(parsed.args).not.toContain("--strict-mcp-config");
    expect(parsed.args).not.toContain("--mcp-config");
    expect(parsed.args).toContain("--allowedTools");
  });

  test("runtime-profile enforces agent/work-unit identity binding", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--agent", "GH-5196", "--work-unit-id", "GH-5195"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("--agent must equal --work-unit-id");
  });

  test("runtime-profile user profile returns broad runtime", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--profile", "user", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.profile).toBe("user");
    expect(parsed.command).toBe("claude");
    expect(parsed.args).toEqual([]);
    expect(parsed.sourcesOfTruth.connectors).toContain("claude.ai:notion");
  });

  test("runtime-profile rejects invalid work-unit identifiers", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["runtime-profile", "--work-unit-id", "feature/GH-5195"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("--work-unit-id must match CANONICAL-ID format");
  });

  test("stately copies machine output and opens url after prompt", () => {
    const logs: string[] = [];
    let copied = "";
    let openedUrl = "";
    const exitCode = runCliDirect(
      ["stately", "--url", "https://stately.ai/registry/editor/"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        copyToClipboard: (text) => {
          copied = text;
        },
        openAfterEnter: (url) => {
          openedUrl = url;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(copied).toContain('import { createMachine } from "xstate";');
    expect(openedUrl).toBe("https://stately.ai/registry/editor/");
    expect(logs[0]!).toContain("Copied machine to clipboard and opened https://stately.ai/registry/editor/");
  });

  test("stately supports the system model", () => {
    let copied = "";
    const exitCode = runCliDirect(
      ["stately", "--model", "system"],
      {
        log: () => {},
        error: () => {},
      },
      {
        copyToClipboard: (text) => {
          copied = text;
        },
        openAfterEnter: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(copied).toContain('"id": "prSystem"');
    expect(copied).toContain("isMergeable");
  });

  test("contract init bootstraps a contract with sensible defaults", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["contract", "init"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        initContract: async (outputPath, options) => {
          expect(outputPath).toBe(".pr/local/pr.json");
          expect(options.ready).toBe(false);
          expect(options.forceBeads).toBe(false);
          expect(options.changeType).toEqual(["feature"]);
          expect(options.generatedBy).toBe("codex");
          expect(options.untracked).toBe(false);
          return {
            outputPath: ".pr/local/pr.json",
            title: "Example title",
            summary: "Example summary",
            excludePath: "/fixtures/repo/.git/info/exclude",
            excludeRules: [".pr/"],
            excludeUpdatedRules: [".pr/"],
            excludeRemovedRules: [".prx/"],
            prxGitignorePaths: [
              "/fixtures/repo/.prx/.gitignore",
              "/fixtures/repo/.prx/repos/.gitignore",
            ],
            beadsSetup: {
              status: "initialized",
              canonicalRepoId: "io.github.bdelanghe/ai-home",
              database: "io_github_bdelanghe_ai_home",
              githubRepository: "bdelanghe/ai-home",
              prefix: "ai-home",
            },
            workspaceTrack: true,
            workspaceConfigPath: "/fixtures/repo/prx.toml",
            workspaceTrackPersisted: false,
            trackedPrxFiles: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(logs).toEqual([
      "Initialized PR contract at .pr/local/pr.json\ntitle=Example title\nsummary=Example summary\nRemoved legacy .prx/ from /fixtures/repo/.git/info/exclude\nAdded .pr/ to /fixtures/repo/.git/info/exclude\nEnsured /fixtures/repo/.prx/.gitignore\nEnsured /fixtures/repo/.prx/repos/.gitignore\nInitialized beads for io.github.bdelanghe/ai-home (database=io_github_bdelanghe_ai_home, prefix=ai-home, github=bdelanghe/ai-home)",
    ]);
  });

  test("contract init supports json output", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["contract", "init", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        initContract: async () => ({
          outputPath: ".pr/local/pr.json",
          title: "Example title",
          summary: "Example summary",
          excludePath: "/fixtures/repo/.git/info/exclude",
          excludeRules: [".pr/"],
          excludeUpdatedRules: [],
          excludeRemovedRules: [],
          prxGitignorePaths: [
            "/fixtures/repo/.prx/.gitignore",
            "/fixtures/repo/.prx/repos/.gitignore",
          ],
          beadsSetup: {
            status: "unchanged",
            canonicalRepoId: "io.github.bdelanghe/ai-home",
            database: "io_github_bdelanghe_ai_home",
            githubRepository: "bdelanghe/ai-home",
          },
          workspaceTrack: true,
          workspaceConfigPath: "/fixtures/repo/prx.toml",
          workspaceTrackPersisted: false,
          trackedPrxFiles: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      outputPath: ".pr/local/pr.json",
      title: "Example title",
      summary: "Example summary",
      excludePath: "/fixtures/repo/.git/info/exclude",
      excludeRules: [".pr/"],
      excludeUpdatedRules: [],
      excludeRemovedRules: [],
      prxGitignorePaths: [
        "/fixtures/repo/.prx/.gitignore",
        "/fixtures/repo/.prx/repos/.gitignore",
      ],
      beadsSetup: {
        status: "unchanged",
        canonicalRepoId: "io.github.bdelanghe/ai-home",
        database: "io_github_bdelanghe_ai_home",
        githubRepository: "bdelanghe/ai-home",
      },
    });
  });

  test("contract init forwards force-beads to contract setup", async () => {
    const exitCode = await runCliDirect(
      ["contract", "init", "--force-beads"],
      {
        log: () => {},
        error: () => {},
      },
      {
        initContract: async (_outputPath, options) => {
          expect(options.forceBeads).toBe(true);
          return {
            outputPath: ".pr/local/pr.json",
            title: "Example title",
            summary: "Example summary",
            excludePath: null,
            excludeRules: [],
            excludeUpdatedRules: [],
            excludeRemovedRules: [],
            prxGitignorePaths: [],
            beadsSetup: {
              status: "forced",
              canonicalRepoId: "io.github.bdelanghe/ai-home",
              database: "io_github_bdelanghe_ai_home",
              githubRepository: "bdelanghe/ai-home",
              prefix: "ai-home",
            },
            workspaceTrack: true,
            workspaceConfigPath: null,
            workspaceTrackPersisted: false,
            trackedPrxFiles: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
  });

  test("init --untracked writes .prx/ to info/exclude, skips internal .gitignores, and persists track=false", async () => {
    // realpathSync: on macOS `/var` symlinks to `/private/var`; mkdtempSync
    // returns the symlinked path but `process.chdir` + the resolved config path
    // report the realpath, so compare against the realpath to avoid a flake.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-state-init-untracked-")));
    execFileSync("git", ["-C", root, "init", "-q"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const result = await initContract(".pr/local/pr.json", {
        ready: false,
        forceBeads: false,
        changeType: ["feature"],
        generatedBy: "codex",
        untracked: true,
      });

      expect(result.workspaceTrack).toBe(false);
      expect(result.workspaceTrackPersisted).toBe(true);
      expect(result.workspaceConfigPath).toBe(join(root, "prx.toml"));
      expect(result.excludeRules).toEqual([".pr/", ".prx/"]);
      expect(result.excludeUpdatedRules).toEqual([".pr/", ".prx/"]);
      expect(result.excludeRemovedRules).toEqual([]);
      expect(result.prxGitignorePaths).toEqual([]);

      const excludeContents = readFileSync(join(root, ".git/info/exclude"), "utf8");
      expect(excludeContents).toContain(".pr/");
      expect(excludeContents).toContain(".prx/");

      expect(existsSync(join(root, ".prx/.gitignore"))).toBe(false);
      expect(existsSync(join(root, ".prx/repos/.gitignore"))).toBe(false);

      const tomlContents = readFileSync(join(root, "prx.toml"), "utf8");
      expect(tomlContents).toContain("[workspace]");
      expect(tomlContents).toContain("track = false");
      expect(loadWorkspaceConfig(root).track).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init --untracked is idempotent across repeated runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-init-untracked-idempotent-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await initContract(".pr/local/pr.json", {
        ready: false,
        forceBeads: false,
        changeType: ["feature"],
        generatedBy: "codex",
        untracked: true,
      });
      const firstExclude = readFileSync(join(root, ".git/info/exclude"), "utf8");
      const firstToml = readFileSync(join(root, "prx.toml"), "utf8");

      const secondResult = await initContract(".pr/local/pr.json", {
        ready: false,
        forceBeads: false,
        changeType: ["feature"],
        generatedBy: "codex",
        untracked: true,
      });

      // Track already persisted → no re-write flagged.
      expect(secondResult.workspaceTrackPersisted).toBe(false);
      expect(secondResult.workspaceTrack).toBe(false);
      // No duplicate .prx/ lines in exclude.
      const secondExclude = readFileSync(join(root, ".git/info/exclude"), "utf8");
      expect(secondExclude).toBe(firstExclude);
      const prxMatches = secondExclude.split("\n").filter((line) => line.trim() === ".prx/");
      expect(prxMatches.length).toBe(1);
      // prx.toml unchanged.
      expect(readFileSync(join(root, "prx.toml"), "utf8")).toBe(firstToml);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init honors persisted [workspace] track = false without --untracked flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-init-persisted-false-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    writeFileSync(join(root, "prx.toml"), ["[workspace]", "track = false", ""].join("\n"));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const result = await initContract(".pr/local/pr.json", {
        ready: false,
        forceBeads: false,
        changeType: ["feature"],
        generatedBy: "codex",
      });
      expect(result.workspaceTrack).toBe(false);
      expect(result.workspaceTrackPersisted).toBe(false);
      expect(result.excludeRules).toEqual([".pr/", ".prx/"]);
      expect(result.prxGitignorePaths).toEqual([]);
      expect(existsSync(join(root, ".prx/.gitignore"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init without --untracked keeps tracked-mode behavior: writes internal .gitignores and strips legacy .prx/ from exclude", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-init-default-tracked-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(join(root, ".git/info"), { recursive: true });
    writeFileSync(join(root, ".git/info/exclude"), ".prx/\n");
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const result = await initContract(".pr/local/pr.json", {
        ready: false,
        forceBeads: false,
        changeType: ["feature"],
        generatedBy: "codex",
      });
      expect(result.workspaceTrack).toBe(true);
      expect(result.excludeRules).toEqual([".pr/"]);
      expect(result.excludeRemovedRules).toEqual([".prx/"]);
      expect(result.prxGitignorePaths.length).toBe(2);
      expect(existsSync(join(root, ".prx/.gitignore"))).toBe(true);
      expect(existsSync(join(root, ".prx/repos/.gitignore"))).toBe(true);

      const excludeContents = readFileSync(join(root, ".git/info/exclude"), "utf8");
      expect(excludeContents.split("\n").filter((line) => line.trim() === ".prx/")).toEqual([]);
      expect(excludeContents).toContain(".pr/");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("contract init --untracked surfaces a nudge when .prx/ files are already tracked", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-init-untracked-tracked-files-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    // GH-261: hermetic — never sign the seed commit (no 1Password/gpg in CI/sandbox).
    execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
    mkdirSync(join(root, ".prx"), { recursive: true });
    writeFileSync(join(root, ".prx/.gitignore"), "*\n!.gitignore\n");
    execFileSync("git", ["-C", root, "add", ".prx/.gitignore"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed .prx/.gitignore"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    const logs: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["contract", "init", "--untracked"],
        { log: (l) => logs.push(l), error: () => {} },
      );
      expect(exitCode).toBe(0);
      const combined = logs.join("\n");
      expect(combined).toContain("Detected tracked .prx/ files.");
      expect(combined).toContain("git rm -r --cached .prx/");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("contract init rejects invalid [workspace] track values in prx.toml with a clear error", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-init-bad-track-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    writeFileSync(join(root, "prx.toml"), ["[workspace]", 'track = "yes"', ""].join("\n"));
    const previousCwd = process.cwd();
    process.chdir(root);
    const errs: string[] = [];
    try {
      const exitCode = await runCliDirect(
        ["contract", "init"],
        { log: () => {}, error: (l) => errs.push(l) },
      );
      expect(exitCode).not.toBe(0);
      expect(errs.join("\n")).toContain("track must be a boolean");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("buildInitialPrContract produces the expected shape for draft and ready modes", () => {
    const draft = buildInitialPrContract({
      title: "t",
      summary: "s",
      generatedBy: "codex",
      ready: false,
      changeType: ["feature"],
    }) as {
      version: string;
      pr: {
        lifecycle: { state: string };
        ready: { value: boolean; notes: string[] };
        change_type: string[];
      };
      provenance: { generated_by: string; generated_at: string };
    };

    expect(draft.version).toBe("1.2.0");
    expect(draft.pr.lifecycle.state).toBe("drafting");
    expect(draft.pr.ready.value).toBe(false);
    expect(draft.pr.ready.notes[0]).toContain(
      "Default behavior is to open or keep the PR as draft",
    );
    expect(draft.provenance.generated_by).toBe("codex");
    expect(draft.provenance.generated_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(draft.pr.change_type).toEqual(["feature"]);

    const ready = buildInitialPrContract({
      title: "t",
      summary: "s",
      generatedBy: "codex",
      ready: true,
      changeType: ["feature"],
    }) as {
      pr: {
        lifecycle: { state: string };
        ready: { value: boolean; notes: string[] };
      };
    };

    expect(ready.pr.lifecycle.state).toBe("ready_for_review");
    expect(ready.pr.ready.value).toBe(true);
    expect(ready.pr.ready.notes).toEqual([]);

    const deduped = buildInitialPrContract({
      title: "t",
      summary: "s",
      generatedBy: "codex",
      ready: false,
      changeType: ["feature", "feature", "bugfix"],
    }) as { pr: { change_type: string[] } };
    expect(deduped.pr.change_type).toEqual(["feature", "bugfix"]);

    expect(() =>
      buildInitialPrContract({
        title: "t",
        summary: "s",
        generatedBy: "codex",
        ready: false,
        changeType: ["typo"],
      }),
    ).toThrow(/Invalid change type/);
  });

  test("initContract writes pr.json with expected shape without shelling out to a script", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-init-install-layout-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await initContract(".pr/local/pr.json", {
        ready: false,
        forceBeads: false,
        changeType: ["feature"],
        generatedBy: "codex",
        title: "smoke",
        summary: "smoke",
      });

      const contractPath = join(root, ".pr/local/pr.json");
      expect(existsSync(contractPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(contractPath, "utf8")) as {
        version: string;
        pr: { title: string; summary: string; lifecycle: { state: string } };
      };
      expect(parsed.version).toBe("1.2.0");
      expect(parsed.pr.title).toBe("smoke");
      expect(parsed.pr.summary).toBe("smoke");
      expect(parsed.pr.lifecycle.state).toBe("drafting");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check-issue PROJECT-<n> without a notion source surfaces a configuration error", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-check-issue-no-resolver-"));
    writeFileSync(
      join(root, "prx.toml"),
      [
        "[sources.github]",
        'kind = "github"',
        'canonical_id_pattern = "^(GH|PROJECT)-\\\\d+$"',
        "",
      ].join("\n"),
    );
    execFileSync("git", ["-C", root, "init", "-q"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    const errs: string[] = [];
    const exitCode = await runCliDirect(
      ["check-issue", "PROJECT-6688"],
      { log: () => {}, error: (l) => errs.push(l) },
    );
    process.chdir(previousCwd);
    expect(exitCode).toBe(1);
    expect(errs.some((l) => l.includes("no issue-authority resolver is configured"))).toBe(true);
  });

  // prx-lrw: when no issue authority can resolve the unit but a CAS submit/plan
  // artifact projects it, check-issue passes on the artifact graph (the publish
  // parity preflight must not require a live bd/GH row). Mirrors
  // checkWorkUnitChain's `artifact_projected` acceptance.
  test("check-issue accepts a canonical id with no resolver when an artifact projects it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-check-issue-projected-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[sources.github]", 'kind = "github"', 'canonical_id_pattern = "^(GH|PROJECT)-\\\\d+$"', ""].join("\n"),
    );
    execFileSync("git", ["-C", root, "init", "-q"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["check-issue", "PROJECT-6688", "--format", "json"],
      { log: (l) => logs.push(l), error: () => {} },
      { hasLocalArtifactProjection: async () => true },
    );
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("artifact_projected"))).toBe(true);
  });

  test("check-issue still refuses a canonical id with no resolver and no artifact projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-state-check-issue-unprojected-"));
    writeFileSync(
      join(root, "prx.toml"),
      ["[sources.github]", 'kind = "github"', 'canonical_id_pattern = "^(GH|PROJECT)-\\\\d+$"', ""].join("\n"),
    );
    execFileSync("git", ["-C", root, "init", "-q"]);
    const previousCwd = process.cwd();
    process.chdir(root);
    const errs: string[] = [];
    const exitCode = await runCliDirect(
      ["check-issue", "PROJECT-6688"],
      { log: () => {}, error: (l) => errs.push(l) },
      { hasLocalArtifactProjection: async () => false },
    );
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
    expect(exitCode).toBe(1);
    expect(errs.some((l) => l.includes("no issue-authority resolver is configured"))).toBe(true);
  });

  test("canonical beads repo ids are derived from github remotes", () => {
    expect(canonicalBeadsRepoIdFromRemote("git@github.com:bdelanghe/ai-home.git")).toBe("io.github.bdelanghe/ai-home");
    expect(canonicalBeadsRepoIdFromRemote("https://github.com/demo/demo-web.git")).toBe("io.github.demo/demo-web");
    expect(canonicalBeadsDatabaseName("io.github.demo/demo-web")).toBe("io_github_demo_demo_web");
  });

  test("beads init setup initializes fresh repos with canonical database names", () => {
    const commands: string[][] = [];
    const runner = (command: string[]) => {
      commands.push(command);
      const joined = command.join(" ");
      if (joined === "bd version") {
        return { status: 0, stdout: "0.61.0\n", stderr: "" };
      }
      if (joined === "git remote get-url origin") {
        return { status: 0, stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "" };
      }
      if (joined === "bd context --json") {
        return { status: 1, stdout: "", stderr: "not initialized" };
      }
      if (joined === "bd init --prefix ai-home --database io_github_bdelanghe_ai_home") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "bd config get github.repository") {
        return { status: 1, stdout: "", stderr: "unset" };
      }
      if (joined === "bd config set github.repository bdelanghe/ai-home") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "bd config set doctor.suppress.git-hooks true") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (joined === "bd vc commit -m prx init: stabilize config state") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    expect(ensureBeadsInitSetup("/fixtures/repo", runner)).toEqual({
      status: "initialized",
      canonicalRepoId: "io.github.bdelanghe/ai-home",
      database: "io_github_bdelanghe_ai_home",
      githubRepository: "bdelanghe/ai-home",
      prefix: "ai-home",
    });
    expect(commands.map((command) => command.join(" "))).toEqual([
      "bd version",
      "git remote get-url origin",
      "bd context --json",
      "bd init --prefix ai-home --database io_github_bdelanghe_ai_home",
      "bd config get github.repository",
      "bd config set github.repository bdelanghe/ai-home",
      "bd config set doctor.suppress.git-hooks true",
      "bd vc commit -m prx init: stabilize config state",
    ]);
  });

  test("beads init setup does not rewrite an existing mismatched database", () => {
    const runner = (command: string[]) => {
      const joined = command.join(" ");
      if (joined === "bd version") {
        return { status: 0, stdout: "0.61.0\n", stderr: "" };
      }
      if (joined === "git remote get-url origin") {
        return { status: 0, stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "" };
      }
      if (joined === "bd context --json") {
        return { status: 0, stdout: JSON.stringify({ database: "bdelanghe_demo" }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    expect(ensureBeadsInitSetup("/fixtures/repo", runner)).toEqual({
      status: "skipped",
      reason: "existing beads database bdelanghe_demo does not match io_github_bdelanghe_ai_home",
      canonicalRepoId: "io.github.bdelanghe/ai-home",
      database: "io_github_bdelanghe_ai_home",
      githubRepository: "bdelanghe/ai-home",
    });
  });

  test("beads init setup can force a mismatched database to the canonical name", () => {
    const commands: string[][] = [];
    const runner = (command: string[]) => {
      commands.push(command);
      const joined = command.join(" ");
      if (joined === "bd version") {
        return { status: 0, stdout: "0.61.0\n", stderr: "" };
      }
      if (joined === "git remote get-url origin") {
        return { status: 0, stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "" };
      }
      if (joined === "bd context --json") {
        return { status: 0, stdout: JSON.stringify({ database: "bdelanghe_demo" }), stderr: "" };
      }
      if (joined === "bd init --prefix ai-home --database io_github_bdelanghe_ai_home --force --destroy-token DESTROY-ai-home") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "bd config get github.repository") {
        return { status: 1, stdout: "", stderr: "unset" };
      }
      if (joined === "bd config set github.repository bdelanghe/ai-home") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "bd config set doctor.suppress.git-hooks true") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (joined === "bd vc commit -m prx init: stabilize config state") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    expect(ensureBeadsInitSetup("/fixtures/repo", runner, { force: true })).toEqual({
      status: "forced",
      canonicalRepoId: "io.github.bdelanghe/ai-home",
      database: "io_github_bdelanghe_ai_home",
      githubRepository: "bdelanghe/ai-home",
      prefix: "ai-home",
    });
    expect(commands.map((command) => command.join(" "))).toEqual([
      "bd version",
      "git remote get-url origin",
      "bd context --json",
      "bd init --prefix ai-home --database io_github_bdelanghe_ai_home --force --destroy-token DESTROY-ai-home",
      "bd config get github.repository",
      "bd config set github.repository bdelanghe/ai-home",
      "bd config set doctor.suppress.git-hooks true",
      "bd vc commit -m prx init: stabilize config state",
    ]);
  });

  test("beads init setup accepts JSON output from bd config get", () => {
    const commands: string[][] = [];
    const runner = (command: string[]) => {
      commands.push(command);
      const joined = command.join(" ");
      if (joined === "bd version") {
        return { status: 0, stdout: "0.61.0\n", stderr: "" };
      }
      if (joined === "git remote get-url origin") {
        return { status: 0, stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "" };
      }
      if (joined === "bd context --json") {
        return { status: 0, stdout: JSON.stringify({ database: "io_github_bdelanghe_ai_home" }), stderr: "" };
      }
      if (joined === "bd config get github.repository") {
        return {
          status: 0,
          stdout: JSON.stringify({ key: "github.repository", value: "bdelanghe/ai-home" }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    expect(ensureBeadsInitSetup("/fixtures/repo", runner)).toEqual({
      status: "unchanged",
      canonicalRepoId: "io.github.bdelanghe/ai-home",
      database: "io_github_bdelanghe_ai_home",
      githubRepository: "bdelanghe/ai-home",
    });
    expect(commands.map((command) => command.join(" "))).toEqual([
      "bd version",
      "git remote get-url origin",
      "bd context --json",
      "bd config get github.repository",
    ]);
  });

  test("beads-init force-repairs stale canonical context when the database is unavailable", () => {
    const logs: string[] = [];
    const commands: string[] = [];
    const spawn = (file: string, args: readonly string[], options?: { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv }) => {
      void options;
      const joined = [file, ...args].join(" ");
      commands.push(joined);
      if (joined === "git rev-parse --show-toplevel") {
        return { status: 0, stdout: "/fixtures/repo\n", stderr: "" };
      }
      if (joined === "git -C /fixtures/repo remote get-url origin") {
        return { status: 0, stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "" };
      }
      if (joined === "bd context --json") {
        return {
          status: 0,
          stdout: JSON.stringify({ database: "io_github_bdelanghe_ai_home" }),
          stderr: "",
        };
      }
      if (joined === "bd info") {
        return {
          status: 1,
          stdout: "",
          stderr: 'database "io_github_bdelanghe_ai_home" not found',
        };
      }
      if (joined === "bd bootstrap --yes") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "bd config set github.repository bdelanghe/ai-home") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "bd config set doctor.suppress.git-hooks true") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (joined === "beads ready") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      throw new Error(`Unexpected command: ${joined}`);
    };

    expect(runBeadsInit(
      "/fixtures/repo",
      false,
      false,
      { log: (line) => logs.push(line) },
      spawn,
    )).toBe(0);

    expect(logs).toContain("repair: canonical metadata matches, but database is unavailable; running beads bootstrap");
    expect(logs).toContain("verified db:       io_github_bdelanghe_ai_home");
    expect(logs).toContain("verified:          beads ready");
    expect(commands).toEqual([
      "git rev-parse --show-toplevel",
      "git -C /fixtures/repo remote get-url origin",
      "bd context --json",
      "bd info",
      "bd bootstrap --yes",
      "bd config set github.repository bdelanghe/ai-home",
      "bd config set doctor.suppress.git-hooks true",
      "bd context --json",
      "beads ready",
    ]);
  });

  test("status supports plain output", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli(["status", "--contract", contractPath]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("drafting (draft)");
  });

  test("status shows a helpful message when the local contract is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-state-cli-missing-"));
    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath, "status"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("Missing PR contract at");
    expect(new TextDecoder().decode(result.stderr)).toContain("prx contract init");
  });

  test("status supports mode and json output", () => {
    const contractPath = makeContractFile("ready_for_review", true);

    const modeResult = runCli(["status", "--contract", contractPath, "--format", "mode"]);
    expect(modeResult.exitCode).toBe(0);
    expect(new TextDecoder().decode(modeResult.stdout).trim()).toBe("ready");

    const jsonResult = runCli(["status", "--contract", contractPath, "--format", "json"]);
    expect(jsonResult.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(jsonResult.stdout))).toMatchObject({
      mode: "ready",
      state: "ready_for_review",
      title: "CLI Example",
    });
  });

  test("transition updates the contract", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "transition",
      "--contract",
      contractPath,
      "--to",
      "validating",
      "--actor",
      "pr-prime",
      "--reason",
      "Checklist complete",
    ]);

    expect(result.exitCode).toBe(0);
    const next = JSON.parse(readFileSync(contractPath, "utf8"));
    expect(next.pr.lifecycle.state).toBe("validating");
    expect(next.pr.ready.value).toBe(false);
  });

  test("transition supports json output", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "transition",
      "--contract",
      contractPath,
      "--to",
      "validating",
      "--actor",
      "pr-prime",
      "--reason",
      "Checklist complete",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      state: "validating",
      mode: "draft",
      transition: {
        to: "validating",
        actor: "pr-prime",
        reason: "Checklist complete",
      },
    });
  });

  test("transition fails on invalid state changes", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli(["transition", "--contract", contractPath, "--to", "merged"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "FAIL: invalid transition from `drafting` to `merged`",
    );
  });

  test("event applies a skill transition", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "event",
      "--contract",
      contractPath,
      "--skill",
      "pr-validate",
      "--actor",
      "prx",
      "--reason",
      "validate run",
    ]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("validating (draft) - SKILL_VALIDATE via pr-validate");
  });

  test("event supports json output", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "event",
      "--contract",
      contractPath,
      "--skill",
      "pr-validate",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      skill: "pr-validate",
      event: "SKILL_VALIDATE",
      kind: "transition",
      from: "drafting",
      to: "validating",
      state: "validating",
      mode: "draft",
    });
  });

  test("event records when transition is invalid for current state", () => {
    const contractPath = makeContractFile("merged", true);
    const result = runCli([
      "event",
      "--contract",
      contractPath,
      "--skill",
      "pr-validate",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      skill: "pr-validate",
      event: "SKILL_VALIDATE",
      kind: "observe",
      from: "merged",
      to: "validating",
      transitionApplied: false,
      blockedTransition: {
        from: "merged",
        to: "validating",
      },
      state: "merged",
      mode: "ready",
    });
  });

  test("contract command records pr-contract event", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "contract",
      "--contract",
      contractPath,
      "--actor",
      "prx",
      "--reason",
      "contract sync",
    ]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("drafting (draft) - SKILL_CONTRACT via pr-contract");
  });

  test("contract supports json output", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "contract",
      "--contract",
      contractPath,
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      skill: "pr-contract",
      event: "SKILL_CONTRACT",
      kind: "observe",
      from: "drafting",
      to: "drafting",
      state: "drafting",
      mode: "draft",
    });
  });

  test("skills shows catalog in plain output", () => {
    const contractPath = makeContractFile("drafting", false);
    const result = runCli([
      "skills",
      "--contract",
      contractPath,
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("pr skill catalog");
    expect(stdout).toContain("current state: drafting");
    expect(stdout).toContain("pr-validate -> SKILL_VALIDATE -> validating (allowed=yes)");
    expect(stdout).toContain("pr-contract -> SKILL_CONTRACT (observe)");
  });

  test("skills supports json output", () => {
    const contractPath = makeContractFile("ready_for_review", true);
    const result = runCli([
      "skills",
      "--contract",
      contractPath,
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(parsed.currentState).toBe("ready_for_review");
    expect(parsed.skills.find((item: { skill: string }) => item.skill === "pr-contract")).toMatchObject({
      skill: "pr-contract",
      event: "SKILL_CONTRACT",
      kind: "observe",
    });
  });

  test("open-mode supports mode json and gh-create", () => {
    const contractPath = makeContractFile("drafting", false);

    const modeResult = runCli(["open-mode", "--contract", contractPath, "--format", "mode"]);
    expect(new TextDecoder().decode(modeResult.stdout).trim()).toBe("draft");

    const jsonResult = runCli(["open-mode", "--contract", contractPath, "--format", "json"]);
    expect(JSON.parse(new TextDecoder().decode(jsonResult.stdout))).toMatchObject({
      mode: "draft",
      state: "drafting",
    });

    const createResult = runCli(["open-mode", "--contract", contractPath, "--format", "gh-create"]);
    expect(new TextDecoder().decode(createResult.stdout).trim()).toBe("gh pr create --draft");
  });

  test("open-mode gh-ready requires a pr ref", () => {
    const contractPath = makeContractFile("ready_for_review", true);
    const result = runCli(["open-mode", "--contract", contractPath, "--format", "gh-ready"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr).trim()).toBe(
      "--pr is required with --format gh-ready",
    );
  });

  test("open-mode gh-ready returns the gh command", () => {
    const contractPath = makeContractFile("ready_for_review", true);
    const result = runCli([
      "open-mode",
      "--contract",
      contractPath,
      "--format",
      "gh-ready",
      "--pr",
      "123",
    ]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("gh pr ready 123");
  });

  test("graph prints the system machine summary", () => {
    const result = runCli(["graph"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("PR System State Machine");
    expect(stdout).toContain("Merge gate: lifecycle=open AND ci=passed AND review=approved AND mergeability=clean");
    expect(stdout).toContain("workflowBackbone");
  });

  test("graph supports json output", () => {
    const result = runCli(["graph", "--format", "json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      id: "prSystem",
      type: "parallel",
      axes: ["lifecycle", "review", "ci", "mergeability", "workflowBackbone"],
    });
  });

  test("graph supports xstate-json output", () => {
    const result = runCli(["graph", "--format", "xstate-json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      id: "prSystem",
      type: "parallel",
      states: {
        lifecycle: {},
        ci: {},
      },
    });
  });

  test("graph supports xstate-ts output", () => {
    const result = runCli(["graph", "--format", "xstate-ts"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('import { createMachine } from "xstate";');
    expect(stdout).toContain("export const machine = createMachine(");
    expect(stdout).toContain('"id": "prSystem"');
    expect(stdout).toContain(").provide({");
  });

  test("graph supports mermaid output", () => {
    const result = runCli(["graph", "--format", "mermaid"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("stateDiagram-v2");
    expect(stdout).toContain('state "lifecycle" as lifecycle');
    expect(stdout).toContain("open --> merged: MERGE [isMergeable]");
    expect(stdout).toContain('state "workflowBackbone" as workflowBackbone');
  });

  test("graph supports xstate-mermaid output alias", () => {
    const result = runCli(["graph", "--format", "xstate-mermaid"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("stateDiagram-v2");
    expect(stdout).toContain('state "lifecycle" as lifecycle');
    expect(stdout).toContain('state "workflowBackbone" as workflowBackbone');
  });

  test("graph supports xstate-system-json output", () => {
    const result = runCli(["graph", "--format", "xstate-system-json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      id: "prSystem",
      type: "parallel",
      states: {
        lifecycle: {},
        ci: {},
        workflowBackbone: { initial: "no_worktree" },
      },
    });
  });

  test("graph supports xstate-system-json validation", () => {
    const result = runCli(["graph", "--format", "xstate-system-json", "--validate"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      id: "prSystem",
      type: "parallel",
    });
  });

  test("graph validates and writes output file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-state-graph-"));
    const outputPath = join(dir, "machine.json");
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["graph", "--format", "xstate-system-json", "--validate", "--output", outputPath],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {},
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain(`Wrote graph output to ${outputPath}`);
    expect(logs[0]!).toContain("json-ok");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      id: "prSystem",
    });
  });

  test("graph validation fails for non-json formats", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["graph", "--format", "mermaid", "--validate"],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
      {},
    );

    expect(exitCode).toBe(1);
    expect(logs).toHaveLength(0);
    expect(errors[0]).toContain("--validate requires a JSON graph format");
  });

  test("graph --open opens URL after successful generation", () => {
    let openedUrl = "";
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["graph", "--format", "xstate-system-json", "--validate", "--open"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        openUrl: (url) => {
          openedUrl = url;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(openedUrl).toBe("https://stately.ai/registry/editor/");
    expect(JSON.parse(logs[0]!)).toMatchObject({
      id: "prSystem",
    });
  });

  test("graph supports xstate-system-ts output", () => {
    const result = runCli(["graph", "--format", "xstate-system-ts"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('import { createMachine } from "xstate";');
    expect(stdout).toContain('"id": "prSystem"');
    expect(stdout).toContain("isMergeable");
    expect(stdout).toContain('"workflowBackbone"');
    expect(stdout).toContain('"no_worktree"');
    // GH-1275 (PR-3 of GH-1261): the dep-research per-run machine is also
    // exported from the same module so consumers can inspect both lifecycles.
    expect(stdout).toContain("export const depResearchMachine = createMachine(");
    expect(stdout).toContain('"id": "dep_research"');
    expect(stdout).toContain('"fetching"');
    expect(stdout).toContain('"snapshotting"');
    expect(stdout).toContain('"diffing"');
    expect(stdout).toContain('"classifying"');
    expect(stdout).toContain('"no_delta"');
    expect(stdout).toContain('"reporting"');
    expect(stdout).toContain('"classificationIsNone"');
    // GH-1537: the per-pair beads↔external-mirror reconcile machine is
    // exported from the same module too.
    expect(stdout).toContain("export const domainSyncMachine = createMachine(");
    expect(stdout).toContain('"id": "domain_sync"');
    expect(stdout).toContain('"pulling"');
    expect(stdout).toContain('"pushing"');
  });

  test("graph supports system-mermaid output", () => {
    const result = runCli(["graph", "--format", "system-mermaid"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("stateDiagram-v2");
    expect(stdout).toContain("state \"lifecycle\" as lifecycle");
    expect(stdout).toContain("open --> merged: MERGE [isMergeable]");
    expect(stdout).toContain("state \"workflowBackbone\" as workflowBackbone");
    expect(stdout).toContain("[*] --> no_worktree");
  });

  test("graph supports xstate-system-mermaid output alias", () => {
    const result = runCli(["graph", "--format", "xstate-system-mermaid"]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("stateDiagram-v2");
    expect(stdout).toContain("state \"lifecycle\" as lifecycle");
    expect(stdout).toContain("state \"workflowBackbone\" as workflowBackbone");
  });

  test("update supports dry-run output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["update"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        updatePrFromContract: () => ({
          exitCode: 0,
          lines: ["WOULD RENDER .pr/local/pr.json -> .pr/local/pr.md"],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs).toEqual(["WOULD RENDER .pr/local/pr.json -> .pr/local/pr.md"]);
  });

  test("update supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["update", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        updatePrFromContract: () => ({
          exitCode: 0,
          lines: ["WOULD RENDER .pr/local/pr.json -> .pr/local/pr.md"],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      exitCode: 0,
      lines: ["WOULD RENDER .pr/local/pr.json -> .pr/local/pr.md"],
    });
  });

  test("sync-status supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["sync-status", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        syncStatus: () => ({
          exitCode: 0,
          lines: ["No open PRs found for @me."],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      exitCode: 0,
      lines: ["No open PRs found for @me."],
    });
  });

  test("sync-issues supports json output", async () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["sync-issues", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        syncGitHubIssuesToBeads: async () => ({
          exitCode: 0,
          lines: ["WOULD UPDATE beads github.repository: unset -> owner/repo", "Dry run complete"],
        }),
      },
    );

    expect(await exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      exitCode: 0,
      lines: ["WOULD UPDATE beads github.repository: unset -> owner/repo", "Dry run complete"],
    });
  });

  test("sync-issues --apply force-repairs beads setup before syncing", async () => {
    const logs: string[] = [];
    let observedBeadsOptions:
      | { cwd: string | undefined; options?: Parameters<typeof ensureBeadsInitSetup>[2] }
      | undefined;
    const syncCalls: Array<{ repoPath: string; apply: boolean }> = [];
    const exitCode = runCliDirect(
      ["sync-issues", "--apply"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        ensureBeadsInitSetup: (
          cwd,
          _runner,
          options?: Parameters<typeof ensureBeadsInitSetup>[2],
        ) => {
          observedBeadsOptions = { cwd, options };
          return {
            status: "forced",
            canonicalRepoId: "io.github.bdelanghe/ai-home",
            database: "io_github_bdelanghe_ai_home",
            githubRepository: "bdelanghe/ai-home",
            prefix: "ai-home",
          };
        },
        syncGitHubIssuesToBeads: async (repoPath, apply) => {
          syncCalls.push({ repoPath, apply });
          return { exitCode: 0, lines: ["Sync applied"] };
        },
      },
    );

    expect(await exitCode).toBe(0);
    expect(syncCalls).toEqual([{ repoPath: ".", apply: true }]);
    expect(logs).toEqual(["Sync applied"]);
    expect(observedBeadsOptions).toBeDefined();
    expect(observedBeadsOptions?.options?.force).toBe(true);
    expect(observedBeadsOptions?.cwd).toBe(".");
  });

  test("overview supports dry-run formatting", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["overview"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        overviewStatus: () => ({
          repo: "owner/repo",
          currentBranch: {
            number: 10,
            title: "Current branch PR",
            branch: "feature-branch",
            url: "https://example.com/10",
            draft: false,
            checks: "green",
            review: "review_required",
            approvals: 0,
            mergeable: "mergeable",
            worktree: {
              clean: true,
              staged: 0,
              unstaged: 0,
              untracked: 0,
              conflicts: 0,
            },
            diff: {
              files: 12,
              additions: 48,
              deletions: 9,
            },
            local: {
              worktreePath: "/repo/feature-branch",
              contractPath: "/repo/feature-branch/.pr/local/pr.json",
              lifecycle: "ready_for_review",
              mode: "ready",
            },
          },
          createdByYou: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Relevant pull requests in owner/repo");
    expect(logs[0]!).toContain("Current branch PR");
    expect(logs[0]!).toContain("✓ Checks passing - Review required | mergeable | wt clean | diff 12f +48/-9 | local ready_for_review (ready)");
  });

  // GH-1757: `prx repo overview <slug>` resolves the registered slug via
  // `locateRepo` and passes `repo.mainWorktree` to `overviewStatus`, so the
  // verb works from any cwd (not only from inside a registered worktree).
  test("overview <slug> resolves via inventory and calls overviewStatus with mainWorktree", () => {
    const logs: string[] = [];
    const overviewCalls: Array<{ repoPath: string; includeDiffStats: boolean | undefined }> = [];
    const exitCode = runCliDirect(
      ["overview", "lima-devshell"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "lima-devshell",
              commonDir: "/bare/io.github/bdelanghe/lima-devshell.git",
              kind: "bare",
              mainWorktree: "/wt/lima-devshell.git/mainx",
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:bdelanghe/lima-devshell.git",
                githubRepo: "bdelanghe/lima-devshell",
              },
              upstreamRemote: null,
            },
          ],
        }),
        overviewStatus: (repoPath, includeDiffStats) => {
          overviewCalls.push({ repoPath, includeDiffStats });
          return { repo: "bdelanghe/lima-devshell", currentBranch: null, createdByYou: [] };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(overviewCalls).toEqual([
      { repoPath: "/wt/lima-devshell.git/mainx", includeDiffStats: true },
    ]);
    expect(logs[0]!).toContain("Relevant pull requests in bdelanghe/lima-devshell");
  });

  // GH-1757: no positional → preserve the prior cwd / `--repo-path` flow.
  // Inventory deps must not be consulted in the no-slug branch.
  test("overview without a slug preserves cwd / --repo-path behavior", () => {
    let inventoryLoaded = false;
    const overviewCalls: Array<{ repoPath: string; includeDiffStats: boolean | undefined }> = [];
    const exitCode = runCliDirect(
      ["overview"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => {
          inventoryLoaded = true;
          return repoInventoryConfigFixture();
        },
        loadRepoInventoryIndex: () => {
          inventoryLoaded = true;
          return { roots: [], repos: [] };
        },
        overviewStatus: (repoPath, includeDiffStats) => {
          overviewCalls.push({ repoPath, includeDiffStats });
          return { repo: "owner/repo", currentBranch: null, createdByYou: [] };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(inventoryLoaded).toBe(false);
    expect(overviewCalls).toEqual([{ repoPath: ".", includeDiffStats: true }]);
  });

  // GH-1757: an unregistered slug surfaces the shared `locateRepo` not-found
  // wording as a `CliError` (exit 1, message on stderr).
  test("overview <unknown-slug> surfaces the locateRepo not-found error", () => {
    const errors: string[] = [];
    const overviewCalls: Array<{ repoPath: string; includeDiffStats: boolean | undefined }> = [];
    const exitCode = runCliDirect(
      ["overview", "not-a-real-slug"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "lima-devshell",
              commonDir: "/bare/io.github/bdelanghe/lima-devshell.git",
              kind: "bare",
              mainWorktree: "/wt/lima-devshell.git/mainx",
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:bdelanghe/lima-devshell.git",
                githubRepo: "bdelanghe/lima-devshell",
              },
              upstreamRemote: null,
            },
          ],
        }),
        overviewStatus: (repoPath, includeDiffStats) => {
          overviewCalls.push({ repoPath, includeDiffStats });
          return { repo: "owner/repo", currentBranch: null, createdByYou: [] };
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(overviewCalls).toEqual([]);
    expect(errors.join("\n")).toContain("No repo registered with slug 'not-a-real-slug'");
  });

  test("repos supports plain output", () => {
    const logs: string[] = [];
    const indexWrites: Array<{ indexPath: string; inventory: unknown }> = [];
    const exitCode = runCliDirect(
      ["repos"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),        discoverLocalRepos: () => ({
          roots: ["/Users/dev/.local/share/git/bare"],
          bareRoot: "/Users/dev/.local/share/git/bare",
          repos: [
            {
              name: "demo-web",
              kind: "bare",
              commonDir: "/Users/dev/.local/share/git/bare/io.github/demo/demo-web.git",
              mainWorktree: null,
              localOnlyBranches: [],
              findings: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:bdelanghe/demo-web.git",
                githubRepo: "bdelanghe/demo-web",
              },
              upstreamRemote: {
                name: "upstream",
                url: "git@github.com:demo/demo-web.git",
                githubRepo: "demo/demo-web",
              },
              remotes: [],
              worktrees: [
                {
                  path: "/Users/dev/.local/state/git/worktrees/io.github/demo/demo-web/main",
                  branch: "main",
                  current: true,
                  kind: "worktree",
                },
              ],
            },
          ],
        }),
        writeRepoInventoryIndex: (indexPath, inventory) => {
          indexWrites.push({ indexPath, inventory });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Local repos");
    expect(logs[0]!).toContain("Configured bare root: /Users/dev/.local/share/git/bare");
    expect(logs[0]!).toContain(`Index: ${repoRoot}/.prx/repos/index.json`);
    expect(logs[0]!).toContain("demo-web (bare)");
    expect(logs[0]!).toContain("remote: origin bdelanghe/demo-web");
    expect(logs[0]!).toContain("upstream: upstream demo/demo-web");
    expect(logs[0]!).toContain("worktrees: 1");
    expect(logs[0]!).toContain("main @ /Users/dev/.local/state/git/worktrees/io.github/demo/demo-web/main current");
    expect(indexWrites).toHaveLength(1);
  });

  test("repos supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repos", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),        discoverLocalRepos: () => ({
          roots: ["/Users/dev/.local/share/git/bare"],
          bareRoot: "/Users/dev/.local/share/git/bare",
          repos: [],
        }),
        writeRepoInventoryIndex: () => {},
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      roots: ["/Users/dev/.local/share/git/bare"],
      bareRoot: "/Users/dev/.local/share/git/bare",
      indexPath: `${repoRoot}/.prx/repos/index.json`,
      repos: [],
    });
  });

  test("repos --local reports local-only branches and exits nonzero", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repos", "--local"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),        discoverLocalRepos: () => ({
          roots: ["/Users/dev/.local/share"],
          bareRoot: "/Users/dev/.local/share/git/bare",
          repos: [
            {
              name: "ai-home",
              kind: "standard",
              commonDir: `${repoRoot}/.git`,
              mainWorktree: repoRoot,
              localOnlyBranches: ["main"],
              findings: [
                {
                  type: "standard_repo",
                  message: "Standard repo exists outside the bare authority model.",
                },
                {
                  type: "orphan_branch",
                  branch: "main",
                  message: "Local-only branch main has no attached worktree.",
                },
              ],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:bdelanghe/ai-home.git",
                githubRepo: "bdelanghe/ai-home",
              },
              upstreamRemote: null,
              remotes: [],
              worktrees: [
                {
                  path: "/Users/dev/.local/state/git/worktrees/io.github/bdelanghe/ai-home/repox-local",
                  branch: "repox-local",
                  current: true,
                  kind: "worktree",
                },
              ],
            },
          ],
        }),
        writeRepoInventoryIndex: () => {},
      },
    );

    expect(exitCode).toBe(1);
    expect(logs[0]!).toContain("Local-only branches");
    expect(logs[0]!).toContain("Configured bare root: /Users/dev/.local/share/git/bare");
    expect(logs[0]!).toContain("ai-home (standard)");
    expect(logs[0]!).toContain("remote: origin bdelanghe/ai-home");
    expect(logs[0]!).toContain("findings: standard_repo");
    expect(logs[0]!).toContain("orphan-branches: main");
    expect(logs[0]!).toContain("local-only: main");
  });

  test("repos rejects roots outside configured bare root unless --everywhere is set", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repos", "--root", "/Users/dev/.local/share/workspaces"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        loadRepoInventoryConfig: () => ({
          ...repoInventoryConfigFixture(),
          everywhereRoots: ["/Users/dev/.local/share/git/bare", "/Users/dev/.local/share/workspaces"],
        }),      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Root outside configured bare root");
    expect(errors[0]).toContain("Use --everywhere");
  });

  test("repos --everywhere permits roots outside configured bare root", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repos", "--everywhere", "--root", "/Users/dev/.local/share/workspaces"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        loadRepoInventoryConfig: () => ({
          ...repoInventoryConfigFixture(),
          everywhereRoots: ["/Users/dev/.local/share/git/bare", "/Users/dev/.local/share/workspaces"],
        }),
        discoverLocalRepos: (roots = []) => ({
          roots,
          bareRoot: "/Users/dev/.local/share/git/bare",
          repos: [],        }),
        writeRepoInventoryIndex: () => {},
      },
    );

    expect(exitCode).toBe(1);
    expect(logs[0]!).toContain("Configured bare root: /Users/dev/.local/share/git/bare");
  });

  test("repos normalize renders planned actions", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repos", "normalize", "--everywhere"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        loadRepoInventoryConfig: () => ({
          ...repoInventoryConfigFixture(),
          everywhereRoots: ["/Users/dev/.local/share/git/bare", "/Users/dev/.local/share/workspaces"],
        }),        discoverLocalRepos: () => ({
          roots: ["/Users/dev/.local/share/workspaces"],
          bareRoot: "/Users/dev/.local/share/git/bare",
          repos: [],
        }),
        writeRepoInventoryIndex: () => {},
        normalizeLocalRepos: () => ({
          apply: false,
          bareRoot: "/Users/dev/.local/share/git/bare",
          repos: [
            {
              name: "lone",
              kind: "standard",
              commonDir: "/Users/dev/.local/share/beads/io.github/bdelanghe/lone/.git",
              canonicalBarePath: "/Users/dev/.local/share/git/bare/io.github/bdelanghe/lone.git",
              actions: [
                {
                  type: "delete_orphan_branch",
                  repoName: "lone",
                  repoKind: "standard",
                  branch: "beads-sync",
                  message: "Delete orphan branch beads-sync.",
                },
                {
                  type: "detach_standard_git_dir",
                  repoName: "lone",
                  repoKind: "standard",
                  path: "/Users/dev/.local/share/beads/io.github/bdelanghe/lone/.git",
                  message: "Detach standard repo authority.",
                },
              ],
            },
          ],
          actions: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Repo normalization (dry-run)");
    expect(logs[0]!).toContain("lone (standard)");
    expect(logs[0]!).toContain("canonical-bare: /Users/dev/.local/share/git/bare/io.github/bdelanghe/lone.git");
    expect(logs[0]!).toContain("- delete_orphan_branch beads-sync");
    expect(logs[0]!).toContain("- detach_standard_git_dir /Users/dev/.local/share/beads/io.github/bdelanghe/lone/.git");
  });

  // GH-1727 / GH-2013: `prx repo list --everywhere` must round-trip all four
  // operator-set per-repo axes (canonical, bd_workspace_prefix,
  // stale_threshold_days, dolt_remote). Before the fix, the handler rebuilt
  // the index from `discoverLocalRepos` (disk-only view) and silently
  // dropped them — a `prx repo set canonical <slug> --to=bd` reverted on
  // the next list. GH-2013 added dolt_remote to the preserved set.
  test("repo list preserves per-repo axes through refresh (GH-1727)", () => {
    const writes: Array<{
      inventory: {
        repos: Array<{
          commonDir: string;
          bd_workspace_prefix?: string;
          canonical?: string;
          stale_threshold_days?: number;
          dolt_remote?: string;
        }>;
      };
    }> = [];
    const exitCode = runCliDirect(
      ["repo", "list", "--everywhere"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "demo-repo",
              commonDir: "/bare/io.github/demo/demo-repo.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
              bd_workspace_prefix: "supply-plan",
              canonical: "bd",
              stale_threshold_days: 14,
              dolt_remote: "https://doltremoteapi.dolthub.com/demo/widgets",
            },
            {
              name: "legacy",
              commonDir: "/bare/io.github/alice/legacy.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        // Disk-derived refresh: no axes — same shape `discoverLocalRepos`
        // would produce on its own.
        discoverLocalRepos: () => ({
          roots: [],
          repos: [
            {
              name: "demo-repo",
              commonDir: "/bare/io.github/demo/demo-repo.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
            {
              name: "legacy",
              commonDir: "/bare/io.github/alice/legacy.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        writeRepoInventoryIndex: (_, inv) => {
          writes.push({
            inventory: inv as {
              repos: Array<{
                commonDir: string;
                bd_workspace_prefix?: string;
                canonical?: string;
                stale_threshold_days?: number;
                dolt_remote?: string;
              }>;
            },
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    const byCommonDir = new Map(
      writes[0]!.inventory.repos.map((r) => [r.commonDir, r]),
    );
    const supplyPlan = byCommonDir.get("/bare/io.github/demo/demo-repo.git");
    expect(supplyPlan?.bd_workspace_prefix).toBe("supply-plan");
    expect(supplyPlan?.canonical).toBe("bd");
    expect(supplyPlan?.stale_threshold_days).toBe(14);
    expect(supplyPlan?.dolt_remote).toBe("https://doltremoteapi.dolthub.com/demo/widgets");
    // Untouched entries stay untouched.
    const legacy = byCommonDir.get("/bare/io.github/alice/legacy.git");
    expect(legacy?.bd_workspace_prefix).toBeUndefined();
    expect(legacy?.canonical).toBeUndefined();
    expect(legacy?.stale_threshold_days).toBeUndefined();
    expect(legacy?.dolt_remote).toBeUndefined();
  });

  // GH-1727: `prx repo normalize` shares the same handler as `repo list`
  // (parsed.action="normalize"). Its refresh path must preserve the same
  // three axes — otherwise running `normalize` before `list` would clobber.
  test("repo normalize preserves per-repo axes through refresh (GH-1727)", () => {
    const writes: Array<{
      inventory: {
        repos: Array<{
          commonDir: string;
          bd_workspace_prefix?: string;
          canonical?: string;
          stale_threshold_days?: number;
          dolt_remote?: string;
        }>;
      };
    }> = [];
    const exitCode = runCliDirect(
      ["repo", "normalize", "--everywhere"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "demo-repo",
              commonDir: "/bare/io.github/demo/demo-repo.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
              bd_workspace_prefix: "supply-plan",
              canonical: "bd",
              stale_threshold_days: 7,
              dolt_remote: "https://doltremoteapi.dolthub.com/demo/widgets",
            },
          ],
        }),
        discoverLocalRepos: () => ({
          roots: [],
          repos: [
            {
              name: "demo-repo",
              commonDir: "/bare/io.github/demo/demo-repo.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        writeRepoInventoryIndex: (_, inv) => {
          writes.push({
            inventory: inv as {
              repos: Array<{
                commonDir: string;
                bd_workspace_prefix?: string;
                canonical?: string;
                stale_threshold_days?: number;
                dolt_remote?: string;
              }>;
            },
          });
        },
        normalizeLocalRepos: () => ({
          apply: false,
          bareRoot: null,
          repos: [],
          actions: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    const entry = writes[0]!.inventory.repos.find(
      (r) => r.commonDir === "/bare/io.github/demo/demo-repo.git",
    );
    expect(entry?.bd_workspace_prefix).toBe("supply-plan");
    expect(entry?.canonical).toBe("bd");
    expect(entry?.stale_threshold_days).toBe(7);
    expect(entry?.dolt_remote).toBe("https://doltremoteapi.dolthub.com/demo/widgets");
  });

  // GH-1657: --bd-workspace-prefix wiring + uniqueness gate + lazy-migration
  // preservation through the post-add refresh.
  test("repo add threads --bd-workspace-prefix into addLocalRepo as bdWorkspacePrefixOverride", () => {
    const logs: string[] = [];
    const captured: { url?: string | undefined; bdWorkspacePrefixOverride?: string | undefined } = {};
    const exitCode = runCliDirect(
      ["repo", "add", "git@github.com:owner/scratch.git", "--bd-workspace-prefix", "supply-plan"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        addLocalRepo: (opts) => {
          captured.url = opts.url;
          captured.bdWorkspacePrefixOverride = opts.bdWorkspacePrefixOverride;
          return {
            url: opts.url,
            parsed: { host: "github.com", owner: "owner", name: "scratch", fetchUrl: opts.url },
            barePath: "/bare/io.github/owner/scratch.git",
            mainxPath: "/wt/scratch.git/mainx",
            defaultBranch: "main",
            fetchRefspecAdded: true,
            originHeadSet: true,
            overlay: null,
            bdWorkspacePrefix: opts.bdWorkspacePrefixOverride ?? "ai-home",
            canonical: opts.canonical ?? "gh",
            beadsHydrate: {
              status: "skipped-no-beads",
              doltRemote: null,
              doltDatabase: null,
              message: "beads: no .beads directory, skipping",
              exitCode: 0,
            },
          };
        },
        loadRepoInventoryIndex: () => null,
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(captured.bdWorkspacePrefixOverride).toBe("supply-plan");
    expect(logs[0]!).toContain("bd workspace prefix: supply-plan");
  });

  test("repo add rolls back and errors on bd_workspace_prefix collision (WP1)", () => {
    const errors: string[] = [];
    const rollbacks: Array<{ barePath: string; mainxPath: string }> = [];
    const writes: Array<{ inventory: unknown }> = [];
    const exitCode = runCliDirect(
      ["repo", "add", "git@github.com:bob/y.git", "--bd-workspace-prefix", "ai-home"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        addLocalRepo: (opts) => ({
          url: opts.url,
          parsed: { host: "github.com", owner: "bob", name: "y", fetchUrl: opts.url },
          barePath: "/bare/io.github/bob/y.git",
          mainxPath: "/wt/y.git/mainx",
          defaultBranch: "main",
          fetchRefspecAdded: true,
          originHeadSet: true,
          overlay: null,
          bdWorkspacePrefix: "ai-home",
          canonical: opts.canonical ?? "gh",
          beadsHydrate: {
            status: "skipped-no-beads",
            doltRemote: null,
            doltDatabase: null,
            message: "beads: no .beads directory, skipping",
            exitCode: 0,
          },
        }),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "x",
              commonDir: "/bare/io.github/alice/x.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:alice/x.git",
                githubRepo: "alice/x",
              },
              upstreamRemote: null,
              bd_workspace_prefix: "ai-home",
            },
          ],
        }),
        rollbackRepoAdd: (r) => { rollbacks.push(r); },
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: (_, inv) => { writes.push({ inventory: inv }); },
      },
    );

    expect(exitCode).toBe(1);
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]!.barePath).toBe("/bare/io.github/bob/y.git");
    expect(rollbacks[0]!.mainxPath).toBe("/wt/y.git/mainx");
    expect(writes).toHaveLength(0);
    const joined = errors.join("\n");
    expect(joined).toContain("alice/x");
    expect(joined).toContain("bob/y");
    expect(joined).toContain("--bd-workspace-prefix");
  });

  test("repo add preserves bd_workspace_prefix on existing entries through post-add refresh (WP3)", () => {
    const writes: Array<{ inventory: { repos: Array<{ commonDir: string; bd_workspace_prefix?: string }> } }> = [];
    const exitCode = runCliDirect(
      ["repo", "add", "git@github.com:bob/y.git", "--bd-workspace-prefix", "demo-web"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        addLocalRepo: (opts) => ({
          url: opts.url,
          parsed: { host: "github.com", owner: "bob", name: "y", fetchUrl: opts.url },
          barePath: "/bare/io.github/bob/y.git",
          mainxPath: "/wt/y.git/mainx",
          defaultBranch: "main",
          fetchRefspecAdded: true,
          originHeadSet: true,
          overlay: null,
          bdWorkspacePrefix: "demo-web",
          canonical: opts.canonical ?? "gh",
          beadsHydrate: {
            status: "skipped-no-beads",
            doltRemote: null,
            doltDatabase: null,
            message: "beads: no .beads directory, skipping",
            exitCode: 0,
          },
        }),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "x",
              commonDir: "/bare/io.github/alice/x.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
              bd_workspace_prefix: "ai-home",
            },
            {
              name: "legacy",
              commonDir: "/bare/io.github/alice/legacy.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        // Discovery returns the new repo + both old ones (typical post-add scan).
        discoverLocalRepos: () => ({
          roots: [],
          repos: [
            {
              name: "x",
              commonDir: "/bare/io.github/alice/x.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
            {
              name: "legacy",
              commonDir: "/bare/io.github/alice/legacy.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
            {
              name: "y",
              commonDir: "/bare/io.github/bob/y.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        writeRepoInventoryIndex: (_, inv) => {
          writes.push({ inventory: inv as { repos: Array<{ commonDir: string; bd_workspace_prefix?: string }> } });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    const byCommonDir = new Map(
      writes[0]!.inventory.repos.map((r) => [r.commonDir, r.bd_workspace_prefix]),
    );
    expect(byCommonDir.get("/bare/io.github/alice/x.git")).toBe("ai-home");
    expect(byCommonDir.get("/bare/io.github/alice/legacy.git")).toBeUndefined();
    expect(byCommonDir.get("/bare/io.github/bob/y.git")).toBe("demo-web");
  });

  // GH-1710: `prx repo add --canonical=bd` persists the axis on the index
  // entry and the CLI dispatches `repo set` through the new writers.
  test("repo add --canonical=bd threads canonical into addLocalRepo and onto the refreshed index", () => {
    const writes: Array<{ inventory: { repos: Array<{ commonDir: string; canonical?: string | undefined }> } }> = [];
    const captured: { canonical?: "gh" | "bd" | undefined } = {};
    const exitCode = runCliDirect(
      [
        "repo",
        "add",
        "git@github.com:demo/demo-repo.git",
        "--bd-workspace-prefix",
        "supply-plan",
        "--canonical",
        "bd",
      ],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        addLocalRepo: (opts) => {
          captured.canonical = opts.canonical;
          return {
            url: opts.url,
            parsed: {
              host: "github.com",
              owner: "demo",
              name: "demo-repo",
              fetchUrl: opts.url,
            },
            barePath: "/bare/io.github/demo/demo-repo.git",
            mainxPath: "/wt/demo-repo.git/mainx",
            defaultBranch: "main",
            fetchRefspecAdded: true,
            originHeadSet: true,
            overlay: null,
            bdWorkspacePrefix: opts.bdWorkspacePrefixOverride ?? "supply-plan",
            canonical: opts.canonical ?? "gh",
            beadsHydrate: {
              status: "skipped-no-beads",
              doltRemote: null,
              doltDatabase: null,
              message: "beads: no .beads directory, skipping",
              exitCode: 0,
            },
          };
        },
        loadRepoInventoryIndex: () => null,
        discoverLocalRepos: () => ({
          roots: [],
          repos: [
            {
              name: "demo-repo",
              commonDir: "/bare/io.github/demo/demo-repo.git",
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        writeRepoInventoryIndex: (_path, inv) => {
          writes.push({ inventory: inv });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(captured.canonical).toBe("bd");
    expect(writes).toHaveLength(1);
    const entry = writes[0]!.inventory.repos.find(
      (r) => r.commonDir === "/bare/io.github/demo/demo-repo.git",
    );
    expect(entry?.canonical).toBe("bd");
  });

  // GH-1710: `prx repo set canonical <slug> --to=<gh|bd>` round-trips through
  // setRepoCanonical.
  test("repo set canonical dispatches to setRepoCanonical with the resolved index path", () => {
    const calls: Array<{ indexPath: string; slug: string; value: "gh" | "bd" }> = [];
    const exitCode = runCliDirect(
      ["repo", "set", "canonical", "demo-repo", "--to=bd"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        setRepoCanonical: (indexPath, slug, value) => {
          calls.push({ indexPath, slug, value });
          return { previous: "gh" as const, current: value };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slug).toBe("demo-repo");
    expect(calls[0]!.value).toBe("bd");
    expect(calls[0]!.indexPath).toContain("index.json");
  });

  test("repo set stale-threshold-days requires an integer --to and dispatches", () => {
    const calls: Array<{ days: number }> = [];
    const exitCode = runCliDirect(
      ["repo", "set", "stale-threshold-days", "demo-repo", "--to=14"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        setRepoStaleThresholdDays: (_indexPath, _slug, days) => {
          calls.push({ days });
          return { previous: undefined, current: days };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls[0]!.days).toBe(14);
  });

  test("repo set rejects unknown axis", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "set", "nonsense", "demo-repo", "--to=bd"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
      },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("<axis>");
  });

  // GH-2013: extend `prx repo set` to the remaining two per-repo axes
  // (bd-workspace-prefix, dolt-remote) so all four overrides reachable via
  // `prx repo bootstrap` are also reachable via the retroactive verb.
  test("repo set bd-workspace-prefix dispatches to setRepoBdWorkspacePrefix with the resolved index path", () => {
    const calls: Array<{ indexPath: string; slug: string; prefix: string }> = [];
    const exitCode = runCliDirect(
      ["repo", "set", "bd-workspace-prefix", "demo-repo", "--to=supply-plan"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        setRepoBdWorkspacePrefix: (indexPath, slug, prefix) => {
          calls.push({ indexPath, slug, prefix });
          return { previous: undefined, current: prefix };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slug).toBe("demo-repo");
    expect(calls[0]!.prefix).toBe("supply-plan");
    expect(calls[0]!.indexPath).toContain("index.json");
  });

  test("repo set dolt-remote dispatches to setRepoDoltRemote with the resolved index path", () => {
    const calls: Array<{ indexPath: string; slug: string; url: string }> = [];
    const exitCode = runCliDirect(
      [
        "repo",
        "set",
        "dolt-remote",
        "demo-repo",
        "--to=https://doltremoteapi.dolthub.com/demo/widgets",
      ],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        setRepoDoltRemote: (indexPath, slug, url) => {
          calls.push({ indexPath, slug, url });
          return { previous: undefined, current: url };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slug).toBe("demo-repo");
    expect(calls[0]!.url).toBe("https://doltremoteapi.dolthub.com/demo/widgets");
    expect(calls[0]!.indexPath).toContain("index.json");
  });

  // GH-2013: invalid bd-workspace-prefix surfaces the WORKSPACE_PREFIX_PATTERN
  // message through CliError. Uses the real writer with a real index file.
  test("repo set rejects invalid bd-workspace-prefix value", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-set-prefix-"));
    const indexPath = join(root, "index.json");
    writeRepoInventoryIndex(indexPath, {
      roots: [],
      repos: [
        {
          name: "demo-repo",
          commonDir: "/bare/io.github/demo/demo-repo.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
        },
      ],
    } as RepoInventory);
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "set", "bd-workspace-prefix", "demo-repo", "--to=BadValue!"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        loadRepoInventoryConfig: () => ({
          ...repoInventoryConfigFixture(),
          indexPath,
        }),
      },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("[a-z][a-z0-9-]*");
  });

  test("repo set rejects invalid dolt-remote URL", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-set-dolt-"));
    const indexPath = join(root, "index.json");
    writeRepoInventoryIndex(indexPath, {
      roots: [],
      repos: [
        {
          name: "demo-repo",
          commonDir: "/bare/io.github/demo/demo-repo.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
        },
      ],
    } as RepoInventory);
    const errors: string[] = [];
    const exitCode = runCliDirect(
      [
        "repo",
        "set",
        "dolt-remote",
        "demo-repo",
        "--to=https://example.com/not/dolthub",
      ],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        loadRepoInventoryConfig: () => ({
          ...repoInventoryConfigFixture(),
          indexPath,
        }),
      },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain(
      "dolt_remote must be a Dolthub URL with a 3–32-char repo-name path segment matching ^[A-Za-z][A-Za-z0-9_-]*$",
    );
  });

  // GH-2013: no-op `repo set` must not rewrite the index file. Uses canonical
  // (the simplest axis); identical reasoning covers the other three. The
  // seed bypasses writeRepoInventoryIndex so the on-disk bytes use a
  // compact (no-indent) serialization the writer would not reproduce —
  // if the writer ran, the file would be reformatted to two-space indent.
  test("repo set is idempotent — no rewrite when value already matches", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-set-idem-"));
    const indexPath = join(root, "index.json");
    const seed: RepoInventory = {
      roots: [],
      repos: [
        {
          name: "demo-repo",
          commonDir: "/bare/io.github/demo/demo-repo.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
          canonical: "bd",
        },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(seed));
    const before = readFileSync(indexPath, "utf8");
    const exitCode = runCliDirect(
      ["repo", "set", "canonical", "demo-repo", "--to=bd"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => ({
          ...repoInventoryConfigFixture(),
          indexPath,
        }),
      },
    );
    expect(exitCode).toBe(0);
    const after = readFileSync(indexPath, "utf8");
    expect(after).toBe(before);
  });

  // GH-1682: `prx repo add --repair <git-url>` — idempotent re-add. When the
  // bare clone already exists on disk and the registered entry's URL matches,
  // delegate to `refreshLocalRepo` (the PR-C path) instead of throwing
  // `bare_path_exists`. Identity is on the parsed URL triple (ssh vs https
  // safe) and on `commonDir` for the index lookup (stale primaryRemote
  // cannot mask the registered entry).
  function repairBareRoot() {
    const root = mkdtempSync(join(tmpdir(), "prx-cli-repair-"));
    return {
      root,
      // The handler computes `<bareRoot>/io.<short>/<owner>/<name>.git` —
      // pre-create this for "exists on disk" cases.
      barePathFor(owner: string, name: string, host: "github" | "gitlab" = "github") {
        const path = join(root, `io.${host}`, owner, `${name}.git`);
        mkdirSync(path, { recursive: true });
        return path;
      },
      configFixture(): ReturnType<typeof repoInventoryConfigFixture> {
        return {
          ...repoInventoryConfigFixture(),
          bareRoot: root,
          roots: [root],
          everywhereRoots: [root],
        };
      },
    };
  }

  function repairInventoryEntry(over: {
    barePath: string;
    name: string;
    url: string;
    githubRepo?: string | null;
    bd_workspace_prefix?: string;
  }) {
    return {
      name: over.name,
      commonDir: over.barePath,
      kind: "bare" as const,
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [],
      primaryRemote: {
        name: "origin",
        url: over.url,
        githubRepo: over.githubRepo === undefined ? null : over.githubRepo,
      },
      upstreamRemote: null,
      ...(over.bd_workspace_prefix !== undefined
        ? { bd_workspace_prefix: over.bd_workspace_prefix }
        : {}),
    };
  }

  test("repo add --repair: barePath missing → falls through to addLocalRepo", () => {
    const env = repairBareRoot();
    let addCalled = false;
    let refreshCalled = false;
    const exitCode = runCliDirect(
      ["repo", "add", "--repair", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: (opts) => {
          addCalled = true;
          return {
            url: opts.url,
            parsed: { host: "github.com", owner: "owner", name: "scratch", fetchUrl: opts.url },
            barePath: join(env.root, "io.github/owner/scratch.git"),
            mainxPath: "/wt/scratch.git/mainx",
            defaultBranch: "main",
            fetchRefspecAdded: true,
            originHeadSet: true,
            overlay: null,
            bdWorkspacePrefix: "ai-home",
            canonical: opts.canonical ?? "gh",
            beadsHydrate: {
              status: "skipped-no-beads",
              doltRemote: null,
              doltDatabase: null,
              message: "beads: no .beads directory, skipping",
              exitCode: 0,
            },
          };
        },
        refreshLocalRepo: () => {
          refreshCalled = true;
          throw new Error("refreshLocalRepo should not be called on barePath-missing fall-through");
        },
        loadRepoInventoryIndex: () => null,
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );
    expect(exitCode).toBe(0);
    expect(addCalled).toBe(true);
    expect(refreshCalled).toBe(false);
  });

  test("repo add --repair: barePath exists + URL matches → delegates to refreshLocalRepo (exit 0, no addLocalRepo)", () => {
    const env = repairBareRoot();
    const barePath = env.barePathFor("owner", "scratch");
    let addCalled = false;
    let refreshOpts: { dryRun: boolean; noFetch: boolean; barePath: string } | undefined;
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "add", "--repair", "git@github.com:owner/scratch.git"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: () => {
          addCalled = true;
          throw new Error("addLocalRepo should not be called when repair-delegated");
        },
        refreshLocalRepo: (opts) => {
          refreshOpts = {
            dryRun: opts.dryRun,
            noFetch: opts.noFetch,
            barePath: opts.repo.commonDir,
          };
          return {
            slug: "scratch",
            barePath: opts.repo.commonDir,
            mainxPath: "/wt/scratch.git/mainx",
            mainxCreated: false,
            refspecBefore: [],
            refspecAfter: [],
            refspecUpgraded: false,
            fetched: !opts.noFetch,
            originHeadSet: !opts.noFetch && !opts.dryRun,
            beadsHydrate: {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "scratch_db",
              message: "beads: already-hydrated",
              exitCode: 0,
            },
            dryRun: opts.dryRun,
          };
        },
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            repairInventoryEntry({
              barePath,
              name: "scratch",
              url: "git@github.com:owner/scratch.git",
            }),
          ],
        }),
      },
    );
    expect(exitCode).toBe(0);
    expect(addCalled).toBe(false);
    expect(refreshOpts).toBeDefined();
    expect(refreshOpts!.dryRun).toBe(false);
    expect(refreshOpts!.noFetch).toBe(false);
    expect(refreshOpts!.barePath).toBe(barePath);
    expect(logs.join("\n")).toContain("scratch");
  });

  test("repo add --repair --dry-run: forwards dryRun=true to refreshLocalRepo", () => {
    const env = repairBareRoot();
    const barePath = env.barePathFor("owner", "scratch");
    let captured: { dryRun: boolean; noFetch: boolean } | undefined;
    const writes: Array<unknown> = [];
    const exitCode = runCliDirect(
      ["repo", "add", "--repair", "--dry-run", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        refreshLocalRepo: (opts) => {
          captured = { dryRun: opts.dryRun, noFetch: opts.noFetch };
          return {
            slug: "scratch",
            barePath: opts.repo.commonDir,
            mainxPath: "/wt/scratch.git/mainx",
            mainxCreated: false,
            refspecBefore: [],
            refspecAfter: [],
            refspecUpgraded: false,
            fetched: false,
            originHeadSet: false,
            beadsHydrate: {
              status: "dry-run",
              doltRemote: null,
              doltDatabase: "scratch_db",
              message: "beads: dry-run",
              exitCode: 0,
            },
            dryRun: true,
          };
        },
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            repairInventoryEntry({
              barePath,
              name: "scratch",
              url: "git@github.com:owner/scratch.git",
            }),
          ],
        }),
        writeRepoInventoryIndex: (_, inv) => { writes.push(inv); },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured?.dryRun).toBe(true);
    expect(captured?.noFetch).toBe(false);
    // Repair-delegated path does not re-write inventory (mirrors `prx repo
    // refresh --dry-run` no-writes invariant).
    expect(writes).toHaveLength(0);
  });

  test("repo add --repair --no-fetch: forwards noFetch=true to refreshLocalRepo", () => {
    const env = repairBareRoot();
    const barePath = env.barePathFor("owner", "scratch");
    let captured: { noFetch: boolean } | undefined;
    const exitCode = runCliDirect(
      ["repo", "add", "--repair", "--no-fetch", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        refreshLocalRepo: (opts) => {
          captured = { noFetch: opts.noFetch };
          return {
            slug: "scratch",
            barePath: opts.repo.commonDir,
            mainxPath: "/wt/scratch.git/mainx",
            mainxCreated: false,
            refspecBefore: [],
            refspecAfter: [],
            refspecUpgraded: false,
            fetched: false,
            originHeadSet: false,
            beadsHydrate: {
              status: "already-hydrated",
              doltRemote: null,
              doltDatabase: "scratch_db",
              message: "beads: already-hydrated",
              exitCode: 0,
            },
            dryRun: false,
          };
        },
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            repairInventoryEntry({
              barePath,
              name: "scratch",
              url: "git@github.com:owner/scratch.git",
            }),
          ],
        }),
      },
    );
    expect(exitCode).toBe(0);
    expect(captured?.noFetch).toBe(true);
  });

  test("repo add --repair: barePath exists + URL mismatch → CliError naming both URLs (no delegation)", () => {
    const env = repairBareRoot();
    const barePath = env.barePathFor("owner", "scratch");
    const errors: string[] = [];
    let addCalled = false;
    let refreshCalled = false;
    const exitCode = runCliDirect(
      ["repo", "add", "--repair", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: () => {
          addCalled = true;
          throw new Error("addLocalRepo should not run on URL mismatch");
        },
        refreshLocalRepo: () => {
          refreshCalled = true;
          throw new Error("refreshLocalRepo should not run on URL mismatch");
        },
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            repairInventoryEntry({
              barePath,
              name: "scratch",
              url: "git@github.com:different-owner/scratch.git",
            }),
          ],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(addCalled).toBe(false);
    expect(refreshCalled).toBe(false);
    const joined = errors.join("\n");
    expect(joined).toContain("URL mismatch");
    expect(joined).toContain("different-owner");
    expect(joined).toContain("owner/scratch");
  });

  test("repo add --repair: barePath exists + unregistered → throws bare_path_exists (no auto-adopt)", () => {
    const env = repairBareRoot();
    env.barePathFor("owner", "scratch");
    const errors: string[] = [];
    let addCalled = false;
    let refreshCalled = false;
    const exitCode = runCliDirect(
      ["repo", "add", "--repair", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: () => {
          addCalled = true;
          throw new Error("addLocalRepo should not run for unmanaged bare");
        },
        refreshLocalRepo: () => {
          refreshCalled = true;
          throw new Error("refreshLocalRepo should not run for unmanaged bare");
        },
        // Index has no entry whose commonDir matches the bare path.
        loadRepoInventoryIndex: () => ({ roots: [], repos: [] }),
      },
    );
    expect(exitCode).toBe(1);
    expect(addCalled).toBe(false);
    expect(refreshCalled).toBe(false);
    expect(errors.join("\n")).toContain("Bare path already exists");
  });

  test("repo add (no --repair, default): barePath exists in registry → still surfaces RepoAddError via addLocalRepo", () => {
    // Regression guard: without --repair we must not short-circuit on
    // barePath existence in the handler. Behaviour is unchanged from PR-B —
    // addLocalRepo runs and its `bare_path_exists` propagates as a CliError.
    const env = repairBareRoot();
    const barePath = env.barePathFor("owner", "scratch");
    let addCalled = false;
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "add", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: () => {
          addCalled = true;
          throw new RepoAddError(
            `Bare path already exists: ${barePath}. Refusing to clobber.`,
            "bare_path_exists",
          );
        },
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            repairInventoryEntry({
              barePath,
              name: "scratch",
              url: "git@github.com:owner/scratch.git",
            }),
          ],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(addCalled).toBe(true);
    expect(errors.join("\n")).toContain("Bare path already exists");
  });

  test("repo add: --dry-run without --repair → parser CliError (handler not invoked)", () => {
    const env = repairBareRoot();
    let addCalled = false;
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "add", "--dry-run", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: () => {
          addCalled = true;
          throw new Error("addLocalRepo should not run when parser rejects flag combination");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(addCalled).toBe(false);
    expect(errors.join("\n")).toContain("--repair");
  });

  test("repo add: --no-fetch without --repair → parser CliError", () => {
    const env = repairBareRoot();
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "add", "--no-fetch", "git@github.com:owner/scratch.git"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repair");
  });

  test("repo add: GH-1657 uniqueness loop self-skips on commonDir match (stale entry pointing at fresh bare)", () => {
    // Stale index entry whose commonDir equals the freshly-cloned bare and
    // whose bd_workspace_prefix collides with the new repo's. The
    // commonDir self-skip must fire before the prefix-match branch
    // evaluates, so the uniqueness check does not roll back the add.
    const env = repairBareRoot();
    const targetBarePath = join(env.root, "io.github/owner/scratch.git");
    const rollbacks: Array<unknown> = [];
    const writes: Array<unknown> = [];
    const exitCode = runCliDirect(
      ["repo", "add", "git@github.com:owner/scratch.git", "--bd-workspace-prefix", "scratch-prefix"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => env.configFixture(),
        addLocalRepo: (opts) => ({
          url: opts.url,
          parsed: { host: "github.com", owner: "owner", name: "scratch", fetchUrl: opts.url },
          barePath: targetBarePath,
          mainxPath: join(env.root, "wt/scratch.git/mainx"),
          defaultBranch: "main",
          fetchRefspecAdded: true,
          originHeadSet: true,
          overlay: null,
          bdWorkspacePrefix: "scratch-prefix",
          canonical: opts.canonical ?? "gh",
          beadsHydrate: {
            status: "skipped-no-beads",
            doltRemote: null,
            doltDatabase: null,
            message: "beads: no .beads directory, skipping",
            exitCode: 0,
          },
        }),
        // Only conflicting entry has matching commonDir AND matching
        // bd_workspace_prefix BUT a null primaryRemote.githubRepo, so the
        // existing URL-key self-skip cannot fire. The commonDir self-skip
        // must catch it.
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "scratch",
              commonDir: targetBarePath,
              kind: "bare" as const,
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
              bd_workspace_prefix: "scratch-prefix",
            },
          ],
        }),
        rollbackRepoAdd: (r) => { rollbacks.push(r); },
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: (_, inv) => { writes.push(inv); },
      },
    );
    expect(exitCode).toBe(0);
    expect(rollbacks).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  // GH-1681: `prx repo refresh <slug>` — operator recovery surface.
  // Resolves the slug through `findRepoBySlug`, dispatches into
  // `refreshLocalRepo`, propagates `beadsHydrate.exitCode`, and re-writes
  // the index merging bd_workspace_prefix / canonical / stale_threshold_days
  // from the prior inventory snapshot.
  function repoRefreshInventoryFixture(overrides: Partial<{
    bd_workspace_prefix: string;
    canonical: "gh" | "bd";
    stale_threshold_days: number;
  }> = {}) {
    return {
      roots: [],
      repos: [
        {
          name: "scratch",
          commonDir: "/bare/io.github/owner/scratch.git",
          kind: "bare" as const,
          mainWorktree: "/wt/scratch.git/mainx",
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:owner/scratch.git",
            githubRepo: "owner/scratch",
          },
          upstreamRemote: null,
          ...(overrides.bd_workspace_prefix !== undefined
            ? { bd_workspace_prefix: overrides.bd_workspace_prefix }
            : {}),
          ...(overrides.canonical !== undefined ? { canonical: overrides.canonical } : {}),
          ...(overrides.stale_threshold_days !== undefined
            ? { stale_threshold_days: overrides.stale_threshold_days }
            : {}),
        },
      ],
    };
  }

  function repoRefreshResultStub(
    over: Partial<{
      slug: string;
      barePath: string;
      mainxPath: string;
      mainxCreated: boolean;
      refspecUpgraded: boolean;
      fetched: boolean;
      originHeadSet: boolean;
      dryRun: boolean;
      hydrateStatus:
        | "hydrated"
        | "already-hydrated"
        | "skipped-no-beads"
        | "skipped-no-metadata"
        | "skipped-no-origin"
        | "skipped-unparseable-origin"
        | "skipped-non-primary-worktree"
        | "dry-run"
        | "clone-failed";
      hydrateExitCode: number;
    }> = {},
  ) {
    const status = over.hydrateStatus ?? "already-hydrated";
    return {
      slug: over.slug ?? "scratch",
      barePath: over.barePath ?? "/bare/io.github/owner/scratch.git",
      mainxPath: over.mainxPath ?? "/wt/scratch.git/mainx",
      mainxCreated: over.mainxCreated ?? false,
      refspecBefore: [
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
        "+refs/notes/*:refs/notes/*",
      ],
      refspecAfter: [
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
        "+refs/notes/*:refs/notes/*",
      ],
      refspecUpgraded: over.refspecUpgraded ?? false,
      fetched: over.fetched ?? true,
      originHeadSet: over.originHeadSet ?? ((over.fetched ?? true) && !(over.dryRun ?? false)),
      beadsHydrate: {
        status,
        doltRemote: null,
        doltDatabase: "scratch_db",
        message: `beads: ${status}`,
        exitCode: over.hydrateExitCode ?? 0,
      },
      dryRun: over.dryRun ?? false,
    };
  }

  test("repo refresh: not_registered → CliError naming the slug", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "refresh", "missing"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoRefreshInventoryFixture(),
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("missing");
  });

  test("repo refresh: ambiguous slug → CliError listing candidates", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "refresh", "scratch"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => ({
          roots: [],
          repos: [
            {
              name: "scratch",
              commonDir: "/bare/io.github/alice/scratch.git",
              kind: "bare" as const,
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:alice/scratch.git",
                githubRepo: "alice/scratch",
              },
              upstreamRemote: null,
            },
            {
              name: "scratch",
              commonDir: "/bare/io.github/bob/scratch.git",
              kind: "bare" as const,
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:bob/scratch.git",
                githubRepo: "bob/scratch",
              },
              upstreamRemote: null,
            },
          ],
        }),
      },
    );
    expect(exitCode).toBe(1);
    const joined = errors.join("\n");
    expect(joined).toContain("ambiguous");
    expect(joined).toContain("alice/scratch");
    expect(joined).toContain("bob/scratch");
  });

  test("repo refresh: hydrate clone-failed → exit code 1", () => {
    const exitCode = runCliDirect(
      ["repo", "refresh", "scratch"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoRefreshInventoryFixture(),
        refreshLocalRepo: () =>
          repoRefreshResultStub({ hydrateStatus: "clone-failed", hydrateExitCode: 1 }),
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );
    expect(exitCode).toBe(1);
  });

  test("repo refresh: already-hydrated → exit 0", () => {
    const exitCode = runCliDirect(
      ["repo", "refresh", "scratch"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoRefreshInventoryFixture(),
        refreshLocalRepo: () => repoRefreshResultStub({ hydrateStatus: "already-hydrated" }),
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );
    expect(exitCode).toBe(0);
  });

  test("repo refresh --dry-run: exit 0, no inventory write, dryRun threaded into refreshLocalRepo", () => {
    const writes: Array<{ inventory: unknown }> = [];
    let captured: { dryRun: boolean; noFetch: boolean } | undefined;
    const exitCode = runCliDirect(
      ["repo", "refresh", "scratch", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoRefreshInventoryFixture(),
        refreshLocalRepo: (opts) => {
          captured = { dryRun: opts.dryRun, noFetch: opts.noFetch };
          return repoRefreshResultStub({
            dryRun: true,
            fetched: false,
            hydrateStatus: "dry-run",
          });
        },
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: (_, inv) => { writes.push({ inventory: inv }); },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured?.dryRun).toBe(true);
    expect(captured?.noFetch).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("repo refresh: writes inventory once, preserving bd_workspace_prefix / canonical / stale_threshold_days through round-trip", () => {
    const writes: Array<{
      inventory: { repos: Array<{ commonDir: string; bd_workspace_prefix?: string; canonical?: string; stale_threshold_days?: number }> };
    }> = [];
    const exitCode = runCliDirect(
      ["repo", "refresh", "scratch"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoRefreshInventoryFixture({
          bd_workspace_prefix: "ai-home",
          canonical: "bd",
          stale_threshold_days: 14,
        }),
        refreshLocalRepo: () => repoRefreshResultStub(),
        // Discovery drops the prefix/canonical/stale fields (those don't live
        // on disk for discoverLocalRepos to read); the post-refresh merge
        // must restore them from the prior inventory snapshot.
        discoverLocalRepos: () => ({
          roots: [],
          repos: [
            {
              name: "scratch",
              commonDir: "/bare/io.github/owner/scratch.git",
              kind: "bare",
              mainWorktree: "/wt/scratch.git/mainx",
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        writeRepoInventoryIndex: (_, inv) => {
          writes.push({
            inventory: inv as {
              repos: Array<{
                commonDir: string;
                bd_workspace_prefix?: string;
                canonical?: string;
                stale_threshold_days?: number;
              }>;
            },
          });
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    const entry = writes[0]!.inventory.repos.find(
      (r) => r.commonDir === "/bare/io.github/owner/scratch.git",
    );
    expect(entry).toBeDefined();
    expect(entry!.bd_workspace_prefix).toBe("ai-home");
    expect(entry!.canonical).toBe("bd");
    expect(entry!.stale_threshold_days).toBe(14);
  });

  test("repo refresh --no-fetch: noFetch threaded into refreshLocalRepo", () => {
    let captured: { noFetch: boolean } | undefined;
    const exitCode = runCliDirect(
      ["repo", "refresh", "scratch", "--no-fetch"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoRefreshInventoryFixture(),
        refreshLocalRepo: (opts) => {
          captured = { noFetch: opts.noFetch };
          return repoRefreshResultStub({ fetched: false });
        },
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );
    expect(exitCode).toBe(0);
    expect(captured?.noFetch).toBe(true);
  });

  // GH-1660: `prx repo materialize <name>` parses and dispatches through the
  // `materializeBareRepo` DI shim, then emits one `BARE_MATERIALIZED` row to
  // the daily NDJSON sink (redirected via XDG_STATE_HOME).
  test("repo materialize dispatches to materializeBareRepo and emits BARE_MATERIALIZED", () => {
    const logs: string[] = [];
    type MatCall = { name: string; dryRun?: boolean | undefined; ttlSeconds?: number | undefined };
    const calls: MatCall[] = [];

    const stateDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "prx-cli-mat-"),
    );
    const previousStateDir = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    let exitCode: number | Promise<number>;
    try {
      exitCode = runCliDirect(
        ["repo", "materialize", "demo", "--dry-run", "--ttl-seconds", "30", "--format", "json"],
        { log: (line) => logs.push(line), error: () => {} },
        {
          materializeBareRepo: (opts) => {
            calls.push({
              name: opts.name,
              dryRun: opts.dryRun,
              ttlSeconds: opts.ttlSeconds,
            });
            return {
              repo: opts.name,
              barePath: "/bare/io.github/octo/demo.git",
              action: "noop" as const,
              lastFetchedAtMs: 1700000000000,
              dryRun: opts.dryRun === true,
            };
          },
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateDir;
      }
    }

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { name: "demo", dryRun: true, ttlSeconds: 30 },
    ]);
    const payload = JSON.parse(logs[0]!) as { action: string; dryRun: boolean };
    expect(payload.action).toBe("noop");
    expect(payload.dryRun).toBe(true);

    // Verify the BARE_MATERIALIZED row landed in the audit NDJSON.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(stateDir, "prx", "audit", `${day}.ndjson`);
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const matRows = lines
      .map((l: string) => JSON.parse(l))
      .filter((r: { event?: string }) => r.event === "BARE_MATERIALIZED");
    expect(matRows).toHaveLength(1);
    expect(matRows[0]).toMatchObject({
      kind: "catalog-event",
      event: "BARE_MATERIALIZED",
      actor: "wt",
      repo: "demo",
      details: {
        barePath: "/bare/io.github/octo/demo.git",
        action: "noop",
        dryRun: true,
      },
    });
  });

  test("repo materialize rejects non-positive --ttl-seconds", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "materialize", "demo", "--ttl-seconds", "0"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        materializeBareRepo: () => {
          throw new Error("should not be invoked");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--ttl-seconds");
  });

  test("repo materialize requires a <name> positional", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repo", "materialize"],
      { log: () => {}, error: (line) => errors.push(line) },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("repo materialize requires");
  });

  // GH-1752: `prx repo materialize` extends past the bare leg — after the
  // clone/fetch, it composes `refreshLocalRepo` (mainx + refspec + beads
  // hydrate) and rescans the inventory so `mainWorktree` flips from
  // `null` to the resolved path. WORKTREE_CREATED is emitted only when
  // the mainx was freshly created on this run, and the exit code mirrors
  // `beadsHydrate.exitCode` so a `clone-failed` fails loud (matches
  // `repo refresh` and `repo add --repair`).
  function repoMaterializeInventoryFixture(overrides: Partial<{
    mainWorktree: string | null;
    bd_workspace_prefix: string;
    canonical: "gh" | "bd";
  }> = {}) {
    return {
      roots: [],
      repos: [
        {
          name: "demo",
          commonDir: "/bare/io.github/octo/demo.git",
          kind: "bare" as const,
          mainWorktree: overrides.mainWorktree !== undefined
            ? overrides.mainWorktree
            : null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:octo/demo.git",
            githubRepo: "octo/demo",
          },
          upstreamRemote: null,
          ...(overrides.bd_workspace_prefix !== undefined
            ? { bd_workspace_prefix: overrides.bd_workspace_prefix }
            : {}),
          ...(overrides.canonical !== undefined
            ? { canonical: overrides.canonical }
            : {}),
        },
      ],
    };
  }

  function materializeRefreshResultStub(
    over: Partial<{
      mainxCreated: boolean;
      refspecUpgraded: boolean;
      hydrateStatus:
        | "hydrated"
        | "already-hydrated"
        | "skipped-no-beads"
        | "dry-run"
        | "clone-failed";
      hydrateExitCode: number;
      dryRun: boolean;
    }> = {},
  ) {
    const status = over.hydrateStatus ?? "already-hydrated";
    return {
      slug: "demo",
      barePath: "/bare/io.github/octo/demo.git",
      mainxPath: "/wt/demo.git/mainx",
      mainxCreated: over.mainxCreated ?? false,
      refspecBefore: [
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
        "+refs/notes/*:refs/notes/*",
      ],
      refspecAfter: [
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
        "+refs/notes/*:refs/notes/*",
      ],
      refspecUpgraded: over.refspecUpgraded ?? false,
      fetched: false,
      originHeadSet: false,
      beadsHydrate: {
        status,
        doltRemote: null,
        doltDatabase: "demo_db",
        message: `beads: ${status}`,
        exitCode: over.hydrateExitCode ?? 0,
      },
      dryRun: over.dryRun ?? false,
    };
  }

  test("repo materialize: cloned arm composes refreshLocalRepo (mainx created, beads hydrated, inventory rescanned)", () => {
    const stateDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "prx-cli-mat-"),
    );
    const previousStateDir = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    type RefreshCall = { repoName: string; dryRun: boolean; noFetch: boolean };
    const refreshCalls: RefreshCall[] = [];
    const writes: Array<{ inventory: { repos: Array<{ name: string; mainWorktree: string | null }> } }> = [];

    let exitCode: number | Promise<number>;
    try {
      exitCode = runCliDirect(
        ["repo", "materialize", "demo", "--format", "json"],
        { log: () => {}, error: () => {} },
        {
          loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
          loadRepoInventoryIndex: () => repoMaterializeInventoryFixture(),
          materializeBareRepo: (opts) => ({
            repo: opts.name,
            barePath: "/bare/io.github/octo/demo.git",
            action: "cloned" as const,
            lastFetchedAtMs: 1700000000000,
            dryRun: opts.dryRun === true,
          }),
          refreshLocalRepo: (opts) => {
            refreshCalls.push({
              repoName: opts.repo.name,
              dryRun: opts.dryRun,
              noFetch: opts.noFetch,
            });
            return materializeRefreshResultStub({
              mainxCreated: true,
              hydrateStatus: "hydrated",
            });
          },
          discoverLocalRepos: () => ({
            roots: [],
            repos: [
              {
                name: "demo",
                commonDir: "/bare/io.github/octo/demo.git",
                kind: "bare",
                mainWorktree: "/wt/demo.git/mainx",
                worktrees: [],
                localOnlyBranches: [],
                findings: [],
                remotes: [],
                primaryRemote: null,
                upstreamRemote: null,
              },
            ],
          }),
          writeRepoInventoryIndex: (_, inv) => {
            writes.push({
              inventory: inv as { repos: Array<{ name: string; mainWorktree: string | null }> },
            });
          },
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateDir;
      }
    }

    expect(exitCode).toBe(0);
    expect(refreshCalls).toEqual([
      { repoName: "demo", dryRun: false, noFetch: true },
    ]);
    expect(writes).toHaveLength(1);
    const entry = writes[0]!.inventory.repos.find((r) => r.name === "demo");
    expect(entry).toBeDefined();
    expect(entry!.mainWorktree).toBe("/wt/demo.git/mainx");

    // Both BARE_MATERIALIZED (bare leg) and WORKTREE_CREATED
    // (mainx was created this run) should land in the audit NDJSON.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(stateDir, "prx", "audit", `${day}.ndjson`);
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const events = lines.map((l: string) => JSON.parse(l));
    const eventNames = events.map((r: { event?: string }) => r.event);
    expect(eventNames).toContain("BARE_MATERIALIZED");
    expect(eventNames).toContain("WORKTREE_CREATED");
  });

  test("repo materialize: noop arm with existing mainx — no WORKTREE_CREATED, refresh still runs idempotently", () => {
    const stateDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "prx-cli-mat-"),
    );
    const previousStateDir = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    let exitCode: number | Promise<number>;
    try {
      exitCode = runCliDirect(
        ["repo", "materialize", "demo", "--format", "json"],
        { log: () => {}, error: () => {} },
        {
          loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
          loadRepoInventoryIndex: () =>
            repoMaterializeInventoryFixture({ mainWorktree: "/wt/demo.git/mainx" }),
          materializeBareRepo: (opts) => ({
            repo: opts.name,
            barePath: "/bare/io.github/octo/demo.git",
            action: "noop" as const,
            lastFetchedAtMs: 1700000000000,
            dryRun: opts.dryRun === true,
          }),
          refreshLocalRepo: () =>
            materializeRefreshResultStub({
              mainxCreated: false,
              hydrateStatus: "already-hydrated",
            }),
          discoverLocalRepos: () => ({ roots: [], repos: [] }),
          writeRepoInventoryIndex: () => {},
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateDir;
      }
    }

    expect(exitCode).toBe(0);
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(stateDir, "prx", "audit", `${day}.ndjson`);
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const events = lines.map((l: string) => JSON.parse(l)) as Array<{ event?: string }>;
    expect(events.some((e) => e.event === "BARE_MATERIALIZED")).toBe(true);
    expect(events.some((e) => e.event === "WORKTREE_CREATED")).toBe(false);
  });

  test("repo materialize: noop arm with missing mainx — refresh self-heals, WORKTREE_CREATED emitted", () => {
    // Even when the bare-freshness short-circuit fires, refresh still
    // runs through `materializeMainxIfMissing` and hydrates beads. This
    // is the idempotent self-heal that lets a half-materialized repo
    // recover without operator intervention.
    const stateDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "prx-cli-mat-"),
    );
    const previousStateDir = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    let exitCode: number | Promise<number>;
    try {
      exitCode = runCliDirect(
        ["repo", "materialize", "demo", "--format", "json"],
        { log: () => {}, error: () => {} },
        {
          loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
          loadRepoInventoryIndex: () => repoMaterializeInventoryFixture(),
          materializeBareRepo: (opts) => ({
            repo: opts.name,
            barePath: "/bare/io.github/octo/demo.git",
            action: "noop" as const,
            lastFetchedAtMs: 1700000000000,
            dryRun: opts.dryRun === true,
          }),
          refreshLocalRepo: () =>
            materializeRefreshResultStub({
              mainxCreated: true,
              hydrateStatus: "hydrated",
            }),
          discoverLocalRepos: () => ({ roots: [], repos: [] }),
          writeRepoInventoryIndex: () => {},
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateDir;
      }
    }

    expect(exitCode).toBe(0);
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(stateDir, "prx", "audit", `${day}.ndjson`);
    const events = fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l)) as Array<{ event?: string }>;
    expect(events.some((e) => e.event === "WORKTREE_CREATED")).toBe(true);
  });

  test("repo materialize: fetched arm threads noFetch:true into refreshLocalRepo (no double fetch)", () => {
    // The bare leg already ran `git fetch --all --prune`; the refresh
    // leg must skip its own `git fetch --prune origin` call.
    let captured: { noFetch: boolean } | undefined;
    const exitCode = runCliDirect(
      ["repo", "materialize", "demo", "--format", "json"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoMaterializeInventoryFixture(),
        materializeBareRepo: (opts) => ({
          repo: opts.name,
          barePath: "/bare/io.github/octo/demo.git",
          action: "fetched" as const,
          lastFetchedAtMs: 1700000000000,
          dryRun: opts.dryRun === true,
        }),
        refreshLocalRepo: (opts) => {
          captured = { noFetch: opts.noFetch };
          return materializeRefreshResultStub({
            mainxCreated: false,
            hydrateStatus: "already-hydrated",
          });
        },
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(captured?.noFetch).toBe(true);
  });

  test("repo materialize --dry-run: dryRun threaded into refreshLocalRepo, no inventory write, no WORKTREE_CREATED", () => {
    const stateDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "prx-cli-mat-"),
    );
    const previousStateDir = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    let refreshOpts: { dryRun: boolean; noFetch: boolean } | undefined;
    const writes: unknown[] = [];
    let exitCode: number | Promise<number>;
    try {
      exitCode = runCliDirect(
        ["repo", "materialize", "demo", "--dry-run", "--format", "json"],
        { log: () => {}, error: () => {} },
        {
          loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
          loadRepoInventoryIndex: () => repoMaterializeInventoryFixture(),
          materializeBareRepo: (opts) => ({
            repo: opts.name,
            barePath: "/bare/io.github/octo/demo.git",
            action: "cloned" as const,
            lastFetchedAtMs: null,
            dryRun: opts.dryRun === true,
          }),
          refreshLocalRepo: (opts) => {
            refreshOpts = { dryRun: opts.dryRun, noFetch: opts.noFetch };
            return materializeRefreshResultStub({
              dryRun: true,
              mainxCreated: true,
              hydrateStatus: "dry-run",
            });
          },
          discoverLocalRepos: () => ({ roots: [], repos: [] }),
          writeRepoInventoryIndex: (_, inv) => { writes.push(inv); },
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateDir;
      }
    }

    expect(exitCode).toBe(0);
    expect(refreshOpts?.dryRun).toBe(true);
    expect(refreshOpts?.noFetch).toBe(true);
    expect(writes).toHaveLength(0);
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(stateDir, "prx", "audit", `${day}.ndjson`);
    const events = fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l)) as Array<{ event?: string }>;
    // BARE_MATERIALIZED still records the dry-run row for audit. But
    // WORKTREE_CREATED is suppressed since nothing actually changed.
    expect(events.some((e) => e.event === "BARE_MATERIALIZED")).toBe(true);
    expect(events.some((e) => e.event === "WORKTREE_CREATED")).toBe(false);
  });

  test("repo materialize: beads clone-failed → exit code 1", () => {
    // Matches the `prx repo refresh` and `prx repo add --repair`
    // convention so an operator hitting `clone-failed` gets a uniform
    // non-zero across the three sibling verbs.
    const exitCode = runCliDirect(
      ["repo", "materialize", "demo", "--format", "json"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () => repoMaterializeInventoryFixture(),
        materializeBareRepo: (opts) => ({
          repo: opts.name,
          barePath: "/bare/io.github/octo/demo.git",
          action: "cloned" as const,
          lastFetchedAtMs: 1700000000000,
          dryRun: opts.dryRun === true,
        }),
        refreshLocalRepo: () =>
          materializeRefreshResultStub({
            mainxCreated: true,
            hydrateStatus: "clone-failed",
            hydrateExitCode: 1,
          }),
        discoverLocalRepos: () => ({ roots: [], repos: [] }),
        writeRepoInventoryIndex: () => {},
      },
    );

    expect(exitCode).toBe(1);
  });

  test("repo materialize: refresh throws RepoAddError (default_branch_unresolved) → BARE_MATERIALIZED emitted, then CliError propagated", () => {
    const stateDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "prx-cli-mat-"),
    );
    const previousStateDir = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    const errors: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      exitCode = runCliDirect(
        ["repo", "materialize", "demo", "--format", "json"],
        { log: () => {}, error: (line) => errors.push(line) },
        {
          loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
          loadRepoInventoryIndex: () => repoMaterializeInventoryFixture(),
          materializeBareRepo: (opts) => ({
            repo: opts.name,
            barePath: "/bare/io.github/octo/demo.git",
            action: "cloned" as const,
            lastFetchedAtMs: 1700000000000,
            dryRun: opts.dryRun === true,
          }),
          refreshLocalRepo: () => {
            throw new RepoAddError(
              "Could not resolve origin/HEAD for repo 'demo'.",
              "default_branch_unresolved",
            );
          },
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateDir;
      }
    }

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Could not resolve origin/HEAD");

    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const day = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(stateDir, "prx", "audit", `${day}.ndjson`);
    const events = fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l)) as Array<{ event?: string }>;
    // The bare leg succeeded before the refresh failure — the audit
    // row reflects what actually happened on the bare leg.
    expect(events.some((e) => e.event === "BARE_MATERIALIZED")).toBe(true);
  });

  test("repo materialize: preserves bd_workspace_prefix / canonical through inventory rescan", () => {
    const writes: Array<{
      inventory: { repos: Array<{ commonDir: string; bd_workspace_prefix?: string; canonical?: string }> };
    }> = [];

    const exitCode = runCliDirect(
      ["repo", "materialize", "demo", "--format", "json"],
      { log: () => {}, error: () => {} },
      {
        loadRepoInventoryConfig: () => repoInventoryConfigFixture(),
        loadRepoInventoryIndex: () =>
          repoMaterializeInventoryFixture({
            bd_workspace_prefix: "ai-home",
            canonical: "bd",
          }),
        materializeBareRepo: (opts) => ({
          repo: opts.name,
          barePath: "/bare/io.github/octo/demo.git",
          action: "fetched" as const,
          lastFetchedAtMs: 1700000000000,
          dryRun: opts.dryRun === true,
        }),
        refreshLocalRepo: () =>
          materializeRefreshResultStub({
            mainxCreated: true,
            hydrateStatus: "hydrated",
          }),
        // Disk discovery drops the operator-set axes; the
        // post-write `preservePerRepoAxes` merge must put them back.
        discoverLocalRepos: () => ({
          roots: [],
          repos: [
            {
              name: "demo",
              commonDir: "/bare/io.github/octo/demo.git",
              kind: "bare",
              mainWorktree: "/wt/demo.git/mainx",
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [],
              primaryRemote: null,
              upstreamRemote: null,
            },
          ],
        }),
        writeRepoInventoryIndex: (_, inv) => {
          writes.push({
            inventory: inv as {
              repos: Array<{ commonDir: string; bd_workspace_prefix?: string; canonical?: string }>;
            },
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    const entry = writes[0]!.inventory.repos.find(
      (r) => r.commonDir === "/bare/io.github/octo/demo.git",
    );
    expect(entry).toBeDefined();
    expect(entry!.bd_workspace_prefix).toBe("ai-home");
    expect(entry!.canonical).toBe("bd");
  });

  test("overview requests diff stats by default", () => {
    const calls: boolean[] = [];
    const exitCode = runCliDirect(
      ["overview"],
      {
        log: () => {},
        error: () => {},
      },
      {
        overviewStatus: (_repoPath, includeDiffStats) => {
          calls.push(includeDiffStats ?? true);
          return {
            repo: "owner/repo",
            currentBranch: null,
            createdByYou: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([true]);
  });

  test("worktree supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["worktree"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        worktreeStatus: () => ({
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
          counts: {
            staged: 0,
            unstaged: 1,
            untracked: 0,
            ignored: 0,
            conflicts: 0,
          },
          clean: false,
          codes: {
            " ": "unmodified",
            M: "modified",
            A: "added",
            D: "deleted",
            R: "renamed",
            C: "copied",
            U: "unmerged",
            "?": "untracked",
            "!": "ignored",
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("branch=GH-5480 sync=up_to_date");
    expect(logs[0]!).toContain("worktree=dirty staged=0 unstaged=1 untracked=0 conflicts=0");
  });

  test("worktree supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["worktree", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        worktreeStatus: () => ({
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
          counts: {
            staged: 1,
            unstaged: 0,
            untracked: 0,
            ignored: 0,
            conflicts: 0,
          },
          clean: false,
          codes: {
            " ": "unmodified",
            M: "modified",
            A: "added",
            D: "deleted",
            R: "renamed",
            C: "copied",
            U: "unmerged",
            "?": "untracked",
            "!": "ignored",
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      branch: {
        name: "main",
        sync: "ahead",
      },
      counts: {
        staged: 1,
      },
      clean: false,
    });
  });

  test("worktrees supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["worktrees"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        wtStatus: () => ({
          source: "wt+git",
          wt_available: true,
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
          worktrees: [
            {
              branch: "GH-5480",
              path: "/repo/wt",
              integration: "ahead",
              clean: false,
              dirty_flags: ["modified"],
              sync: { ahead: 1, behind: 0, state: "ahead" },
              structural: { detached: false, mismatch: true, states: ["branch_worktree_mismatch"] },
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
                files: { staged: [], unstaged: ["x.rb"], untracked: [], ignored: [], conflicts: [] },
                counts: { staged: 0, unstaged: 1, untracked: 0, ignored: 0, conflicts: 0 },
                clean: false,
                codes: {
                  " ": "unmodified",
                  M: "modified",
                  A: "added",
                  D: "deleted",
                  R: "renamed",
                  C: "copied",
                  U: "unmerged",
                  "?": "untracked",
                  "!": "ignored",
                },
              },
              commit: { sha: "abc", message: "msg" },
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Worktrunk status");
    expect(logs[0]!).toContain("GH-5480 (ahead)");
    expect(logs[0]!).toContain("symbols: ! ↑ ⚑ (modified, ahead, branch_worktree_mismatch)");
  });

  test("worktrees supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["worktrees", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        wtStatus: () => ({
          source: "wt+git",
          wt_available: true,
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
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      source: "wt+git",
      wt_available: true,
      worktrees: [],
    });
  });

  test("worktree-remove supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["worktree-remove", "feature-123", "--format", "json", "--force", "--delete-branch"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        removeWorktree: (_repoPath, target, options) => ({
          repoPath: ".",
          target,
          path: "feature-123",
          resolvedPath: "/repo/feature-123",
          branch: "feature-123",
          force: options?.force ?? false,
          prune: options?.prune ?? true,
          deleteBranch: options?.deleteBranch ?? false,
          dryRun: options?.dryRun ?? false,
          removed: true,
          branchDeleted: true,
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({
      repoPath: ".",
      target: "feature-123",
      path: "feature-123",
      resolvedPath: "/repo/feature-123",
      branch: "feature-123",
      force: true,
      prune: true,
      deleteBranch: true,
      dryRun: false,
      removed: true,
      branchDeleted: true,
    });
  });

  test("removeWorktree removes the worktree directory and prunes metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-remove-repo-"));
    const worktreePath = join(repo, "feature-123");
    mkdirSync(worktreePath);
    const calls: string[] = [];

    const result = removeWorktree(
      repo,
      "feature-123",
      { force: true, deleteBranch: true },
      (cmd) => {
        const rendered = cmd.join(" ");
        calls.push(rendered);
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\nbranch refs/heads/feature-123\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force ${worktreePath}`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        if (rendered === `git -C ${repo} worktree prune`) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (rendered === `git -C ${repo} branch -D feature-123`) {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(result.path).toBe("feature-123");
    expect(result.resolvedPath).toBe(worktreePath);
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(calls).toEqual([
      `git -C ${repo} worktree list --porcelain`,
      `git -C ${repo} worktree remove --force ${worktreePath}`,
      `git -C ${repo} worktree prune`,
      `git -C ${repo} branch -D feature-123`,
    ]);
  });

  test("removeWorktree resolves relative paths against repoPath", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-relative-repo-"));
    const worktreePath = join(repo, "nested", "feature-123");
    mkdirSync(join(repo, "nested"), { recursive: true });
    mkdirSync(worktreePath);

    const result = removeWorktree(
      repo,
      "nested/feature-123",
      { force: true, prune: false },
      (cmd) => {
        const rendered = cmd.join(" ");
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree nested/feature-123\nbranch refs/heads/feature-123\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force nested/feature-123`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(result.path).toBe("nested/feature-123");
    expect(result.resolvedPath).toBe(worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("removeWorktree resolves GH-<n> tokens to gh_<n>_<slug> worktrees (GH-756)", () => {
    // Regression: the orphan-cleanup thread of `prx next` / `prx delegate
    // next` emits `prx worktree-remove GH-674 --delete-branch` as its
    // suggested command, but worktrees are laid out as `gh_674_<slug>`
    // with detached HEAD (branch=null), so the direct branch/path lookups
    // miss.
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-ticket-"));
    const worktreePath = join(repo, "gh_674_h5e");
    mkdirSync(worktreePath);

    const result = removeWorktree(
      repo,
      "GH-674",
      { force: true, prune: false },
      (cmd) => {
        const rendered = cmd.join(" ");
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          // Detached HEAD — no `branch refs/heads/…` line.
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\ndetached\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force ${worktreePath}`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(result.resolvedPath).toBe(worktreePath);
    expect(result.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("removeWorktree GH-<n> lookup is case-insensitive and accepts lowercase gh-<n> (GH-756)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-ticket-case-"));
    const worktreePath = join(repo, "gh_674_h5e");
    mkdirSync(worktreePath);

    const result = removeWorktree(
      repo,
      "gh-674",
      { force: true, prune: false },
      (cmd) => {
        const rendered = cmd.join(" ");
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\ndetached\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force ${worktreePath}`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(result.resolvedPath).toBe(worktreePath);
    expect(result.removed).toBe(true);
  });

  test("removeWorktree refuses to delete protected branches by default", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-protected-repo-"));

    expect(() =>
      removeWorktree(
        repo,
        "main",
        { deleteBranch: true, prune: false },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout: "worktree /repo/main\nbranch refs/heads/main\n\n",
              stderr: "",
            };
          }
          if (rendered === `git -C /repo/main status --porcelain=v1`) {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (rendered === `git -C ${repo} worktree remove /repo/main`) {
            return { status: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(/Refusing to delete protected branch 'main'/);
  });

  test("removeWorktree refuses a dirty worktree when --force is not set (GH-757)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-dirty-"));
    const worktreePath = join(repo, "gh_674_h5e");
    mkdirSync(worktreePath);

    expect(() =>
      removeWorktree(
        repo,
        "gh_674_h5e",
        { deleteBranch: true, prune: false },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout: `worktree ${worktreePath}\nbranch refs/heads/GH-674\n\n`,
              stderr: "",
            };
          }
          if (rendered === `git -C ${worktreePath} status --porcelain=v1`) {
            return {
              status: 0,
              stdout: "UU src/foo.ts\n M test/bar.ts\n",
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(/has uncommitted changes/);
  });

  test("removeWorktree proceeds on dirty worktree when --force is set (GH-757)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-dirty-force-"));
    const worktreePath = join(repo, "gh_674_h5e");
    mkdirSync(worktreePath);

    const result = removeWorktree(
      repo,
      "gh_674_h5e",
      { force: true, prune: false },
      (cmd) => {
        const rendered = cmd.join(" ");
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\nbranch refs/heads/GH-674\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force ${worktreePath}`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(result.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("removeWorktree refuses to remove a locked worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-locked-repo-"));

    expect(() =>
      removeWorktree(
        repo,
        "feature-123",
        { force: true, prune: false },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout: "worktree feature-123\nbranch refs/heads/feature-123\nlocked prx session runtime active for FEATURE-123\n\n",
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(/Worktree 'feature-123' is locked: prx session runtime active for FEATURE-123/);
  });

  test("removeWorktree invokes muxHandle.cleanup before `git worktree remove`, passing the resolved worktree path (GH-678)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-mux-"));
    const worktreePath = join(repo, "gh_678_abc");
    mkdirSync(worktreePath);
    const calls: string[] = [];
    const cleanupPaths: string[] = [];

    removeWorktree(
      repo,
      "gh_678_abc",
      {
        force: true,
        prune: false,
        muxHandle: {
          cleanup: (path) => {
            cleanupPaths.push(path);
            calls.push("MUX:cleanup");
          },
        },
      },
      (cmd) => {
        const rendered = cmd.join(" ");
        calls.push(rendered);
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\nbranch refs/heads/gh_678_abc\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force ${worktreePath}`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    // Resolved path — not the user-supplied target — must be passed to cleanup.
    expect(cleanupPaths).toEqual([worktreePath]);
    // Order-sensitive assertion: cleanup must happen BEFORE `git worktree remove`.
    const cleanupIdx = calls.indexOf("MUX:cleanup");
    const removeIdx = calls.findIndex((c) => c.includes("worktree remove"));
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(cleanupIdx);
  });

  test("removeWorktree skips muxHandle.cleanup on dry-run (no side effects when not removing) (GH-678)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-mux-dry-"));
    const worktreePath = join(repo, "gh_678_abc");
    mkdirSync(worktreePath);
    let cleanupCallCount = 0;

    removeWorktree(
      repo,
      "gh_678_abc",
      {
        dryRun: true,
        muxHandle: { cleanup: () => { cleanupCallCount += 1; } },
      },
      (cmd) => {
        const rendered = cmd.join(" ");
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\nbranch refs/heads/gh_678_abc\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${worktreePath} status --porcelain=v1`) {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command on dry-run: ${rendered}`);
      },
    );

    expect(cleanupCallCount).toBe(0);
  });

  test("removeWorktree swallows muxHandle.cleanup exceptions so git-level removal still proceeds (GH-678)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-mux-throw-"));
    const worktreePath = join(repo, "gh_678_abc");
    mkdirSync(worktreePath);

    const result = removeWorktree(
      repo,
      "gh_678_abc",
      {
        force: true,
        prune: false,
        muxHandle: {
          cleanup: () => {
            throw new Error("simulated tmux-missing ENOENT");
          },
        },
      },
      (cmd) => {
        const rendered = cmd.join(" ");
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout: `worktree ${worktreePath}\nbranch refs/heads/gh_678_abc\n\n`,
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree remove --force ${worktreePath}`) {
          rmSync(worktreePath, { recursive: true, force: true });
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(result.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("removeWorktree --force reclaims stale-pid lock then removes (GH-591)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-stale-lock-"));
    const calls: string[] = [];

    const result = removeWorktree(
      repo,
      "feature-123",
      { force: true, prune: false, isPidAlive: () => false },
      (cmd) => {
        const rendered = cmd.join(" ");
        calls.push(rendered);
        if (rendered === `git -C ${repo} worktree list --porcelain`) {
          return {
            status: 0,
            stdout:
              "worktree feature-123\nbranch refs/heads/feature-123\nlocked prx session runtime active for FEATURE-123 (pid 99233)\n\n",
            stderr: "",
          };
        }
        if (rendered === `git -C ${repo} worktree unlock feature-123`) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (rendered === `git -C ${repo} worktree remove --force feature-123`) {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${rendered}`);
      },
    );

    expect(calls).toEqual([
      `git -C ${repo} worktree list --porcelain`,
      `git -C ${repo} worktree unlock feature-123`,
      `git -C ${repo} worktree remove --force feature-123`,
    ]);
    expect(result.removed).toBe(true);
  });

  test("removeWorktree without --force still blocks on stale-pid lock (GH-591)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-stale-noforce-"));

    expect(() =>
      removeWorktree(
        repo,
        "feature-123",
        { force: false, prune: false, isPidAlive: () => false },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout:
                "worktree feature-123\nbranch refs/heads/feature-123\nlocked prx session runtime active for FEATURE-123 (pid 99233)\n\n",
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(/Worktree 'feature-123' is locked/);
  });

  test("removeWorktree --force keeps blocking when lock pid is alive (GH-591)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-live-lock-"));

    expect(() =>
      removeWorktree(
        repo,
        "feature-123",
        { force: true, prune: false, isPidAlive: () => true },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout:
                "worktree feature-123\nbranch refs/heads/feature-123\nlocked prx session runtime active for FEATURE-123 (pid 42)\n\n",
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(/Worktree 'feature-123' is locked/);
  });

  test("removeWorktree --force blocks on lock without parseable pid (GH-591)", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-state-worktree-opaque-lock-"));

    expect(() =>
      removeWorktree(
        repo,
        "feature-123",
        { force: true, prune: false, isPidAlive: () => false },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout:
                "worktree feature-123\nbranch refs/heads/feature-123\nlocked manual operator lock\n\n",
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(/Worktree 'feature-123' is locked/);
  });

  test("removeWorktree quotes unlock guidance for paths with spaces", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "pr state worktree locked repo ")), "repo root");

    expect(() =>
      removeWorktree(
        repo,
        "feature path",
        { force: true, prune: false },
        (cmd) => {
          const rendered = cmd.join(" ");
          if (rendered === `git -C ${repo} worktree list --porcelain`) {
            return {
              status: 0,
              stdout: "worktree feature path\nbranch refs/heads/feature-path\nlocked session still active\n\n",
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${rendered}`);
        },
      ),
    ).toThrow(
      new RegExp(
        `git -C '${repo.replace(/'/g, `'\\\\''`)}' worktree unlock 'feature path'`,
      ),
    );
  });

  test("repo-status supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repo-status"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        repoStatus: () => ({
          source: "wt+git+gh",
          repo_root: "/repo",
          operation: "none",
          local: {
            branch: {
              name: "main",
              detached: false,
              noCommits: false,
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              diverged: false,
              sync: "up_to_date",
            },
            files: { staged: [], unstaged: ["db/schema.rb"], untracked: [], ignored: [], conflicts: [] },
            counts: { staged: 0, unstaged: 1, untracked: 0, ignored: 0, conflicts: 0 },
            clean: false,
            codes: {
              " ": "unmodified",
              M: "modified",
              A: "added",
              D: "deleted",
              R: "renamed",
              C: "copied",
              U: "unmerged",
              "?": "untracked",
              "!": "ignored",
            },
          },
          worktrees: {
            source: "wt+git",
            wt_available: true,
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
          },
          remote: {
            freshness: "stale",
            fetch_required: true,
            fetch_status: "ok",
            updated_refs: ["origin/main"],
            new_refs: ["origin/new-branch"],
            deleted_refs: [],
            raw: [],
          },
          pr: {
            exists: true,
            number: 123,
            title: "PR",
            url: "https://example.com/pr/123",
            draft: false,
            checks: "green",
            review: "approved",
            approvals: 2,
            mergeable: "mergeable",
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("repo=/repo");
    expect(logs[0]!).toContain("remote=stale");
    expect(logs[0]!).toContain("pr=#123 ready checks=green review=approved mergeable=mergeable");
  });

  test("repo-status supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repo-status", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        repoStatus: () => ({
          source: "wt+git+gh",
          repo_root: "/repo",
          operation: "none",
          local: {
            branch: {
              name: "main",
              detached: false,
              noCommits: false,
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              diverged: false,
              sync: "up_to_date",
            },
            files: { staged: [], unstaged: [], untracked: [], ignored: [], conflicts: [] },
            counts: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            clean: true,
            codes: {
              " ": "unmodified",
              M: "modified",
              A: "added",
              D: "deleted",
              R: "renamed",
              C: "copied",
              U: "unmerged",
              "?": "untracked",
              "!": "ignored",
            },
          },
          worktrees: {
            source: "wt+git",
            wt_available: true,
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
          },
          remote: {
            freshness: "fresh",
            fetch_required: false,
            fetch_status: "no-op",
            updated_refs: [],
            new_refs: [],
            deleted_refs: [],
            raw: [],
          },
          pr: {
            exists: false,
            number: null,
            title: null,
            url: null,
            draft: null,
            checks: null,
            review: null,
            approvals: null,
            mergeable: null,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      source: "wt+git+gh",
      remote: {
        freshness: "fresh",
      },
      pr: {
        exists: false,
      },
    });
  });

  test("protect-main supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["protect-main"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        protectMainBranch: () => protectMainBranchResultFixture({          requireConversationResolution: true,
          requiredStatusChecks: ["ci / test", "lint"],
          payload: {
            ...protectMainBranchResultFixture().payload,
            required_status_checks: { strict: true, contexts: ["ci / test", "lint"] },
            required_conversation_resolution: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("WOULD APPLY main protection");
    expect(logs[0]!).toContain("backend=branch-protection");
    expect(logs[0]!).toContain("solo=false");
    expect(logs[0]!).toContain("repo=bdelanghe/ai-home");
    expect(logs[0]!).toContain("viewer=bdelanghe");
    expect(logs[0]!).toContain("require_conversation_resolution=true");
    expect(logs[0]!).toContain("required_status_checks=ci / test,lint");
  });

  test("protect-main supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["protect-main", "--apply", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        protectMainBranch: () => protectMainBranchResultFixture({
          apply: true,
          applied: true,        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      repo: "bdelanghe/ai-home",
      applied: true,
      branch: "main",
    });
  });

  test("protect-main --strict enables the current strict defaults", () => {
    const logs: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["protect-main", "--strict"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        protectMainBranch: (_repoPath, options) => {
          calls.push(options as unknown as Record<string, unknown>);
          return protectMainBranchResultFixture({            enforceAdmins: true,
            requireConversationResolution: true,
            requireLastPushApproval: true,
            requireLinearHistory: true,
            payload: {
              ...protectMainBranchResultFixture().payload,
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
            },
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls[0]!).toMatchObject({
      apply: false,
      enforceAdmins: true,
      requireConversationResolution: true,
      requireLastPushApproval: true,
      requireLinearHistory: true,
    });
    expect(logs[0]!).toContain("enforce_admins=true");
    expect(logs[0]!).toContain("require_conversation_resolution=true");
    expect(logs[0]!).toContain("require_last_push_approval=true");
    expect(logs[0]!).toContain("require_linear_history=true");
  });

  test("protect-main defaults to dry-run and supports deno-style --allow options", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["protect-main", "--allow", "enforce-admins", "--allow", "status-check:ci"],
      {
        log: () => {},
        error: () => {},
      },
      {
        protectMainBranch: (_repoPath, options) => {
          calls.push(options as unknown as Record<string, unknown>);
          return protectMainBranchResultFixture({            enforceAdmins: true,
            requiredStatusChecks: ["ci"],
            payload: {
              ...protectMainBranchResultFixture().payload,
              required_status_checks: { strict: true, contexts: ["ci"] },
              enforce_admins: true,
            },
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls[0]!).toMatchObject({
      backend: "branch-protection",
      apply: false,
      enforceAdmins: true,
      requiredStatusChecks: ["ci"],
    });
  });

  test("protect-main supports ruleset backend selection", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["protect-main", "--ruleset"],
      {
        log: () => {},
        error: () => {},
      },
      {
        protectMainBranch: (_repoPath, options) => {
          calls.push(options as unknown as Record<string, unknown>);
          return protectMainBranchResultFixture({
            backend: "ruleset",
            rulesetId: 42,
            rulesetName: "prx main branch ruleset",
            enforceAdmins: true,
            requireConversationResolution: true,
            requireLastPushApproval: false,
            requiredApprovingReviewCount: 0,
            requiredStatusChecks: ["ci"],
            payload: {
              ...protectMainBranchResultFixture().payload,
              required_status_checks: { strict: true, contexts: ["ci"] },
              required_pull_request_reviews: {
                dismiss_stale_reviews: true,
                require_code_owner_reviews: false,
                required_approving_review_count: 0,
                require_last_push_approval: false,
              },
              required_conversation_resolution: true,
            },
            command: ["gh", "api", "--method", "POST", "repos/bdelanghe/ai-home/rulesets"],
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls[0]!).toMatchObject({ backend: "ruleset" });
  });

  test("protect-main forwards --solo", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["protect-main", "--solo"],
      {
        log: () => {},
        error: () => {},
      },
      {
        protectMainBranch: (_repoPath, options) => {
          calls.push(options as unknown as Record<string, unknown>);
          return protectMainBranchResultFixture({            solo: true,
            approvalContributorCount: null,
            requireLastPushApproval: false,
            requiredApprovingReviewCount: 0,
            payload: {
              ...protectMainBranchResultFixture().payload,
              required_pull_request_reviews: {
                dismiss_stale_reviews: false,
                require_code_owner_reviews: false,
                required_approving_review_count: 0,
                require_last_push_approval: false,
              },
            },
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls[0]!).toMatchObject({ solo: true });
  });

  test("repos rejects unexpected positionals", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["repos", "normlize"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Unexpected argument");
  });

  test("protect-main --check supports plain output and nonzero drift exit", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["protect-main", "--check", "--enforce-admins"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        checkMainBranchProtection: () => checkMainBranchProtectionResultFixture({          enforceAdmins: true,
          desired: {
            ...protectMainBranchResultFixture().payload,
            enforce_admins: true,
          },
          live: protectMainBranchResultFixture().payload,
          matches: false,
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(logs[0]!).toContain("DRIFT main protection");
    expect(logs[0]!).toContain("enforce_admins=true");
  });

  test("repo-checks supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repo-checks"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        repoCheckNames: () => ({
          repo: "bdelanghe/ai-home",
          branch: "main",
          sha: "abc123",
          checks: ["ci / test", "lint"],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("check names for bdelanghe/ai-home @ main");
    expect(logs[0]!).toContain("sha=abc123");
    expect(logs[0]!).toContain("- ci / test");
  });

  test("repo-checks supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["repo-checks", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        repoCheckNames: () => ({
          repo: "bdelanghe/ai-home",
          branch: "main",
          sha: "abc123",
          checks: ["ci / test", "lint"],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({
      repo: "bdelanghe/ai-home",
      branch: "main",
      sha: "abc123",
      checks: ["ci / test", "lint"],
    });
  });

  test("remote-ci-check supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["remote-ci-check", "--pr", "16230"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        remoteCiCheck: () => ({
          repoPath: ".",
          pr: "16230",
          failingChecks: [
            {
              name: "continuous-integration/codebuild",
              state: "FAILURE",
              description: "The CodeBuild build has failed",
              link: "https://console.aws.amazon.com/codebuild/home?region=us-east-1#/builds/WebCodeBuildProject-X:view/new",
              codebuild: {
                buildId: "WebCodeBuildProject-X:view",
                reportArn: "arn:aws:codebuild:us-east-1:123:report/X",
                error: null,
                failures: [
                  {
                    name: "test_lin_loop_item",
                    suite: "OrderfulInventoryInquiryAdviceTest",
                    status: "FAILED",
                    message: null,
                    details: "Expected: \"1\" Actual: nil",
                    duration_ns: 69930102,
                  },
                ],
              },
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(logs[0]!).toContain("remote ci check");
    expect(logs[0]!).toContain("continuous-integration/codebuild");
    expect(logs[0]!).toContain("failed_tests: 1");
  });

  test("remote-ci-check supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["remote-ci-check", "--pr", "16230", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        remoteCiCheck: () => ({
          repoPath: "/repo",
          pr: "16230",
          failingChecks: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      repoPath: "/repo",
      pr: "16230",
      failingChecks: [],
    });
  });

  test("remote-ci-check without --pr auto-resolves from current branch", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["remote-ci-check"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        resolveCurrentPrRef: () => "42",
        remoteCiCheck: (_repoPath, prRef) => {
          expect(prRef).toBe("42");
          return { repoPath: ".", pr: prRef, failingChecks: [] };
        },
      },
    );

    expect(exitCode).toBe(0);
  });

  test("scout comments routes to pr-comments", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["scout", "comments", "--format", "json", "--pr", "GH-100"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        fetchPrComments: (_repoPath, prRef) => ({
          repoPath: ".",
          pr: { number: 100, title: "test", url: "", isDraft: false, baseRefName: "main", reviewDecision: null, mergeStateStatus: null, mergeable: null, autoMergeEnabled: false },
          reviewAdded: false,
          reviewApproved: false,
          agentReview: false,
          humanReview: false,
          unresolvedThreads: 0,
          threads: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain('"unresolvedThreads": 0');
  });

  test("scout ci routes to remote-ci-check", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["scout", "ci", "--pr", "123"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        remoteCiCheck: (_repoPath, prRef) => {
          expect(prRef).toBe("123");
          return { repoPath: ".", pr: prRef, failingChecks: [] };
        },
      },
    );

    expect(exitCode).toBe(0);
  });

  test("scout checks routes to repo-checks", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["scout", "checks"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        repoCheckNames: () => ({ checks: [], repo: "bdelanghe/ai-home", branch: "main", sha: "abc123" }),
      },
    );

    // exit 1 because no checks found (empty)
    expect(exitCode).toBe(1);
  });

  test("scout logs routes to scout-logs with failing checks", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["scout", "logs", "--pr", "42", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        scoutLogs: (_repoPath, prRef, _runner, _maxLines) => {
          expect(prRef).toBe("42");
          return {
            repoPath: ".",
            pr: prRef,
            checks: [{
              name: "ci",
              state: "FAILURE",
              link: "https://github.com/owner/repo/actions/runs/123",
              runId: "123",
              logs: "Error: test failed",
              error: null,
            }],
          };
        },
      },
    );

    expect(exitCode).toBe(1); // failing checks
    const output = logs.join("\n");
    expect(output).toContain('"runId": "123"');
    expect(output).toContain("Error: test failed");
  });

  test("scout logs with no failures returns exit 0", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["scout", "logs", "--pr", "42"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        scoutLogs: () => ({ repoPath: ".", pr: "42", checks: [] }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("no failing checks");
  });

  test("scout unknown subcommand errors", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["scout", "invalid"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Unknown scout subcommand");
  });

  test("pr-comments supports plain output and default write path", () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "prx-pr-comments-"));
    const exitCode = runCliDirect(
      ["pr-comments", "--repo-path", dir, "--write"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        fetchPrComments: () => ({
          repoPath: dir,
          pr: {
            number: 334,
            title: "Signal remote CI before reviewer",
            url: "https://example.com/pr/334",
            isDraft: false,
            baseRefName: "main",
            reviewDecision: null,
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
              isOutdated: false,
              path: "src/pr-state/task.ts",
              comments: [
                {
                  authorLogin: "copilot-pull-request-reviewer",
                  body: "Please fix the blocker text.",
                  path: "src/pr-state/task.ts",
                  state: "SUBMITTED",
                  createdAt: "2026-03-22T02:25:18Z",
                  url: "https://example.com/comment/1",
                  outdated: false,
                },
              ],
            },
          ],
        }),
      },
    );

    const outputPath = join(dir, ".pr", "local", "review-comments.json");
    expect(exitCode).toBe(1);
    expect(logs[0]!).toContain("pr comments for #334");
    expect(logs[0]!).toContain("unresolved_threads=1");
    expect(logs[0]!).toContain(`saved=${outputPath}`);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      unresolvedThreads: 1,
      pr: { number: 334 },
    });
  });

  test("pr-comments supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["pr-comments", "--format", "json", "--pr", "GH-321"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        fetchPrComments: () => ({
          repoPath: "/repo",
          pr: {
            number: 334,
            title: "Signal remote CI before reviewer",
            url: "https://example.com/pr/334",
            isDraft: false,
            baseRefName: "main",
            reviewDecision: null,
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            autoMergeEnabled: false,
          },
          reviewAdded: false,
          reviewApproved: false,
          agentReview: false,
          humanReview: false,
          unresolvedThreads: 0,
          threads: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      repoPath: "/repo",
      unresolvedThreads: 0,
      pr: {
        number: 334,
      },
    });
  });

  test("pr-comments resolve resolves specified threads and verifies post-resolution state", () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "prx-pr-comments-resolve-"));
    let fetchCount = 0;
    const exitCode = runCliDirect(
      ["pr-comments", "resolve", "thread-1", "--thread", "thread-2", "--repo-path", dir, "--write"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        fetchPrComments: () => {
          fetchCount += 1;
          if (fetchCount === 1) {
            return {
              repoPath: dir,
              pr: {
                number: 334,
                title: "Signal remote CI before reviewer",
                url: "https://example.com/pr/334",
                isDraft: false,
                baseRefName: "main",
                reviewDecision: null,
                mergeStateStatus: "BLOCKED",
                mergeable: "MERGEABLE",
                autoMergeEnabled: true,
              },
              reviewAdded: true,
              reviewApproved: false,
              agentReview: true,
              humanReview: false,
              unresolvedThreads: 2,
              threads: [
                { id: "thread-1", isResolved: false, isOutdated: false, path: "a.ts", comments: [] },
                { id: "thread-2", isResolved: false, isOutdated: true, path: "b.ts", comments: [] },
              ],
            };
          }
          return {
            repoPath: dir,
            pr: {
              number: 334,
              title: "Signal remote CI before reviewer",
              url: "https://example.com/pr/334",
              isDraft: false,
              baseRefName: "main",
              reviewDecision: null,
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
              autoMergeEnabled: true,
            },
            reviewAdded: true,
            reviewApproved: false,
            agentReview: true,
            humanReview: false,
            unresolvedThreads: 0,
            threads: [
              { id: "thread-1", isResolved: true, isOutdated: false, path: "a.ts", comments: [] },
              { id: "thread-2", isResolved: true, isOutdated: true, path: "b.ts", comments: [] },
            ],
          };
        },
        resolvePrReviewThreads: (_repoPath, threadIds) =>
          threadIds.map((id) => ({ id, isResolved: true })),
      },
    );

    const outputPath = join(dir, ".pr", "local", "review-comments.json");
    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("resolved_threads=2");
    expect(logs[0]!).toContain("=== POST-RESOLUTION ===");
    expect(logs[0]!).toContain("unresolved_threads=0");
    expect(logs[0]!).toContain(`saved=${outputPath}`);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      unresolvedThreads: 0,
      pr: { number: 334 },
    });
  });

  test("pr-comments resolve supports resolving all unresolved threads", () => {
    const logs: string[] = [];
    let resolvedIds: string[] = [];
    const exitCode = runCliDirect(
      ["pr-comments", "resolve", "--all-unresolved", "--format", "json", "--pr", "GH-321"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        fetchPrComments: (() => {
          let fetchCount = 0;
          return () => {
            fetchCount += 1;
            return {
              repoPath: "/repo",
              pr: {
                number: 334,
                title: "Signal remote CI before reviewer",
                url: "https://example.com/pr/334",
                isDraft: false,
                baseRefName: "main",
                reviewDecision: null,
                mergeStateStatus: fetchCount === 1 ? "BLOCKED" : "CLEAN",
                mergeable: "MERGEABLE",
                autoMergeEnabled: true,
              },
              reviewAdded: true,
              reviewApproved: false,
              agentReview: true,
              humanReview: false,
              unresolvedThreads: fetchCount === 1 ? 2 : 0,
              threads: fetchCount === 1
                ? [
                    { id: "thread-1", isResolved: false, isOutdated: false, path: "a.ts", comments: [] },
                    { id: "thread-2", isResolved: false, isOutdated: false, path: "b.ts", comments: [] },
                  ]
                : [
                    { id: "thread-1", isResolved: true, isOutdated: false, path: "a.ts", comments: [] },
                    { id: "thread-2", isResolved: true, isOutdated: false, path: "b.ts", comments: [] },
                  ],
            };
          };
        })(),
        resolvePrReviewThreads: (_repoPath, threadIds) => {
          resolvedIds = threadIds;
          return threadIds.map((id) => ({ id, isResolved: true }));
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(resolvedIds).toEqual(["thread-1", "thread-2"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      resolvedThreads: [
        { id: "thread-1", isResolved: true },
        { id: "thread-2", isResolved: true },
      ],
      postResolution: {
        unresolvedThreads: 0,
      },
    });
  });

  test("chains supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["chains"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        chainStatus: () => ({
          source: "chains",
          repo: "owner/repo",
          remote_freshness: "fresh",
          rows: [
            {
              id: "GH-1001",
              display_id: "GH-1001",
              ticket: "GH-1001",
              branch: "GH-1001-feature",
              worktree_path: "/repo/wt1",
              pr: {
                exists: true,
                number: 10,
                title: "Feature",
                url: "https://example.com/10",
                draft: false,
                checks: "green",
                review: "approved",
                approvals: 1,
                mergeable: "mergeable",
              },
              artifacts: {
                worktree: true,
                branch: true,
                pr: true,
                ticket: true,
              },
              local: {
                clean: true,
                staged: 0,
                unstaged: 0,
                untracked: 0,
                conflicts: 0,
              },
              state: "merge_ready",
              reasons: ["approved + checks green + mergeable + remote fresh"],
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Chains view for owner/repo");
    expect(logs[0]!).toContain("GH-1001 | merge_ready | #10 ready | local=clean");
  });

  test("chains plain output uses branch ids for no-ticket rows", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["chains"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        chainStatus: () => ({
          source: "chains",
          repo: "owner/repo",
          remote_freshness: "fresh",
          rows: [
            {
              id: "main",
              display_id: "no-ticket",
              ticket: null,
              branch: "main",
              worktree_path: null,
              pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
              local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
              state: "pushed",
              reasons: [],
            },
            {
              id: "release/next",
              display_id: "no-ticket",
              ticket: null,
              branch: "release/next",
              worktree_path: null,
              pr: { exists: false, number: null, title: null, url: null, draft: null, checks: null, review: null, approvals: null, mergeable: null },
              local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
              state: "pushed",
              reasons: [],
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("main | pushed | no-pr | local=clean");
    expect(logs[0]!).toContain("release/next | pushed | no-pr | local=clean");
  });

  test("chains plain output includes merge_state when remote status is present", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["chains"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        chainStatus: () => ({
          source: "chains",
          repo: "owner/repo",
          remote_freshness: "fresh",
          rows: [
            {
              id: "GH-190",
              display_id: "GH-190",
              ticket: "GH-190",
              branch: "GH-190",
              worktree_path: "/repo/GH-190",
              pr: {
                exists: true,
                number: 10,
                title: "Feature",
                url: "https://example.com/10",
                draft: false,
                checks: "green",
                review: "approved",
                approvals: 1,
                mergeable: "mergeable",
              },
              artifacts: {
                worktree: true,
                branch: true,
                pr: true,
                ticket: true,
              },
              local: {
                clean: true,
                staged: 0,
                unstaged: 0,
                untracked: 0,
                conflicts: 0,
              },
              status: {
                remote: {
                  gh_issue: "dirty",
                  beads_issue: "dirty",
                  project_item: "dirty",
                  branch: "dirty",
                  pr: "dirty",
                  merge_state: "open",
                  ci: "passed",
                  problem: "no",
                },
                local: {
                  branch: "dirty",
                  worktree: "clean",
                  dir: "present",
                  problem: "no",
                },
              },
              state: "merge_ready",
              reasons: [],
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("merge_state:open");
  });

  test("chains supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["chains", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        chainStatus: () => ({
          source: "chains",
          repo: "owner/repo",
          remote_freshness: "stale",
          rows: [
            {
              id: "main",
              display_id: "no-ticket",
              ticket: null,
              branch: "main",
              worktree_path: null,
              pr: {
                exists: false,
                number: null,
                title: null,
                url: null,
                draft: null,
                checks: null,
                review: null,
                approvals: null,
                mergeable: null,
              },
              local: {
                clean: true,
                staged: 0,
                unstaged: 0,
                untracked: 0,
                conflicts: 0,
              },
              state: "pushed",
              reasons: [],
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      source: "chains",
      repo: "owner/repo",
      remote_freshness: "stale",
      rows: [
        {
          id: "main",
          display_id: "no-ticket",
          branch: "main",
          ticket: null,
          state: "pushed",
        },
      ],
    });
  });

  test("chains forwards --remote to chainStatus", () => {
    const calls: Array<{ repoPath: string; remote: boolean }> = [];
    const exitCode = runCliDirect(
      ["chains", "--remote"],
      {
        log: () => {},
        error: () => {},
      },
      {
        chainStatus: (repoPath, options) => {
          const remote = options && typeof options !== "function" ? (options.remote ?? false) : false;
          calls.push({ repoPath, remote });
          return {
            source: "chains",
            repo: "owner/repo",
            remote_freshness: "fresh",
            rows: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ repoPath: ".", remote: true }]);
  });

  test("board is no longer a supported command", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["board"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Unknown subcommand: board");
  });

  test("reconcile supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["reconcile", "--mode", "full", "--authority", "issue", "--scope", "all"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "full",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [
            {
              branch: "GH-190",
              ticket: "GH-190",
              actions: [
                {
                  type: "create_worktree",
                  branch: "GH-190",
                  ticket: "GH-190",
                  reason: "Local branch exists but no worktree is attached",
                  command: "git worktree add ../GH-190 GH-190",
                },
              ],
            },
          ],
          actions: [
            {
              type: "create_worktree",
              branch: "GH-190",
              ticket: "GH-190",
              reason: "Local branch exists but no worktree is attached",
              command: "git worktree add ../GH-190 GH-190",
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("PLAN reconcile");
    expect(logs[0]!).toContain("mode=full");
    expect(logs[0]!).toContain("GH-190 ticket=GH-190");
    expect(logs[0]!).toContain("create_worktree");
  });

  test("prune forwards alias mode to buildParityChain", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["prune", "--authority", "pr", "--scope", "remote", "--format", "json"],
      {
        log: () => {},
        error: () => {},
      },
      {
        buildParityChain: (repoPath, options) => {
          const safeOptions = options ?? {};
          calls.push({ repoPath, ...safeOptions });
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: safeOptions.mode ?? "full",
            authority: safeOptions.authority ?? "issue",
            scope: safeOptions.scope ?? "all",
            apply: safeOptions.apply ?? false,
            units: [],
            actions: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        repoPath: ".",
        mode: "prune",
        authority: "pr",
        scope: "remote",
        apply: true,
      },
    ]);
  });

  test("backfill --ticket threads ticket filter to buildParityChain (GH-460)", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["backfill", "--ticket", "GH-441"],
      {
        log: () => {},
        error: () => {},
      },
      {
        buildParityChain: (repoPath, options) => {
          const safeOptions = options ?? {};
          calls.push({ repoPath, ...safeOptions });
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: safeOptions.mode ?? "backfill",
            authority: safeOptions.authority ?? "issue",
            scope: safeOptions.scope ?? "all",
            apply: safeOptions.apply ?? false,
            ...(safeOptions.ticket ? { ticket: safeOptions.ticket } : {}),
            units: [],
            actions: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        repoPath: ".",
        mode: "backfill",
        authority: "issue",
        scope: "all",
        apply: false,
        ticket: "GH-441",
      },
    ]);
  });

  test("chain backfill --ticket alias dispatches through to buildParityChain (GH-460)", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["chain", "backfill", "--ticket", "gh-441"],
      {
        log: () => {},
        error: () => {},
      },
      {
        buildParityChain: (repoPath, options) => {
          const safeOptions = options ?? {};
          calls.push({ repoPath, ...safeOptions });
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: safeOptions.mode ?? "backfill",
            authority: safeOptions.authority ?? "issue",
            scope: safeOptions.scope ?? "all",
            apply: safeOptions.apply ?? false,
            ...(safeOptions.ticket ? { ticket: safeOptions.ticket } : {}),
            units: [],
            actions: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        repoPath: ".",
        mode: "backfill",
        authority: "issue",
        scope: "all",
        apply: false,
        ticket: "GH-441",
      },
    ]);
  });

  test("reconcile --ticket composes with --mode (GH-460)", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["reconcile", "--mode", "backfill", "--ticket", "GH-441"],
      {
        log: () => {},
        error: () => {},
      },
      {
        buildParityChain: (repoPath, options) => {
          const safeOptions = options ?? {};
          calls.push({ repoPath, ...safeOptions });
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: safeOptions.mode ?? "full",
            authority: safeOptions.authority ?? "issue",
            scope: safeOptions.scope ?? "all",
            apply: safeOptions.apply ?? false,
            ...(safeOptions.ticket ? { ticket: safeOptions.ticket } : {}),
            units: [],
            actions: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        repoPath: ".",
        mode: "backfill",
        authority: "issue",
        scope: "all",
        apply: false,
        ticket: "GH-441",
      },
    ]);
  });

  test("backfill --ticket rejects non-canonical ids (GH-460)", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["backfill", "--ticket", "441"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {},
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--ticket");
  });

  test("backfill --ticket echoes filter and no-actions message in plain output (GH-460)", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["backfill", "--ticket", "GH-441"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "backfill",
          authority: "issue",
          scope: "all",
          apply: false,
          ticket: "GH-441",
          units: [],
          actions: [],
        }),
      },
    );
    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("ticket=GH-441");
    expect(out).toContain("No reconciliation actions required for GH-441.");
  });

  test("prune executes each action's command and reports results", () => {
    // `prx prune` is an active verb — it applies by default and invokes
    // each action's shell command via `/bin/sh -c`, printing a per-action
    // result block. Preview lives at `prx reconcile --mode prune`.
    const logs: string[] = [];
    const applyCalls: Array<{ command: string; cwd: string }> = [];
    const exitCode = runCliDirect(
      ["prune", "--authority", "issue", "--scope", "all"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "prune",
          authority: "issue",
          scope: "all",
          apply: true,
          units: [
            {
              branch: "GH-515",
              ticket: "GH-515",
              actions: [
                {
                  type: "delete_remote_branch",
                  branch: "GH-515",
                  ticket: "GH-515",
                  reason: "PR completed but remote branch still differs from origin/main",
                },
              ],
            },
          ],
          actions: [
            {
              type: "delete_remote_branch",
              branch: "GH-515",
              ticket: "GH-515",
              reason: "PR completed but remote branch still differs from origin/main",
            },
          ],
        }),
        applyParityChainActions: (summary, cwd) => summary.actions.map((action) => {
          const command = commandForSurfaceSyncAction(action, { repoPath: cwd ?? ".", bufferPath: null });
          applyCalls.push({ command, cwd: cwd ?? "" });
          return { action, command, status: 0, stdout: "", stderr: "" };
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.command).toBe("'git' 'push' 'origin' '--delete' 'GH-515'");
    const combined = logs.join("\n");
    expect(combined).toContain("APPLY reconcile");
    expect(combined).toContain("Applied:");
    expect(combined).toContain("[ok ] delete_remote_branch GH-515");
  });

  test("prune invokes pruneStaleRemoteRefs BEFORE buildParityChain (GH-830)", () => {
    // GH-830: on the apply path, remote-tracking refs must be refreshed
    // before planning. Otherwise a remote branch GitHub already deleted
    // still appears in origin/* and gets planned as delete_remote_branch,
    // which then errors at apply-time with "remote ref does not exist".
    const order: string[] = [];
    const exitCode = runCliDirect(
      ["prune", "--authority", "issue", "--scope", "all"],
      {
        log: () => {},
        error: () => {},
      },
      {
        pruneStaleRemoteRefs: () => { order.push("prune"); },
        buildParityChain: () => {
          order.push("parityChain");
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: "prune",
            authority: "issue",
            scope: "all",
            apply: true,
            units: [],
            actions: [],
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(order).toEqual(["prune", "parityChain"]);
  });

  test("reconcile preview (no --apply) does NOT call pruneStaleRemoteRefs (GH-830)", () => {
    // Read-only previews must stay network-free: the fetch --prune origin
    // only happens when we're about to mutate state.
    let pruneCalls = 0;
    const exitCode = runCliDirect(
      ["reconcile", "--mode", "prune", "--authority", "issue", "--scope", "all"],
      {
        log: () => {},
        error: () => {},
      },
      {
        pruneStaleRemoteRefs: () => { pruneCalls += 1; },
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "prune",
          authority: "issue",
          scope: "all",
          apply: false,
          units: [],
          actions: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(pruneCalls).toBe(0);
  });

  test("prune rejects --apply with a helpful migration error", () => {
    // `prx prune` is an active verb — pruning is always on, so --apply is
    // no longer a knob. Reject it loudly rather than silently ignoring it
    // so stale callers learn about the new UX.
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["prune", "--authority", "issue", "--scope", "all", "--apply"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("`prx prune` no longer accepts --apply");
    expect(errors[0]).toContain("prx reconcile --mode prune");
  });

  test("prune session without a work-unit id errors with a usage hint (GH-1133 subverb)", () => {
    // GH-1132 originally expected 'session' to be an unknown positional.
    // GH-1133 claimed it as a subverb; missing id now gets a targeted hint.
    const errors: string[] = [];
    const exitCode = runCliDirect(["prune", "session"], {
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/work-unit id/i);
    expect(errors.join("\n")).toMatch(/prx prune session GH-/);
  });

  test("prune rejects unknown positional 'foo' with accepted-flags list (GH-1132)", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(["prune", "foo"], {
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("unknown positional 'foo'");
    expect(errors[0]).toContain("Accepted flags:");
    expect(errors[0]).toContain("prx prune --help");
  });

  test("prune rejects unknown positional 'beads' with bd close suggestion (GH-1132)", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(["prune", "beads"], {
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("unknown positional 'beads'");
    expect(errors[0]).toContain("bd close");
  });

  test("prune continues on error and exits non-zero when any action fails", () => {
    // GH-520: independent reconciliation steps → continue-on-error, exit
    // non-zero if any action fails so CI can detect partial failures.
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["prune", "--authority", "issue", "--scope", "all"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        buildParityChain: () => ({
          source: "surface-sync",
          repo: "owner/repo",
          mode: "prune",
          authority: "issue",
          scope: "all",
          apply: true,
          units: [
            { branch: "GH-A", ticket: "GH-A", actions: [{
              type: "delete_remote_branch", branch: "GH-A", ticket: "GH-A",
              reason: "r",
            }] },
            { branch: "GH-B", ticket: "GH-B", actions: [{
              type: "delete_local_branch", branch: "GH-B", ticket: "GH-B",
              reason: "r",
            }] },
          ],
          actions: [
            {
              type: "delete_remote_branch", branch: "GH-A", ticket: "GH-A",
              reason: "r",
            },
            {
              type: "delete_local_branch", branch: "GH-B", ticket: "GH-B",
              reason: "r",
            },
          ],
        }),
        applyParityChainActions: (summary) => summary.actions.map((action, i) => ({
          action,
          command: commandForSurfaceSyncAction(action, { repoPath: ".", bufferPath: null }),
          status: i === 0 ? 128 : 0,
          stdout: "",
          stderr: i === 0 ? "remote branch already gone" : "",
        })),
      },
    );

    expect(exitCode).toBe(1);
    const combined = logs.join("\n");
    expect(combined).toContain("[err] delete_remote_branch GH-A");
    expect(combined).toContain("remote branch already gone");
    expect(combined).toContain("[ok ] delete_local_branch GH-B");
  });

  test("applyParityChainActions invokes /bin/sh -c for each action and collects status/stdout/stderr", () => {
    // Unit test for the applier helper itself — contract: one /bin/sh -c
    // invocation per action, in order, with cwd threaded through, and each
    // result's status/stdout/stderr captured for caller reporting.
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const spawn = (file: string, args: string[], options: { cwd: string; encoding: "utf8" }) => {
      calls.push({ file, args, cwd: options.cwd });
      if (args[1]?.includes("GH-A")) {
        return { status: 0, stdout: "deleted\n", stderr: "" };
      }
      return { status: 128, stdout: "", stderr: "branch not found" };
    };

    const results = applyParityChainActions(
      {
        source: "surface-sync",
        repo: "owner/repo",
        mode: "prune",
        authority: "issue",
        scope: "all",
        apply: true,
        units: [],
        actions: [
          { type: "delete_remote_branch", branch: "GH-A", ticket: "GH-A", reason: "r" },
          { type: "delete_local_branch", branch: "GH-B", ticket: "GH-B", reason: "r" },
        ],
      },
      "/repo/root",
      spawn,
      { repoPath: "/repo/root", bufferPath: null },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.file).toBe("/bin/sh");
    expect(calls[0]!.args).toEqual(["-c", "'git' 'push' 'origin' '--delete' 'GH-A'"]);
    expect(calls[0]!.cwd).toBe("/repo/root");
    expect(results[0]!.status).toBe(0);
    expect(results[0]!.stdout).toBe("deleted\n");
    expect(results[1]!.status).toBe(128);
    expect(results[1]!.stderr).toBe("branch not found");
  });

  test("prune rejects explicit --mode", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["prune", "--mode", "full"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("--mode is not supported with `prune`");
  });

  test("prune --dry-run --ticket aliases to `gc teardown --dry-run`: apply:false, no apply call (GH-1126/2l4ua)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let applyCalls = 0;
    const exitCode = await runCliDirect(
      ["prune", "--dry-run", "--ticket", "GH-1048"],
      {
        log: () => {},
        error: () => {},
      },
      {
        buildParityChain: (repoPath, options) => {
          const safeOptions = options ?? {};
          calls.push({ repoPath, ...safeOptions });
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: safeOptions.mode ?? "prune",
            authority: safeOptions.authority ?? "issue",
            scope: safeOptions.scope ?? "all",
            apply: safeOptions.apply ?? false,
            ...(safeOptions.ticket ? { ticket: safeOptions.ticket } : {}),
            units: [],
            actions: [{
              type: "delete_worktree", branch: "GH-1048", ticket: "GH-1048",
              reason: "r",
            }],
          };
        },
        applyParityChainActions: () => {
          applyCalls += 1;
          return [];
        },
      },
    );

    expect(exitCode).toBe(0);
    // Routed through `gc teardown`: runTeardown threads {mode, ticket, apply}
    // (repoPath resolves to cwd; authority/scope default inside buildParityChain).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mode: "prune", apply: false, ticket: "GH-1048" });
    expect(applyCalls).toBe(0); // dry-run → would-tear-down, never applies
  });

  test("prune --ticket (no --dry-run) aliases to `gc teardown`: apply:true + applies (GH-1126/2l4ua)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let applyCalls = 0;
    const action = { type: "delete_worktree" as const, branch: "GH-1048", ticket: "GH-1048", reason: "r" };
    const exitCode = await runCliDirect(
      ["prune", "--ticket", "GH-1048"],
      { log: () => {}, error: () => {} },
      {
        buildParityChain: (repoPath, options) => {
          const safeOptions = options ?? {};
          calls.push({ repoPath, ...safeOptions });
          return {
            source: "surface-sync",
            repo: "owner/repo",
            mode: safeOptions.mode ?? "prune",
            authority: safeOptions.authority ?? "issue",
            scope: safeOptions.scope ?? "all",
            apply: safeOptions.apply ?? false,
            ...(safeOptions.ticket ? { ticket: safeOptions.ticket } : {}),
            units: [],
            actions: [action],
          };
        },
        applyParityChainActions: () => {
          applyCalls += 1;
          return [{ action, command: "noop", status: 0, stdout: "", stderr: "" }];
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ mode: "prune", apply: true, ticket: "GH-1048" });
    expect(applyCalls).toBe(1); // teardown applies the chain
  });

  test("prx prune --ticket emits the deprecation hint once; gc teardown does not (2l4ua)", async () => {
    const { PRX_PRUNE_GC_ALIAS_HINT } = await import("../../src/machine/gc/cli.ts");
    const chain = () => ({
      source: "surface-sync" as const, repo: "o/r", mode: "prune" as const,
      authority: "issue" as const, scope: "all" as const, apply: false,
      units: [], actions: [],
    });
    const aliasErrors: string[] = [];
    await runCliDirect(
      ["prune", "--ticket", "GH-1048", "--dry-run"],
      { log: () => {}, error: (l: string) => aliasErrors.push(l) },
      { buildParityChain: chain },
    );
    expect(aliasErrors.filter((l) => l === PRX_PRUNE_GC_ALIAS_HINT)).toHaveLength(1);

    const canonErrors: string[] = [];
    await runCliDirect(
      ["gc", "teardown", "GH-1048", "--dry-run"],
      { log: () => {}, error: (l: string) => canonErrors.push(l) },
      { buildParityChain: chain },
    );
    expect(canonErrors).not.toContain(PRX_PRUNE_GC_ALIAS_HINT);
  });

  test("bare `prx prune` stays the prune handler + emits the deprecation hint (2l4ua)", async () => {
    const { PRX_PRUNE_GC_ALIAS_HINT } = await import("../../src/machine/gc/cli.ts");
    const errs: string[] = [];
    let built = 0;
    const exitCode = await runCliDirect(
      ["prune", "--dry-run"],
      { log: () => {}, error: (l: string) => errs.push(l) },
      {
        buildParityChain: () => {
          built += 1;
          return {
            source: "surface-sync", repo: "o/r", mode: "prune",
            authority: "issue", scope: "all", apply: false, units: [], actions: [],
          };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(built).toBe(1); // bare prune is NOT remapped — still the prune handler
    expect(errs.filter((l) => l === PRX_PRUNE_GC_ALIAS_HINT)).toHaveLength(1);
  });

  test("actions supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["actions"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: true,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/10",
              draft: false,
              checks: "green",
              review: "approved",
              approvals: 1,
              mergeable: "mergeable",
            },
            system: {
              lifecycle: "open",
              review: "approved",
              ci: "passed",
              mergeability: "clean",
            },
            mergeReady: true,
            phase: "ready_to_merge",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: {
                  exists: true,
                  path: "/repo",
                  checkedOutBranch: "GH-1001",
                  headSha: "abc",
                },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: true,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: "abc",
                },
                pr: {
                  exists: true,
                  number: 10,
                  state: "open",
                  isDraft: false,
                  headRef: "GH-1001",
                  baseRef: "main",
                  url: "https://example.com/10",
                },
              },
              signals: {
                review: { decision: "approved", reviewersRequested: true, unresolvedThreads: 0 },
                ci: { state: "passed", requiredTotal: 1, requiredPassed: 1, failing: [] },
                mergeability: { state: "mergeable", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: true },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [
            {
              id: "contract.init",
              actor: "git",
              surface: "skill",
              label: "Initialize PR contract",
              command: "prx contract init",
              priority: 10,
              enabled: false,
              disabledReason: "PR contract already initialized",
            },
            {
              id: "pr.merge",
              actor: "gh",
              surface: "tool",
              label: "Merge PR",
              reason: "Merge gate is satisfied",
              command: "gh pr merge 10 --squash --delete-branch",
              priority: 110,
              enabled: true,
            },
          ],
          next: {
            id: "pr.merge",
            actor: "gh",
            surface: "tool",
            label: "Merge PR",
            reason: "Merge gate is satisfied",
            command: "gh pr merge 10 --squash --delete-branch",
            priority: 110,
            enabled: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Workflow phase: ready_to_merge");
    expect(logs[0]!).toContain("Derived actions (enabled and disabled, from the XState workflow model plus local repo signals):");
    expect(logs[0]!).toContain("contract.init [disabled] (skill) -> prx contract init");
    expect(logs[0]!).toContain("blocked: PR contract already initialized");
    expect(logs[0]!).not.toContain("reason: undefined");
    expect(logs[0]!).toContain("pr.merge [enabled] (tool)");
  });

  test("next-action supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["next-action"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: false,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: false,
              number: null,
              title: null,
              url: null,
              draft: null,
              checks: null,
              review: null,
              approvals: null,
              mergeable: null,
            },
            system: {
              lifecycle: "drafting",
              review: "none",
              ci: "pending",
              mergeability: "unknown",
            },
            mergeReady: false,
            phase: "draft",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: false, id: null, system: "other", url: null },
                worktree: {
                  exists: true,
                  path: "/repo",
                  checkedOutBranch: "GH-1001",
                  headSha: "abc",
                },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: false,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: null,
                },
                pr: {
                  exists: false,
                  number: null,
                  state: "none",
                  isDraft: null,
                  headRef: null,
                  baseRef: null,
                  url: null,
                },
              },
              signals: {
                review: { decision: "none", reviewersRequested: false, unresolvedThreads: 0 },
                ci: { state: "none", requiredTotal: 0, requiredPassed: 0, failing: [] },
                mergeability: { state: "unknown", blockedReasons: [] },
              },
              sync: { remoteFresh: false, ticketLinkedToPR: null },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: null,
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [
            {
              id: "contract.init",
              actor: "git",
              surface: "skill",
              label: "Initialize PR contract",
              reason: "Missing .pr/local/pr.json",
              command: "prx contract init",
              priority: 10,
              enabled: true,
            },
          ],
          next: {
            id: "contract.init",
            actor: "git",
            surface: "skill",
            label: "Initialize PR contract",
            reason: "Missing .pr/local/pr.json",
            command: "prx contract init",
            priority: 10,
            enabled: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("contract.init (skill)");
    expect(logs[0]!).toContain("run=prx contract init");
  });

  test("next aliases next-action", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["next"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: false,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: false,
              number: null,
              title: null,
              url: null,
              draft: null,
              checks: null,
              review: null,
              approvals: null,
              mergeable: null,
            },
            system: {
              lifecycle: "drafting",
              review: "none",
              ci: "pending",
              mergeability: "unknown",
            },
            mergeReady: false,
            phase: "draft",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: { exists: true, path: "/repo", checkedOutBranch: "GH-1001", headSha: "abc" },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: false,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: null,
                },
                pr: {
                  exists: false,
                  number: null,
                  state: "none",
                  isDraft: null,
                  headRef: null,
                  baseRef: null,
                  url: null,
                },
              },
              signals: {
                review: { decision: "none", reviewersRequested: false, unresolvedThreads: 0 },
                ci: { state: "queued", requiredTotal: 0, requiredPassed: 0, failing: [] },
                mergeability: { state: "unknown", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: false },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [{
            id: "contract.init",
            actor: "git",
            surface: "skill",
            label: "Initialize PR contract",
            reason: "Missing .pr/local/pr.json",
            command: "prx contract init",
            priority: 10,
            enabled: true,
          }],
          next: {
            id: "contract.init",
            actor: "git",
            surface: "skill",
            label: "Initialize PR contract",
            reason: "Missing .pr/local/pr.json",
            command: "prx contract init",
            priority: 10,
            enabled: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Suggested next step");
    expect(logs[0]!).toContain("contract.init");
  });

  test("do rejects disabled actions with the derived disabled reason", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["do", "pr.validate"],
      {
        log: () => {},
        error: (line) => errors.push(line),
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: true,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/10",
              draft: false,
              checks: "green",
              review: "approved",
              approvals: 1,
              mergeable: "mergeable",
            },
            system: {
              lifecycle: "open",
              review: "approved",
              ci: "passed",
              mergeability: "clean",
            },
            mergeReady: true,
            phase: "ready_to_merge",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: { exists: true, path: "/repo", checkedOutBranch: "GH-1001", headSha: "abc" },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: true,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: "abc",
                },
                pr: {
                  exists: true,
                  number: 10,
                  state: "open",
                  isDraft: false,
                  headRef: "GH-1001",
                  baseRef: "main",
                  url: "https://example.com/10",
                },
              },
              signals: {
                review: { decision: "approved", reviewersRequested: true, unresolvedThreads: 0 },
                ci: { state: "passed", requiredTotal: 1, requiredPassed: 1, failing: [] },
                mergeability: { state: "mergeable", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: true },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [{
            id: "pr.validate",
            actor: "local_ci",
            surface: "skill",
            label: "Run PR validation skill",
            command: "prx event --skill pr-validate",
            priority: 80,
            enabled: false,
            disabledReason: "CI is not pending or running",
          }],
          next: null,
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Action `pr.validate` is disabled");
    expect(errors[0]).toContain("CI is not pending or running");
  });

  test("do executes an enabled skill action through the gated command path", () => {
    const contractPath = makeContractFile("drafting", false);
    const exitCode = runCliDirect(
      ["do", "pr.validate", "--contract", contractPath],
      {
        log: () => {},
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: true,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/10",
              draft: false,
              checks: "pending",
              review: "review_required",
              approvals: 0,
              mergeable: "unknown",
            },
            system: {
              lifecycle: "open",
              review: "in_review",
              ci: "pending",
              mergeability: "unknown",
            },
            mergeReady: false,
            phase: "waiting_on_ci",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: { exists: true, path: "/repo", checkedOutBranch: "GH-1001", headSha: "abc" },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: true,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: "abc",
                },
                pr: {
                  exists: true,
                  number: 10,
                  state: "open",
                  isDraft: false,
                  headRef: "GH-1001",
                  baseRef: "main",
                  url: "https://example.com/10",
                },
              },
              signals: {
                review: { decision: "none", reviewersRequested: true, unresolvedThreads: 0 },
                ci: { state: "queued", requiredTotal: 1, requiredPassed: 0, failing: [] },
                mergeability: { state: "unknown", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: true },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [{
            id: "pr.validate",
            actor: "local_ci",
            surface: "skill",
            label: "Run PR validation skill",
            reason: "CI is still pending/running",
            command: "prx event --skill pr-validate",
            priority: 80,
            enabled: true,
          }],
          next: {
            id: "pr.validate",
            actor: "local_ci",
            surface: "skill",
            label: "Run PR validation skill",
            reason: "CI is still pending/running",
            command: "prx event --skill pr-validate",
            priority: 80,
            enabled: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    const contract = loadContract(contractPath);
    expect(deriveInfo(contract).state).toBe("validating");
    expect(contract.pr!.lifecycle!.updated_by).toBe("local_ci");
    expect(contract.pr!.lifecycle!.reason).toBe("CI is still pending/running");
  });

  test("do lets explicit actor and reason override derived action metadata", () => {
    const contractPath = makeContractFile("drafting", false);
    const exitCode = runCliDirect(
      ["do", "pr.validate", "--contract", contractPath, "--actor", "codex", "--reason", "manual override"],
      {
        log: () => {},
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: true,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/10",
              draft: false,
              checks: "pending",
              review: "review_required",
              approvals: 0,
              mergeable: "unknown",
            },
            system: {
              lifecycle: "open",
              review: "in_review",
              ci: "pending",
              mergeability: "unknown",
            },
            mergeReady: false,
            phase: "waiting_on_ci",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: { exists: true, path: "/repo", checkedOutBranch: "GH-1001", headSha: "abc" },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: true,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: "abc",
                },
                pr: {
                  exists: true,
                  number: 10,
                  state: "open",
                  isDraft: false,
                  headRef: "GH-1001",
                  baseRef: "main",
                  url: "https://example.com/10",
                },
              },
              signals: {
                review: { decision: "none", reviewersRequested: true, unresolvedThreads: 0 },
                ci: { state: "queued", requiredTotal: 1, requiredPassed: 0, failing: [] },
                mergeability: { state: "unknown", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: true },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [{
            id: "pr.validate",
            actor: "local_ci",
            surface: "skill",
            label: "Run PR validation skill",
            reason: "CI is still pending/running",
            command: "prx event --skill pr-validate",
            priority: 80,
            enabled: true,
          }],
          next: {
            id: "pr.validate",
            actor: "local_ci",
            surface: "skill",
            label: "Run PR validation skill",
            reason: "CI is still pending/running",
            command: "prx event --skill pr-validate",
            priority: 80,
            enabled: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    const contract = loadContract(contractPath);
    expect(contract.pr!.lifecycle!.updated_by).toBe("codex");
    expect(contract.pr!.lifecycle!.reason).toBe("manual override");
  });

  test("phase supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["phase"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: true,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/pr/10",
              draft: false,
              checks: "pending",
              review: "review_required",
              approvals: 0,
              mergeable: "unknown",
            },
            system: {
              lifecycle: "open",
              review: "in_review",
              ci: "running",
              mergeability: "unknown",
            },
            mergeReady: false,
            phase: "waiting_on_ci",
            currentUnit: null,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: {
                  exists: true,
                  path: "/repo",
                  checkedOutBranch: "GH-1001",
                  headSha: "abc",
                },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: true,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: "abc",
                },
                pr: {
                  exists: true,
                  number: 10,
                  state: "open",
                  isDraft: false,
                  headRef: "GH-1001",
                  baseRef: "main",
                  url: "https://example.com/pr/10",
                },
              },
              signals: {
                review: { decision: "none", reviewersRequested: true, unresolvedThreads: 0 },
                ci: { state: "in_progress", requiredTotal: 1, requiredPassed: 0, failing: [] },
                mergeability: { state: "unknown", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: true },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [],
          next: null,
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toBe("waiting_on_ci");
  });

  test("snapshot supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["snapshot", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        buildDomainState: () => ({
          kind: "DomainStateV1",
          taskContract: null,
          prState: {
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/pr/10",
              draft: false,
              checks: "green",
              review: "approved",
              approvals: 1,
              mergeable: "mergeable",
            },
            system: {
              lifecycle: "open",
              review: "approved",
              ci: "passed",
              mergeability: "clean",
            },
            contract: {
              exists: true,
              mode: "ready",
              state: "merge_ready",
              title: "PR",
              reason: "Approved and green",
            },
            mergeReady: true,
          },
          workflowState: {
            phase: "ready_to_merge",
            task: {
              exists: false,
              currentRole: null,
              machineState: null,
              handoffStatus: null,
              blockers: [],
              nextRole: null,
            },
          },
          repoState: {
            repoRoot: "/repo",
            branch: "PROJ-1001",
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicts: 0 },
            currentUnit: null,
            artifacts: {
              ticket: { exists: true, id: "PROJ-1001", system: "other", url: null },
              worktree: {
                exists: true,
                path: "/repo",
                checkedOutBranch: "PROJ-1001",
                headSha: "abc",
              },
              branch: {
                name: "PROJ-1001",
                existsLocal: true,
                existsRemote: true,
                ahead: 0,
                behind: 0,
                headShaLocal: "abc",
                headShaRemote: "abc",
              },
              pr: {
                exists: true,
                number: 10,
                state: "open",
                isDraft: false,
                headRef: "PROJ-1001",
                baseRef: "main",
                url: "https://example.com/pr/10",
              },
            },
            sync: { remoteFresh: true, ticketLinkedToPR: true },
          },
          reviewState: {
            decision: "approved",
            reviewersRequested: true,
            unresolvedThreads: 0,
            approvals: 1,
            agentReview: null,
            humanReview: null,
            commentsResolved: null,
          },
          rawState: {
            unitId: "PROJ-1001",
            artifacts: {
              ticket: { exists: true, id: "PROJ-1001", system: "other", url: null },
              worktree: {
                exists: true,
                path: "/repo",
                checkedOutBranch: "PROJ-1001",
                headSha: "abc",
              },
              branch: {
                name: "PROJ-1001",
                existsLocal: true,
                existsRemote: true,
                ahead: 0,
                behind: 0,
                headShaLocal: "abc",
                headShaRemote: "abc",
              },
              pr: {
                exists: true,
                number: 10,
                state: "open",
                isDraft: false,
                headRef: "PROJ-1001",
                baseRef: "main",
                url: "https://example.com/pr/10",
              },
            },
            signals: {
              review: { decision: "approved", reviewersRequested: true, unresolvedThreads: 0 },
              ci: { state: "passed", requiredTotal: 1, requiredPassed: 1, failing: [] },
              mergeability: { state: "mergeable", blockedReasons: [] },
            },
            sync: { remoteFresh: true, ticketLinkedToPR: true },
            meta: {
              observedAt: "2026-03-19T00:00:00Z",
              sources: {
                git: "2026-03-19T00:00:00Z",
                gh: "2026-03-19T00:00:00Z",
                ticketSystem: "2026-03-19T00:00:00Z",
              },
            },
          },
          invariants: { valid: true, findings: [] },
        }) as unknown as DomainStateV1,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      kind: "DomainStateV1",
      workflowState: {
        phase: "ready_to_merge",
      },
      prState: {
        mergeReady: true,
      },
      rawState: {
        artifacts: {
          pr: { state: "open" },
        },
        signals: {
          review: {
            unresolvedThreads: 0,
          },
        },
      },
      invariants: {
        valid: true,
      },
    });
  });

  test("statusline supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["statusline"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        nextAction: () => ({
          snapshot: {
            repoRoot: "/repo",
            branch: "GH-1001",
            contractExists: true,
            operation: "none",
            remoteFreshness: "fresh",
            local: { staged: 0, unstaged: 1, untracked: 0, ignored: 0, conflicts: 0 },
            pr: {
              exists: true,
              number: 10,
              title: "PR",
              url: "https://example.com/pr/10",
              draft: false,
              checks: "pending",
              review: "review_required",
              approvals: 0,
              mergeable: "unknown",
            },
            system: {
              lifecycle: "open",
              review: "in_review",
              ci: "running",
              mergeability: "unknown",
            },
            mergeReady: false,
            phase: "waiting_on_ci",
            currentUnit: { ticket: "GH-1001" } as never,
            rawState: ({
              unitId: "GH-1001",
              artifacts: {
                ticket: { exists: true, id: "GH-1001", system: "other", url: null },
                worktree: {
                  exists: true,
                  path: "/repo",
                  checkedOutBranch: "GH-1001",
                  headSha: "abc",
                },
                branch: {
                  name: "GH-1001",
                  existsLocal: true,
                  existsRemote: true,
                  ahead: 0,
                  behind: 0,
                  headShaLocal: "abc",
                  headShaRemote: "abc",
                },
                pr: {
                  exists: true,
                  number: 10,
                  state: "open",
                  isDraft: false,
                  headRef: "GH-1001",
                  baseRef: "main",
                  url: "https://example.com/pr/10",
                },
              },
              signals: {
                review: { decision: "none", reviewersRequested: true, unresolvedThreads: 0 },
                ci: { state: "in_progress", requiredTotal: 1, requiredPassed: 0, failing: [] },
                mergeability: { state: "unknown", blockedReasons: [] },
              },
              sync: { remoteFresh: true, ticketLinkedToPR: true },
              meta: {
                observedAt: "2026-03-19T00:00:00Z",
                sources: {
                  git: "2026-03-19T00:00:00Z",
                  gh: "2026-03-19T00:00:00Z",
                  ticketSystem: "2026-03-19T00:00:00Z",
                },
              },
            }) as unknown as RawStateV1,
            invariants: { valid: true, findings: [] },
          },
          actions: [],
          next: {
            id: "gh.wait_for_ci",
            actor: "gh",
            surface: "tool",
            label: "Wait for CI",
            reason: "Checks are still pending",
            command: "gh pr checks --watch",
            priority: 10,
            enabled: true,
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("GH-1001");
    expect(logs[0]!).toContain("phase=waiting_on_ci");
    expect(logs[0]!).toContain("pr=#10");
    expect(logs[0]!).toContain("ci=pending");
    expect(logs[0]!).toContain("threads=0");
    expect(logs[0]!).toContain("wt=s0/u1/?0/c0");
    expect(logs[0]!).toContain("next=gh.wait_for_ci");
  });

  test("actors supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["actors"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {},
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Tool actors (pr)");
    expect(logs[0]!).toContain("git (cli)");
    expect(logs[0]!).toContain("tier: execution");
    expect(logs[0]!).toContain("gh (api_cli)");
    expect(logs[0]!).toContain("local_ci (local_runner)");
    expect(logs[0]!).not.toContain("notion_mcp");
  });

  test("actors supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["actors", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {},
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      scope: string;
      actors: Array<{ actor: string }>;
    };
    expect(parsed.scope).toBe("pr");
    expect(parsed.actors.map((actor) => actor.actor).sort()).toEqual([
      "doctor",
      "gh",
      "git",
      // GH-2348.3: keeper (git-write / ref custody) joins the pr scope,
      // split out of publisher.
      "keeper",
      "local_ci",
      // prx-wt5: mediator (merge-conflict reconciliation) joins the pr scope.
      "mediator",
      "prx",
      // GH-1558: publisher joins the pr scope as foundation for the
      // GH-1398 publisher-actor chain.
      "publisher",
      "remote_ci",
      "wt",
    ]);
  });

  test("actors supports workflow scope", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["actors", "--scope", "workflow", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {},
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      scope: string;
      actors: Array<{ actor: string }>;
    };
    expect(parsed.scope).toBe("workflow");
    expect(parsed.actors.map((actor) => actor.actor)).toContain("notion_mcp");
    expect(parsed.actors.map((actor) => actor.actor)).toContain("beads");
    expect(parsed.actors.map((actor) => actor.actor)).toContain("llm_agent");
  });

  test("model supports plain output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["model"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {},
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!).toContain("Model (pr)");
    expect(logs[0]!).toContain("actors -> owned raw facts -> invariants -> derived phase");
    expect(logs[0]!).toContain("ready_to_merge");
  });

  test("model supports json output", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["model", "--scope", "workflow", "--format", "json"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {},
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      scope: string;
      actors: Array<{ actor: string }>;
      rawFieldOwners: Record<string, string>;
      eventOwners: Record<string, string>;
      workflowBackbone?: { id?: string };
    };
    expect(parsed.scope).toBe("workflow");
    expect(parsed.actors.map((actor) => actor.actor)).toContain("beads");
    expect(parsed.rawFieldOwners["task.id"]).toBe("beads");
    expect(parsed.eventOwners["TASK_CREATED"]).toBe("beads");
    expect(parsed.eventOwners["WORKTREE_CREATED"]).toBe("wt");
    expect(parsed.eventOwners["REMOTE_BRANCH_PUBLISHED"]).toBe("git");
    expect(parsed.eventOwners["PR_READY_FOR_REVIEW"]).toBe("gh");
    expect(parsed.workflowBackbone?.id).toBe("workflowBackbone");
  });

  test("overview omits duplicate current-branch entry from created-by-you", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["overview"],
      {
        log: (line) => logs.push(line),
        error: () => {},
      },
      {
        overviewStatus: () => ({
          repo: "owner/repo",
          currentBranch: {
            number: 10,
            title: "Current branch PR",
            branch: "feature-branch",
            url: "https://example.com/10",
            draft: false,
            checks: "green",
            review: "review_required",
            approvals: 0,
            mergeable: "unknown",
            worktree: null,
            diff: {
              files: 12,
              additions: 48,
              deletions: 9,
            },
            local: null,
          },
          createdByYou: [
            {
              number: 10,
              title: "Current branch PR",
              branch: "feature-branch",
              url: "https://example.com/10",
              draft: false,
              checks: "green",
              review: "review_required",
              approvals: 0,
              mergeable: "unknown",
              worktree: null,
              diff: {
                files: 12,
                additions: 48,
                deletions: 9,
              },
              local: null,
            },
            {
              number: 11,
              title: "Other PR",
              branch: "other-branch",
              url: "https://example.com/11",
              draft: true,
              checks: "pending",
              review: "approved",
              approvals: 3,
              mergeable: "unknown",
              worktree: null,
              diff: {
                files: 3,
                additions: 7,
                deletions: 2,
              },
              local: null,
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs[0]!.match(/Current branch PR/g)?.length ?? 0).toBe(2);
    expect(logs[0]!).toContain("#11  Other PR [other-branch]");
    expect(logs[0]!).toContain("- Checks pending - ✓ 3 Approved");
  });

  test.skipIf(!existsSync(join(repoRoot, "skills/pr-contract/example.pr.json")))("example contract still resolves to draft mode", () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        scriptPath,
        "status",
        "--contract",
        "skills/pr-contract/example.pr.json",
        "--format",
        "json",
      ],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
      mode: "draft",
      state: "drafting",
    });
  });
});

describe("prx doctor gh-budget (GH-1533)", () => {
  type AnyRow = Record<string, unknown>;
  // A `rate-limit.jsonl` row (RateLimitAuditEntry shape) with the GH-1533
  // attribution fields populated. `ts` defaults to inside the test window.
  const row = (over: AnyRow): AnyRow => ({
    ts: "2026-05-12T14:30:00.000Z",
    argv: ["gh", "issue", "list", "--json", "number"],
    bucket: "graphql",
    remaining_before: 4900,
    remaining_after: 4900,
    exit_code: 0,
    threw: null,
    cost_delta: null,
    api: "graphql",
    verb: "triage.status",
    actor: "claude-code",
    operation: "issue.list",
    cost: null,
    remaining: 4900,
    limit: 5000,
    reset_at: null,
    duration_ms: 100,
    ...over,
  });
  const fixedNow = () => new Date("2026-05-12T15:00:00.000Z");

  test("json: groups graphql rows by verb, sums measured cost, surfaces exhaustion; excludes out-of-window + REST", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["doctor", "gh-budget", "--format", "json", "--since", "1h"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        now: fixedNow,
        rateLimitAuditReader: () =>
          [
            row({ ts: "2026-05-12T13:00:00.000Z", verb: "old.verb", cost: 99 }), // before the window — dropped
            row({ verb: "triage.status", cost: 5 }),
            row({ verb: "triage.status", cost: 3 }),
            row({ verb: "triage.status", cost: null }),
            row({ verb: "intake.search", cost: 1, threw: "BUDGET_EXHAUSTED", exit_code: -1 }),
            row({ verb: null, cost: null }),
            row({ verb: "intake.search", api: "rest", bucket: "core" }), // REST — not graphql-charged
            // a pre-GH-1533 row (no `api`) on the graphql bucket still counts
            { ts: "2026-05-12T14:45:00.000Z", argv: ["gh", "pr", "view", "--json", "x"], bucket: "graphql", remaining_before: null, remaining_after: null, exit_code: 0, threw: null, cost_delta: null },
          ] as never,
      },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      since: string;
      windowMs: number;
      restCalls: number;
      rows: Array<{ verb: string | null; calls: number; cost: number; costRowsMissing: number; exhausted: number }>;
      totals: { calls: number; cost: number; costRowsMissing: number; exhausted: number };
    };
    expect(parsed.since).toBe("2026-05-12T14:00:00.000Z");
    expect(parsed.windowMs).toBe(3_600_000);
    expect(parsed.restCalls).toBe(1);
    // Sorted by cost desc: triage.status (8) → intake.search (1) → (no verb) (0).
    expect(parsed.rows).toEqual([
      { verb: "triage.status", calls: 3, cost: 8, costRowsMissing: 1, exhausted: 0 },
      { verb: "intake.search", calls: 1, cost: 1, costRowsMissing: 0, exhausted: 1 },
      // the pre-GH-1533 row (no `verb`, no `cost`) folds into "(no verb)"
      { verb: null, calls: 2, cost: 0, costRowsMissing: 2, exhausted: 0 },
    ]);
    expect(parsed.totals).toEqual({ calls: 6, cost: 9, costRowsMissing: 3, exhausted: 1 });
  });

  test("plain: renders a table, the lower-bound caveat, and the REST footnote", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["doctor", "gh-budget"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        now: fixedNow,
        rateLimitAuditReader: () =>
          [
            row({ verb: "triage.status", cost: 4 }),
            row({ verb: "triage.status", cost: null }),
            row({ verb: "intake.search", api: "rest", bucket: "core" }),
          ] as never,
      },
    );
    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("gh GraphQL spend — last 1h");
    expect(out).toContain("triage.status");
    expect(out).toMatch(/triage\.status\s+2\s+4\+/);
    expect(out).toContain("total");
    expect(out).toContain("(+1 REST/core/search calls");
    expect(out).toContain("cost is a lower bound — 1 call(s)");
  });

  test("plain: empty window prints the no-calls line", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["doctor", "gh-budget", "--since", "30m"],
      { log: (line) => logs.push(line), error: () => {} },
      { now: fixedNow, rateLimitAuditReader: () => [] as never },
    );
    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("last 30m");
    expect(out).toContain("(no gh GraphQL calls recorded in this window)");
  });

  test("rejects a malformed --since value", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["doctor", "gh-budget", "--since", "soon"],
      { log: () => {}, error: (line) => errors.push(line) },
      {},
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--since: expected a duration");
  });
});

describe("hooks command", () => {
  const hooksConfigFixture = (): RepoInventoryConfig => ({
    repoRoot,
    bareRoot: "/bare",
    roots: ["/bare"],
    everywhereRoots: ["/bare", "/worktrees"],
    globalConfigPath: null,
    configPath: `${repoRoot}/.prx/repos/config.json`,
    indexPath: `${repoRoot}/.prx/repos/index.json`,
  });

  const hooksInventoryFixture = (): RepoInventory => ({
    roots: ["/bare"],
    bareRoot: "/bare",
    repos: [
      {
        name: "alpha",
        kind: "bare",
        commonDir: "/bare/alpha.git",
        mainWorktree: null,
        localOnlyBranches: [],
        findings: [],
        primaryRemote: null,
        upstreamRemote: null,
        remotes: [],
        worktrees: [],
      },
      {
        name: "beta",
        kind: "bare",
        commonDir: "/bare/beta.git",
        mainWorktree: null,
        localOnlyBranches: [],
        findings: [],
        primaryRemote: null,
        upstreamRemote: null,
        remotes: [],
        worktrees: [],
      },
    ],
  });

  test("hooks apply sets core.hooksPath on each discovered repo", () => {
    const logs: string[] = [];
    const applied: Array<{ commonDir: string; hooksPath: string }> = [];
    const exitCode = runCliDirect(
      ["hooks", "apply", "--hooks-path", "/shared/hooks"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => hooksConfigFixture(),
        discoverLocalRepos: () => hooksInventoryFixture(),
        applyHooks: (inventory, hooksPath) => {
          const entries = inventory.repos.map((repo) => {
            applied.push({ commonDir: repo.commonDir, hooksPath });
            return {
              name: repo.name,
              commonDir: repo.commonDir,
              previousHooksPath: null,
              newHooksPath: hooksPath,
              changed: true,
            };
          });
          return { hooksPath, repos: entries };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(applied).toEqual([
      { commonDir: "/bare/alpha.git", hooksPath: "/shared/hooks" },
      { commonDir: "/bare/beta.git", hooksPath: "/shared/hooks" },
    ]);
    const output = logs.join("\n");
    expect(output).toContain("hooks-path: /shared/hooks");
    expect(output).toContain("apply  alpha  <unset> -> /shared/hooks");
    expect(output).toContain("apply  beta  <unset> -> /shared/hooks");
  });

  test("hooks apply returns exit 1 when any repo errors out", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["hooks", "apply", "--hooks-path", "/shared/hooks"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => hooksConfigFixture(),
        discoverLocalRepos: () => hooksInventoryFixture(),
        applyHooks: (_inventory, hooksPath) => ({
          hooksPath,
          repos: [
            {
              name: "alpha",
              commonDir: "/bare/alpha.git",
              previousHooksPath: null,
              newHooksPath: hooksPath,
              changed: true,
            },
            {
              name: "beta",
              commonDir: "/bare/beta.git",
              previousHooksPath: null,
              newHooksPath: hooksPath,
              changed: false,
              error: "permission denied",
            },
          ],
        }),
      },
    );

    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("err    beta  permission denied");
  });

  test("hooks status exits 0 when every repo matches the expected path", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["hooks", "status", "--hooks-path", "/shared/hooks"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => hooksConfigFixture(),
        discoverLocalRepos: () => hooksInventoryFixture(),
        hookStatus: (inventory, expectedPath) => ({
          hooksPath: expectedPath,
          repos: inventory.repos.map((repo) => ({
            name: repo.name,
            commonDir: repo.commonDir,
            currentHooksPath: expectedPath,
            matches: true,
          })),
        }),
      },
    );

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("expected: /shared/hooks");
    expect(output).toContain("ok    alpha  /shared/hooks");
    expect(output).toContain("ok    beta  /shared/hooks");
  });

  test("hooks status exits 1 when any repo has drift", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["hooks", "status", "--hooks-path", "/shared/hooks", "--format", "json"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        loadRepoInventoryConfig: () => hooksConfigFixture(),
        discoverLocalRepos: () => hooksInventoryFixture(),
        hookStatus: (inventory, expectedPath) => ({
          hooksPath: expectedPath,
          repos: inventory.repos.map((repo, index) => ({
            name: repo.name,
            commonDir: repo.commonDir,
            currentHooksPath: index === 0 ? expectedPath : null,
            matches: index === 0,
          })),
        }),
      },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.hooksPath).toBe("/shared/hooks");
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos[0].matches).toBe(true);
    expect(parsed.repos[1].matches).toBe(false);
  });

  test("hooks apply uses PRX_HOOKS_PATH when --hooks-path omitted", () => {
    const previous = process.env.PRX_HOOKS_PATH;
    process.env.PRX_HOOKS_PATH = "/env/hooks";
    try {
      const logs: string[] = [];
      const exitCode = runCliDirect(
        ["hooks", "apply"],
        { log: (line) => logs.push(line), error: () => {} },
        {
          loadRepoInventoryConfig: () => hooksConfigFixture(),
          discoverLocalRepos: () => hooksInventoryFixture(),
          applyHooks: (_inventory, hooksPath) => ({
            hooksPath,
            repos: [],
          }),
        },
      );
      expect(exitCode).toBe(0);
      expect(logs[0]!).toContain("hooks-path: /env/hooks");
    } finally {
      if (previous === undefined) {
        delete process.env.PRX_HOOKS_PATH;
      } else {
        process.env.PRX_HOOKS_PATH = previous;
      }
    }
  });

  test("hooks errors when no subcommand given", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["hooks"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("hooks requires a subcommand");
  });
});

describe("delegate next command (GH-983 supersedes GH-1510)", () => {
  // GH-983: `prx delegate next` is the filter-aware portfolio picker that
  // supersedes the retired `prx worktree next` verb (itself a GH-1510
  // deprecation alias for `prx next`). It projects `nextWork()`'s
  // bd-canonical output through optional filters and returns a top-1
  // pick (default) or full list (`--all`) with a suggested command.

  const emptyNextWorkResult = {
    source: "next-work" as const,
    repo: "owner/repo",
    threads: [],
    cache: {
      queried_at: "2026-05-13T00:00:00.000+00:00",
      stale: false,
      ttl_seconds: 60,
      refreshed: false,
    },
  };

  const populatedNextWorkResult = {
    source: "next-work" as const,
    repo: "owner/repo",
    threads: [
      {
        kind: "ready_to_start" as const,
        candidates: [
          {
            bd_id: "ai-home-r1",
            gh_issue: 160,
            title: "Wire the picker",
            priority: 1,
            issue_type: "feature",
            branch: null,
            worktree_path: null,
            status: "open" as const,
            blocked_by: [],
            reason: "bd ready; no worktree yet",
            command: "prx session open --create GH-160",
          },
        ],
        recommended_action: "prx session open --create GH-160",
        cost_of_context_switch: "high" as const,
        reason: "bd-ready with no blockers and no worktree yet",
      },
    ],
    cache: {
      queried_at: "2026-05-13T00:00:00.000+00:00",
      stale: false,
      ttl_seconds: 60,
      refreshed: false,
    },
  };

  test("plain output renders the top-1 candidate with a suggested command", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next"],
      { log: (line) => logs.push(line), error: () => {} },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("delegate next");
    expect(output).toContain("ai-home-r1");
    expect(output).toContain("GH-160");
    expect(output).toContain("prx session open --create GH-160");
  });

  test("JSON output parses to source === 'delegate-next'", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next", "--format", "json"],
      { log: (line) => logs.push(line), error: () => {} },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.source).toBe("delegate-next");
    expect(parsed.candidates[0].bd_id).toBe("ai-home-r1");
    expect(parsed.candidates[0].thread).toBe("ready_to_start");
    expect(parsed.suggested_command).toBe("prx session open --create GH-160");
  });

  test("--all renders the full filtered list", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next", "--all"],
      { log: (line) => logs.push(line), error: () => {} },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("1 candidate");
    expect(output).toContain("ai-home-r1");
  });

  test("--type filters by bd issue_type", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next", "--type", "bug"],
      { log: (line) => logs.push(line), error: () => {} },
      { nextWork: () => populatedNextWorkResult },
    );
    // populated fixture's only candidate has issue_type=feature, so this
    // filter yields zero matches and exit 1.
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("no candidates matched");
  });

  test("--priority filters by numeric bd priority", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next", "--priority", "1", "--format", "json"],
      { log: (line) => logs.push(line), error: () => {} },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.candidates[0].priority).toBe(1);
  });

  test("--priority rejects non-numeric input", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next", "--priority", "high"],
      { log: () => {}, error: (line) => errors.push(line) },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("--priority must be an integer");
  });

  test("--epic rejects malformed values", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next", "--epic", "974"],
      { log: () => {}, error: (line) => errors.push(line) },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("--epic must be a GH-NNN");
  });

  test("exit code 1 when every thread is empty", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["delegate", "next"],
      { log: (line) => logs.push(line), error: () => {} },
      { nextWork: () => emptyNextWorkResult },
    );
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("no candidates matched");
  });

  test("retired `prx worktree next` surfaces an unknown-subcommand error", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["worktree", "next"],
      { log: () => {}, error: (line) => errors.push(line) },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toMatch(/Unknown worktree subcommand: next/);
  });

  test("top-level `prx nw` alias is removed (GH-781)", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["nw"],
      { log: () => {}, error: (line) => errors.push(line) },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toMatch(/unknown subcommand/i);
  });

  test("top-level `prx next-worktree` alias is removed (GH-781)", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["next-worktree"],
      { log: () => {}, error: (line) => errors.push(line) },
      { nextWork: () => populatedNextWorkResult },
    );
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toMatch(/unknown subcommand/i);
  });
});

describe("plan handoff command (GH-643; renamed from session close in GH-1166)", () => {
  type CloseOptions = Parameters<typeof closeSession>[0];
  type CloseResult = ReturnType<typeof closeSession>;

  function stubResult(overrides: Partial<CloseResult> = {}): CloseResult {
    return {
      workUnitId: "GH-643",
      worktreePath: "/wt/gh_643_abc",
      branch: "GH-643",
      prNumber: 999,
      prState: "merged",
      issueState: "CLOSED",
      remoteBranchPresent: false,
      mainxReset: "done",
      handoff: [
        "prx worktree-remove GH-643 --delete-branch --force",
        "prx delegate next",
      ],
      handoffRequired: true,
      refusalReason: null,
      dryRun: false,
      ...overrides,
    };
  }

  test("merged PR emits handoff lines and exits 2", async () => {
    const logs: string[] = [];
    let received: CloseOptions | undefined;
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        closeSession: (options) => {
          received = options;
          return stubResult();
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(received).toEqual({
      workUnitId: "GH-643",
      dryRun: false,
      mainxReset: true,
      emitNext: true,
      emitFile: undefined,
      force: false,
    });
    const out = logs.join("\n");
    expect(out).toContain("close=GH-643");
    expect(out).toContain("pr=#999 merged");
    expect(out).toContain("issue=CLOSED");
    expect(out).toContain("remote_branch=gone");
    expect(out).toContain("mainx_reset=done");
    expect(out).toContain("handoff:");
    expect(out).toContain("prx worktree-remove GH-643 --delete-branch --force");
    expect(out).toContain("prx delegate next");
  });

  test("open PR refuses with exit 1 and no handoff", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        closeSession: () =>
          stubResult({
            prState: "open",
            issueState: "OPEN",
            remoteBranchPresent: true,
            mainxReset: "skipped",
            handoff: [],
            handoffRequired: false,
            refusalReason: "PR #999 is open, not merged",
          }),
      },
    );

    expect(exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("refusal=PR #999 is open, not merged");
    expect(out).toContain("result=refused");
    expect(out).not.toContain("handoff:");
  });

  test("draft PR refuses with exit 1", async () => {
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643"],
      { log: () => {}, error: () => {} },
      {
        closeSession: () =>
          stubResult({
            prState: "draft",
            handoff: [],
            handoffRequired: false,
            refusalReason: "PR #999 is draft, not merged",
          }),
      },
    );
    expect(exitCode).toBe(1);
  });

  test("--force forwards to executor and accepts closed-not-merged", async () => {
    let received: CloseOptions | undefined;
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643", "--force"],
      { log: () => {}, error: () => {} },
      {
        closeSession: (options) => {
          received = options;
          return stubResult({ prState: "closed" });
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(received?.force).toBe(true);
  });

  test("--dry-run forwards to executor", async () => {
    let received: CloseOptions | undefined;
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        closeSession: (options) => {
          received = options;
          return stubResult({ dryRun: true, mainxReset: "dry-run" });
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(received?.dryRun).toBe(true);
  });

  test("--no-mainx-reset and --no-next propagate and shrink handoff", async () => {
    let received: CloseOptions | undefined;
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643", "--no-mainx-reset", "--no-next"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        closeSession: (options) => {
          received = options;
          return stubResult({
            mainxReset: "skipped",
            handoff: ["prx worktree-remove GH-643 --delete-branch --force"],
          });
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(received?.mainxReset).toBe(false);
    expect(received?.emitNext).toBe(false);
    const out = logs.join("\n");
    expect(out).toContain("mainx_reset=skipped");
    expect(out).not.toContain("prx delegate next");
  });

  test("--format json emits structured handoff", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643", "--format", "json"],
      { log: (line) => logs.push(line), error: () => {} },
      { closeSession: () => stubResult() },
    );
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed).toMatchObject({
      workUnitId: "GH-643",
      prState: "merged",
      handoff: [
        "prx worktree-remove GH-643 --delete-branch --force",
        "prx delegate next",
      ],
      handoffRequired: true,
    });
  });

  test("worktree already gone reports result=already-gone and exits 0", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "handoff", "GH-643"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        closeSession: () =>
          stubResult({
            worktreePath: null,
            branch: null,
            prNumber: null,
            prState: "none",
            issueState: null,
            remoteBranchPresent: null,
            mainxReset: "skipped",
            handoff: [],
            handoffRequired: false,
          }),
      },
    );
    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("worktree=gone");
    expect(out).toContain("result=already-gone");
  });

  test("positional id must be canonical", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "handoff", "not-a-real-id"],
      { log: () => {}, error: (line) => errors.push(line) },
      {},
    );
    expect(exitCode).toBe(1);
    // `not-a-real-id` has the bd-short shape, so the gate emits the
    // unregistered-prefix hint; either way it carries the canonical-format
    // guidance and the verb label.
    expect(errors.join("\n")).toContain("close");
    expect(errors.join("\n")).toContain("must match CANONICAL-ID format");
  });

  describe("closeSession executor", () => {
    function makeSpawn(responses: Map<string, { status: number; stdout?: string; stderr?: string }>) {
      return ((_file, args) => {
        const key = args.join(" ");
        const match = responses.get(key);
        if (!match) {
          return { status: 1, stdout: "", stderr: `unexpected spawn: ${key}` };
        }
        return { status: match.status, stdout: match.stdout ?? "", stderr: match.stderr ?? "" };
      }) as Parameters<typeof closeSession>[1] extends infer D
        ? D extends { spawn?: infer S }
          ? NonNullable<S>
          : never
        : never;
    }

    function makeRunner(responses: Map<string, { status: number; stdout?: string; stderr?: string }>) {
      return ((cmd) => {
        const key = cmd.join(" ");
        const match = responses.get(key);
        if (!match) {
          return { status: 1, stdout: "", stderr: `unexpected runner: ${key}` };
        }
        return { status: match.status, stdout: match.stdout ?? "", stderr: match.stderr ?? "" };
      }) as Parameters<typeof closeSession>[1] extends infer D
        ? D extends { runner?: infer R }
          ? NonNullable<R>
          : never
        : never;
    }

    test("returns already-gone when the worktree is not registered", () => {
      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: false,
          mainxReset: true,
          emitNext: true,
          force: false,
        },
        {
          cwd: "/repo",
          spawn: makeSpawn(
            new Map([
              ["rev-parse --show-toplevel", { status: 0, stdout: "/repo\n" }],
            ]),
          ),
          runner: makeRunner(
            new Map([
              ["git -C /repo worktree list --porcelain", { status: 0, stdout: "" }],
            ]),
          ),
        },
      );
      expect(result.worktreePath).toBeNull();
      expect(result.handoffRequired).toBe(false);
    });

    test("refuses when PR is open and --force is not set", () => {
      const repoRoot = "/tmp/worktrees/main/gh_643_abc";
      const wtPath = repoRoot;
      const prJson = JSON.stringify({
        number: 42,
        state: "OPEN",
        isDraft: false,
      });
      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: false,
          mainxReset: true,
          emitNext: true,
          force: false,
        },
        {
          cwd: wtPath,
          spawn: makeSpawn(
            new Map([["rev-parse --show-toplevel", { status: 0, stdout: `${repoRoot}\n` }]]),
          ),
          runner: makeRunner(
            new Map([
              [
                `git -C ${repoRoot} worktree list --porcelain`,
                { status: 0, stdout: `worktree ${wtPath}\nbranch refs/heads/GH-643\n\n` },
              ],
              [
                "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
                { status: 0, stdout: prJson },
              ],
            ]),
          ),
        },
      );
      expect(result.refusalReason).toContain("not merged");
      expect(result.prState).toBe("open");
      expect(result.handoff).toEqual([]);
      expect(result.mainxReset).toBe("skipped");
    });

    test("emits handoff and triggers mainx reset on a merged PR", () => {
      const repoRoot = "/tmp/worktrees/main/gh_643_abc";
      const wtPath = repoRoot;
      const mainxPath = "/tmp/worktrees/main/mainx";
      const prJson = JSON.stringify({ number: 42, state: "MERGED", isDraft: false });
      const spawnCalls: string[] = [];
      const spawn = ((_file, args) => {
        const key = args.join(" ");
        spawnCalls.push(key);
        if (key === "rev-parse --show-toplevel") return { status: 0, stdout: `${repoRoot}\n` };
        if (key === `-C ${repoRoot} fetch origin`) return { status: 0, stdout: "" };
        if (key === `-C ${repoRoot} worktree list --porcelain`) {
          return { status: 0, stdout: `worktree ${mainxPath}\nHEAD abc\n\n` };
        }
        if (key === `-C ${mainxPath} checkout --detach origin/main`) return { status: 0, stdout: "" };
        return { status: 1, stdout: "", stderr: `unexpected spawn: ${key}` };
      }) as Parameters<typeof closeSession>[1] extends infer D
        ? D extends { spawn?: infer S }
          ? NonNullable<S>
          : never
        : never;

      const runner = makeRunner(
        new Map([
          [
            `git -C ${repoRoot} worktree list --porcelain`,
            { status: 0, stdout: `worktree ${wtPath}\nbranch refs/heads/GH-643\n\n` },
          ],
          [
            "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
            { status: 0, stdout: prJson },
          ],
          [
            "gh repo view --json nameWithOwner --jq .nameWithOwner",
            { status: 0, stdout: "bdelanghe/ai-home\n" },
          ],
          [
            "gh issue view 643 --json number,state -R bdelanghe/ai-home",
            { status: 0, stdout: JSON.stringify({ number: 643, state: "CLOSED" }) },
          ],
          [
            `git -C ${wtPath} ls-remote --exit-code --heads origin GH-643`,
            { status: 2, stdout: "" },
          ],
        ]),
      );

      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: false,
          mainxReset: true,
          emitNext: true,
          force: false,
        },
        { cwd: wtPath, spawn, runner },
      );

      expect(result.prState).toBe("merged");
      expect(result.issueState).toBe("CLOSED");
      expect(result.remoteBranchPresent).toBe(false);
      expect(result.mainxReset).toBe("done");
      expect(result.handoff).toEqual([
        "prx worktree-remove GH-643 --delete-branch --force",
        "prx delegate next",
      ]);
      expect(spawnCalls).toContain(`-C ${mainxPath} checkout --detach origin/main`);
    });

    test("--dry-run skips the mainx reset spawn", () => {
      const repoRoot = "/tmp/worktrees/main/gh_643_abc";
      const wtPath = repoRoot;
      const prJson = JSON.stringify({ number: 42, state: "MERGED", isDraft: false });
      const spawnCalls: string[] = [];
      const spawn = ((_file, args) => {
        const key = args.join(" ");
        spawnCalls.push(key);
        if (key === "rev-parse --show-toplevel") return { status: 0, stdout: `${repoRoot}\n` };
        return { status: 1, stdout: "", stderr: `unexpected spawn: ${key}` };
      }) as Parameters<typeof closeSession>[1] extends infer D
        ? D extends { spawn?: infer S }
          ? NonNullable<S>
          : never
        : never;

      const runner = makeRunner(
        new Map([
          [
            `git -C ${repoRoot} worktree list --porcelain`,
            { status: 0, stdout: `worktree ${wtPath}\nbranch refs/heads/GH-643\n\n` },
          ],
          [
            "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
            { status: 0, stdout: prJson },
          ],
          [
            "gh repo view --json nameWithOwner --jq .nameWithOwner",
            { status: 0, stdout: "bdelanghe/ai-home\n" },
          ],
          [
            "gh issue view 643 --json number,state -R bdelanghe/ai-home",
            { status: 0, stdout: JSON.stringify({ number: 643, state: "CLOSED" }) },
          ],
          [
            `git -C ${wtPath} ls-remote --exit-code --heads origin GH-643`,
            { status: 2, stdout: "" },
          ],
        ]),
      );

      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: true,
          mainxReset: true,
          emitNext: true,
          force: false,
        },
        { cwd: wtPath, spawn, runner },
      );

      expect(result.mainxReset).toBe("dry-run");
      expect(result.handoff).toHaveLength(2);
      expect(spawnCalls.every((c) => !c.includes("checkout --detach origin/main"))).toBe(true);
    });

    test("writes --emit-file with handoff lines", () => {
      const repoRoot = "/tmp/worktrees/main/gh_643_abc";
      const wtPath = repoRoot;
      const prJson = JSON.stringify({ number: 42, state: "MERGED", isDraft: false });
      let writtenPath = "";
      let writtenContent = "";

      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: false,
          mainxReset: false,
          emitNext: true,
          force: false,
          emitFile: "/fixtures/handoff.txt",
        },
        {
          cwd: wtPath,
          spawn: makeSpawn(
            new Map([["rev-parse --show-toplevel", { status: 0, stdout: `${repoRoot}\n` }]]),
          ),
          runner: makeRunner(
            new Map([
              [
                `git -C ${repoRoot} worktree list --porcelain`,
                { status: 0, stdout: `worktree ${wtPath}\nbranch refs/heads/GH-643\n\n` },
              ],
              [
                "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
                { status: 0, stdout: prJson },
              ],
              [
                "gh repo view --json nameWithOwner --jq .nameWithOwner",
                { status: 0, stdout: "bdelanghe/ai-home\n" },
              ],
              [
                "gh issue view 643 --json number,state -R bdelanghe/ai-home",
                { status: 0, stdout: JSON.stringify({ number: 643, state: "CLOSED" }) },
              ],
              [
                `git -C ${wtPath} ls-remote --exit-code --heads origin GH-643`,
                { status: 2, stdout: "" },
              ],
            ]),
          ),
          writeFile: (p, c) => {
            writtenPath = p;
            writtenContent = c;
          },
        },
      );

      expect(result.handoffRequired).toBe(true);
      expect(writtenPath).toBe("/fixtures/handoff.txt");
      expect(writtenContent).toBe(
        "prx worktree-remove GH-643 --delete-branch --force\nprx delegate next\n",
      );
    });

    test("matches worktree by cwd path when branch is null (detached HEAD)", () => {
      const repoRoot = "/tmp/worktrees/main/gh_643_detached";
      const wtPath = repoRoot;
      const prJson = JSON.stringify({ number: 42, state: "MERGED", isDraft: false });
      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: true,
          mainxReset: false,
          emitNext: true,
          force: false,
        },
        {
          cwd: wtPath,
          spawn: ((_file, args) => {
            const key = args.join(" ");
            if (key === "rev-parse --show-toplevel") return { status: 0, stdout: `${repoRoot}\n`, stderr: "" };
            return { status: 1, stdout: "", stderr: `unexpected: ${key}` };
          }) as Parameters<typeof closeSession>[1] extends infer D
            ? D extends { spawn?: infer S }
              ? NonNullable<S>
              : never
            : never,
          runner: ((cmd) => {
            const key = cmd.join(" ");
            if (key === `git -C ${repoRoot} worktree list --porcelain`) {
              // Worktree entry has no `branch` line — simulates detached HEAD.
              return { status: 0, stdout: `worktree ${wtPath}\nHEAD abc123\n\n`, stderr: "" };
            }
            if (
              key ===
              "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
            ) {
              return { status: 0, stdout: prJson, stderr: "" };
            }
            if (key === "gh repo view --json nameWithOwner --jq .nameWithOwner") {
              return { status: 0, stdout: "bdelanghe/ai-home\n", stderr: "" };
            }
            if (key === "gh issue view 643 --json number,state -R bdelanghe/ai-home") {
              return { status: 0, stdout: JSON.stringify({ number: 643, state: "CLOSED" }), stderr: "" };
            }
            if (key === `git -C ${wtPath} ls-remote --exit-code --heads origin GH-643`) {
              return { status: 2, stdout: "", stderr: "" };
            }
            return { status: 1, stdout: "", stderr: `unexpected: ${key}` };
          }) as Parameters<typeof closeSession>[1] extends infer D
            ? D extends { runner?: infer R }
              ? NonNullable<R>
              : never
            : never,
        },
      );
      expect(result.worktreePath).toBe(wtPath);
      expect(result.branch).toBeNull();
      expect(result.prState).toBe("merged");
      expect(result.handoffRequired).toBe(true);
    });

    test("ls-remote transport failure reports remote_branch=unknown, not gone", () => {
      const repoRoot = "/tmp/worktrees/main/gh_643_ls";
      const wtPath = repoRoot;
      const prJson = JSON.stringify({ number: 42, state: "MERGED", isDraft: false });
      const result = closeSession(
        {
          workUnitId: "GH-643",
          dryRun: true,
          mainxReset: false,
          emitNext: true,
          force: false,
        },
        {
          cwd: wtPath,
          spawn: ((_file, args) => {
            const key = args.join(" ");
            if (key === "rev-parse --show-toplevel") return { status: 0, stdout: `${repoRoot}\n`, stderr: "" };
            return { status: 1, stdout: "", stderr: `unexpected: ${key}` };
          }) as Parameters<typeof closeSession>[1] extends infer D
            ? D extends { spawn?: infer S }
              ? NonNullable<S>
              : never
            : never,
          runner: ((cmd) => {
            const key = cmd.join(" ");
            if (key === `git -C ${repoRoot} worktree list --porcelain`) {
              return { status: 0, stdout: `worktree ${wtPath}\nbranch refs/heads/GH-643\n\n`, stderr: "" };
            }
            if (
              key ===
              "gh pr view --json number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews"
            ) {
              return { status: 0, stdout: prJson, stderr: "" };
            }
            if (key === "gh repo view --json nameWithOwner --jq .nameWithOwner") {
              return { status: 0, stdout: "bdelanghe/ai-home\n", stderr: "" };
            }
            if (key === "gh issue view 643 --json number,state -R bdelanghe/ai-home") {
              return { status: 0, stdout: JSON.stringify({ number: 643, state: "CLOSED" }), stderr: "" };
            }
            if (key === `git -C ${wtPath} ls-remote --exit-code --heads origin GH-643`) {
              return { status: 128, stdout: "", stderr: "fatal: unable to access origin" };
            }
            return { status: 1, stdout: "", stderr: `unexpected: ${key}` };
          }) as Parameters<typeof closeSession>[1] extends infer D
            ? D extends { runner?: infer R }
              ? NonNullable<R>
              : never
            : never,
        },
      );
      expect(result.remoteBranchPresent).toBeNull();
      expect(result.handoffRequired).toBe(true);
    });
  });
});

describe("review / ultrareview commands", () => {
  type ReviewOptions = Parameters<typeof reviewVerb>[0];
  type ReviewResult = ReturnType<typeof reviewVerb>;

  function stubResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return {
      workUnitId: "GH-100",
      worktreePath: "/wt/gh_100_abc",
      sessionName: "gh_100_abc",
      sent: { keys: "/review", submit: true },
      handoff: ["tmux -L prx attach-session -t gh_100_abc"],
      ...overrides,
    };
  }

  test("prx review GH-100 dispatches to reviewVerb with ultra=false and emits attach handoff", () => {
    const logs: string[] = [];
    let received: ReviewOptions | undefined;
    const exitCode = runCliDirect(
      ["review", "GH-100"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        reviewVerb: (options) => {
          received = options;
          return stubResult();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual({ workUnitId: "GH-100", ultra: false });
    expect(logs.join("\n")).toContain("tmux -L prx attach-session -t gh_100_abc");
  });

  test("prx review GH-100 --format json emits the full ReviewVerbResult", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["review", "GH-100", "--format", "json"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        reviewVerb: () => stubResult(),
      },
    );

    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain('"keys": "/review"');
    expect(out).toContain('"submit": true');
    expect(out).toContain('"sessionName": "gh_100_abc"');
  });

  test("prx ultrareview GH-100 dispatches with ultra=true and appends the billing-hint handoff line", () => {
    const logs: string[] = [];
    let received: ReviewOptions | undefined;
    const exitCode = runCliDirect(
      ["ultrareview", "GH-100"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        reviewVerb: (options) => {
          received = options;
          return stubResult({
            sent: { keys: "/ultrareview", submit: false },
            handoff: [
              "tmux -L prx attach-session -t gh_100_abc",
              "/ultrareview is pre-filled and not submitted — press Enter in the pane to see Claude Code's billing confirmation (~$5–20/run).",
            ],
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual({ workUnitId: "GH-100", ultra: true });
    const out = logs.join("\n");
    expect(out).toContain("tmux -L prx attach-session -t gh_100_abc");
    expect(out).toContain("/ultrareview is pre-filled and not submitted");
  });

  test("prx ultrareview GH-100 --format json marks submit=false and keys=/ultrareview", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["ultrareview", "GH-100", "--format", "json"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        reviewVerb: () => stubResult({
          sent: { keys: "/ultrareview", submit: false },
        }),
      },
    );

    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain('"keys": "/ultrareview"');
    expect(out).toContain('"submit": false');
  });

  test("bare prx review (no positional) dispatches with workUnitId undefined", () => {
    let received: ReviewOptions | undefined;
    const exitCode = runCliDirect(
      ["review"],
      { log: () => {}, error: () => {} },
      {
        reviewVerb: (options) => {
          received = options;
          return stubResult({ workUnitId: null });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual({ workUnitId: undefined, ultra: false });
  });

  test("prx review errors with exit 1 when reviewVerb throws (no live session)", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["review", "GH-999"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        reviewVerb: () => {
          const err = new Error("no live tmux session for gh_999_abc; run `prx session open GH-999` first.");
          // runCli wraps arbitrary Error with exit 1 — that's fine.
          throw err;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("prx session open GH-999");
  });

  test("prx review rejects non-canonical positional", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["review", "not-a-canonical-id"],
      { log: () => {}, error: (line) => errors.push(line) },
    );

    expect(exitCode).toBe(1);
    // `not-a-canonical-id` has the bd-short shape → unregistered-prefix hint;
    // the canonical-format guidance and verb label are still present.
    expect(errors.join("\n")).toContain("review");
    expect(errors.join("\n")).toContain("must match CANONICAL-ID format");
  });
});

describe("prx intake (GH-666)", () => {
  test("requires a type positional", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["intake"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("intake requires a type positional");
  });

  test("rejects unknown types", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["intake", "banana", "--title", "x"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("unknown type 'banana'");
  });

  test("accepts spike type (GH-1221)", () => {
    let captured: { type?: string | undefined; title?: string | undefined } | null = null;
    const exitCode = runCliDirect(
      ["intake", "spike", "--title", "x", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("spike");
    expect(captured!.title).toBe("x");
  });

  test("requires a title", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["intake", "task"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("intake requires a title");
  });

  test("rejects --body and --body-stdin together", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["intake", "task", "--title", "x", "--body", "y", "--body-stdin"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("mutually exclusive");
  });

  test("rejects both --title and a second positional", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["intake", "task", "title-positional", "--title", "title-flag"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("via both --title and positional");
  });

  test("dry-run forwards parsed options to runIntake handler", () => {
    let captured: { type?: string | undefined; title?: string | undefined; scope?: string | undefined; to?: string | undefined; bodyFile?: string | undefined; format?: string | undefined; dryRun?: boolean | undefined } | null = null;
    const exitCode = runCliDirect(
      [
        "intake",
        "task",
        "--title",
        "verify",
        "--scope",
        "prx",
        "--body",
        "@/tmp/body.md",
        "--to",
        "gh",
        "--label",
        "intake",
        "--assignee",
        "alice",
        "--repo",
        "owner/repo",
        "--dry-run",
        "--format",
        "json",
      ],
      { log: () => {}, error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("task");
    expect(captured!.title).toBe("verify");
    expect(captured!.scope).toBe("prx");
    // GH-1607: --to gh opts into the GH projection via publishOne.
    expect(captured!.to).toBe("gh");
    // --body @path should be routed through bodyFile, not body.
    expect(captured!.bodyFile).toBe("/tmp/body.md");
    expect(captured!.format).toBe("json");
    expect(captured!.dryRun).toBe(true);
  });

  test("title may be passed as second positional", () => {
    let captured: { title?: string; type?: string } | null = null;
    runCliDirect(
      ["intake", "bug", "broken thing", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
      },
    );
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("bug");
    expect(captured!.title).toBe("broken thing");
  });

  // GH-876: default --scope from cwd worktree
  test("infers --scope from cwd when unset, emits inference to stderr", () => {
    const errors: string[] = [];
    let captured: { scope?: string | undefined } | null = null;
    let inferCalls = 0;
    const exitCode = runCliDirect(
      ["intake", "task", "--title", "x", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
        inferOperatorScopeFromCwd: () => {
          inferCalls += 1;
          return { scope: "prx", source: "git-remote", mapping: "bdelanghe/ai-home" };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(inferCalls).toBe(1);
    expect(captured!.scope).toBe("prx");
    expect(errors).toContain("scope (inferred from cwd): prx");
  });

  test("explicit --scope wins; inference is not consulted", () => {
    const logs: string[] = [];
    let captured: { scope?: string | undefined } | null = null;
    let inferCalls = 0;
    // GH-1305: scope is bound to the AREA enum, so the explicit and inferred
    // sentinels must both be canonical AREA values.
    runCliDirect(
      ["intake", "task", "--title", "x", "--scope", "beads", "--dry-run"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
        inferOperatorScopeFromCwd: () => {
          inferCalls += 1;
          return { scope: "prx", source: "git-remote", mapping: "bdelanghe/ai-home" };
        },
      },
    );
    expect(inferCalls).toBe(0);
    expect(captured!.scope).toBe("beads");
    expect(logs.some((line) => line.startsWith("scope (inferred from cwd):"))).toBe(false);
  });

  test("inference returns null → scope stays unset, no log line", () => {
    const logs: string[] = [];
    let captured: { scope?: string | undefined } | null = null;
    runCliDirect(
      ["intake", "task", "--title", "x", "--dry-run"],
      { log: (line) => logs.push(line), error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
        inferOperatorScopeFromCwd: () => ({
          scope: null,
          source: "skipped",
          reason: "mainx",
        }),
      },
    );
    expect(captured!.scope).toBeUndefined();
    expect(logs.some((line) => line.startsWith("scope (inferred from cwd):"))).toBe(false);
  });

  // GH-1486: --yes bypasses the TTY confirm prompt for `prx intake <type>`.
  test("--yes parses and forwards yes:true to runIntake", () => {
    let captured: { yes?: boolean } | null = null;
    const exitCode = runCliDirect(
      ["intake", "spike", "--title", "probe", "--yes", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.yes).toBe(true);
  });

  test("-y short flag parses identically", () => {
    let captured: { yes?: boolean } | null = null;
    runCliDirect(
      ["intake", "spike", "--title", "probe", "-y", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
      },
    );
    expect(captured).not.toBeNull();
    expect(captured!.yes).toBe(true);
  });

  test("default (no --yes) parses as yes:false", () => {
    let captured: { yes?: boolean } | null = null;
    runCliDirect(
      ["intake", "spike", "--title", "probe", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        runIntake: (options) => {
          captured = options;
          return 0;
        },
      },
    );
    expect(captured).not.toBeNull();
    expect(captured!.yes).toBe(false);
  });
});

describe("prx plan prime (GH-1056)", () => {
  test("primes a unit and prints the canonical primed status line", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-prime-ok-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const logs: string[] = [];
    const errors: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["plan", "prime", "GH-5431"],
        { log: (line) => logs.push(line), error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "up_to_date" }),
          hydrateBeads: () => ({
            status: "hydrated",
            doltRemote: "https://doltremoteapi.dolthub.com/example/repo",
            doltDatabase: "example_db",
            message: "beads: hydrated example_db",
            exitCode: 0,
          }),
          ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
          ensureClaudeAllowlist: () => ({ status: "created", path: `${cwd}/.claude/settings.local.json` }),
          findSavedClaudeSession: () => false,
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(0);
    const primedLine = logs.find((line) => line.startsWith("primed:"));
    expect(primedLine).toBeDefined();
    expect(primedLine).toContain(`worktree=${cwd}`);
    expect(primedLine).toContain("branch=GH-5431");
    expect(primedLine).toContain("beads=hydrated");
    expect(primedLine).toContain("mcp=none");
    expect(primedLine).toContain("allowlist=created");
  }, 15000);

  test("re-running plan prime is idempotent and reports already-hydrated, allowlist=unchanged", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-prime-idem-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const logs: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["plan", "prime", "GH-5431"],
        { log: (line) => logs.push(line), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "up_to_date" }),
          hydrateBeads: () => ({
            status: "already-hydrated",
            doltRemote: null,
            doltDatabase: "example_db",
            message: "beads: example_db already hydrated",
            exitCode: 0,
          }),
          ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
          ensureClaudeAllowlist: () => ({ status: "unchanged", path: `${cwd}/.claude/settings.local.json` }),
          findSavedClaudeSession: () => true,
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(0);
    const primedLine = logs.find((line) => line.startsWith("primed:"));
    expect(primedLine).toBeDefined();
    expect(primedLine).toContain("beads=already-hydrated");
    expect(primedLine).toContain("allowlist=unchanged");
  }, 15000);

  test("hydrate clone-failed exits 1 and emits the warning line", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-prime-fail-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const logs: string[] = [];
    const errors: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["plan", "prime", "GH-5431"],
        { log: (line) => logs.push(line), error: (line) => errors.push(line) },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "up_to_date" }),
          hydrateBeads: () => ({
            status: "clone-failed",
            doltRemote: "https://doltremoteapi.dolthub.com/example/repo",
            doltDatabase: "example_db",
            message: "beads: clone failed for https://doltremoteapi.dolthub.com/example/repo",
            exitCode: 1,
          }),
          ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
          ensureClaudeAllowlist: () => ({ status: "unchanged", path: `${cwd}/.claude/settings.local.json` }),
          findSavedClaudeSession: () => false,
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }

    expect(exitCode).toBe(1);
    expect(errors.some((line) => line.includes("beads: clone failed"))).toBe(true);
    const primedLine = logs.find((line) => line.startsWith("primed:"));
    expect(primedLine).toBeDefined();
    expect(primedLine).toContain("beads=clone-failed");
  }, 15000);

  test("rejects --check with a clear error", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "prime", "GH-5431", "--check"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...noOpWorktreeLockDeps,
        // Hydration deps must NOT be invoked — assert via throws.
        hydrateBeads: () => {
          throw new Error("hydrateBeads must not be called when --check is rejected");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.some((line) => line.includes("does not accept --check or --dry-run"))).toBe(true);
  });

  test("rejects --dry-run with a clear error", async () => {
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "prime", "GH-5431", "--dry-run"],
      { log: () => {}, error: (line) => errors.push(line) },
      {
        ...noOpWorktreeLockDeps,
        hydrateBeads: () => {
          throw new Error("hydrateBeads must not be called when --dry-run is rejected");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.some((line) => line.includes("does not accept --check or --dry-run"))).toBe(true);
  });

  test("does not spawn a tmux session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-prime-no-tmux-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const muxCalls: string[][] = [];
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      await runCliDirect(
        ["plan", "prime", "GH-5431"],
        { log: () => {}, error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "up_to_date" }),
          hydrateBeads: () => ({
            status: "already-hydrated",
            doltRemote: null,
            doltDatabase: "example_db",
            message: "beads: already hydrated",
            exitCode: 0,
          }),
          ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
          ensureClaudeAllowlist: () => ({ status: "unchanged", path: `${cwd}/.claude/settings.local.json` }),
          findSavedClaudeSession: () => false,
          muxRunner: ((cmd) => {
            muxCalls.push([...cmd]);
            return { stdout: "", stderr: "", status: 0 };
          }) as GithubCommandRunner,
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }
    // plan-prime never invokes muxRunner — no `tmux new-session`, no
    // `tmux send-keys`, no `tmux has-session`.
    expect(muxCalls.length).toBe(0);
  }, 15000);

  test("--format=json emits a structured payload instead of the plain status line", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pr-state-plan-prime-json-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.PRX_SESSION_OPEN;
    const logs: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      delete process.env.PRX_SESSION_OPEN;
      process.chdir(cwd);
      exitCode = await runCliDirect(
        ["plan", "prime", "GH-5431", "--format", "json"],
        { log: (line) => logs.push(line), error: () => {} },
        {
          ...noOpWorktreeLockDeps,
          resolveWorkUnitCwd: () => cwd,
          autoRebaseOnSessionOpen: () => ({ status: "up_to_date" }),
          hydrateBeads: () => ({
            status: "already-hydrated",
            doltRemote: null,
            doltDatabase: "example_db",
            message: "beads: already hydrated",
            exitCode: 0,
          }),
          ensureRuntimeArtifacts: () => ({ mcpServers: [] }),
          ensureClaudeAllowlist: () => ({ status: "unchanged", path: `${cwd}/.claude/settings.local.json` }),
          findSavedClaudeSession: () => false,
        },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv !== undefined) process.env.PRX_SESSION_OPEN = previousEnv;
    }
    expect(exitCode).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.workUnitId).toBe("GH-5431");
    expect(payload.launchCwd).toBe(cwd);
    expect(payload.hydrateStatus).toBe("already-hydrated");
    expect(payload.allowlistStatus).toBe("unchanged");
    expect(payload.runtimeArtifacts).toEqual({ mcpServers: [] });
  }, 15000);
});

// GH-1133: `prx prune session <GH-N>` — narrow session/tmux teardown verb.
describe("prx prune session (GH-1133)", () => {
  function stubSessionLayerPruneResult(
    workUnitId: string,
    actions: Array<{ type: string; reason: string; sessionName?: string }>,
  ) {
    const mapAction = (a: { type: string; reason: string; sessionName?: string }) => {
      if (a.type === "kill_tmux_session") {
        return {
          type: "kill_tmux_session" as const,
          branch: workUnitId,
          ticket: workUnitId,
          reason: a.reason,
          sessionName: a.sessionName ?? "",
        };
      }
      return {
        type: "close_prx_session" as const,
        branch: workUnitId,
        ticket: workUnitId,
        reason: a.reason,
        sessionName: a.sessionName ?? "",
      };
    };
    return {
      source: "surface-sync" as const,
      repo: "owner/repo",
      mode: "prune" as const,
      authority: "local" as const,
      scope: "all" as const,
      apply: false,
      ticket: workUnitId,
      units: [{ branch: workUnitId, ticket: workUnitId, actions: actions.map(mapAction) }],
      actions: actions.map(mapAction),
    };
  }

  test("`prx prune session GH-1133` parses to prune-session and threads work-unit id", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["prune", "session", "GH-1133", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        buildSessionLayerPrune: (repoPath, workUnitId, options) => {
          calls.push({ repoPath, workUnitId, ...(options ?? {}) });
          return stubSessionLayerPruneResult(workUnitId, []);
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { repoPath: ".", workUnitId: "GH-1133", apply: false },
    ]);
  });

  test("`prx chain prune session <id>` alias dispatches to the same handler", () => {
    const calls: Array<Record<string, unknown>> = [];
    const exitCode = runCliDirect(
      ["chain", "prune", "session", "GH-1133"],
      { log: () => {}, error: () => {} },
      {
        buildSessionLayerPrune: (repoPath, workUnitId, options) => {
          calls.push({ repoPath, workUnitId, ...(options ?? {}) });
          return stubSessionLayerPruneResult(workUnitId, []);
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { repoPath: ".", workUnitId: "GH-1133", apply: true },
    ]);
  });

  test("`prx prune session` with no work-unit id errors with a usable hint", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["prune", "session"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/work-unit id/i);
    expect(errors.join("\n")).toMatch(/prx prune session GH-/);
  });

  test("apply path runs each action's shell command in `kill_tmux_session, close_prx_session` order", () => {
    const sessionName = "gh_1133_test";
    const actions = [
      {
        type: "kill_tmux_session",
        reason: "Live tmux session present; tear down without removing worktree",
        sessionName,
      },
      {
        type: "close_prx_session",
        reason: "Drop persistent prx session state (tmux-resurrect entry)",
        sessionName,
      },
    ];

    const observedCommands: string[] = [];
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      const exitCode = runCliDirect(
        ["prune", "session", "GH-1133"],
        { log: () => {}, error: () => {} },
        {
          buildSessionLayerPrune: (_repoPath, workUnitId) =>
            stubSessionLayerPruneResult(workUnitId, actions),
          applyParityChainActions: (summary) => {
            const ctx = { repoPath: ".", bufferPath: null };
            for (const action of summary.actions) {
              observedCommands.push(commandForSurfaceSyncAction(action, ctx));
            }
            return summary.actions.map((action) => ({
              action,
              command: commandForSurfaceSyncAction(action, ctx),
              status: 0,
              stdout: "",
              stderr: "",
            }));
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(observedCommands).toEqual([
        `'tmux' '-L' 'prx' 'kill-session' '-t' '${sessionName}'`,
        `'prx' 'tools' 'mux' 'clear-resurrect' '${sessionName}'`,
      ]);
    } finally {
      if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    }
  });

  test("`prx tools mux clear-resurrect` requires a session name", () => {
    const errors: string[] = [];
    const exitCode = runCliDirect(
      ["tools", "mux", "clear-resurrect"],
      { log: () => {}, error: (line) => errors.push(line) },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/session name/i);
  });

  test("`prx tools mux clear-resurrect <name>` succeeds idempotently for an unknown session", () => {
    const logs: string[] = [];
    const exitCode = runCliDirect(
      ["tools", "mux", "clear-resurrect", "gh_9999_nope"],
      { log: (line) => logs.push(line), error: () => {} },
    );
    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toMatch(/cleared resurrect entry/i);
  });

  test("self-destruct guard refuses apply and exits 2 when inside the target session", () => {
    const sessionName = "gh_1133_test";
    const actions = [
      {
        type: "kill_tmux_session",
        reason: "Live tmux session present; tear down without removing worktree",
        sessionName,
      },
      {
        type: "close_prx_session",
        reason: "Drop persistent prx session state (tmux-resurrect entry)",
        sessionName,
      },
    ];

    const applied: string[] = [];
    const previousTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/prx/default,1234,0";
    try {
      const exitCode = runCliDirect(
        ["prune", "session", "GH-1133"],
        { log: () => {}, error: () => {} },
        {
          buildSessionLayerPrune: (_repoPath, workUnitId) =>
            stubSessionLayerPruneResult(workUnitId, actions),
          applyParityChainActions: (summary) => {
            applied.push(...summary.actions.map((a) => a.type));
            return [];
          },
          // Simulate: caller IS the target session
          tmuxCurrentSession: () => sessionName,
        },
      );

      expect(exitCode).toBe(2);
      // apply must not execute when self-destruct guard fires
      expect(applied).toHaveLength(0);
    } finally {
      if (previousTmux !== undefined) {
        process.env.TMUX = previousTmux;
      } else {
        delete process.env.TMUX;
      }
    }
  });
});

describe("argparse — flag-after-positional (GH-1227)", () => {
  test("plan show --slot draft is accepted (parser-level regression)", () => {
    const result = runCli(["plan", "show", "GH-9999", "--slot", "draft"]);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    // No CAS blob → exit 1 with PlanRefNotFound, but the parser must NOT
    // reject `--slot` with `Unknown option`. Argparse rejection would surface
    // on stderr with a strict-mode message before runPlanShow ever fires.
    expect(stderr).not.toContain("Unknown option");
    expect(`${stdout}${stderr}`).toMatch(/no plan blob for GH-9999/);
  });

  test("plan show --slot approved is accepted", () => {
    const result = runCli(["plan", "show", "GH-9999", "--slot", "approved"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("Unknown option");
  });

  // GH-1175: --paths surfaces the staging dir + source alongside cas_root.
  test("plan show --paths --format json includes staging + staging_source", () => {
    const result = runCli(["plan", "show", "GH-9999", "--paths", "--format", "json"]);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload).toHaveProperty("cas_root");
    expect(payload).toHaveProperty("source");
    expect(payload).toHaveProperty("staging");
    expect(payload).toHaveProperty("staging_source");
    // Either env var resolves the staging dir; in CI both XDG_CACHE_HOME and
    // HOME are typically set, so staging should be a non-null absolute path.
    if (payload.staging !== null) {
      expect(typeof payload.staging).toBe("string");
      expect((payload.staging as string).endsWith("/prx/plans/staging")).toBe(true);
    }
  });

  test("plan show --paths plain text includes a staging: line", () => {
    const result = runCli(["plan", "show", "GH-9999", "--paths"]);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("cas_root:");
    expect(stdout).toContain("staging:");
    expect(stdout).toContain("staging_source:");
  });

  test("`prx <verb> --help` after a positional renders registry help (no Unknown option)", () => {
    const result = runCli(["plan", "show", "GH-9999", "--help"]);
    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("prx plan show");
    expect(stdout).toContain("domain:");
  });

  test("`prx intake bug … --help` does NOT file an intake (renders help instead)", () => {
    const result = runCli(["intake", "bug", "title goes here", "--help"]);
    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stdout).toContain("prx");
    // Must not look like an intake-file outcome.
    expect(`${stdout}${stderr}`).not.toMatch(/created|filed|opened issue/i);
  });

  test("`prx tools bd ready --limit 10` no longer requires explicit `--`", () => {
    // GH-1227: passthrough verbs auto-split — the parser must accept
    // `--limit 10` after the subcommand and forward it to bd. We can't
    // mock the bd binary at runCli granularity, but we can assert the
    // parser does not reject `--limit` with `Unknown option`.
    const result = runCli(["tools", "bd", "ready", "--limit", "10"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("Unknown option");
  });

  // GH-874: `prx tools gh` was hard-removed. The dispatch tests that used to
  // assert passthrough behavior moved to direct `execGh()` coverage in
  // test/tools/gh.test.ts. The CLI must now reject `tools gh` as an unknown
  // subcommand instead of dispatching to the (removed) passthrough.
  test("`prx tools gh ...` fails fast with Unknown tools subcommand after GH-874 removal", () => {
    const result = runCli(["tools", "gh", "issue", "view", "1227"]);
    expect(result.exitCode).not.toBe(0);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain("tools");
    expect(stderr).toContain("gh");
  });

  test("backwards compat — explicit `--` boundary still works for tools-bd", () => {
    const result = runCli(["tools", "bd", "ready", "--", "--limit", "10"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("Unknown option");
  });

  test("work --help still renders session-help (not registry help-verb)", () => {
    // Bespoke `work --help` output must keep working — the interceptor
    // skips verbs in VERBS_WITH_NATIVE_HELP.
    const result = runCli(["work", "--help"]);
    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain("prx session open");
  });
});

describe("argparse — over-positional diagnostic (GH-1229)", () => {
  test("plan load with `-- --slot draft` names tokens and hints at flag-before-positional", () => {
    const result = runCli(["plan", "load", "GH-1221", "--", "--slot", "draft"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("got 3");
    expect(stderr).toContain("GH-1221");
    expect(stderr).toContain("--slot");
    expect(stderr).toContain("draft");
    expect(stderr).toMatch(/hint:.*flags must come before the positional/);
    expect(stderr).toContain("prx plan load --slot draft GH-1221");
  });

  test("plan show with `-- --slot draft` produces the same enriched message", () => {
    const result = runCli(["plan", "show", "GH-9999", "--", "--slot", "draft"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("got 3");
    expect(stderr).toMatch(/hint:.*flags must come before the positional/);
    expect(stderr).toContain("prx plan show --slot draft GH-9999");
  });

  test("plan load with two work-unit ids names tokens but emits no flag-hint", () => {
    const result = runCli(["plan", "load", "GH-1000", "GH-2000"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("got 2");
    expect(stderr).toContain("GH-1000");
    expect(stderr).toContain("GH-2000");
    expect(stderr).not.toMatch(/hint:/);
  });

  test("regression — `plan load --slot draft GH-1221` (post-GH-1227 happy path) still parses", () => {
    const result = runCli(["plan", "load", "--slot", "draft", "GH-1221"]);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("accepts at most one");
    expect(stderr).not.toContain("Unknown option");
  });
});

// GH-2379: `prx doctor dedupe-bd --only` selector parsing.
describe("parseCommand — doctor dedupe-bd --only", () => {
  test("`--only` without `--apply` is rejected as a CliError", () => {
    expect(() => parseCommand(["doctor", "dedupe-bd", "--only", "GH-19"])).toThrow(CliError);
  });

  test("`--apply --only <value>` parses, threading a single selector", () => {
    const parsed = parseCommand(["doctor", "dedupe-bd", "--apply", "--only", "GH-19"]);
    expect(parsed.command).toBe("doctor-dedupe-bd");
    if (parsed.command !== "doctor-dedupe-bd") throw new Error("unreachable");
    expect(parsed.apply).toBe(true);
    expect(parsed.only).toEqual(["GH-19"]);
  });

  test("repeatable `--only` flags accumulate into the union", () => {
    const parsed = parseCommand([
      "doctor",
      "dedupe-bd",
      "--apply",
      "--only",
      "GH-19",
      "--only",
      "ai-home-1463",
    ]);
    if (parsed.command !== "doctor-dedupe-bd") throw new Error("unreachable");
    expect(parsed.only).toEqual(["GH-19", "ai-home-1463"]);
  });

  test("bare `dedupe-bd` (no --only) defaults `only` to []", () => {
    const parsed = parseCommand(["doctor", "dedupe-bd"]);
    if (parsed.command !== "doctor-dedupe-bd") throw new Error("unreachable");
    expect(parsed.only).toEqual([]);
    expect(parsed.apply).toBe(false);
  });
});
