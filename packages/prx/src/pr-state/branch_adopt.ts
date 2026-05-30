// GH-1761: `prx branch adopt --from-worktree <path> [--detached-as <name>]`
// — register the current branch of an on-disk worktree in the prx registry.
// Requires the owning repo to be adopted first (BranchRow.repo_id has a FK to
// repos.repo_id).
//
// Inference is read-only (`git symbolic-ref --short HEAD` for the branch
// name, `git rev-parse HEAD` for the SHA). Detached HEAD refuses unless
// `--detached-as <name>` is supplied; the override goes through the same
// safe-name validator as the unattended path. Idempotency mirrors
// `repo_adopt`: a re-run with byte-identical name + head_sha + repo_id
// returns `already-adopted` and preserves `adopted_at`.

import { resolve } from "node:path";
import { CliError } from "./cli.ts";
import { defaultRepoRunner, type RepoRunner } from "./repos.ts";
import {
  BranchStore,
  RepositoryStore,
  type BranchRow,
} from "./registry_store.ts";
import { inferRepoFromWorktree } from "./repo_adopt.ts";

// Mirrors repos.ts SAFE_SEGMENT, but branch names allow `/` as a separator
// (e.g. `feature/foo`). Refs disallow `..`, leading `-`, etc.; this regex
// covers the operator-supplied cases without needing the full git ref ruleset.
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._\/-]+$/;

export type BranchInference = {
  name: string | null;
  head_sha: string;
};

export function inferBranchFromWorktree(
  worktreePath: string,
  runner: RepoRunner = defaultRepoRunner,
): BranchInference {
  const absWorktree = resolve(worktreePath);

  const head = runner(["git", "rev-parse", "HEAD"], { cwd: absWorktree, check: false });
  if (head.status !== 0) {
    const detail = (head.stderr || head.stdout).trim();
    throw new CliError(
      `Not a git worktree or empty HEAD: ${absWorktree}${detail ? `: ${detail}` : ""}`,
    );
  }
  const head_sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head_sha)) {
    throw new CliError(`Unexpected HEAD output for ${absWorktree}: '${head_sha}'`);
  }

  const symref = runner(
    ["git", "symbolic-ref", "--short", "HEAD"],
    { cwd: absWorktree, check: false },
  );
  if (symref.status !== 0) {
    return { name: null, head_sha };
  }
  const name = symref.stdout.trim();
  return { name: name.length > 0 ? name : null, head_sha };
}

export type AdoptBranchOptions = {
  worktreePath: string;
  repoStore: RepositoryStore;
  branchStore: BranchStore;
  runner?: RepoRunner;
  detachedAs?: string | null;
  now?: () => Date;
};

export type AdoptBranchResult =
  | { kind: "adopted"; row: BranchRow }
  | { kind: "already-adopted"; row: BranchRow };

export function adoptBranch({
  worktreePath,
  repoStore,
  branchStore,
  runner = defaultRepoRunner,
  detachedAs = null,
  now = () => new Date(),
}: AdoptBranchOptions): AdoptBranchResult {
  const repoInferred = inferRepoFromWorktree(worktreePath, runner);
  const repoRow = repoStore.getById(repoInferred.repo_id);
  if (!repoRow) {
    throw new CliError(
      `branch adopt: repo ${repoInferred.repo_id} is not in the registry yet. ` +
        `Run \`prx repo adopt --from-worktree ${worktreePath}\` first.`,
    );
  }

  const branchInferred = inferBranchFromWorktree(worktreePath, runner);

  let name: string;
  if (branchInferred.name) {
    name = branchInferred.name;
  } else if (detachedAs) {
    if (!SAFE_BRANCH_NAME.test(detachedAs)) {
      throw new CliError(
        `branch adopt: --detached-as '${detachedAs}' must match ${SAFE_BRANCH_NAME}.`,
      );
    }
    name = detachedAs;
  } else {
    throw new CliError(
      `detached HEAD has no branch to adopt. Either:\n` +
        `  - \`git switch -c <name>\` to create a branch first, then re-run\n` +
        `  - \`prx branch adopt --from-worktree ${worktreePath} --detached-as <name>\` to register\n` +
        `    the current commit under <name>`,
    );
  }

  const branch_id = `${repoRow.repo_id}:${name}`;
  const prior = branchStore.getById(branch_id);
  if (prior) {
    const sameIdentity = prior.repo_id === repoRow.repo_id
      && prior.name === name
      && prior.head_sha === branchInferred.head_sha;
    if (sameIdentity) {
      return { kind: "already-adopted", row: prior };
    }
    // head_sha drift is allowed — re-adopt with the new SHA but preserve
    // adopted_at so the registry retains its original adoption timestamp.
    const refreshed: BranchRow = {
      ...prior,
      head_sha: branchInferred.head_sha,
    };
    const { row } = branchStore.upsertBranch(refreshed);
    return { kind: "adopted", row };
  }

  const row: BranchRow = {
    branch_id,
    repo_id: repoRow.repo_id,
    name,
    head_sha: branchInferred.head_sha,
    purpose: "scratch",
    state: "active",
    adopted_at: now().toISOString(),
  };
  const { row: stored } = branchStore.upsertBranch(row);
  return { kind: "adopted", row: stored };
}
