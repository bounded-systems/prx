/**
 * `prx keeper` git-write handlers (GH-2348.3 / GH-2348.2).
 *
 * Keeper owns the git ref/object graph. Its push is the git-write counterpart
 * of `prx submit publish`'s push: when a provenance signer + ledger are
 * configured (`--ledger` + `PRX_PROVENANCE_KEY`), the push emits the same
 * signed SLSA `push/v1` derivation — via the git-boundary `attestingGit`
 * wrapper, which is self-describing (subject = post-push `rev-parse HEAD`) and
 * builds `GIT_PUSH_BUILD_TYPE`. This is the attestation-capable push that lets
 * `.2` move submit-publish's push to keeper without dropping the signed-push
 * guarantee (GH-2249).
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { processEnv } from "@bounded-systems/env";
import { execGit, type GitExecResult } from "@bounded-systems/git";

import {
  attestingGit,
  persistAttestation,
  WORKTREE_ADD_BUILD_TYPE,
  type AttestDeps,
} from "../provenance/attest.ts";
import type { Derivation } from "@bounded-systems/anchored-chain";

export interface KeeperPushDeps {
  /**
   * When present, the push is wrapped by `attestingGit` so a clean push emits a
   * signed `push/v1` derivation into the ledger. Absent ⇒ a bare `execGit`
   * push (no emission) — the default, identical to today's `prx keeper push`.
   */
  attest?: AttestDeps | undefined;
  /** Injectable git seam (defaults to `execGit`); tests stub it offline. */
  git?: typeof execGit | undefined;
}

/**
 * Push the work-unit branch to its remote under `role=keeper`. `args` are the
 * git push args (e.g. `["origin", "GH-456"]`). Always pushes the
 * checked-out branch's tip; `attestingGit` resolves the attested subject via
 * `rev-parse HEAD`, so the pushed branch must be the current HEAD (the
 * keeper-commit → keeper-push flow guarantees this).
 */
export async function runKeeperPush(
  args: string[],
  cwd: string | undefined,
  deps: KeeperPushDeps = {},
): Promise<GitExecResult> {
  const git = deps.git ?? execGit;
  const opts = { subcommand: "push", args, cwd, role: "keeper" as const };
  if (deps.attest) {
    return attestingGit(git, deps.attest)(opts);
  }
  return git(opts);
}

const SHA1_RE = /^[0-9a-f]{40}$/;

export class KeeperGitError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "KeeperGitError";
    this.exitCode = exitCode;
  }
}

/** Injectable git seam (defaults to `execGit`); tests stub it offline. */
export interface KeeperGitDeps {
  git?: typeof execGit | undefined;
}

/**
 * GH-2381: materialize the working state into a git TREE object under
 * `role=keeper` and return its 40-hex SHA. Keeper is the sole git-writer
 * (I-AUD4), so the producer (`prx submit stage`) routes here rather than
 * running git-write itself. `write-tree` reads the *index*, so the working-tree
 * edits a headless `prx implement` leaves behind are staged first (`add -A`,
 * itself a keeper git-write) — both run as `role=keeper` through the policy-aware
 * `execGit` seam. The tree SHA is a pure function of file contents, so staging
 * the same state twice yields the same SHA.
 */
export async function runKeeperWriteTree(
  cwd: string | undefined,
  deps: KeeperGitDeps = {},
): Promise<string> {
  const git = deps.git ?? execGit;
  const added = git({ subcommand: "add", args: ["-A"], cwd, role: "keeper" });
  if (added.exitCode !== 0) {
    throw new KeeperGitError(
      `keeper write-tree: git add -A failed (${added.exitCode}): ${added.stderr.trim()}`,
      added.exitCode,
    );
  }
  const written = git({ subcommand: "write-tree", args: [], cwd, role: "keeper" });
  if (written.exitCode !== 0) {
    throw new KeeperGitError(
      `keeper write-tree: git write-tree failed (${written.exitCode}): ${written.stderr.trim()}`,
      written.exitCode,
    );
  }
  const treeSha = written.stdout.trim();
  if (!SHA1_RE.test(treeSha)) {
    throw new KeeperGitError(`keeper write-tree: expected a 40-hex tree sha, got '${treeSha}'`);
  }
  return treeSha;
}

