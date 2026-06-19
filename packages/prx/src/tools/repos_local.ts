/**
 * Local git repository discovery — scans a filesystem root for working
 * tree and bare repo roots. Replaces scripts/git_local_repos.sh (the
 * snake-case ai-home copy) and ~/.config/home-manager/scripts/git-local-repos.sh
 * (the kebab-case home-manager-local copy, canonical).
 *
 * Distinct from `prx repos` (bare-inventory listing sourced from the
 * .prx/repos/index.json): this command walks the FS to find working trees
 * *and* bare repos wherever they live under a scan root.
 */

import path from "node:path";

import { localProcExecutor } from "@bounded-systems/proc";

const proc = localProcExecutor();

const DEFAULT_PRUNE_SUBDIRS = [
  "Library",
  ".cache",
  ".Trash",
  ".local/share/Trash",
  ".npm",
  ".pnpm-store",
  ".cargo/registry",
  ".cargo/git",
] as const;

export type LocalReposOptions = {
  scanHome: string;
  strict: boolean;
};

export type LocalReposResult = {
  scanHome: string;
  strict: boolean;
  repos: string[];
  count: number;
};

function buildFindArgs(opts: LocalReposOptions): string[] {
  const args: string[] = [opts.scanHome];
  if (!opts.strict) {
    args.push("(");
    for (let i = 0; i < DEFAULT_PRUNE_SUBDIRS.length; i++) {
      if (i > 0) args.push("-o");
      args.push("-path", path.join(opts.scanHome, DEFAULT_PRUNE_SUBDIRS[i]!));
    }
    args.push(")", "-prune", "-o");
  }
  args.push(
    "(",
    "-type",
    "d",
    "-name",
    ".git",
    "-o",
    "-type",
    "f",
    "-name",
    ".git",
    ")",
    "-print0",
  );
  return args;
}

async function runGit(candidate: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const r = await proc.exec({
    command: "git",
    args: ["--no-pager", "-C", candidate, ...args],
  });
  return { ok: r.status === 0, stdout: r.stdout.trim() };
}

async function resolveRepoRoot(candidate: string): Promise<string | null> {
  const workTree = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
  if (workTree.ok && workTree.stdout.length > 0) return workTree.stdout;

  const bareCheck = await runGit(candidate, ["rev-parse", "--is-bare-repository"]);
  if (bareCheck.ok && bareCheck.stdout === "true") {
    const dir = await runGit(candidate, ["rev-parse", "--absolute-git-dir"]);
    if (dir.ok && dir.stdout.length > 0) return dir.stdout;
  }
  return null;
}

export async function discoverLocalGitRepos(opts: LocalReposOptions): Promise<LocalReposResult> {
  const find = await proc.exec({ command: "find", args: buildFindArgs(opts) });

  const candidates = find.stdout
    .split("\0")
    .map((gitPath) => (gitPath ? path.dirname(gitPath) : ""))
    .filter((candidate) => candidate.length > 0);

  const seen = new Set<string>();
  const repos: string[] = [];
  for (const candidate of candidates) {
    const root = await resolveRepoRoot(candidate);
    if (!root) continue;
    if (root.includes("/.git/")) continue;
    if (seen.has(root)) continue;
    seen.add(root);
    repos.push(root);
  }
  repos.sort();

  return {
    scanHome: opts.scanHome,
    strict: opts.strict,
    repos,
    count: repos.length,
  };
}

export function formatLocalReposResult(
  result: LocalReposResult,
  format: "plain" | "json",
  countOnly: boolean,
): string {
  if (format === "json") {
    return JSON.stringify(countOnly ? { count: result.count } : result);
  }
  if (countOnly) return String(result.count);
  return result.repos.join("\n");
}
