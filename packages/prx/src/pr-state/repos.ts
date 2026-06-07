import { getEnv } from "@bounded-systems/env";

function resolvedHome(): string | null {
  const h = getEnv("HOME");
  return h ? resolve(h) : null;
}
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homeDir as osHomeDir } from "@bounded-systems/host";
import { z } from "zod";
import { spawnCapture } from "@bounded-systems/proc";
import {
  hydrateAfterMaterialize,
  type HydrateResult,
} from "../beads/repo_hydrate.ts";

// GH-1657: bd workspace prefix shape — mirrors DomainAdapterConfig.domain
// (`^[a-z][a-z0-9-]*$`); inlined to avoid an import cycle with the adapters
// module.
export const WORKSPACE_PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

// GH-1703: Dolthub repo-name path segment. Dolthub enforces 3–32 chars,
// `[A-Za-z][A-Za-z0-9_-]*`. This pattern matches the *path segment*, not the
// full URL — the schema applies it to the segment after the {dolt_user}.
export const DOLTHUB_REPO_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;

// GH-1703: parse the Dolthub remote URL into {dolt_user, repo_name} so the
// schema refinement can validate just the repo-name segment.
function parseDolthubRemoteUrl(
  url: string,
): { doltUser: string; repoName: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "doltremoteapi.dolthub.com") return null;
    const segments = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
    if (segments.length !== 2) return null;
    const [doltUser, repoName] = segments;
    if (!doltUser || !repoName) return null;
    return { doltUser, repoName };
  } catch {
    return null;
  }
}

export type RepoRunner = (
  cmd: string[],
  options?: { cwd?: string; check?: boolean },
) => { stdout: string; stderr: string; status: number };

export const defaultRepoRunner: RepoRunner = (cmd, options = {}) => {
  // GH-1609: stream stdout through spawnCapture so an inventory probe (e.g.
  // `git for-each-ref` on a large repo) cannot hit Node's default 1 MiB cap
  // and surface partial bytes here. Preserves the existing throw-on-error
  // contract that downstream callers rely on.
  const result = spawnCapture(cmd, { cwd: options.cwd });

  if (result.error) {
    throw result.error;
  }

  const output = {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 0,
  };

  if (options.check !== false && output.status !== 0) {
    throw new Error(output.stderr.trim() || output.stdout.trim() || `Command failed: ${cmd.join(" ")}`);
  }

  return output;
};

export type RepoWorktree = {
  path: string;
  branch: string | null;
  current: boolean;
  kind: "standard" | "worktree";
};

export type RepoRemote = {
  name: string;
  url: string;
  githubRepo: string | null;
};

export type RepoFindingType =
  | "standard_repo"
  | "duplicate_repo_forms"
  | "orphan_branch"
  | "no_attached_worktree";

export type RepoFinding = {
  type: RepoFindingType;
  message: string;
  branch?: string;
};

export type LocalRepo = {
  name: string;
  commonDir: string;
  kind: "bare" | "standard";
  mainWorktree: string | null;
  worktrees: RepoWorktree[];
  localOnlyBranches: string[];
  findings: RepoFinding[];
  remotes: RepoRemote[];
  primaryRemote: RepoRemote | null;
  upstreamRemote: RepoRemote | null;
  /**
   * GH-1657: per-repo BD workspace prefix used by `repo_router` (GH-1659) to
   * resolve `BD-<prefix>-<tail>` → `(repo, barePath)`. Optional on read so
   * pre-GH-1657 index files migrate lazily on the next `prx repo add`.
   */
  bd_workspace_prefix?: string | undefined;
  /**
   * GH-1710: explicit triage direction for the repo.
   *   - `"gh"` (default): GitHub is the comparator for drift/stale detection,
   *     and bd records MAY mirror GH issues via `external_ref`. Note (prx-3f1):
   *     under the beads-first model (bd is the source/first layer; GitHub is an
   *     opt-in projection per the GH-1500 authority ADR), a bd record with no
   *     `external_ref` is the NORMAL, EXPECTED state — NOT a remediation orphan
   *     needing a GH backfill. The reverse-orphan axis is therefore
   *     informational only on canonical=gh repos: it is no longer projected into
   *     `triage_backlog` candidates and no longer counts toward the rate-limit
   *     sweep budget. This supersedes the earlier GH-2011 'GitHub canonical'
   *     assumption that treated bead-without-GH as actionable.
   *   - `"bd"`: bd is the source of truth — there is no GH issues queue to
   *     mirror. `prx triage status` drops the reverse-orphan + drift buckets,
   *     and `classify` proposes `bd update` mutations.
   *
   * Optional on read so pre-GH-1710 index files parse cleanly; absent → "gh"
   * via {@link repoCanonical}.
   */
  canonical?: "gh" | "bd" | undefined;
  /**
   * GH-1710: per-repo threshold (in days) for the `stale` bucket on
   * canonical=bd repos. Open beads whose `updated_at` is older than this many
   * days surface as stale. Optional on read; absent → 30 via
   * {@link repoStaleThresholdDays}.
   */
  stale_threshold_days?: number | undefined;
  /**
   * GH-1703: persisted Dolthub remote URL, populated by `prx repo add-dolthub`
   * after the bd subprocess sequence wires the remote on the workspace. Once
   * set, `prx repo audit` reads this in preference to the
   * {@link buildDoltRemoteUrl} derivation — so a non-default `--name` override
   * survives across runs. Optional on read for pre-GH-1703 inventories;
   * absent → fall back to derivation.
   */
  dolt_remote?: string | undefined;
};

/**
 * GH-1710: single read-site for the canonical-axis default. Centralizes the
 * fallback so triage code does not sprinkle `?? "gh"` across the projection.
 */
export function repoCanonical(repo: Pick<LocalRepo, "canonical">): "gh" | "bd" {
  return repo.canonical ?? "gh";
}

/**
 * GH-1710: single read-site for the stale-threshold default. Mirrors
 * {@link repoCanonical}.
 */
export function repoStaleThresholdDays(repo: Pick<LocalRepo, "stale_threshold_days">): number {
  return repo.stale_threshold_days ?? 30;
}

export type RepoInventory = {
  roots: string[];
  repos: LocalRepo[];
  bareRoot?: string | null;
  configPath?: string | null;
  indexPath?: string | null;
  generatedAt?: string;
};

// GH-1657: structural gate on the only field this ticket adds. The rest of
// LocalRepo is left permissive — this is not a refactor of the existing
// inventory boundary, just a regex check on `bd_workspace_prefix` so a
// non-conforming or non-string value cannot land in `.prx/repos/index.json`.
//
// GH-1710 adds the `canonical` and `stale_threshold_days` axes on the same
// entry; both are optional on read so pre-GH-1710 indexes continue to parse.
//
// GH-1703 adds `dolt_remote` (persisted Dolthub URL). The refinement
// validates only the repo-name path segment against
// {@link DOLTHUB_REPO_NAME_PATTERN}; the rest of the URL shape is checked
// by {@link parseDolthubRemoteUrl} so the structural gate cannot be
// bypassed by smuggling a non-Dolthub URL.
export const repoInventorySchema = z
  .object({
    repos: z
      .array(
        z
          .object({
            bd_workspace_prefix: z.string().regex(WORKSPACE_PREFIX_PATTERN).optional(),
            canonical: z.enum(["gh", "bd"]).optional(),
            stale_threshold_days: z.number().int().positive().optional(),
            dolt_remote: z
              .string()
              .url()
              .refine(
                (url) => {
                  const parsed = parseDolthubRemoteUrl(url);
                  return parsed !== null
                    && DOLTHUB_REPO_NAME_PATTERN.test(parsed.repoName);
                },
                {
                  message:
                    "dolt_remote must be a Dolthub URL with a 3–32-char repo-name path segment matching ^[A-Za-z][A-Za-z0-9_-]*$",
                },
              )
              .optional(),
          })
          .passthrough(),
      ),
  })
  .passthrough();

export type RepoNormalizationActionType =
  | "create_canonical_bare"
  | "create_attached_worktree"
  | "detach_standard_git_dir"
  | "delete_orphan_branch"
  | "report_no_attached_worktree";

export type RepoNormalizationAction = {
  type: RepoNormalizationActionType;
  repoName: string;
  repoKind: LocalRepo["kind"];
  path?: string;
  branch?: string;
  message: string;
};

export type RepoNormalizationRepo = {
  name: string;
  kind: LocalRepo["kind"];
  commonDir: string;
  canonicalBarePath: string | null;
  actions: RepoNormalizationAction[];
};

export type RepoNormalizationResult = {
  apply: boolean;
  bareRoot: string | null;
  repos: RepoNormalizationRepo[];
  actions: RepoNormalizationAction[];
};

export type RepoInventoryConfig = {
  repoRoot: string | null;
  bareRoot: string | null;
  roots: string[];
  everywhereRoots: string[];
  globalConfigPath: string | null;
  configPath: string | null;
  indexPath: string | null;
};

function defaultBareRootForHome(homeDir: string | null): string | null {
  return homeDir ? join(homeDir, ".local", "share", "git", "bare") : null;
}

function defaultRootsForHome(homeDir: string | null): string[] {
  const bareRoot = defaultBareRootForHome(homeDir);
  if (!homeDir || !bareRoot) {
    return [];
  }
  return [
    bareRoot,
    join(homeDir, ".local", "share"),
    // Modern wt path (canonical per src/tools/worktree_path.ts) — must be
    // scanned so worktrees created by `wt switch --create` and the
    // detached `mainx` produced by `prx repo add` are visible to the
    // inventory indexer. The legacy ~/.local/state/git/worktrees entry
    // below stays during transition (GH-989).
    join(homeDir, ".local", "state", "wt", "worktrees"),
    join(homeDir, ".local", "state", "git", "worktrees"),
    join(homeDir, "dev"),
    join(homeDir, "src"),
  ];
}

