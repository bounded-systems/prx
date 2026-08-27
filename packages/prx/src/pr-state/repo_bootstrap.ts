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
  type RepoInventoryConfig,
} from "./repos.ts";
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

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoBootstrap(
  opts: RepoBootstrapOptions,
  _deps: RepoBootstrapDeps = {},
): RepoBootstrapResult {
  // GH-1012 — the bd/beads write-plane has been removed; there is no
  // per-project bd workspace to bootstrap. GitHub issues are the write plane
  // and Front Desk the read plane.
  //
  // GH-1005: this refusal is returned FIRST, ahead of the inventory / locate /
  // worktree / prefix gates that used to run before it. Those gates could only
  // ever change WHICH refusal came back, never whether one did — and on an
  // externally-added repo (no `.prx/repos/index.json` in its worktree) the
  // first gate won the race and answered `no-inventory`, whose detail told the
  // operator to run `prx repo list`. That is a dead end twice over: `repo list`
  // does not create a per-worktree inventory for an external repo, and even if
  // it did the verb would still refuse. Diagnosing a retired verb as a missing
  // inventory sends the operator to fix something that is not broken, so the
  // verb now answers with the one true reason for every caller.
  //
  // `opts.slug` is echoed back unresolved: resolving it required the inventory
  // read this refusal deliberately skips, and a slug the operator typed is
  // more useful in the message than one this verb can no longer look up.
  return {
    kind: "refused",
    slug: opts.slug,
    reason: "beads-removed",
    detail:
      "`prx repo bootstrap` provisioned a bd/beads workspace, which has been removed (GH-1012). " +
      "GitHub issues are now the write plane and Front Desk the read plane; there is no per-project " +
      "bd workspace to bootstrap, on this or any repo. Nothing needs to be run in its place: " +
      "`prx repo add` finishes the job on its own (it derives the workspace prefix from the repo slug), " +
      "and work items live on GitHub.",
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
