// GH-1689 — shared slug → target-mainx resolver used by `prx plan session
// --repo` (GH-1643) and `prx triage session --repo` (this issue). Extracted
// from the inline block in `primePlanSession` so both verbs error with the
// same byte-for-byte phrasing and route the same materialize call.

import { CliError } from "./cli.ts";
import {
  discoverLocalRepos,
  findRepoBySlug,
  loadRepoInventoryConfig,
  type LocalRepo,
  type RepoInventory,
  type RepoInventoryConfig,
} from "./repos.ts";
import {
  materializeBareRepo,
  type MaterializeResult,
} from "./materialize.ts";

export type ResolveTargetRepoInput = {
  /** Repo slug — matched against `name` first, then `owner/name`. */
  slug: string;
  /** Inventory + config probe cwd. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Skip the GH-1660 materialize call. Tests use this when the inventory
   * stub already points at a synthetic bare on disk.
   */
  skipMaterialize?: boolean;
};

export type ResolveTargetRepoResult = {
  /**
   * Absolute mainx-worktree path of the target. Falls back to `commonDir`
   * for bare-only inventory entries — same precedence as the original
   * `primePlanSession` block (`mainWorktree ?? commonDir`).
   */
  targetCwd: string;
  /** Inventory entry (carries name, primaryRemote, prefix). */
  repo: LocalRepo;
  /** GH-1660 materialize outcome — `null` when `skipMaterialize`. */
  materialize: MaterializeResult | null;
};

export type ResolveTargetRepoDeps = {
  loadRepoInventoryConfig?: ((cwd: string) => RepoInventoryConfig) | undefined;
  discoverLocalRepos?: ((roots: string[]) => RepoInventory) | undefined;
  findRepoBySlug?: typeof findRepoBySlug | undefined;
  materializeBareRepo?: typeof materializeBareRepo | undefined;
};

export function resolveTargetRepoCwd(
  input: ResolveTargetRepoInput,
  deps: ResolveTargetRepoDeps = {},
): ResolveTargetRepoResult {
  const cwd = input.cwd ?? process.cwd();
  const inventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(cwd);
  const inventory = (deps.discoverLocalRepos ?? discoverLocalRepos)(inventoryConfig.roots);
  const lookup = (deps.findRepoBySlug ?? findRepoBySlug)(inventory, input.slug);
  if (!lookup.ok) {
    if (lookup.error.kind === "not_registered") {
      throw new CliError(
        `Repo "${input.slug}" is not registered. Run \`prx repo add <git-url>\` to register it.`,
      );
    }
    throw new CliError(
      `Repo slug "${input.slug}" is ambiguous; candidates: ${lookup.error.candidates.join(", ")}. Pass the full owner/name.`,
    );
  }

  const materialize = input.skipMaterialize
    ? null
    : (deps.materializeBareRepo ?? materializeBareRepo)({
        name: input.slug,
        cwd,
      });

  const targetCwd = lookup.repo.mainWorktree ?? lookup.repo.commonDir;
  return { targetCwd, repo: lookup.repo, materialize };
}
