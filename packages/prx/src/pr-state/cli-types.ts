import type { SurfaceSyncAction } from "@bounded-systems/surface-sync";
import { type TaskContract } from "./task.ts";
import { type PlanCloseBdRecordOutcome } from "./plan-close-bd.ts";
import { type BdSchemaProbeResult, type BdSchemaRepairResult } from "../beads/schema_repair.ts";

// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules.

/** The CLI output sink (stdout/stderr), threaded through every handler. */
export type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type WorkUnitIssueCheckResult = {
  workUnitId: string;
  repo: string;
  issue: {
    number: number;
    title: string;
    state: string;
  };
  checked: boolean;
  valid: boolean;
  reason: "open";
};

export type BeadsGithubIssueMatch = {
  id: string;
  title: string;
  status?: string | null;
  source_system?: string | null;
  external_ref?: string | null;
  [key: string]: unknown;
};

export type WorkUnitSessionCheckResult = {
  workUnitId: string;
  worktreePath: string | null;
  lockReason: string | null;
  checked: true;
  valid: true;
  reason: "no_matching_worktree" | "no_active_session";
};

export type WorkUnitChainCheckResult = {
  workUnitId: string;
  create: boolean;
  unitExists: boolean;
  issueAuthorityActive: boolean | null;
  pruneActions: string[];
  backfillActions: string[];
  checked: true;
  valid: true;
  reason:
    | "ok"
    | "missing_unit_allowed"
    | "backfill_allowed"
    | "bd_schema_drift_detected"
    // prx-jcb: the unit has no GH-board parity row, but a content-addressed
    // artifact (a plan in CAS) already links it locally. The artifact graph IS
    // the projection — entry is allowed and the consumer validates the artifact.
    | "artifact_projected";
  bdSchemaProbe?: BdSchemaProbeResult;
};

export type SessionOpenCheckReport = {
  workUnitId: string;
  localBranch: "absent" | "present";
  remoteBranch: "absent" | "present";
  worktreePath: string | null;
  taskContract: "missing" | "present" | "not-applicable";
  task?: TaskContract;
};

export type BeadsInitSetupResult =
  | {
      status: "initialized" | "forced" | "unchanged";
      canonicalRepoId: string;
      database: string;
      githubRepository: string;
      prefix?: string | undefined;
    }
  | {
      status: "skipped";
      reason: string;
      canonicalRepoId?: string;
      database?: string;
      githubRepository?: string;
    };

export const VERB_HELP_SEE_ALSO: Record<string, string[]> = {
  "submit body-template": [
    "Bd-canonical PR linkage (Refs <bd-id> for pin-zero UoWs):",
    "  docs/architecture/bd-canonical-pr-linkage.md",
  ],
  "submit postmerge": [
    "Bd-canonical PR linkage (explicit `bd close <id>` handoff for pin-zero UoWs):",
    "  docs/architecture/bd-canonical-pr-linkage.md",
  ],
  "doctor merge": [
    "Bd-canonical PR linkage (no auto-close fires for pin-zero UoWs):",
    "  docs/architecture/bd-canonical-pr-linkage.md",
  ],
};

export type CloseSessionResult = {
  workUnitId: string;
  worktreePath: string | null;
  branch: string | null;
  prNumber: number | null;
  prState: "merged" | "draft" | "open" | "closed" | "unknown" | "none";
  issueState: string | null;
  remoteBranchPresent: boolean | null;
  mainxReset: "done" | "skipped" | "dry-run" | "failed";
  handoff: string[];
  handoffRequired: boolean;
  refusalReason: string | null;
  dryRun: boolean;
};

export type PlanCloseReason = "completed" | "not-planned" | "duplicate";

export type PlanCloseResult = {
  workUnitId: string;
  issueNumber: number | null;
  reason: PlanCloseReason;
  upstream: string | null;
  upstreamCommentPosted: boolean;
  issueClosed: boolean;
  /**
   * GH-2110: outcome of the bd-record close-and-verify pass that runs after
   * `gh issue close` succeeds. The headline operator-facing signal — distinct
   * from `bdSyncExitCode` (the broader reconcile tick), which can still
   * report `ok` even when this pass leaves the linked bd record open.
   */
  bdRecord: PlanCloseBdRecordOutcome | null;
  /**
   * Exit code from the canonical reconcile tick (`runBeadsSync`). Narrower
   * meaning post-GH-2110 — "did the periodic-reconcile shell out cleanly?",
   * not "is the linked bd record CLOSED?". The latter is `bdRecord`.
   */
  bdSyncExitCode: number | null;
  handoff: string[];
  refusalReason: string | null;
  dryRun: boolean;
};

export type ParityChainApplyResult = {
  action: SurfaceSyncAction;
  command: string;
  status: number;
  stdout: string;
  stderr: string;
};

export type RepairBdEntry = { cwd: string; result: BdSchemaRepairResult };


