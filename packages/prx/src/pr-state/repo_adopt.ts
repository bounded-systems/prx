// GH-1760: `prx repo adopt --from-worktree <path>` — read-only git
// inference + idempotent registry write into the new sqlite store.
//
// The inference layer is pure (`inferRepoFromWorktree`): it only runs
// `git rev-parse --git-common-dir`, `git remote get-url origin`,
// `git symbolic-ref refs/remotes/origin/HEAD` (with the ls-remote fallback
// from `repos.ts:resolveDefaultBranch`), and derives `repo_id` from the
// parsed URL triple. Idempotency lives in `adoptRepo`: on a re-run the
// stored row's `adopted_at` is preserved, and an origin-URL or bare-path
// mismatch on the same `repo_id` refuses with a curated `CliError`.

import { isAbsolute, resolve } from "node:path";
import { CliError } from "./cli-error.ts";
import { defaultRepoRunner, parseRepoUrl, type RepoRunner, type ParsedRepoUrl } from "./repos.ts";
import { RepositoryStore, type RepoRow } from "./registry_store.ts";

export type RepoInference = {
  repo_id: string;
  bare_path: string;
  remote_url: string;
  default_branch: string;
  parsed: ParsedRepoUrl;
};

function normalizeCommonDir(raw: string, cwd: string): string {
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(cwd, raw);
}

function runOrThrow(runner: RepoRunner, cmd: string[], cwd: string, errorMessage: string): string {
  const result = runner(cmd, { cwd, check: false });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(`${errorMessage}${detail ? `: ${detail}` : ""}`);
  }
  const out = result.stdout.trim();
  if (!out) {
    throw new CliError(`${errorMessage}: empty output`);
  }
  return out;
}

function inferDefaultBranch(worktreePath: string, runner: RepoRunner): string {
  const symref = runner(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: worktreePath,
    check: false,
  });
  if (symref.status === 0) {
    const value = symref.stdout.trim();
    if (value.startsWith("origin/")) {
      const stripped = value.slice("origin/".length);
      if (stripped.length > 0) return stripped;
    }
  }
  const lsRemote = runner(["git", "ls-remote", "--symref", "origin", "HEAD"], {
    cwd: worktreePath,
    check: false,
  });
  if (lsRemote.status === 0) {
    for (const line of lsRemote.stdout.split("\n")) {
      const match = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
      if (match) return match[1]!;
    }
  }
  throw new CliError(
    `Could not resolve origin/HEAD for ${worktreePath}. Run \`git remote set-head origin --auto\` in the bare clone, then re-run \`prx repo adopt\`.`,
  );
}

export function inferRepoFromWorktree(
  worktreePath: string,
  runner: RepoRunner = defaultRepoRunner,
): RepoInference {
  const absWorktree = resolve(worktreePath);
  const rawCommonDir = runOrThrow(
    runner,
    ["git", "rev-parse", "--git-common-dir"],
    absWorktree,
    `Not a git worktree: ${absWorktree}`,
  );
  const bare_path = normalizeCommonDir(rawCommonDir, absWorktree);

  const remote_url = runOrThrow(
    runner,
    ["git", "remote", "get-url", "origin"],
    absWorktree,
    `No \`origin\` remote in ${absWorktree}. \`prx repo adopt\` needs an origin URL to derive repo_id`,
  );
  const parsed = parseRepoUrl(remote_url);
  if (!parsed) {
    throw new CliError(
      `Could not parse origin URL '${remote_url}' for ${absWorktree}. Expected an ssh or https git URL.`,
    );
  }
  const default_branch = inferDefaultBranch(absWorktree, runner);
  const repo_id = `${parsed.host}/${parsed.owner}/${parsed.name}`;
  return { repo_id, bare_path, remote_url, default_branch, parsed };
}

export type AdoptRepoOptions = {
  worktreePath: string;
  store: RepositoryStore;
  runner?: RepoRunner;
  now?: () => Date;
};

export type AdoptRepoResult =
  | { kind: "adopted"; row: RepoRow }
  | { kind: "already-adopted"; row: RepoRow };

function sameRepoIdentity(prior: RepoRow, inferred: RepoInference): boolean {
  return prior.bare_path === inferred.bare_path && prior.remote_url === inferred.remote_url;
}

export function adoptRepo({
  worktreePath,
  store,
  runner = defaultRepoRunner,
  now = () => new Date(),
}: AdoptRepoOptions): AdoptRepoResult {
  const inferred = inferRepoFromWorktree(worktreePath, runner);
  const prior = store.getById(inferred.repo_id);

  if (prior) {
    if (!sameRepoIdentity(prior, inferred)) {
      throw new CliError(
        `repo adopt: registered entry for ${inferred.repo_id} disagrees with ${worktreePath}. ` +
          `registered bare_path=${prior.bare_path} remote_url=${prior.remote_url}; ` +
          `inferred bare_path=${inferred.bare_path} remote_url=${inferred.remote_url}. ` +
          "Refusing to silently rewrite. Re-run against the registered worktree or remove the registry entry first.",
      );
    }
    return { kind: "already-adopted", row: prior };
  }

  const row: RepoRow = {
    repo_id: inferred.repo_id,
    bare_path: inferred.bare_path,
    remote_url: inferred.remote_url,
    default_branch: inferred.default_branch,
    managed_by: "prx",
    adopted_at: now().toISOString(),
  };
  const { row: stored } = store.upsertRepo(row);
  return { kind: "adopted", row: stored };
}