export interface KeeperCommitTreeInput {
  /** The tree object to wrap in a commit (the submit artifact's identity). */
  treeSha: string;
  /** Lineage parent — the resolved base commit. */
  parentSha: string;
  /** Synthetic commit message (derived from workUnitId + summary). */
  message: string;
  /**
   * ISO timestamp pinned to BOTH author and committer date so the commit SHA is
   * reproducible from (tree, parent, message, date) — the same inputs always
   * yield the same commit.
   */
  date: string;
  /**
   * Branch to point at the materialized commit and check out, so it becomes
   * HEAD before keeper pushes (`attestingGit` resolves the attested subject via
   * post-push `rev-parse HEAD`).
   */
  branch: string;
}

/**
 * GH-2381: materialize a synthetic commit from a tree artifact under
 * `role=keeper` and make it the checked-out HEAD. This is the publish-time
 * counterpart of {@link runKeeperWriteTree}: the branch + commit the v0 artifact
 * used to store are derived here instead of persisted. With pinned author/
 * committer dates the resulting commit SHA is deterministic. Returns the 40-hex
 * commit SHA, which becomes the provenance subject for the attesting push.
 */
export async function runKeeperCommitTree(
  input: KeeperCommitTreeInput,
  cwd: string | undefined,
  deps: KeeperGitDeps = {},
): Promise<string> {
  const git = deps.git ?? execGit;
  const env = {
    ...processEnv(),
    GIT_AUTHOR_DATE: input.date,
    GIT_COMMITTER_DATE: input.date,
  };
  const committed = git(
    {
      subcommand: "commit-tree",
      args: [input.treeSha, "-p", input.parentSha, "-m", input.message],
      cwd,
      role: "keeper",
    },
    env,
  );
  if (committed.exitCode !== 0) {
    throw new KeeperGitError(
      `keeper commit-tree: git commit-tree failed (${committed.exitCode}): ${committed.stderr.trim()}`,
      committed.exitCode,
    );
  }
  const commitSha = committed.stdout.trim();
  if (!SHA1_RE.test(commitSha)) {
    throw new KeeperGitError(
      `keeper commit-tree: expected a 40-hex commit sha, got '${commitSha}'`,
    );
  }
  // Point the derived branch at the materialized commit and check it out, so
  // `rev-parse HEAD` (the attested push subject) is the commit we just made.
  const switched = git({
    subcommand: "switch",
    args: ["-C", input.branch, commitSha],
    cwd,
    role: "keeper",
  });
  if (switched.exitCode !== 0) {
    const stderr = switched.stderr.trim();
    // prx-5l3: the branch is checked out in another worktree, so git refuses to
    // switch to it here. keeper must materialize + push from where its branch
    // lives (the attested push subject is `rev-parse HEAD` in that worktree), so
    // surface a clean ownership error naming the holding worktree instead of the
    // raw `is already used by worktree` git failure. (The durable elimination is
    // the salted, ephemeral, per-actor worktrees tracked in prx-g88.)
    const collision = /already used by worktree at '([^']+)'/.exec(stderr);
    if (collision) {
      throw new KeeperGitError(
        `keeper commit-tree: branch '${input.branch}' is checked out in another worktree (${collision[1]}). ` +
          `Run keeper / publish from that worktree — keeper materializes and pushes where its branch lives.`,
        switched.exitCode,
      );
    }
    throw new KeeperGitError(
      `keeper commit-tree: git switch -C ${input.branch} failed (${switched.exitCode}): ${stderr}`,
      switched.exitCode,
    );
  }
  return commitSha;
}

export interface KeeperEnsureWorktreeInput {
  /** The local branch to attach (created from `origin/main` if absent). */
  branch: string;
  /** Absolute path the worktree should live at. */
  targetPath: string;
}

