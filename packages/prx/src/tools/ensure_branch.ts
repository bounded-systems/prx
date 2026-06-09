/**
 * ensure-branch — idempotently create a remote branch from a base ref.
 *
 * Invoked by the workspace reserve/materialize path (prx-arl — formerly also
 * `prx tools wt ensure-branch <name>` from worktrunk's pre-switch hook).
 * Semantics:
 *
 *   - no-op, exit 0, when <name> already exists as refs/heads/<name> locally
 *   - no-op, exit 0, when <name> already exists as refs/remotes/<any>/<name>
 *   - no-op, exit 0, when <name> is in the skip list
 *   - otherwise: resolve <base> (default origin/main) to <remote>/<ref>,
 *     fetch once if needed, then push <base> to refs/heads/<name> on <remote>
 *
 * Best-effort: push failure is reported but the caller (the CLI dispatcher)
 * still exits 0 so the pre-switch hook cannot turn a real wt-switch failure
 * into a hook failure.
 *
 * Read-only git operations go through execGit from ./git.ts (policy-enforced).
 * The push itself uses spawnCapture directly (GH-1609), matching the existing
 * convention for prx-internal git writes (see src/pr-state/github.ts); the
 * tool-policy layer is intended for agent-facing calls, not for this narrow
 * bootstrap op.
 */

import { spawnCapture } from "@bounded-systems/proc";
import { execGit } from "@bounded-systems/git";

export const DEFAULT_BASE = "origin/main";
export const DEFAULT_SKIP_BRANCHES = ["main", "master", "trunk", "develop", "HEAD"] as const;

export type EnsureBranchStatus =
  | "exists-local"
  | "exists-remote"
  | "skipped"
  | "created"
  | "base-unresolved"
  | "error";

/**
 * Spawn function signature compatible with both a node child-spawn and the
 * callers in src/pr-state/cli.ts that thread a test-injected SpawnLike
 * through the materialize flow.
 */
export type EnsureBranchSpawnLike = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8" },
) => {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

export type EnsureBranchOptions = {
  name: string;
  base?: string | undefined;
  skip?: readonly string[] | undefined;
  cwd?: string | undefined;
  /**
   * Create the branch ref locally only — `git branch <name> <base>`
   * instead of `git push <remote> <base>:refs/heads/<name>`. Base
   * resolution still runs (so `base-unresolved` is still detected), but
   * nothing is pushed to the remote. Used by ephemeral session-open
   * (intake/triage) whose branches must never reach GitHub origin
   * (ai-home-rkg1w.1 §3.5 / GH-2271). The worktrunk pre-switch hook
   * leaves this false and keeps publishing the remote branch ref.
   */
  localOnly?: boolean | undefined;
  /** Optional spawn injector for tests. Defaults to the @bounded-systems/proc spawn. */
  spawn?: EnsureBranchSpawnLike | undefined;
};

export type EnsureBranchResult = {
  status: EnsureBranchStatus;
  branch: string;
  base: string;
  remote: string | null;
  created: boolean;
  message?: string;
};

function splitBase(base: string): { remote: string; ref: string } | null {
  const slashIdx = base.indexOf("/");
  if (slashIdx <= 0 || slashIdx >= base.length - 1) return null;
  return { remote: base.slice(0, slashIdx), ref: base.slice(slashIdx + 1) };
}

type GitResult = { exitCode: number; stdout: string; stderr: string };

function runGit(
  spawn: EnsureBranchSpawnLike | undefined,
  subcommand: string,
  args: readonly string[],
  cwd: string,
): GitResult {
  if (spawn) {
    const r = spawn("git", ["-C", cwd, subcommand, ...args], { cwd, encoding: "utf8" });
    return {
      exitCode: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }
  const r = execGit({ subcommand, args: [...args], cwd });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

export function ensureBranch(opts: EnsureBranchOptions): EnsureBranchResult {
  const branch = opts.name;
  const base = opts.base ?? DEFAULT_BASE;
  const cwd = opts.cwd ?? process.cwd();
  const skip = opts.skip ?? DEFAULT_SKIP_BRANCHES;
  const spawn = opts.spawn;
  const localOnly = opts.localOnly ?? false;

  const parts = splitBase(base);
  if (!parts) {
    return {
      status: "error",
      branch,
      base,
      remote: null,
      created: false,
      message: `invalid --base '${base}', expected <remote>/<ref>`,
    };
  }
  const { remote, ref: baseRef } = parts;

  if (skip.includes(branch)) {
    return { status: "skipped", branch, base, remote, created: false };
  }

  const local = runGit(spawn, "rev-parse", ["--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (local.exitCode === 0) {
    return { status: "exists-local", branch, base, remote, created: false };
  }

  const remoteList = runGit(spawn, "branch", ["-r", "--list", `*/${branch}`], cwd);
  if (remoteList.exitCode === 0 && remoteList.stdout.trim().length > 0) {
    return { status: "exists-remote", branch, base, remote, created: false };
  }

  const baseCheck = runGit(spawn, "rev-parse", ["--verify", "--quiet", base], cwd);
  if (baseCheck.exitCode !== 0) {
    const fetch = runGit(spawn, "fetch", [remote, baseRef], cwd);
    if (fetch.exitCode !== 0) {
      return {
        status: "base-unresolved",
        branch,
        base,
        remote,
        created: false,
        message: fetch.stderr.trim() || `fetch ${remote} ${baseRef} failed`,
      };
    }
    const recheck = runGit(spawn, "rev-parse", ["--verify", "--quiet", base], cwd);
    if (recheck.exitCode !== 0) {
      return {
        status: "base-unresolved",
        branch,
        base,
        remote,
        created: false,
        message: `base '${base}' still unresolvable after fetch`,
      };
    }
  }

  if (localOnly) {
    // Local-only: create the branch ref without pushing. `git branch
    // <name> <base>` resolves the (already-verified) base to a commit
    // and writes refs/heads/<name> — no network, no remote pollution.
    const create = runGit(spawn, "branch", [branch, base], cwd);
    if (create.exitCode !== 0) {
      return {
        status: "error",
        branch,
        base,
        remote,
        created: false,
        message: create.stderr.trim() || `git branch exited ${create.exitCode}`,
      };
    }
    return { status: "created", branch, base, remote, created: true };
  }

  const push = spawn
    ? spawn("git", ["-C", cwd, "push", remote, `${base}:refs/heads/${branch}`], { cwd, encoding: "utf8" })
    : spawnCapture(["git", "-C", cwd, "push", remote, `${base}:refs/heads/${branch}`]);
  if ((push.status ?? 1) !== 0) {
    return {
      status: "error",
      branch,
      base,
      remote,
      created: false,
      message: (push.stderr ?? "").toString().trim() || `git push exited ${push.status ?? "?"}`,
    };
  }

  return { status: "created", branch, base, remote, created: true };
}

export function formatEnsureBranchResult(
  result: EnsureBranchResult,
  format: "plain" | "json",
): string {
  if (format === "json") return JSON.stringify(result, null, 2);

  const tag =
    result.status === "created" ? "created" :
    result.status === "exists-local" ? "ok (local)" :
    result.status === "exists-remote" ? "ok (remote)" :
    result.status === "skipped" ? "skipped" :
    result.status === "base-unresolved" ? "base-unresolved" :
    "error";

  let line = `${tag}: ${result.branch}`;
  if (result.status === "created") line += ` from ${result.base}`;
  if (result.message) line += ` — ${result.message}`;
  return line;
}