const ignoredDirs = new Set([
  ".git",
  "node_modules",
  ".direnv",
  ".next",
  "dist",
  "build",
  "tmp",
  ".tmp",
  "vendor",
  ".cache",
]);

function normalizeCommonDir(raw: string, cwd: string): string {
  if (isAbsolute(raw)) {
    return resolve(raw);
  }
  return resolve(cwd, raw);
}

function normalizeConfiguredPath(raw: string, repoRoot: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw);
}

function gitOutput(cmd: string[], cwd: string, runner: RepoRunner): string | null {
  const result = runner(cmd, { cwd, check: false });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function gitRepoRoot(cwd: string, runner: RepoRunner): string | null {
  const value = gitOutput(["git", "rev-parse", "--show-toplevel"], cwd, runner);
  return value ? resolve(value) : null;
}

/**
 * GH-2156: resolve the cwd's git common-dir — for a managed worktree this is
 * the bare repo directory itself (absolute on modern git), and at a repo root
 * it is a relative `.git`. Resolved against `cwd` so both forms normalize the
 * same way `normalizeCommonDir` does for inventory entries, letting
 * `localWorkspacePrefixForCwd` match a worktree onto its `entry.commonDir`.
 */
function gitCommonDir(cwd: string, runner: RepoRunner): string | null {
  const value = gitOutput(["git", "rev-parse", "--git-common-dir"], cwd, runner);
  return value ? resolve(cwd, value) : null;
}

function walkForGitEntries(root: string, maxDepth: number, entries: string[], depth = 0): void {
  if (!existsSync(root)) {
    return;
  }

  let stat;
  try {
    stat = statSync(root);
  } catch {
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  const dirents = readdirSync(root, { withFileTypes: true });
  for (const dirent of dirents) {
    const fullPath = join(root, dirent.name);
    if (dirent.name === ".git") {
      entries.push(fullPath);
      continue;
    }
    if (dirent.isDirectory() && dirent.name.endsWith(".git")) {
      entries.push(fullPath);
    }

    if (!dirent.isDirectory()) {
      continue;
    }
    if (depth >= maxDepth) {
      continue;
    }
    if (ignoredDirs.has(dirent.name)) {
      continue;
    }
    walkForGitEntries(fullPath, maxDepth, entries, depth + 1);
  }
}

function displayNameForCommonDir(commonDir: string, worktrees: RepoWorktree[]): string {
  if (worktrees.length > 0) {
    const top = basename(worktrees[0]!.path);
    if (top.length > 0) {
      return top;
    }
  }
  return basename(commonDir).replace(/\.git$/, "");
}

function repoInspectionCwd(repo: LocalRepo): string | null {
  if (repo.worktrees.length > 0) {
    return repo.worktrees[0]!.path;
  }
  if (repo.kind === "bare") {
    return repo.commonDir;
  }
  if (repo.mainWorktree) {
    return repo.mainWorktree;
  }
  return null;
}

function parseGithubRepo(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1] ?? null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return repoPath.length > 0 ? repoPath : null;
  } catch {
    return null;
  }
}

export type ParsedRepoUrl = {
  host: string;
  owner: string;
  name: string;
  fetchUrl: string;
};

// Safe path-segment characters only — prevents path traversal via owner/name/host.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(s: string): boolean {
  return SAFE_SEGMENT.test(s) && s !== "." && s !== "..";
}

export function parseRepoUrl(url: string): ParsedRepoUrl | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  // ssh: git@host:owner/repo[.git]
  const sshMatch = trimmed.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    const host = sshMatch[1]!;
    const owner = sshMatch[2]!;
    const name = sshMatch[3]!;
    if (!isSafeSegment(host) || !isSafeSegment(owner) || !isSafeSegment(name)) {
      return null;
    }
    return { host, owner, name, fetchUrl: trimmed };
  }

  // https / http / git protocol
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "git:") {
      return null;
    }
    const segments = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
    if (segments.length !== 2) {
      return null;
    }
    const owner = segments[0]!;
    const repoSegment = segments[1]!;
    const name = repoSegment.replace(/\.git$/, "");
    if (!isSafeSegment(parsed.hostname) || !isSafeSegment(owner) || !isSafeSegment(name)) {
      return null;
    }
    return { host: parsed.hostname, owner, name, fetchUrl: trimmed };
  } catch {
    return null;
  }
}

function loadRepoRemotes(cwd: string, runner: RepoRunner): RepoRemote[] {
  const remoteNames = (gitOutput(["git", "remote"], cwd, runner) ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return remoteNames
    .map((name) => {
      const url = gitOutput(["git", "remote", "get-url", name], cwd, runner);
      if (!url) {
        return null;
      }
      return {
        name,
        url,
        githubRepo: parseGithubRepo(url),
      };
    })
    .filter((remote): remote is RepoRemote => Boolean(remote))
    .sort((a, b) => {
      const aPriority = a.name === "origin" ? 0 : a.name === "upstream" ? 1 : 2;
      const bPriority = b.name === "origin" ? 0 : b.name === "upstream" ? 1 : 2;
      return aPriority - bPriority || a.name.localeCompare(b.name);
    });
}

function repoIdentityKey(repo: Pick<LocalRepo, "name" | "primaryRemote" | "commonDir">): string {
  return repo.primaryRemote?.githubRepo ?? `${repo.name}:${repo.commonDir}`;
}

function canonicalBarePathForRepo(repo: Pick<LocalRepo, "primaryRemote">, bareRoot: string | null | undefined): string | null {
  if (!bareRoot || !repo.primaryRemote?.githubRepo) {
    return null;
  }
  const [owner, name] = repo.primaryRemote.githubRepo.split("/");
  if (!owner || !name) {
    return null;
  }
  return join(bareRoot, "io.github", owner, `${name}.git`);
}

function canonicalWorktreePathForRepo(
  repo: Pick<LocalRepo, "primaryRemote">,
  branch: string,
): string | null {
  const homeDir = resolvedHome() ?? osHomeDir();
  if (!repo.primaryRemote?.githubRepo) {
    return null;
  }
  const [owner, name] = repo.primaryRemote.githubRepo.split("/");
  if (!owner || !name) {
    return null;
  }
  return join(homeDir, ".local", "state", "git", "worktrees", "io.github", owner, name, branch);
}

function uniqueBackupPath(path: string): string {
  let attempt = `${path}.prx-backup`;
  let suffix = 2;
  while (existsSync(attempt)) {
    attempt = `${path}.prx-backup-${suffix}`;
    suffix += 1;
  }
  return attempt;
}

function deleteLocalBranch(repo: LocalRepo, branch: string, runner: RepoRunner): void {
  const cwd = repo.mainWorktree ?? repo.worktrees[0]?.path ?? repo.commonDir;
  const branchDelete = runner(["git", "branch", "-D", branch], {
    cwd,
    check: false,
  });
  if (branchDelete.status === 0) {
    return;
  }

  const refCandidates = new Set<string>([
    `refs/heads/${branch}`,
  ]);
  if (branch.startsWith("heads/")) {
    refCandidates.add(`refs/heads/${branch.slice("heads/".length)}`);
  }

  for (const ref of refCandidates) {
    const deleted = runner(["git", "update-ref", "-d", ref], {
      cwd,
      check: false,
    });
    if (deleted.status === 0) {
      return;
    }
  }

  throw new Error(branchDelete.stderr.trim() || branchDelete.stdout.trim() || `Failed to delete branch ${branch}`);
}

// GH-1643: slug → registered bare-repo resolver used by `prx plan session --repo`.
// Matches name first, then primaryRemote.githubRepo (owner/name). Standard repos
// are filtered out — only bare repos in the inventory are valid targets.
export type RepoLookupError =
  | { kind: "not_registered"; slug: string }
  | { kind: "ambiguous"; slug: string; candidates: string[] };

export function findRepoBySlug(
  inventory: RepoInventory,
  slug: string,
): { ok: true; repo: LocalRepo } | { ok: false; error: RepoLookupError } {
  const bareRepos = inventory.repos.filter((repo) => repo.kind === "bare");
  const nameMatches = bareRepos.filter((repo) => repo.name === slug);
  const ownerNameMatches = bareRepos.filter(
    (repo) => repo.primaryRemote?.githubRepo === slug,
  );

  const distinctMatches = new Map<string, LocalRepo>();
  for (const repo of [...nameMatches, ...ownerNameMatches]) {
    distinctMatches.set(repo.commonDir, repo);
  }

  if (distinctMatches.size === 0) {
    return { ok: false, error: { kind: "not_registered", slug } };
  }
  if (distinctMatches.size > 1) {
    const candidates = [...distinctMatches.values()].map((repo) =>
      repo.primaryRemote?.githubRepo ?? repo.name,
    );
    return { ok: false, error: { kind: "ambiguous", slug, candidates } };
  }
  const [repo] = [...distinctMatches.values()];
  return { ok: true, repo: repo! };
}

export function loadRepoInventoryConfig(
  cwd = process.cwd(),
  runner: RepoRunner = defaultRepoRunner,
): RepoInventoryConfig {
  const homeDir = resolvedHome();
  const defaultBareRoot = defaultBareRootForHome(homeDir);
  const defaultRoots = defaultRootsForHome(homeDir);
  const globalConfigPath = homeDir ? join(homeDir, ".config", "prx", "config.json") : null;
  const globalParsed = globalConfigPath && existsSync(globalConfigPath)
    ? JSON.parse(readFileSync(globalConfigPath, "utf8")) as {
        bareRoot?: string;
        roots?: string[];
        everywhereRoots?: string[];
        indexPath?: string;
      }
    : null;
  const globalBareRoot = homeDir && typeof globalParsed?.bareRoot === "string" && globalParsed.bareRoot.trim().length > 0
    ? normalizeConfiguredPath(globalParsed.bareRoot, homeDir)
    : defaultBareRoot;
  const globalEverywhereRoots = homeDir && Array.isArray(globalParsed?.everywhereRoots) && globalParsed.everywhereRoots.length > 0
    ? globalParsed.everywhereRoots
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      .map((root) => normalizeConfiguredPath(root, homeDir))
    : [...new Set(defaultRoots.map((root) => root === defaultBareRoot && globalBareRoot ? globalBareRoot : root))];
  const globalRoots = homeDir && Array.isArray(globalParsed?.roots) && globalParsed.roots.length > 0
    ? globalParsed.roots
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      .map((root) => normalizeConfiguredPath(root, homeDir))
    : globalBareRoot ? [globalBareRoot] : [];

  // GH-2156: a foreign worktree's git-root carries no cwd-local
  // `.prx/repos/index.json` — there is one central index (the control repo's).
  // Resolve a global index pointer (global config `indexPath`, else the fixed
  // state path) so `localWorkspacePrefixForCwd` can read it from any managed
  // worktree. The cwd-local index, when present on disk, still wins and stays
  // the write target for `prx repo add`; the fallback only fires when no local
  // index file exists.
  const fixedGlobalIndexPath = homeDir
    ? join(homeDir, ".local", "state", "prx", "repos", "index.json")
    : null;
  const globalIndexPath = homeDir && typeof globalParsed?.indexPath === "string" && globalParsed.indexPath.trim().length > 0
    ? normalizeConfiguredPath(globalParsed.indexPath, homeDir)
    : fixedGlobalIndexPath;
  const withGlobalIndexFallback = (local: string | null): string | null => {
    if (local && existsSync(local)) return local;
    if (globalIndexPath && existsSync(globalIndexPath)) return globalIndexPath;
    return local;
  };

  const repoRoot = gitRepoRoot(cwd, runner);
  if (!repoRoot) {
    return {
      repoRoot: null,
      bareRoot: globalBareRoot,
      roots: globalRoots,
      everywhereRoots: globalEverywhereRoots,
      globalConfigPath,
      configPath: null,
      indexPath: withGlobalIndexFallback(null),
    };
  }

  const configPath = join(repoRoot, ".prx", "repos", "config.json");
  const indexPath = join(repoRoot, ".prx", "repos", "index.json");
  if (!existsSync(configPath)) {
    return {
      repoRoot,
      bareRoot: globalBareRoot,
      roots: globalRoots,
      everywhereRoots: globalEverywhereRoots,
      globalConfigPath,
      configPath,
      indexPath: withGlobalIndexFallback(indexPath),
    };
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
    bareRoot?: string;
    roots?: string[];
    everywhereRoots?: string[];
    indexPath?: string;
  };
  const bareRoot = typeof parsed.bareRoot === "string" && parsed.bareRoot.trim().length > 0
    ? normalizeConfiguredPath(parsed.bareRoot, repoRoot)
    : globalBareRoot;
  const everywhereRoots = Array.isArray(parsed.everywhereRoots) && parsed.everywhereRoots.length > 0
    ? parsed.everywhereRoots
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      .map((root) => normalizeConfiguredPath(root, repoRoot))
    : globalEverywhereRoots;
  const roots = Array.isArray(parsed.roots) && parsed.roots.length > 0
    ? parsed.roots
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      .map((root) => normalizeConfiguredPath(root, repoRoot))
    : globalRoots;

  return {
    repoRoot,
    bareRoot,
    roots,
    everywhereRoots,
    globalConfigPath,
    configPath,
    indexPath: withGlobalIndexFallback(
      typeof parsed.indexPath === "string" && parsed.indexPath.trim().length > 0
        ? normalizeConfiguredPath(parsed.indexPath, repoRoot)
        : indexPath,
    ),
  };
}

export function writeRepoInventoryIndex(indexPath: string, inventory: RepoInventory): void {
  // GH-1657: validate the bd_workspace_prefix field shape before persisting so
  // a malformed value cannot land in the on-disk cache the router reads.
  repoInventorySchema.parse(inventory);
  mkdirSync(dirname(indexPath), { recursive: true });
  // GH-1722: atomic tmp-write + rename so a mid-write throw (sink-side ENOSPC,
  // signal mid-flush) leaves the previous index.json byte-identical for the
  // next read. Sibling-path tmp keeps the rename on the same filesystem.
  const tmpPath = `${indexPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(inventory, null, 2)}\n`);
    renameSync(tmpPath, indexPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // best-effort: don't mask the original error
      }
    }
    throw err;
  }
}

