// ai-home-mqlno — the read-only git capability (envelope-first).
//
// Surfaces (git/bd/fs) must be ocap-gated, not granted ambiently. Read-only
// actors (plan, author) need `git log/diff/show` to compose plans/PR bodies but
// must NOT get ambient `prx tools git` (which can mutate). This module is the
// *envelope*: a deny-by-default contract that admits only purely-read git
// subcommands and runs them through an injected runner PORT (the real
// `execGit` from `@bounded-systems/git` satisfies the port later, when this is
// wired as a dispatch target). Tested by mocking the port — no real git needed.
//
// The contract is the allowlist: any subcommand not on it is rejected, so a new
// or flag-dependent-mutating subcommand defaults to denied (e.g. `commit`,
// `push`, `checkout`, `reset`, `branch`, `config` — all rejected).

/**
 * Subcommands that only READ the repository — safe regardless of flags. Kept
 * conservative; flag-dependent-mutating verbs (branch/tag/remote/config/
 * symbolic-ref) are intentionally excluded.
 */
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "diff",
  "show",
  "status",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "cat-file",
  "describe",
  "shortlog",
  "merge-base",
  "name-rev",
  "grep",
  "reflog",
  "whatchanged",
]);

export function isReadOnlyGitSubcommand(subcommand: string): boolean {
  return READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/** Result shape of the git runner (compatible with `execGit`). */
export interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The runner PORT — the real `execGit({subcommand,args,cwd})` satisfies it. */
export type GitReadRunner = (req: {
  subcommand: string;
  args: string[];
  cwd: string;
}) => GitRunResult;

export interface GitReadInput {
  subcommand: string;
  args?: string[];
  cwd: string;
  runner: GitReadRunner;
}

export type GitReadResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "not_read_only" | "exec_failed"; detail: string };

/**
 * Run a read-only git subcommand. Rejects (without invoking the runner) any
 * subcommand not on the read-only allowlist — the capability's whole point is
 * that it can never mutate the repo, so a read-only actor can hold it safely.
 */
export function runGitRead(input: GitReadInput): GitReadResult {
  if (!isReadOnlyGitSubcommand(input.subcommand)) {
    return {
      ok: false,
      reason: "not_read_only",
      detail:
        `git ${input.subcommand} is not a read-only subcommand — the read ` +
        `capability admits only: ${[...READ_ONLY_GIT_SUBCOMMANDS].join(", ")}`,
    };
  }
  const result = input.runner({
    subcommand: input.subcommand,
    args: input.args ?? [],
    cwd: input.cwd,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "exec_failed",
      detail: `git ${input.subcommand} exited ${result.status}: ${result.stderr.trim()}`,
    };
  }
  return { ok: true, stdout: result.stdout };
}