export interface KeeperEnsureWorktreeResult {
  worktree_path: string;
  /** `exists` = healthy already; `created` = fresh; `recreated` = self-healed. */
  status: "exists" | "created" | "recreated";
}

/** Git seam + injectable fs probes for the worktree lifecycle (tests stub these). */
export interface KeeperEnsureWorktreeDeps extends KeeperGitDeps {
  /** Worktree health / leftover probe (defaults to `existsSync`). */
  exists?: (path: string) => boolean;
  /** Clear a leftover dir before recreate (defaults to recursive force `rmSync`). */
  remove?: (path: string) => void;
}

/**
 * prx-0yf / prx-5h0: keeper-owned `git worktree` ensure. Keeper is the sole
 * git-knower, so worktree placement + the self-heal of stale state both live
 * here rather than scattered across the workspace actor / worktree_layout.
 *
 * Self-heal is the fix for the #47 regression: a registered-but-prunable
 * worktree (working dir or its `.git` link gone) was previously treated as a
 * healthy "exists", yielding a worktree with no `.git` — launch then hit
 * "fatal: not a git repository". Here we `prune` stale registrations, detect an
 * unhealthy registration or a leftover non-worktree dir at the target, clear it,
 * and recreate a clean tree. Idempotent: a healthy worktree returns `exists`.
 */
export function runKeeperEnsureWorktree(
  input: KeeperEnsureWorktreeInput,
  cwd: string,
  deps: KeeperEnsureWorktreeDeps = {},
): KeeperEnsureWorktreeResult {
  const git = deps.git ?? execGit;
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const target = resolve(input.targetPath);

  // 1. Drop stale/prunable registrations (whose dir or .git is gone) so a
  //    broken prior materialize can be recreated rather than skipped.
  git({ subcommand: "worktree", args: ["prune"], cwd, role: "keeper" });

  // 2. Is the target a *healthy* registered worktree? (registered AND its `.git`
  //    link is present — a registered dir missing `.git` is the broken case.)
  const registered = worktreeIsRegistered(git, cwd, target);
  if (registered && exists(join(target, ".git"))) {
    return { worktree_path: target, status: "exists" };
  }

  // 3. Clear whatever is at the target so `git worktree add` recreates cleanly:
  //    deregister a broken worktree, then remove any leftover dir.
  const hadLeftover = exists(target) || registered;
  if (registered) {
    git({ subcommand: "worktree", args: ["remove", "--force", target], cwd, role: "keeper" });
  }
  if (exists(target)) {
    remove(target);
  }
  git({ subcommand: "worktree", args: ["prune"], cwd, role: "keeper" });

  // 4. Add: reuse the local branch if it exists, else cut it from origin/main.
  const branchExists =
    git({
      subcommand: "rev-parse",
      args: ["--verify", "--quiet", `refs/heads/${input.branch}`],
      cwd,
      role: "keeper",
    }).exitCode === 0;
  const addArgs = branchExists
    ? ["add", target, input.branch]
    : ["add", "-b", input.branch, target, "origin/main"];
  const added = git({ subcommand: "worktree", args: addArgs, cwd, role: "keeper" });
  if (added.exitCode !== 0) {
    throw new KeeperGitError(
      `keeper ensure-worktree: git worktree add failed for ${input.branch} (${added.exitCode}): ${added.stderr.trim()}`,
      added.exitCode,
    );
  }
  return { worktree_path: target, status: hadLeftover ? "recreated" : "created" };
}

export interface KeeperRemoveWorktreeInput {
  /** Absolute path of the worktree to remove. */
  targetPath: string;
}

export interface KeeperRemoveWorktreeResult {
  worktree_path: string;
  /** `removed` = was a registered worktree; `absent` = nothing registered. */
  status: "removed" | "absent";
}

