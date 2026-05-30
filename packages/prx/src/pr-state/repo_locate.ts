// GH-1704 — shared slug-or-cwd repo locator.
//
// Lifted out of `repo_add_dolthub.ts` so the new `repo_bootstrap.ts` verb can
// share the same lookup shape. Pure refactor: behaviour matches the original
// (slug branch first, cwd inference second, ambiguity reported with the
// owner/name candidates).

import {
  findRepoBySlug,
  type LocalRepo,
  type RepoInventory,
} from "./repos.ts";

export type RepoLocateOptions = {
  /** Positional slug (or null → derive from cwd). */
  slug: string | null;
  /** Fallback cwd when slug is null. */
  cwd?: string | undefined;
};

export type RepoLocateResult =
  | { kind: "found"; repo: LocalRepo; index: number }
  | { kind: "not_found"; detail: string };

export function locateRepo(
  inventory: RepoInventory,
  opts: RepoLocateOptions,
): RepoLocateResult {
  if (opts.slug && opts.slug.length > 0) {
    const lookup = findRepoBySlug(inventory, opts.slug);
    if (!lookup.ok) {
      if (lookup.error.kind === "ambiguous") {
        return {
          kind: "not_found",
          detail: `Slug '${opts.slug}' is ambiguous; matches: ${lookup.error.candidates.join(", ")}. Pass the owner/name form to disambiguate.`,
        };
      }
      return {
        kind: "not_found",
        detail: `No repo registered with slug '${opts.slug}'. Run \`prx repo add\` first, or run \`prx repo list\` to see registered slugs.`,
      };
    }
    const idx = inventory.repos.findIndex((r) => r.commonDir === lookup.repo.commonDir);
    return { kind: "found", repo: lookup.repo, index: idx };
  }
  const cwd = opts.cwd;
  if (!cwd) {
    return {
      kind: "not_found",
      detail: "No <slug> positional and no cwd to derive one from. Pass an explicit slug.",
    };
  }
  for (let i = 0; i < inventory.repos.length; i += 1) {
    const repo = inventory.repos[i]!;
    if (cwd === repo.commonDir || cwd.startsWith(`${repo.commonDir}/`)) {
      return { kind: "found", repo, index: i };
    }
    for (const wt of repo.worktrees) {
      if (cwd === wt.path || cwd.startsWith(`${wt.path}/`)) {
        return { kind: "found", repo, index: i };
      }
    }
  }
  return {
    kind: "not_found",
    detail: `Could not infer slug from cwd ${cwd}; no inventory entry covers it. Pass an explicit slug positional.`,
  };
}
