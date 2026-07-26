// GH-1704 — `prx repo bootstrap`: originally bootstrapped a fresh per-project
// `.beads/` workspace on a registered, beads-less repo (via `bd init`), then
// auto-chained `prx repo add-dolthub`.
//
// GH-1012 — the bd/beads write-plane has been removed. GitHub issues are now
// the write plane and Front Desk the read plane; there is no per-project bd
// workspace to bootstrap. The verb is retained (so the `prx repo bootstrap`
// CLI surface and its result/formatter types stay stable), but the bd machinery
// (`bd init`, workspace classification, HOME-isolation, ship-metadata PR flow,
// dolthub auto-chain) is gone. The handler now performs the non-bd inventory /
// locate / worktree / prefix validation and then refuses, pointing the operator
// at the GitHub + Front Desk planes.

import {
  loadRepoInventoryIndex as defaultLoadRepoInventoryIndex,
  WORKSPACE_PREFIX_PATTERN,
  type LocalRepo,
  type RepoInventoryConfig,
} from "./repos.ts";
import { locateRepo } from "./repo_locate.ts";
import { type AddDolthubRefusalReason } from "./repo_add_dolthub.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export type RepoBootstrapOptions = {
  /** Resolved by the executor via `loadRepoInventoryConfig(cwd)`. */
  config: RepoInventoryConfig;
  /** Optional positional slug; null → derive from cwd. */
  slug: string | null;
  /** `--prefix` override; null → derive from slug. */
  prefixOverride: string | null;
  /**
   * `--ship-metadata` flow toggle. Retained on the option surface for CLI
   * compatibility; the bd-backed ship-metadata PR flow no longer runs (GH-1012).
   */
  shipMetadata: boolean;
  /** Fallback cwd when `slug` is null (e.g. `process.cwd()`). */
  cwd?: string | undefined;
};

export type RepoBootstrapDeps = {
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  /** BEADS_DOLTHUB_OWNER fallback (retained on the dep surface; unused). */
  dolthubOwnerDefault?: string | null;
};

// ── result arms ────────────────────────────────────────────────────────────

export type BootstrapRefusalReason =
  | "no-inventory"
  | "slug-not-found"
  | "no-worktree"
  | "prefix-invalid"
  // GH-1012: the bd/beads write-plane was removed; there is nothing to bootstrap.
  | "beads-removed";

export const BOOTSTRAP_EVENT_NAMES = [
  "BD_BOOTSTRAP_STARTED",
  "BD_BOOTSTRAP_LEGACY_HOME_DETECTED",
  "BD_BOOTSTRAP_LEGACY_HOME_ISOLATED",
  "BD_BOOTSTRAP_INIT_COMPLETED",
  "BD_BOOTSTRAP_AUTO_PUSH_DISABLED",
  "BD_BOOTSTRAP_AUTO_PUSH_DISABLE_FAILED",
  "BD_BOOTSTRAP_INDEX_UPDATED",
  "BD_BOOTSTRAP_COMPLETED",
  "BD_BOOTSTRAP_FAILED",
] as const;
export type BootstrapEventName = (typeof BOOTSTRAP_EVENT_NAMES)[number];

export type RepoBootstrapDolthubOutcome =
  | { wired: true; url: string }
  | { skipped: true; reason: AddDolthubRefusalReason };

export type RepoBootstrapResult =
  | {
      kind: "bootstrapped";
      slug: string;
      prefix: string;
      doltDir: string | null;
      shipped: boolean;
      pr?: { url: string; number: number };
      dolthub: RepoBootstrapDolthubOutcome | null;
      events: BootstrapEventName[];
    }
  | {
      kind: "already-bootstrapped";
      slug: string;
      prefix: string;
      doltDir: string | null;
    }
  | {
      kind: "refused";
      slug: string | null;
      reason: BootstrapRefusalReason;
      detail: string;
    };

// ── error class ────────────────────────────────────────────────────────────

export class RepoBootstrapError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RepoBootstrapError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function resolvedRepoCwd(repo: LocalRepo): string | null {
  if (repo.mainWorktree) return repo.mainWorktree;
  if (repo.worktrees.length > 0) return repo.worktrees[0]!.path;
  return null;
}

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoBootstrap(
  opts: RepoBootstrapOptions,
  deps: RepoBootstrapDeps = {},
): RepoBootstrapResult {
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;

  // 1. inventory load.
  if (!opts.config.indexPath) {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "no-inventory",
      detail:
        "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo bootstrap` from a prx-managed checkout (or run `prx repo list` once to bootstrap the inventory).",
    };
  }
  const inventory = loadIndex(opts.config.indexPath);
  if (!inventory) {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "no-inventory",
      detail: `No repo inventory index at ${opts.config.indexPath}. Run \`prx repo list\` to populate it before bootstrapping a beads workspace.`,
    };
  }

  // 2. locate repo.
  const located = locateRepo(inventory, { slug: opts.slug, cwd: opts.cwd });
  if (located.kind === "not_found") {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "slug-not-found",
      detail: located.detail,
    };
  }
  const { repo } = located;

  // 3. worktree presence.
  const workspaceCwd = resolvedRepoCwd(repo);
  if (!workspaceCwd) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "no-worktree",
      detail: `${repo.name}: no attached worktree on the inventory entry. Run \`prx repo materialize ${repo.name}\` first.`,
    };
  }

  // 4. derive + validate prefix.
  const prefix = opts.prefixOverride?.trim() || repo.name;
  if (!WORKSPACE_PREFIX_PATTERN.test(prefix)) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "prefix-invalid",
      detail: `${repo.name}: prefix '${prefix}' does not match ${WORKSPACE_PREFIX_PATTERN}. Pass --prefix <value> to override.`,
    };
  }

  // 5. GH-1012 — the bd/beads write-plane has been removed; there is no
  // per-project bd workspace to bootstrap. GitHub issues are the write plane
  // and Front Desk the read plane.
  return {
    kind: "refused",
    slug: repo.name,
    reason: "beads-removed",
    detail: `${repo.name}: \`prx repo bootstrap\` provisioned a bd/beads workspace, which has been removed (GH-1012). GitHub issues are now the write plane and Front Desk the read plane; there is no per-project bd workspace to bootstrap.`,
  };
}

// ── formatter ──────────────────────────────────────────────────────────────

export function formatRepoBootstrap(result: RepoBootstrapResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  switch (result.kind) {
    case "bootstrapped": {
      const lines: string[] = [
        `bootstrapped ${result.slug} [prefix=${result.prefix}]`,
        result.doltDir
          ? `  mode: per-project (${result.doltDir})`
          : `  mode: non-per-project (check .beads/ on disk for the actual shape)`,
        `  ship-metadata: ${result.shipped ? "yes" : "stealth (no upstream commit)"}`,
      ];
      if (result.pr) {
        lines.push(`  pr: ${result.pr.url}`);
      }
      if (result.dolthub) {
        if ("wired" in result.dolthub) {
          lines.push(`  dolthub: wired → ${result.dolthub.url}`);
        } else {
          lines.push(`  dolthub: skipped (${result.dolthub.reason})`);
        }
      }
      return lines.join("\n");
    }
    case "already-bootstrapped":
      return `already-bootstrapped ${result.slug} [prefix=${result.prefix}]${result.doltDir ? ` → ${result.doltDir}` : ""}`;
    case "refused":
      return `refused (${result.reason}): ${result.detail}`;
  }
}