/**
 * Keeper-owned `git worktree` removal — the symmetric counterpart of
 * {@link runKeeperEnsureWorktree}. Keeper is the sole git-knower, so tearing the
 * worktree out of the git registry (and clearing the leftover dir) lives here,
 * not in the workspace actor (which owns only the lifecycle ledger). The Claude
 * Code `WorktreeRemove` hook routes its git half through this; the ledger half
 * stays in `runTeardown`. Idempotent: an unregistered/absent target returns
 * `absent` without error.
 */
export function runKeeperRemoveWorktree(
  input: KeeperRemoveWorktreeInput,
  cwd: string,
  deps: KeeperEnsureWorktreeDeps = {},
): KeeperRemoveWorktreeResult {
  const git = deps.git ?? execGit;
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const target = resolve(input.targetPath);

  const registered = worktreeIsRegistered(git, cwd, target);
  if (registered) {
    git({ subcommand: "worktree", args: ["remove", "--force", target], cwd, role: "keeper" });
  }
  // Clear any leftover dir `git worktree remove` left behind (or a dir that was
  // never a registered worktree), then drop stale registrations.
  if (exists(target)) {
    remove(target);
  }
  git({ subcommand: "worktree", args: ["prune"], cwd, role: "keeper" });

  return { worktree_path: target, status: registered ? "removed" : "absent" };
}

export interface AttestWorktreeAddInput {
  /** The branch the worktree was placed on (the attestation subject's name). */
  branch: string;
  /** Absolute path of the materialized worktree (its HEAD is the subject). */
  targetPath: string;
  /** The base commit the branch was cut from (e.g. `origin/main`), recorded as a material. */
  baseCommit?: string | undefined;
  /** Injectable git seam (defaults to `execGit`); tests stub it offline. */
  git?: typeof execGit | undefined;
}

/**
 * prx-hc5: emit a signed `worktree-add/v1` SLSA step for a keeper-materialized
 * worktree — the provenance counterpart of {@link runKeeperPush}'s `push/v1`.
 * Keeper is the one git-knower AND the provenance signer, so the worktree
 * placement is an attestable keeper git-write like push.
 *
 * Unlike commit/push ({@link attestingGit}, self-describing via the cwd's HEAD),
 * `git worktree add` does not move the cwd's HEAD — the artifact is the NEW
 * worktree's branch tip, so the subject is DECLARED here: resolve `HEAD` in the
 * target worktree post-add. Opt-in + fail-safe: callers invoke this only when a
 * signer + ledger are configured and the placement was real (`created` /
 * `recreated`, not `exists`); a missing/malformed HEAD yields `null` (no link)
 * rather than a malformed attestation.
 */
export async function attestWorktreeAdd(
  attest: AttestDeps,
  input: AttestWorktreeAddInput,
): Promise<Derivation | null> {
  const git = input.git ?? execGit;
  const target = resolve(input.targetPath);
  const head = git({ subcommand: "rev-parse", args: ["HEAD"], cwd: target, role: "keeper" });
  const oid = head.stdout.trim();
  if (head.exitCode !== 0 || !SHA1_RE.test(oid)) return null;
  return persistAttestation(attest, {
    buildType: WORKTREE_ADD_BUILD_TYPE,
    subject: [{ name: input.branch, digest: { gitCommit: oid } }],
    ...(input.baseCommit && SHA1_RE.test(input.baseCommit)
      ? { resolvedDependencies: [{ name: "base", digest: { gitCommit: input.baseCommit } }] }
      : {}),
    externalParameters: { branch: input.branch, targetPath: target },
  });
}

/** Parse `git worktree list --porcelain` for a `worktree <target>` line. */
function worktreeIsRegistered(git: typeof execGit, cwd: string, target: string): boolean {
  const list = git({ subcommand: "worktree", args: ["list", "--porcelain"], cwd, role: "keeper" });
  if (list.exitCode !== 0) return false;
  return list.stdout
    .split("\n")
    .some(
      (line) =>
        line.startsWith("worktree ") && resolve(line.slice("worktree ".length).trim()) === target,
    );
}