/**
 * GH-1727: layer operator-set per-repo axes from a prior on-disk inventory
 * onto a freshly discovered one. `discoverLocalRepos` derives only what it
 * can read from disk; `canonical`, `bd_workspace_prefix`, and
 * `stale_threshold_days` live only in the index, so a naive refresh
 * (`discoverLocalRepos` → `writeRepoInventoryIndex`) silently clobbers them.
 *
 * Pure function: identical input → identical output, no I/O. The match key
 * is `commonDir`; entries in `refreshed` without a prior entry pass through
 * unchanged. New axes added to `LocalRepo` extend the helper here rather
 * than at every refresh site (single point of truth for the merge).
 */
export function preservePerRepoAxes(
  prior: RepoInventory | null,
  refreshed: RepoInventory,
): RepoInventory {
  if (!prior || prior.repos.length === 0) {
    return refreshed;
  }
  const prefixByCommonDir = new Map<string, string>();
  const canonicalByCommonDir = new Map<string, "gh" | "bd">();
  const staleByCommonDir = new Map<string, number>();
  // GH-2013: preserve the `dolt_remote` override against scanner refresh
  // (same clobber surface GH-1727 patched for the other three axes).
  const doltRemoteByCommonDir = new Map<string, string>();
  for (const repo of prior.repos) {
    if (repo.bd_workspace_prefix) {
      prefixByCommonDir.set(repo.commonDir, repo.bd_workspace_prefix);
    }
    if (repo.canonical) {
      canonicalByCommonDir.set(repo.commonDir, repo.canonical);
    }
    if (typeof repo.stale_threshold_days === "number") {
      staleByCommonDir.set(repo.commonDir, repo.stale_threshold_days);
    }
    if (repo.dolt_remote) {
      doltRemoteByCommonDir.set(repo.commonDir, repo.dolt_remote);
    }
  }
  return {
    ...refreshed,
    repos: refreshed.repos.map((repo) => {
      const prefix = prefixByCommonDir.get(repo.commonDir);
      const canonical = canonicalByCommonDir.get(repo.commonDir);
      const stale = staleByCommonDir.get(repo.commonDir);
      const doltRemote = doltRemoteByCommonDir.get(repo.commonDir);
      let next = repo;
      if (prefix) next = { ...next, bd_workspace_prefix: prefix };
      if (canonical) next = { ...next, canonical };
      if (typeof stale === "number") next = { ...next, stale_threshold_days: stale };
      if (doltRemote) next = { ...next, dolt_remote: doltRemote };
      return next;
    }),
  };
}

/**
 * GH-1657: read tolerance for `.prx/repos/index.json`. Returns `null` when the
 * file does not exist (first-time `prx repo add`). Pre-GH-1657 files (no
 * `bd_workspace_prefix` field on entries) parse cleanly — those entries fill
 * lazily on their owner's next `prx repo add`.
 */
export function loadRepoInventoryIndex(indexPath: string): RepoInventory | null {
  if (!existsSync(indexPath)) {
    return null;
  }
  const raw = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
  return repoInventorySchema.parse(raw) as unknown as RepoInventory;
}

function isAncestorOrEqual(ancestor: string, child: string): boolean {
  const a = resolve(ancestor);
  const c = resolve(child);
  if (a === c) return true;
  return c.startsWith(`${a}/`);
}

/**
 * GH-1658: index-only lookup of the BD workspace prefix covering `cwd`. The
 * source of truth is the `bd_workspace_prefix` field GH-1657 pins onto each
 * `LocalRepo` at `prx repo add` time. Used by `BdDomainAdapter` to tell a
 * local long-id from a foreign one. Returns `null` when:
 *
 *   - the index file does not exist (no prx-managed roots),
 *   - no `LocalRepo`'s `commonDir` / worktree path covers `cwd`,
 *   - the covering `LocalRepo` is pre-GH-1657 (field absent).
 *
 * No fs walk-up, no `bd` subprocess. The repo index is authoritative; a stale
 * index means the operator re-runs `prx repo add` to refresh.
 */
export function localWorkspacePrefixForCwd(
  cwd: string,
  runner: RepoRunner = defaultRepoRunner,
): string | null {
  const config = loadRepoInventoryConfig(cwd, runner);
  if (!config.indexPath) return null;
  const inventory = loadRepoInventoryIndex(config.indexPath);
  if (!inventory) return null;
  const target = resolve(cwd);
  // GH-2156: a managed worktree (under ~/.local/state/wt/...) is never an
  // ancestor of its bare repo's `commonDir` (under ~/.local/share/git/bare/...)
  // and the `worktrees[]` array is often stale/empty, so the commonDir-ancestor
  // and worktree-path arms below miss from inside a worktree. Resolve the cwd's
  // git common-dir — which IS the bare repo path — and match it directly
  // against each `entry.commonDir`. Exact, and independent of the
  // worktree-discovery state.
  const commonDir = gitCommonDir(cwd, runner);
  for (const repo of inventory.repos) {
    if (isAncestorOrEqual(repo.commonDir, target)) {
      return repo.bd_workspace_prefix ?? null;
    }
    if (commonDir && resolve(repo.commonDir) === commonDir) {
      return repo.bd_workspace_prefix ?? null;
    }
    for (const worktree of repo.worktrees) {
      if (isAncestorOrEqual(worktree.path, target)) {
        return repo.bd_workspace_prefix ?? null;
      }
    }
  }
  return null;
}

