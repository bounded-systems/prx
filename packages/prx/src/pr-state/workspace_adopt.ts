// GH-1762: `prx workspace adopt [<path>] [--mode read|write] [--detached-as <name>]`
// — register an on-disk worktree in the prx-wide sqlite registry. Closes the
// registry chain (`repos → branches → workspaces`) and produces the
// `workspace_id` every downstream adopt-flow verb (`lease acquire`,
// `reconcile`, `status`) will key off.
//
// Auto-chains `repo adopt` + `branch adopt` so the operator can run the verb
// against a fresh worktree without a manual three-step dance — both upstream
// verbs are idempotent, so re-running through the chain is safe. Idempotency
// here mirrors `branch_adopt`: a re-run with byte-identical identity
// (repo_id, branch_id, path, mode, backend) is `already-adopted` and
// preserves `adopted_at`; only `dirty` is allowed to drift on re-adopt.

import { resolve } from "node:path";
import { CliError } from "./cli.ts";
import { defaultRepoRunner, type RepoRunner } from "./repos.ts";
import {
  BranchStore,
  RepositoryStore,
  WorkspaceStore,
  type WorkspaceRow,
} from "./registry_store.ts";
import { adoptRepo, type AdoptRepoResult } from "./repo_adopt.ts";
import { adoptBranch, type AdoptBranchResult } from "./branch_adopt.ts";

export type WorkspaceInference = {
  path: string;
  dirty: boolean;
};

export function inferWorkspaceFromWorktree(
  worktreePath: string,
  runner: RepoRunner = defaultRepoRunner,
): WorkspaceInference {
  const absWorktree = resolve(worktreePath);
  // Inlined from `defaultGitStatusClean` in `repo_bootstrap.ts:152-160` —
  // kept self-contained here to follow the precedent of `branch_adopt.ts`
  // not depending on `repo_audit.ts` for unrelated probes.
  const result = runner(["git", "-C", absWorktree, "status", "--porcelain"], { check: false });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(
      `Could not read git status for ${absWorktree}${detail ? `: ${detail}` : ""}`,
    );
  }
  const dirty = result.stdout.trim().length > 0;
  return { path: absWorktree, dirty };
}

export type AdoptChain = {
  repo: AdoptRepoResult;
  branch: AdoptBranchResult;
};

export type AdoptWorkspaceOptions = {
  worktreePath: string;
  repoStore: RepositoryStore;
  branchStore: BranchStore;
  workspaceStore: WorkspaceStore;
  runner?: RepoRunner;
  mode?: "read" | "write";
  detachedAs?: string | null;
  now?: () => Date;
};

export type AdoptWorkspaceResult =
  | { kind: "adopted"; row: WorkspaceRow; chain: AdoptChain }
  | { kind: "already-adopted"; row: WorkspaceRow; chain: AdoptChain };

export function adoptWorkspace({
  worktreePath,
  repoStore,
  branchStore,
  workspaceStore,
  runner = defaultRepoRunner,
  mode = "write",
  detachedAs = null,
  now = () => new Date(),
}: AdoptWorkspaceOptions): AdoptWorkspaceResult {
  const repo = adoptRepo({ worktreePath, store: repoStore, runner, now });
  const branch = adoptBranch({
    worktreePath,
    repoStore,
    branchStore,
    runner,
    detachedAs,
    now,
  });
  const chain: AdoptChain = { repo, branch };

  const inferred = inferWorkspaceFromWorktree(worktreePath, runner);
  const workspace_id = branch.row.branch_id;
  const prior = workspaceStore.getById(workspace_id);

  if (prior) {
    const sameIdentity = prior.path === inferred.path
      && prior.repo_id === repo.row.repo_id
      && prior.branch_id === branch.row.branch_id
      && prior.mode === mode
      && prior.backend === "git-worktree";
    if (!sameIdentity) {
      throw new CliError(
        `workspace adopt: registered entry for ${workspace_id} disagrees with ${worktreePath}. ` +
          `registered path=${prior.path} mode=${prior.mode} backend=${prior.backend}; ` +
          `inferred path=${inferred.path} mode=${mode} backend=git-worktree. ` +
          "Refusing to silently rewrite. Re-run against the registered path or remove the registry entry first.",
      );
    }
    // dirty is allowed to drift on re-adopt — preserve adopted_at.
    const refreshed: WorkspaceRow = { ...prior, dirty: inferred.dirty };
    const { row } = workspaceStore.upsertWorkspace(refreshed);
    return { kind: "already-adopted", row, chain };
  }

  const row: WorkspaceRow = {
    workspace_id,
    repo_id: repo.row.repo_id,
    branch_id: branch.row.branch_id,
    path: inferred.path,
    backend: "git-worktree",
    state: "ready",
    mode,
    dirty: inferred.dirty,
    adopted_at: now().toISOString(),
  };
  const { row: stored } = workspaceStore.upsertWorkspace(row);
  return { kind: "adopted", row: stored, chain };
}
