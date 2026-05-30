// GH-1125 — `prx prune --merged-only` pre-step in `prx triage prime`.
//
// Discovery: build a parity chain in prune mode with `mergedOnly: true`.
// That gate selects units whose PR is merged but whose issue is still open
// and prepends a `close_issue` action to each unit; the existing prune-mode
// emit logic ALSO fires for those units, so `delete_remote_branch` (and,
// once GH-1126 lands, `delete_local_branch` + `remove_worktree`) layer on
// alongside the close.
//
// Apply: re-uses `applyParityChainActions` so each action runs through the
// same continue-on-error harness the standalone `prx prune` verb uses.
// After a successful apply pass, mirror the close into beads via the
// canonical status-only reconcile `runBeadsSync({ domain: "gh" })` — same
// chain `triage apply` runs after label edits so beads tracks the GH state
// without an out-of-band sync step (the sanctioned `prx sync issues --from gh
// --to bd` surface). GH-2316 retired the destructive bd-side reconcile
// shell-out here so a GH `priority::*` label can never round-trip into
// bd-canonical priority (priority is bd-authoritative, projected bd→external
// only; I-DS-PRIO).
//
// Result shape (`TriagePruneMergedActorResult`) is consumed by the
// `triageMachine` `pruneMerged` state and surfaced to `prx triage prime`'s
// per-iteration log so the operator sees what the sweep closed.

import {
  applyParityChainActions,
  pruneStaleRemoteRefs,
  type ParityChainApplyResult,
} from "../pr-state/cli.ts";
import { buildParityChain, repoNameWithOwner } from "../pr-state/github.ts";
import type { SurfaceSyncAction } from "@bounded-systems/surface-sync";
import {
  runBeadsSync as defaultRunBeadsSync,
  type BeadsSyncResult,
} from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";

import {
  triagePruneMergedOptionsSchema,
  type TriagePruneMergedOptions,
} from "./schemas/index.ts";

/**
 * Result of one `prx prune --merged-only` sweep.
 *
 * `closedIssues` lists the GH issue numbers whose `close_issue` action ran
 * to status 0. `removedWorktrees` lists worktree paths torn down by the
 * pass — empty until GH-1126 extends the parity chain with the missing
 * teardown action; the field is on the contract today so the consuming
 * surfaces (machine context, prime per-iteration log) don't change shape
 * when that ticket lands.
 */
export type TriagePruneMergedActorResult = {
  exitCode: number;
  closedIssues: number[];
  removedWorktrees: string[];
  applyResults: ParityChainApplyResult[];
  bdSync: { exitCode: number; stdout: string; stderr: string } | null;
};

export type TriagePruneMergedDeps = {
  buildParityChain?: typeof buildParityChain;
  applyParityChainActions?: typeof applyParityChainActions;
  pruneStaleRemoteRefs?: typeof pruneStaleRemoteRefs;
  /**
   * Canonical reconcile chained after the merged-PR closures (GH-2316:
   * replaces the retired destructive `bd github sync --pull-only
   * --prefer-github` shell-out). Default delegates to `defaultRunBeadsSync`.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
  cwd?: () => string;
  resolveRepoNameWithOwner?: (path: string) => string;
};

export async function runPruneMergedActor(
  opts: TriagePruneMergedOptions,
  deps: TriagePruneMergedDeps = {},
): Promise<TriagePruneMergedActorResult> {
  const validated = triagePruneMergedOptionsSchema.parse(opts);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const build = deps.buildParityChain ?? buildParityChain;
  const apply = deps.applyParityChainActions ?? applyParityChainActions;
  const refresh = deps.pruneStaleRemoteRefs ?? pruneStaleRemoteRefs;
  const resolveRepo =
    deps.resolveRepoNameWithOwner ?? ((path: string) => repoNameWithOwner(path));
  const beadsSync = deps.runBeadsSync ?? defaultRunBeadsSync;

  // GH-1125 / Copilot review: this actor plans, applies, AND syncs against
  // `cwd`. If `validated.repo` is set and disagrees with the gh repo
  // inferred from `cwd`, the rest of triage targets `validated.repo` (via
  // the gh CLI's directory-resolved auth) while this state would prune /
  // close issues in the cwd repo — a dangerous mismatch. Fail fast rather
  // than silently diverging; the operator can re-run from a checkout of
  // the intended repo or omit `--repo`.
  if (validated.repo) {
    const inferred = resolveRepo(cwd);
    if (inferred !== validated.repo) {
      throw new Error(
        `triagePruneMergedActor: --repo ${validated.repo} does not match repo inferred from cwd (${inferred}). ` +
          `Run from a checkout of ${validated.repo} or omit --repo.`,
      );
    }
  }

  // GH-830 ordering: refresh remote-tracking refs before planning so a
  // remote branch GitHub already deleted doesn't trigger a doomed
  // `delete_remote_branch` action. Cheap, network-bound, mirrors the
  // standalone prune apply path in src/pr-state/cli.ts.
  if (!validated.dryRun) {
    refresh(cwd);
  }

  const chain = build(cwd, {
    mode: "prune",
    apply: !validated.dryRun,
    mergedOnly: true,
  });

  if (chain.actions.length === 0) {
    return {
      exitCode: 0,
      closedIssues: [],
      removedWorktrees: [],
      applyResults: [],
      bdSync: null,
    };
  }

  if (validated.dryRun) {
    // Dry-run: report what *would* close, no shell actions, no bd sync.
    const wouldClose = chain.actions.flatMap(extractClosedIssue);
    return {
      exitCode: 0,
      closedIssues: wouldClose,
      removedWorktrees: [],
      applyResults: [],
      bdSync: null,
    };
  }

  const applyResults = apply(chain, cwd);
  const closedIssues = applyResults.flatMap(extractAppliedClose);
  const failed = applyResults.some((r) => r.status !== 0);

  // Sync the GH closures back into beads so subsequent triage stages see
  // the closed state. Skip when nothing closed or when the apply pass
  // already failed — the sync would either be a no-op or compound the
  // failure noise.
  let syncResult: TriagePruneMergedActorResult["bdSync"] = null;
  if (closedIssues.length > 0 && !failed) {
    const syncCapture: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const syncOutput = {
      log: (line: string) => syncCapture.stdout.push(line),
      error: (line: string) => syncCapture.stderr.push(line),
    };
    const out: BeadsSyncResult = await beadsSync(
      {
        // `repo` is optional; when omitted, runBeadsSync resolves it from cwd.
        // The mismatch guard above already proved `validated.repo` (when set)
        // matches the cwd-inferred repo, so passing it through is safe.
        ...(validated.repo ? { repo: validated.repo } : {}),
        domain: "gh",
        dryRun: false,
        limit: DEFAULT_SYNC_LIMIT,
        format: "plain",
      },
      syncOutput,
    );
    syncResult = {
      exitCode: out.exitCode,
      stdout: syncCapture.stdout.join("\n").trim(),
      stderr: syncCapture.stderr.join("\n").trim(),
    };
  }

  return {
    exitCode: failed || (syncResult?.exitCode ?? 0) !== 0 ? 1 : 0,
    closedIssues,
    removedWorktrees: [],
    applyResults,
    bdSync: syncResult,
  };
}

function extractClosedIssue(action: SurfaceSyncAction): number[] {
  return action.type === "close_issue" ? [action.issue] : [];
}

function extractAppliedClose(result: ParityChainApplyResult): number[] {
  if (result.action.type !== "close_issue") return [];
  if (result.status !== 0) return [];
  return [result.action.issue];
}