/**
 * GH-1662 — enumerate the cross-repo reconcile target set.
 *
 * Returns one entry per `LocalRepo` in the inventory that (a) is a bare repo,
 * (b) carries a `bd_workspace_prefix` (GH-1657 schema; pre-GH-1657 entries
 * are skipped — the daemon orchestrator surfaces them with a warning) and
 * (c) has a `primaryRemote.githubRepo` (OWNER/REPO) so the per-repo
 * `runBeadsSync()` pass has something to resolve `repo` to.
 *
 * Sorted by `slug` ascending so the cross-repo cursor's `nextRepoSlug` pin
 * stays stable across ticks even if the inventory file's row order shifts.
 */
export type IndexedRepoForReconcile = {
  /** Inventory `name` (matches `findRepoBySlug` first arm). */
  slug: string;
  /** `OWNER/REPO` from `primaryRemote.githubRepo`. */
  nameWithOwner: string;
  /** Absolute path of the bare repo on disk. */
  barePath: string;
  bdWorkspacePrefix: string;
};

export function listIndexedReposForReconcile(
  inventory: RepoInventory,
): IndexedRepoForReconcile[] {
  const out: IndexedRepoForReconcile[] = [];
  for (const repo of inventory.repos) {
    if (repo.kind !== "bare") continue;
    const bdWorkspacePrefix = repo.bd_workspace_prefix;
    if (typeof bdWorkspacePrefix !== "string" || bdWorkspacePrefix.length === 0) continue;
    const nameWithOwner = repo.primaryRemote?.githubRepo;
    if (typeof nameWithOwner !== "string" || nameWithOwner.length === 0) continue;
    out.push({
      slug: repo.name,
      nameWithOwner,
      barePath: repo.commonDir,
      bdWorkspacePrefix,
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

// GH-1702 — enumerate the cross-repo `prx beads sync-all` target set.
//
// Sibling of `listIndexedReposForReconcile` (GH-1662) with a different
// eligibility gate: `dolt_remote` must be set (no point fanning reconcile out
// to a repo that has no remote to push/pull against), and the on-disk
// `.beads/` layout must be ready (per-project or shared-server). Embedded
// repos (GH-1061 legacy layout) and ambiguous/none repos are surfaced with
// an explicit `skipped:` reason rather than silently dropped, so the
// per-repo result table tells the operator *why* a repo was left out.
//
// The beads-state classifier is injected so the call site can use the live
// `classifyBeadsWorkspace` and tests can hand in a deterministic fixture.
export type BeadsStateForReconcile =
  | "per_project"
  | "shared_server"
  | "embedded"
  | "none"
  | "ambiguous";

export type IndexedRepoForDoltReconcile = {
  /** Inventory `name` (matches `findRepoBySlug` first arm). */
  slug: string;
  /** `OWNER/REPO` from `primaryRemote.githubRepo`, or `null` if absent. */
  nameWithOwner: string | null;
  /** Absolute path of the bare repo on disk. */
  barePath: string;
  /** GH-1703 — persisted Dolthub remote URL. Required for eligibility. */
  doltRemote: string;
};

export type DoltReconcileCandidate =
  | { kind: "eligible"; repo: IndexedRepoForDoltReconcile }
  | { kind: "skipped"; slug: string; nameWithOwner: string | null; reason: "no-remote" | "legacy-embedded" };

export function listIndexedReposForDoltReconcile(
  inventory: RepoInventory,
  classifyBeadsState: (barePath: string) => BeadsStateForReconcile,
): DoltReconcileCandidate[] {
  const eligible: { repo: IndexedRepoForDoltReconcile; sortKey: string }[] = [];
  const skipped: {
    slug: string;
    nameWithOwner: string | null;
    reason: "no-remote" | "legacy-embedded";
    sortKey: string;
  }[] = [];

  for (const repo of inventory.repos) {
    if (repo.kind !== "bare") continue;
    const slug = repo.name;
    const nameWithOwner = repo.primaryRemote?.githubRepo ?? null;
    const doltRemote = repo.dolt_remote;

    if (typeof doltRemote !== "string" || doltRemote.length === 0) {
      skipped.push({ slug, nameWithOwner, reason: "no-remote", sortKey: slug });
      continue;
    }

    const state = classifyBeadsState(repo.commonDir);
    if (state === "per_project" || state === "shared_server") {
      eligible.push({
        repo: { slug, nameWithOwner, barePath: repo.commonDir, doltRemote },
        sortKey: slug,
      });
      continue;
    }

    // `embedded` is the GH-1061 legacy layout the AC explicitly calls out.
    // `none` / `ambiguous` are treated as `legacy-embedded` conservatively —
    // either means the repo is not safely migrated to a reconcile-able
    // layout, and the operator-facing label is identical (it points at the
    // GH-1691 migration path).
    skipped.push({ slug, nameWithOwner, reason: "legacy-embedded", sortKey: slug });
  }

  // Stable per-slug ordering across both arms so the cross-repo result table
  // is deterministic regardless of inventory file row order. Eligible repos
  // sort first (to match operator expectation in a happy-path run), then
  // skipped rows in slug order.
  eligible.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  skipped.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const out: DoltReconcileCandidate[] = [];
  for (const e of eligible) {
    out.push({ kind: "eligible", repo: e.repo });
  }
  for (const s of skipped) {
    out.push({ kind: "skipped", slug: s.slug, nameWithOwner: s.nameWithOwner, reason: s.reason });
  }
  return out;
}

export function discoverLocalRepos(
  roots: string[] = defaultRootsForHome(resolvedHome()),
  runner: RepoRunner = defaultRepoRunner,
  cwd = process.cwd(),
): RepoInventory {
  const homeDir = resolvedHome();
  const resolvedRoots = roots.length > 0 ? roots : defaultRootsForHome(homeDir);
  const candidates: string[] = [];
  for (const root of resolvedRoots) {
    walkForGitEntries(root, 6, candidates);
  }

  const repoMap = new Map<string, LocalRepo>();
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const name = basename(candidate);
    if (name === ".git") {
      const worktreePath = dirname(candidate);
      const topLevel = gitOutput(["git", "rev-parse", "--show-toplevel"], worktreePath, runner);
      const commonDirRaw = gitOutput(["git", "rev-parse", "--git-common-dir"], worktreePath, runner);
      if (!topLevel || !commonDirRaw) {
        continue;
      }
      const commonDir = normalizeCommonDir(commonDirRaw, topLevel);
      const branch = gitOutput(["git", "branch", "--show-current"], worktreePath, runner);
      const current = cwd === worktreePath || cwd.startsWith(`${worktreePath}/`);
      const existing = repoMap.get(commonDir);
      const worktree: RepoWorktree = {
        path: topLevel,
        branch,
        current,
        kind: commonDir === resolve(topLevel, ".git") ? "standard" : "worktree",
      };

      if (existing) {
        if (!existing.worktrees.some((item) => item.path === worktree.path)) {
          existing.worktrees.push(worktree);
        }
        if (worktree.kind === "standard") {
          existing.mainWorktree = worktree.path;
        }
        continue;
      }

      repoMap.set(commonDir, {
        name: displayNameForCommonDir(commonDir, [worktree]),
        commonDir,
        kind: worktree.kind === "standard" ? "standard" : "bare",
        mainWorktree: worktree.kind === "standard" ? worktree.path : null,
        worktrees: [worktree],
        localOnlyBranches: [],
        findings: [] as RepoFinding[],
        remotes: [],
        primaryRemote: null,
        upstreamRemote: null,
      });
      continue;
    }

    const isBare = gitOutput(["git", "rev-parse", "--is-bare-repository"], candidate, runner);
    if (isBare !== "true") {
      continue;
    }
    const commonDirRaw = gitOutput(["git", "rev-parse", "--git-common-dir"], candidate, runner);
    const commonDir = normalizeCommonDir(commonDirRaw ?? ".", candidate);
    const existing = repoMap.get(commonDir);
    if (existing) {
      existing.kind = "bare";
      continue;
    }
    repoMap.set(commonDir, {
      name: displayNameForCommonDir(commonDir, []),
      commonDir,
      kind: "bare",
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [] as RepoFinding[],
      remotes: [],
      primaryRemote: null,
      upstreamRemote: null,
    });
  }

  const repos = [...repoMap.values()]
    .map((repo) => {
      const inspectCwd = repoInspectionCwd(repo);
      const branchNames = inspectCwd
        ? (gitOutput(
          ["git", "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"],
          inspectCwd,
          runner,
        ) ?? "")
          .split("\n")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        : [];
      const worktreeBranches = new Set(
        repo.worktrees
          .map((worktree) => worktree.branch)
          .filter((branch): branch is string => Boolean(branch)),
      );
      const localOnlyBranches = branchNames
        .filter((branch) => !worktreeBranches.has(branch))
        .sort((a, b) => a.localeCompare(b));
      const remotes = inspectCwd ? loadRepoRemotes(inspectCwd, runner) : [];
      const primaryRemote = remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null;
      const upstreamRemote = remotes.find((remote) => remote.name === "upstream") ?? null;

      return {
        ...repo,
        localOnlyBranches,
        findings: [] as RepoFinding[],
        remotes,
        primaryRemote,
        upstreamRemote,
      };
    })
    .map((repo) => ({
      ...repo,
      worktrees: [...repo.worktrees].sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.commonDir.localeCompare(b.commonDir));

  const kindSetByIdentity = new Map<string, Set<LocalRepo["kind"]>>();
  for (const repo of repos) {
    const key = repoIdentityKey(repo);
    const kinds = kindSetByIdentity.get(key) ?? new Set<LocalRepo["kind"]>();
    kinds.add(repo.kind);
    kindSetByIdentity.set(key, kinds);
  }

  for (const repo of repos) {
    const findings: RepoFinding[] = [];
    if (repo.kind === "standard") {
      findings.push({
        type: "standard_repo",
        message: "Standard repo exists outside the bare authority model.",
      });
    }
    if ((kindSetByIdentity.get(repoIdentityKey(repo))?.size ?? 0) > 1) {
      findings.push({
        type: "duplicate_repo_forms",
        message: "Repo exists in multiple local forms (for example bare + standard).",
      });
    }
    if (repo.kind === "bare" && repo.worktrees.length === 0 && repo.localOnlyBranches.length > 0) {
      findings.push({
        type: "no_attached_worktree",
        message: "Bare repo has no attached worktrees in the current scan scope.",
      });
    }
    for (const branch of repo.localOnlyBranches) {
      findings.push({
        type: "orphan_branch",
        branch,
        message: `Local-only branch ${branch} has no attached worktree.`,
      });
    }
    repo.findings = findings;
  }

  return {
    roots: resolvedRoots.filter((root) => existsSync(root)),
    repos,
    generatedAt: new Date().toISOString(),
  };
}

export function normalizeLocalRepos(
  inventory: RepoInventory,
  options: {
    apply?: boolean;
    names?: string[];
  } = {},
  runner: RepoRunner = defaultRepoRunner,
): RepoNormalizationResult {
  const apply = options.apply ?? false;
  const selectedNames = new Set((options.names ?? []).filter((name) => name.trim().length > 0));
  const candidateRepos = inventory.repos.filter((repo) =>
    selectedNames.size === 0 ? repo.findings.length > 0 : selectedNames.has(repo.name)
  );
  const bareRoot = inventory.bareRoot ?? null;
  const canonicalBareRepos = new Set(
    inventory.repos
      .filter((repo) => repo.kind === "bare")
      .map((repo) => repo.commonDir),
  );
  const repoResults: RepoNormalizationRepo[] = [];
  const actions: RepoNormalizationAction[] = [];

  for (const repo of candidateRepos) {
    const canonicalBarePath = canonicalBarePathForRepo(repo, bareRoot);
    const singleBranchWorktreePath = repo.kind === "bare" && repo.localOnlyBranches.length === 1
      ? canonicalWorktreePathForRepo(repo, repo.localOnlyBranches[0]!)
      : null;
    const repoActions: RepoNormalizationAction[] = [];
    const shouldCreateAttachedWorktree = repo.kind === "bare"
      && repo.findings.some((finding) => finding.type === "no_attached_worktree")
      && repo.localOnlyBranches.length === 1
      && Boolean(singleBranchWorktreePath);

    if (shouldCreateAttachedWorktree) {
      const branch = repo.localOnlyBranches[0]!;
      const createWorktreeAction: RepoNormalizationAction = {
        type: "create_attached_worktree",
        repoName: repo.name,
        repoKind: repo.kind,
        branch,
        path: singleBranchWorktreePath!,
        message: `Create attached worktree for ${branch} at ${singleBranchWorktreePath!}.`,
      };
      repoActions.push(createWorktreeAction);
      actions.push(createWorktreeAction);
      if (apply) {
        mkdirSync(dirname(singleBranchWorktreePath!), { recursive: true });
        runner(["git", "worktree", "add", singleBranchWorktreePath!, branch], {
          cwd: repo.commonDir,
        });
      }
    }

    const skippedOrphanBranch = shouldCreateAttachedWorktree ? repo.localOnlyBranches[0]! : null;
    const orphanBranches = repo.findings
      .filter((finding) => finding.type === "orphan_branch" && finding.branch)
      .map((finding) => finding.branch as string);

    for (const branch of orphanBranches) {
      if (skippedOrphanBranch && branch === skippedOrphanBranch) {
        continue;
      }
      const action: RepoNormalizationAction = {
        type: "delete_orphan_branch",
        repoName: repo.name,
        repoKind: repo.kind,
        branch,
        message: `Delete orphan branch ${branch}.`,
      };
      repoActions.push(action);
      actions.push(action);
      if (apply) {
        deleteLocalBranch(repo, branch, runner);
      }
    }

    if (repo.kind === "standard" && repo.findings.some((finding) => finding.type === "standard_repo")) {
      const bareAlreadyExists = canonicalBarePath ? canonicalBareRepos.has(canonicalBarePath) || existsSync(canonicalBarePath) : false;
      if (canonicalBarePath && !bareAlreadyExists) {
        const createAction: RepoNormalizationAction = {
          type: "create_canonical_bare",
          repoName: repo.name,
          repoKind: repo.kind,
          path: canonicalBarePath,
          message: `Create canonical bare repo at ${canonicalBarePath}.`,
        };
        repoActions.push(createAction);
        actions.push(createAction);
        if (apply) {
          mkdirSync(dirname(canonicalBarePath), { recursive: true });
          runner(["git", "clone", "--bare", repo.mainWorktree ?? repo.worktrees[0]?.path ?? repo.commonDir, canonicalBarePath], {
            cwd: process.cwd(),
          });
        }
      }

      const detachAction: RepoNormalizationAction = {
        type: "detach_standard_git_dir",
        repoName: repo.name,
        repoKind: repo.kind,
        path: repo.commonDir,
        message: `Detach standard repo authority by moving ${repo.commonDir}.`,
      };
      repoActions.push(detachAction);
      actions.push(detachAction);
      if (apply) {
        renameSync(repo.commonDir, uniqueBackupPath(repo.commonDir));
      }
    }

    if (repo.kind === "bare" && repo.findings.some((finding) => finding.type === "no_attached_worktree")) {
      const reportAction: RepoNormalizationAction = {
        type: "report_no_attached_worktree",
        repoName: repo.name,
        repoKind: repo.kind,
        path: repo.commonDir,
        message: `Bare repo ${repo.commonDir} has no attached worktrees in the current scan scope.`,
      };
      repoActions.push(reportAction);
      actions.push(reportAction);
    }

    if (repoActions.length > 0) {
      repoResults.push({
        name: repo.name,
        kind: repo.kind,
        commonDir: repo.commonDir,
        canonicalBarePath,
        actions: repoActions,
      });
    }
  }

  return {
    apply,
    bareRoot,
    repos: repoResults,
    actions,
  };
}

// ---------------------------------------------------------------------------
// addLocalRepo (GH-989) — bare-clone + canonical-path register + mainx bootstrap
// ---------------------------------------------------------------------------

export type RepoAddOptions = {
  url: string;
  bareRoot: string;
  /** XDG_STATE_HOME/wt/worktrees base. */
  wtRoot: string;
  /** Operator-config root (ai-home repo) for `--overlay` scaffolding. */
  operatorConfigRoot: string | null;
  overlay: boolean;
  /**
   * GH-1657: opt-out from the `bd config get database.workspace_prefix` probe
   * in the freshly-bootstrapped mainx. When set, this value is validated and
   * used directly; `bd` is never invoked.
   */
  bdWorkspacePrefixOverride?: string | undefined;
  /**
   * GH-1710: explicit canonical axis for the new entry. Defaults to "gh" when
   * omitted — preserved as an explicit field on the persisted index entry so
   * the meaning of "absent" stays operator-visible.
   */
  canonical?: "gh" | "bd" | undefined;
};

export type RepoAddOverlayResult = {
  path: string;
  written: boolean;
  reason?: "already_exists";
};

export type RepoAddResult = {
  url: string;
  parsed: ParsedRepoUrl;
  barePath: string;
  mainxPath: string;
  defaultBranch: string;
  fetchRefspecAdded: boolean;
  overlay: RepoAddOverlayResult | null;
  /**
   * GH-1657: workspace prefix resolved from `bd config get
   * database.workspace_prefix` (or supplied via override). Always populated on
   * success; `addLocalRepo` throws if it cannot resolve a conforming value.
   */
  bdWorkspacePrefix: string;
  /**
   * GH-1710: resolved canonical axis ("gh" by default). Always populated so
   * the CLI's index-merge step has an explicit value to write.
   */
  canonical: "gh" | "bd";
  /**
   * GH-1680: outcome of `.beads/` hydrate against the freshly-bootstrapped
   * mainx worktree. Warn-and-continue: every status — including
   * `clone-failed` — is captured here rather than thrown, so a transient
   * DoltHub outage does not roll back the bare clone + mainx. Operators
   * recover via `prx repo refresh <slug>` (PR-C, GH-1681).
   */
  beadsHydrate: HydrateResult;
  /**
   * GH-1751: true when `git remote set-head origin --auto` ran. Persisting
   * `refs/remotes/origin/HEAD` locally lets {@link resolveDefaultBranch} take
   * the symref path on later operations instead of falling through to the
   * network `ls-remote --symref` probe.
   */
  originHeadSet: boolean;
};

export class RepoAddError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RepoAddError";
  }
}

/**
 * Map a hostname to the canonical `io.<short>` namespace used by the bare-clone
 * tree and the operator-config overlay. The convention (predates GH-989; see
 * `~/.local/share/git/bare/io.github/...` and `<ai-home>/.prx/repos/io.github/...`)
 * is to drop the trailing TLD label so `github.com → github`,
 * `gitlab.com → gitlab`, `gitlab.example.com → gitlab.example`. Single-label
 * hosts pass through unchanged.
 */
function canonicalHostSegment(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 1) return host;
  return labels.slice(0, -1).join(".");
}

export function canonicalBarePathFromParsed(bareRoot: string, parsed: ParsedRepoUrl): string {
  return join(bareRoot, `io.${canonicalHostSegment(parsed.host)}`, parsed.owner, `${parsed.name}.git`);
}

export function canonicalMainxPathFromParsed(wtRoot: string, parsed: ParsedRepoUrl): string {
  // Convention matches wt switch --create: {{ repo }}/{{ branch }} where
  // {{ repo }} is the bare basename (<name>.git). Owner/host are not included
  // so the path stays consistent with worktrees created by worktrunk. Cross-
  // owner collisions are possible but uncommon in operator use; reject at
  // clone time via the bare-path existence check if needed.
  return join(wtRoot, `${parsed.name}.git`, "mainx");
}

export function resolveDefaultBranch(barePath: string, runner: RepoRunner): string {
  // Preferred: HEAD symref written by `git clone` (best-effort; some repos lack it).
  const symref = runner(["git", "-C", barePath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    check: false,
  });
  if (symref.status === 0) {
    const name = symref.stdout.trim();
    if (name.startsWith("origin/")) {
      const stripped = name.slice("origin/".length);
      if (stripped.length > 0) {
        return stripped;
      }
    }
  }

  // Fallback: ask the remote directly via ls-remote (does not require the symref to be set locally).
  const lsRemote = runner(["git", "-C", barePath, "ls-remote", "--symref", "origin", "HEAD"], {
    check: false,
  });
  if (lsRemote.status === 0) {
    for (const line of lsRemote.stdout.split("\n")) {
      const match = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
      if (match) {
        return match[1]!;
      }
    }
  }

  // Last resort: probe common defaults.
  for (const candidate of ["main", "master"]) {
    const probe = runner(["git", "-C", barePath, "rev-parse", "--verify", `origin/${candidate}`], {
      check: false,
    });
    if (probe.status === 0) {
      return candidate;
    }
  }

  throw new RepoAddError(
    `Could not resolve default branch for ${barePath}. Set origin/HEAD for the remote (git remote set-head origin --auto) or ensure the remote advertises HEAD.`,
    "default_branch_unresolved",
  );
}

/**
 * GH-1736: verify that `origin/<branch>` exists as a fetched ref in the bare
 * clone. `resolveDefaultBranch` may return a name from origin/HEAD's symref or
 * `ls-remote` even when the underlying ref has never been fetched locally;
 * `git worktree add origin/<branch>` then fails with a raw-stderr `fatal:
 * invalid reference`. Calling this probe between resolution and worktree-add
 * (in `materializeMainxIfMissing`) and in `prx repo backfill --dry-run` lets
 * both paths surface the same curated `RepoAddError` with the raw stderr
 * preserved on `err.message` for operator visibility.
 */
export function verifyDefaultBranchRef(
  barePath: string,
  branch: string,
  runner: RepoRunner,
): void {
  const result = runner(
    ["git", "-C", barePath, "rev-parse", "--verify", `origin/${branch}`],
    { check: false },
  );
  if (result.status !== 0) {
    const stderr = result.stderr.trim() || `rev-parse returned status ${result.status}`;
    throw new RepoAddError(stderr, "default_branch_unresolved");
  }
}

/**
 * GH-1722: shared mainx bootstrap. `prx repo add` (forward-only) and
 * `prx repo backfill` (retroactive) both need an identically-shaped mainx
 * worktree: detached at `origin/<default>`, sibling-of-bare under the wt root.
 * Both must surface the same `default_branch_unresolved` failure mode, so the
 * sequence is centralized here. Raw `git worktree add --detach` (not `wt
 * switch --create`): mainx must be detached at origin/<default>, an ops
 * surface — wt produces a suffixed branch-attached path, wrong shape (see
 * feedback_mainx_detached).
 *
 * Idempotent: when `mainxPath` already exists on disk, returns `created:
 * false` without invoking the worktree-add. Default branch resolution still
 * runs because callers (the backfill report) want the value either way.
 */
export function materializeMainxIfMissing(
  barePath: string,
  mainxPath: string,
  runner: RepoRunner,
): { defaultBranch: string; created: boolean } {
  const defaultBranch = resolveDefaultBranch(barePath, runner);
  // GH-1736: probe the ref before `worktree add` so a bare-clone-with-symref-
  // but-no-fetch state surfaces a curated `default_branch_unresolved` error
  // instead of a raw-stderr Error from `worktree add`.
  verifyDefaultBranchRef(barePath, defaultBranch, runner);
  if (existsSync(mainxPath)) {
    return { defaultBranch, created: false };
  }
  mkdirSync(dirname(mainxPath), { recursive: true });
  runner([
    "git",
    "-C",
    barePath,
    "worktree",
    "add",
    "--detach",
    mainxPath,
    `origin/${defaultBranch}`,
  ]);
  return { defaultBranch, created: true };
}

function overlayTemplate(parsed: ParsedRepoUrl): string {
  return `# Operator config for prx when resolving ${parsed.owner}/${parsed.name} work items.
# Routed by the per-repo overlay loader: loadIdentityConfig merges this file
# over any ${parsed.name}-root prx.toml. Cross-repo operator config lives in
# ai-home, never in the upstream repo.
#
# GH-1421: declare ticket-tracker backends as [sources.<name>] blocks. Each
# block carries a \`kind\` ("github" | "notion" | "beads") and the
# \`canonical_id_pattern\` that routes ids through this source. The first
# declared source becomes the default.

# [sources.github]
# kind                  = "github"
# canonical_id_pattern  = "^GH-\\\\d+$"

# [sources.notion]
# kind                  = "notion"
# canonical_id_pattern  = "^[A-Z][A-Z0-9]+-\\\\d+$"
# auth                  = "rest"
# database_id           = ""
# id_property           = ""
# title_property        = ""
# token_op_ref          = "op://<vault>/<item>/<field>"
`;
}

function writeOverlayStub(
  operatorConfigRoot: string,
  parsed: ParsedRepoUrl,
): RepoAddOverlayResult {
  const overlayDir = join(operatorConfigRoot, ".prx", "repos", `io.${canonicalHostSegment(parsed.host)}`, parsed.owner, parsed.name);
  const overlayPath = join(overlayDir, "prx.toml");
  mkdirSync(overlayDir, { recursive: true });
  // Atomic create-if-absent: `wx` fails with EEXIST rather than an
  // existsSync→write TOCTOU window (CodeQL js/file-system-race).
  try {
    writeFileSync(overlayPath, overlayTemplate(parsed), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: overlayPath, written: false, reason: "already_exists" };
    }
    throw err;
  }
  return { path: overlayPath, written: true };
}

/**
 * GH-1657: read the per-repo BD workspace prefix from the freshly-bootstrapped
 * mainx worktree. Single deterministic source — no yaml fallback, no
 * directory-name auto-detect. If `bd` is unavailable or returns
 * empty/non-conforming output, throws a structured `RepoAddError` that points
 * the operator at `--bd-workspace-prefix <value>`.
 */
export function readBdWorkspacePrefix(mainxPath: string, runner: RepoRunner): string {
  const result = runner(
    ["bd", "config", "get", "database.workspace_prefix"],
    { cwd: mainxPath, check: false },
  );
  if (result.status !== 0) {
    throw new RepoAddError(
      `Could not resolve bd workspace prefix in ${mainxPath}: ${(result.stderr || result.stdout).trim()}. Pass --bd-workspace-prefix <value> to override.`,
      "bd_workspace_prefix_unresolved",
    );
  }
  const value = result.stdout.trim();
  if (!value) {
    throw new RepoAddError(
      `bd reported an empty database.workspace_prefix in ${mainxPath}. Pass --bd-workspace-prefix <value> to override.`,
      "bd_workspace_prefix_empty",
    );
  }
  if (!WORKSPACE_PREFIX_PATTERN.test(value)) {
    throw new RepoAddError(
      `bd workspace prefix '${value}' does not match ${WORKSPACE_PREFIX_PATTERN}. Pass --bd-workspace-prefix <value> to override.`,
      "bd_workspace_prefix_invalid_shape",
    );
  }
  return value;
}

/**
 * GH-1657: cleanup hook for `prx repo add` partial-failure paths. Removes the
 * bare clone and the bootstrapped mainx worktree if they exist. Used by the
 * uniqueness-collision branch in the `repos-add` CLI handler.
 */
export function rollbackRepoAdd(
  result: Pick<RepoAddResult, "barePath" | "mainxPath">,
): void {
  for (const path of [result.mainxPath, result.barePath]) {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export function addLocalRepo(
  options: RepoAddOptions,
  runner: RepoRunner = defaultRepoRunner,
  hydrateFn: typeof hydrateAfterMaterialize = hydrateAfterMaterialize,
): RepoAddResult {
  const parsed = parseRepoUrl(options.url);
  if (!parsed) {
    throw new RepoAddError(`Could not parse git URL: ${options.url}`, "invalid_url");
  }

  const barePath = canonicalBarePathFromParsed(options.bareRoot, parsed);
  const mainxPath = canonicalMainxPathFromParsed(options.wtRoot, parsed);

  if (existsSync(barePath)) {
    throw new RepoAddError(
      `Bare path already exists: ${barePath}. Refusing to clobber.`,
      "bare_path_exists",
    );
  }
  if (existsSync(mainxPath)) {
    throw new RepoAddError(
      `Mainx worktree path already exists: ${mainxPath}. Refusing to clobber.`,
      "mainx_path_exists",
    );
  }

  // 1. clone --bare
  mkdirSync(dirname(barePath), { recursive: true });
  runner(["git", "clone", "--bare", parsed.fetchUrl, barePath]);

  // 2. set fetch refspec (git clone --bare omits it, leaving refs/remotes/origin/* empty)
  runner([
    "git",
    "-C",
    barePath,
    "config",
    "--add",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  runner([
    "git",
    "-C",
    barePath,
    "config",
    "--add",
    "remote.origin.fetch",
    "+refs/tags/*:refs/tags/*",
  ]);
  runner([
    "git",
    "-C",
    barePath,
    "config",
    "--add",
    "remote.origin.fetch",
    "+refs/notes/*:refs/notes/*",
  ]);

  // 3. populate refs/remotes/origin/*
  runner(["git", "-C", barePath, "fetch", "origin"]);

  // 3b. GH-1751: persist `refs/remotes/origin/HEAD` locally so steady-state
  // refresh / future verbs hit the local-symref path in
  // `resolveDefaultBranch` instead of the network fallback.
  runner(["git", "-C", barePath, "remote", "set-head", "origin", "--auto"]);
  const originHeadSet = true;

  // 4. resolve default branch + bootstrap mainx detached at origin/<default>.
  // Both steps share a helper with `runRepoBackfill` (GH-1722) so the failure
  // mode (`default_branch_unresolved`) and the worktree-add shape stay in sync
  // across the forward-only and retroactive paths.
  const { defaultBranch } = materializeMainxIfMissing(barePath, mainxPath, runner);

  // 5b. Hydrate `.beads/` into the freshly-bootstrapped mainx (GH-1680). Any
  // non-success status — including `clone-failed` — is captured on the result
  // and surfaced via `formatRepoAdd` rather than thrown, so a transient
  // DoltHub outage does not roll back a successful bare + mainx
  // materialization. Operators recover via `prx repo refresh <slug>` (PR-C,
  // GH-1681). `stopBdDoltServer` is a safe no-op on a fresh mainx (no bd
  // server is running yet).
  const beadsHydrate = hydrateFn(mainxPath);

  // 6. resolve the BD workspace prefix (GH-1657). Override path skips the bd
  // subprocess entirely; without it, query `bd config get
  // database.workspace_prefix` in the mainx we just bootstrapped.
  let bdWorkspacePrefix: string;
  if (options.bdWorkspacePrefixOverride !== undefined) {
    const candidate = options.bdWorkspacePrefixOverride;
    if (!WORKSPACE_PREFIX_PATTERN.test(candidate)) {
      throw new RepoAddError(
        `--bd-workspace-prefix value '${candidate}' does not match ${WORKSPACE_PREFIX_PATTERN}.`,
        "bd_workspace_prefix_invalid_shape",
      );
    }
    bdWorkspacePrefix = candidate;
  } else {
    bdWorkspacePrefix = readBdWorkspacePrefix(mainxPath, runner);
  }

  let overlay: RepoAddOverlayResult | null = null;
  if (options.overlay) {
    if (!options.operatorConfigRoot) {
      throw new RepoAddError(
        "Overlay scaffolding requested but operator config root (ai-home repo) could not be resolved.",
        "no_operator_config_root",
      );
    }
    overlay = writeOverlayStub(options.operatorConfigRoot, parsed);
  }

  return {
    url: options.url,
    parsed,
    barePath,
    mainxPath,
    defaultBranch,
    fetchRefspecAdded: true,
    overlay,
    bdWorkspacePrefix,
    canonical: options.canonical ?? "gh",
    beadsHydrate,
    originHeadSet,
  };
}

// ---------------------------------------------------------------------------
// refreshLocalRepo (GH-1681) — operator recovery surface for transient
// hydrate failures (`clone-failed`) and legacy pre-GH-1679 bare clones whose
// fetch refspec is still heads-only. Strict superset of
// "fetch --prune + hydrate": triggers cold-mainx recovery via
// `materializeMainxIfMissing` when the mainx is missing on disk.
// ---------------------------------------------------------------------------

export type RepoRefreshOptions = {
  /** Index entry resolved by {@link findRepoBySlug}; refresh never reaches the registry itself. */
  repo: LocalRepo;
  /** XDG_STATE_HOME/wt/worktrees base — needed for cold-mainx path derivation. */
  wtRoot: string;
  /** When true, perform no writes: no refspec rewrite, no fetch, no inventory write; hydrate runs with `dryRun: true`. */
  dryRun: boolean;
  /** When true, skip the `git fetch --prune origin` network call; refspec upgrade and hydrate still run. */
  noFetch: boolean;
};

export type RepoRefreshResult = {
  slug: string;
  barePath: string;
  mainxPath: string;
  /** True when {@link materializeMainxIfMissing} created a fresh mainx worktree this run (cold-mainx recovery). */
  mainxCreated: boolean;
  /** Lines returned by `git config --get-all remote.origin.fetch` before the run. */
  refspecBefore: string[];
  /** Lines after the run (or the would-be value when `dryRun`). */
  refspecAfter: string[];
  /** True when refresh rewrote `remote.origin.fetch` to the three canonical lines. */
  refspecUpgraded: boolean;
  /** True when `git fetch --prune origin` ran. */
  fetched: boolean;
  /**
   * GH-1751: true when `git remote set-head origin --auto` ran (false under
   * `--dry-run` or `--no-fetch`, since both skip the network round-trip that
   * makes `set-head --auto` meaningful).
   */
  originHeadSet: boolean;
  beadsHydrate: HydrateResult;
  dryRun: boolean;
};

const CANONICAL_FETCH_REFSPECS: readonly string[] = [
  "+refs/heads/*:refs/remotes/origin/*",
  "+refs/tags/*:refs/tags/*",
  "+refs/notes/*:refs/notes/*",
];

/**
 * GH-1681: rehydrate a registered bare repo. Idempotent on steady-state
 * (already-broadened refspec + already-hydrated `.beads/dolt/<db>/`).
 *
 * Race note: `prx repo refresh` and the `repo_router` (GH-1659) both call
 * `hydrateAfterMaterialize`. The `already-hydrated` short-circuit
 * (hydrate.ts:428-436) returns BEFORE `stopBdDoltServer` (hydrate.ts:501),
 * so steady-state refresh never touches a running `bd dolt sql-server`. A
 * refresh that is actively re-cloning `.beads/dolt/<db>/` could race a
 * router materialize; left unlocked per the umbrella plan's stated
 * disposition (re-evaluate if reproduced).
 */
export function refreshLocalRepo(
  options: RepoRefreshOptions,
  runner: RepoRunner = defaultRepoRunner,
  hydrateFn: typeof hydrateAfterMaterialize = hydrateAfterMaterialize,
): RepoRefreshResult {
  const { repo, wtRoot, dryRun, noFetch } = options;
  const barePath = repo.commonDir;

  if (!existsSync(barePath)) {
    throw new RepoAddError(
      `Bare clone does not exist at ${barePath} for repo '${repo.name}'.`,
      "bare_path_missing",
    );
  }

  const remoteUrl = repo.primaryRemote?.url;
  const parsed = remoteUrl ? parseRepoUrl(remoteUrl) : null;
  if (!parsed) {
    throw new RepoAddError(
      `Could not parse primary remote URL for repo '${repo.name}' (${remoteUrl ?? "<none>"}).`,
      "invalid_url",
    );
  }
  const mainxPath = canonicalMainxPathFromParsed(wtRoot, parsed);

  // GH-1751: step order matters when the bare is pre-PR-A "legacy" state
  // (empty `remote.origin.fetch`, no `refs/remotes/origin/HEAD` symref,
  // never-fetched). The repair sequence must be: read+upgrade refspec →
  // fetch → set-head → materialize → hydrate. Running materialize first
  // (the old order) tripped `verifyDefaultBranchRef` on the never-fetched
  // bare and the repair never executed.

  // Read current refspec. `check: false` because `--get-all` exits non-zero
  // when the key has no entries (pre-PR-A bare with refspec scrubbed).
  const refspecRead = runner(
    ["git", "-C", barePath, "config", "--get-all", "remote.origin.fetch"],
    { check: false },
  );
  const refspecBefore = refspecRead.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Lazy refspec upgrade. Delete-all-then-add when any canonical line is
  // missing; pure idempotent no-op when all three are already present
  // (extra lines outside the canonical set are preserved by the
  // hasAllCanonical check). Matches `addLocalRepo`'s `--add` shape exactly.
  const beforeSet = new Set(refspecBefore);
  const hasAllCanonical = CANONICAL_FETCH_REFSPECS.every((line) =>
    beforeSet.has(line),
  );
  let refspecAfter: string[];
  let refspecUpgraded: boolean;
  if (hasAllCanonical) {
    refspecAfter = refspecBefore;
    refspecUpgraded = false;
  } else if (dryRun) {
    refspecAfter = [...CANONICAL_FETCH_REFSPECS];
    refspecUpgraded = true;
  } else {
    runner(
      ["git", "-C", barePath, "config", "--unset-all", "remote.origin.fetch"],
      { check: false },
    );
    for (const refspec of CANONICAL_FETCH_REFSPECS) {
      runner([
        "git",
        "-C",
        barePath,
        "config",
        "--add",
        "remote.origin.fetch",
        refspec,
      ]);
    }
    refspecAfter = [...CANONICAL_FETCH_REFSPECS];
    refspecUpgraded = true;
  }

  let fetched = false;
  if (!noFetch && !dryRun) {
    runner(["git", "-C", barePath, "fetch", "--prune", "origin"]);
    fetched = true;
  }

  // GH-1751: persist `refs/remotes/origin/HEAD` so subsequent
  // `resolveDefaultBranch` calls take the local-symref path. Gated on the
  // same conditions as fetch — `--auto` queries the remote, so without a
  // fresh fetch it is a no-op at best and a network call at worst. Skipped
  // under `--dry-run` (no writes) and `--no-fetch` (no network).
  let originHeadSet = false;
  if (!noFetch && !dryRun) {
    runner(["git", "-C", barePath, "remote", "set-head", "origin", "--auto"]);
    originHeadSet = true;
  }

  // Cold-mainx recovery. `materializeMainxIfMissing` is idempotent; on a
  // healthy refresh (mainx already on disk) it short-circuits with `created:
  // false`. Skipped in `--dry-run` to preserve the no-writes invariant.
  // Moved AFTER fetch+set-head (GH-1751) so a legacy bare's never-fetched
  // refs are populated before `verifyDefaultBranchRef` probes them.
  let mainxCreated = false;
  if (!dryRun) {
    const result = materializeMainxIfMissing(barePath, mainxPath, runner);
    mainxCreated = result.created;
  }

  // Hydrate. `hydrateAfterMaterialize` returns the `HydrateResult` as data
  // (warn-and-continue at the lib layer); `clone-failed` exit-code
  // propagation happens at the CLI handler.
  const beadsHydrate = hydrateFn(mainxPath, undefined, { dryRun });

  return {
    slug: repo.name,
    barePath,
    mainxPath,
    mainxCreated,
    refspecBefore,
    refspecAfter,
    refspecUpgraded,
    fetched,
    originHeadSet,
    beadsHydrate,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// setRepoAxis (GH-1710) — retroactive flip of `canonical` / stale-threshold
// ---------------------------------------------------------------------------

export type SetRepoAxisDelta<T> = { previous: T | undefined; current: T };

function findRepoIndexBySlug(
  inventory: RepoInventory,
  slug: string,
): number {
  return inventory.repos.findIndex(
    (repo) =>
      repo.name === slug || repo.primaryRemote?.githubRepo === slug,
  );
}

/**
 * GH-1710: flip the `canonical` field on an existing index entry. Loads via
 * `loadRepoInventoryIndex`, locates by slug (matches `name` first, then
 * `primaryRemote.githubRepo`), mutates, and persists via
 * `writeRepoInventoryIndex` so the Zod gate re-validates the shape.
 *
 * Throws {@link RepoAddError} when the index is missing or the slug does not
 * resolve. Reuses `RepoAddError` because the CLI handler already maps it to
 * `CliError`; introducing a second error class would be churn.
 */
export function setRepoCanonical(
  indexPath: string,
  slug: string,
  value: "gh" | "bd",
): SetRepoAxisDelta<"gh" | "bd"> {
  const inventory = loadRepoInventoryIndex(indexPath);
  if (!inventory) {
    throw new RepoAddError(
      `No repo inventory index at ${indexPath}. Run \`prx repo add\` first to create one.`,
      "repo_index_missing",
    );
  }
  const idx = findRepoIndexBySlug(inventory, slug);
  if (idx < 0) {
    throw new RepoAddError(
      `No repo registered with slug '${slug}' in ${indexPath}.`,
      "repo_slug_not_found",
    );
  }
  const repo = inventory.repos[idx]!;
  const previous = repo.canonical;
  // GH-2013: skip the FS write when the value already matches (no-op).
  if (previous === value) {
    return { previous, current: value };
  }
  inventory.repos[idx] = { ...repo, canonical: value };
  writeRepoInventoryIndex(indexPath, inventory);
  return { previous, current: value };
}

/**
 * GH-1710: sibling of {@link setRepoCanonical} for the stale-threshold knob.
 */
export function setRepoStaleThresholdDays(
  indexPath: string,
  slug: string,
  days: number,
): SetRepoAxisDelta<number> {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RepoAddError(
      `stale_threshold_days must be a positive integer; got ${days}.`,
      "stale_threshold_invalid",
    );
  }
  const inventory = loadRepoInventoryIndex(indexPath);
  if (!inventory) {
    throw new RepoAddError(
      `No repo inventory index at ${indexPath}. Run \`prx repo add\` first to create one.`,
      "repo_index_missing",
    );
  }
  const idx = findRepoIndexBySlug(inventory, slug);
  if (idx < 0) {
    throw new RepoAddError(
      `No repo registered with slug '${slug}' in ${indexPath}.`,
      "repo_slug_not_found",
    );
  }
  const repo = inventory.repos[idx]!;
  const previous = repo.stale_threshold_days;
  if (previous === days) {
    return { previous, current: days };
  }
  inventory.repos[idx] = { ...repo, stale_threshold_days: days };
  writeRepoInventoryIndex(indexPath, inventory);
  return { previous, current: days };
}

/**
 * GH-2013: sibling of {@link setRepoCanonical} for the bd workspace prefix
 * axis. Pre-validates against {@link WORKSPACE_PREFIX_PATTERN} so the
 * RepoAddError fires with a stable code before the Zod gate sees the value.
 */
export function setRepoBdWorkspacePrefix(
  indexPath: string,
  slug: string,
  prefix: string,
): SetRepoAxisDelta<string> {
  if (!WORKSPACE_PREFIX_PATTERN.test(prefix)) {
    throw new RepoAddError(
      `bd workspace prefix '${prefix}' does not match ${WORKSPACE_PREFIX_PATTERN}.`,
      "bd_workspace_prefix_invalid_shape",
    );
  }
  const inventory = loadRepoInventoryIndex(indexPath);
  if (!inventory) {
    throw new RepoAddError(
      `No repo inventory index at ${indexPath}. Run \`prx repo add\` first to create one.`,
      "repo_index_missing",
    );
  }
  const idx = findRepoIndexBySlug(inventory, slug);
  if (idx < 0) {
    throw new RepoAddError(
      `No repo registered with slug '${slug}' in ${indexPath}.`,
      "repo_slug_not_found",
    );
  }
  const repo = inventory.repos[idx]!;
  const previous = repo.bd_workspace_prefix;
  if (previous === prefix) {
    return { previous, current: prefix };
  }
  inventory.repos[idx] = { ...repo, bd_workspace_prefix: prefix };
  writeRepoInventoryIndex(indexPath, inventory);
  return { previous, current: prefix };
}

/**
 * GH-2013: sibling of {@link setRepoCanonical} for the `dolt_remote` axis.
 * Pre-validates the URL shape against the same Dolthub refinement used by
 * the Zod schema (parseDolthubRemoteUrl + DOLTHUB_REPO_NAME_PATTERN) so
 * the error message matches the schema gate exactly.
 */
export function setRepoDoltRemote(
  indexPath: string,
  slug: string,
  url: string,
): SetRepoAxisDelta<string> {
  const parsed = parseDolthubRemoteUrl(url);
  if (!parsed || !DOLTHUB_REPO_NAME_PATTERN.test(parsed.repoName)) {
    throw new RepoAddError(
      "dolt_remote must be a Dolthub URL with a 3–32-char repo-name path segment matching ^[A-Za-z][A-Za-z0-9_-]*$",
      "dolt_remote_invalid_shape",
    );
  }
  const inventory = loadRepoInventoryIndex(indexPath);
  if (!inventory) {
    throw new RepoAddError(
      `No repo inventory index at ${indexPath}. Run \`prx repo add\` first to create one.`,
      "repo_index_missing",
    );
  }
  const idx = findRepoIndexBySlug(inventory, slug);
  if (idx < 0) {
    throw new RepoAddError(
      `No repo registered with slug '${slug}' in ${indexPath}.`,
      "repo_slug_not_found",
    );
  }
  const repo = inventory.repos[idx]!;
  const previous = repo.dolt_remote;
  if (previous === url) {
    return { previous, current: url };
  }
  inventory.repos[idx] = { ...repo, dolt_remote: url };
  writeRepoInventoryIndex(indexPath, inventory);
  return { previous, current: url };
}

/**
 * GH-1710: index-only lookup of the `LocalRepo` covering `cwd`. Mirrors
 * {@link localWorkspacePrefixForCwd} but returns the full entry so triage
 * code can read both `canonical` and `stale_threshold_days` in one pass.
 *
 * Best-effort: a spawn failure on the underlying `git rev-parse` (e.g. `git`
 * not in PATH, common in test fixtures) is swallowed and treated as
 * "no repo registered for this cwd" — the canonical-axis branch is an
 * additive read; failing it must not knock out the triage verb entirely.
 */
export function localRepoForCwd(
  cwd: string,
  runner: RepoRunner = defaultRepoRunner,
): LocalRepo | null {
  let config: RepoInventoryConfig;
  try {
    config = loadRepoInventoryConfig(cwd, runner);
  } catch {
    return null;
  }
  if (!config.indexPath) return null;
  const inventory = loadRepoInventoryIndex(config.indexPath);
  if (!inventory) return null;
  const target = resolve(cwd);
  for (const repo of inventory.repos) {
    if (isAncestorOrEqual(repo.commonDir, target)) {
      return repo;
    }
    for (const worktree of repo.worktrees) {
      if (isAncestorOrEqual(worktree.path, target)) {
        return repo;
      }
    }
  }
  return null;
}
