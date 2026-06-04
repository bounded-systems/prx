import { getEnv, processEnv, setEnv, deleteEnv } from "@bounded-systems/env";
import { defaultRunner as procRunner, localProcExecutor } from "@bounded-systems/proc";
import { bakedGitSha, bakedReleaseVersion } from "../build-info.ts";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  applyTransition,
  deriveInfo,
  loadContract,
  recordEvent,
  writeContract,
  type StateMode,
} from "./contract.ts";
import {
  appendTransitionLog,
  validateActorOwnership,
  type TransitionEntry,
} from "./transition_log.ts";
import {
  overviewStatus,
  syncGitHubIssuesToBeads,
  syncStatus,
  updatePrFromContract,
  loadPrefixRoutingConfig,
  loadIdentityConfig,
  commandForSurfaceSyncAction,
  surfaceSyncExecContext,
  type SurfaceSyncExecContext,
  listWorktrees,
  maybeViewCurrentPr,
  prMergeStateLabel,
  viewIssueFresh,
  worktreeMap,
  worktreeStatus,
  wtStatus,
  removeWorktree,
  lockWorktree,
  boardStatus,
  chainStatus,
  repoStatus,
  remoteCiCheck,
  resolveCurrentPrRef,
  scoutLogs,
  repoCheckNames,
  fetchPrComments,
  resolvePrReviewThreads,
  buildParityChain,
  buildSurfaceSyncFromBoard,
  buildSessionLayerPrune,
  checkMainBranchProtection,
  protectMainBranch,
  viewPr,
  type ProtectMainBackend,
  type ScoutLogsResult,
  type PrView,
  type OverviewResult,
  type ChainStatusResult,
  type RemoteCiCheckResult,
  type PrCommentsResult,
  type PrReviewThreadResolution,
  type ProtectMainBranchResult,
  type RepoCheckNamesResult,
  type ProtectMainBranchCheckResult,
  type RepoStatusResult,
  type SyncGitHubIssuesToBeadsResult,
  type WorktreeStatus,
  type WorktreeRemoveResult,
  type WtStatusResult,
  unlockWorktree,
  repoNameWithOwner,
  resolveFeatureForPrefix,
  validateBeadsIssue,
  validateGitHubIssue,
  loadReviewConfig,
  loadWorkspaceConfig,
  persistWorkspaceTrack,
  defaultRunner,
  commandEnv,
  effectiveCanonicalIdPattern,
  findFirstSourceOfKind,
  parseGithubRepo,
  parseSessionLockPid,
  defaultPidAliveProbe,
  type CommandRunner as GithubCommandRunner,
  type PidAliveProbe,
  type IdentityConfig,
  type NotionIdentityConfig,
  type WorktreeRemoveMuxHandle,
} from "./github.ts";
import type {
  SurfaceSyncAction,
  SurfaceSyncAuthority,
  SurfaceSyncMode,
  SurfaceSyncResult,
  SurfaceSyncScope,
} from "@bounded-systems/surface-sync";
import { formatSurfaceSync } from "@bounded-systems/surface-sync";
import {
  attachMuxSession,
  clearResurrectEntry,
  killMuxSession,
  muxSessionName,
  muxSessionState,
  restoreMuxSession,
  sendMuxKeys,
  spawnMuxSession,
  PRX_TMUX_SOCKET,
} from "@bounded-systems/prx-mux";
import { shellQuote as shellQuoteArg } from "./executor.ts";
import { emit } from "../cli/emit.ts";
import {
  agentResultSchema,
  captureAgentResult,
  planAgentResultSchema,
  readReportedResult,
  renderAgentResult,
  renderPlanAgentResult,
  type ReportedResult,
  snapshotBeadIds,
  summarizeAgentStdout,
  writeReportedResult,
} from "../pipeline/agent-result.ts";
import { finalizeImplementRun } from "../pipeline/implement-artifact.ts";
import { pinWorkUnitSourceBestEffort } from "../pipeline/source-pin.ts";
import { type CheckStep, runAttestedChecks } from "../provenance/attest.ts";

// prx-ub4 (slice 4c): the project checks prx re-runs + signs (`checks/v1`) after
// a headless implement commit, when a signer + ledger are configured. Mirrors
// the executor's own check tooling (the implement allowlist grants these).
const IMPLEMENT_CHECK_STEPS: readonly CheckStep[] = [
  { command: "bun", args: ["run", "typecheck"] },
  { command: "bun", args: ["test"] },
];
import { pickPrimaryTmuxEntry, readTmuxSurface } from "./surfaces/tmux.ts";
import { resolverForCanonicalId } from "./resolvers/dispatch.ts";
import { BeadsResolver } from "./resolvers/beads.ts";
import type { ResolvedWorkUnit, WorkUnitSource } from "./resolvers/types.ts";
import { workUnitSources } from "./resolvers/types.ts";
import {
  normalizeToBdSurfaceShort,
  recognizeBareWorkspaceLongId,
} from "../issues/resolver.ts";
import { adapterForCanonicalId } from "../adapters/domain-adapter.ts";
import { nextAction, type ActionPlan, type ResolvedAction } from "./actions.ts";
import { nextWork } from "./next_work.ts";
import { runDelegateAssign } from "../delegate/assign.ts";
import { runRepairAssignees } from "../delegate/repair_assignees.ts";
import type { NextWorkResult } from "../beads/ready.ts";
import {
  formatDelegateNext,
  formatDelegateNextList,
  selectDelegateCandidate,
  type DelegateNextEnrichment,
} from "../beads/delegate.ts";
import { buildDomainState, type DomainStateV1 } from "./domain_state.ts";
import {
  addLocalRepo,
  canonicalBarePathFromParsed,
  discoverLocalRepos,
  findRepoBySlug,
  listIndexedReposForDoltReconcile,
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  localRepoForCwd,
  normalizeLocalRepos,
  parseRepoUrl,
  preservePerRepoAxes,
  refreshLocalRepo,
  RepoAddError,
  repoCanonical,
  rollbackRepoAdd,
  setRepoBdWorkspacePrefix,
  setRepoCanonical,
  setRepoDoltRemote,
  setRepoStaleThresholdDays,
  writeRepoInventoryIndex,
  type DoltReconcileCandidate,
  type LocalRepo,
  type RepoAddResult,
  type RepoInventory,
  type RepoNormalizationResult,
  type RepoRefreshResult,
  type SetRepoAxisDelta,
} from "./repos.ts";
import {
  auditRegisteredRepos,
  formatRepoAudit,
  type RepoAuditDeps,
} from "./repo_audit.ts";
import {
  // GH-1760: registry-store DI + types shared by adopt verbs and the
  // `prx repo audit` count line.
  BranchStore,
  RepositoryStore,
  WorkspaceStore,
  defaultRegistryPath,
  openRegistry,
  type BranchRow,
  type RepoRow,
  type WorkspaceRow,
} from "./registry_store.ts";
import { adoptRepo, type AdoptRepoResult } from "./repo_adopt.ts";
import { adoptBranch, type AdoptBranchResult } from "./branch_adopt.ts";
import {
  adoptWorkspace,
  type AdoptWorkspaceResult,
} from "./workspace_adopt.ts";
import {
  formatRepoBackfill,
  RepoBackfillError,
  runRepoBackfill,
} from "./repo_backfill.ts";
import {
  formatRepoGcReport,
  RepoGcError,
  runRepoGc,
} from "./repo_gc.ts";
import {
  AddDolthubError,
  formatRepoAddDolthub,
  runRepoAddDolthub,
} from "./repo_add_dolthub.ts";
import {
  formatRepoBootstrap,
  RepoBootstrapError,
  runRepoBootstrap,
} from "./repo_bootstrap.ts";
import { locateRepo } from "./repo_locate.ts";
import {
  materializeBareRepo,
  MaterializeError,
  type MaterializeResult,
} from "./materialize.ts";
import {
  resolveTargetRepoCwd,
} from "./repo-target.ts";
import {
  beadsModeHint,
  classifyBeadsWorkspace,
} from "../beads/workspace_mode.ts";
import {
  applyHooks,
  formatHookApply,
  formatHookStatus,
  hookApplyHasErrors,
  hookStatus,
  hookStatusHasDrift,
} from "./hooks.ts";
import {
  actorsForScope,
  eventOwnersForScope,
  rawFieldOwnersForScope,
  type ActorScope,
} from "./actors.ts";
import {
  allowedTransitions,
  assertValidTransition,
  canonicalPrEventAliases,
  eventForSkill,
  lifecycleStates,
  prSystemMachine,
  prSkillNames,
  type PrSkillName,
  type SkillEventDefinition,
  type LifecycleState,
} from "./machine.ts";
import { invariantSpecs, phasePrecedence } from "./raw_state.ts";
import {
  // GH-1821: contract-trinity registry read path consumed by
  // `prx contract show --kind=...` and `--list`.
  getAgentContract,
  listAgentContracts,
} from "../machine/contracts/instances.ts";
import {
  getArtifactContract,
  listArtifactContracts,
} from "../machine/contracts/artifacts.ts";
import {
  getTransitionContract,
  listTransitionContracts,
  transitionKey,
} from "../machine/contracts/transitions.ts";
import {
  assertSprintInvariants,
  createSprintState,
  refreshSprintDerived,
  sprintStateV1Schema,
  type SprintPrSnapshot,
  type SprintStateV1,
} from "./sprint.ts";
import {
  buildCanonicalWorkUnitIdHelpers,
  canonicalWorkUnitIdPattern,
  normalizeCanonicalWorkUnitId,
  type CanonicalWorkUnitIdHelpers,
} from "../machine/work_unit.ts";
import {
  PRX_SESSION_DEPRECATION_WORK,
  PRX_SESSION_OPEN_DEFINITION,
  PRX_SESSION_OPEN_REQUIRES_TARGET,
  PRX_SESSION_PLAN_ALIAS_HINT,
  PRX_SESSION_PLAN_DEFINITION,
  formatPrxSessionOpenHelpBlock,
  prxSessionBoardReadFailureMessage,
  prxSessionCannotOpenPrefix,
  prxSessionEpicRefusalMessage,
  prxSessionNoSourceConfiguredMessage,
  prxSessionNotProjectedLocallyEnvelope,
  prxSessionNotProjectedLocallyMessage,
  prxSessionParityCleanupMessage,
  prxSessionSourceClosedMessage,
  prxSessionSourceNotFoundMessage,
  prxSessionUnitCompleteMessage,
} from "../machine/session_open.ts";
import { findEpicChildren } from "../beads/epic_children.ts";
import { hasEpicLabel } from "../triage/labels.ts";
import {
  ensureClaudeInteractiveAllowlist,
  ensureClaudeSessionProfileAllowlist,
  type EnsureClaudeAllowlistResult,
} from "../machine/claude_local_settings.ts";
import {
  buildTaskRoleAgentId,
  buildTaskRoleClaudeRuntimeProfile,
  buildTaskRoleCopilotRuntimeProfile,
  buildTaskRoleCodexRuntimeProfile,
  buildTaskRoleCursorRuntimeProfile,
  buildTaskRoleGeminiRuntimeProfile,
  buildWorkUnitCopilotRuntimeProfile,
  buildWorkUnitCodexRuntimeProfile,
  buildWorkUnitCursorRuntimeProfile,
  buildWorkUnitGeminiRuntimeProfile,
  SESSION_PROFILES,
  buildUserClaudeRuntimeProfile,
  buildWorkUnitClaudeInteractiveRuntimeProfile,
  buildWorkUnitClaudeImplementSdkRuntimeProfile,
  buildWorkUnitClaudePlanPrintRuntimeProfile,
  buildWorkUnitClaudeRuntimeProfile,
  buildWorkUnitMachineFirstPromptText,
  resolveAgentBackend,
  getLocalRuntimeArtifactPaths,
  runtimeIoFormats,
  runtimeModes,
  runtimeProfiles,
  type SessionProfileName,
  taskAgentRoles,
  type TaskAgentRole,
  workAgentImplementations,
  type WorkAgentImplementation,
  type RuntimeIoFormat,
  type RuntimeMode,
  type RuntimeProfileName,
  type RuntimeProfileProjection,
} from "../machine/runtime_profiles.ts";
import { buildRuntimeOutputSchema } from "../machine/runtime_output.ts";
import {
  agentProfileExecutionAsRuntimeResult,
  DEFAULT_IMPLEMENT_WATCHDOG_MS,
  executeAgentProfile,
  executeValidatedAgentWithRetry,
  localRuntimeExecutor,
  type RuntimeExecutor,
} from "./executor.ts";
import { makeWorkUnitDraftSink } from "../claude/partial_capture.ts";
import type { RunClaudeAgentNonInteractiveOpts } from "../claude/agent_service.ts";
import {
  completeTaskRole,
  confirmTaskScope,
  confirmTaskSuccessCriteria,
  createTaskContract,
  defaultTaskPath,
  deriveTaskStatus,
  failTaskRole,
  loadTaskContract,
  setTaskMergeConflict,
  setTaskNeedsRebase,
  setTaskRemoteCiPassed,
  setTaskReviewAdded,
  setTaskReviewApproved,
  setTaskAgentReview,
  setTaskHumanReview,
  setTaskCommentsResolved,
  setTaskAutoMergeEnabled,
  startTaskRole,
  setTaskSuccessRequirements,
  syncTaskContract,
  taskContractExists,
  taskContractSchema,
  writeTaskContract,
  type TaskContract,
} from "./task.ts";
import { invalidateUnit } from "./projection.ts";
import {
  fetchPrSignalInfo,
  currentBranchName,
} from "./github.ts";
// GH-885 + GH-882: doctor actor — PR readiness diagnostician.
import { runInventory as doctorRunInventory } from "./doctor.ts";
// GH-1559 (GH-1398 ADR §4): publisher actor — PR publication transitions.
// The merge/ready/draft verbs moved off doctor; `prx doctor merge|ready|draft`
// stay one release window as deprecation aliases that delegate here.
import {
  runMerge as publisherRunMerge,
  runReady as publisherRunReady,
  runDraft as publisherRunDraft,
  runPrOpen as publisherRunPrOpen,
  runPrUpdate as publisherRunPrUpdate,
  runPrComment as publisherRunPrComment,
  runPrEdit as publisherRunPrEdit,
} from "./publisher.ts";
// GH-2348.2: keeper attested-push handler.
import { runKeeperPush, type KeeperPushDeps } from "./keeper.ts";
// GH-1508: doctor substrate-tier dedupe verb (ADR §6).
import { runDedupeBd as doctorRunDedupeBd } from "../doctor/dedupe-bd.ts";
// GH-1823: audit actor — read-only adherence metrics over the artifact graph.
import {
  runAuditIngest,
  runAuditUow,
  runAuditSystem,
} from "../audit/cli.ts";
// GH-1407: services actor — Anthropic prompt-cache hit-rate projector.
import { runServicesStatus } from "../services/cli.ts";
import { taskRoleMachine, taskRoles, type TaskRole } from "../machine/machines/task.ts";
import { workflowMachine } from "../machine/machines/workflow.ts";
import {
  resolveWorktreePath,
  worktreeEnv,
  execWorktrunk,
  formatWorktreePath,
  formatWorktreeEnv,
  formatExecResult,
} from "../tools/worktree_path.ts";
import {
  addWorktreeForBranch,
  expectedWorktreePath,
  WorktreeAddError,
} from "../tools/worktree_layout.ts";
import {
  execGit,
  formatGitExecResult,
  type LockRecoveryHooks,
  runWithGitLockRecovery,
  withGitLockRecovery,
} from "@bounded-systems/git";
import {
  ensureBranch,
  formatEnsureBranchResult,
  type EnsureBranchResult,
} from "../tools/ensure_branch.ts";
import {
  bootstrapWorktree,
  buildDefaultDeps as buildDefaultBootstrapDeps,
  formatBootstrapResult,
} from "../tools/bootstrap_worktree.ts";
import { ensureWorkUnitBranchAndUpstream } from "../tools/ensure_work_unit_branch.ts";
import { execGh } from "@bounded-systems/gh";
import {
  execBd,
  formatBdExecResult,
  runBdShow,
  runBdUpdateClaim,
  type BdGithubRunner,
} from "@bounded-systems/bd";
import { execBdIssueClose } from "../tools/bd_issue_close.ts";
import {
  resolveAndCloseLinkedBeads,
  type PlanCloseBdRecordOutcome,
} from "./plan-close-bd.ts";
import { syncLabels, formatSyncLabelsResult } from "../tools/labels.ts";
import {
  runClaudePreflight,
  formatClaudePreflight,
} from "../tools/preflight_claude.ts";
import {
  runNotionMcpPreflight,
  formatNotionMcpPreflight,
} from "../tools/preflight_notion_mcp.ts";
import {
  discoverLocalGitRepos,
  formatLocalReposResult,
} from "../tools/repos_local.ts";
import {
  ensurePrxExcludes,
  type EnsurePrxExcludesResult,
} from "../tools/ignore_sync.ts";
import { runHook, formatRunHookResult } from "../tools/run_hook.ts";
import { hydrate as hydrateBeads, formatHydrateResult, type HydrateStatus } from "../beads/hydrate.ts";
import {
  parseWorkspaceArgs,
  runWorkspaceCli,
  WorkspaceCliError,
} from "../workspace/cli.ts";
// GH-2026/GH-2327: `prx gc <verb>` unified housekeeping actor. Verb parser +
// dispatch live in `src/machine/gc/cli.ts`; this surface only routes argv and
// injects the prune-teardown deps the `gc teardown` path reuses.
import {
  parseGcArgs,
  runGcCli,
  GcCliError,
  PRX_PRUNE_GC_ALIAS_HINT,
} from "../machine/gc/cli.ts";
import {
  resolveCanonicalChainLedger,
  resolveWorkspaceContext,
  runMaterialize as runWorkspaceMaterialize,
  runReserve as runWorkspaceReserve,
} from "../workspace/actor.ts";
import { MaterializeInput, ReserveInput } from "../workspace/schema.ts";
import {
  runBeadsPublish,
  beadsPublishOptionsSchema,
  type BeadsPublishOptions,
  type BeadsPublishDeps,
} from "../beads/publish.ts";
import {
  probeBdSchema,
  repairBdSchema,
  type BdSchemaProbeResult,
  type BdSchemaRepairResult,
} from "../beads/schema_repair.ts";
// GH-1706: embedded → shared-server bd migration verb. Pure runner; the
// CLI dispatch passes parsed flags straight through and formats the
// discriminated-union result.
import { runBeadsMigrate } from "../beads/migrate.ts";
import {
  runHomeUpdate,
  type HomeUpdateOptions,
  type HomeUpdateDeps,
} from "./home-update.ts";
import {
  runHomeSync,
  type HomeSyncOptions,
  type HomeSyncDeps,
} from "./home-sync.ts";
import {
  runDoltReconcile,
  type DoltReconcileOptions,
  type DoltReconcileDeps,
} from "./dolt-reconcile.ts";
import {
  runDoltStatus,
  type DoltStatusOptions,
  type DoltStatusDeps,
} from "../dolt/status.ts";
import {
  DOLT_VERBS,
  DOLT_VERB_DISPATCH,
  type DoltStubOutput,
  type DoltVerb,
} from "../dolt/schema.ts";
import {
  runTmuxReconcile,
  type TmuxReconcileOptions,
  type TmuxReconcileDeps,
} from "./tmux-reconcile.ts";
import {
  runIntake,
  intakeOptionsSchema,
  type IntakeOptions,
  type IntakeDeps,
} from "../intake/intake.ts";
import {
  INTAKE_INTENTS,
  type IntakeIntent,
} from "../intake/types.ts";
import {
  runIntakeView,
  intakeViewOptionsSchema,
  type IntakeViewOptions,
  type IntakeViewDeps,
} from "../intake/intake-view.ts";
import {
  runIntakeSearch,
  intakeSearchOptionsSchema,
  type IntakeSearchOptions,
  type IntakeSearchDeps,
} from "../intake/intake-search.ts";
import {
  runIntakeStatus,
  intakeStatusOptionsSchema,
  type IntakeStatusOptions,
  type IntakeStatusDeps,
} from "../intake/intake-status.ts";
import {
  runIntakeMerge,
  intakeMergeOptionsSchema,
  type IntakeMergeOptions,
  type IntakeMergeDeps,
} from "../intake/intake-merge.ts";
import {
  runIntakeComment,
  intakeCommentOptionsSchema,
  type IntakeCommentOptions,
  type IntakeCommentDeps,
} from "../intake/intake-comment.ts";
import {
  runIntakeMirror,
  intakeMirrorOptionsSchema,
  type IntakeMirrorOptions,
  type IntakeMirrorDeps,
} from "../intake/intake-mirror.ts";
// GH-1318: submit actor — pre-merge `Closes #N` emitter + post-merge sweep.
import {
  runBodyTemplate,
  bodyTemplateOptionsSchema,
  type BodyTemplateOptions,
} from "../submit/body-template.ts";
// GH-1206: author actor — PR-body authoring between implement and prune.
import {
  runAuthorBodyTemplate,
  authorBodyTemplateOptionsSchema,
  type AuthorBodyTemplateOptions,
} from "../author/body-template.ts";
import {
  runPostmerge,
  postmergeOptionsSchema,
  type PostmergeOptions,
  type PostmergeDeps,
} from "../submit/postmerge.ts";
// GH-1900: submit publish — consumer of the CAS-backed submit-session artifact.
import {
  runSubmitPublish,
  formatPublishRender,
  PublishError,
  type PublishOptions,
  type PublishDeps,
} from "../submit/publish.ts";
// GH-2269: live Signer factory + ledger handle for production SLSA emission.
import {
  isActorDevMode,
  requireSignedDerivations,
  resolveActorVerifierForDerivation,
  resolveProvenanceSigner,
  resolveProvenanceVerifier,
} from "../provenance/signer.ts";
import { projectProvenanceAxis } from "../provenance/merge-guard.ts";
import type { Derivation } from "@bounded-systems/anchored-chain";
import type { ProvenanceAxis } from "../machine/machines/workflow.ts";
// GH-2282: persisted dev provenance identity — `prx provenance dev-pubkey`.
import {
  loadOrCreateDevKeypair,
  resolveDevKeyPathForDisplay,
} from "../provenance/dev-key.ts";
// GH-2262: submit stage — producer that writes the CAS-backed artifact the
// `publish` consumer reads.
import {
  runSubmitStage,
  formatStageRender,
  StageError,
  type StageOptions,
} from "../submit/stage.ts";
import {
  runIntakeBdLs,
  runIntakeBdMemoryLs,
  runIntakeBdMemoryGet,
  runIntakeBdMemorySet,
  intakeBdLsOptionsSchema,
  intakeBdMemoryLsOptionsSchema,
  intakeBdMemoryGetOptionsSchema,
  intakeBdMemorySetOptionsSchema,
  type IntakeBdLsOptions,
  type IntakeBdMemoryLsOptions,
  type IntakeBdMemoryGetOptions,
  type IntakeBdMemorySetOptions,
  type IntakeBdDeps,
} from "../intake/intake-bd.ts";
import {
  loadAllBeads as defaultLoadAllBeads,
  runTriageStatus,
  triageStatusOptionsSchema,
  type BeadsRecord,
  type TriageStatusOptions,
  type TriageStatusDeps,
  type TriageStatusResult,
} from "../triage/triage.ts";
import {
  createBeadsCache,
  type BeadsCache,
} from "../triage/beads_cache.ts";
import {
  runTriageClassify,
  triageClassifyOptionsSchema,
  type TriageClassifyOptions,
  type TriageClassifyDeps,
} from "../triage/classifier.ts";
import {
  runTriageApply,
  triageApplyOptionsSchema,
  type TriageApplyOptions,
  type TriageApplyDeps,
} from "../triage/apply.ts";
import {
  runTriagePromote,
  triagePromoteOptionsSchema,
  type TriagePromoteOptions,
  type TriagePromoteDeps,
} from "../triage/promote.ts";
import {
  runTriagePromoteChildren,
  triagePromoteChildrenOptionsSchema,
  type TriagePromoteChildrenOptions,
  type TriagePromoteChildrenDeps,
} from "../triage/promote-children.ts";
import {
  runTriageDriftFix,
  triageDriftFixOptionsSchema,
  type DriftFixAxis,
  type TriageDriftFixOptions,
  type TriageDriftFixDeps,
} from "../triage/drift-fix.ts";
import {
  runTriageMigrateAxisValue,
  triageMigrateAxisValueOptionsSchema,
  type TriageMigrateAxisValueOptions,
  type TriageMigrateAxisValueDeps,
} from "../triage/migrate-axis-value.ts";
import { LABEL_AXES, type LabelAxis } from "../triage/labels.ts";
import {
  runTriageClose,
  triageCloseOptionsSchema,
  formatTriageCloseResult,
  type TriageCloseOptions,
  type TriageCloseDeps,
  type TriageCloseReason,
  type TriageCloseResult,
} from "../triage/close.ts";
import {
  runTriageCloseStale,
  triageCloseStaleOptionsSchema,
  formatTriageCloseStaleResult,
  type TriageCloseStaleOptions,
  type TriageCloseStaleDeps,
  type TriageCloseStaleResult,
} from "../triage/close-stale.ts";
import {
  runTriagePrioritize,
  triagePrioritizeOptionsSchema,
  type TriagePrioritizeOptions,
  type TriagePrioritizeDeps,
} from "../triage/prioritize.ts";
import {
  runTriageTypePass,
  triageTypePassOptionsSchema,
  type TriageTypePassOptions,
  type TriageTypePassDeps,
} from "../triage/type-pass.ts";
import {
  runTriagePrioritizeBulk,
  type TriagePrioritizeBulkDeps,
} from "../triage/prioritize-bulk.ts";
import {
  triagePrioritizeBulkOptionsSchema,
  triagePrimeOptionsSchema,
  type TriagePrioritizeBulkOptions,
  type TriagePrimeOptions,
} from "../triage/schemas/index.ts";
import {
  runTriagePrime,
  type TriagePrimeDeps,
} from "../triage/prime.ts";
import {
  runCi,
  ciOptionsSchema,
  CI_PHASES,
  type CiOptions,
  type CiPhase,
} from "./local-ci.ts";
import {
  inferOperatorScopeFromCwd,
  isMainxPath,
  type InferredScope,
} from "./scope-inference.ts";
import { dispatchFromArgv, dispatchSessionEntryEvent } from "./session-entry/dispatch.ts";
import {
  deriveSessionBranch,
  openSession,
  type OpenSessionResult,
} from "../session/open.ts";
import type { SessionActor } from "../session/schema.ts";
import { runStep } from "./session-progress.ts";
import { findCommand, prxCommandRegistry } from "../cli/registry.data.ts";
import { HelpOverview } from "./help/overview.ts";
import { HelpAll } from "./help/help-all.ts";
import { ActorSection } from "./help/components.ts";
import { getCurrentSessionContext } from "./help/session-context.ts";
import {
  PlanRefNotFound,
  refName,
  runPlanLoad,
  runPlanPreflight,
  runPlanSave,
  runPlanShow,
  formatPreflightPlain,
} from "../plan-store/verbs.ts";
import {
  PlanStoreError,
  resolvePlanStagingDirForDisplay,
  resolveStoreRootForDisplay,
} from "../plan-store/cas.ts";
import {
  runPlanView,
  planViewOptionsSchema,
  type PlanViewOptions,
  type PlanViewDeps,
} from "../plan-store/plan-view.ts";
import {
  runPlanSearch,
  planSearchOptionsSchema,
  type PlanSearchOptions,
  type PlanSearchDeps,
} from "../plan-store/plan-search.ts";
import { resolvePlanSessionUnit } from "../plan-store/session-context.ts";
import type { DispatchActor } from "../machine/dispatch.ts";
import {
  DispatchParseError,
  parseDispatchCommand as parseDispatchArgv,
} from "./dispatch/parse.ts";
import { renderDispatchOutcome, runDispatch } from "./dispatch/handler.ts";
import {
  formatScoutGrepJsonLines,
  runScoutGrep,
  ScoutGrepError,
  formatScoutFilesJsonLines,
  runScoutFiles,
  ScoutFilesError,
  runScoutRead,
  ScoutReadError,
  recordScoutReadDerivation,
  scoutReadProvenance,
} from "@bounded-systems/scout";
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import {
  runMapCreate,
  mapCreateOptionsSchema,
  type MapCreateOptions,
} from "../map/create.ts";
import {
  runMapShow,
  mapShowOptionsSchema,
  type MapShowOptions,
} from "../map/show.ts";
import { MapRecordNotFoundError } from "../map/record-io.ts";
import {
  formatScoutIssuesJsonLines,
  runScoutIssues,
  ScoutIssuesError,
} from "../scout/issues.ts";
import {
  formatScoutNotionJson,
  runScoutNotion,
  ScoutNotionError,
} from "../scout/notion.ts";
import {
  FetchGhIssuesError,
  formatFetchGhIssuesJson,
  runFetchGhIssues,
} from "../fetch/gh-issues.ts";
import { BucketBudgetExhaustedError } from "@bounded-systems/github-budget";
import {
  DepManifestError,
  formatDepManifestJson,
  formatDepManifestPlain,
  loadDepManifest,
} from "../dep-research/manifest.ts";
import { defaultFetchSource, fetchSources } from "../dep-research/fetch.ts";
import type { FetchSourceFn } from "../dep-research/fetch.ts";
import {
  buildSnapshot,
  formatRunId,
  writeSnapshot,
} from "../dep-research/snapshot.ts";
import {
  formatDepStatusJson,
  formatDepStatusPlain,
  loadDepStatus,
} from "../dep-research/status.ts";
import { depResearchMachine } from "../dep-research/machine.ts";
import { domainSyncMachine } from "../sync/machine.ts";
import { fetchMachine } from "../machine/machines/fetch.ts";
import {
  runBeadsSync,
  type RunBeadsSyncOptions,
} from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import {
  runBeadsSyncAcrossRepos,
  type RunBeadsSyncAcrossReposOptions,
} from "../sync/run-cross-repo.ts";
import {
  runBackfill,
  type RunBackfillOptions,
} from "../sync/backfill.ts";
import {
  runDoltReconcileAcrossRepos,
  type RunDoltReconcileAcrossReposOptions,
} from "../sync/run-dolt-reconcile-cross-repo.ts";
import { runMemoryCompact } from "../memory/compact.ts";
import {
  runHandoffEnqueue,
  runHandoffStatus,
  runHandoffDrain,
  runHandoffReplay,
} from "../handoff/cli.ts";
import {
  runTranscriptsDigest,
  runTranscriptsStatus,
  runTranscriptsListSources,
} from "../transcripts-digest/cli.ts";
import {
  formatScaffoldResult,
  scaffoldRepo,
  ScaffoldError,
} from "../init/scaffold.ts";
import { setAuditRuntimeContext } from "@bounded-systems/audit-context";
import { recordEvent as recordCatalogEvent } from "../machine/record_event.ts";
import {
  readRateLimitAuditRows,
  type RateLimitAuditEntry,
} from "@bounded-systems/github-budget";

// Shared default for the `SpawnLike` capture seams below. Routes through
// @bounded-systems/proc (imported as procRunner) rather than the bucket-gated github.ts
// defaultRunner — these are plain git/bd/tmux capture calls that must stay
// ungated — and maps a thrown spawn error back to the { status: null, error }
// result shape the seam callers branch on. (SpawnLike / SpawnLikeResult are
// declared later in the file; type aliases hoist.)
const procSpawnLike: SpawnLike = (file, args, options) => {
  try {
    const result = procRunner([file, ...args], {
      cwd: options.cwd,
      env: options.env ?? processEnv(),
      check: false,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

// Run an interactive (stdio-inherit) command and return its exit status. A
// spawn failure (e.g. the binary is missing) maps to 1 so callers' `status
// !== 0` checks fire — matching the prior raw spawn, which reported such
// failures as a null status.
function runInheritStatus(
  cmd: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  try {
    return procRunner(cmd, { ...options, stdio: "inherit", check: false }).status;
  } catch {
    return 1;
  }
}

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

// GH-1336: post-save cleanup spec for the `prx plan save` staging file.
// `none` preserves the legacy GH-1175 behavior (file persists). `delete`
// unlinks the `--from-file` path; `move-to` renames it under an
// already-existing directory. Cleanup runs strictly after runPlanSave
// returns success — the CAS writers throw on failure, so the exception
// bubbles past the cleanup site and the staging file is never touched
// on save failure.
type PlanSaveCleanupSpec =
  | { kind: "none" }
  | { kind: "delete" }
  | { kind: "move-to"; dest: string };

type ParsedCommand =
  | {
      command: "help";
    }
  | {
      command: "help-all";
    }
  | {
      // GH-1227: `prx <verb> --help` after the canonical verb is resolved.
      // The verb name is the post-namespace-rewrite token (e.g. "plan-show",
      // "tools-bd"). Renderer in handler looks up registry via findCommand.
      command: "help-verb";
      verb: string;
    }
  | {
      command: "session-help";
    }
  | {
      command: "plan-namespace-help";
    }
  | {
      // GH-1474: `prx intake --help` overview surface (registry-backed).
      command: "intake-namespace-help";
    }
  | {
      command: "version";
    }
  | {
      command: "tui";
      forwardArgs: string[];
    }
  | {
      command: "init";
      force: boolean;
      format: "plain" | "json";
    }
  | {
      command: "contract-init";
      outputPath: string;
      title?: string | undefined;
      summary?: string | undefined;
      ready: boolean;
      forceBeads: boolean;
      changeType: string[];
      generatedBy: string;
      untracked: boolean;
      format: "plain" | "json";
    }
  | {
      command: "status";
      contract: string;
      format: "plain" | "mode" | "json";
    }
  | {
      command: "transition";
      contract: string;
      to: LifecycleState;
      actor: string;
      reason?: string | null | undefined;
      format: "plain" | "json";
      log: string;
      id?: string | undefined;
    }
  | {
      command: "event";
      contract: string;
      skill: PrSkillName;
      actor: string;
      reason?: string | null | undefined;
      format: "plain" | "json";
      log: string;
      id?: string | undefined;
    }
  | {
      command: "contract";
      contract: string;
      actor: string;
      reason?: string | null | undefined;
      format: "plain" | "json";
      // GH-1821: contract-trinity read path. When `kind` or `list` is set,
      // serve from the AgentContract / ArtifactContract / TransitionContract
      // registries instead of the legacy pr.json contract.
      kind?: "agent" | "artifact" | "transition" | undefined;
      list?: boolean | undefined;
      id?: string | undefined;
    }
  | {
      command: "skills";
      contract: string;
      format: "plain" | "json";
    }
  | {
      command: "open-mode";
      contract: string;
      format: "mode" | "json" | "gh-create" | "gh-ready";
      pr?: string | undefined;
    }
  | {
      command: "graph";
      format:
        | "plain"
        | "json"
        | "xstate-json"
        | "xstate-ts"
        | "xstate-mermaid"
        | "mermaid"
        | "xstate-system-json"
        | "xstate-system-ts"
        | "xstate-system-mermaid"
        | "system-mermaid";
      outputPath?: string | undefined;
      validate: boolean;
      open: boolean;
      url: string;
    }
  | {
      command: "runtime-profile";
      profile: RuntimeProfileName;
      mode: RuntimeMode;
      agent?: string | undefined;
      workUnitId: string;
      ioFormat: RuntimeIoFormat;
      format: "plain" | "json";
      interactive: boolean;
      automation: boolean;
    }
  | {
      command: "session";
      invokedViaDeprecatedWorkAlias?: boolean | undefined;
      invokedViaDeprecatedSessionShorthand?: boolean | undefined;
      invokedViaDeprecatedRootOpen?: boolean | undefined;
      invokedViaPlanSession?: boolean | undefined;
      invokedViaSessionOpen?: boolean | undefined;
      mode: RuntimeMode;
      workUnitId: string;
      launchFromCurrentWorkspace?: boolean | undefined;
      agent: ExecutionWorkAgent;
      ioFormat: RuntimeIoFormat;
      format: "plain" | "json";
      prompt?: string | undefined;
      dryRun: boolean;
      check: boolean;
      create: boolean;
      from?: WorkUnitSource | undefined;
      noVerify: boolean;
      // GH-1643: registered bare-repo slug. When set, materialization +
      // launchCwd target that repo's worktree tree instead of process.cwd().
      // Implies --create.
      repoSlug?: string | undefined;
      // GH-1239: opt-out for the auto-step preflight that runs before
      // dispatchSessionEntryEvent under `prx plan session`. Loud — the
      // operator sees a stderr line confirming the skip fired.
      skipPreflight?: boolean | undefined;
    }
  | {
      command: "session-plan";
      workUnitId: string;
      format: "plain" | "json";
      dryRun: boolean;
      check: boolean;
      create: boolean;
      noVerify: boolean;
      interactive: boolean;
      emitFile?: string | undefined;
      // GH-1643: registered bare-repo slug. When set, materialization +
      // launchCwd target that repo's worktree tree instead of process.cwd().
      // Implies --create.
      repoSlug?: string | undefined;
      // GH-1239: opt-out for the auto-step preflight that runs before
      // dispatchSessionEntryEvent under `prx plan session`.
      skipPreflight?: boolean | undefined;
      // GH-950: source selector for materialization (gated by --create).
      from?: WorkUnitSource | undefined;
      // GH-1164: tags the variant when reached via `prx plan session` so the
      // handler can swap the user-facing banner and chain the print-mode
      // stdout into `prx plan save --slot draft`.
      invokedViaPlanSession?: boolean | undefined;
      // GH-1982: marker for the `prx session plan` alias path. The alias
      // dispatch also sets `invokedViaPlanSession: true` so the auto-save
      // chain fires; this flag only gates the one-line stderr hint so the
      // canonical entry stays silent.
      viaAlias?: boolean | undefined;
      // GH-1407: debug knob — invalidates the SDK prompt-cache prefix via a
      // per-run nonce, so the operator can compare cold/warm latency + cost.
      // Non-interactive only (the interactive plan session uses the CLI
      // subprocess, which has its own internal caching).
      noCache?: boolean | undefined;
      // GH-1825: opt-in watchdog for the non-interactive SDK call site. When
      // omitted, the print path runs with no timeout (matches spike §3.2
      // "no baked-in default"). Bare numbers stay in the parseDurationMs
      // contract (treated as minutes); explicit `--timeout=30000ms` works too.
      timeoutMs?: number | undefined;
      // GH-1825: resume continuation of a previously cancelled plan-print run
      // by reading `<UoW>:plan@draft` and threading the partial content into
      // the planner's user prompt. Print mode only.
      resumeFromDraft?: boolean | undefined;
    }
  | {
      command: "session-open-claude";
      workUnitId: string;
      launchFromCurrentWorkspace?: boolean | undefined;
      format: "plain" | "json";
      dryRun: boolean;
      noAttach: boolean;
      // GH-2014: when "background", the handler skips `attachMuxSession`
      // and prints a re-entry hint instead of inheriting the tmux TTY.
      // Distinct from --no-attach (which is scripted/silent).
      attachMode: "foreground" | "background";
      invokedViaDeprecatedWorkAlias?: boolean | undefined;
      invokedViaPlanSession?: boolean | undefined;
      invokedViaSessionOpen?: boolean | undefined;
      planPath?: string | undefined;
      // GH-1643: registered bare-repo slug from `--repo <slug>`. When set,
      // primePlanSession resolves materialization + launchCwd against the
      // target bare-repo's worktree tree (implies --create).
      repoSlug?: string | undefined;
      // GH-1239: see the `session` variant — auto-step opt-out propagates
      // through both dispatch paths so the planner can skip preflight on
      // either entry shape.
      skipPreflight?: boolean | undefined;
    }
  | {
      // GH-1172: dedicated dispatch path for `prx implement`. Previously
      // `parseImplementCommand` returned `session-open-claude`, which routed
      // the executor verb through the read-only plan profile (Edit/Write
      // disabled at the flag layer per GH-1147). The new variant carries the
      // same fields but dispatches `OPEN_IMPLEMENT_SESSION` and tags the tmux
      // session name with `-implement` so plan and implement sessions for the
      // same work unit coexist on the prx tmux socket.
      command: "session-open-implement";
      workUnitId: string;
      launchFromCurrentWorkspace?: boolean | undefined;
      format: "plain" | "json";
      dryRun: boolean;
      noAttach: boolean;
      // GH-2014: foreground vs background tmux attach. Distinct from --no-attach
      // (which is scripted/silent).
      attachMode: "foreground" | "background";
      planPath?: string | undefined;
      // headless-first step 2b-i: run the implement work as an async SDK job
      // (buildWorkUnitClaudeImplementSdkRuntimeProfile via executeAgentProfile)
      // in-process — no tmux, typed envelope result. Opt-in for now; becomes the
      // default in 2b-ii. See docs/spikes/headless-first-profiles.md.
      headless?: boolean | undefined;
      // headless-first step 2b-ii: explicit opt-in to the interactive tmux/PTY
      // pairing path. Absent (the new default) dispatches an async detached
      // headless job instead of opening a tmux session.
      interactive?: boolean | undefined;
      // GH-1981: set when the operator entered via the deprecated
      // `prx implement session <UoW>` shape (renamed to `agent`). The
      // dispatcher emits a one-shot stderr hint and proceeds with the
      // canonical handler.
      invokedViaDeprecatedImplementSession?: boolean | undefined;
    }
  | {
      // GH-1056: pre-tmux setup of `prx plan session` exposed as its own verb.
      // Runs validate → materialize → rebase → hydrate (beads/MCP/allowlist),
      // then exits 0 with a status line. No XState session-entry, no tmux spawn.
      command: "plan-prime";
      workUnitId: string;
      launchFromCurrentWorkspace?: boolean | undefined;
      agent: ExecutionWorkAgent;
      isInteractiveClaude: boolean;
      create: boolean;
      noVerify: boolean;
      from?: WorkUnitSource | undefined;
      format: "plain" | "json";
    }
  | {
      command: "review";
      workUnitId?: string | undefined;
      ultra: boolean;
      format: "plain" | "json";
    }
  | {
      command: "agent-smoke";
      mode: RuntimeMode;
      workUnitId: string;
      launchFromCurrentWorkspace?: boolean | undefined;
      ioFormat: RuntimeIoFormat;
      format: "plain" | "json";
      create: boolean;
      noVerify: boolean;
    }
  | {
      command: "check-issue";
      workUnitId: string;
      format: "plain" | "json";
    }
  | {
      command: "check-session";
      workUnitId: string;
      format: "plain" | "json";
    }
  | {
      command: "check-chain";
      workUnitId: string;
      format: "plain" | "json";
    }
  | {
      command: "mainx";
      format: "plain" | "json";
    }
  | {
      command: "close";
      workUnitId: string;
      format: "plain" | "json";
      dryRun: boolean;
      mainxReset: boolean;
      emitNext: boolean;
      emitFile?: string | undefined;
      force: boolean;
    }
  | {
      // GH-1057: `prx plan close` — close-without-merge wrapper. Distinct
      // from `close` (post-merge cleanup); see `planClose()` below.
      command: "plan-close";
      workUnitId: string;
      reason: PlanCloseReason;
      upstream: string | null;
      dryRun: boolean;
      emitNext: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1173: operator-facing verbs over the GH-1174 CAS plan store.
      command: "plan-save";
      workUnitId?: string | undefined;
      slot: "draft" | "approved";
      source: { kind: "stdin" } | { kind: "file"; path: string };
      format: "plain" | "json";
      // GH-1277: --skip-validate persists a malformed slot; CLI emits a
      // stderr warning so operators see the escape hatch fired.
      skipValidate: boolean;
      // GH-1336: post-save cleanup for the staging file. `none` preserves
      // the legacy behavior; `delete`/`move-to` run only after runPlanSave
      // resolves so the staging file is untouched on save failure.
      cleanup: PlanSaveCleanupSpec;
    }
  | {
      command: "plan-load";
      workUnitId: string;
      slot: "draft" | "approved";
      slotExplicit: boolean;
      format: "raw" | "json";
    }
  | {
      command: "plan-show";
      workUnitId: string;
      slot: "draft" | "approved" | undefined;
      format: "text" | "json";
      paths: boolean;
    }
  | {
      // GH-1239: deterministic pre-draft preflight (already-done /
      // allowlist-feasibility / blocked-by-open-deps).
      command: "plan-preflight";
      workUnitId: string;
      format: "plain" | "json";
    }
  | {
      // GH-1186: planner-side read primitives — twins of `intake-view` /
      // `intake-search`. Pure reads that route through the shared
      // `src/issues/` core; see plan-view.ts / plan-search.ts.
      command: "plan-view";
      id: string;
      format: "plain" | "json";
    }
  | {
      command: "plan-search";
      query: string;
      state: "open" | "closed" | "all";
      source: "gh" | "beads" | "both";
      limit: number;
      format: "plain" | "json";
    }
  | {
      // GH-885 + GH-882: doctor actor verbs — PR readiness diagnosis +
      // guarded transitions. `verb` selects the action; the work-unit id is
      // resolved from the cwd worktree when omitted (same shape as
      // `prx implement`).
      command: "doctor";
      verb: "inventory" | "merge" | "ready" | "draft";
      workUnitId: string;
      format: "plain" | "json";
      method?: "MERGE" | "SQUASH" | "REBASE" | undefined;
      noUpdateBranch?: boolean | undefined;
      // GH-2249: anchored-chain ledger path. When set with
      // PRX_REQUIRE_SIGNED_DERIVATIONS, the merge/ready gate re-verifies the
      // head commit's derivations (I-PROV1). Absent ⇒ no provenance gate.
      ledger?: string | undefined;
    }
  | {
      // GH-1559 (GH-1398 ADR §4): publisher actor verbs — the PR
      // publication transitions moved off `doctor`. Same parse shape as the
      // doctor verbs (work-unit resolved from the cwd worktree when omitted);
      // `--method` / `--no-update-branch` only apply to `merge`.
      command: "publisher";
      verb: "merge" | "ready" | "draft";
      workUnitId: string;
      format: "plain" | "json";
      method?: "MERGE" | "SQUASH" | "REBASE" | undefined;
      noUpdateBranch?: boolean | undefined;
      // GH-2249: anchored-chain ledger for the merge-guard provenance gate.
      ledger?: string | undefined;
    }
  | {
      // GH-1560: `prx publisher pr open|update` — forge PR-open / update-branch.
      // ai-home-2ow2v: + comment|edit (forge `gh pr comment` / `gh pr edit`).
      command: "publisher-pr";
      verb: "open" | "update" | "comment" | "edit";
      workUnitId: string;
      format: "plain" | "json";
      title?: string | undefined;
      closes?: string[] | undefined;
      base?: string | undefined;
      ready: boolean;
      body?: string | undefined;
      bodyFile?: string | undefined;
    }
  | {
      // GH-2282: read-only print of the persisted dev provenance identity
      // (the keypair `PRX_PROVENANCE_KEY=dev` signs with). Generate-on-demand
      // to match resolver semantics, so it doubles as a bootstrap-and-inspect
      // command for the zero-config dev sign → enforce → verify loop.
      command: "provenance-dev-pubkey";
      format: "plain" | "json";
    }
  | {
      // GH-1533: read-back over the unified audit sink — summarizes recent
      // `gh` GraphQL spend grouped by prx verb. `since` is a lookback window
      // in ms (default 1h); the handler resolves which daily NDJSON files to
      // read from the current time minus the window.
      command: "doctor-gh-budget";
      sinceMs: number;
      format: "plain" | "json";
    }
  | {
      // GH-1508: ADR §6 dedupe verb. Operator-initiated, dry-run-by-default;
      // `--apply` flips it to writing. Substrate-wide scan, no work-unit
      // binding.
      command: "doctor-dedupe-bd";
      apply: boolean;
      // GH-2379: scope `--apply` to the named cluster(s); repeatable; requires
      // `--apply`. Empty = apply all clusters.
      only: string[];
      format: "plain" | "json";
    }
  | {
      // GH-1823 — `prx audit <verb>` adherence-metric verb.
      command: "audit-ingest";
      since?: string | undefined;
      format: "plain" | "json";
    }
  | {
      command: "audit-uow";
      workUnitId: string;
      format: "plain" | "json";
    }
  | {
      command: "audit-system";
      since?: string | undefined;
      format: "plain" | "json";
    }
  | {
      // GH-1407 — `prx services status` projects prompt-cache hit rate from
      // non-interactive-agent/usage rows.
      command: "services-status";
      anthropic: boolean;
      window?: string | undefined;
      by: "profile" | "actor" | "workUnitId";
      format: "plain" | "json";
    }
  | {
      // GH-1194: per-actor dispatch envelope. The leading source flag is
      // injected by normalizeNamespaceArgv (or by intake/implement passthrough);
      // target defaults to source for self-dispatch.
      command: "dispatch";
      source: DispatchActor;
      target: DispatchActor;
      action: string;
      argv: string[];
    }
  | {
      // GH-1194 (sub-ticket D): first concrete scout FS-exploration verb.
      command: "scout-grep";
      pattern: string;
      in?: string | undefined;
      pathPrefix?: string | undefined;
      maxResults: number;
      format: "jsonl" | "json";
    }
  | {
      // GH-1384 PR-1: bounded glob walk over the repo tree.
      command: "scout-files";
      pattern: string;
      in?: string | undefined;
      maxResults: number;
      format: "jsonl" | "json";
    }
  | {
      // GH-1384 PR-2: bounded text-only single-file read.
      command: "scout-read";
      path: string;
      in?: string | undefined;
      maxBytes: number;
      format: "json";
      // Emit the SLSA Provenance v1 statement instead of the read envelope.
      provenance: boolean;
      // Record the read as a derivation in the anchored-chain ledger at this path.
      ledger?: string | undefined;
    }
  | {
      // GH-1244: read-only beads/Dolt projection. Reads the local
      // substrate (no external HTTP), parses kind/scope from titles,
      // projects ghNumber + native dependency edges as `links`.
      command: "scout-issues";
      query: string;
      state: "open" | "closed" | "all";
      repo?: string | undefined;
      max?: number | undefined;
      maxStaleness: string;
      format: "jsonl" | "plain";
    }
  | {
      // GH-1420: Notion page UUID / Task-ID → structured mirror record.
      command: "scout-notion";
      id: string;
      noMirrors: boolean;
      format: "json";
    }
  | {
      // GH-1245 → GH-1603 — fetch verb. `--dry-run` projects an
      // external→substrate refresh cost; without it, the verb paginates
      // through `gh api graphql` and writes per page to bd with a
      // per-page watermark advance (I-F4 + I-F5).
      command: "fetch-gh-issues";
      repo?: string | undefined;
      since?: string | undefined;
      budget?: number | undefined;
      dryRun: boolean;
      format: "json";
    }
  | {
      // GH-1768: derive verbs. One variant per subverb so narrowing on
      // `parsed.command === "derive-X"` removes a single shape from the
      // union.
      command: "derive-ready";
      fixturePath?: string | undefined;
      issueFilter?: string | undefined;
      format: "plain" | "json";
      positionals: string[];
    }
  | {
      command: "derive-drift";
      fixturePath?: string | undefined;
      issueFilter?: string | undefined;
      format: "plain" | "json";
      positionals: string[];
    }
  | {
      command: "derive-eligible";
      fixturePath?: string | undefined;
      issueFilter?: string | undefined;
      format: "plain" | "json";
      positionals: string[];
    }
  | {
      command: "derive-why";
      fixturePath?: string | undefined;
      issueFilter?: string | undefined;
      format: "plain" | "json";
      positionals: string[];
    }
  | {
      command: "derive-dump-facts";
      fixturePath?: string | undefined;
      issueFilter?: string | undefined;
      format: "plain" | "json";
      positionals: string[];
    }
  | {
      // GH-1423: rules render — emit core.md from typed inputs to stdout.
      command: "rules-render";
      format: "plain" | "json";
    }
  | {
      // GH-1423: rules validate — run assertions against `--path <file>`.
      command: "rules-validate";
      path: string;
      format: "plain" | "json";
    }
  | {
      // GH-1423: rules inputs — dump loaded inputs as JSON for debugging.
      command: "rules-inputs";
      format: "plain" | "json";
    }
  | {
      command: "beads-init";
      importGh: boolean;
      dryRun: boolean;
    }
  | {
      // GH-1706: embedded → shared-server migration verb. `slug` is optional;
      // when omitted, resolves the registered repo from cwd via
      // `localRepoForCwd` so an operator inside a worktree can run the verb
      // without re-typing the slug.
      command: "beads-migrate";
      slug?: string | undefined;
      dryRun: boolean;
      patchMetadata: boolean;
      staleThresholdSeconds: number;
    }
  | {
      // GH-1261 (PR-1): read-only inspector — prints the parsed dep-research
      // manifest. PR-2/PR-3 add `dep research` and `dep status`.
      command: "dep-manifest";
      format: "plain" | "json";
    }
  | {
      // GH-1274 (PR-2 of GH-1261): snapshot + fetch verb. `--dry-run` writes
      // to a tmpdir and prints the DepSnapshot to stdout; the bare form
      // writes atomically under .prx/dep-research/<dep>/<run_id>/.
      command: "dep-research";
      dep: string;
      dryRun: boolean;
    }
  | {
      // GH-1275 (PR-3 of GH-1261): read-only inspector over the snapshot
      // tree. Reports last_run_id + recomputed classification per dep.
      command: "dep-status";
      format: "plain" | "json";
    }
  | {
      command: "desktop";
      workUnitId: string;
      launchFromCurrentWorkspace?: boolean | undefined;
      agent: "codex";
      format: "plain" | "json";
      dryRun: boolean;
    }
  | {
      command: "task";
      action: "sync" | "status" | "run" | "graph";
      taskPath: string;
      workUnitId: string;
      beadId?: string | undefined;
      sourceVersion?: string | undefined;
      sourceHash?: string | undefined;
      agent?: WorkAgentImplementation | undefined;
      format: "plain" | "json";
      dryRun: boolean;
      confirmScope: boolean;
      confirmSuccess: boolean;
    }
  | {
      command: "task-spec";
      action: "init" | "show" | "validate";
      taskPath: string;
      workUnitId: string;
      beadId?: string | undefined;
      format: "plain" | "json";
      dryRun: boolean;
    }
  | {
      command: "role";
      action: "start" | "complete" | "fail";
      role: TaskRole;
      taskPath: string;
      workUnitId: string;
      agent?: WorkAgentImplementation | undefined;
      reason?: string | undefined;
      format: "plain" | "json";
      dryRun: boolean;
    }
  | {
      command: "repos";
      action: "list" | "normalize";
      roots: string[];
      everywhere: boolean;
      local: boolean;
      names: string[];
      apply: boolean;
      format: "plain" | "json";
    }
  | {
      command: "repo-audit";
      format: "plain" | "json";
    }
  | {
      command: "repos-add";
      url: string;
      overlay: boolean;
      format: "plain" | "json";
      bdWorkspacePrefix: string | null;
      canonical: "gh" | "bd";
      // GH-1682: `--repair` makes `prx repo add <git-url>` idempotent — on a
      // re-run against an already-registered repo it delegates to the PR-C
      // refresh path instead of throwing `bare_path_exists`.
      repair: boolean;
      repairDryRun: boolean;
      repairNoFetch: boolean;
    }
  | {
      // GH-1710 / GH-2013: `prx repo set <axis> <slug> --to=<value>`.
      command: "repos-set";
      axis: "canonical" | "stale-threshold-days" | "bd-workspace-prefix" | "dolt-remote";
      slug: string;
      to: string;
      format: "plain" | "json";
    }
  | {
      command: "repos-materialize";
      name: string;
      format: "plain" | "json";
      dryRun: boolean;
      ttlSeconds: number | null;
    }
  | {
      // GH-1722: `prx repo backfill` — populate `bd_workspace_prefix` on
      // stale inventory entries that predate GH-1680's `.beads/` hydration.
      command: "repos-backfill";
      format: "plain" | "json";
      dryRun: boolean;
    }
  | {
      // GH-1681: `prx repo refresh <slug>` — operator recovery surface for
      // a transient hydrate failure (`clone-failed`) or a legacy pre-GH-1679
      // bare clone whose fetch refspec is still heads-only.
      command: "repo-refresh";
      slug: string;
      dryRun: boolean;
      noFetch: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1700: `prx repo gc [<slug>]` — sweep migration orphans left by
      // `prx beads migrate` (`.beads/embeddeddolt/<dbname>/`). Dry-run by
      // default; `--apply` mutates after confirming GC-I1..I3 invariants.
      command: "repos-gc";
      slug: string | null;
      apply: boolean;
      yes: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1703: `prx repo add-dolthub` — wire a Dolthub remote on an
      // already-registered per-project beads workspace.
      command: "repos-add-dolthub";
      slug: string | null;
      dolthubUser: string | null;
      name: string | null;
      noPush: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1704: `prx repo bootstrap` — bootstrap a fresh shared-server
      // .beads/ workspace on a registered, beads-less repo.
      command: "repos-bootstrap";
      slug: string | null;
      prefix: string | null;
      shipMetadata: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1760: `prx repo adopt --from-worktree <path>` — read-only git
      // inference + idempotent registry write into the sqlite registry.
      command: "repos-adopt";
      fromWorktree: string;
      format: "plain" | "json";
    }
  | {
      // GH-1761: `prx branch adopt --from-worktree <path>
      // [--detached-as <name>]` — register the current branch in the registry.
      command: "branch-adopt";
      fromWorktree: string;
      detachedAs: string | null;
      format: "plain" | "json";
    }
  | {
      // GH-1762: `prx workspace adopt [<path>] [--mode read|write]
      // [--detached-as <name>]` — register the on-disk worktree in the
      // registry. Auto-chains `repo adopt` + `branch adopt` (idempotent).
      command: "workspace-adopt";
      fromWorktree: string;
      mode: "read" | "write";
      detachedAs: string | null;
      format: "plain" | "json";
    }
  | {
      command: "overview";
      // GH-1757: optional slug positional — when set, resolve the target
      // repo via `locateRepo` (registered slug → mainWorktree) instead of
      // using `repoPath`. When null, preserve the cwd / `--repo-path` flow.
      slug: string | null;
      repoPath: string;
      format: "plain" | "json";
      includeDiffStats: boolean;
    }
  | {
      command: "worktree";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "worktrees";
      repoPath: string;
      format: "plain" | "json";
      includeGitDetails: boolean;
    }
  | {
      command: "worktree-remove";
      repoPath: string;
      target: string;
      format: "plain" | "json";
      force: boolean;
      prune: boolean;
      deleteBranch: boolean;
      dryRun: boolean;
    }
  | {
      // GH-1978: `prx workspace <verb> [flags]`. The verb + flag parser lives
      // in `src/workspace/cli.ts`; this branch only carries the raw argv tail
      // (e.g. `["reserve", "--branch", "GH-1978"]`).
      command: "workspace";
      argv: string[];
    }
  | {
      // GH-2026/GH-2327: `prx gc <verb> [flags]`. The verb + flag parser lives
      // in `src/machine/gc/cli.ts`; this branch only carries the raw argv tail
      // (e.g. `["teardown", "GH-1234", "--dry-run"]`).
      command: "gc";
      argv: string[];
      // 2l4ua: set when reached via the deprecated `prx prune --ticket` alias —
      // the dispatch emits PRX_PRUNE_GC_ALIAS_HINT once.
      viaAlias?: boolean;
    }
  | {
      command: "tools-wt";
      action:
        | "path"
        | "env"
        | "exec"
        | "ensure-branch"
        | "ensure-prx-excludes"
        | "run-hook"
        | "bootstrap";
      format: "plain" | "json";
      execArgs: string[];
      source: boolean;
      parentPid?: string | undefined;
      branchName?: string | undefined;
      base?: string | undefined;
      skip?: string[] | undefined;
      hookEvent?: string | undefined;
      strict?: boolean | undefined;
    }
  | {
      command: "tools-git";
      format: "plain" | "json";
      subcommand: string;
      passArgs: string[];
      cwd?: string | undefined;
    }
  | {
      // GH-2353 (GH-2348.3): `prx keeper <verb>` — git-write / ref custody.
      command: "keeper";
      format: "plain" | "json";
      verb: "push" | "branch" | "commit";
      passArgs: string[];
      // GH-2346: commit message for `keeper commit` (add -A + commit).
      message?: string | undefined;
      // GH-2348.2: anchored-chain ledger for the attested `keeper push`.
      ledger?: string | undefined;
      cwd?: string | undefined;
    }
  | {
      command: "tools-bd";
      format: "plain" | "json";
      subcommand: string;
      passArgs: string[];
      cwd?: string | undefined;
    }
  | {
      command: "tools-labels-sync";
      format: "plain" | "json";
      repo?: string | undefined;
      prune: boolean;
      dryRun: boolean;
    }
  | {
      command: "preflight-claude";
      format: "plain" | "json";
    }
  | {
      command: "preflight-notion-mcp";
      format: "plain" | "json";
    }
  | {
      command: "repos-local";
      format: "plain" | "json";
      scanHome: string;
      strict: boolean;
      countOnly: boolean;
    }
  | {
      command: "beads-hydrate";
      format: "plain" | "json";
      cwd?: string | undefined;
      dryRun: boolean;
    }
  | {
      command: "beads-issue";
      issueNumber: number;
      format: "plain" | "json" | "id";
    }
  | {
      command: "beads-publish";
      bdId: string;
      repo?: string | undefined;
      dryRun: boolean;
      noAdopt: boolean;
      format: "plain" | "json";
    }
  | {
      command: "beads-sync";
      format: "plain" | "json";
      repo?: string | undefined;
      domain: string;
      dryRun: boolean;
      budget?: number | undefined;
      limit: number;
      /** GH-1662: cross-repo daemon mode — walk the .prx inventory. */
      allRepos: boolean;
    }
  | {
      // GH-1702: cross-repo fan-out of `prx dolt reconcile`.
      command: "beads-sync-all";
      format: "plain" | "json";
      mode: "full" | "push-only" | "pull-only";
      repo?: string | undefined;
      dryRun: boolean;
      resolve?: "schema-prefer-remote" | undefined;
    }
  | {
      // GH-1990: `prx sync issues --from <src> --to <dst>`. v0 wires only the
      // `gh → bd` pair (delegates to `runBdGithubSyncPullOnly`). Other pairs
      // are accepted by the parser but the executor returns a deferred-pair
      // error pointing at the follow-up.
      command: "sync-issues-pair";
      from: string;
      to: string;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1469: `prx sync backfill --domain gh --from N --to M`. Range-backfill
      // of cursor-skipped external records via `runBackfill`.
      command: "sync-backfill";
      domain: string;
      from: number;
      to: number;
      repo?: string | undefined;
      budget?: number | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "memory-compact";
      format: "plain" | "json";
      repo?: string | undefined;
      apply: boolean;
      horizonDays: number;
      messageHorizonDays: number;
      messageIssueTypes: string[];
      preservedTypes: string[];
      limit: number;
    }
  | {
      // GH-1397: structured handoff queue.
      command: "handoff-enqueue";
      target: string;
      verb: string;
      workUnitId?: string | undefined;
      argsFile?: string | undefined;
      argsLiteral?: string | undefined;
      dedupKey?: string | undefined;
      sourceActor?: string | undefined;
      format: "plain" | "json";
    }
  | {
      command: "handoff-status";
      target?: string | undefined;
      workUnitId?: string | undefined;
      state?: "pending" | "claimed" | "draining" | "done" | "failed" | "abandoned" | undefined;
      showStale: boolean;
      format: "plain" | "json";
    }
  | {
      command: "handoff-drain";
      actor: string;
      once: boolean;
      max: number;
      format: "plain" | "json";
    }
  | {
      command: "handoff-replay";
      id: string;
      format: "plain" | "json";
    }
  | {
      // GH-1495: `prx transcripts digest` — temporal→durable memory pipeline.
      command: "transcripts-digest";
      source: "claude-code-jsonl" | "claude-web-export";
      inputPath?: string | undefined;
      project?: string | undefined;
      sessionId?: string | undefined;
      since?: string | undefined;
      limit?: number | undefined;
      mode: "dry-run" | "stage" | "commit";
      format: "plain" | "json";
    }
  | {
      // GH-1495: `prx transcripts status` — TTL pressure + candidate counts.
      command: "transcripts-status";
      format: "plain" | "json";
    }
  | {
      // GH-1495: `prx transcripts list-sources` — adapter registry introspect.
      command: "transcripts-list-sources";
      format: "plain" | "json";
    }
  | {
      command: "repo-status";
      repoPath: string;
      format: "plain" | "json";
      includeGitDetails: boolean;
      fetch: boolean;
    }
  | {
      command: "remote-ci-check";
      repoPath: string;
      pr?: string | undefined;
      format: "plain" | "json";
    }
  | {
      command: "scout-logs";
      repoPath: string;
      pr?: string | undefined;
      maxLines: number;
      format: "plain" | "json";
    }
  | {
      command: "pr-comments";
      repoPath: string;
      action: "show" | "resolve";
      pr?: string | undefined;
      format: "plain" | "json";
      outputPath?: string | undefined;
      write: boolean;
      threadIds: string[];
      resolveAll: boolean;
    }
  | {
      command: "repo-checks";
      repoPath: string;
      repo?: string | undefined;
      branch: string;
      format: "plain" | "json";
    }
  | {
      command: "reconcile" | "prune" | "backfill";
      repoPath: string;
      mode: SurfaceSyncMode;
      authority: SurfaceSyncAuthority;
      scope: SurfaceSyncScope;
      apply: boolean;
      ticket?: string | undefined;
      mergedOnly?: boolean | undefined;
      format: "plain" | "json";
    }
  | {
      command: "prune-session";
      repoPath: string;
      workUnitId: string;
      apply: boolean;
      format: "plain" | "json";
    }
  | {
      command: "tools-mux-clear-resurrect";
      sessionName: string;
      format: "plain" | "json";
    }
  | {
      command: "protect-main";
      repoPath: string;
      backend: ProtectMainBackend;
      repo?: string | undefined;
      branch: string;
      apply: boolean;
      check: boolean;
      solo: boolean;
      allow: string[];
      strict: boolean;
      enforceAdmins?: boolean | undefined;
      requireConversationResolution?: boolean | undefined;
      requireLastPushApproval?: boolean | undefined;
      requireLinearHistory?: boolean | undefined;
      requiredStatusChecks?: string[] | undefined;
      format: "plain" | "json";
    }
  | {
      command: "chains";
      repoPath: string;
      remote: boolean;
      format: "plain" | "json";
    }
  | {
      command: "repair-bd";
      repoPath: string;
      all: boolean;
      format: "plain" | "json";
    }
  | {
      command: "delegate-next";
      repoPath: string;
      filters: {
        epic?: string | undefined;
        area?: string | undefined;
        priority?: number | undefined;
        type?: string | undefined;
        all: boolean;
      };
      format: "plain" | "json";
    }
  | {
      command: "delegate-assign";
      repoPath: string;
      id: string;
      agent?: string | undefined;
      self: boolean;
      unassign: boolean;
    }
  | {
      command: "delegate-repair-assignees";
      repoPath: string;
      from: string;
      to: string;
      apply: boolean;
    }
  | {
      command: "actions";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "next-action";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "do";
      repoPath: string;
      actionId: string;
      contract: string;
      actor?: string | undefined;
      reason?: string | undefined;
      format: "plain" | "json";
      log: string;
      id?: string | undefined;
    }
  | {
      command: "phase";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "actors";
      scope: ActorScope;
      format: "plain" | "json";
    }
  | {
      command: "model";
      scope: ActorScope;
      format: "plain" | "json";
    }
  | {
      command: "refresh";
      repoPath: string;
      noPush: boolean;
      local: boolean;
      format: "plain" | "json";
    }
  | {
      command: "snapshot";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "statusline";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "sprint";
      action: "init" | "bind" | "metric" | "status" | "sync-notion";
      sprintPath: string;
      repoPath: string;
      format: "plain" | "json";
      apply: boolean;
      sprintId?: string | undefined;
      goal?: string | undefined;
      metricName?: string | undefined;
      targetDelta?: number | undefined;
      weekStart?: string | undefined;
      weekEnd?: string | undefined;
      pr?: number | undefined;
      ticket?: string | undefined;
      unit?: string | undefined;
      baseline?: number | undefined;
      current?: number | undefined;
    }
  | {
      command: "update";
      contract: string;
      outputPath: string;
      pr?: string | undefined;
      repoPath: string;
      apply: boolean;
      format: "plain" | "json";
    }
  | {
      command: "sync-status";
      repoPath: string;
      apply: boolean;
      format: "plain" | "json";
    }
  | {
      command: "sync-issues";
      repoPath: string;
      apply: boolean;
      format: "plain" | "json";
    }
  | {
      command: "stately";
      url: string;
      noWait: boolean;
      model: "lifecycle" | "system";
    }
  | {
      command: "hooks-apply";
      hooksPath: string;
      everywhere: boolean;
      format: "plain" | "json";
    }
  | {
      command: "hooks-status";
      hooksPath: string;
      everywhere: boolean;
      format: "plain" | "json";
    }
  | {
      command: "home-update";
      flakeDir?: string | undefined;
      input?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
      verbose: boolean;
    }
  | {
      command: "home-sync";
      flakeDir?: string | undefined;
      input?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "dolt-reconcile";
      repoPath: string;
      dryRun: boolean;
      format: "plain" | "json";
      resolve?: "schema-prefer-remote" | undefined;
    }
  | {
      command: "dolt-status";
      repoPath: string;
      format: "plain" | "json";
    }
  | {
      command: "dolt-stub";
      verb: DoltVerb;
      tracking: string;
      format: "plain" | "json";
    }
  | {
      command: "tmux-reconcile";
      socket: string;
      configPath?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "intake";
      type: IntakeIntent;
      title: string;
      scope?: string | undefined;
      body?: string | undefined;
      bodyFile?: string | undefined;
      bodyStdin: boolean;
      description?: string | undefined;
      design?: string | undefined;
      acceptance?: string | undefined;
      notes?: string | undefined;
      labels: string[];
      assignees: string[];
      repo?: string | undefined;
      to?: "gh" | undefined;
      dryRun: boolean;
      yes: boolean;
      format: "plain" | "json";
    }
  | {
      // prx-lfv: the structured intake-result tool the agent reports through.
      command: "intake-result";
      disposition: "filed" | "merged" | "duplicate" | "no_action";
      uow?: string | undefined;
      reason?: string | undefined;
    }
  | {
      // prx-9p9: the structured triage-result tool the triage agent reports through.
      command: "triage-result";
      disposition: "classified" | "promoted" | "deferred" | "merged" | "no_action";
      uow?: string | undefined;
      reason?: string | undefined;
    }
  | {
      command: "intake-session";
      dryRun: boolean;
      check: boolean;
      format: "plain" | "json";
      // GH-2380: headless-first. Default runs the headless SDK job;
      // `--interactive` opts into the legacy tmux/PTY session.
      interactive?: boolean | undefined;
      // prx-28w: free-text seed (`--message`) — intake THIS item.
      message?: string | undefined;
    }
  | {
      command: "intake-view";
      id: string;
      format: "plain" | "json";
    }
  | {
      command: "intake-search";
      query: string;
      state: "open" | "closed" | "all";
      format: "plain" | "json";
    }
  | {
      command: "intake-status";
      repo?: string | undefined;
      limit: number;
      format: "plain" | "json";
      includeIntentional: boolean;
      rateLimit: boolean;
    }
  | {
      command: "intake-merge";
      dupId: string;
      canonicalId: string;
      template?: string | undefined;
      reason: "completed" | "not planned" | "duplicate";
      label?: string | undefined;
      repo?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "intake-comment";
      canonicalId: string;
      body?: string | undefined;
      bodyFile?: string | undefined;
      bodyStdin: boolean;
      repo?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "intake-mirror";
      ghId: string;
      repo?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "intake-bd-ls";
      status?: string | undefined;
      limit: number;
      format: "plain" | "json";
    }
  | {
      command: "intake-bd-memory-ls";
      search?: string | undefined;
      format: "plain" | "json";
    }
  | {
      command: "intake-bd-memory-get";
      key: string;
      format: "plain" | "json";
    }
  | {
      command: "intake-bd-memory-set";
      key: string;
      body: string;
      format: "plain" | "json";
    }
  | {
      // GH-1318: `prx submit body-template --closes <id> [...]` — pre-merge
      // emitter that renders `Closes #N` markdown for paste into
      // `gh pr create --body-file`. Pure-data; no gh I/O at this layer.
      command: "submit-body-template";
      closes: string[];
      repo?: string | undefined;
      prefix?: string | undefined;
      suffix?: string | undefined;
      format: "plain" | "json";
    }
  | {
      // GH-1318: `prx submit postmerge <pr-number>` — post-merge body sweep
      // + close for issues GitHub did not auto-close at merge (the
      // PR-title `(GH-N)` suffix is decorative, not a close keyword).
      command: "submit-postmerge";
      prNumber: number;
      repo?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
      commentTemplate?: string | undefined;
    }
  | {
      // GH-1740: `prx submit session` — submit operator session.
      // GH-1900: work-unit-bound. Mirrors author-session: requires a
      // canonical work-unit id positional; --check is the cwd/profile
      // readiness probe and may run without a positional; --dry-run prints
      // the resolved profile.
      command: "submit-session";
      workUnitId: string;
      dryRun: boolean;
      check: boolean;
      format: "plain" | "json";
      // GH-2380: headless-first. See intake-session.
      interactive?: boolean | undefined;
    }
  | {
      // GH-2262: `prx submit stage <work-unit-id>` — producer that resolves
      // git state into a CAS submit artifact and advances `<UoW>:submit@<slot>`,
      // the ref `submit publish` consumes.
      command: "submit-stage";
      workUnitId: string;
      slot: "draft" | "ready";
      baseRef: string;
      summary?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1900: `prx submit publish --from-cas <ref>` — consumer of the
      // submit-session artifact. Reads the CAS-backed artifact, runs the
      // parity preflight, pushes the head branch, opens the PR, and advances
      // the ref to `<UoW>:submit@published`.
      command: "submit-publish";
      fromCas: string;
      dryRun: boolean;
      // GH-2267: open ready-for-review instead of draft (default draft).
      ready: boolean;
      format: "plain" | "json";
      // GH-2269: opt-in anchored-chain ledger path. When set (and a signer is
      // configured via PRX_PROVENANCE_KEY), a clean push emits a signed SLSA
      // `push/v1` derivation here. Absent ⇒ no emission.
      ledger?: string | undefined;
    }
  | {
      // GH-1206: `prx author session <id>` — work-unit PR author session.
      // Mirrors implement-session's shape (work-unit bound) but the profile
      // is read+gh-pr-only — no Edit/Write on source, no `git push`.
      command: "author-session";
      workUnitId: string;
      dryRun: boolean;
      check: boolean;
      format: "plain" | "json";
      // GH-2380: headless-first. See intake-session.
      interactive?: boolean | undefined;
    }
  | {
      // GH-2394: `prx scratch` — ad-hoc, work-unit-UNBOUND least-privilege
      // Claude session, safe by default. `--unsafe` is the single escape hatch
      // back to ambient authority. No positional (unbound); launches in the
      // current cwd with no workspace reserve. `--dry-run` prints the resolved
      // profile; `--check` is a cwd readiness probe.
      command: "scratch";
      unsafe: boolean;
      dryRun: boolean;
      check: boolean;
      help: boolean;
      format: "plain" | "json";
    }
  | {
      // GH-1206: `prx author body-template --unit <id>` — pure renderer
      // that emits a CLAUDE.md PR-Standards run-sheet PR body for paste
      // into `gh pr create --body-file` or `gh pr edit --body-file`.
      command: "author-body-template";
      unit: string;
      base: string;
      format: "plain" | "json";
    }
  | {
      command: "triage-status";
      repo?: string | undefined;
      limit: number;
      format: "plain" | "json";
      includeIntentional: boolean;
      rateLimit: boolean;
      // GH-1786: read-time freshness gate — symmetric with `scout issues`.
      maxStaleness: string;
      noRefresh: boolean;
    }
  | {
      command: "triage-session";
      repoSlug?: string | undefined;
      dryRun: boolean;
      check: boolean;
      format: "plain" | "json";
      // GH-2380: headless-first. See intake-session.
      interactive?: boolean | undefined;
      // prx-383: optional work-unit id — triage THIS item, not the whole queue.
      message?: string | undefined;
    }
  | {
      command: "triage-classify";
      repo?: string | undefined;
      from?: string | undefined;
      limit: number;
      format: "json" | "tsv";
      requireBudget?: number | undefined;
    }
  | {
      command: "triage-apply";
      plan?: string | undefined;
      repo?: string | undefined;
      dryRun: boolean;
      limit: number;
      sync: boolean;
    }
  | {
      command: "triage-promote";
      repo?: string | undefined;
      from?: string | undefined;
      dryRun: boolean;
      limit: number;
      only?: number | undefined;
    }
  | {
      command: "triage-promote-children";
      dir: string;
      dryRun: boolean;
      limit: number;
      only?: string | undefined;
    }
  | {
      command: "triage-drift-fix";
      repo?: string | undefined;
      from?: string | undefined;
      apply: boolean;
      dryRun: boolean;
      limit: number;
      axes: DriftFixAxis[];
      sync: boolean;
    }
  | {
      command: "triage-migrate-axis-value";
      repo?: string | undefined;
      axis: LabelAxis;
      from: string;
      to: string;
      apply: boolean;
      limit: number;
      sync: boolean;
    }
  | {
      command: "triage-prioritize";
      repo?: string | undefined;
      limit: number;
      dryRun: boolean;
      sync: boolean;
    }
  | {
      command: "triage-type-pass";
      repo?: string | undefined;
      model: string;
      batchSize: number;
      limit: number;
      dryRun: boolean;
    }
  | {
      command: "triage-prioritize-bulk";
      repo?: string | undefined;
      model: string;
      batchSize: number;
      limit: number;
      dryRun: boolean;
    }
  | {
      command: "triage-close";
      bdId: string;
      reason: TriageCloseReason;
      note?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }
  | {
      command: "triage-close-stale";
      repo?: string | undefined;
      reason: TriageCloseReason;
      note?: string | undefined;
      dryRun: boolean;
      limit: number;
      format: "plain" | "json";
    }
  | {
      command: "triage-prime";
      repo?: string | undefined;
      dryRun: boolean;
      autoPrioritize: boolean;
      autoDriftFix: boolean;
      maxIterations: number;
      format: "plain" | "json";
    }
  | {
      command: "map-create";
      name: string;
      tickets: string[];
      rationale: string;
      parents: string[];
      fromFile?: string | undefined;
    }
  | {
      command: "map-show";
      name: string;
      format: "plain" | "json";
    }
  | {
      command: "ci";
      phase?: CiPhase | undefined;
      format: "plain" | "json";
    };

type CliDeps = {
  ensureBeadsInitSetup?: typeof ensureBeadsInitSetup;
  syncGitHubIssuesToBeads?: typeof syncGitHubIssuesToBeads;
  syncStatus?: typeof syncStatus;
  updatePrFromContract?: typeof updatePrFromContract;
  overviewStatus?: typeof overviewStatus;
  discoverLocalRepos?: typeof discoverLocalRepos;
  normalizeLocalRepos?: typeof normalizeLocalRepos;
  addLocalRepo?: typeof addLocalRepo;
  // GH-1760: opener for the new sqlite registry. Tests inject an in-memory
  // (or temp-path) Database so the verb can be exercised without touching
  // `~/.local/state/prx/registry.sqlite`. Defaults to `openRegistry()` at
  // its canonical path.
  openRegistry?: typeof openRegistry;
  // GH-1760 / GH-1761 / GH-1762: adopt-verb runtime overrides. Tests inject
  // fakes so the parser → runner glue is exercised without spawning a real
  // `git`.
  adoptRepo?: typeof adoptRepo;
  adoptBranch?: typeof adoptBranch;
  adoptWorkspace?: typeof adoptWorkspace;
  // GH-1681: hydrate/refspec recovery for an existing registered bare.
  refreshLocalRepo?: typeof refreshLocalRepo;
  loadRepoInventoryConfig?: typeof loadRepoInventoryConfig;
  // GH-1657: index reader for the `repos-add` uniqueness gate.
  loadRepoInventoryIndex?: typeof loadRepoInventoryIndex;
  // GH-1657: cleanup hook for the `repos-add` collision branch.
  rollbackRepoAdd?: typeof rollbackRepoAdd;
  // GH-1710 / GH-2013: writers for the `repo set <axis>` verb.
  setRepoCanonical?: typeof setRepoCanonical;
  setRepoStaleThresholdDays?: typeof setRepoStaleThresholdDays;
  setRepoBdWorkspacePrefix?: typeof setRepoBdWorkspacePrefix;
  setRepoDoltRemote?: typeof setRepoDoltRemote;
  // GH-1660: clone-or-fetch primitive backing `prx repo materialize`.
  materializeBareRepo?: typeof materializeBareRepo;
  // GH-1643: slug → registered bare-repo lookup used by `prx plan session --repo`.
  findRepoBySlug?: typeof findRepoBySlug;
  // GH-1689: shared slug→target-mainx resolver used by plan-session + triage-session.
  resolveTargetRepoCwd?: typeof resolveTargetRepoCwd;
  // GH-1689 / GH-1684: workspace-mode classifier used by triage-session --repo.
  classifyBeadsWorkspace?: typeof classifyBeadsWorkspace;
  writeRepoInventoryIndex?: typeof writeRepoInventoryIndex;
  applyHooks?: typeof applyHooks;
  hookStatus?: typeof hookStatus;
  worktreeStatus?: typeof worktreeStatus;
  wtStatus?: typeof wtStatus;
  removeWorktree?: typeof removeWorktree;
  muxHandle?: WorktreeRemoveMuxHandle;
  /** CommandRunner seam for all tmux IPC (has-session, display-message, new-session, split-window, send-keys, kill-session). Tests inject a recording runner. */
  muxRunner?: GithubCommandRunner;
  /** CommandRunner seam for the final `tmux attach-session` call. Separate from muxRunner because the attach is interactive (stdio-inherit) in prod while tests want it mocked. */
  attachRunner?: GithubCommandRunner;
  repoStatus?: typeof repoStatus;
  remoteCiCheck?: typeof remoteCiCheck;
  scoutLogs?: typeof scoutLogs;
  fetchPrComments?: typeof fetchPrComments;
  resolvePrReviewThreads?: typeof resolvePrReviewThreads;
  repoCheckNames?: typeof repoCheckNames;
  buildParityChain?: typeof buildParityChain;
  buildSessionLayerPrune?: typeof buildSessionLayerPrune;
  /** Override for testability: return the name of the current tmux session, or null. */
  tmuxCurrentSession?: () => string | null;
  checkMainBranchProtection?: typeof checkMainBranchProtection;
  protectMainBranch?: typeof protectMainBranch;
  boardStatus?: typeof boardStatus;
  chainStatus?: typeof chainStatus;
  validateGitHubIssue?: typeof validateGitHubIssue;
  findEpicChildren?: typeof findEpicChildren;
  nextAction?: typeof nextAction;
  // GH-1510: injection seam for the multi-thread next-work picker so the
  // CLI tests can drive `delegate next` / `next` without spinning up a real
  // bd binary or git repo. Production callers leave this `undefined`.
  nextWork?: typeof nextWork;
  buildDomainState?: typeof buildDomainState;
  viewPr?: typeof viewPr;
  initContract?: typeof initContract;
  copyToClipboard?: (text: string) => void;
  openAfterEnter?: (url: string) => void;
  openUrl?: (url: string) => void;
  execRuntime?: RuntimeExecutor;
  execOpen?: (command: string, args: string[], cwd?: string) => {
    status: number;
    stdout: string;
    stderr: string;
  };
  lockWorktree?: typeof lockWorktree;
  unlockWorktree?: typeof unlockWorktree;
  resolveWorkUnitCwd?: (workUnitId: string, cwd?: string, noVerify?: boolean) => string;
  materializeWorktree?: (workUnitId: string, cwd: string, noVerify?: boolean) => void;
  inspectSessionOpenState?: (workUnitId: string, cwd?: string) => SessionOpenCheckReport;
  ensureRuntimeArtifacts?: typeof ensureLocalRuntimeArtifacts;
  ensureClaudeAllowlist?: (launchCwd: string) => EnsureClaudeAllowlistResult;
  // GH-1545: pre-approve an operator session's own scoped allowlist
  // (`prx intake|triage session`) into `.claude/settings.local.json` so the
  // auto-mode classifier never gates the session's core verbs. Injected so
  // tests don't mutate the real `.claude/settings.local.json`.
  ensureClaudeSessionAllowlist?: (
    cwd: string,
    profile: SessionProfileName,
  ) => EnsureClaudeAllowlistResult;
  hydrateBeads?: typeof hydrateBeads;
  repairBdSchema?: typeof repairBdSchema;
  listFeatureWorktreesForRepair?: typeof listFeatureWorktreesForRepair;
  checkWorkUnitIssue?: typeof checkWorkUnitIssue;
  findBeadsIssuesByGithubIssue?: typeof findBeadsIssuesByGithubIssue;
  checkWorkUnitSession?: typeof checkWorkUnitSession;
  checkWorkUnitChain?: typeof checkWorkUnitChain;
  resolveCurrentPrRef?: typeof resolveCurrentPrRef;
  pruneStaleRemoteRefs?: typeof pruneStaleRemoteRefs;
  applyParityChainActions?: typeof applyParityChainActions;
  checkPrxBinaryUpstream?: typeof checkPrxBinaryUpstream;
  closeSession?: typeof closeSession;
  planClose?: typeof planClose;
  // GH-1173: CAS plan-store verb seams (save/load/show).
  runPlanSave?: typeof runPlanSave;
  runPlanLoad?: typeof runPlanLoad;
  runPlanShow?: typeof runPlanShow;
  // GH-1239: pre-draft preflight (axis 1/2/3) — same DI shape so tests can
  // inject a deterministic stub instead of reaching gh/git.
  runPlanPreflight?: typeof runPlanPreflight;
  // GH-1186: planner-side read primitives (view/search) — twins of the
  // intake siblings. Same DI shape (Output + deps).
  runPlanView?: (
    options: PlanViewOptions,
    output: Output,
    deps?: PlanViewDeps,
  ) => number | Promise<number>;
  runPlanSearch?: (
    options: PlanSearchOptions,
    output: Output,
    deps?: PlanSearchDeps,
  ) => number;
  /** Override for plan-save reading binary content from stdin. */
  readStdinSync?: () => Buffer;
  /** Override for plan-save reading binary content from a file path. */
  readPlanFile?: (path: string) => Buffer;
  /** Override for plan-load writing binary content directly to stdout. */
  writeStdoutBinary?: (buf: Buffer) => void;
  /** GH-1336: seams for `--cleanup` post-save FS actions. Tests inject
   * recorders to assert atomicity (no FS touch on save failure). */
  unlinkPlanFile?: (path: string) => void;
  renamePlanFile?: (src: string, dest: string) => void;
  statPath?: (path: string) => { isDirectory: () => boolean };
  reviewVerb?: typeof reviewVerb;
  findSavedClaudeSession?: (launchCwd: string, homeDir?: string) => boolean;
  writeFile?: (path: string, content: string) => void;
  autoRebaseOnSessionOpen?: (repoPath: string, options?: AutoRebaseOptions) => AutoRebaseResult;
  // GH-1983: plan-session preflight — refuse when launch worktree is on a
  // detached HEAD. Returns null on a named branch; tests inject a fake to
  // bypass the real `git symbolic-ref` call against a non-git tmpdir.
  assertWorktreeOnNamedBranch?: (
    launchCwd: string,
    expectedBranch: string,
  ) => DetachedHeadRefusal | null;
  homeUpdate?: (
    options: HomeUpdateOptions,
    output: Output,
    deps?: HomeUpdateDeps,
  ) => number;
  homeSync?: (
    options: HomeSyncOptions,
    output: Output,
    deps?: HomeSyncDeps,
  ) => number;
  runDoltReconcile?: (
    options: DoltReconcileOptions,
    output: Output,
    deps?: DoltReconcileDeps,
  ) => number;
  runDoltStatus?: (
    options: DoltStatusOptions,
    output: Output,
    deps?: DoltStatusDeps,
  ) => number;
  runTmuxReconcile?: (
    options: TmuxReconcileOptions,
    output: Output,
    deps?: TmuxReconcileDeps,
  ) => number;
  runIntake?: (
    options: IntakeOptions,
    output: Output,
    deps?: IntakeDeps,
  ) => number;
  runIntakeView?: (
    options: IntakeViewOptions,
    output: Output,
    deps?: IntakeViewDeps,
  ) => number | Promise<number>;
  runIntakeSearch?: (
    options: IntakeSearchOptions,
    output: Output,
    deps?: IntakeSearchDeps,
  ) => number;
  runIntakeStatus?: (
    options: IntakeStatusOptions,
    output: Output,
    deps?: IntakeStatusDeps,
  ) => number;
  runIntakeMerge?: (
    options: IntakeMergeOptions,
    output: Output,
    deps?: IntakeMergeDeps,
  ) => number;
  runIntakeComment?: (
    options: IntakeCommentOptions,
    output: Output,
    deps?: IntakeCommentDeps,
  ) => number;
  runIntakeMirror?: (
    options: IntakeMirrorOptions,
    output: Output,
    deps?: IntakeMirrorDeps,
  ) => number;
  // GH-1318: submit actor handler seams.
  runBodyTemplate?: (
    options: BodyTemplateOptions,
    output: Output,
  ) => number;
  runPostmerge?: (
    options: PostmergeOptions,
    output: Output,
    deps?: PostmergeDeps,
  ) => number;
  runBeadsPublish?: (
    options: BeadsPublishOptions,
    output: Output,
    deps?: BeadsPublishDeps,
  ) => number;
  // GH-885 + GH-882: doctor actor handler seams. Each takes the resolved
  // doctor target (workUnitId + repoPath) plus a verb-specific options shape.
  runDoctorInventory?: typeof doctorRunInventory;
  // GH-1559: publisher actor handler seams. The `prx doctor merge|ready|draft`
  // deprecation aliases delegate to these same handlers.
  runPublisherMerge?: typeof publisherRunMerge;
  runPublisherReady?: typeof publisherRunReady;
  runPublisherDraft?: typeof publisherRunDraft;
  // GH-1560: publisher PR open/update handler seams.
  runPublisherPrOpen?: typeof publisherRunPrOpen;
  runPublisherPrUpdate?: typeof publisherRunPrUpdate;
  runPublisherPrComment?: typeof publisherRunPrComment;
  runPublisherPrEdit?: typeof publisherRunPrEdit;
  // GH-1508: ADR §6 dedupe verb. No work-unit target — substrate-wide scan.
  runDoctorDedupeBd?: typeof doctorRunDedupeBd;
  runIntakeBdLs?: (
    options: IntakeBdLsOptions,
    output: Output,
    deps?: IntakeBdDeps,
  ) => number;
  runIntakeBdMemoryLs?: (
    options: IntakeBdMemoryLsOptions,
    output: Output,
    deps?: IntakeBdDeps,
  ) => number;
  runIntakeBdMemoryGet?: (
    options: IntakeBdMemoryGetOptions,
    output: Output,
    deps?: IntakeBdDeps,
  ) => number;
  runIntakeBdMemorySet?: (
    options: IntakeBdMemorySetOptions,
    output: Output,
    deps?: IntakeBdDeps,
  ) => number;
  runTriageStatus?: (
    options: TriageStatusOptions,
    output: Output,
    deps?: TriageStatusDeps,
  ) => number;
  runTriageClassify?: (
    options: TriageClassifyOptions,
    output: Output,
    deps?: TriageClassifyDeps,
  ) => number;
  runTriageApply?: (
    options: TriageApplyOptions,
    output: Output,
    deps?: TriageApplyDeps,
  ) => number;
  runTriagePromote?: (
    options: TriagePromoteOptions,
    output: Output,
    deps?: TriagePromoteDeps,
  ) => number;
  runTriagePromoteChildren?: (
    options: TriagePromoteChildrenOptions,
    output: Output,
    deps?: TriagePromoteChildrenDeps,
  ) => number;
  runTriageDriftFix?: (
    options: TriageDriftFixOptions,
    output: Output,
    deps?: TriageDriftFixDeps,
  ) => Promise<number>;
  runTriageMigrateAxisValue?: (
    options: TriageMigrateAxisValueOptions,
    output: Output,
    deps?: TriageMigrateAxisValueDeps,
  ) => Promise<number>;
  runTriagePrioritize?: (
    options: TriagePrioritizeOptions,
    output: Output,
    deps?: TriagePrioritizeDeps,
  ) => Promise<number>;
  runTriageTypePass?: (
    options: TriageTypePassOptions,
    output: Output,
    deps?: TriageTypePassDeps,
  ) => Promise<number>;
  runTriagePrioritizeBulk?: (
    options: TriagePrioritizeBulkOptions,
    output: Output,
    deps?: TriagePrioritizeBulkDeps,
  ) => Promise<number>;
  runTriageClose?: (
    options: TriageCloseOptions,
    output: Output,
    deps?: TriageCloseDeps,
  ) => TriageCloseResult;
  runTriageCloseStale?: (
    options: TriageCloseStaleOptions,
    output: Output,
    deps?: TriageCloseStaleDeps,
  ) => TriageCloseStaleResult;
  runTriagePrime?: (
    options: TriagePrimeOptions,
    output: Output,
    deps?: TriagePrimeDeps,
  ) => Promise<number>;
  runCi?: (options: CiOptions, output: Output) => number;
  inferOperatorScopeFromCwd?: (cwd: string) => InferredScope;
  isMainxWorktree?: (cwd: string) => boolean;
  // GH-2258: route `prx triage|intake session` onto the dedicated triage
  // surface (a per-call ephemeral worktree off origin/main) via the
  // `session_open` actor (I-SO1). Injected so tests assert the routing +
  // spawn-at-worktree behavior without reserving a real worktree.
  // GH-2280: extended to the work-unit-bound submit/author session verbs,
  // which carry a `workUnitId` (the reserved branch name).
  openSession?: (
    input: { actor: SessionActor; workUnitId?: string | undefined },
    deps?: Parameters<typeof openSession>[1],
  ) => Promise<OpenSessionResult>;
  ensureOpsRuntimeMcp?: typeof ensureOpsRuntimeMcp;
  // GH-1274 (PR-2 of GH-1261): inject the dep-research fetcher to keep tests
  // from shelling to real git/curl. Defaults to `defaultFetchSource()` which
  // uses the live CommandRunner.
  depResearchFetcher?: FetchSourceFn;
  // GH-1274: inject the clock so run-id formatting is deterministic in tests.
  depResearchNow?: () => Date;
  // GH-1537: `prx beads sync` runtime override — tests hand in a fake so the
  // verb is exercised without a real `bd` / `gh` / rate-limit probe.
  beadsSync?: typeof runBeadsSync;
  // GH-1469: `prx sync backfill` runtime override — tests inject a fake so the
  // verb is exercised without a real adapter `enumerate` / `runIntakeMirror`.
  backfill?: typeof runBackfill;
  // GH-1662: cross-repo daemon runtime override — `--all-repos` walks the
  // inventory and calls this once per indexed repo. Defaults to the in-tree
  // orchestrator (`runBeadsSyncAcrossRepos`).
  beadsSyncAcrossRepos?: typeof runBeadsSyncAcrossRepos;
  // GH-1702: cross-repo `prx beads sync-all` runtime override — tests hand
  // in a fake so the verb is exercised without a real `bd dolt push|pull`.
  beadsSyncAllAcrossRepos?: typeof runDoltReconcileAcrossRepos;
  // GH-1513: `prx memory compact` runtime override — tests hand in a fake so
  // the verb is exercised without a real `bd admin compact` / `bd dep list`.
  memoryCompact?: typeof runMemoryCompact;
  // GH-1533: `prx doctor gh-budget` read-back seams. `rateLimitAuditReader`
  // lets tests hand in fixed `rate-limit.jsonl` rows instead of touching
  // ~/.cache; `now` anchors the lookback window.
  rateLimitAuditReader?: () => RateLimitAuditEntry[];
  now?: () => Date;
};

type NodeError = Error & {
  code?: string;
  path?: string;
};

type CommandRunnerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

type CommandRunner = (command: string[], cwd?: string) => CommandRunnerResult;

type RuntimeArtifactStatus = {
  // GH-1587: the MCP server keys actually written into
  // `.pr/local/runtime/mcp.json` — `["notion"]` when Notion auth is
  // configured, otherwise `[]`. (No `beads` entry: prx-managed Claude
  // sessions reach beads via the `prx tools bd` / `bd-safe` CLI wrappers,
  // and the `beads` workflow actor is `kind: cli`, not `mcp_server`.)
  mcpServers: string[];
};

/**
 * GH-2067: optional structured payload carried by {@link CliError}. The
 * session-plan command's `--format json` catch reads `details` to render a
 * stderr JSON envelope on a typed error branch (e.g. the not-yet-materialized
 * branch); when `details` is absent the error renders as today's plain-text
 * stderr line via `handleRunCliError`. Designed as a discriminated union so
 * additional sibling branches (no source, source closed, source not found,
 * unit complete, parity cleanup, epic refusal, board-read failure) can be
 * adopted one-at-a-time in follow-ups without further refactor.
 */
export type CliErrorDetails = {
  code: "PRX_SESSION_NOT_PROJECTED_LOCALLY";
  message: string;
  workUnitId: string;
  source: string;
  title: string;
  url: string | null;
  suggestedNextCommands: string[];
};

export class CliError extends Error {
  exitCode: number;
  details?: CliErrorDetails;

  constructor(message: string, exitCode = 1, details?: CliErrorDetails) {
    super(message);
    this.exitCode = exitCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

const buildMalformedAllowlistWarning = (path: string): string =>
  `warning: ${path} contains malformed JSON or is not a JSON object — leaving prx allowlist untouched; prx commands may prompt for permission`;

const protectMainAllowChoices = [
  "strict",
  "enforce-admins",
  "conversation-resolution",
  "last-push-approval",
  "linear-history",
] as const;

type ProtectMainAllowChoice = (typeof protectMainAllowChoices)[number];

function parseProtectMainAllow(value: string): { type: ProtectMainAllowChoice | "status-check"; value?: string } {
  const normalized = value.trim();
  if (protectMainAllowChoices.includes(normalized as ProtectMainAllowChoice)) {
    return { type: normalized as ProtectMainAllowChoice };
  }
  if (normalized.startsWith("status-check:")) {
    const checkName = normalized.slice("status-check:".length).trim();
    if (!checkName) {
      throw new CliError("--allow status-check:<name> requires a non-empty check name");
    }
    return { type: "status-check", value: checkName };
  }
  throw new CliError(
    `Invalid value for --allow: ${value}. Expected one of ${protectMainAllowChoices.join(", ")}, or status-check:<name>`,
  );
}

function ensureChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if (choices.includes(value as T)) {
    return value as T;
  }
  throw new CliError(`Invalid value for ${flag}: ${value}. Valid options: ${choices.join(", ")}`);
}

// GH-1336: parse `--cleanup` into a discriminated `PlanSaveCleanupSpec`.
// Accepts `none`, `delete`, or `move-to=<path>` (with non-empty path).
// `=` is the only payload separator we support — operators with `=` in
// their destination path must use a different mechanism (rejected here
// rather than silently truncated).
function parseCleanupSpec(raw: string): PlanSaveCleanupSpec {
  if (raw === "none") return { kind: "none" };
  if (raw === "delete") return { kind: "delete" };
  if (raw.startsWith("move-to=")) {
    const dest = raw.slice("move-to=".length);
    if (dest.length === 0) {
      throw new CliError(
        "plan save: --cleanup=move-to= requires a destination path (e.g., --cleanup=move-to=/tmp/archive)",
      );
    }
    return { kind: "move-to", dest };
  }
  throw new CliError(
    `plan save: invalid --cleanup value: ${raw}. Valid: none, delete, move-to=<path>`,
  );
}

/**
 * GH-1227: verbs whose own dispatch returns a richer help shape (session-help,
 * plan-namespace-help, etc.); the post-namespace-rewrite `--help` interceptor
 * skips these so the bespoke output keeps rendering.
 *
 * `open`/`work` route through `parseSessionOpenCommand`'s session-help branch.
 * The plan-namespace family (`close`, `plan-close`, `ci`, `next-action`,
 * `phase`, `snapshot`, `statusline`) all pre-check `--help` and emit
 * `plan-namespace-help`; without this skip, the interceptor preempts them.
 *
 * Verbs intercepted BEFORE the namespace rewrite (`plan-session`,
 * `plan-prime`, `review`, `implement`) never reach the interceptor and so are
 * not listed here.
 */
const VERBS_WITH_NATIVE_HELP: ReadonlySet<string> = new Set([
  "open",
  "work",
  "close",
  "plan-close",
  "ci",
  "next-action",
  "phase",
  "snapshot",
  "statusline",
]);

/**
 * GH-1227: split argv for passthrough verbs (`tools wt|git|bd`).
 *
 * Walks tokens collecting positionals plus any flag declared in
 * `knownStringFlags` / `knownBoolFlags` into `prxArgs`. The first unknown
 * flag — or an explicit `--` — sends the remainder to `passthrough`. Lets
 * operators write `prx tools bd ready --json` (no `--`) while the existing
 * `prx tools wt exec -- git status` form keeps working. (GH-874 retired the
 * `prx tools gh` surface; internal callers continue to use `execGh()`.)
 */
function splitPassthroughArgv(
  argv: string[],
  knownStringFlags: ReadonlySet<string>,
  knownBoolFlags: ReadonlySet<string>,
): { prxArgs: string[]; passthrough: string[] } {
  const prxArgs: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (tok === "--") {
      return { prxArgs, passthrough: argv.slice(i + 1) };
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      if (knownStringFlags.has(name)) {
        prxArgs.push(tok);
        if (eq < 0 && i + 1 < argv.length) {
          // i + 1 < argv.length guarantees argv[i + 1] is in-bounds.
          prxArgs.push(argv[i + 1]!);
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (knownBoolFlags.has(name)) {
        prxArgs.push(tok);
        i += 1;
        continue;
      }
      // Unknown long flag — bail out, send rest to passthrough.
      return { prxArgs, passthrough: argv.slice(i) };
    }
    // Single-dash short flag (e.g., `-R owner/repo`, `-C path`, `-h`) — none
    // of the four passthrough verbs declare any short flag, so any `-X` is
    // unknown and forwards to the underlying tool. A lone `-` is conventional
    // stdin and treated as a positional.
    if (tok.length > 1 && tok.startsWith("-")) {
      return { prxArgs, passthrough: argv.slice(i) };
    }
    // Positional — keep collecting; subcommand parsing happens downstream.
    prxArgs.push(tok);
    i += 1;
  }
  return { prxArgs, passthrough: [] };
}

function parseTicketFlag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseCanonicalWorkUnitId(value, "--ticket");
}

function defaultHooksPath(): string {
  const envOverride = getEnv("PRX_HOOKS_PATH");
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim();
  }
  const home = getEnv("HOME");
  if (!home) {
    throw new CliError(
      "Cannot resolve default hooks path: HOME is unset. Pass --hooks-path or set PRX_HOOKS_PATH.",
    );
  }
  return `${home}/.local/share/git-hooks`;
}

const workAgentAliases = {
  "gh-copilot": "copilot",
} as const satisfies Record<string, WorkAgentImplementation>;

const executionWorkAgents = ["claude", "codex"] as const satisfies readonly WorkAgentImplementation[];
type ExecutionWorkAgent = (typeof executionWorkAgents)[number];
const executionWorkAgentSet = new Set<WorkAgentImplementation>(executionWorkAgents);

type ExecutionPolicy = {
  timeout_ms: number;
  max_retries: number;
  allowed_agents: readonly WorkAgentImplementation[];
  temperature?: number;
};

export const POLICY: ExecutionPolicy = {
  timeout_ms: 30000,
  max_retries: 1,
  allowed_agents: executionWorkAgents,
  temperature: 0,
};

/** Returns undefined (no timeout) for interactive plain sessions; returns the policy timeout for automated json runs. */
export function interactiveTimeoutMs(format: "plain" | "json", timeoutMs: number): number | undefined {
  return format === "plain" ? undefined : timeoutMs;
}

function supportsExecutionWorkflowAgent(agent: WorkAgentImplementation): agent is ExecutionWorkAgent {
  return executionWorkAgentSet.has(agent);
}

function ensureExecutionWorkflowAgent(agent: WorkAgentImplementation, flag = "--agent"): ExecutionWorkAgent {
  if (supportsExecutionWorkflowAgent(agent)) {
    return agent;
  }
  throw new CliError(
    `Invalid value for ${flag}: ${agent}. Execution workflows currently support: ${POLICY.allowed_agents.join(", ")}.`,
  );
}

function formatWorkAgentAliasMappings(): string {
  return Object.entries(workAgentAliases)
    .map(([alias, target]) => `${alias} -> ${target}`)
    .join(", ");
}

function formatSupportedWorkAgents(): string {
  const aliases = formatWorkAgentAliasMappings();
  const base = workAgentImplementations.join(", ");
  return aliases ? `${base} (aliases: ${aliases})` : base;
}

function formatSupportedWorkAgentsForUsage(): string {
  return workAgentImplementations.join("|");
}

function formatExecutionWorkAgentsForUsage(): string {
  return executionWorkAgents.join("|");
}

function validateWorkIoFormat(
  agent: WorkAgentImplementation,
  ioFormat: RuntimeIoFormat,
): RuntimeIoFormat {
  if (agent === "copilot" && ioFormat === "stream-json") {
    throw new CliError("--io-format stream-json is not supported with --agent copilot");
  }
  return ioFormat;
}

function parseWorkAgentImplementation(value: string, flag: string): WorkAgentImplementation {
  const normalized = workAgentAliases[value as keyof typeof workAgentAliases] ?? value;
  if (workAgentImplementations.includes(normalized as WorkAgentImplementation)) {
    return normalized as WorkAgentImplementation;
  }
  throw new CliError(`Invalid value for ${flag}: ${value}. Valid options: ${formatSupportedWorkAgents()}`);
}

function buildWorkAutomationProfile(
  agent: WorkAgentImplementation,
  workUnitId: string,
  ioFormat: RuntimeIoFormat,
  mode: RuntimeMode,
): RuntimeProfileProjection {
  if (agent === "codex") {
    return buildWorkUnitCodexRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  if (agent === "copilot") {
    return buildWorkUnitCopilotRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  if (agent === "gemini") {
    return buildWorkUnitGeminiRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  if (agent === "cursor") {
    return buildWorkUnitCursorRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  return buildWorkUnitClaudeRuntimeProfile({
    agentId: workUnitId,
    workUnitId,
    ioFormat,
    mode,
  });
}

function supportsCurrentWorkspaceLaunch(agent: WorkAgentImplementation): boolean {
  return agent === "codex";
}

// Resolved canonical-ID helpers for the current CLI invocation. Lazily loaded
// on first validator access so `prx help` / `prx version` / other non-repo
// commands don't pay the cost of a `git rev-parse` or fail in minimal
// environments. resetCanonicalHelpers() at the top of runCli() ensures fresh
// state per invocation (tests share the process and chdir between cases).
let activeCanonicalHelpers: CanonicalWorkUnitIdHelpers | null = null;
let activeCanonicalIsDefault = true;
let activeIdentityConfig: IdentityConfig | null = null;

function resetCanonicalHelpers(): void {
  activeCanonicalHelpers = null;
  activeCanonicalIsDefault = true;
  activeIdentityConfig = null;
}

function ensureIdentityConfig(
  runner: GithubCommandRunner = defaultRunner,
): IdentityConfig {
  if (activeIdentityConfig) {
    return activeIdentityConfig;
  }
  activeIdentityConfig = loadIdentityConfig(process.cwd(), runner);
  return activeIdentityConfig;
}

function ensureCanonicalHelpers(
  runner: GithubCommandRunner = defaultRunner,
): CanonicalWorkUnitIdHelpers {
  if (activeCanonicalHelpers) {
    return activeCanonicalHelpers;
  }
  const config = ensureIdentityConfig(runner);
  activeCanonicalHelpers = buildCanonicalWorkUnitIdHelpers(
    effectiveCanonicalIdPattern(config),
  );
  activeCanonicalIsDefault = config.isDefault;
  return activeCanonicalHelpers;
}

function canonicalFormatExample(): string {
  const helpers = ensureCanonicalHelpers();
  if (activeCanonicalIsDefault) {
    return "for example GH-456";
  }
  return `for example GH-456 or a canonical_id_pattern declared by a configured prx.toml [sources.<name>] (${helpers.pattern.source})`;
}

function validatePlanPath(path: string): string {
  if (/[\r\n\x00-\x1f]/.test(path)) {
    throw new CliError("--plan PATH must not contain newlines or control characters.");
  }
  return path.trim();
}

function parseCanonicalWorkUnitId(value: string, flag: string): string {
  const helpers = ensureCanonicalHelpers();
  const normalized = helpers.normalize(value);
  if (helpers.isCanonical(normalized)) {
    return normalized;
  }
  // GH-2015: the static `combinedCanonicalIdPattern()` regex cannot encode
  // cwd-dependent surface ids (BD's bare-workspace arm reads
  // `bd_workspace_prefix` from `.prx/repos/index.json` via
  // `localWorkspacePrefix(cwd)`). Fall through to the adapter registry so
  // ids whose recognition is runtime-only still pass the gate. Gated on
  // `activeCanonicalIsDefault` — a per-repo `[identity] canonical_id_pattern`
  // overlay wins outright (operator explicitly pinned a shape).
  //
  // Try the trimmed verbatim form first so lowercase-only adapter arms
  // (BD's bare-workspace arm, BD long-id) preserve case for downstream bd
  // record lookup. Fall back to the uppercased form so case-stable arms
  // (`GH-\d+`, etc.) routed through a future adapter still match.
  if (activeCanonicalIsDefault) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && adapterForCanonicalId(trimmed) !== null) {
      return trimmed;
    }
    if (normalized !== trimmed && adapterForCanonicalId(normalized) !== null) {
      return normalized;
    }
  }
  // A `<prefix>-<rest>` id that survives to here is most often a *recognized*
  // bd surface id whose covering repo has no `bd_workspace_prefix` registered
  // (a pre-GH-1657 inventory row) — the bd bare-workspace adapter arm needs
  // that field to fire, so the id silently fails the gate. The generic
  // "must match CANONICAL-ID format (GH-456)" misleads in that case (it cost a
  // full debugging session to trace). Detect the bd-short shape and point at
  // the documented `prx repo backfill` / `prx repo refresh <slug>` remedy.
  const inputTrimmed = value.trim();
  if (activeCanonicalIsDefault && looksLikeBeadsShortId(inputTrimmed)) {
    const slug = localRepoForCwd(process.cwd())?.name;
    const refreshHint = slug ? ` (or \`prx repo refresh ${slug}\`)` : "";
    throw new CliError(
      `${flag} "${inputTrimmed}" looks like a beads id but is not recognized. ` +
        `This repo's bd workspace prefix is not registered in the repo inventory ` +
        `(a pre-GH-1657 row), so the bd id arm cannot resolve it. ` +
        `Run \`prx repo backfill\`${refreshHint} to populate bd_workspace_prefix, then retry. ` +
        `Otherwise the id must match CANONICAL-ID format (${canonicalFormatExample()}).`,
    );
  }
  throw new CliError(`${flag} must match CANONICAL-ID format (${canonicalFormatExample()})`);
}

/**
 * Heuristic: does `value` look like a bd workspace-short id (`<prefix>-<rest>`,
 * e.g. `prx-0v5`) rather than a malformed canonical id? Excludes the known
 * domain prefixes (gh / notion / bd) — those have their own surface arms and a
 * miss there is a genuine format error, not an unregistered-prefix one.
 */
function looksLikeBeadsShortId(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]*-[a-z0-9]+$/i.test(trimmed)) return false;
  const prefix = trimmed.slice(0, trimmed.indexOf("-")).toLowerCase();
  return prefix !== "gh" && prefix !== "notion" && prefix !== "bd";
}

function detectWorkUnitIdFromCwd(cwd = process.cwd()): string {
  const helpers = ensureCanonicalHelpers();
  const candidate = helpers.normalize(basename(cwd));
  if (!helpers.isCanonical(candidate)) {
    throw new CliError(
      `work requires a canonical work unit id, or a canonical worktree directory name (${canonicalFormatExample()})`,
    );
  }
  return candidate;
}

/**
 * GH-643: `prx plan handoff` (post-merge teardown) is invoked from inside a
 * feature worktree
 * whose directory is a Worktrunk basename (e.g. `gh_643_abc`, not the
 * canonical `GH-643`). Prefer the branch name — which IS the canonical
 * id in this project — and fall back to the cwd basename only if it
 * already matches the canonical pattern.
 */
function detectCloseWorkUnitId(cwd = process.cwd()): string {
  const helpers = ensureCanonicalHelpers();
  const branchName = detectBranchNameFromCwd(cwd);
  const branchCandidate = branchName ? helpers.normalize(branchName) : "";
  if (helpers.isCanonical(branchCandidate)) {
    return branchCandidate;
  }
  const cwdCandidate = helpers.normalize(basename(cwd));
  if (helpers.isCanonical(cwdCandidate)) {
    return cwdCandidate;
  }
  throw new CliError(
    `close requires a canonical work unit id; pass GH-<n> explicitly (could not infer from branch '${branchName ?? "<none>"}' or cwd '${basename(cwd)}')`,
  );
}

function detectBranchNameFromCwd(cwd = process.cwd()): string | null {
  let status: number;
  let stdout: string;
  try {
    const result = procRunner(["git", "branch", "--show-current"], { cwd, check: false });
    status = result.status;
    stdout = result.stdout;
  } catch {
    return null;
  }
  if (status !== 0) {
    return null;
  }
  const branch = stdout.trim();
  return branch ? branch : null;
}

function detectWorkCommandTarget(
  cwd = process.cwd(),
): { workUnitId: string; launchFromCurrentWorkspace: boolean } {
  const helpers = ensureCanonicalHelpers();
  const cwdCandidate = helpers.normalize(basename(cwd));
  if (helpers.isCanonical(cwdCandidate)) {
    return { workUnitId: cwdCandidate, launchFromCurrentWorkspace: false };
  }

  const branchName = detectBranchNameFromCwd(cwd);
  const branchCandidate = branchName ? helpers.normalize(branchName) : "";
  if (helpers.isCanonical(branchCandidate)) {
    return { workUnitId: branchCandidate, launchFromCurrentWorkspace: false };
  }

  return {
    workUnitId: branchName ?? basename(cwd),
    launchFromCurrentWorkspace: true,
  };
}

function summarizeParityActionKinds(actions: Array<{ type: string }>): string {
  return actions.map((action) => action.type).join(", ");
}

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

function githubIssueNumberForWorkUnit(workUnitId: string): number | null {
  const match = workUnitId.match(/^GH-(\d+)$/);
  if (!match) {
    return null;
  }
  const issueNumber = Number.parseInt(match[1]!, 10);
  return Number.isNaN(issueNumber) ? null : issueNumber;
}

type InactiveAuthorityRemote = {
  gh_issue: string;
  beads_issue: string;
};

type InactiveAuthorityLocal = {
  dir: string;
};

function describeInactiveIssueAuthority(
  workUnitId: string,
  remote: InactiveAuthorityRemote | undefined,
  local: InactiveAuthorityLocal | undefined,
): string {
  const prefix = prxSessionCannotOpenPrefix(workUnitId);
  if (!remote) {
    return `${prefix} the parity chain has no active issue authority for this unit. Run \`prx chain prune --authority issue --scope all\` to clean orphaned units, or reopen the backing issue to restore authority.`;
  }

  const issueNumber = githubIssueNumberForWorkUnit(workUnitId);
  const reason = remote.gh_issue === "completed"
    ? (issueNumber !== null
      ? `GitHub issue #${issueNumber} is closed, so issue authority is not active`
      : "the linked GitHub issue is closed, so issue authority is not active")
    : remote.beads_issue === "completed"
    ? "the linked beads issue is closed, so issue authority is not active"
    : remote.gh_issue === "unknown" || remote.beads_issue === "unknown"
    ? (() => {
      const unknowns: string[] = [];
      if (remote.gh_issue === "unknown") unknowns.push("gh_issue=unknown");
      if (remote.beads_issue === "unknown") unknowns.push("beads_issue=unknown");
      return `issue authority is unreachable (${unknowns.join(", ")})`;
    })()
    : remote.gh_issue === "disabled" && remote.beads_issue === "disabled"
    ? "all issue-authority features are disabled"
    : `no open issue is linked to this work unit (gh_issue=${remote.gh_issue}, beads_issue=${remote.beads_issue})`;

  const remedy = local?.dir === "present"
    ? `Run \`prx worktree-remove ${workUnitId} --delete-branch\` to clear the orphaned worktree`
    : local?.dir === "no worktree"
    ? "Run `prx chain prune --authority issue --scope all` to drop the orphaned branch"
    : "Run `prx chain prune --authority issue --scope all` to clean orphaned units, or reopen the backing issue to restore authority";

  return `${prefix} ${reason}. ${remedy}.`;
}

export function checkWorkUnitIssue(
  workUnitId: string,
  cwd = process.cwd(),
  runner: GithubCommandRunner = defaultRunner,
): WorkUnitIssueCheckResult {
  const issueNumber = githubIssueNumberForWorkUnit(workUnitId);
  if (issueNumber === null) {
    throw new CliError(
      `${prxSessionCannotOpenPrefix(workUnitId)} canonical work unit identity must be GitHub-backed (expected GH-<number>).`,
    );
  }

  const repo = repoNameWithOwner(cwd, runner);
  const issue = validateGitHubIssue(repo, issueNumber, runner);
  const state = (issue.state ?? "").toUpperCase();
  if (state !== "OPEN") {
    throw new CliError(
      `${prxSessionCannotOpenPrefix(workUnitId)} GitHub issue #${issue.number} is ${state || "not open"}, so issue authority is not active.`,
    );
  }

  return {
    workUnitId,
    repo,
    issue,
    checked: true,
    valid: true,
    reason: "open",
  };
}

function parseGithubIssueNumber(value: string): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(/(?:^GH-#?|^#|\/issues\/)(\d+)$/i) ?? trimmed.match(/^(\d+)$/);
  if (!match) {
    return null;
  }
  const issueNumber = Number.parseInt(match[1]!, 10);
  return Number.isNaN(issueNumber) ? null : issueNumber;
}

function matchesGithubIssue(record: BeadsRecord, issueNumber: number): boolean {
  if (record.externalIssueNumber === issueNumber) return true;
  const sourceSystem = record.sourceSystem ?? "";
  return sourceSystem.endsWith(`:${issueNumber}`);
}

/**
 * GH → bd resolver. Consumes the converged `loadAllBeads()` reader so the
 * GH-1589 fix (full bead set, open + closed) stays intact and so the
 * `BeadsCache` constructed in `runCli` can share one read with every other
 * `loadAllBeads`-shaped caller in this process (`prx beads sync`'s bulk
 * adapter loop is the dominant hot path — GH-1595).
 *
 * `loader` is `cache.load` in production; tests pass a `() => BeadsRecord[]`
 * stub to drive both the resolver and the cache-sharing assertions.
 */
export function findBeadsIssuesByGithubIssue(
  issueNumber: number,
  loader: () => BeadsRecord[],
): BeadsGithubIssueMatch[] {
  const records = loader();
  return records
    .filter((record) => matchesGithubIssue(record, issueNumber))
    .map((record) => ({
      id: record.id,
      title: record.title,
      status: record.status || null,
      source_system: record.sourceSystem,
      external_ref: record.externalRef,
    }));
}

function formatWorkUnitIssueCheck(result: WorkUnitIssueCheckResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  return `Issue ${result.workUnitId} is open in ${result.repo} (#${result.issue.number}: ${result.issue.title}).`;
}

function formatResolvedWorkUnitCheck(
  workUnitId: string,
  resolved: ResolvedWorkUnit,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        workUnitId,
        source: resolved.source,
        title: resolved.title,
        state: resolved.state,
        url: resolved.url,
        checked: true,
        valid: true,
        reason: resolved.state === "open" ? "open" : resolved.state,
      },
      null,
      2,
    );
  }
  const location = resolved.url ?? resolved.source;
  return `Issue ${workUnitId} is ${resolved.state} in ${location} (${resolved.title}).`;
}

export function formatBeadsIssueMatches(
  issueNumber: number,
  matches: BeadsGithubIssueMatch[],
  format: "plain" | "json" | "id",
): string {
  if (format === "json") {
    return JSON.stringify(matches, null, 2);
  }
  if (format === "id") {
    return matches.map((issue) => issue.id).join("\n");
  }
  if (matches.length === 0) {
    return `No Beads issues linked to GitHub issue #${issueNumber}.`;
  }
  return matches
    .map((issue) => {
      const status = typeof issue.status === "string" ? issue.status : "unknown";
      return `${issue.id} [${status}] ${issue.title}`;
    })
    .join("\n");
}

export type WorkUnitSessionCheckResult = {
  workUnitId: string;
  worktreePath: string | null;
  lockReason: string | null;
  checked: true;
  valid: true;
  reason: "no_matching_worktree" | "no_active_session";
};

export function checkWorkUnitSession(
  workUnitId: string,
  repoPath = process.cwd(),
  readWorktrees: typeof listWorktrees = listWorktrees,
  deps: {
    isPidAlive?: PidAliveProbe;
    unlock?: typeof unlockWorktree;
    log?: (line: string) => void;
  } = {},
): WorkUnitSessionCheckResult {
  const entry = readWorktrees(repoPath).find((candidate) => candidate.branch === workUnitId) ?? null;
  if (entry?.locked) {
    const pid = parseSessionLockPid(entry.lockReason);
    const probe = deps.isPidAlive ?? defaultPidAliveProbe;
    const stale = pid !== null && !probe(pid);
    if (stale) {
      const unlock = deps.unlock ?? unlockWorktree;
      unlock(entry.path);
      deps.log?.(
        `reclaimed stale prx session lock on ${entry.path} (pid ${pid} no longer running).`,
      );
    } else {
      const reason = entry.lockReason ? `: ${entry.lockReason}` : "";
      throw new CliError(
        `${prxSessionCannotOpenPrefix(workUnitId)} an active worktree session is already running at ${entry.path}${reason}.`,
      );
    }
  }

  return {
    workUnitId,
    worktreePath: entry?.path ?? null,
    lockReason: entry?.lockReason ?? null,
    checked: true,
    valid: true,
    reason: entry ? "no_active_session" : "no_matching_worktree",
  };
}

function formatWorkUnitSessionCheck(result: WorkUnitSessionCheckResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (result.worktreePath) {
    return `No active session for ${result.workUnitId}; existing worktree ${result.worktreePath} is not locked.`;
  }

  return `No active session for ${result.workUnitId}; no matching worktree is currently attached.`;
}

type CodexSessionMeta = {
  id: string;
  cwd: string;
  timestamp: string;
};

function codexHomePath(): string | null {
  const configured = getEnv("CODEX_HOME")?.trim();
  if (configured) {
    return configured;
  }
  const home = getEnv("HOME")?.trim();
  return home ? join(home, ".codex") : null;
}

function listCodexSessionFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCodexSessionFiles(path));
      continue;
    }
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function readCodexSessionMeta(path: string): CodexSessionMeta | null {
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0]?.trim();
    if (!firstLine) {
      return null;
    }
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown };
    };
    if (parsed.type !== "session_meta") {
      return null;
    }
    if (
      typeof parsed.payload?.id !== "string" ||
      typeof parsed.payload.cwd !== "string" ||
      typeof parsed.payload.timestamp !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.payload.id,
      cwd: parsed.payload.cwd,
      timestamp: parsed.payload.timestamp,
    };
  } catch {
    return null;
  }
}

function slugifyClaudeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function claudeProjectsRoot(homeDir = getEnv("HOME")?.trim()): string | null {
  return homeDir ? join(homeDir, ".claude", "projects") : null;
}

export function findSavedClaudeSession(
  launchCwd: string,
  homeDir = getEnv("HOME")?.trim(),
): boolean {
  const root = claudeProjectsRoot(homeDir);
  if (!root) {
    return false;
  }
  const projectDir = join(root, slugifyClaudeProjectPath(launchCwd));
  if (!existsSync(projectDir)) {
    return false;
  }
  let entries;
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    try {
      const stats = statSync(join(projectDir, entry.name));
      if (stats.size > 0) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function findSavedCodexSession(
  workUnitId: string,
  launchCwd: string,
  homePath = codexHomePath(),
): CodexSessionMeta | null {
  if (!homePath) {
    return null;
  }
  const sessionsRoot = join(homePath, "sessions");
  const matches = listCodexSessionFiles(sessionsRoot)
    .map((path) => readCodexSessionMeta(path))
    .filter((meta): meta is CodexSessionMeta => meta !== null)
    .filter((meta) => meta.cwd === launchCwd || basename(meta.cwd) === workUnitId)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  return matches[0] ?? null;
}

function resolveCodexSessionProfile(
  profile: RuntimeProfileProjection,
  workUnitId: string,
  launchCwd: string,
): { profile: RuntimeProfileProjection; message: string | null } {
  if (profile.command !== "codex" || profile.args[0] !== "resume" || !profile.fallbackArgs) {
    return { profile, message: null };
  }

  const saved = findSavedCodexSession(workUnitId, launchCwd);
  if (!saved) {
    return {
      profile: {
        ...profile,
        args: [...profile.fallbackArgs],
      },
      message: `No saved Codex session for ${workUnitId}; starting a fresh session instead.`,
    };
  }

  const args = [...profile.args];
  args[5] = saved.id;
  return {
    profile: {
      ...profile,
      args,
    },
    message: null,
  };
}

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

async function probeNonGhResolver(
  workUnitId: string,
  repoPath: string,
  loadIdentity: typeof loadIdentityConfig,
  buildResolver: typeof resolverForCanonicalId,
): Promise<ResolvedWorkUnit | null> {
  const identity = loadIdentity(repoPath);
  const resolver = buildResolver(workUnitId, identity, repoPath);
  if (resolver === null) return null;
  let resolved: ResolvedWorkUnit;
  try {
    // notion-cli hits the lookup cache first (cheap); REST is heavier but
    // only reached when the unit has no GH/beads backing at all.
    resolved = await resolver.fetch(workUnitId);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new CliError(prxSessionSourceNotFoundMessage(workUnitId, resolver.name, details));
  }
  if (resolved.state === "closed") {
    throw new CliError(prxSessionSourceClosedMessage(workUnitId, resolved));
  }
  return resolved;
}

/**
 * prx-jcb: does a content-addressed artifact already link this unit locally?
 *
 * The in-toto / SLSA framing the operator is steering toward: a unit is
 * "projected locally" iff it exists in the artifact graph — not iff the external
 * GitHub board has a row for it. A plan in CAS (`<unit>:plan@draft|approved`) is
 * the proof the intake→triage→plan edges ran for this unit, so its presence is a
 * valid local projection. We return `exists` only (not the validity verdict):
 * the gate answers "is it projected", the downstream consumer (`prx implement
 * agent` already refuses on `validated_ok=false`) answers "is it valid" — one
 * source of refusal, no double-gating.
 */
async function defaultHasLocalPlanArtifact(
  workUnitId: string,
  showPlan: typeof runPlanShow = runPlanShow,
): Promise<boolean> {
  try {
    await showPlan({ unit: workUnitId });
    return true;
  } catch {
    // PlanRefNotFound (no plan for this unit) — and any CAS read error — mean we
    // cannot claim a local artifact projection; fall through to the board path.
    return false;
  }
}

export async function checkWorkUnitChain(
  workUnitId: string,
  repoPath: string,
  create: boolean,
  readBoardStatus: typeof boardStatus,
  readParityChain: typeof buildParityChain,
  readGitHubIssue: typeof validateGitHubIssue = validateGitHubIssue,
  loadIdentity: typeof loadIdentityConfig = loadIdentityConfig,
  buildResolver: typeof resolverForCanonicalId = resolverForCanonicalId,
  from?: WorkUnitSource,
  readEpicChildren: typeof findEpicChildren = findEpicChildren,
  probeSchema: typeof probeBdSchema = probeBdSchema,
  // prx-jcb: artifact-native local-projection probe (in-toto framing). Default
  // checks the CAS plan ref; injectable so tests stay offline.
  hasLocalPlanArtifact: (unit: string) => Promise<boolean> = defaultHasLocalPlanArtifact,
): Promise<WorkUnitChainCheckResult> {
  let board: ReturnType<typeof boardStatus>;
  try {
    // GH-2306: this verb only ever reads the target unit's row, and
    // `workUnitId` is concrete here — so scope the remote hydration to that one
    // branch instead of fanning out across every worktree. The board still
    // enumerates all units (so the existence check below is unchanged); only
    // the per-unit remote/local probes are collapsed to the target.
    board = readBoardStatus(repoPath, { remote: true, targetBranch: workUnitId });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new CliError(prxSessionBoardReadFailureMessage(workUnitId, details));
  }
  const unit = board.units.find((candidate) => normalizeCanonicalWorkUnitId(candidate.branch) === workUnitId);

  // GH-935: when no parity unit exists yet, this verb is about to either
  // materialize a fresh worktree (`create=true`) or refuse with a hint. In
  // both shapes the operator is one decision away from a worktree that
  // can't actually ship, so refuse early when the resolved GH issue is
  // `type::epic`. Children come from beads parent-child edges (GH-891 epic
  // content layer is authoritative). The cached issue is reused below to
  // avoid a duplicate `gh issue view` round-trip in the missing-unit branch.
  let cachedGhIssue: ReturnType<typeof validateGitHubIssue> | null = null;
  if (!unit) {
    const epicCheckIssueNumber = githubIssueNumberForWorkUnit(workUnitId);
    // GH-870: skip the GH fetch when --from=notion was passed against a GH
    // canonical id — the existing branch below already rejects with a clear
    // error, and the epic check would otherwise mask it with a `gh` failure.
    // GH-2090: same defensive skip for --from=beads.
    if (epicCheckIssueNumber !== null && !(create && (from === "notion" || from === "beads"))) {
      cachedGhIssue = readGitHubIssue(board.repo, epicCheckIssueNumber);
      if (hasEpicLabel(cachedGhIssue.labels)) {
        // GH-935: if `bd` itself fails (missing binary, parse error, schema
        // drift), still refuse — falling back to an empty children list keeps
        // the operator on the refusal path with the "no children registered"
        // hint, rather than escaping as a non-CliError that would surface as a
        // raw stack trace.
        let children: ReturnType<typeof readEpicChildren>;
        try {
          children = readEpicChildren(repoPath, epicCheckIssueNumber);
        } catch {
          children = [];
        }
        throw new CliError(prxSessionEpicRefusalMessage(workUnitId, children));
      }
    }
  }

  if (!unit) {
    if (create) {
      // GH-870: when `--from=notion` is explicit, validate the Notion ticket
      // exists and is open before allowing materialization. probeNonGhResolver
      // throws prxSessionSourceClosedMessage / prxSessionSourceNotFoundMessage
      // on failure, and returns null when no non-GitHub resolver is configured;
      // the caller throws prxSessionNoSourceConfiguredMessage in that case. On
      // success the resolved unit is informational and we fall through to allow
      // create. --from=notion is only valid for non-GH canonical IDs.
      if (from === "notion") {
        if (githubIssueNumberForWorkUnit(workUnitId) !== null) {
          throw new CliError(
            `--from=notion is not valid for GitHub work unit IDs (${workUnitId}). Use a Notion canonical ID or omit --from=notion.`,
          );
        }
        const resolved = await probeNonGhResolver(workUnitId, repoPath, loadIdentity, buildResolver);
        if (resolved === null) {
          throw new CliError(prxSessionNoSourceConfiguredMessage(workUnitId));
        }
      }
      // GH-2090: mirror of the --from=notion arm above for bd-backed canonical
      // ids on canonical=bd repos. Dispatch by canonical-id shape (handled by
      // resolverForCanonicalId via BeadsResolver), so we don't assert
      // resolved.source === "beads" here — the notion arm doesn't either.
      //
      // GH-2152: through the `session`/`plan session` command flow this GH-shaped
      // rejection is unreachable — the equivalent guard lifted upstream by GH-2140
      // (validateWorkSessionEntry, ~line 4003) fires first on the local wtStatus
      // view, and canonical=bd ids normalize/bail in primePlanSession before this
      // helper sees a GH id. This arm is retained as defense-in-depth for
      // standalone/direct checkWorkUnitChain callers (see the standalone-caller
      // test in cli.test.ts), and the operator hint still surfaces via the lifted
      // guard in the only config where it is meaningful (canonical=GH).
      if (from === "beads") {
        if (githubIssueNumberForWorkUnit(workUnitId) !== null) {
          throw new CliError(
            `--from=beads is not valid for GitHub work unit IDs (${workUnitId}). Use a BD canonical ID or omit --from=beads.`,
          );
        }
        const resolved = await probeNonGhResolver(workUnitId, repoPath, loadIdentity, buildResolver);
        if (resolved === null) {
          throw new CliError(prxSessionNoSourceConfiguredMessage(workUnitId));
        }
      }
      return {
        workUnitId,
        create,
        unitExists: false,
        issueAuthorityActive: null,
        pruneActions: [],
        backfillActions: [],
        checked: true,
        valid: true,
        reason: "missing_unit_allowed",
      };
    }
    const issueNumber = githubIssueNumberForWorkUnit(workUnitId);
    if (issueNumber !== null) {
      // GH-935: reuse the issue fetched for the epic-label check above when
      // available; otherwise fetch fresh (the canonical id was non-GH at the
      // earlier check point, which can't happen here, but keep the fallback
      // to avoid a hard dependency between the two branches).
      const issue = cachedGhIssue && cachedGhIssue.number === issueNumber
        ? cachedGhIssue
        : readGitHubIssue(board.repo, issueNumber);
      const state = (issue.state ?? "").toUpperCase();
      if (state !== "OPEN") {
        throw new CliError(
          `${prxSessionCannotOpenPrefix(workUnitId)} GitHub issue #${issue.number} in ${board.repo} is ${state.toLowerCase()}. Reopen the issue or choose a different work unit.`,
        );
      }
      return {
        workUnitId,
        create,
        unitExists: false,
        issueAuthorityActive: true,
        pruneActions: [],
        backfillActions: [],
        checked: true,
        valid: true,
        reason: "missing_unit_allowed",
      };
    }
    // GH-799: non-GH canonical id — probe the configured issue-authority
    // resolver (Notion, etc.) before falling through to a generic error, so
    // the operator gets the ticket title + url and a targeted next step.
    const resolved = await probeNonGhResolver(workUnitId, repoPath, loadIdentity, buildResolver);
    if (resolved === null) {
      throw new CliError(prxSessionNoSourceConfiguredMessage(workUnitId));
    }
    // prx-adj: content-anchor the chain ROOT. We have the resolved issue/bead
    // authority here, so FOD-pin it as `<unit>:source@pinned` — the chain is now
    // anchored to the exact source text at entry, and `workUnitSourceFresh`
    // makes upstream drift observable. Best-effort: a CAS write must never break
    // session entry.
    await pinWorkUnitSourceBestEffort(workUnitId, resolved);
    // prx-jcb: the GH board has no parity row, but ask the artifact graph before
    // refusing. A plan in CAS is a valid local projection (in-toto: the artifact
    // links the unit, so we don't re-probe external board/git state). Entry is
    // allowed; the consumer validates the artifact it reads.
    if (await hasLocalPlanArtifact(workUnitId)) {
      return {
        workUnitId,
        create,
        unitExists: true,
        issueAuthorityActive: true,
        pruneActions: [],
        backfillActions: [],
        checked: true,
        valid: true,
        reason: "artifact_projected",
      };
    }
    throw new CliError(
      prxSessionNotProjectedLocallyMessage(workUnitId, resolved),
      1,
      prxSessionNotProjectedLocallyEnvelope(workUnitId, resolved),
    );
  }

  const remoteStatus = unit.status?.remote;
  const localStatus = unit.status?.local;

  // GH-924: when the worktree is still on disk for a terminal-phase unit
  // (PR merged/closed, or issue completed), the parity chain emits no prune
  // action — `delete_local_branch` only fires for orphaned branches without a
  // worktree. Without this gate, session entry falls through to attaching a
  // tmux pane whose bootstrap process exits, leaving the operator staring at
  // a silent red `[exited]`. Catch terminal-phase units here, ahead of the
  // `!issueBacked` authority gate below — the issue-authority message frames
  // closure as a missing-authority error and recommends `prx worktree-remove`,
  // but a merged + closed unit is a *completed* lifecycle whose canonical
  // teardown is `prx prune`.
  {
    const prLifecycleCompleted = remoteStatus?.pr === "completed";
    const prMergeState =
      remoteStatus?.merge_state === "merged"
        ? "merged"
        : remoteStatus?.merge_state === "closed"
          ? "closed"
          : prLifecycleCompleted && remoteStatus?.merge_state == null
            ? "closed"
            : null;
    const ghIssueClosed = remoteStatus?.gh_issue === "completed";
    const beadsIssueClosed = remoteStatus?.beads_issue === "completed";
    if (prMergeState !== null || ghIssueClosed || beadsIssueClosed) {
      throw new CliError(
        prxSessionUnitCompleteMessage(workUnitId, {
          prMergeState,
          ghIssueClosed,
          beadsIssueClosed,
          worktreePath: unit.worktree_path,
        }),
      );
    }
  }

  const issueBacked = remoteStatus
    ? remoteStatus.gh_issue === "dirty" || remoteStatus.beads_issue === "dirty"
    : false;

  if (!issueBacked) {
    // For non-GH canonical IDs (PROJ-*, PROD-*, etc.) GH/beads issue
    // authority always reads as "clean" — probe the configured resolver instead.
    const issueNumber = githubIssueNumberForWorkUnit(workUnitId);
    if (issueNumber === null) {
      const resolved = await probeNonGhResolver(workUnitId, repoPath, loadIdentity, buildResolver);
      if (resolved === null) {
        throw new CliError(prxSessionNoSourceConfiguredMessage(workUnitId));
      }
    } else {
      throw new CliError(describeInactiveIssueAuthority(workUnitId, remoteStatus, localStatus));
    }
  }

  const parity = readParityChain === buildParityChain
    ? buildSurfaceSyncFromBoard(repoPath, board, {
      mode: "full",
      authority: "issue",
      scope: "all",
      apply: false,
    })
    : readParityChain(repoPath, {
      mode: "full",
      authority: "issue",
      scope: "all",
      apply: false,
    });
  const parityUnit = parity.units.find((candidate) => normalizeCanonicalWorkUnitId(candidate.branch) === workUnitId);
  const actions = parityUnit?.actions ?? [];

  const pruneActionRecords = actions
    .filter(
      (action) =>
        action.type === "delete_local_branch"
        || action.type === "delete_remote_branch"
        || action.type === "delete_worktree",
    );
  const pruneActions = pruneActionRecords.map((action) => action.type);
  if (pruneActions.length > 0) {
    // GH-914: the action enumerator already drops `delete_remote_branch`
    // for teammate-authored remote branches, so any prune action that
    // reaches this point targets operator-controlled artifacts. Cross-
    // reference the parity board for any remaining foreign branches
    // defensively — if the gate is ever bypassed, surface a non-
    // destructive remediation instead of prescribing `prx chain prune`.
    const foreignBranches = pruneActionRecords
      .filter((action) => action.type === "delete_remote_branch" && action.remote !== "local")
      .map((action) => action.branch)
      .filter((branch) => {
        const candidate = board.units.find((u) => u.branch === branch);
        return candidate?.remote_branch_author?.isOperator === false;
      });
    throw new CliError(prxSessionParityCleanupMessage(workUnitId, pruneActions, foreignBranches));
  }

  const backfillActions = actions
    .filter((action) => action.type === "create_local_branch" || action.type === "create_worktree")
    .map((action) => action.type);

  // GH-1152: detect bd schema drift (missing `started_at` column on worktrees
  // that missed compat migration 017). Reported alongside backfill state, but
  // strictly informational — the operator unblocks via `prx chain repair-bd`.
  // backfill takes precedence in the `reason` field because backfill blocks
  // session-open while drift only blocks `bd export` warnings on commit.
  let bdSchemaProbe: BdSchemaProbeResult | undefined;
  if (existsSync(join(repoPath, ".beads"))) {
    try {
      bdSchemaProbe = probeSchema(repoPath);
    } catch {
      // Probe is best-effort; never fail chain check on a bd binary issue.
      bdSchemaProbe = undefined;
    }
  }
  const driftDetected = bdSchemaProbe?.status === "drift_detected";
  const reason: WorkUnitChainCheckResult["reason"] = backfillActions.length > 0
    ? "backfill_allowed"
    : driftDetected
      ? "bd_schema_drift_detected"
      : "ok";

  return {
    workUnitId,
    create,
    unitExists: true,
    issueAuthorityActive: true,
    pruneActions,
    backfillActions,
    checked: true,
    valid: true,
    reason,
    ...(bdSchemaProbe ? { bdSchemaProbe } : {}),
  };
}

function formatWorkUnitChainCheck(result: WorkUnitChainCheckResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (result.reason === "missing_unit_allowed") {
    return result.issueAuthorityActive
      ? `Parity chain check passed for ${result.workUnitId}: open GitHub issue authority can bootstrap this unit before local projection exists.`
      : `Parity chain check passed for ${result.workUnitId}: no existing issue-backed unit yet, which is allowed for pre-switch creation.`;
  }

  if (result.reason === "artifact_projected") {
    return `Parity chain check passed for ${result.workUnitId}: no GitHub-board parity row, but a content-addressed plan artifact already links this unit locally — the artifact graph is the projection.`;
  }

  if (result.reason === "backfill_allowed") {
    return `Parity chain check passed for ${result.workUnitId}: local backfill is still needed, but opening the PRX session can reconcile it automatically.`;
  }

  if (result.reason === "bd_schema_drift_detected") {
    return `Parity chain check passed for ${result.workUnitId}: bd schema drift detected (column "started_at" missing). Run \`prx chain repair-bd\` to apply compat migration 017.`;
  }

  return `Parity chain check passed for ${result.workUnitId}: issue authority is active and no cleanup is required.`;
}

async function validateWorkSessionEntry(
  workUnitId: string,
  repoPath: string,
  create: boolean,
  readBoardStatus: typeof boardStatus,
  readParityChain: typeof buildParityChain,
  readGitHubIssue: typeof validateGitHubIssue,
  pruneRefs: typeof pruneStaleRemoteRefs = pruneStaleRemoteRefs,
  from?: WorkUnitSource,
  readEpicChildren: typeof findEpicChildren = findEpicChildren,
  readWtStatus: typeof wtStatus = wtStatus,
): Promise<void> {
  // GH-2140 (uh534.1/GH-2113, uh534.2/GH-2120): the GH-870 contract — `--from=beads`
  // and `--from=notion` are invalid against GitHub-keyed canonical ids when no local
  // parity unit exists yet — mirrors the in-body refusal arms in checkWorkUnitChain
  // (`!unit && create` branch), which only reject in the missing-unit case. Lift it to
  // the front of the entry boundary so the rejection no longer hides behind two
  // upstream `gh` round-trips (`gh pr list` + `remoteStatus`) via boardStatus.
  //
  // Gate on a LOCAL-only worktree check (`wt list`, TTL-cached) rather than the remote
  // board: an existing parity unit still falls through to the current path (preserving
  // GH-870's accept-when-unit-exists contract, e.g. an idempotent re-open with a moot
  // --from). Validating that the local view is fresh — and redirecting the operator to
  // fetch when it is stale — is the deferred validate-work-session IO work (udqx2.1) and
  // is intentionally out of scope here. The in-body arms in checkWorkUnitChain are
  // retained as defense-in-depth for standalone callers.
  if (create && (from === "notion" || from === "beads") && githubIssueNumberForWorkUnit(workUnitId) !== null) {
    const localView = readWtStatus(repoPath, false);
    const hasLocalParityUnit =
      localView.wt_available &&
      localView.worktrees.some((candidate) => normalizeCanonicalWorkUnitId(candidate.branch) === workUnitId);
    if (!hasLocalParityUnit) {
      throw new CliError(
        `--from=${from} is not valid for GitHub work unit IDs (${workUnitId}). ` +
          `Use a ${from === "beads" ? "BD" : "Notion"} canonical ID or omit --from=${from}.`,
      );
    }
  }
  // GH-519: drop stale origin/GH-NNN remote-tracking refs before evaluating
  // the parity chain so a deleted remote branch doesn't trigger a
  // `delete_remote_branch` action against a ref that's already gone.
  pruneRefs(repoPath);
  // Backfill actions (create_local_branch, create_worktree) are resolved
  // automatically by resolveWorkUnitLaunchCwd — no need to block here.
  await checkWorkUnitChain(
    workUnitId,
    repoPath,
    create,
    readBoardStatus,
    readParityChain,
    readGitHubIssue,
    loadIdentityConfig,
    resolverForCanonicalId,
    from,
    readEpicChildren,
  );
}

/**
 * GH-549: read-only inspection for `prx session open --check`. Reports the
 * current local/remote branch and worktree state for a work unit without
 * running `wt switch`, calling `materializeWorkUnitBranch`, or touching any
 * refs/worktrees. Safe to call when no local checkout exists yet.
 */
export type SessionOpenCheckReport = {
  workUnitId: string;
  localBranch: "absent" | "present";
  remoteBranch: "absent" | "present";
  worktreePath: string | null;
  taskContract: "missing" | "present" | "not-applicable";
  task?: TaskContract;
};

export function inspectSessionOpenState(
  workUnitId: string,
  cwd: string = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
  runner: GithubCommandRunner = defaultRunner,
): SessionOpenCheckReport {
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);

  const localRef = spawn(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${workUnitId}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const localBranch = (localRef.status ?? 1) === 0 ? "present" : "absent";

  const remoteRef = spawn(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${workUnitId}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const remoteBranch = (remoteRef.status ?? 1) === 0 ? "present" : "absent";

  const entries = listResolvedWorktrees(repoRoot, runner);
  const worktreeEntry =
    entries.find((entry) => entry.branch === workUnitId)
    ?? findWorktreeByDirectoryPrefix(entries, workUnitId);

  if (!worktreeEntry) {
    return {
      workUnitId,
      localBranch,
      remoteBranch,
      worktreePath: null,
      taskContract: "not-applicable",
    };
  }

  const taskPath = defaultTaskPath(worktreeEntry.path);
  if (!taskContractExists(taskPath)) {
    return {
      workUnitId,
      localBranch,
      remoteBranch,
      worktreePath: worktreeEntry.path,
      taskContract: "missing",
    };
  }

  return {
    workUnitId,
    localBranch,
    remoteBranch,
    worktreePath: worktreeEntry.path,
    taskContract: "present",
    task: loadTaskContract(taskPath),
  };
}

export function formatSessionOpenCheck(
  report: SessionOpenCheckReport,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        workUnitId: report.workUnitId,
        localBranch: report.localBranch,
        remoteBranch: report.remoteBranch,
        worktreePath: report.worktreePath,
        taskContract: report.taskContract,
        task: report.task ?? null,
        taskStatus: report.task ? deriveTaskStatus(report.task) : null,
      },
      null,
      2,
    );
  }
  const lines = [
    `workUnit=${report.workUnitId}`,
    `localBranch=${report.localBranch}`,
    `remoteBranch=${report.remoteBranch}`,
    `worktreePath=${report.worktreePath ?? "none"}`,
    `taskContract=${report.taskContract}`,
  ];
  if (report.task) {
    const status = deriveTaskStatus(report.task);
    lines.push(
      `bead=${report.task.identity.beadId ?? "unlinked"}`,
      `currentRole=${report.task.rolePlan.currentRole}`,
      `machine=${status.machineState}`,
      `handoff=${status.handoffStatus}`,
      `nextRole=${status.nextRole ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function argvNamespaceRewritten(before: string[], after: string[]): boolean {
  if (before.length !== after.length) {
    return true;
  }
  return before.some((value, index) => value !== after[index]);
}

export function normalizeNamespaceArgv(argv: string[]): string[] {
  const [c0, c1, ...tail] = argv;
  if (!c0) {
    return argv;
  }

  if (c0 === "contract") {
    if (!c1 || c1.startsWith("-")) {
      return argv;
    }
    const reroute: Record<string, string> = {
      // GH-357: top-level `prx init` is now the cross-agent scaffold; the PR
      // contract initializer is reachable only via `prx contract init` and
      // routes to the `contract-init` command.
      init: "contract-init",
      status: "status",
      transition: "transition",
      event: "event",
      skills: "skills",
      "open-mode": "open-mode",
      update: "update",
      show: "contract",
    };
    const target = reroute[c1];
    if (!target) {
      throw new CliError(
        `Unknown contract subcommand: ${c1}. Expected: init, status, transition, event, skills, open-mode, update, show.`,
      );
    }
    if (target === "contract") {
      return [target, ...tail];
    }
    return [target, ...tail];
  }

  if (c0 === "model") {
    if (!c1 || c1.startsWith("-")) {
      return argv;
    }
    if (c1 === "graph") {
      return ["graph", ...tail];
    }
    if (c1 === "actors") {
      return ["actors", ...tail];
    }
    if (c1 === "show") {
      return ["model", ...tail];
    }
    if (c1 === "stately") {
      return ["stately", ...tail];
    }
    throw new CliError(`Unknown model subcommand: ${c1}`);
  }

  if (c0 === "chain") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "chain requires a subcommand: status, check, check-issue, check-session, prune, backfill, sync, repair-bd",
      );
    }
    if (c1 === "status") {
      return ["chains", ...tail];
    }
    if (c1 === "check") {
      return ["check-chain", ...tail];
    }
    if (c1 === "check-issue") {
      return ["check-issue", ...tail];
    }
    if (c1 === "check-session") {
      return ["check-session", ...tail];
    }
    if (c1 === "prune") {
      return ["prune", ...tail];
    }
    if (c1 === "backfill") {
      return ["backfill", ...tail];
    }
    if (c1 === "sync") {
      return ["reconcile", ...tail];
    }
    if (c1 === "repair-bd") {
      return ["repair-bd", ...tail];
    }
    throw new CliError(`Unknown chain subcommand: ${c1}`);
  }

  if (c0 === "repo") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "repo requires a subcommand: add, add-dolthub, bootstrap, backfill, gc, refresh, list, audit, normalize, materialize, overview, status, checks, sync-issues, sync-status, protect-main, ci, pr-comments",
      );
    }
    if (c1 === "list") {
      return ["repos", ...tail];
    }
    if (c1 === "audit") {
      return ["repo-audit", ...tail];
    }
    if (c1 === "local") {
      return ["repos-local", ...tail];
    }
    if (c1 === "normalize") {
      return ["repos", "normalize", ...tail];
    }
    if (c1 === "add") {
      return ["repos-add", ...tail];
    }
    if (c1 === "adopt") {
      // GH-1760: idempotent registry write for an existing on-disk worktree.
      return ["repos-adopt", ...tail];
    }
    if (c1 === "backfill") {
      return ["repos-backfill", ...tail];
    }
    if (c1 === "refresh") {
      return ["repo-refresh", ...tail];
    }
    if (c1 === "gc") {
      return ["repos-gc", ...tail];
    }
    if (c1 === "add-dolthub") {
      return ["repos-add-dolthub", ...tail];
    }
    if (c1 === "bootstrap") {
      return ["repos-bootstrap", ...tail];
    }
    if (c1 === "materialize") {
      return ["repos-materialize", ...tail];
    }
    if (c1 === "overview") {
      return ["overview", ...tail];
    }
    if (c1 === "status") {
      return ["repo-status", ...tail];
    }
    if (c1 === "checks") {
      return ["repo-checks", ...tail];
    }
    if (c1 === "sync-issues") {
      return ["sync-issues", ...tail];
    }
    if (c1 === "sync-status") {
      return ["sync-status", ...tail];
    }
    if (c1 === "protect-main") {
      return ["protect-main", ...tail];
    }
    if (c1 === "ci") {
      return ["remote-ci-check", ...tail];
    }
    if (c1 === "pr-comments") {
      return ["pr-comments", ...tail];
    }
    if (c1 === "set") {
      return ["repos-set", ...tail];
    }
    throw new CliError(`Unknown repo subcommand: ${c1}`);
  }

  // Plural ergonomic: `prx repos local` mirrors `prx repo local`.
  // Bare `prx repos` falls through to the existing repos command.
  if (c0 === "repos" && c1 === "local") {
    return ["repos-local", ...tail];
  }

  // GH-1761: registry-side branch namespace. `prx branch adopt` writes a
  // BranchRow tied to a previously-adopted repo. No other `branch` verbs ship
  // in GH-1761 — additions land alongside their own tickets.
  if (c0 === "branch") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("branch requires a subcommand: adopt");
    }
    if (c1 === "adopt") {
      return ["branch-adopt", ...tail];
    }
    throw new CliError(`Unknown branch subcommand: ${c1}`);
  }

  // GH-1762: registry-side workspace namespace. `prx workspace adopt`
  // produces the `workspace_id` every downstream adopt-flow verb keys off.
  // GH-1978: workspace lifecycle actor (reserve/prepare/sync/service/teardown)
  // retires wtctl's sync / ignore sync / up / down surface. Drivers
  // (worktrunk today; devcontainer / nix devShell / CI pre-job tomorrow) call
  // into the actor only through these verbs; the verb-level parser/dispatcher
  // lives in `src/workspace/cli.ts`.
  if (c0 === "workspace") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "workspace requires a subcommand: adopt | reserve | materialize | prepare | sync | service | teardown",
      );
    }
    if (c1 === "adopt") {
      return ["workspace-adopt", ...tail];
    }
    if (
      c1 === "reserve" ||
      c1 === "materialize" ||
      c1 === "prepare" ||
      c1 === "sync" ||
      c1 === "service" ||
      c1 === "teardown"
    ) {
      return ["workspace", c1, ...tail];
    }
    throw new CliError(`Unknown workspace subcommand: ${c1}`);
  }

  // GH-2026/GH-2327: `prx gc <verb>` unified housekeeping actor. The verb-level
  // parser/dispatcher lives in `src/machine/gc/cli.ts`; this only routes the
  // raw argv tail. `prune`→`gc` rename stays out of scope (sibling 2l4ua).
  if (c0 === "gc") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "gc requires a subcommand: inventory | run | teardown",
      );
    }
    if (c1 === "inventory" || c1 === "run" || c1 === "teardown") {
      return ["gc", c1, ...tail];
    }
    throw new CliError(`Unknown gc subcommand: ${c1}`);
  }

  if (c0 === "scout") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "scout requires a subcommand: comments, ci, checks, logs, status, overview, dispatch, grep, files, read, notion, issues",
      );
    }
    // GH-1194: per-actor dispatch envelope. The leading `--source=<actor>`
    // flag is injected here so the downstream parser sees a uniform shape
    // regardless of which namespace the operator typed.
    if (c1 === "dispatch") {
      return ["dispatch", "--source=scout", ...tail];
    }
    // GH-1194 (sub-ticket D): first concrete scout FS-exploration verb.
    if (c1 === "grep") {
      return ["scout-grep", ...tail];
    }
    // GH-1384 PR-1: bounded glob walk.
    if (c1 === "files") {
      return ["scout-files", ...tail];
    }
    // GH-1384 PR-2: bounded text-only read.
    if (c1 === "read") {
      return ["scout-read", ...tail];
    }
    // GH-1420: Notion page UUID / Task-ID resolver.
    if (c1 === "notion") {
      return ["scout-notion", ...tail];
    }
    // GH-1244: read-only beads/Dolt projection.
    if (c1 === "issues") {
      return ["scout-issues", ...tail];
    }
    if (c1 === "comments" || c1 === "pr-comments") {
      return ["pr-comments", ...tail];
    }
    if (c1 === "ci") {
      return ["remote-ci-check", ...tail];
    }
    if (c1 === "checks") {
      return ["repo-checks", ...tail];
    }
    if (c1 === "logs") {
      return ["scout-logs", ...tail];
    }
    if (c1 === "status") {
      return ["repo-status", ...tail];
    }
    if (c1 === "overview") {
      return ["overview", ...tail];
    }
    throw new CliError(`Unknown scout subcommand: ${c1}`);
  }

  // GH-1768: derive actor — Datalog-as-derived-truth spike. Read-only
  // verbs over a projected fact set. Subcommand names mirror the
  // registry entries.
  if (c0 === "derive") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "derive requires a subcommand: ready, drift, eligible, why, dump-facts",
      );
    }
    if (
      c1 === "ready" ||
      c1 === "drift" ||
      c1 === "eligible" ||
      c1 === "why" ||
      c1 === "dump-facts"
    ) {
      return [`derive-${c1}`, ...tail];
    }
    throw new CliError(
      `Unknown derive subcommand: ${c1}. Available: ready, drift, eligible, why, dump-facts`,
    );
  }

  // GH-1423: rules actor — claude/rules/*.md as build artifact. Spike PR-1
  // wires verb-supply only; alias-supply / worktree-gestures / memory-index
  // are typed stubs. Verbs mirror the registry entries.
  if (c0 === "rules") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "rules requires a subcommand: render | validate | inputs",
      );
    }
    if (c1 === "render" || c1 === "validate" || c1 === "inputs") {
      return [`rules-${c1}`, ...tail];
    }
    throw new CliError(
      `Unknown rules subcommand: ${c1}. Available: render | validate | inputs`,
    );
  }

  // GH-1245: fetch actor spike — external→substrate refresh chokepoint.
  // v0 ships exactly one subverb (`gh-issues`) and is dry-run-only; the
  // spike doc (§4) recommends per-source verb shape before deciding the
  // plugin-envelope cut at source #2.
  if (c0 === "fetch") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "fetch requires a subcommand: gh-issues",
      );
    }
    if (c1 === "gh-issues") {
      return ["fetch-gh-issues", ...tail];
    }
    throw new CliError(`Unknown fetch subcommand: ${c1}. Available: gh-issues`);
  }

  // GH-1261: dep-research routine. PR-1 ships `dep manifest`, PR-2 ships
  // `dep research`, PR-3 (GH-1275) adds `dep status`. Bare `prx dep` lists
  // verbs and suggests a closest match on typo (per the unknown-subcommand
  // pattern — GH-1132 / GH-1217 / GH-1265 precedent).
  if (c0 === "dep") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("dep requires a subcommand: manifest | research | status");
    }
    if (c1 === "manifest") {
      return ["dep-manifest", ...tail];
    }
    if (c1 === "research") {
      return ["dep-research", ...tail];
    }
    if (c1 === "status") {
      return ["dep-status", ...tail];
    }
    throw new CliError(
      `Unknown dep subcommand: ${c1}. Available: manifest | research | status`,
    );
  }

  if (c0 === "delegate") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "delegate requires a subcommand: next | assign | repair-assignees",
      );
    }
    if (c1 === "next") {
      return ["delegate-next", ...tail];
    }
    if (c1 === "assign") {
      return ["delegate-assign", ...tail];
    }
    if (c1 === "repair-assignees") {
      return ["delegate-repair-assignees", ...tail];
    }
    throw new CliError(
      `Unknown delegate subcommand: ${c1}. Available: next | assign | repair-assignees`,
    );
  }

  if (c0 === "worktree") {
    if (!c1 || c1.startsWith("-")) {
      return argv;
    }
    if (c1 === "list") {
      return ["worktrees", ...tail];
    }
    if (c1 === "status") {
      return ["worktree", ...tail];
    }
    if (c1 === "remove") {
      return ["worktree-remove", ...tail];
    }
    // GH-1166: `prx worktree refresh` is the canonical home for the rebase-onto
    // -origin-main verb, replacing retired `prx session refresh`.
    if (c1 === "refresh") {
      return ["refresh", ...tail];
    }
    throw new CliError(`Unknown worktree subcommand: ${c1}`);
  }

  if (c0 === "run") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("run requires a subcommand: profile, smoke, desktop, task");
    }
    if (c1 === "profile") {
      return ["runtime-profile", ...tail];
    }
    if (c1 === "smoke") {
      return ["agent-smoke", ...tail];
    }
    if (c1 === "desktop") {
      return ["desktop", ...tail];
    }
    if (c1 === "task") {
      return ["task", ...tail];
    }
    throw new CliError(`Unknown run subcommand: ${c1}`);
  }

  if (c0 === "hooks") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("hooks requires a subcommand: apply, status");
    }
    if (c1 === "apply") {
      return ["hooks-apply", ...tail];
    }
    if (c1 === "status") {
      return ["hooks-status", ...tail];
    }
    throw new CliError(`Unknown hooks subcommand: ${c1}`);
  }

  if (c0 === "tools") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("tools requires a subcommand: wt, git, bd, labels");
    }
    if (c1 === "wt") {
      return ["tools-wt", ...tail];
    }
    if (c1 === "git") {
      return ["tools-git", ...tail];
    }
    if (c1 === "bd") {
      return ["tools-bd", ...tail];
    }
    if (c1 === "labels") {
      const c2 = tail[0];
      if (!c2 || c2.startsWith("-")) {
        throw new CliError("tools labels requires a subcommand: sync");
      }
      if (c2 === "sync") {
        return ["tools-labels-sync", ...tail.slice(1)];
      }
      throw new CliError(`Unknown tools labels subcommand: ${c2}`);
    }
    if (c1 === "mux") {
      const c2 = tail[0];
      if (!c2 || c2.startsWith("-")) {
        throw new CliError("tools mux requires a subcommand: clear-resurrect");
      }
      if (c2 === "clear-resurrect") {
        return ["tools-mux-clear-resurrect", ...tail.slice(1)];
      }
      throw new CliError(`Unknown tools mux subcommand: ${c2}`);
    }
    throw new CliError(`Unknown tools subcommand: ${c1}`);
  }

  // GH-1990: canonical actor surface for bd↔external reconcile. `prx sync
  // issues --from gh --to bd` is wired here; other pairs are rejected at
  // parse time (see the executor branch for `sync-issues-pair`).
  if (c0 === "sync") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("sync requires a subcommand: issues, backfill");
    }
    if (c1 === "issues") {
      return ["sync-issues-pair", ...tail];
    }
    if (c1 === "backfill") {
      return ["sync-backfill", ...tail];
    }
    throw new CliError(`Unknown sync subcommand: ${c1}`);
  }

  if (c0 === "beads") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "beads requires a subcommand: hydrate, issue, migrate, publish, sync, sync-all",
      );
    }
    if (c1 === "hydrate") {
      return ["beads-hydrate", ...tail];
    }
    if (c1 === "issue") {
      return ["beads-issue", ...tail];
    }
    if (c1 === "migrate") {
      return ["beads-migrate", ...tail];
    }
    if (c1 === "publish") {
      return ["beads-publish", ...tail];
    }
    if (c1 === "sync") {
      return ["beads-sync", ...tail];
    }
    if (c1 === "sync-all") {
      // GH-1702: cross-repo fan-out of `prx dolt reconcile` over every
      // dolthub-wired registered bare repo.
      return ["beads-sync-all", ...tail];
    }
    throw new CliError(`Unknown beads subcommand: ${c1}`);
  }

  if (c0 === "memory") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("memory requires a subcommand: compact");
    }
    if (c1 === "compact") {
      return ["memory-compact", ...tail];
    }
    throw new CliError(`Unknown memory subcommand: ${c1}`);
  }

  // GH-1397: `prx handoff <verb>` — structured handoff queue.
  if (c0 === "handoff") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "handoff requires a subcommand: enqueue | status | drain | replay",
      );
    }
    if (c1 === "enqueue") return ["handoff-enqueue", ...tail];
    if (c1 === "status") return ["handoff-status", ...tail];
    if (c1 === "drain") return ["handoff-drain", ...tail];
    if (c1 === "replay") return ["handoff-replay", ...tail];
    throw new CliError(`Unknown handoff subcommand: ${c1}`);
  }

  // GH-1495: `prx transcripts <verb>` — temporal→durable memory digest.
  if (c0 === "transcripts") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "transcripts requires a subcommand: digest | status | list-sources",
      );
    }
    if (c1 === "digest") {
      return ["transcripts-digest", ...tail];
    }
    if (c1 === "status") {
      return ["transcripts-status", ...tail];
    }
    if (c1 === "list-sources") {
      return ["transcripts-list-sources", ...tail];
    }
    throw new CliError(`Unknown transcripts subcommand: ${c1}`);
  }

  if (c0 === "triage") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "triage requires a subcommand: status, agent, result, classify, apply, promote, prioritize, type-pass, prioritize-bulk, prime, drift-fix, migrate-axis-value, close, close-stale, dispatch",
      );
    }
    // GH-1194: per-actor dispatch envelope.
    if (c1 === "dispatch") {
      return ["dispatch", "--source=triage", ...tail];
    }
    if (c1 === "status") {
      return ["triage-status", ...tail];
    }
    // GH-2380: `agent` is the canonical verb (headless-first); the hard-removed
    // `session` token errors with a removal hint.
    if (c1 === "agent") {
      return ["triage-session", ...tail];
    }
    // prx-9p9: the structured result tool the headless triage agent reports through.
    if (c1 === "result") {
      return ["triage-result", ...tail];
    }
    if (c1 === "session") {
      throw new CliError(
        "prx triage session: removed; use prx triage agent (add --interactive for the tmux/PTY session).",
      );
    }
    if (c1 === "classify") {
      return ["triage-classify", ...tail];
    }
    if (c1 === "apply") {
      return ["triage-apply", ...tail];
    }
    if (c1 === "promote") {
      return ["triage-promote", ...tail];
    }
    if (c1 === "promote-children") {
      return ["triage-promote-children", ...tail];
    }
    if (c1 === "drift-fix") {
      return ["triage-drift-fix", ...tail];
    }
    if (c1 === "migrate-axis-value") {
      return ["triage-migrate-axis-value", ...tail];
    }
    if (c1 === "prioritize") {
      return ["triage-prioritize", ...tail];
    }
    if (c1 === "type-pass") {
      return ["triage-type-pass", ...tail];
    }
    if (c1 === "prioritize-bulk") {
      return ["triage-prioritize-bulk", ...tail];
    }
    // GH-1719: actor-tied close for bd-only records.
    if (c1 === "close") {
      return ["triage-close", ...tail];
    }
    // GH-1782: bulk close beads whose linked GH issue is already closed.
    if (c1 === "close-stale") {
      return ["triage-close-stale", ...tail];
    }
    // GH-1015: orchestrator that drives untriaged → 0 by looping the
    // classify/apply/(priority)/promote chain on the GH-1052 machine.
    if (c1 === "prime") {
      return ["triage-prime", ...tail];
    }
    throw new CliError(`Unknown triage subcommand: ${c1}`);
  }

  // GH-2016: roadmap actor — `prx map <verb>`. PR-1 wires `create` + `show`;
  // `next` / `sync` ship as stubs at the actor layer and surface no CLI route
  // until their PR-2 / PR-3 child tickets land.
  if (c0 === "map") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("map requires a subcommand: create, show");
    }
    if (c1 === "create") {
      return ["map-create", ...tail];
    }
    if (c1 === "show") {
      return ["map-show", ...tail];
    }
    throw new CliError(`Unknown map subcommand: ${c1}`);
  }

  // GH-950: `prx plan` is the session-profile family verb for plan-mode work
  // sessions.
  // GH-978 (path (a) aliases-first): plan.* leaves rewrite to existing
  // canonical argv forms so plan-namespace verbs share implementations with
  // their top-level / session.* siblings without code duplication.
  if (c0 === "plan") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(
        "plan requires a subcommand: session | agent | prime | preflight | handoff | ultrareview | ci | status | next | save | load | show | view | search | dispatch",
      );
    }
    // GH-1194: per-actor dispatch envelope.
    if (c1 === "dispatch") {
      return ["dispatch", "--source=plan", ...tail];
    }
    if (c1 === "session" || c1 === "agent") {
      // prx-383: `prx plan agent` is the uniform headless verb — it parallels
      // `prx <actor> agent` for the other lifecycle steps and routes to the
      // same plan-session engine, whose default IS the non-interactive --print
      // headless plan generation (`--interactive` opts into the tmux session,
      // exactly as for `prx plan session`). This closes the last gap so every
      // step is `prx <actor> agent`.
      return ["plan-session", ...tail];
    }
    // GH-1056: pre-tmux setup of `prx plan session` exposed as its own verb.
    if (c1 === "prime") {
      return ["plan-prime", ...tail];
    }
    if (c1 === "handoff") {
      return ["close", ...tail];
    }
    if (c1 === "close") {
      // GH-1057: distinct verb from `plan handoff` (which aliases to `close`,
      // i.e. `closeSession` — post-merge cleanup that refuses unless merged).
      // `plan close` performs an actual issue close-without-merge with reason
      // + optional upstream pointer comment + bd github sync.
      return ["plan-close", ...tail];
    }
    if (c1 === "ultrareview") {
      return ["review", "--ultra", ...tail];
    }
    if (c1 === "ci") {
      return ["ci", ...tail];
    }
    if (c1 === "status") {
      return ["phase", ...tail];
    }
    if (c1 === "next") {
      return ["next-action", ...tail];
    }
    // GH-1173: CAS plan-store verb surface.
    if (c1 === "save") {
      return ["plan-save", ...tail];
    }
    if (c1 === "load") {
      return ["plan-load", ...tail];
    }
    if (c1 === "show") {
      return ["plan-show", ...tail];
    }
    // GH-1186: planner-side read primitives — twins of `intake view` /
    // `intake search`. Routed before the generic "unknown subcommand" error
    // so the parser sees the canonical command name.
    if (c1 === "view") {
      return ["plan-view", ...tail];
    }
    if (c1 === "search") {
      return ["plan-search", ...tail];
    }
    // GH-1239: deterministic three-axis pre-draft check.
    if (c1 === "preflight") {
      return ["plan-preflight", ...tail];
    }
    throw new CliError(`Unknown plan subcommand: ${c1}`);
  }

  if (c0 === "preflight") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("preflight requires a subcommand: claude | notion");
    }
    if (c1 === "claude") {
      return ["preflight-claude", ...tail];
    }
    if (c1 === "notion") {
      return ["preflight-notion-mcp", ...tail];
    }
    throw new CliError(`Unknown preflight subcommand: ${c1}`);
  }

  if (c0 === "home") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("home requires a subcommand: update | sync");
    }
    if (c1 === "update") {
      return ["home-update", ...tail];
    }
    if (c1 === "sync") {
      return ["home-sync", ...tail];
    }
    throw new CliError(`Unknown home subcommand: ${c1}`);
  }

  // prx-1ab: `prx upgrade` — the one-command self-update. Updates the `prx` flake
  // input (the installed binary), commits the lockfile, and runs home-manager
  // switch (all via `home-update`). `--input <name>` overrides the default to
  // update a different input. Tail flags (--dry-run/--format/--flake-dir) pass
  // through. (Distinct from `prx update`, which renders/updates the GitHub PR.)
  if (c0 === "upgrade") {
    const argv = [c1, ...tail].filter((a): a is string => a !== undefined);
    const hasInput = argv.some((a) => a === "--input" || a.startsWith("--input="));
    return hasInput ? ["home-update", ...argv] : ["home-update", "--input", "prx", ...argv];
  }

  if (c0 === "review") {
    return argv;
  }
  if (c0 === "ultrareview") {
    return ["review", "--ultra", ...argv.slice(1)];
  }

  // GH-955: `prx ci` is the CLI surface for the `local_ci` actor's `run`
  // accept (workflow tier verification_publication). Top-level leaf verb;
  // flags (`--phase`, `--format`) are handled in the parser block.
  if (c0 === "ci") {
    return argv;
  }

  if (c0 === "dolt") {
    // GH-2129: table-driven dispatch over DOLT_VERB_DISPATCH (the contract-side
    // source of truth in src/dolt/schema.ts). Every verb either rewrites to its
    // real command or to `dolt-stub`, which emits a typed not-implemented
    // outcome. No verb falls through to a bare `Unknown dolt subcommand` string.
    const verbs = Object.keys(DOLT_VERB_DISPATCH) as DoltVerb[];
    if (!c1 || c1.startsWith("-")) {
      throw new CliError(`dolt requires a subcommand: ${verbs.join(", ")}`);
    }
    const entry = DOLT_VERB_DISPATCH[c1 as DoltVerb];
    if (!entry) {
      throw new CliError(
        `Unknown dolt subcommand: ${c1} (available: ${verbs.join(", ")})`,
      );
    }
    if (entry.route === "dolt-stub") {
      return ["dolt-stub", c1, ...tail];
    }
    return [entry.route, ...tail];
  }

  if (c0 === "tmux") {
    if (!c1 || c1.startsWith("-")) {
      throw new CliError("tmux requires a subcommand: reconcile");
    }
    if (c1 === "reconcile") {
      return ["tmux-reconcile", ...tail];
    }
    throw new CliError(`Unknown tmux subcommand: ${c1}`);
  }

  // GH-1474: route `prx intake [<sub>...] --help` to the registry-backed
  // help renderers without disturbing the filing path (`prx intake <type>
  // <title>`). The filing handler at `command === "intake"` (cli.ts ~7377)
  // owns every argv shape that does not contain `--help` / `-h`. Stops
  // scanning at `--` so an explicit end-of-options boundary preserves a
  // literal `--help` for any future passthrough surface in this namespace.
  if (c0 === "intake") {
    const dashEnd = argv.indexOf("--");
    const scanWindow = dashEnd >= 0 ? argv.slice(1, dashEnd) : argv.slice(1);
    const wantsHelp = scanWindow.some((a) => a === "--help" || a === "-h");
    if (wantsHelp) {
      const subParts: string[] = [];
      for (const arg of argv.slice(1)) {
        if (arg.startsWith("-")) break;
        subParts.push(arg);
      }
      if (subParts.length === 0) {
        return ["intake-namespace-help"];
      }
      const canonicalVerb = ["intake", ...subParts].join("-");
      return [canonicalVerb, "--help"];
    }
    return argv;
  }

  return argv;
}

function parseActionDoCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "repo-path": { type: "string", default: "." },
      contract: { type: "string", default: ".pr/local/pr.json" },
      actor: { type: "string" },
      reason: { type: "string" },
      format: { type: "string", default: "plain" },
      log: { type: "string", default: ".prx/transitions.jsonl" },
      id: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  const actionId = positionals[0]?.trim();
  if (!actionId) {
    throw new CliError("do requires an action id");
  }
  if (positionals.length > 1) {
    throw new CliError("do accepts a single action id; pass options as flags");
  }
  return {
    command: "do",
    repoPath: values["repo-path"],
    actionId,
    contract: values.contract,
    actor: values.actor,
    reason: values.reason,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    log: values.log,
    id: values.id,
  };
}

function parseSessionOpenCommand(
  rest: string[],
  meta: {
    invokedViaDeprecatedWorkAlias?: boolean;
    invokedViaDeprecatedSessionShorthand?: boolean;
    invokedViaDeprecatedRootOpen?: boolean;
    invokedViaSessionOpen?: boolean;
    idLabel: string;
  },
): ParsedCommand {
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "session-help" };
  }
  // GH-2014: refuse `--detached` with a structured hint pointing at
  // `--background` so the operator does not confuse the git detached-HEAD
  // vocabulary (GH-1983) with the tmux background-attach intent.
  if (rest.includes("--detached") || rest.includes("--detached=true")) {
    throw new CliError(
      "--detached is not supported on `prx session open` / `prx plan session` (avoids the git detached-HEAD collision flagged in GH-1983); use --background to boot the session without attaching.",
    );
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      agent: { type: "string", default: "claude" },
      mode: { type: "string", default: "full" },
      "io-format": { type: "string", default: "json" },
      format: { type: "string", default: "plain" },
      prompt: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "create": { type: "boolean", default: false },
      from: { type: "string" },
      "no-verify": { type: "boolean", default: false },
      plan: { type: "string" },
      // GH-1643: route session entry to a different registered bare repo
      // (resolved via the .prx/repos inventory). Implies --create — when
      // set, the target worktree is materialized before launchCwd is
      // resolved against the target bare, not the caller's cwd.
      repo: { type: "string" },
      // GH-1239: opt-out for the auto-step preflight. Loud escape hatch —
      // when set, the planner enters the session even though the preflight
      // would have refused. Mirrors `plan save --skip-validate` (GH-1277).
      "skip-preflight": { type: "boolean", default: false },
      // GH-1164: accepted no-op marker. The outer `plan-session` dispatch
      // (parseCommand) consumes `--interactive` to fork between the
      // print-default (parseSessionPlanCommand) and the legacy interactive
      // path (parseSessionOpenCommand). Declared here so parseArgs in
      // strict mode does not reject it when normalizeNamespaceArgv or other
      // callers route `--interactive` through.
      interactive: { type: "boolean", default: false },
      // GH-2014: boot the tmux session without attaching the caller's TTY.
      // Differs from --no-attach (which is silent/scripted) by also printing
      // a re-entry hint to stderr.
      background: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const from = values.from === undefined
    ? undefined
    : ensureChoice(values.from, workUnitSources, "--from");
  if (from !== undefined && !values["create"]) {
    throw new CliError("--from requires --create (the source selector only applies when materializing a new work unit).");
  }

  const agent = ensureExecutionWorkflowAgent(parseWorkAgentImplementation(values.agent, "--agent"), "--agent");
  const ioFormat = validateWorkIoFormat(
    agent,
    ensureChoice(values["io-format"], runtimeIoFormats, "--io-format"),
  );
  const workUnitArg = positionals[0];
  const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
  if (!workUnitArg && detectedTarget?.launchFromCurrentWorkspace) {
    throw new CliError(
      [
        PRX_SESSION_OPEN_REQUIRES_TARGET,
        PRX_SESSION_OPEN_DEFINITION,
      ].join(" "),
    );
  }

  const workUnitId = workUnitArg
    ? parseCanonicalWorkUnitId(workUnitArg, meta.idLabel)
    : detectedTarget!.workUnitId;
  const launchFromCurrentWorkspace = detectedTarget?.launchFromCurrentWorkspace;
  const format = ensureChoice(values.format, ["plain", "json"], "--format");

  // GH-1643: --repo is mutually compatible with all session entry shapes
  // (it just retargets materialization + launchCwd). It implies --create
  // so the worktree exists before launch; --create stays valid alongside
  // it as a redundant explicit no-op.
  const repoSlug = values.repo === undefined ? undefined : values.repo;

  // GH-834: route the canonical interactive-claude entry through the
  // session-open-claude direct-exec path (tmux pane PID 1, no send-keys
  // replay). Codex, prompt-mode, --check/--create/--no-verify stay on
  // the legacy path — each depends on behaviour session-open-claude
  // does not yet implement.
  if (
    agent === "claude" &&
    values.prompt === undefined &&
    !values.check &&
    !values["create"] &&
    !values["no-verify"]
  ) {
    return {
      command: "session-open-claude",
      workUnitId,
      launchFromCurrentWorkspace,
      format,
      dryRun: values["dry-run"],
      noAttach: false,
      attachMode: values.background === true ? "background" : "foreground",
      invokedViaDeprecatedWorkAlias: meta.invokedViaDeprecatedWorkAlias,
      invokedViaSessionOpen: meta.invokedViaSessionOpen,
      planPath: values.plan !== undefined ? validatePlanPath(values.plan) : undefined,
      repoSlug,
      skipPreflight: values["skip-preflight"] === true,
    };
  }

  if (values.plan !== undefined) {
    throw new CliError(
      "--plan is only supported on the canonical claude path; remove --check/--create/--no-verify/--prompt or drop --plan.",
    );
  }
  // GH-2014: --background only governs the tmux-attach gate inside the
  // canonical claude path. The legacy `command: "session"` branch covers
  // codex / prompt-mode / --check / --create / --no-verify, none of which
  // own a mux attach step today. Refuse loudly instead of silently dropping.
  if (values.background === true) {
    throw new CliError(
      "--background is only supported on the canonical claude path; remove --check/--create/--no-verify/--prompt to use it.",
    );
  }

  return {
    command: "session",
    invokedViaDeprecatedWorkAlias: meta.invokedViaDeprecatedWorkAlias,
    invokedViaDeprecatedSessionShorthand: meta.invokedViaDeprecatedSessionShorthand,
    invokedViaDeprecatedRootOpen: meta.invokedViaDeprecatedRootOpen,
    invokedViaSessionOpen: meta.invokedViaSessionOpen,
    agent,
    mode: ensureChoice(values.mode, runtimeModes, "--mode"),
    workUnitId,
    launchFromCurrentWorkspace,
    ioFormat,
    format,
    prompt: values.prompt,
    dryRun: values["dry-run"],
    check: values.check,
    create: values["create"],
    from,
    noVerify: values["no-verify"],
    repoSlug,
    skipPreflight: values["skip-preflight"] === true,
  };
}

// GH-1056: parser for `prx plan prime <unit>`. Mirrors parseSessionOpenCommand
// minus --check / --dry-run (rejected explicitly — `prime` is itself the
// non-spawning pre-flight, so those flags are not meaningful here).
function parsePlanPrimeCommand(rest: string[]): ParsedCommand {
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "session-help" };
  }
  for (const flag of ["--check", "--dry-run"] as const) {
    if (rest.includes(flag)) {
      throw new CliError(
        "prx plan prime does not accept --check or --dry-run; the verb is itself a non-spawning pre-flight",
      );
    }
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      agent: { type: "string", default: "claude" },
      format: { type: "string", default: "plain" },
      prompt: { type: "string" },
      "create": { type: "boolean", default: false },
      from: { type: "string" },
      "no-verify": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const from = values.from === undefined
    ? undefined
    : ensureChoice(values.from, workUnitSources, "--from");
  if (from !== undefined && !values["create"]) {
    throw new CliError("--from requires --create (the source selector only applies when materializing a new work unit).");
  }

  const agent = ensureExecutionWorkflowAgent(parseWorkAgentImplementation(values.agent, "--agent"), "--agent");
  const workUnitArg = positionals[0];
  const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
  if (!workUnitArg && (!detectedTarget || detectedTarget.launchFromCurrentWorkspace)) {
    throw new CliError(
      "prx plan prime requires a work-unit id (e.g. GH-456).",
    );
  }
  if (positionals.length > 1) {
    throw new CliError("prx plan prime accepts a single work-unit id; pass options as flags");
  }

  const workUnitId = workUnitArg
    ? parseCanonicalWorkUnitId(workUnitArg, "plan prime")
    : detectedTarget!.workUnitId;
  const launchFromCurrentWorkspace = detectedTarget?.launchFromCurrentWorkspace;
  const format = ensureChoice(values.format, ["plain", "json"], "--format");
  const isInteractiveClaude = agent === "claude" && values.prompt === undefined;

  return {
    command: "plan-prime",
    workUnitId,
    launchFromCurrentWorkspace,
    agent,
    isInteractiveClaude,
    create: values["create"],
    noVerify: values["no-verify"],
    from,
    format,
  };
}

function parseReviewCommand(rest: string[]): ParsedCommand {
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "plan-namespace-help" };
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      ultra: { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    throw new CliError("review accepts at most one work-unit id; pass options as flags");
  }
  const workUnitArg = positionals[0];
  return {
    command: "review",
    workUnitId: workUnitArg ? parseCanonicalWorkUnitId(workUnitArg, "review") : undefined,
    ultra: values.ultra,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

function parseSessionOpenClaudeCommand(rest: string[]): ParsedCommand {
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "session-help" };
  }
  if (rest.includes("--detached") || rest.includes("--detached=true")) {
    throw new CliError(
      "--detached is not supported on `prx claude` (avoids the git detached-HEAD collision flagged in GH-1983); use --background to boot the session without attaching.",
    );
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "plain" },
      "dry-run": { type: "boolean", default: false },
      "no-attach": { type: "boolean", default: false },
      plan: { type: "string" },
      background: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const workUnitArg = positionals[0];
  const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
  if (!workUnitArg && !detectedTarget) {
    throw new CliError(
      "prx claude requires a work-unit id (e.g. GH-456).",
    );
  }
  if (!workUnitArg && detectedTarget?.launchFromCurrentWorkspace) {
    throw new CliError(
      [PRX_SESSION_OPEN_REQUIRES_TARGET, PRX_SESSION_OPEN_DEFINITION].join(" "),
    );
  }
  if (positionals.length > 1) {
    throw new CliError("prx claude accepts a single work-unit id; pass options as flags");
  }

  return {
    command: "session-open-claude",
    workUnitId: workUnitArg
      ? parseCanonicalWorkUnitId(workUnitArg, "claude")
      : parseCanonicalWorkUnitId(detectedTarget!.workUnitId, "claude"),
    launchFromCurrentWorkspace: detectedTarget?.launchFromCurrentWorkspace,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    dryRun: values["dry-run"],
    noAttach: values["no-attach"],
    attachMode: values.background === true ? "background" : "foreground",
    planPath: values.plan !== undefined ? validatePlanPath(values.plan) : undefined,
  };
}

function printImplementHelpAndExit(): never {
  process.stdout.write(
    [
      "Usage: prx implement agent [GH-NNN] [options]",
      "",
      "Run the implementation for a work unit. Default: a headless SDK job run",
      "in-process (no tmux); state via the typed envelope + worktree lock. Use",
      "--interactive for the attached tmux/PTY pairing session.",
      "",
      "Options:",
      "  --plan PATH            Append 'Execute the plan at PATH.' to the session prompt",
      "  --dry-run              Print the resolved profile without launching the session",
      "  --interactive          Open the attached tmux/PTY pairing session (the pre-2b default)",
      "  --headless             Explicit synonym for the default in-process headless run",
      "  --no-attach            (interactive) start the session without attaching",
      "  --background           (interactive) boot the session and print a re-entry hint (GH-2014)",
      "  --format <plain|json>  Output format (default: plain)",
      "  -h, --help             Show this help",
      "",
      "Examples:",
      "  prx implement agent GH-456",
      "  prx implement agent GH-456 --plan ~/.config/claude/plans/my-plan.md",
      "  prx implement agent GH-456 --dry-run --format json",
      "",
      "Deprecated:",
      "  prx implement session [GH-NNN]  — accepted with stderr hint (GH-1981, alias for `prx implement agent`).",
      "  prx implement [GH-NNN]          — removed (GH-1981); use `prx implement agent`.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function parseImplementCommand(rest: string[]): ParsedCommand {
  if (rest.includes("--help") || rest.includes("-h")) {
    printImplementHelpAndExit();
  }
  // GH-1194: `prx implement dispatch …` redirects to the dispatch envelope
  // shape with source=implement injected; everything after is parsed by
  // the dispatch argv parser.
  if (rest[0] === "dispatch") {
    return parseCommand(["dispatch", "--source=implement", ...rest.slice(1)]);
  }
  // GH-1981: verb-shape carve-out. The canonical form is `prx implement
  // agent <UoW>` (the verb token `agent` says "this spawns a Claude
  // agent", per the GH-1943 ADR). The legacy `prx implement session
  // <UoW>` shape stays accepted for one cycle with a stderr deprecation
  // hint emitted from the dispatch path; the flat/bare `prx implement
  // [<UoW>]` form is hard-removed.
  let normalized: string[];
  let invokedViaDeprecatedImplementSession = false;
  if (rest[0] === "agent") {
    normalized = rest.slice(1);
  } else if (rest[0] === "session") {
    invokedViaDeprecatedImplementSession = true;
    normalized = rest.slice(1);
  } else {
    throw new CliError(
      "prx implement: removed; use prx implement agent [GH-N]",
    );
  }
  if (normalized.includes("--detached") || normalized.includes("--detached=true")) {
    throw new CliError(
      "--detached is not supported on `prx implement agent` (avoids the git detached-HEAD collision flagged in GH-1983); use --background to boot the session without attaching.",
    );
  }
  const { values, positionals } = parseArgs({
    args: normalized,
    options: {
      format: { type: "string", default: "plain" },
      "dry-run": { type: "boolean", default: false },
      "no-attach": { type: "boolean", default: false },
      plan: { type: "string" },
      background: { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const workUnitArg = positionals[0];
  if (!workUnitArg) {
    throw new CliError(
      "prx implement agent requires a work-unit id (e.g. GH-456).",
    );
  }
  if (positionals.length > 1) {
    throw new CliError("prx implement agent accepts a single work-unit id; pass options as flags");
  }

  return {
    command: "session-open-implement",
    workUnitId: parseCanonicalWorkUnitId(workUnitArg, "implement"),
    launchFromCurrentWorkspace: undefined,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    dryRun: values["dry-run"],
    noAttach: values["no-attach"],
    attachMode: values.background === true ? "background" : "foreground",
    planPath: values.plan !== undefined ? validatePlanPath(values.plan) : undefined,
    headless: values.headless === true ? true : undefined,
    interactive: values.interactive === true ? true : undefined,
    invokedViaDeprecatedImplementSession: invokedViaDeprecatedImplementSession || undefined,
  };
}

function printDoctorHelpAndExit(): never {
  process.stdout.write(
    [
      "Usage: prx doctor <verb> [GH-NNN] [options]",
      "",
      "PR readiness diagnostician (GH-885 + GH-882) + audit read-back (GH-1533).",
      "Reads PR state via gh. GH-1559: the publication transitions moved to",
      "`prx publisher` (run `prx publisher --help`).",
      "",
      "Verbs:",
      "  inventory  Print typed PR snapshot + per-verb gate breakdown",
      "  gh-budget  Summarize recent `gh` GraphQL spend grouped by prx verb",
      "  dedupe-bd  Close bd duplicates sharing an external_id pin (ADR §6)",
      "",
      "Deprecated (aliases for `prx publisher <verb>`; removed next release):",
      "  merge      → prx publisher merge",
      "  ready      → prx publisher ready",
      "  draft      → prx publisher draft",
      "",
      "Options:",
      "  --method <squash|merge|rebase>  Merge method for `merge` (default: squash)",
      "  --no-update-branch              Skip the auto `gh pr update-branch` retry",
      "  --since <30m|2h|...>            Lookback window for `gh-budget` (default: 1h)",
      "  --apply                         Write planned actions (dedupe-bd; dry-run otherwise)",
      "  --only <pin|bd-id>              Apply only the named cluster(s); repeatable; requires --apply (dedupe-bd)",
      "  --format <plain|json>           Output format (default: plain)",
      "  -h, --help                      Show this help",
      "",
      "Examples:",
      "  prx doctor inventory",
      "  prx doctor gh-budget --since 2h",
      "  prx doctor dedupe-bd",
      "  prx doctor dedupe-bd --apply",
      "  prx doctor dedupe-bd --apply --only <pin> --only <bd-id>",
      "",
      "See:",
      "  docs/architecture/cross-repo-pr-linkage.md",
      "    — cross-repo close-on-merge linkage (bd `gh` pin authority)",
      "  docs/architecture/bd-canonical-pr-linkage.md",
      "    — pin-zero case: no auto-close fires; `bd close <id>` is an explicit handoff",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// GH-1533: best-effort `<n><unit>` duration → ms. `unit` ∈ {ms, s, m, h, d};
// a bare number is read as minutes (matches `--since 30` reading as 30m).
// GH-1825 added `ms` so `--timeout=30000ms` is expressible alongside `30s`.
// Throws a CliError on garbage so the operator gets a usable message rather
// than NaN.
function parseDurationMs(raw: string, flag: string): number {
  const trimmed = raw.trim();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(trimmed);
  if (!m) {
    throw new CliError(`${flag}: expected a duration like 30s, 5m, 2h, 1d (got '${raw}')`);
  }
  const n = Number.parseFloat(m[1]!);
  const unit = (m[2] ?? "m").toLowerCase();
  const scale = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return Math.round(n * scale);
}

const DOCTOR_VERBS = ["inventory", "merge", "ready", "draft", "gh-budget", "dedupe-bd"] as const;
type DoctorVerb = (typeof DOCTOR_VERBS)[number];

const DOCTOR_GH_BUDGET_DEFAULT_SINCE_MS = 60 * 60 * 1_000;

function parseDoctorGhBudgetCommand(subRest: string[]): ParsedCommand {
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printDoctorHelpAndExit();
  }
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      format: { type: "string", default: "plain" },
      since: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new CliError("prx doctor gh-budget takes no positional arguments; pass options as flags");
  }
  return {
    command: "doctor-gh-budget",
    sinceMs: values.since !== undefined
      ? parseDurationMs(values.since, "--since")
      : DOCTOR_GH_BUDGET_DEFAULT_SINCE_MS,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

function parseDoctorDedupeBdCommand(subRest: string[]): ParsedCommand {
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printDoctorHelpAndExit();
  }
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      format: { type: "string", default: "plain" },
      apply: { type: "boolean", default: false },
      // GH-2379: repeatable `--only <pin|bd-id>` selector.
      only: { type: "string", multiple: true },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new CliError(
      "prx doctor dedupe-bd takes no positional arguments; pass options as flags",
    );
  }
  const only = values.only ?? [];
  // GH-2379: `--only` is only meaningful at apply time — reject it standalone
  // so a dry-run `--only` is never silently a no-op.
  if (only.length > 0 && !(values.apply ?? false)) {
    throw new CliError("prx doctor dedupe-bd: --only requires --apply");
  }
  return {
    command: "doctor-dedupe-bd",
    apply: values.apply ?? false,
    only,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

function parseDoctorCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printDoctorHelpAndExit();
  }
  const verbArg = rest[0]!;
  if (!(DOCTOR_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx doctor: unknown verb '${verbArg}'. Valid verbs: ${DOCTOR_VERBS.join(", ")}.`,
    );
  }
  const verb = verbArg as DoctorVerb;
  if (verb === "gh-budget") {
    return parseDoctorGhBudgetCommand(rest.slice(1));
  }
  if (verb === "dedupe-bd") {
    return parseDoctorDedupeBdCommand(rest.slice(1));
  }
  const subRest = rest.slice(1);
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printDoctorHelpAndExit();
  }
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      format: { type: "string", default: "plain" },
      method: { type: "string" },
      "no-update-branch": { type: "boolean", default: false },
      // GH-2249: anchored-chain ledger for the merge-guard provenance gate.
      ledger: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const workUnitArg = positionals[0];
  if (positionals.length > 1) {
    throw new CliError(
      `prx doctor ${verb} accepts a single work-unit id; pass options as flags`,
    );
  }
  const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
  if (!workUnitArg && !detectedTarget) {
    throw new CliError(`prx doctor ${verb} requires a work-unit id (e.g. GH-456).`);
  }
  if (!workUnitArg && detectedTarget?.launchFromCurrentWorkspace) {
    throw new CliError(
      `prx doctor ${verb} requires a canonical work-unit id (e.g. GH-456); pass one explicitly.`,
    );
  }

  const workUnitId = workUnitArg
    ? parseCanonicalWorkUnitId(workUnitArg, "doctor")
    : parseCanonicalWorkUnitId(detectedTarget!.workUnitId, "doctor");

  // method only meaningful for merge; reject elsewhere.
  if (values.method !== undefined && verb !== "merge") {
    throw new CliError(`prx doctor ${verb}: --method is only valid for the merge verb`);
  }
  if (values["no-update-branch"] && verb !== "merge") {
    throw new CliError(
      `prx doctor ${verb}: --no-update-branch is only valid for the merge verb`,
    );
  }
  // --ledger only gates the ready/merge transitions (I-PROV1).
  if (values.ledger !== undefined && verb !== "merge" && verb !== "ready") {
    throw new CliError(
      `prx doctor ${verb}: --ledger is only valid for the merge and ready verbs`,
    );
  }

  let method: "MERGE" | "SQUASH" | "REBASE" | undefined;
  if (verb === "merge") {
    const raw = (values.method ?? "squash").toLowerCase();
    if (raw !== "squash" && raw !== "merge" && raw !== "rebase") {
      throw new CliError(
        `prx doctor merge: --method must be one of squash | merge | rebase (got '${values.method}')`,
      );
    }
    method = raw === "squash" ? "SQUASH" : raw === "merge" ? "MERGE" : "REBASE";
  }

  return {
    command: "doctor",
    verb,
    workUnitId,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    ...(method !== undefined ? { method } : {}),
    ...(verb === "merge" ? { noUpdateBranch: values["no-update-branch"] } : {}),
    ...(values.ledger !== undefined ? { ledger: values.ledger } : {}),
  };
}

/**
 * GH-2249 / GH-2338 (I-PROV1): resolve the merge-guard provenance verdict for a
 * ready/merge transition, or `undefined` when the gate should be unchanged.
 *
 * Only runs when `PRX_REQUIRE_SIGNED_DERIVATIONS` is truthy (AC-4: the
 * flag-unset path is byte-for-byte unchanged — always `undefined`). When the
 * flag is set the effective ledger is `--ledger` if given (AC-2, explicit
 * override), else the canonical per-UoW anchored-chain ledger resolved from the
 * reserved workspace (GH-2338, AC-5 reuses the by-id lookup — not cwd HEAD). It
 * resolves the head commit, opens the ledger, and runs the async projection
 * (`projectProvenanceAxis`) using `resolveProvenanceVerifier`. The verdict is
 * injected into `PublisherDeps` so the synchronous gate reads it as a derived
 * axis — no ledger I/O in the gate.
 *
 * Fail-closed (AC-3): with enforcement on and no ledger resolvable (neither
 * `--ledger` nor a canonical per-UoW ledger), the gate must block rather than
 * silently pass. We return the blocking `"unsigned"` axis — the same verdict
 * the projection emits for a present-but-unverifiable derivation — so the
 * synchronous gate refuses the transition. (A failure to resolve the head
 * commit is likewise treated as blocking under enforcement.)
 */
export async function resolveMergeGuardProvenanceAxis(
  repoPath: string,
  ledgerPath: string | undefined,
): Promise<ProvenanceAxis | undefined> {
  if (!requireSignedDerivations()) return undefined;
  // AC-2/AC-3: explicit --ledger wins; otherwise fall back to the canonical
  // per-UoW ledger. No resolvable ledger ⇒ fail closed (block, never pass).
  const effectiveLedger =
    ledgerPath ?? resolveCanonicalChainLedger(repoPath)?.ledgerPath;
  if (effectiveLedger === undefined) {
    process.stderr.write(
      "provenance: no canonical ledger for UoW; refusing under PRX_REQUIRE_SIGNED_DERIVATIONS\n",
    );
    return "unsigned";
  }
  const head = execGit({ subcommand: "rev-parse", args: ["HEAD"], cwd: repoPath });
  const gitCommit = head.exitCode === 0 ? head.stdout.trim() : "";
  if (gitCommit.length === 0) return "unsigned";
  // The canonical ledger's parent (`info/provenance/`) may not exist yet on a
  // UoW that has not emitted; `bun:sqlite` creates the file but not the dir.
  mkdirSync(dirname(effectiveLedger), { recursive: true });
  const store = openAnchoredChain(effectiveLedger);
  try {
    return await projectProvenanceAxis(gitCommit, {
      store: store.derivations,
      verifier: resolveProvenanceVerifier(),
      // prx-keymaker: in per-actor (`actor-dev`) mode, check each derivation
      // against the key of the actor named in its own `builder.id` — the actor
      // and the signature must match. Other modes keep the single verifier above.
      ...(isActorDevMode()
        ? { verifierFor: (d: Derivation) => resolveActorVerifierForDerivation(d) }
        : {}),
      enforce: true,
    });
  } finally {
    store.close();
  }
}

// GH-1559 (GH-1398 ADR §4): `prx publisher <verb>` — PR publication
// transitions moved off `doctor`. `merge` is handoff-only at the executor
// allowlist layer (denied); `ready` / `draft` are allowlisted.
const PUBLISHER_VERBS = ["merge", "ready", "draft"] as const;
type PublisherVerb = (typeof PUBLISHER_VERBS)[number];

function printPublisherHelpAndExit(): never {
  process.stdout.write(
    [
      "Usage: prx publisher <verb> [GH-NNN] [options]",
      "",
      "PR publication transitions (GH-1559 / GH-1398 ADR §4).",
      "Requests guarded transitions through GitHub's GraphQL surface.",
      "",
      "Verbs:",
      "  merge       Gate against I04, then enable automerge (default method=squash)",
      "  ready       Gate ci/threads, then markPullRequestReadyForReview",
      "  draft       convertPullRequestToDraft (no gate)",
      "  pr open     Open a PR (gh pr create) — draft by default; --ready opts out (GH-1560)",
      "  pr update   gh pr update-branch + optional retitle (GH-1560)",
      "  pr comment  Post a review comment on the PR (gh pr comment) (ai-home-2ow2v)",
      "  pr edit     Edit PR title and/or body (gh pr edit) (ai-home-2ow2v)",
      "",
      "Options:",
      "  --method <squash|merge|rebase>  Merge method for `merge` (default: squash)",
      "  --no-update-branch              Skip the auto `gh pr update-branch` retry",
      "  --ledger <path>                 Override the auto-resolved canonical per-UoW",
      "                                  anchored-chain ledger for the merge-guard",
      "                                  provenance gate (GH-2249/GH-2338, merge/ready only)",
      "  --title <summary>               PR title summary for `pr open|update` (→ `… (GH-N)`)",
      "  --closes <id>                   Extra unit(s) to Closes/Refs in `pr open` body (repeatable)",
      "  --base <branch>                 Base branch for `pr open` (default: main)",
      "  --ready                         Open `pr open` ready-for-review instead of draft",
      "  --body <text>                   Comment body for `pr comment` (required)",
      "  --body-file <path>              Body file for `pr edit` (apply rendered PR body)",
      "  --format <plain|json>           Output format (default: plain)",
      "  -h, --help                      Show this help",
      "",
      "Examples:",
      "  prx publisher merge GH-885 --method squash",
      "  prx publisher ready GH-885",
      "  prx publisher draft",
      "  prx publisher pr open GH-885 --title \"feat(x): thing\"",
      "  prx publisher pr update GH-885 --title \"feat(x): renamed\"",
      "  prx publisher pr comment GH-885 --body \"rebased onto main\"",
      "  prx publisher pr edit GH-885 --body-file /tmp/pr-body.md",
      "",
      "Read-only diagnosis lives on the sibling `prx doctor inventory`.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// GH-1560: `prx publisher pr open|update` — the forge PR-open / update-branch
// verbs (a `pr` sub-namespace under publisher, distinct from the
// merge/ready/draft transition verbs).
function parsePublisherPrCommand(rest: string[]): ParsedCommand {
  const verbArg = rest[0];
  if (
    verbArg !== "open" &&
    verbArg !== "update" &&
    verbArg !== "comment" &&
    verbArg !== "edit"
  ) {
    throw new CliError(
      `prx publisher pr: unknown verb '${verbArg ?? ""}'. Valid verbs: open, update, comment, edit.`,
    );
  }
  const verb = verbArg;
  const subRest = rest.slice(1);
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printPublisherHelpAndExit();
  }
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      format: { type: "string", default: "plain" },
      title: { type: "string" },
      closes: { type: "string", multiple: true },
      base: { type: "string" },
      ready: { type: "boolean", default: false },
      // ai-home-2ow2v: comment/edit inputs.
      body: { type: "string" },
      "body-file": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    throw new CliError(
      `prx publisher pr ${verb} accepts a single work-unit id; pass options as flags`,
    );
  }
  const workUnitArg = positionals[0];
  const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
  if (!workUnitArg && !detectedTarget) {
    throw new CliError(`prx publisher pr ${verb} requires a work-unit id (e.g. GH-456).`);
  }
  if (!workUnitArg && detectedTarget?.launchFromCurrentWorkspace) {
    throw new CliError(
      `prx publisher pr ${verb} requires a canonical work-unit id (e.g. GH-456); pass one explicitly.`,
    );
  }
  const workUnitId = workUnitArg
    ? parseCanonicalWorkUnitId(workUnitArg, "publisher pr")
    : parseCanonicalWorkUnitId(detectedTarget!.workUnitId, "publisher pr");

  if (verb === "open" && (typeof values.title !== "string" || values.title.length === 0)) {
    throw new CliError('prx publisher pr open requires --title "<summary>"');
  }
  // ai-home-2ow2v: comment requires a body; edit requires title and/or body-file.
  if (verb === "comment" && (typeof values.body !== "string" || values.body.length === 0)) {
    throw new CliError('prx publisher pr comment requires --body "<text>"');
  }
  if (
    verb === "edit" &&
    (typeof values.title !== "string" || values.title.length === 0) &&
    (typeof values["body-file"] !== "string" || values["body-file"].length === 0)
  ) {
    throw new CliError(
      "prx publisher pr edit requires --title <summary> and/or --body-file <path>",
    );
  }
  return {
    command: "publisher-pr",
    verb,
    workUnitId,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    ...(values.title !== undefined ? { title: values.title } : {}),
    ...(values.closes !== undefined ? { closes: values.closes as string[] } : {}),
    ...(values.base !== undefined ? { base: values.base } : {}),
    ready: values.ready ?? false,
    ...(values.body !== undefined ? { body: values.body } : {}),
    ...(values["body-file"] !== undefined ? { bodyFile: values["body-file"] } : {}),
  };
}

function parsePublisherCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printPublisherHelpAndExit();
  }
  // GH-1560: the `pr` sub-namespace (open|update) is parsed separately.
  if (rest[0] === "pr") {
    return parsePublisherPrCommand(rest.slice(1));
  }
  const verbArg = rest[0]!;
  if (!(PUBLISHER_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx publisher: unknown verb '${verbArg}'. Valid verbs: ${PUBLISHER_VERBS.join(", ")}.`,
    );
  }
  const verb = verbArg as PublisherVerb;
  const subRest = rest.slice(1);
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printPublisherHelpAndExit();
  }
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      format: { type: "string", default: "plain" },
      method: { type: "string" },
      "no-update-branch": { type: "boolean", default: false },
      // GH-2249: anchored-chain ledger for the merge-guard provenance gate.
      ledger: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const workUnitArg = positionals[0];
  if (positionals.length > 1) {
    throw new CliError(
      `prx publisher ${verb} accepts a single work-unit id; pass options as flags`,
    );
  }
  const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
  if (!workUnitArg && !detectedTarget) {
    throw new CliError(`prx publisher ${verb} requires a work-unit id (e.g. GH-456).`);
  }
  if (!workUnitArg && detectedTarget?.launchFromCurrentWorkspace) {
    throw new CliError(
      `prx publisher ${verb} requires a canonical work-unit id (e.g. GH-456); pass one explicitly.`,
    );
  }

  const workUnitId = workUnitArg
    ? parseCanonicalWorkUnitId(workUnitArg, "publisher")
    : parseCanonicalWorkUnitId(detectedTarget!.workUnitId, "publisher");

  // method / no-update-branch only meaningful for merge; reject elsewhere.
  if (values.method !== undefined && verb !== "merge") {
    throw new CliError(`prx publisher ${verb}: --method is only valid for the merge verb`);
  }
  if (values["no-update-branch"] && verb !== "merge") {
    throw new CliError(
      `prx publisher ${verb}: --no-update-branch is only valid for the merge verb`,
    );
  }
  // --ledger only gates the merge/ready transitions (I-PROV1), not draft.
  if (values.ledger !== undefined && verb !== "merge" && verb !== "ready") {
    throw new CliError(
      `prx publisher ${verb}: --ledger is only valid for the merge and ready verbs`,
    );
  }

  let method: "MERGE" | "SQUASH" | "REBASE" | undefined;
  if (verb === "merge") {
    const raw = (values.method ?? "squash").toLowerCase();
    if (raw !== "squash" && raw !== "merge" && raw !== "rebase") {
      throw new CliError(
        `prx publisher merge: --method must be one of squash | merge | rebase (got '${values.method}')`,
      );
    }
    method = raw === "squash" ? "SQUASH" : raw === "merge" ? "MERGE" : "REBASE";
  }

  return {
    command: "publisher",
    verb,
    workUnitId,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    ...(method !== undefined ? { method } : {}),
    ...(verb === "merge" ? { noUpdateBranch: values["no-update-branch"] } : {}),
    ...(values.ledger !== undefined ? { ledger: values.ledger } : {}),
  };
}

// GH-2282: `prx provenance <verb>` — read-only provenance key inspection.
const PROVENANCE_VERBS = ["dev-pubkey"] as const;

function printProvenanceHelpAndExit(): never {
  process.stdout.write(
    [
      "Usage: prx provenance <verb> [options]",
      "",
      "Inspect provenance signing identities (read-only).",
      "",
      "Verbs:",
      "  dev-pubkey  Print the persisted dev signing identity (point + keyid + path)",
      "",
      "Options:",
      "  --format <plain|json>  Output format (default: plain)",
      "  -h, --help             Show this help",
      "",
      "Notes:",
      "  dev-pubkey resolves the keypair `PRX_PROVENANCE_KEY=dev` signs with,",
      "  generating + persisting it under the prx state dir on first use. The",
      "  matching verifier auto-loads this key, so the dev sign -> enforce ->",
      "  verify loop needs no PRX_PROVENANCE_PUBKEY wiring.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function parseProvenanceCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printProvenanceHelpAndExit();
  }
  const verbArg = rest[0]!;
  if (!(PROVENANCE_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx provenance: unknown verb '${verbArg}'. Valid verbs: ${PROVENANCE_VERBS.join(", ")}.`,
    );
  }
  const subRest = rest.slice(1);
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printProvenanceHelpAndExit();
  }
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new CliError(
      "prx provenance dev-pubkey takes no positional arguments; pass options as flags",
    );
  }
  return {
    command: "provenance-dev-pubkey",
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

// GH-1823: `prx audit <verb>` — read-only adherence-metric verb.
const AUDIT_VERBS = ["ingest", "uow", "system"] as const;
type AuditVerb = (typeof AUDIT_VERBS)[number];

function printAuditHelp(): string {
  return [
    "Usage: prx audit <verb> [options]",
    "",
    "Verbs:",
    "  ingest [--since=<ts>]              Refresh metrics store from sink + transitions",
    "  uow <GH-NNN> [--format text|json]  Per-UoW projection (artifact chain + findings)",
    "  system [--since 7d]                System rollup of seven V1 metrics",
    "",
    "Examples:",
    "  prx audit ingest",
    "  prx audit uow GH-1823 --format text",
    "  prx audit system --since 7d --format json",
  ].join("\n");
}

function printAuditHelpAndExit(): never {
  process.stdout.write(printAuditHelp() + "\n");
  process.exit(0);
}

function parseAuditCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printAuditHelpAndExit();
  }
  const verbArg = rest[0]!;
  if (!(AUDIT_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx audit: unknown verb '${verbArg}'. Valid verbs: ${AUDIT_VERBS.join(", ")}.`,
    );
  }
  const verb = verbArg as AuditVerb;
  const subRest = rest.slice(1);
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printAuditHelpAndExit();
  }

  if (verb === "ingest") {
    const { values, positionals } = parseArgs({
      args: subRest,
      options: {
        format: { type: "string", default: "plain" },
        since: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 0) {
      throw new CliError("prx audit ingest takes no positional arguments");
    }
    return {
      command: "audit-ingest",
      ...(values.since !== undefined ? { since: values.since } : {}),
      format: normalizeAuditFormat(values.format),
    };
  }

  if (verb === "system") {
    const { values, positionals } = parseArgs({
      args: subRest,
      options: {
        format: { type: "string", default: "plain" },
        since: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 0) {
      throw new CliError("prx audit system takes no positional arguments");
    }
    return {
      command: "audit-system",
      ...(values.since !== undefined ? { since: values.since } : {}),
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  // verb === "uow"
  const { values, positionals } = parseArgs({
    args: subRest,
    options: { format: { type: "string", default: "plain" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    throw new CliError("prx audit uow requires a work-unit id (e.g. GH-1823)");
  }
  if (positionals.length > 1) {
    throw new CliError("prx audit uow accepts a single work-unit id");
  }
  return {
    command: "audit-uow",
    workUnitId: parseCanonicalWorkUnitId(positionals[0]!, "audit uow"),
    format: normalizeAuditFormat(values.format),
  };
}

// GH-1407 — `prx services <verb>` read-only external-plane status verb.
const SERVICES_VERBS = ["status"] as const;
type ServicesVerb = (typeof SERVICES_VERBS)[number];

function printServicesHelp(): string {
  return [
    "Usage: prx services <verb> [options]",
    "",
    "Verbs:",
    "  status --anthropic [--window=Nd] [--by=profile|actor|workUnitId] [--format=plain|json]",
    "         Project Anthropic prompt-cache hit rate from non-interactive-agent/usage rows.",
    "",
    "Examples:",
    "  prx services status --anthropic --by=profile",
    "  prx services status --anthropic --window=7d --format=json",
  ].join("\n");
}

function printServicesHelpAndExit(): never {
  process.stdout.write(printServicesHelp() + "\n");
  process.exit(0);
}

function parseServicesCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printServicesHelpAndExit();
  }
  const verbArg = rest[0]!;
  if (!(SERVICES_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx services: unknown verb '${verbArg}'. Valid verbs: ${SERVICES_VERBS.join(", ")}.`,
    );
  }
  const verb = verbArg as ServicesVerb;
  const subRest = rest.slice(1);
  if (subRest.includes("--help") || subRest.includes("-h")) {
    printServicesHelpAndExit();
  }

  // verb === "status"
  const { values, positionals } = parseArgs({
    args: subRest,
    options: {
      anthropic: { type: "boolean", default: false },
      window: { type: "string" },
      by: { type: "string", default: "profile" },
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new CliError("prx services status takes no positional arguments");
  }
  if (!values.anthropic) {
    throw new CliError(
      "prx services status: --anthropic is required (per-actor planes ship with GH-1826)",
    );
  }
  const by = ensureChoice(values.by, ["profile", "actor", "workUnitId"], "--by");
  return {
    command: "services-status",
    anthropic: true,
    ...(values.window !== undefined ? { window: values.window } : {}),
    by,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

// `text` is accepted as an alias for `plain` — the GH-1823 issue body's
// example output uses `--format text`, but the rest of prx normalises on
// `plain`. Normalising here keeps a single union narrow downstream.
function normalizeAuditFormat(raw: unknown): "plain" | "json" {
  const v = typeof raw === "string" ? raw : "plain";
  if (v === "text") return "plain";
  return ensureChoice(v, ["plain", "json"], "--format");
}

// GH-1318: `prx submit <verb>` — pre/post-merge close cleanup.
// GH-1740: adds `session` for the submit operator session.
// GH-1900: adds `publish` (artifact→CAS→submit handoff consumer); flips
// `session` from mainx-bound to work-unit-bound.
// GH-2380: `session` hard-renamed to `agent` (headless-first). The bare
// `session` token is rejected with a removal hint in `parseSubmitCommand`.
const SUBMIT_VERBS = [
  "body-template",
  "postmerge",
  "agent",
  "stage",
  "publish",
] as const;
type SubmitVerb = (typeof SUBMIT_VERBS)[number];

function printSubmitHelp(): string {
  return [
    "Usage: prx submit <verb> [options]",
    "",
    "Verbs:",
    "  body-template          Render PR body `Closes #N` / `Refs <id>` lines for paste into `gh pr create`",
    "  postmerge <pr-number>  Sweep a merged PR's body, close referenced units GitHub missed",
    "  agent <work-unit-id>   Run the work-unit submit operator (prep CAS artifact); headless by default, --interactive for tmux/PTY",
    "  stage <work-unit-id>   Resolve git state into a CAS submit artifact (the publish producer)",
    "  publish --from-cas <ref>  Publish a CAS-backed submit artifact (push + gh pr create); opens a DRAFT PR by default, --ready opts into ready-for-review",
    "",
    "Examples:",
    "  prx submit body-template --closes GH-885 --closes GH-882",
    "  prx submit postmerge 1313 --dry-run",
    "  prx submit agent GH-1767",
    "  prx submit stage GH-1767 --slot ready",
    "  prx submit publish --from-cas GH-1767:submit@ready --dry-run",
    "  prx submit publish --from-cas GH-1767:submit@ready --ready  # CI known-green",
    "",
    "Pipeline (GH-1900 / GH-2262):",
    "  prx submit stage <id>           → writes <id>:submit@ready in the submit CAS",
    "  prx submit publish --from-cas …  → reads ready slot, pushes, opens PR,",
    "                                     advances to <id>:submit@published",
    "",
    "See:",
    "  docs/architecture/bd-canonical-pr-linkage.md",
    "    — pin-zero case: PR body uses `Refs <bd-id>`; `bd close <id>` is",
    "      an explicit handoff because no auto-close fires",
  ].join("\n");
}

function parseSubmitCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(`${printSubmitHelp()}\n`);
    process.exit(0);
  }
  const verbArg = rest[0]!;
  // GH-2380: hard-removed verb. Mirror `prx implement <UoW>`'s removal hint.
  if (verbArg === "session") {
    throw new CliError(
      "prx submit session: removed; use prx submit agent <GH-N> (add --interactive for the tmux/PTY session).",
    );
  }
  if (!(SUBMIT_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx submit: unknown verb '${verbArg}'. Valid verbs: ${SUBMIT_VERBS.join(", ")}.`,
    );
  }
  const verb = verbArg as SubmitVerb;
  const subRest = rest.slice(1);
  if (verb === "body-template") {
    return parseSubmitBodyTemplateCommand(subRest);
  }
  if (verb === "agent") {
    return parseSubmitSessionCommand(subRest);
  }
  if (verb === "stage") {
    return parseSubmitStageCommand(subRest);
  }
  if (verb === "publish") {
    return parseSubmitPublishCommand(subRest);
  }
  // verb === "postmerge"
  return parseSubmitPostmergeCommand(subRest);
}

// GH-1740: parser for `prx submit session` (the operator-session shape).
// GH-1900: flipped to work-unit-bound; requires a `<work-unit-id>` positional.
// Mirrors `parseAuthorSessionCommand`: --check is the cwd/profile readiness
// probe and may run without a positional; the launch path always requires one.
function parseSubmitSessionCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      // GH-2380: headless-first. Default is the headless SDK job; --interactive
      // opts into the legacy tmux/PTY session.
      interactive: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const check = values.check ?? false;
  const dryRun = values["dry-run"] ?? false;
  const format = ensureChoice(values.format, ["plain", "json"], "--format");
  const interactive = values.interactive === true ? true : undefined;

  if (check) {
    return {
      command: "submit-session",
      workUnitId: positionals[0]
        ? parseCanonicalWorkUnitId(positionals[0], "submit agent")
        : "",
      dryRun,
      check: true,
      format,
      interactive,
    };
  }

  if (positionals.length === 0) {
    throw new CliError(
      "prx submit agent: requires a <work-unit-id> positional (e.g. `prx submit agent GH-1767`).",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      "prx submit agent: accepts a single work-unit id; pass options as flags",
    );
  }
  const workUnitId = parseCanonicalWorkUnitId(positionals[0]!, "submit agent");
  return {
    command: "submit-session",
    workUnitId,
    dryRun,
    check: false,
    format,
    interactive,
  };
}

// GH-2394: parser for the bare `prx scratch` command — an ad-hoc,
// work-unit-UNBOUND least-privilege Claude session that is safe by default.
// `--unsafe` is the single escape hatch back to ambient authority. There is no
// positional (scratch is unbound). `--dry-run` prints the resolved profile;
// `--check` is a cwd readiness probe.
function parseScratchCommand(rest: string[]): ParsedCommand {
  // GH-2394: `prx scratch --help` early-exits to the safe/unsafe contract
  // banner (printed by the handler from SESSION_PROFILES.scratch.banner). The
  // strict parseArgs below does not know `--help`, so intercept it first.
  const dashEnd = rest.indexOf("--");
  const scanWindow = dashEnd >= 0 ? rest.slice(0, dashEnd) : rest;
  if (scanWindow.some((arg) => arg === "--help" || arg === "-h")) {
    return {
      command: "scratch",
      unsafe: false,
      dryRun: false,
      check: false,
      help: true,
      format: "plain",
    };
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      unsafe: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 0) {
    throw new CliError(
      `prx scratch: takes no positional arguments (scratch is work-unit-unbound); got '${positionals[0]}'. Use \`prx scratch --unsafe\` for the ambient escape hatch.`,
    );
  }

  return {
    command: "scratch",
    unsafe: values.unsafe ?? false,
    dryRun: values["dry-run"] ?? false,
    check: values.check ?? false,
    help: false,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

// GH-1900: parser for `prx submit publish` — reads a CAS-backed submit
// artifact and publishes it (push + gh pr create + advance ref). The `--from-cas`
// ref can be a `<UoW>:submit@<slot>` ref or a raw `sha256:...` handle.
function parseSubmitPublishCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "from-cas": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      ready: { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      ledger: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new CliError(
      `prx submit publish: unexpected positionals: ${positionals.join(" ")} (use --from-cas <ref>)`,
    );
  }
  const fromCas = values["from-cas"];
  if (typeof fromCas !== "string" || fromCas.length === 0) {
    throw new CliError(
      "prx submit publish: --from-cas <ref> is required (e.g. --from-cas GH-1767:submit@ready)",
    );
  }
  return {
    command: "submit-publish",
    fromCas,
    dryRun: values["dry-run"] ?? false,
    ready: values.ready ?? false,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    ledger: values.ledger,
  };
}

// GH-2262: parser for `prx submit stage <work-unit-id>` — the producer that
// resolves git state into a CAS submit artifact. Requires a canonical
// work-unit id positional; `--slot` (default ready) selects the slot the
// downstream `publish` reads.
function parseSubmitStageCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      slot: { type: "string", default: "ready" },
      base: { type: "string", default: "main" },
      summary: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    throw new CliError(
      "prx submit stage: requires a <work-unit-id> positional (e.g. `prx submit stage GH-1767`).",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      "prx submit stage: accepts a single work-unit id; pass options as flags",
    );
  }
  const workUnitId = parseCanonicalWorkUnitId(positionals[0]!, "submit stage");
  const summary = values.summary;
  return {
    command: "submit-stage",
    workUnitId,
    slot: ensureChoice(values.slot, ["draft", "ready"], "--slot"),
    baseRef:
      typeof values.base === "string" && values.base.length > 0
        ? values.base
        : "main",
    ...(typeof summary === "string" ? { summary } : {}),
    dryRun: values["dry-run"] ?? false,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

function parseSubmitBodyTemplateCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      closes: { type: "string", multiple: true },
      repo: { type: "string" },
      prefix: { type: "string" },
      suffix: { type: "string" },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new CliError(
      `prx submit body-template: unexpected positionals: ${positionals.join(" ")} (use --closes <id> flags)`,
    );
  }
  const closes = (values.closes as string[] | undefined) ?? [];
  if (closes.length === 0) {
    throw new CliError(
      "prx submit body-template: at least one --closes <id> is required (e.g. --closes GH-885)",
    );
  }
  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");
  return {
    command: "submit-body-template",
    closes,
    repo: values.repo,
    prefix: values.prefix,
    suffix: values.suffix,
    format,
  };
}

function parseSubmitPostmergeCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
      "comment-template": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length < 1) {
    throw new CliError(
      "prx submit postmerge requires a <pr-number> positional",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      `prx submit postmerge: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }
  const prRaw = positionals[0]!.trim();
  const prNumber = Number.parseInt(prRaw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0 || String(prNumber) !== prRaw) {
    throw new CliError(
      `prx submit postmerge: <pr-number> must be a positive integer, got '${prRaw}'`,
    );
  }
  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");
  return {
    command: "submit-postmerge",
    prNumber,
    repo: values.repo,
    dryRun: values["dry-run"] ?? false,
    format,
    commentTemplate: values["comment-template"],
  };
}

// GH-1206: `prx author <verb>` — PR-body authoring between implement and prune.
// Verbs: session (lifecycle) | body-template (toolset renderer).
// GH-2380: `session` hard-renamed to `agent` (headless-first).
const AUTHOR_VERBS = ["agent", "body-template"] as const;
type AuthorVerb = (typeof AUTHOR_VERBS)[number];

function printAuthorHelp(): string {
  return [
    "Usage: prx author <verb> [options]",
    "",
    "PR-body authoring profile between `implement` and `prune` (GH-1206).",
    "Reads source + diff + saved plan; writes PR via gh pr {create,edit,ready,view,comment}.",
    "",
    "Verbs:",
    "  agent <GH-NNN>         Run the work-unit PR author pass (headless by default, --interactive for tmux/PTY)",
    "  body-template          Render the CLAUDE.md PR Standards run-sheet body",
    "",
    "Options (agent):",
    "  --interactive          Open the attached tmux/PTY session (default is headless SDK)",
    "  --dry-run              Print the resolved runtime profile, do not launch",
    "  --check                Report cwd/profile readiness",
    "  --format <plain|json>  Output format (default: plain)",
    "",
    "Options (body-template):",
    "  --unit <id>            Work-unit id (GH-N / #N / N / URL / bd id)",
    "  --base <ref>           Diff base ref (default: origin/main)",
    "  --format <plain|json>  Output format (default: plain)",
    "",
    "Examples:",
    "  prx author agent GH-1206",
    "  prx author body-template --unit GH-1206",
    "",
    "See: docs/prx/author-runbook.md",
  ].join("\n");
}

function parseAuthorCommand(rest: string[]): ParsedCommand {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(`${printAuthorHelp()}\n`);
    process.exit(0);
  }
  const verbArg = rest[0]!;
  // GH-2380: hard-removed verb. Mirror `prx implement <UoW>`'s removal hint.
  if (verbArg === "session") {
    throw new CliError(
      "prx author session: removed; use prx author agent <GH-N> (add --interactive for the tmux/PTY session).",
    );
  }
  if (!(AUTHOR_VERBS as readonly string[]).includes(verbArg)) {
    throw new CliError(
      `prx author: unknown verb '${verbArg}'. Valid verbs: ${AUTHOR_VERBS.join(", ")}.`,
    );
  }
  const verb = verbArg as AuthorVerb;
  const subRest = rest.slice(1);
  if (verb === "agent") {
    return parseAuthorSessionCommand(subRest);
  }
  return parseAuthorBodyTemplateCommand(subRest);
}

function parseAuthorSessionCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      // GH-2380: headless-first. Default is the headless SDK job; --interactive
      // opts into the legacy tmux/PTY session.
      interactive: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const check = values.check ?? false;
  const dryRun = values["dry-run"] ?? false;
  const format = ensureChoice(values.format, ["plain", "json"], "--format");
  const interactive = values.interactive === true ? true : undefined;

  // --check is the cwd/profile readiness probe and does not need a work-unit id.
  if (check) {
    return {
      command: "author-session",
      workUnitId: positionals[0]
        ? parseCanonicalWorkUnitId(positionals[0], "author agent")
        : "",
      dryRun,
      check: true,
      format,
      interactive,
    };
  }

  if (positionals.length === 0) {
    throw new CliError(
      "prx author agent requires a work-unit id (e.g. GH-1206).",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      "prx author agent accepts a single work-unit id; pass options as flags",
    );
  }
  const workUnitId = parseCanonicalWorkUnitId(positionals[0]!, "author agent");
  return {
    command: "author-session",
    workUnitId,
    dryRun,
    check: false,
    format,
    interactive,
  };
}

function parseAuthorBodyTemplateCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      unit: { type: "string" },
      base: { type: "string", default: "origin/main" },
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });
  const unitRaw = values.unit ?? positionals[0];
  if (typeof unitRaw !== "string" || unitRaw.trim().length === 0) {
    throw new CliError(
      "prx author body-template: --unit <id> is required (e.g. --unit GH-1206)",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      `prx author body-template: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }
  return {
    command: "author-body-template",
    unit: unitRaw.trim(),
    base: values.base ?? "origin/main",
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

interface ParseSessionPlanOptions {
  // GH-1164: when true, the caller is `prx plan session` (canonical
  // namespace). Used for the user-facing id-label in errors and the
  // `invokedViaPlanSession` tag propagated to the dispatch handler.
  invokedViaPlanSession?: boolean;
  // GH-1982: when true, the caller is `prx session plan` (the deprecated
  // alias). The alias path sets `invokedViaPlanSession: true` too so the
  // auto-save chain fires; this flag is the dispatch-side marker that
  // additionally emits the stderr alias hint.
  viaAlias?: boolean;
}

function parseSessionPlanCommand(
  rest: string[],
  options: ParseSessionPlanOptions = {},
): ParsedCommand {
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "session-help" };
  }
  // GH-2014: --detached is reserved by the git vocabulary (detached HEAD per
  // GH-1983); refuse here with a structured hint pointing at --background
  // even though print-mode does not own a tmux attach step. Surfacing the
  // refusal at the parser keeps the message identical between the print and
  // --interactive paths.
  if (rest.includes("--detached") || rest.includes("--detached=true")) {
    throw new CliError(
      "--detached is not supported on `prx plan session` (avoids the git detached-HEAD collision flagged in GH-1983); use --interactive --background to boot a tmux session without attaching.",
    );
  }
  // GH-2014: --background is meaningful only on the --interactive branch
  // (which routes to `session-open-claude`); the print path does not own a
  // tmux attach step. Refuse early so the operator sees the dependency.
  if (rest.includes("--background") && !rest.includes("--interactive")) {
    throw new CliError(
      "--background requires --interactive on `prx plan session` (the print path does not attach a tmux session).",
    );
  }
  // GH-1982: alias path sets `invokedViaPlanSession: true` for the dispatch
  // chain but error messages should still mirror what the operator typed.
  const idLabel = options.viaAlias
    ? "session plan"
    : options.invokedViaPlanSession
      ? "plan session"
      : "session plan";
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "plain" },
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "create": { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
      "emit-file": { type: "string" },
      // GH-1164: subset of parseSessionOpenCommand flags that matter for
      // work-unit-bound print entry. Interactive-only flags (--agent,
      // --mode, --io-format, --prompt, --plan) are intentionally absent
      // — print mode is claude / plan permission / one-shot stdout.
      from: { type: "string" },
      repo: { type: "string" },
      "skip-preflight": { type: "boolean", default: false },
      // GH-1407 — debug knob for the non-interactive SDK call site only.
      "no-cache": { type: "boolean", default: false },
      // GH-1825 — opt-in watchdog (no baked-in default). Accepts the same
      // duration grammar as parseDurationMs (`30s`, `5m`, `1h`, `30000ms`,
      // bare numbers = minutes).
      timeout: { type: "string" },
      // GH-1825 — continue a previously-cancelled plan-print run by reading
      // <UoW>:plan@draft and threading it into the planner prompt.
      "resume-from-draft": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const workUnitArg = positionals[0];
  if (!workUnitArg) {
    throw new CliError(
      [
        `prx ${idLabel} requires a work-unit id (e.g. GH-456).`,
        PRX_SESSION_PLAN_DEFINITION,
      ].join(" "),
    );
  }
  if (positionals.length > 1) {
    throw new CliError(`prx ${idLabel} accepts a single work-unit id; pass options as flags`);
  }

  const interactive = values.interactive;
  const emitFile = values["emit-file"];
  if (interactive && emitFile !== undefined) {
    throw new CliError(`prx ${idLabel}: --emit-file is only valid for the non-interactive default; drop --interactive or remove --emit-file`);
  }
  const noCache = values["no-cache"] === true;
  if (interactive && noCache) {
    throw new CliError(
      `prx ${idLabel}: --no-cache only applies to the non-interactive SDK call site; drop --interactive or remove --no-cache`,
    );
  }
  const timeoutMs = values.timeout === undefined
    ? undefined
    : parseDurationMs(values.timeout, "--timeout");
  if (interactive && timeoutMs !== undefined) {
    throw new CliError(
      `prx ${idLabel}: --timeout only applies to the non-interactive SDK call site; drop --interactive or remove --timeout`,
    );
  }
  const resumeFromDraft = values["resume-from-draft"] === true;
  if (interactive && resumeFromDraft) {
    throw new CliError(
      `prx ${idLabel}: --resume-from-draft only applies to the non-interactive SDK call site; drop --interactive or remove --resume-from-draft`,
    );
  }

  const from = values.from === undefined
    ? undefined
    : ensureChoice(values.from, workUnitSources, "--from");
  if (from !== undefined && !values["create"]) {
    throw new CliError("--from requires --create (the source selector only applies when materializing a new work unit).");
  }

  const repoSlug = values.repo === undefined ? undefined : values.repo;

  return {
    command: "session-plan",
    workUnitId: parseCanonicalWorkUnitId(workUnitArg, "session"),
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    dryRun: values["dry-run"],
    check: values.check,
    create: values["create"],
    noVerify: values["no-verify"],
    interactive,
    emitFile,
    from,
    repoSlug,
    skipPreflight: values["skip-preflight"] === true,
    invokedViaPlanSession: options.invokedViaPlanSession,
    ...(options.viaAlias ? { viaAlias: true } : {}),
    ...(noCache ? { noCache: true } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(resumeFromDraft ? { resumeFromDraft: true } : {}),
  };
}

// prx-9p9: parser for `prx triage result` — the structured tool the headless
// triage agent calls to report its disposition (a non-MCP CLI tool).
function parseTriageResultCommand(rest: string[]): ParsedCommand {
  const { values } = parseArgs({
    args: rest,
    options: {
      disposition: { type: "string" },
      uow: { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (typeof values.disposition !== "string") {
    throw new CliError(
      "triage result requires --disposition <classified|promoted|deferred|merged|no_action>",
    );
  }
  const disposition = ensureChoice(
    values.disposition,
    ["classified", "promoted", "deferred", "merged", "no_action"],
    "--disposition",
  );
  return {
    command: "triage-result",
    disposition,
    ...(typeof values.uow === "string" ? { uow: values.uow } : {}),
    ...(typeof values.reason === "string" ? { reason: values.reason } : {}),
  };
}

// prx-lfv: parser for `prx intake result` — the structured tool the headless
// intake agent calls to report its disposition (a non-MCP CLI tool).
function parseIntakeResultCommand(rest: string[]): ParsedCommand {
  const { values } = parseArgs({
    args: rest,
    options: {
      disposition: { type: "string" },
      uow: { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (typeof values.disposition !== "string") {
    throw new CliError(
      "intake result requires --disposition <filed|merged|duplicate|no_action>",
    );
  }
  const disposition = ensureChoice(
    values.disposition,
    ["filed", "merged", "duplicate", "no_action"],
    "--disposition",
  );
  return {
    command: "intake-result",
    disposition,
    ...(typeof values.uow === "string" ? { uow: values.uow } : {}),
    ...(typeof values.reason === "string" ? { reason: values.reason } : {}),
  };
}

// GH-950: parser for `prx intake agent` (the operator-session shape).
// Mirrors the triage-session parser at the same offsets in the intake namespace.
function parseIntakeSessionCommand(rest: string[]): ParsedCommand {
  const { values } = parseArgs({
    args: rest,
    options: {
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      // GH-2380: headless-first. Default is the headless SDK job; --interactive
      // opts into the legacy tmux/PTY session.
      interactive: { type: "boolean", default: false },
      // prx-28w: free-text seed — intake THIS item (dedupe → file/merge)
      // instead of sweeping the whole queue.
      message: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    command: "intake-session",
    dryRun: values["dry-run"] ?? false,
    check: values.check ?? false,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    interactive: values.interactive === true ? true : undefined,
    message: typeof values.message === "string" ? values.message : undefined,
  };
}

// GH-1000: parser for `prx intake view <id>` — the read primitive for the
// intake operator session. Accepts GH-N / #N / N / GitHub URL / bd id.
function parseIntakeViewCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "plain" },
    },
    strict: true,
    allowPositionals: true,
  });

  const id = positionals[0]?.trim();
  if (!id) {
    throw new CliError(
      "intake view requires an id positional (GH-N, #N, N, GitHub URL, or bd id)",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      `intake view: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  return {
    command: "intake-view",
    id,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
  };
}

// GH-999: parser for `prx intake search <query>` — unified GH+bd dedupe
// search. Mirrors parseIntakeViewCommand: positional query, --state filter
// (open|closed|all, default all), --format / --json output toggle.
function parseIntakeSearchCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      state: { type: "string", default: "all" },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const query = positionals[0]?.trim();
  if (!query) {
    throw new CliError("intake search requires a query positional");
  }
  if (positionals.length > 1) {
    throw new CliError(
      `intake search: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-search",
    query,
    state: ensureChoice(values.state, ["open", "closed", "all"], "--state"),
    format,
  };
}

// GH-1218: parser for `prx intake status` — intake-side mirror of `prx triage
// status`. Reports unfiled (open GH issues with no beads row), reverse
// orphans (bd rows with no GH issue), and field-level GH↔bd drift. The
// `--rate-limit` flag attaches the same budget snapshot block as triage.
function parseIntakeStatusCommand(rest: string[]): ParsedCommand {
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      format: { type: "string", default: "plain" },
      limit: { type: "string", default: "0" },
      "include-intentional": { type: "boolean", default: false },
      "rate-limit": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const limitNum = Number.parseInt(values.limit ?? "0", 10);
  if (!Number.isFinite(limitNum) || limitNum < 0) {
    throw new CliError(
      `intake status: --limit must be a non-negative integer (got ${values.limit})`,
    );
  }

  return {
    command: "intake-status",
    repo: values.repo,
    limit: limitNum,
    format: ensureChoice(values.format, ["plain", "json"], "--format"),
    includeIntentional: values["include-intentional"] === true,
    rateLimit: values["rate-limit"] === true,
  };
}

// GH-1001: parser for `prx intake merge <dup> <canonical>` — pointer-comment
// + close (the dedupe verb). Both ids accept GH-N / #N / N / GitHub URL.
function parseIntakeMergeCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      template: { type: "string" },
      reason: { type: "string", default: "duplicate" },
      label: { type: "string" },
      repo: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length < 2) {
    throw new CliError(
      "intake merge requires two positionals: <dup> <canonical> (each accepts GH-N, #N, N, or URL)",
    );
  }
  if (positionals.length > 2) {
    throw new CliError(
      `intake merge: unexpected extra positionals: ${positionals.slice(2).join(" ")}`,
    );
  }

  const dupId = positionals[0]!.trim();
  const canonicalId = positionals[1]!.trim();
  if (!dupId) {
    throw new CliError("intake merge: dup id must not be empty");
  }
  if (!canonicalId) {
    throw new CliError("intake merge: canonical id must not be empty");
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-merge",
    dupId,
    canonicalId,
    template: values.template,
    reason: ensureChoice(
      values.reason,
      ["completed", "not planned", "duplicate"],
      "--reason",
    ),
    label: values.label,
    repo: values.repo,
    dryRun: values["dry-run"] ?? false,
    format,
  };
}

// GH-1323: parser for `prx intake comment <canonical> --body …` —
// pointer-comment without close (sister of `intake merge`). Body comes from
// `--body`, `--body-file`, or `--body-stdin` (mutex). `--body @file` is
// treated as `--body-file file` to match the `intake` filing UX.
function parseIntakeCommentCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      body: { type: "string" },
      "body-file": { type: "string" },
      "body-stdin": { type: "boolean", default: false },
      repo: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    throw new CliError(
      "intake comment requires one positional: <canonical> (accepts GH-N, #N, N, or URL)",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      `intake comment: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  const canonicalId = positionals[0]!.trim();
  if (!canonicalId) {
    throw new CliError("intake comment: canonical id must not be empty");
  }

  // --body / --body-file / --body-stdin mutex (parse-layer; mirrors the
  // `prx intake <type>` body cluster).
  let bodyValue = values.body;
  let bodyFile = values["body-file"];
  const bodyStdin = values["body-stdin"] === true;

  // gh-cli convention: `--body @path` reads from a file. Promote to bodyFile
  // before counting sources so mutex passes. Comment bodies frequently start
  // with a literal `@mention`, so the promotion requires the rest to contain
  // a `/` (path separator) — that keeps `@./body.md`, `@/abs/path.md`, and
  // `@subdir/file.md` working while leaving `@alice`, `@alice please look`,
  // and other GitHub mentions as plain text. Single-segment file inputs go
  // through `--body-file PATH`.
  if (
    bodyValue !== undefined &&
    bodyValue.startsWith("@") &&
    bodyValue.length > 1 &&
    bodyValue.includes("/")
  ) {
    if (bodyFile !== undefined) {
      throw new CliError(
        "intake comment: --body @file and --body-file are mutually exclusive",
      );
    }
    bodyFile = bodyValue.slice(1);
    bodyValue = undefined;
  }

  const bodySources = [
    bodyValue !== undefined,
    bodyFile !== undefined,
    bodyStdin,
  ].filter(Boolean).length;
  if (bodySources > 1) {
    throw new CliError(
      "intake comment: --body, --body-file, and --body-stdin are mutually exclusive",
    );
  }
  if (bodySources === 0) {
    throw new CliError(
      "intake comment requires a body (--body TEXT, --body @file, --body-file PATH, or --body-stdin)",
    );
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-comment",
    canonicalId,
    body: bodyValue,
    bodyFile,
    bodyStdin,
    repo: values.repo,
    dryRun: values["dry-run"] ?? false,
    format,
  };
}

// GH-1002: parser for `prx intake mirror <gh-id>` — idempotent bd create with
// race-check. Accepts GH-N / #N / N / GitHub URL.
function parseIntakeMirrorCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    throw new CliError(
      "intake mirror requires one positional: <gh-id> (accepts GH-N, #N, N, or URL)",
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      `intake mirror: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  const ghId = positionals[0]!.trim();
  if (!ghId) {
    throw new CliError("intake mirror: gh-id must not be empty");
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-mirror",
    ghId,
    repo: values.repo,
    dryRun: values["dry-run"] ?? false,
    format,
  };
}

// GH-1003: parsers for `prx intake bd {ls, memory ls|get|set}` — the narrow
// bd surface that subsumes raw `bd list` and `bd memories` so GH-1004 can
// drop those entries from the intake profile allowlist.
function parseIntakeBdCommand(rest: string[]): ParsedCommand {
  const sub = rest[0];
  if (!sub) {
    throw new CliError(
      "intake bd requires a subcommand: ls | memory <ls|get|set>",
    );
  }
  if (sub === "ls") {
    return parseIntakeBdLsCommand(rest.slice(1));
  }
  if (sub === "memory") {
    return parseIntakeBdMemoryCommand(rest.slice(1));
  }
  throw new CliError(
    `intake bd: unknown subcommand '${sub}'. Available: ls | memory <ls|get|set>`,
  );
}

function parseIntakeBdLsCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      status: { type: "string" },
      limit: { type: "string", default: "20" },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (positionals.length > 0) {
    throw new CliError(
      `intake bd ls: unexpected positionals: ${positionals.join(" ")}`,
    );
  }

  // Reject the whole token (parseInt silently truncates "1.5" → 1; we want
  // strict integer-only input so the CLI contract matches the schema).
  const limitRaw = values.limit ?? "20";
  if (!/^\d+$/.test(limitRaw)) {
    throw new CliError(
      `intake bd ls: --limit must be a non-negative integer (got ${values.limit})`,
    );
  }
  const limitNum = Number.parseInt(limitRaw, 10);

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-bd-ls",
    status: values.status,
    limit: limitNum,
    format,
  };
}

function parseIntakeBdMemoryCommand(rest: string[]): ParsedCommand {
  const sub = rest[0];
  if (!sub) {
    throw new CliError("intake bd memory requires a subcommand: ls | get | set");
  }
  if (sub === "ls") {
    return parseIntakeBdMemoryLsCommand(rest.slice(1));
  }
  if (sub === "get") {
    return parseIntakeBdMemoryGetCommand(rest.slice(1));
  }
  if (sub === "set") {
    return parseIntakeBdMemorySetCommand(rest.slice(1));
  }
  throw new CliError(
    `intake bd memory: unknown subcommand '${sub}'. Available: ls | get | set`,
  );
}

function parseIntakeBdMemoryLsCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new CliError(
      `intake bd memory ls: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-bd-memory-ls",
    search: positionals[0]?.trim() || undefined,
    format,
  };
}

function parseIntakeBdMemoryGetCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    throw new CliError("intake bd memory get requires a <key> positional");
  }
  if (positionals.length > 1) {
    throw new CliError(
      `intake bd memory get: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  const key = positionals[0]!.trim();
  if (!key) {
    throw new CliError("intake bd memory get: key must not be empty");
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-bd-memory-get",
    key,
    format,
  };
}

function parseIntakeBdMemorySetCommand(rest: string[]): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      body: { type: "string" },
      format: { type: "string", default: "plain" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    throw new CliError("intake bd memory set requires a <key> positional");
  }
  if (positionals.length > 1) {
    throw new CliError(
      `intake bd memory set: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
    );
  }

  const key = positionals[0]!.trim();
  if (!key) {
    throw new CliError("intake bd memory set: key must not be empty");
  }
  const body = values.body;
  if (body === undefined || body.length === 0) {
    throw new CliError("intake bd memory set requires --body \"<text>\"");
  }

  const format = values.json
    ? "json"
    : ensureChoice(values.format, ["plain", "json"], "--format");

  return {
    command: "intake-bd-memory-set",
    key,
    body,
    format,
  };
}

// GH-1166: bare `prx session <verb>` is retired. Read-side subcommands moved
// to canonical actor-owned homes (see registry.ts session.* leaves comment).
// We keep:
//   - `prx session open` / deprecated GH-id shorthand → still routes to plan
//     session (separate retirement: #582 / #833 / #1084).
//   - `prx session open-claude` → internal launcher for the runtime bootstrap
//     pane; not user-facing.
//   - `prx session plan` → deprecated alias for `prx plan session`
//     (GH-1982 one-cycle alias: stderr hint + canonical handler with
//     auto-save chain via invokedViaPlanSession=true; hard-remove next cycle).
//   - `prx session --help` / `help` → still prints session-help formatted with
//     the redirect map.
// Everything else errors with a verb-specific hint.
const RETIRED_SESSION_VERB_REDIRECTS: Record<string, string> = {
  next: "prx next",
  "next-action": "prx next",
  do: "prx do",
  close: "prx plan handoff",
  status: "prx phase",
  phase: "prx phase",
  snapshot: "prx snapshot",
  statusline: "prx statusline",
  actions: "prx actions",
  refresh: "prx worktree refresh",
  check: "prx chain check",
  "check-issue": "prx chain check-issue",
  "check-session": "prx chain check-session",
  "check-chain": "prx chain check",
};

// prx-rgr: the final functional `prx session` verbs are retired here — there is
// no `prx session` surface anymore. `open` / `plan` / the bare `<id>` shorthand
// redirect to the canonical `prx plan session` (interactive) / `prx plan agent`
// (headless) entry; the internal claude runtime launcher (`open-claude`) moves
// to the top-level `prx claude`. `parseSessionOpenCommand` /
// `parseSessionOpenClaudeCommand` survive — they back `prx plan session
// --interactive` and `prx claude` respectively.
const NEWLY_RETIRED_SESSION_VERB_REDIRECTS: Record<string, string> = {
  open: "prx plan session",
  plan: "prx plan session",
  "open-claude": "prx claude",
};

function parseSessionNamespace(rest: string[]): ParsedCommand {
  const head = rest[0];
  // `prx session --help` still prints the redirect map to ease migration —
  // it performs no session action, it only signposts the new homes.
  if (head === "--help" || head === "-h" || head === "help") {
    return { command: "session-help" };
  }

  if (head && Object.prototype.hasOwnProperty.call(NEWLY_RETIRED_SESSION_VERB_REDIRECTS, head)) {
    const target = NEWLY_RETIRED_SESSION_VERB_REDIRECTS[head];
    throw new CliError(`prx session ${head} is retired. Use \`${target}\` instead.`);
  }

  if (head && Object.prototype.hasOwnProperty.call(RETIRED_SESSION_VERB_REDIRECTS, head)) {
    const target = RETIRED_SESSION_VERB_REDIRECTS[head];
    throw new CliError(
      `prx session ${head} is retired (GH-1166). Use \`${target}\` instead.`,
    );
  }

  // The bare `prx session <id>` shorthand is retired too → plan session.
  if (head && !head.startsWith("-")) {
    throw new CliError(
      `prx session ${head} is retired. Use \`prx plan session ${head}\` (interactive) or \`prx plan agent ${head}\` (headless pipeline entry) instead.`,
    );
  }

  // Bare `prx session` (no subverb) → hard error with the full redirect map.
  throw new CliError(
    "prx session is retired — there is no `prx session` surface. Use: `prx plan session` / `prx plan agent` (planning), `prx intake agent`, `prx triage agent`, `prx implement agent`, `prx submit agent`, `prx author agent`, `prx prune session`, or `prx claude` (internal claude launcher).",
  );
}

// GH-1229: Build a "too many positionals" diagnostic that names the suspect
// tokens and, when any look flag-shaped, hints at the flag-before-positional
// form. Pure formatting — no parser semantics shift.
function tooManyWorkUnitIdsError(verb: string, positionals: string[]): CliError {
  const tokens = positionals.join(", ");
  let msg =
    `${verb} accepts at most one work-unit id ` +
    `(got ${positionals.length}: ${tokens})`;
  const flagLike = positionals.find((p) => p.startsWith("--"));
  if (flagLike) {
    const flagIdx = positionals.indexOf(flagLike);
    const valueGuess = positionals[flagIdx + 1];
    const idGuess = positionals.find(
      (p) => !p.startsWith("--") && p !== valueGuess,
    );
    if (idGuess && valueGuess && !valueGuess.startsWith("--")) {
      msg +=
        `\nhint: flags must come before the positional — try ` +
        `\`prx ${verb} ${flagLike} ${valueGuess} ${idGuess}\` ` +
        `or \`prx ${verb} ${flagLike}=${valueGuess} ${idGuess}\``;
    } else {
      msg +=
        `\nhint: flags must come before the positional ` +
        `(e.g., \`prx ${verb} --slot draft <id>\` or \`--slot=draft <id>\`)`;
    }
  }
  return new CliError(msg);
}

// Exported for parser-level tests (e.g. routing characterization between
// canonical `prx plan session` and deprecated alias `prx session open`,
// per ai-home-f2lcz). Not part of the stable CLI consumer surface — runCli
// remains the supported entry point.
export function parseCommand(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }
  if (command === "help-all" || command === "commands") {
    return { command: "help-all" };
  }
  // GH-1474: synthetic command produced by `normalizeNamespaceArgv` when the
  // user runs `prx intake --help` (bare namespace). Recursion lands here
  // after the rewrite — no flags or positionals to validate.
  if (command === "intake-namespace-help") {
    return { command: "intake-namespace-help" };
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return { command: "version" };
  }
  if (command === "next") {
    return parseCommand(["next-action", ...rest]);
  }

  if (command === "session") {
    return parseSessionNamespace(rest);
  }

  // prx-rgr: `prx claude [<id>] [flags]` is the new home for the internal
  // claude runtime-bootstrap launcher (formerly `prx session open-claude`). It
  // parses to the same `session-open-claude` command tag + handler — only the
  // user-facing verb moved off the retired `prx session` namespace.
  if (command === "claude") {
    return parseSessionOpenClaudeCommand(rest);
  }

  // GH-950 / GH-1164: `prx plan session [GH-NNN] [...flags]` is the canonical
  // name for the work-unit-bound planning entry. The `plan-session` rewrite
  // arrives here from normalizeNamespaceArgv. As of GH-1164, the default is
  // the non-interactive print path (claude --print, plan permission mode,
  // chained into `prx plan save --slot draft`). `--interactive` opts into
  // the legacy tmux-pane session. Both paths get tagged with
  // `invokedViaPlanSession: true` so the dispatch handler swaps the
  // user-facing banner from `prx session …` to `prx plan session …`.
  if (command === "plan-session") {
    const interactiveIdx = rest.findIndex((arg) => arg === "--interactive");
    if (interactiveIdx >= 0) {
      const remaining = [...rest.slice(0, interactiveIdx), ...rest.slice(interactiveIdx + 1)];
      const parsedSession = parseSessionOpenCommand(remaining, { idLabel: "plan session" });
      if (parsedSession.command === "session" || parsedSession.command === "session-open-claude") {
        parsedSession.invokedViaPlanSession = true;
      }
      return parsedSession;
    }
    return parseSessionPlanCommand(rest, { invokedViaPlanSession: true });
  }

  // GH-1056: pre-tmux setup of `prx plan session` exposed as a standalone verb.
  if (command === "plan-prime") {
    return parsePlanPrimeCommand(rest);
  }

  if (command === "review") {
    return parseReviewCommand(rest);
  }

  if (command === "implement") {
    return parseImplementCommand(rest);
  }

  // GH-2394: `prx scratch` — bare command (no sub-verb), ad-hoc work-unit-
  // UNBOUND least-privilege session, safe by default. Parsed before the
  // generic `--help` interception so `prx scratch --help` reaches its own
  // banner-printing path.
  if (command === "scratch") {
    return parseScratchCommand(rest);
  }

  // GH-885 + GH-882: `prx doctor <verb>` — PR readiness diagnostician.
  // Verbs: inventory | merge | ready | draft. The verb-positional is required;
  // each subverb takes an optional [GH-NNN] target.
  if (command === "doctor") {
    return parseDoctorCommand(rest);
  }

  // GH-1559 (GH-1398 ADR §4): `prx publisher <verb>` — PR publication
  // transitions. Verbs: merge | ready | draft. Each takes an optional
  // [GH-NNN] target (resolved from the cwd worktree when omitted).
  if (command === "publisher") {
    return parsePublisherCommand(rest);
  }

  // GH-2353 (GH-2348.3): `prx keeper <verb> [args...]` — git-write / ref
  // custody. Verbs: push | branch. Runs git through the git-safe wrapper as
  // role=keeper — a thin role-scoped passthrough (mirrors `prx tools git`,
  // but attributed to the keeper capability rather than the default executor).
  if (command === "keeper") {
    const { prxArgs, passthrough } = splitPassthroughArgv(
      rest,
      new Set(["format", "cwd", "message", "ledger"]),
      new Set(),
    );
    const { values, positionals } = parseArgs({
      args: prxArgs,
      options: {
        format: { type: "string", default: "plain" },
        cwd: { type: "string" },
        message: { type: "string" },
        // GH-2348.2: opt-in attested push (emit a signed push/v1 derivation).
        ledger: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    const verb = positionals[0];
    if (verb !== "push" && verb !== "branch" && verb !== "commit") {
      throw new CliError(
        "prx keeper requires a verb: push | branch | commit (e.g. `prx keeper commit -m \"msg\"`)",
      );
    }
    // GH-2346: `keeper commit` finalizes the worktree headlessly (add -A +
    // commit under role=keeper). `--message <msg>` is the canonical flag; `-m`
    // bails to passthrough via splitPassthroughArgv, so recover it there.
    let message = values.message;
    if (message === undefined) {
      const mi = passthrough.findIndex((a) => a === "-m" || a === "--message");
      if (mi >= 0 && mi + 1 < passthrough.length) message = passthrough[mi + 1];
    }
    if (verb === "commit" && (typeof message !== "string" || message.length === 0)) {
      throw new CliError(
        'prx keeper commit requires a message: -m "<msg>" (or --message "<msg>")',
      );
    }
    return {
      command: "keeper",
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      verb,
      passArgs: [...positionals.slice(1), ...passthrough],
      ...(message !== undefined ? { message } : {}),
      ...(values.ledger !== undefined ? { ledger: values.ledger } : {}),
      cwd: values.cwd,
    };
  }

  // GH-2282: `prx provenance <verb>` — read-only provenance key inspection.
  // Verb: dev-pubkey (print the persisted dev signing identity).
  if (command === "provenance") {
    return parseProvenanceCommand(rest);
  }

  // GH-1318: `prx submit <verb>` — pre/post-merge issue-close cleanup.
  // Verbs: body-template (pre-merge `Closes #N` emitter) | postmerge
  // (post-merge sweep + close for refs GitHub did not auto-close).
  if (command === "submit") {
    return parseSubmitCommand(rest);
  }

  // GH-1823: `prx audit <verb>` — read-only adherence metrics.
  // Verbs: ingest | uow <id> | system. No bd / gh / git writes.
  if (command === "audit") {
    return parseAuditCommand(rest);
  }

  // GH-1407: `prx services <verb>` — read-only external-plane status.
  // Verbs: status (today: --anthropic plane only; GH-1826 adds more).
  if (command === "services") {
    return parseServicesCommand(rest);
  }

  // GH-1206: `prx author <verb>` — PR-body authoring between implement and
  // prune. Verbs: session (lifecycle) | body-template (toolset renderer).
  if (command === "author") {
    return parseAuthorCommand(rest);
  }

  if (command === "tui") {
    return { command: "tui", forwardArgs: rest };
  }

  const rewritten = normalizeNamespaceArgv(argv);
  if (argvNamespaceRewritten(argv, rewritten)) {
    return parseCommand(rewritten);
  }

  // GH-1227: intercept `--help` / `-h` after the canonical verb is resolved so
  // every per-verb parseArgs (strict:true) can rely on the flag being absent.
  // Verbs whose own parser already returns a richer help shape (session-help,
  // plan-namespace-help, etc.) are skipped so their bespoke output is preserved.
  // Stops scanning at the first `--` so an explicit end-of-options boundary
  // forwards a literal `--help` to passthrough verbs (e.g.
  // `prx tools bd … -- --help`). Edge case: a flag *value* of literal `--help`
  // before any `--` still mis-routes — workaround is `--flag=--help`.
  if (!VERBS_WITH_NATIVE_HELP.has(command)) {
    const dashEnd = rest.indexOf("--");
    const scanWindow = dashEnd >= 0 ? rest.slice(0, dashEnd) : rest;
    if (scanWindow.some((arg) => arg === "--help" || arg === "-h")) {
      return { command: "help-verb", verb: command };
    }
  }

  if (command === "init") {
    // GH-357: top-level `prx init` scaffolds the cross-agent convention layer
    // (AGENTS.md + project-scope `.claude/settings.json`). The legacy PR
    // contract initializer moved under `prx contract init` (command name
    // `contract-init`).
    const { values } = parseArgs({
      args: rest,
      options: {
        force: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      force: values.force,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "contract-init") {
    const { values } = parseArgs({
      args: rest,
      options: {
        output: { type: "string", default: ".pr/local/pr.json" },
        title: { type: "string" },
        summary: { type: "string" },
        ready: { type: "boolean", default: false },
        "force-beads": { type: "boolean", default: false },
        "change-type": { type: "string", multiple: true },
        "generated-by": { type: "string", default: "codex" },
        untracked: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      outputPath: values.output,
      title: values.title,
      summary: values.summary,
      ready: values.ready,
      forceBeads: values["force-beads"],
      changeType: values["change-type"]?.length ? values["change-type"] : ["feature"],
      generatedBy: values["generated-by"],
      untracked: values.untracked,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      contract: values.contract,
      format: ensureChoice(values.format, ["plain", "mode", "json"], "--format"),
    };
  }

  if (command === "transition") {
    const { values } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        to: { type: "string" },
        actor: { type: "string", default: "codex" },
        reason: { type: "string" },
        format: { type: "string", default: "plain" },
        log: { type: "string", default: ".prx/transitions.jsonl" },
        id: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (!values.to) {
      throw new CliError("--to is required");
    }

    return {
      command,
      contract: values.contract,
      to: ensureChoice(values.to, lifecycleStates, "--to"),
      actor: values.actor,
      reason: values.reason,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      log: values.log,
      id: values.id,
    };
  }

  if (command === "open-mode") {
    const { values } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        format: { type: "string", default: "mode" },
        pr: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      contract: values.contract,
      format: ensureChoice(values.format, ["mode", "json", "gh-create", "gh-ready"], "--format"),
      pr: values.pr,
    };
  }

  if (command === "event") {
    const { values } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        skill: { type: "string" },
        actor: { type: "string", default: "codex" },
        reason: { type: "string" },
        format: { type: "string", default: "plain" },
        log: { type: "string", default: ".prx/transitions.jsonl" },
        id: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (!values.skill) {
      throw new CliError("--skill is required");
    }

    return {
      command,
      contract: values.contract,
      skill: ensureChoice(values.skill, prSkillNames, "--skill"),
      actor: values.actor,
      reason: values.reason,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      log: values.log,
      id: values.id,
    };
  }

  if (command === "contract") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        actor: { type: "string", default: "codex" },
        reason: { type: "string" },
        format: { type: "string", default: "plain" },
        // GH-1821: contract-trinity flags. `--kind=agent|artifact|transition`
        // pivots to the new registries; `--list` enumerates the active
        // `--kind` (or all kinds when `--kind` is omitted). Positional id is
        // the role / artifact-type / transition-key to inspect.
        kind: { type: "string" },
        list: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    return {
      command,
      contract: values.contract,
      actor: values.actor,
      reason: values.reason,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      kind: values.kind
        ? ensureChoice(values.kind, ["agent", "artifact", "transition"] as const, "--kind")
        : undefined,
      list: values.list,
      id: positionals[0],
    };
  }

  if (command === "skills") {
    const { values } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      contract: values.contract,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "graph") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        output: { type: "string" },
        validate: { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        url: { type: "string", default: "https://stately.ai/registry/editor/" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      format: ensureChoice(
        values.format,
        [
          "plain",
          "json",
          "xstate-json",
          "xstate-ts",
          "xstate-mermaid",
          "mermaid",
          "xstate-system-json",
          "xstate-system-ts",
          "xstate-system-mermaid",
          "system-mermaid",
        ],
        "--format",
      ),
      outputPath: values.output,
      validate: values.validate,
      open: values.open,
      url: values.url,
    };
  }

  if (command === "runtime-profile") {
    const { values } = parseArgs({
      args: rest,
      options: {
        profile: { type: "string", default: "work-unit" },
        mode: { type: "string", default: "full" },
        agent: { type: "string" },
        "work-unit-id": { type: "string", default: "<work-unit-id>" },
        "io-format": { type: "string", default: "json" },
        format: { type: "string", default: "plain" },
        interactive: { type: "boolean", default: true },
        automation: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    const profile = ensureChoice(values.profile, runtimeProfiles, "--profile");
    const mode = ensureChoice(values.mode, runtimeModes, "--mode");
    const ioFormat = ensureChoice(values["io-format"], runtimeIoFormats, "--io-format");

    const normalizedWorkUnitId = values["work-unit-id"] === "<work-unit-id>"
      ? values["work-unit-id"]
      : parseCanonicalWorkUnitId(values["work-unit-id"], "--work-unit-id");
    const normalizedAgent = values.agent
      ? parseCanonicalWorkUnitId(values.agent, "--agent")
      : undefined;

    if (
      profile === "work-unit" &&
      normalizedAgent &&
      normalizedWorkUnitId !== "<work-unit-id>" &&
      normalizedAgent !== normalizedWorkUnitId
    ) {
      throw new CliError("--agent must equal --work-unit-id for work-unit profile");
    }

    return {
      command,
      profile,
      mode,
      agent: normalizedAgent,
      workUnitId: normalizedWorkUnitId,
      ioFormat,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      interactive: values.automation ? false : values.interactive,
      automation: values.automation,
    };
  }

  if (command === "open" || command === "work") {
    return parseSessionOpenCommand(rest, {
      invokedViaDeprecatedWorkAlias: command === "work",
      invokedViaDeprecatedRootOpen: command === "open",
      idLabel: command === "work" ? "work" : "open",
    });
  }

  if (command === "agent-smoke") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        mode: { type: "string", default: "full" },
        "io-format": { type: "string", default: "json" },
        format: { type: "string", default: "plain" },
        "create": { type: "boolean", default: false },
        "no-verify": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    const ioFormat = ensureChoice(values["io-format"], runtimeIoFormats, "--io-format");
    if (ioFormat !== "json") {
      throw new CliError("agent-smoke currently requires --io-format json");
    }
    const workUnitArg = positionals[0];
    const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();
    if (!workUnitArg && detectedTarget?.launchFromCurrentWorkspace) {
      throw new CliError(
        `agent-smoke requires a canonical issue-backed work unit id, or a canonical worktree directory name (example: GH-5195)`,
      );
    }
    return {
      command,
      mode: ensureChoice(values.mode, runtimeModes, "--mode"),
      workUnitId: workUnitArg
        ? parseCanonicalWorkUnitId(workUnitArg, "agent-smoke")
        : detectedTarget!.workUnitId,
      launchFromCurrentWorkspace: detectedTarget?.launchFromCurrentWorkspace,
      ioFormat,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      create: values["create"],
      noVerify: values["no-verify"],
    };
  }

  if (command === "check-issue") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    const workUnitId = positionals[0]?.trim();
    if (!workUnitId) {
      throw new CliError("check-issue requires a target work unit id or branch name");
    }
    return {
      command,
      workUnitId,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "check-session" || command === "check-chain") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    const workUnitId = positionals[0]?.trim();
    if (!workUnitId) {
      throw new CliError(`${command} requires a target work unit id or branch name`);
    }
    return {
      command,
      workUnitId,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }
  if (command === "mainx") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }
  if (command === "close") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return { command: "plan-namespace-help" };
    }
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        "dry-run": { type: "boolean", default: false },
        "no-mainx-reset": { type: "boolean", default: false },
        "no-next": { type: "boolean", default: false },
        "emit-file": { type: "string" },
        force: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError("close accepts at most one work-unit id");
    }
    const workUnitId = positionals[0]
      ? parseCanonicalWorkUnitId(positionals[0], "close")
      : detectCloseWorkUnitId();
    return {
      command,
      workUnitId,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      dryRun: values["dry-run"],
      mainxReset: !values["no-mainx-reset"],
      emitNext: !values["no-next"],
      emitFile: values["emit-file"],
      force: values.force,
    };
  }
  if (command === "plan-close") {
    // GH-1057: close-without-merge wrapper for plan-mode sessions. The unit
    // positional is REQUIRED — unlike `close` (post-merge cleanup, which
    // infers from branch as a convenience), this verb performs a real GH
    // issue close + bd sync, so operator intent must be explicit.
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        "dry-run": { type: "boolean", default: false },
        "no-next": { type: "boolean", default: false },
        reason: { type: "string", default: "completed" },
        upstream: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "plan close requires an explicit work-unit id (e.g., `prx plan close GH-1050`); inference from the current branch is intentionally disabled to prevent accidental closes",
      );
    }
    if (positionals.length > 1) {
      throw new CliError("plan close accepts at most one work-unit id");
    }
    const workUnitId = parseCanonicalWorkUnitId(positionals[0]!, "plan close");
    const reason = ensureChoice(
      values.reason,
      ["completed", "not-planned", "duplicate"] as const,
      "--reason",
    );
    return {
      command,
      workUnitId,
      reason,
      upstream: values.upstream ?? null,
      dryRun: values["dry-run"],
      emitNext: !values["no-next"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }
  // GH-1173: CAS plan-store verb surface (save/load/show).
  if (command === "plan-save") {
    const { values } = parseArgs({
      args: rest,
      options: {
        unit: { type: "string" },
        slot: { type: "string", default: "draft" },
        "from-stdin": { type: "boolean", default: false },
        "from-file": { type: "string" },
        format: { type: "string", default: "plain" },
        // GH-1277: opt-out for the symmetric shape gate. Mirrors the
        // GH-1239 `--skip-preflight` shape — loud escape hatch, not silent.
        "skip-validate": { type: "boolean", default: false },
        // GH-1336: post-save cleanup for the staging file. Default `none`
        // preserves the legacy GH-1175 behavior. Discriminated values are
        // parsed via parseCleanupSpec below; parseArgs only carries the raw
        // string because Node's parseArgs doesn't understand `move-to=PATH`
        // payloads.
        cleanup: { type: "string", default: "none" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values["from-stdin"] && values["from-file"] !== undefined) {
      throw new CliError(
        "plan save: --from-stdin and --from-file are mutually exclusive",
      );
    }
    let source: { kind: "stdin" } | { kind: "file"; path: string };
    if (values["from-file"] !== undefined) {
      source = { kind: "file", path: values["from-file"] };
    } else if (values["from-stdin"]) {
      source = { kind: "stdin" };
    } else if (!process.stdin.isTTY) {
      source = { kind: "stdin" };
    } else {
      throw new CliError(
        "plan save: pass --from-stdin or --from-file <path> (no piped stdin detected)",
      );
    }
    const cleanup = parseCleanupSpec(values.cleanup);
    if (cleanup.kind !== "none" && source.kind !== "file") {
      throw new CliError(
        "plan save: --cleanup requires --from-file (no staging path to clean up when reading from stdin)",
      );
    }
    // GH-1311: route through resolvePlanSessionUnit so the planner pane
    // (which exports PRX_PLAN_SESSION_UNIT via runtime_profiles.ts) supplies
    // the unit when --unit is omitted, ahead of cwd/branch detection.
    const resolved = resolvePlanSessionUnit(values.unit, {
      detect: detectWorkCommandTarget,
    });
    if (resolved.unit === null) {
      throw new CliError(
        "plan save: pass --unit GH-N or run from a feature worktree (PRX_PLAN_SESSION_UNIT must be set, or branch/cwd must match the canonical id)",
      );
    }
    const workUnitId =
      resolved.source === "flag"
        ? parseCanonicalWorkUnitId(resolved.unit, "--unit")
        : resolved.unit;
    return {
      command,
      workUnitId,
      slot: ensureChoice(values.slot, ["draft", "approved"] as const, "--slot"),
      source,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      skipValidate: values["skip-validate"] === true,
      cleanup,
    };
  }
  if (command === "plan-load") {
    const slotProvided = rest.some(
      (arg) => arg === "--slot" || arg.startsWith("--slot="),
    );
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        slot: { type: "string", default: "approved" },
        format: { type: "string", default: "raw" },
        // GH-1311: lets the verb run from inside an open planner pane.
        unit: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw tooManyWorkUnitIdsError("plan load", positionals);
    }
    const explicit = positionals[0] ?? values.unit;
    const resolved = resolvePlanSessionUnit(explicit, {
      detect: detectWorkCommandTarget,
    });
    if (resolved.unit === null) {
      throw new CliError(
        "plan load requires a work-unit id (positional or --unit), or run from an open `prx plan session` pane",
      );
    }
    return {
      command,
      workUnitId:
        resolved.source === "flag"
          ? parseCanonicalWorkUnitId(resolved.unit, "plan load")
          : resolved.unit,
      slot: ensureChoice(values.slot, ["draft", "approved"] as const, "--slot"),
      slotExplicit: slotProvided,
      format: ensureChoice(values.format, ["raw", "json"] as const, "--format"),
    };
  }
  if (command === "plan-show") {
    const slotProvided = rest.some(
      (arg) => arg === "--slot" || arg.startsWith("--slot="),
    );
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        slot: { type: "string" },
        format: { type: "string", default: "text" },
        paths: { type: "boolean", default: false },
        // GH-1311: lets the verb run from inside an open planner pane.
        unit: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw tooManyWorkUnitIdsError("plan show", positionals);
    }
    const explicit = positionals[0] ?? values.unit;
    const resolved = resolvePlanSessionUnit(explicit, {
      detect: detectWorkCommandTarget,
    });
    if (resolved.unit === null) {
      throw new CliError(
        "plan show requires a work-unit id (positional or --unit), or run from an open `prx plan session` pane",
      );
    }
    return {
      command,
      workUnitId:
        resolved.source === "flag"
          ? parseCanonicalWorkUnitId(resolved.unit, "plan show")
          : resolved.unit,
      slot:
        slotProvided && values.slot !== undefined
          ? ensureChoice(values.slot, ["draft", "approved"] as const, "--slot")
          : undefined,
      format: ensureChoice(values.format, ["text", "json"] as const, "--format"),
      paths: values.paths === true,
    };
  }
  // GH-1239: deterministic three-axis pre-draft preflight.
  if (command === "plan-preflight") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "plan preflight requires a work-unit id (e.g., `prx plan preflight GH-1239`)",
      );
    }
    if (positionals.length > 1) {
      throw tooManyWorkUnitIdsError("plan preflight", positionals);
    }
    return {
      command,
      workUnitId: parseCanonicalWorkUnitId(positionals[0]!, "plan preflight"),
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
    };
  }
  // GH-1186: planner-side read primitives. Twins of `intake-view` /
  // `intake-search`; route through the shared `src/issues/` core. Pure reads,
  // no XState / no schema, mirror parseIntakeViewCommand / parseIntakeSearchCommand.
  if (command === "plan-view") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        // GH-1311: lets `prx plan view` (no positional) view the active unit
        // when run from inside an open planner pane (PRX_PLAN_SESSION_UNIT)
        // or a feature worktree. Resolution order: positional > --unit > env
        // > cwd/branch detection. When all four are missing we fall through
        // to the existing "id positional required" error.
        unit: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `plan view: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
      );
    }
    const positional = positionals[0]?.trim();
    let id: string | undefined = positional;
    if (!id) {
      const resolved = resolvePlanSessionUnit(values.unit, {
        detect: detectWorkCommandTarget,
      });
      id = resolved.unit ?? undefined;
    }
    if (!id) {
      throw new CliError(
        "plan view requires an id positional (GH-N, #N, N, GitHub URL, or bd id), or --unit, or run from an open `prx plan session` pane",
      );
    }
    return {
      command,
      id,
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
    };
  }
  if (command === "plan-search") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        state: { type: "string", default: "all" },
        source: { type: "string", default: "both" },
        limit: { type: "string" },
        format: { type: "string", default: "plain" },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    const query = positionals[0]?.trim();
    if (!query) {
      throw new CliError("plan search requires a query positional");
    }
    if (positionals.length > 1) {
      throw new CliError(
        `plan search: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
      );
    }
    let limit = 20;
    if (values.limit !== undefined) {
      const n = Number.parseInt(values.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliError("--limit must be a positive integer");
      }
      limit = n;
    }
    const format = values.json
      ? "json"
      : ensureChoice(values.format, ["plain", "json"] as const, "--format");
    return {
      command,
      query,
      state: ensureChoice(values.state, ["open", "closed", "all"] as const, "--state"),
      source: ensureChoice(values.source, ["gh", "beads", "both"] as const, "--source"),
      limit,
      format,
    };
  }
  // GH-1194: per-actor dispatch envelope. argv arrives shaped as
  // `dispatch --source=<actor> ...` from normalizeNamespaceArgv; the verb
  // tail (action + its args, optionally separated by `--`) is what the
  // dispatched target invokes.
  if (command === "dispatch") {
    try {
      const parsed = parseDispatchArgv(rest);
      return {
        command,
        source: parsed.source,
        target: parsed.target,
        action: parsed.action,
        argv: parsed.argv,
      };
    } catch (err) {
      if (err instanceof DispatchParseError) {
        throw new CliError(err.message);
      }
      throw err;
    }
  }
  // GH-1194 (sub-ticket D): first concrete scout FS-exploration verb. Bounded
  // grep over a directory tree; output is JSON-lines (default) so the
  // dispatch envelope writes a clean CAS payload.
  if (command === "scout-grep") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        in: { type: "string" },
        path: { type: "string" },
        "max-results": { type: "string" },
        format: { type: "string", default: "jsonl" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "scout grep requires a pattern (e.g., `prx scout grep mkdtemp`)",
      );
    }
    if (positionals.length > 1) {
      throw new CliError(
        "scout grep accepts a single pattern positional; pass options as flags",
      );
    }
    const maxResultsRaw = values["max-results"];
    let maxResults = 200;
    if (maxResultsRaw !== undefined) {
      const parsedNum = Number.parseInt(maxResultsRaw, 10);
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new CliError("--max-results must be a positive integer");
      }
      maxResults = parsedNum;
    }
    return {
      command,
      pattern: positionals[0] as string,
      in: values.in,
      pathPrefix: values.path,
      maxResults,
      format: ensureChoice(values.format, ["jsonl", "json"] as const, "--format"),
    };
  }
  // GH-1384 PR-1: bounded glob walk; sibling of scout-grep.
  if (command === "scout-files") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        in: { type: "string" },
        "max-results": { type: "string" },
        format: { type: "string", default: "jsonl" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "scout files requires a glob pattern (e.g., `prx scout files '**/*.nix'`)",
      );
    }
    if (positionals.length > 1) {
      throw new CliError(
        "scout files accepts a single glob positional; pass options as flags",
      );
    }
    const maxResultsRaw = values["max-results"];
    let maxResults = 200;
    if (maxResultsRaw !== undefined) {
      const parsedNum = Number.parseInt(maxResultsRaw, 10);
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new CliError("--max-results must be a positive integer");
      }
      maxResults = parsedNum;
    }
    return {
      command,
      pattern: positionals[0] as string,
      in: values.in,
      maxResults,
      format: ensureChoice(values.format, ["jsonl", "json"] as const, "--format"),
    };
  }
  // GH-1384 PR-2: bounded text-only single-file read.
  if (command === "scout-read") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        in: { type: "string" },
        "max-bytes": { type: "string" },
        format: { type: "string", default: "json" },
        provenance: { type: "boolean", default: false },
        ledger: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "scout read requires a path (e.g., `prx scout read flake.nix`)",
      );
    }
    if (positionals.length > 1) {
      throw new CliError(
        "scout read accepts a single path positional; pass options as flags",
      );
    }
    const maxBytesRaw = values["max-bytes"];
    let maxBytes = 2 * 1024 * 1024;
    if (maxBytesRaw !== undefined) {
      const parsedNum = Number.parseInt(maxBytesRaw, 10);
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new CliError("--max-bytes must be a positive integer");
      }
      maxBytes = parsedNum;
    }
    return {
      command,
      path: positionals[0] as string,
      in: values.in,
      maxBytes,
      format: ensureChoice(values.format, ["json"] as const, "--format"),
      provenance: values.provenance === true,
      ledger: values.ledger,
    };
  }
  // GH-1244: read-only beads/Dolt projection. `<query>` is optional
  // (omitted = full snapshot). Flags mirror the spec §3 surface.
  if (command === "scout-issues") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        state: { type: "string", default: "open" },
        repo: { type: "string" },
        max: { type: "string" },
        "max-staleness": { type: "string", default: "24h" },
        format: { type: "string", default: "jsonl" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        "scout issues accepts a single query positional; pass options as flags",
      );
    }
    const maxRaw = values.max;
    let max: number | undefined;
    if (maxRaw !== undefined) {
      const parsedNum = Number.parseInt(maxRaw, 10);
      // Spec §9: --max <= 0 → exit 64 (EX_USAGE). Pre-parser-level so the
      // error code matches whether the caller types `--max=0` or
      // `--max=garbled` (NaN trips the same invariant downstream).
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new CliError("scout issues INVALID_MAX: --max must be a positive integer", 64);
      }
      max = parsedNum;
    }
    const repo = values.repo;
    if (repo !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
      throw new CliError(`scout issues INVALID_REPO: --repo must be in owner/repo form (got: ${repo})`, 64);
    }
    return {
      command,
      query: (positionals[0] as string | undefined) ?? "",
      state: ensureChoice(values.state, ["open", "closed", "all"] as const, "--state"),
      repo,
      max,
      maxStaleness: (values["max-staleness"] as string | undefined) ?? "24h",
      format: ensureChoice(values.format, ["jsonl", "plain"] as const, "--format"),
    };
  }
  // GH-1420: Notion page UUID / Task-ID resolver.
  if (command === "scout-notion") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "no-mirrors": { type: "boolean", default: false },
        format: { type: "string", default: "json" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "scout notion requires an id (e.g., `prx scout notion PROJ-5779` or a Notion page UUID)",
      );
    }
    if (positionals.length > 1) {
      throw new CliError(
        "scout notion accepts a single id positional; pass options as flags",
      );
    }
    return {
      command,
      id: positionals[0] as string,
      noMirrors: values["no-mirrors"] === true,
      format: ensureChoice(values.format, ["json"] as const, "--format"),
    };
  }
  // GH-1245 → GH-1603 — fetch verb. `--dry-run` runs the cheap GraphQL
  // count probe and skips the write loop (I-F6). Without it, the verb
  // paginates through `gh api graphql` and writes per page to bd with a
  // per-page watermark advance (I-F4 + I-F5).
  if (command === "fetch-gh-issues") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
        repo: { type: "string" },
        since: { type: "string" },
        budget: { type: "string" },
        format: { type: "string", default: "json" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (positionals.length > 0) {
      throw new CliError(
        "fetch gh-issues takes no positionals; pass options as flags",
      );
    }
    let budgetVal: number | undefined;
    if (values.budget !== undefined) {
      const parsedNum = Number.parseInt(values.budget, 10);
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new CliError("--budget must be a positive integer");
      }
      budgetVal = parsedNum;
    }
    return {
      command,
      repo: values.repo,
      since: values.since,
      budget: budgetVal,
      dryRun: values["dry-run"] === true,
      format: ensureChoice(values.format, ["json"] as const, "--format"),
    };
  }
  if (command === "beads-init") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "import-gh": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      importGh: values["import-gh"],
      dryRun: values["dry-run"],
    };
  }
  // GH-1768: derive-* verbs share a uniform parsing surface — a fixture
  // path, optional --issue filter, format, and free positionals the
  // verb-specific handler interprets.
  if (
    command === "derive-ready" ||
    command === "derive-drift" ||
    command === "derive-eligible" ||
    command === "derive-why" ||
    command === "derive-dump-facts"
  ) {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        fixture: { type: "string" },
        issue: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    return {
      command,
      fixturePath: values.fixture,
      issueFilter: values.issue,
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
      positionals,
    };
  }
  // GH-1423: rules-* verbs.
  //   render / inputs — no positionals, `--format <plain|json>` only.
  //   validate — requires `--path <file>` (CI surface; explicit input).
  if (command === "rules-render" || command === "rules-inputs") {
    const { values } = parseArgs({
      args: rest,
      options: { format: { type: "string", default: "plain" } },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
    };
  }
  if (command === "rules-validate") {
    const { values } = parseArgs({
      args: rest,
      options: {
        path: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (typeof values.path !== "string" || values.path.trim().length === 0) {
      throw new CliError(
        "prx rules validate: --path <file> is required (e.g. --path claude/rules/core.md)",
      );
    }
    return {
      command,
      path: values.path.trim(),
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
    };
  }
  // GH-1706: `prx beads migrate [<slug>]` — embedded → shared-server migration.
  // `--patch-metadata` is default-on (the GH-1695 dolt_mode workaround); the
  // `--no-patch-metadata` form retires the workaround once bd-upstream's
  // metadata-persistence fix lands.
  if (command === "beads-migrate") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
        "patch-metadata": { type: "boolean", default: true },
        "no-patch-metadata": { type: "boolean", default: false },
        "stale-threshold": { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `beads migrate takes at most one <slug> positional, got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }
    let staleThresholdSeconds = 3600;
    const staleRaw = values["stale-threshold"];
    if (staleRaw !== undefined) {
      const parsedNum = Number.parseInt(staleRaw, 10);
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new CliError(
          "beads migrate: --stale-threshold must be a positive integer (seconds)",
        );
      }
      staleThresholdSeconds = parsedNum;
    }
    const patchMetadata = values["no-patch-metadata"]
      ? false
      : values["patch-metadata"];
    return {
      command,
      slug: positionals[0] as string | undefined,
      dryRun: values["dry-run"],
      patchMetadata,
      staleThresholdSeconds,
    };
  }
  // GH-1261 (PR-1): `prx dep manifest` — read-only inspector.
  if (command === "dep-manifest") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
    };
  }
  // GH-1274 (PR-2 of GH-1261): `prx dep research <dep> [--dry-run]`.
  if (command === "dep-research") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "dep research requires a <dep> positional (e.g. `prx dep research beads`)",
      );
    }
    if (positionals.length > 1) {
      throw new CliError(
        `dep research takes one <dep> positional, got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }
    return {
      command,
      dep: positionals[0]!,
      dryRun: values["dry-run"],
    };
  }
  // GH-1275 (PR-3 of GH-1261): `prx dep status [--format plain|json]`.
  if (command === "dep-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"] as const, "--format"),
    };
  }
  if (command === "desktop") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        agent: { type: "string", default: "codex" },
        format: { type: "string", default: "plain" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    const workUnitArg = positionals[0];
    const agent = ensureChoice(values.agent, ["codex"], "--agent");
    const detectedTarget = workUnitArg ? null : detectWorkCommandTarget();

    return {
      command: "desktop",
      agent,
      workUnitId: workUnitArg
        ? parseCanonicalWorkUnitId(workUnitArg, "desktop")
        : detectedTarget!.workUnitId,
      launchFromCurrentWorkspace: detectedTarget?.launchFromCurrentWorkspace,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      dryRun: values["dry-run"],
    };
  }

  if (command === "task") {
    const [action = "status", ...taskArgs] = rest;
    const taskAction = ensureChoice(action, ["sync", "status", "run", "graph"], "task action");
    const { values } = parseArgs({
      args: taskArgs,
      options: {
        task: { type: "string", default: defaultTaskPath() },
        "work-unit-id": { type: "string" },
        "bead-id": { type: "string" },
        "source-version": { type: "string" },
        "source-hash": { type: "string" },
        agent: { type: "string" },
        format: { type: "string", default: "plain" },
        "dry-run": { type: "boolean", default: false },
        "confirm-scope": { type: "boolean", default: false },
        "confirm-success": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      action: taskAction,
      taskPath: values.task,
      workUnitId: values["work-unit-id"]
        ? parseCanonicalWorkUnitId(values["work-unit-id"], "--work-unit-id")
        : detectWorkUnitIdFromCwd(),
      beadId: values["bead-id"],
      sourceVersion: values["source-version"],
      sourceHash: values["source-hash"],
      agent: values.agent ? parseWorkAgentImplementation(values.agent, "--agent") : undefined,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      dryRun: values["dry-run"],
      confirmScope: values["confirm-scope"],
      confirmSuccess: values["confirm-success"],
    };
  }

  if (command === "spec") {
    const [action = "show", ...specArgs] = rest;
    const specAction = ensureChoice(action, ["init", "show", "validate"], "spec action");
    const { values } = parseArgs({
      args: specArgs,
      options: {
        task: { type: "string", default: defaultTaskPath() },
        "work-unit-id": { type: "string" },
        "bead-id": { type: "string" },
        format: { type: "string", default: "plain" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "task-spec",
      action: specAction,
      taskPath: values.task,
      workUnitId: values["work-unit-id"]
        ? parseCanonicalWorkUnitId(values["work-unit-id"], "--work-unit-id")
        : detectWorkUnitIdFromCwd(),
      beadId: values["bead-id"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      dryRun: values["dry-run"],
    };
  }

  if (command === "role") {
    const [action = "", ...roleArgs] = rest;
    const roleAction = ensureChoice(action, ["start", "complete", "fail"], "role action");
    const { values } = parseArgs({
      args: roleArgs,
      options: {
        role: { type: "string" },
        task: { type: "string", default: defaultTaskPath() },
        "work-unit-id": { type: "string" },
        agent: { type: "string" },
        reason: { type: "string" },
        format: { type: "string", default: "plain" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    if (!values.role) {
      throw new CliError("--role is required");
    }

    return {
      command,
      action: roleAction,
      role: ensureChoice(values.role, taskRoles, "--role"),
      taskPath: values.task,
      workUnitId: values["work-unit-id"]
        ? parseCanonicalWorkUnitId(values["work-unit-id"], "--work-unit-id")
        : detectWorkUnitIdFromCwd(),
      agent: values.agent ? parseWorkAgentImplementation(values.agent, "--agent") : undefined,
      reason: values.reason,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      dryRun: values["dry-run"],
    };
  }

  if (command === "overview") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
        "include-diff-stats": { type: "boolean", default: true },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `repo overview takes at most one <slug> positional; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }

    return {
      command,
      slug: positionals[0] ?? null,
      repoPath: values["repo-path"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      includeDiffStats: values["include-diff-stats"],
    };
  }

  if (command === "repos") {
    const [repoActionCandidate = "", ...repoArgs] = rest;
    const repoAction = repoActionCandidate === "normalize" ? "normalize" : "list";
    const args = repoAction === "normalize" ? repoArgs : rest;
    const { values } = parseArgs({
      args,
      options: {
        root: { type: "string", multiple: true },
        everywhere: { type: "boolean", default: false },
        local: { type: "boolean", default: false },
        name: { type: "string", multiple: true },
        apply: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      action: repoAction,
      roots: values.root ?? [],
      everywhere: values.everywhere,
      local: values.local,
      names: values.name ?? [],
      apply: values.apply,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repo-audit") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const rawFormat = values.json === true ? "json" : values.format;
    return {
      command,
      format: ensureChoice(rawFormat, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        overlay: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
        "bd-workspace-prefix": { type: "string" },
        canonical: { type: "string", default: "gh" },
        // GH-1682: idempotent re-add — delegates to refreshLocalRepo when the
        // bare already exists and the registered URL matches.
        repair: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "no-fetch": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length === 0) {
      throw new CliError("repo add requires a <git-url> positional argument");
    }
    if (positionals.length > 1) {
      throw new CliError(`repo add takes a single <git-url>; got ${positionals.length}: ${positionals.join(", ")}`);
    }

    const repair = values.repair === true;
    const repairDryRun = values["dry-run"] === true;
    const repairNoFetch = values["no-fetch"] === true;
    if (!repair && (repairDryRun || repairNoFetch)) {
      throw new CliError(
        "repo add: --dry-run and --no-fetch require --repair (they only apply on the repair-delegated refresh path).",
      );
    }

    const bdWorkspacePrefixRaw = values["bd-workspace-prefix"];
    const canonical = ensureChoice(values.canonical, ["gh", "bd"], "--canonical") as "gh" | "bd";
    return {
      command,
      url: positionals[0]!,
      overlay: values.overlay ?? false,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      bdWorkspacePrefix: typeof bdWorkspacePrefixRaw === "string" ? bdWorkspacePrefixRaw : null,
      canonical,
      repair,
      repairDryRun,
      repairNoFetch,
    };
  }

  if (command === "repos-adopt") {
    // GH-1760: `prx repo adopt --from-worktree <path>`. `--from-worktree` is
    // required for GH-1760; future extensions may infer-from-cwd, but the
    // adopt verb stays explicit so an accidental shell cwd cannot quietly
    // register the wrong worktree.
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "from-worktree": { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 0) {
      throw new CliError(
        `repo adopt takes no positional arguments; use --from-worktree <path>. Got: ${positionals.join(", ")}`,
      );
    }
    const fromWorktree = values["from-worktree"];
    if (typeof fromWorktree !== "string" || fromWorktree.length === 0) {
      throw new CliError("repo adopt requires --from-worktree <path>");
    }
    return {
      command,
      fromWorktree,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "branch-adopt") {
    // GH-1761: `prx branch adopt --from-worktree <path> [--detached-as <name>]`.
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "from-worktree": { type: "string" },
        "detached-as": { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 0) {
      throw new CliError(
        `branch adopt takes no positional arguments; use --from-worktree <path>. Got: ${positionals.join(", ")}`,
      );
    }
    const fromWorktree = values["from-worktree"];
    if (typeof fromWorktree !== "string" || fromWorktree.length === 0) {
      throw new CliError("branch adopt requires --from-worktree <path>");
    }
    const detachedAsRaw = values["detached-as"];
    return {
      command,
      fromWorktree,
      detachedAs:
        typeof detachedAsRaw === "string" && detachedAsRaw.length > 0 ? detachedAsRaw : null,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "workspace-adopt") {
    // GH-1762: `prx workspace adopt [<path>] [--mode read|write]
    // [--detached-as <name>]`. Positional <path> defaults to cwd so the
    // operator-facing `prx workspace adopt .` works ergonomically;
    // `--from-worktree <path>` is also accepted as a scripted alias and
    // wins over the positional when both are supplied.
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "from-worktree": { type: "string" },
        mode: { type: "string", default: "write" },
        "detached-as": { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `workspace adopt takes at most one positional <path>. Got: ${positionals.join(", ")}`,
      );
    }
    const fromWorktreeFlag = values["from-worktree"];
    const positionalPath = positionals[0];
    const fromWorktree =
      typeof fromWorktreeFlag === "string" && fromWorktreeFlag.length > 0
        ? fromWorktreeFlag
        : typeof positionalPath === "string" && positionalPath.length > 0
          ? positionalPath
          : process.cwd();
    const detachedAsRaw = values["detached-as"];
    return {
      command,
      fromWorktree,
      mode: ensureChoice(values.mode, ["read", "write"], "--mode"),
      detachedAs:
        typeof detachedAsRaw === "string" && detachedAsRaw.length > 0 ? detachedAsRaw : null,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-set") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        to: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length < 2) {
      throw new CliError(
        "repo set requires two positionals: <axis> <slug>. Example: `prx repo set canonical owner/repo --to=bd`. Axes: canonical, stale-threshold-days, bd-workspace-prefix, dolt-remote.",
      );
    }
    if (positionals.length > 2) {
      throw new CliError(
        `repo set takes <axis> <slug>; got ${positionals.length} positionals: ${positionals.join(", ")}`,
      );
    }
    const axis = ensureChoice(
      positionals[0]!,
      ["canonical", "stale-threshold-days", "bd-workspace-prefix", "dolt-remote"],
      "<axis>",
    ) as "canonical" | "stale-threshold-days" | "bd-workspace-prefix" | "dolt-remote";
    const toRaw = values.to;
    if (typeof toRaw !== "string" || toRaw.length === 0) {
      throw new CliError("repo set requires --to=<value>");
    }
    return {
      command,
      axis,
      slug: positionals[1]!,
      to: toRaw,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-backfill") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length > 0) {
      throw new CliError(
        `repo backfill takes no positional arguments; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }

    return {
      command,
      dryRun: values["dry-run"] === true,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repo-refresh") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
        "no-fetch": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length === 0) {
      throw new CliError("repo refresh requires a <slug> positional argument");
    }
    if (positionals.length > 1) {
      throw new CliError(
        `repo refresh takes a single <slug>; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }

    return {
      command,
      slug: positionals[0]!,
      dryRun: values["dry-run"] === true,
      noFetch: values["no-fetch"] === true,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-gc") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        apply: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `repo gc takes at most one <slug> positional; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }
    const rawSlug = positionals[0]?.trim();
    return {
      command,
      slug: rawSlug && rawSlug.length > 0 ? rawSlug : null,
      apply: values.apply === true,
      yes: values.yes === true,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-add-dolthub") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dolthub-user": { type: "string" },
        name: { type: "string" },
        "no-push": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `repo add-dolthub takes at most one <slug> positional; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }
    const dolthubUserRaw = values["dolthub-user"];
    const nameRaw = values.name;
    return {
      command,
      slug: positionals[0] ?? null,
      dolthubUser: typeof dolthubUserRaw === "string" ? dolthubUserRaw : null,
      name: typeof nameRaw === "string" ? nameRaw : null,
      noPush: values["no-push"] === true,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-bootstrap") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        prefix: { type: "string" },
        "ship-metadata": { type: "boolean", default: false },
        stealth: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length > 1) {
      throw new CliError(
        `repo bootstrap takes at most one <slug> positional; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }
    if (values["ship-metadata"] === true && values.stealth === true) {
      throw new CliError(
        "repo bootstrap: --ship-metadata and --stealth are mutually exclusive.",
      );
    }
    const prefixRaw = values.prefix;
    return {
      command,
      slug: positionals[0] ?? null,
      prefix: typeof prefixRaw === "string" ? prefixRaw : null,
      shipMetadata: values["ship-metadata"] === true,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-materialize") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
        "ttl-seconds": { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length === 0) {
      throw new CliError("repo materialize requires a <name> positional argument");
    }
    if (positionals.length > 1) {
      throw new CliError(
        `repo materialize takes a single <name>; got ${positionals.length}: ${positionals.join(", ")}`,
      );
    }

    const ttlRaw = values["ttl-seconds"];
    let ttlSeconds: number | null = null;
    if (typeof ttlRaw === "string") {
      const parsedTtl = Number.parseInt(ttlRaw, 10);
      if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
        throw new CliError(`--ttl-seconds expects a positive integer, got: ${ttlRaw}`);
      }
      ttlSeconds = parsedTtl;
    }

    return {
      command,
      name: positionals[0]!,
      dryRun: values["dry-run"] === true,
      ttlSeconds,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "hooks-apply" || command === "hooks-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "hooks-path": { type: "string" },
        everywhere: { type: "boolean", default: true },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    const hooksPathRaw = values["hooks-path"]?.trim() ?? "";
    const hooksPath = hooksPathRaw.length > 0 ? hooksPathRaw : defaultHooksPath();

    return {
      command,
      hooksPath,
      everywhere: values.everywhere,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "home-update") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "flake-dir": { type: "string" },
        input: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
        verbose: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "home-update",
      flakeDir: values["flake-dir"],
      input: values.input,
      dryRun: values["dry-run"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      verbose: values.verbose,
    };
  }

  if (command === "home-sync") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "flake-dir": { type: "string" },
        input: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "home-sync",
      flakeDir: values["flake-dir"],
      input: values.input,
      dryRun: values["dry-run"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "dolt-reconcile") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
        resolve: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "dolt-reconcile",
      repoPath: values["repo-path"],
      dryRun: values["dry-run"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      resolve:
        values.resolve === undefined
          ? undefined
          : ensureChoice(values.resolve, ["schema-prefer-remote"] as const, "--resolve"),
    };
  }

  if (command === "dolt-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "dolt-status",
      repoPath: values["repo-path"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "dolt-stub") {
    // GH-2129: synthetic command produced by the dolt namespace rewrite for any
    // verb whose DOLT_VERB_DISPATCH route is still "dolt-stub". The verb arrives
    // as the first positional; flags beyond --format are ignored so an operator
    // can keep the eventual real-verb flags in muscle memory without an error.
    const [verbArg] = rest;
    const verb = ensureChoice(verbArg ?? "", DOLT_VERBS, "dolt subcommand");
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: false,
      allowPositionals: true,
    });
    const format = typeof values.format === "string" ? values.format : "plain";
    return {
      command: "dolt-stub",
      verb,
      tracking: DOLT_VERB_DISPATCH[verb].tracking,
      format: ensureChoice(format, ["plain", "json"], "--format"),
    };
  }

  if (command === "tmux-reconcile") {
    const { values } = parseArgs({
      args: rest,
      options: {
        socket: { type: "string", default: PRX_TMUX_SOCKET },
        "config-path": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "tmux-reconcile",
      socket: values.socket ?? PRX_TMUX_SOCKET,
      configPath: values["config-path"],
      dryRun: values["dry-run"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "worktree") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "worktrees") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
        "include-git-details": { type: "boolean", default: true },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      includeGitDetails: values["include-git-details"],
    };
  }

  if (command === "worktree-remove") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
        force: { type: "boolean", default: false },
        prune: { type: "boolean", default: true },
        "delete-branch": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length !== 1) {
      throw new CliError("worktree-remove requires exactly one branch-or-path target");
    }

    return {
      command,
      repoPath: values["repo-path"],
      target: positionals[0]!,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      force: values.force,
      prune: values.prune,
      deleteBranch: values["delete-branch"],
      dryRun: values["dry-run"],
    };
  }

  // GH-1978: `prx workspace <verb> [flags]`. Parsing/dispatch lives in
  // `src/workspace/cli.ts`; this branch just hands off the remaining argv.
  if (command === "workspace") {
    return {
      command: "workspace",
      argv: rest,
    };
  }

  // GH-2026/GH-2327: `prx gc <verb> [flags]`. Parsing/dispatch lives in
  // `src/machine/gc/cli.ts`; this branch just hands off the remaining argv.
  if (command === "gc") {
    return {
      command: "gc",
      argv: rest,
    };
  }

  if (command === "tools-wt") {
    // GH-1227: auto-split prx flags from pass-through args; explicit `--`
    // still works for backwards compat.
    const { prxArgs, passthrough } = splitPassthroughArgv(
      rest,
      new Set(["format", "parent-pid", "base", "skip"]),
      new Set(["source", "strict"]),
    );

    const { values, positionals } = parseArgs({
      args: prxArgs,
      options: {
        format: { type: "string", default: "plain" },
        source: { type: "boolean", default: false },
        "parent-pid": { type: "string" },
        base: { type: "string" },
        skip: { type: "string" },
        strict: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    const action = positionals[0] ?? "path";
    if (
      action !== "path" &&
      action !== "env" &&
      action !== "exec" &&
      action !== "ensure-branch" &&
      action !== "ensure-prx-excludes" &&
      action !== "run-hook" &&
      action !== "bootstrap"
    ) {
      throw new CliError(
        `Unknown tools wt action: ${action}. Expected: path, env, exec, ensure-branch, ensure-prx-excludes, run-hook, bootstrap`,
      );
    }

    let branchName: string | undefined;
    if (action === "ensure-branch") {
      branchName = positionals[1];
      if (!branchName) {
        throw new CliError("tools wt ensure-branch requires <name>");
      }
    }

    let hookEvent: string | undefined;
    if (action === "run-hook") {
      hookEvent = positionals[1];
      if (!hookEvent) {
        throw new CliError("tools wt run-hook requires <event>");
      }
    }

    const skip = values.skip
      ? values.skip
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;

    return {
      command,
      action: action as
        | "path"
        | "env"
        | "exec"
        | "ensure-branch"
        | "ensure-prx-excludes"
        | "run-hook"
        | "bootstrap",
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      execArgs: [...positionals.slice(1), ...passthrough],
      source: values.source ?? false,
      parentPid: values["parent-pid"],
      branchName,
      base: values.base,
      skip,
      hookEvent,
      strict: values.strict ?? false,
    };
  }

  if (command === "tools-git") {
    // prx tools git <subcommand> [args...] [--format plain|json] [--cwd PATH]
    // GH-1227: auto-split — unknown flags forward to git automatically;
    // `--` boundary still honored for backwards compat.
    const { prxArgs, passthrough } = splitPassthroughArgv(
      rest,
      new Set(["format", "cwd"]),
      new Set(),
    );

    const { values, positionals } = parseArgs({
      args: prxArgs,
      options: {
        format: { type: "string", default: "plain" },
        cwd: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });

    const subcommand = positionals[0];
    if (!subcommand) {
      throw new CliError("tools git requires a subcommand (e.g., status, diff, log)");
    }

    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      subcommand,
      passArgs: [...positionals.slice(1), ...passthrough],
      cwd: values.cwd,
    };
  }

  if (command === "tools-bd") {
    // GH-1227: auto-split prx flags from bd passthrough.
    const { prxArgs, passthrough } = splitPassthroughArgv(
      rest,
      new Set(["format", "cwd"]),
      new Set(),
    );

    const { values, positionals } = parseArgs({
      args: prxArgs,
      options: {
        format: { type: "string", default: "plain" },
        cwd: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });

    const subcommand = positionals[0];
    if (!subcommand) {
      throw new CliError("tools bd requires a subcommand (e.g., ready, list, show)");
    }

    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      subcommand,
      passArgs: [...positionals.slice(1), ...passthrough],
      cwd: values.cwd,
    };
  }

  if (command === "tools-mux-clear-resurrect") {
    // GH-1133: thin CLI wrapper over `clearResurrectEntry` from
    // @bounded-systems/prx-mux. Invoked by the `close_prx_session` parity-chain
    // action; not generally operator-facing.
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    const sessionName = positionals[0];
    if (!sessionName) {
      throw new CliError("tools mux clear-resurrect requires a tmux session name");
    }
    if (positionals.length > 1) {
      throw new CliError(
        `tools mux clear-resurrect takes a single session name; got ${positionals.length}`,
      );
    }
    return {
      command: "tools-mux-clear-resurrect",
      sessionName,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "tools-labels-sync") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        repo: { type: "string" },
        prune: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const repo = values.repo?.trim();
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      repo: repo && repo.length > 0 ? repo : undefined,
      prune: values.prune ?? false,
      dryRun: values["dry-run"] ?? false,
    };
  }

  if (command === "preflight-claude") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "preflight-notion-mcp") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repos-local") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        strict: { type: "boolean", default: false },
        count: { type: "boolean", default: false },
        home: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const scanHome = values.home ?? getEnv("HOME") ?? "";
    if (!scanHome) {
      throw new CliError("repos-local: --home not provided and $HOME is unset");
    }
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      scanHome,
      strict: values.strict ?? false,
      countOnly: values.count ?? false,
    };
  }

  if (command === "beads-hydrate") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        cwd: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      cwd: values.cwd,
      dryRun: values["dry-run"] ?? false,
    };
  }

  if (command === "beads-issue") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    const issueRef = positionals[0]?.trim();
    if (!issueRef) {
      throw new CliError("beads issue requires a GitHub issue reference (for example: 204 or GH-204)");
    }
    const issueNumber = parseGithubIssueNumber(issueRef);
    if (issueNumber === null) {
      throw new CliError(`beads issue: invalid GitHub issue reference "${issueRef}"`);
    }

    return {
      command,
      issueNumber,
      format: ensureChoice(values.format, ["plain", "json", "id"], "--format"),
    };
  }

  if (command === "beads-publish") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "no-adopt": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    const bdId = positionals[0]?.trim();
    if (!bdId) {
      throw new CliError("beads publish requires one positional: <bd-id>");
    }
    if (positionals.length > 1) {
      throw new CliError(
        `beads publish: unexpected extra positionals: ${positionals.slice(1).join(" ")}`,
      );
    }

    return {
      command,
      bdId,
      repo: values.repo,
      dryRun: values["dry-run"] ?? false,
      noAdopt: values["no-adopt"] ?? false,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "beads-sync") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        repo: { type: "string" },
        domain: { type: "string", default: "gh" },
        "dry-run": { type: "boolean", default: false },
        budget: { type: "string" },
        limit: { type: "string" },
        // GH-1662: opt-in cross-repo daemon mode. Cron/launchd flips this on;
        // interactive `prx beads sync` (no flag) stays single-repo as today.
        "all-repos": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const parseNonNegInt = (raw: string | undefined, flag: string): number | undefined => {
      if (raw === undefined) return undefined;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new CliError(`beads sync: ${flag} must be a non-negative integer, got "${raw}"`);
      }
      return n;
    };
    const allRepos = values["all-repos"] ?? false;
    if (allRepos && typeof values.repo === "string" && values.repo.trim().length > 0) {
      throw new CliError("beads sync: --all-repos and --repo are mutually exclusive");
    }
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      repo: typeof values.repo === "string" && values.repo.trim().length > 0 ? values.repo.trim() : undefined,
      domain: typeof values.domain === "string" && values.domain.trim().length > 0 ? values.domain.trim() : "gh",
      dryRun: values["dry-run"] ?? false,
      budget: parseNonNegInt(values.budget, "--budget"),
      limit: parseNonNegInt(values.limit, "--limit") ?? 0,
      allRepos,
    };
  }

  if (command === "beads-sync-all") {
    // GH-1702: parse flags for the cross-repo `prx dolt reconcile` fan-out.
    // `--push-only` / `--pull-only` are mutually exclusive (map onto the
    // `DoltReconcileMode` parameter on the per-repo primitive).
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        repo: { type: "string" },
        "push-only": { type: "boolean", default: false },
        "pull-only": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        resolve: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values["push-only"] === true && values["pull-only"] === true) {
      throw new CliError("beads sync-all: --push-only and --pull-only are mutually exclusive");
    }
    const mode: "full" | "push-only" | "pull-only" = values["push-only"]
      ? "push-only"
      : values["pull-only"]
        ? "pull-only"
        : "full";
    return {
      command: "beads-sync-all",
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      mode,
      repo:
        typeof values.repo === "string" && values.repo.trim().length > 0
          ? values.repo.trim()
          : undefined,
      dryRun: values["dry-run"] ?? false,
      resolve:
        values.resolve === undefined
          ? undefined
          : ensureChoice(values.resolve, ["schema-prefer-remote"] as const, "--resolve"),
    };
  }

  if (command === "sync-issues-pair") {
    // GH-1990: required `--from` / `--to`. The executor enforces the wired
    // pair list (only `gh → bd` today); the parser only validates that the
    // flags were supplied.
    const { values } = parseArgs({
      args: rest,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    const from = typeof values.from === "string" ? values.from.trim() : "";
    const to = typeof values.to === "string" ? values.to.trim() : "";
    if (from.length === 0) {
      throw new CliError("sync issues: --from <source> is required (e.g. --from gh)");
    }
    if (to.length === 0) {
      throw new CliError("sync issues: --to <destination> is required (e.g. --to bd)");
    }
    return {
      command,
      from,
      to,
      dryRun: values["dry-run"] ?? false,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "sync-backfill") {
    // GH-1469: `--from` / `--to` are required integers (from <= to); `--domain`
    // defaults to `gh` (the only domain with a wired `enumerate` in the first
    // cut). `--budget` overrides the GraphQL pause threshold.
    const { values } = parseArgs({
      args: rest,
      options: {
        domain: { type: "string", default: "gh" },
        from: { type: "string" },
        to: { type: "string" },
        repo: { type: "string" },
        budget: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    const parseRangeInt = (raw: string | undefined, flag: string): number => {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new CliError(`sync backfill: ${flag} <N> is required (e.g. ${flag} 1259)`);
      }
      const n = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
        throw new CliError(`sync backfill: ${flag} must be a non-negative integer, got "${raw}"`);
      }
      return n;
    };
    const from = parseRangeInt(values.from, "--from");
    const to = parseRangeInt(values.to, "--to");
    if (from > to) {
      throw new CliError(`sync backfill: --from (${from}) must be <= --to (${to})`);
    }
    let budget: number | undefined;
    if (typeof values.budget === "string" && values.budget.trim().length > 0) {
      const b = Number.parseInt(values.budget.trim(), 10);
      if (!Number.isFinite(b) || b < 0) {
        throw new CliError(`sync backfill: --budget must be a non-negative integer, got "${values.budget}"`);
      }
      budget = b;
    }
    return {
      command,
      domain: typeof values.domain === "string" ? values.domain.trim() : "gh",
      from,
      to,
      repo:
        typeof values.repo === "string" && values.repo.trim().length > 0
          ? values.repo.trim()
          : undefined,
      budget,
      dryRun: values["dry-run"] ?? false,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "memory-compact") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
        repo: { type: "string" },
        apply: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "horizon-days": { type: "string" },
        "message-horizon-days": { type: "string" },
        "message-issue-types": { type: "string" },
        "preserved-types": { type: "string" },
        limit: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const parseNonNegInt = (raw: string | undefined, flag: string): number | undefined => {
      if (raw === undefined) return undefined;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new CliError(`memory compact: ${flag} must be a non-negative integer, got "${raw}"`);
      }
      return n;
    };
    const parseList = (raw: string | undefined): string[] => {
      if (typeof raw !== "string" || raw.trim().length === 0) return [];
      return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    };
    if (values.apply === true && values["dry-run"] === true) {
      throw new CliError("memory compact: --apply and --dry-run are mutually exclusive");
    }
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      repo:
        typeof values.repo === "string" && values.repo.trim().length > 0 ? values.repo.trim() : undefined,
      apply: values.apply ?? false,
      horizonDays: parseNonNegInt(values["horizon-days"], "--horizon-days") ?? 90,
      messageHorizonDays:
        parseNonNegInt(values["message-horizon-days"], "--message-horizon-days") ?? 14,
      messageIssueTypes: parseList(values["message-issue-types"]),
      preservedTypes: parseList(values["preserved-types"]),
      limit: parseNonNegInt(values.limit, "--limit") ?? 100,
    };
  }

  // GH-1397: handoff queue flag parsers.
  if (command === "handoff-enqueue") {
    const { values } = parseArgs({
      args: rest,
      options: {
        target: { type: "string" },
        verb: { type: "string" },
        "work-unit": { type: "string" },
        "args-file": { type: "string" },
        args: { type: "string" },
        "dedup-key": { type: "string" },
        "source-actor": { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (typeof values.target !== "string" || values.target.length === 0) {
      throw new CliError("handoff enqueue: --target <actor> is required");
    }
    if (typeof values.verb !== "string" || values.verb.length === 0) {
      throw new CliError("handoff enqueue: --verb <name> is required");
    }
    return {
      command,
      target: values.target,
      verb: values.verb,
      ...(typeof values["work-unit"] === "string" && values["work-unit"].length > 0
        ? { workUnitId: values["work-unit"] }
        : {}),
      ...(typeof values["args-file"] === "string"
        ? { argsFile: values["args-file"] }
        : {}),
      ...(typeof values.args === "string" ? { argsLiteral: values.args } : {}),
      ...(typeof values["dedup-key"] === "string"
        ? { dedupKey: values["dedup-key"] }
        : {}),
      ...(typeof values["source-actor"] === "string"
        ? { sourceActor: values["source-actor"] }
        : {}),
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "handoff-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        target: { type: "string" },
        "work-unit": { type: "string" },
        state: { type: "string" },
        "show-stale": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    const stateValues = ["pending", "claimed", "draining", "done", "failed", "abandoned"] as const;
    let state: (typeof stateValues)[number] | undefined;
    if (typeof values.state === "string" && values.state.length > 0) {
      if (!(stateValues as readonly string[]).includes(values.state)) {
        throw new CliError(
          `handoff status: --state must be one of ${stateValues.join("|")}, got "${values.state}"`,
        );
      }
      state = values.state as (typeof stateValues)[number];
    }
    return {
      command,
      ...(typeof values.target === "string" && values.target.length > 0
        ? { target: values.target }
        : {}),
      ...(typeof values["work-unit"] === "string" && values["work-unit"].length > 0
        ? { workUnitId: values["work-unit"] }
        : {}),
      ...(state ? { state } : {}),
      showStale: values["show-stale"] === true,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "handoff-drain") {
    const { values } = parseArgs({
      args: rest,
      options: {
        actor: { type: "string" },
        once: { type: "boolean", default: false },
        max: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (typeof values.actor !== "string" || values.actor.length === 0) {
      throw new CliError("handoff drain: --actor <name> is required");
    }
    let max = 1;
    if (typeof values.max === "string") {
      const n = Number.parseInt(values.max, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliError(`handoff drain: --max must be a positive integer, got "${values.max}"`);
      }
      max = n;
    } else if (values.once !== true) {
      // No --once and no --max → still single-shot (max defaults to 1).
      max = 1;
    }
    return {
      command,
      actor: values.actor,
      once: values.once === true,
      max,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "handoff-replay") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError("handoff replay: handoff id positional is required");
    }
    return {
      command,
      id: positionals[0] as string,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  // GH-1495: `prx transcripts digest` — temporal→durable memory pipeline.
  if (command === "transcripts-digest") {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: "string", default: "claude-code-jsonl" },
        input: { type: "string" },
        project: { type: "string" },
        session: { type: "string" },
        since: { type: "string" },
        limit: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        stage: { type: "boolean", default: false },
        commit: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    const modeFlags = [
      values["dry-run"] === true,
      values.stage === true,
      values.commit === true,
    ].filter((v) => v).length;
    if (modeFlags > 1) {
      throw new CliError(
        "transcripts digest: --dry-run, --stage, --commit are mutually exclusive",
      );
    }
    const mode: "dry-run" | "stage" | "commit" =
      values["dry-run"] === true
        ? "dry-run"
        : values.commit === true
          ? "commit"
          : "stage";
    const source = ensureChoice(
      values.source,
      ["claude-code-jsonl", "claude-web-export"],
      "--source",
    );
    let limit: number | undefined;
    if (typeof values.limit === "string" && values.limit.length > 0) {
      const n = Number.parseInt(values.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliError(`transcripts digest: --limit must be a positive integer, got "${values.limit}"`);
      }
      limit = n;
    }
    return {
      command,
      source: source as "claude-code-jsonl" | "claude-web-export",
      ...(typeof values.input === "string" && values.input.length > 0
        ? { inputPath: values.input }
        : {}),
      ...(typeof values.project === "string" && values.project.length > 0
        ? { project: values.project }
        : {}),
      ...(typeof values.session === "string" && values.session.length > 0
        ? { sessionId: values.session }
        : {}),
      ...(typeof values.since === "string" && values.since.length > 0
        ? { since: values.since }
        : {}),
      ...(typeof limit === "number" ? { limit } : {}),
      mode,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "transcripts-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "transcripts-list-sources") {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repo-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
        "include-git-details": { type: "boolean", default: true },
        fetch: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      includeGitDetails: values["include-git-details"],
      fetch: values.fetch,
    };
  }

  if (command === "remote-ci-check") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        pr: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      pr: values.pr ?? undefined,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "scout-logs") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        pr: { type: "string" },
        "max-lines": { type: "string", default: "200" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      pr: values.pr ?? undefined,
      maxLines: parseInt(values["max-lines"] ?? "200", 10),
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "pr-comments") {
    const subcommand = rest[0] === "resolve" ? "resolve" : "show";
    const commandArgs = subcommand === "resolve" ? rest.slice(1) : rest;
    const { values, positionals } = parseArgs({
      args: commandArgs,
      options: {
        "repo-path": { type: "string", default: "." },
        pr: { type: "string" },
        format: { type: "string", default: "plain" },
        output: { type: "string" },
        write: { type: "boolean", default: false },
        thread: { type: "string", multiple: true },
        "all-unresolved": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    const threadIds = [...positionals.map((value) => value.trim()), ...(values.thread ?? []).map((value) => value.trim())]
      .filter((value) => value.length > 0);
    const resolveAll = values["all-unresolved"];
    if (subcommand === "resolve" && threadIds.length === 0 && !resolveAll) {
      throw new CliError("pr-comments resolve requires at least one thread id or --all-unresolved");
    }

    return {
      command,
      repoPath: values["repo-path"],
      action: subcommand,
      pr: values.pr,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      outputPath: values.output,
      write: values.write,
      threadIds,
      resolveAll,
    };
  }

  if (command === "repo-checks") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        repo: { type: "string" },
        branch: { type: "string", default: "main" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      repo: values.repo,
      branch: values.branch,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "protect-main") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        ruleset: { type: "boolean", default: false },
        backend: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string", default: "main" },
        apply: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        solo: { type: "boolean", default: false },
        allow: { type: "string", multiple: true },
        strict: { type: "boolean", default: false },
        "enforce-admins": { type: "boolean", default: false },
        "require-conversation-resolution": { type: "boolean", default: false },
        "require-last-push-approval": { type: "boolean", default: false },
        "require-linear-history": { type: "boolean", default: false },
        "require-status-check": { type: "string", multiple: true },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    const allowEntries = (values.allow ?? []).map(parseProtectMainAllow);
    const strictFromAllow = allowEntries.some((entry) => entry.type === "strict");
    const effectiveStrict = values.strict || strictFromAllow;
    const allowedStatusChecks = allowEntries
      .filter((entry): entry is { type: "status-check"; value: string } => entry.type === "status-check")
      .map((entry) => entry.value);

    return {
      command,
      repoPath: values["repo-path"],
      backend: values.ruleset ? "ruleset" : ensureChoice(values.backend ?? "branch-protection", ["branch-protection", "ruleset"], "--backend") as ProtectMainBackend,
      repo: values.repo,
      branch: values.branch,
      apply: values.check ? false : values.apply,
      check: values.check,
      solo: values.solo,
      allow: values.allow ?? [],
      strict: effectiveStrict,
      enforceAdmins: effectiveStrict || values["enforce-admins"] || allowEntries.some((entry) => entry.type === "enforce-admins")
        ? true
        : undefined,
      requireConversationResolution:
        effectiveStrict ||
        values["require-conversation-resolution"] ||
        allowEntries.some((entry) => entry.type === "conversation-resolution")
          ? true
          : undefined,
      requireLastPushApproval:
        effectiveStrict ||
        values["require-last-push-approval"] ||
        allowEntries.some((entry) => entry.type === "last-push-approval")
          ? true
          : undefined,
      requireLinearHistory:
        effectiveStrict ||
        values["require-linear-history"] ||
        allowEntries.some((entry) => entry.type === "linear-history")
          ? true
          : undefined,
      requiredStatusChecks: [...(values["require-status-check"] ?? []), ...allowedStatusChecks].length > 0
        ? [...(values["require-status-check"] ?? []), ...allowedStatusChecks]
        : undefined,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "prune") {
    // GH-1133: `prx prune session <GH-N>` — narrow session/tmux-only
    // teardown. Detect the positional subverb before the flag-only
    // `prx prune` parser runs (the latter rejects positionals).
    if (rest[0] === "session") {
      const sessionRest = rest.slice(1);
      const { values, positionals } = parseArgs({
        args: sessionRest,
        options: {
          "repo-path": { type: "string", default: "." },
          "dry-run": { type: "boolean", default: false },
          format: { type: "string", default: "plain" },
        },
        strict: true,
        allowPositionals: true,
      });
      const workUnitArg = positionals[0];
      if (!workUnitArg) {
        throw new CliError(
          "prx prune session requires a work-unit id (e.g., `prx prune session GH-1133`)",
        );
      }
      if (positionals.length > 1) {
        throw new CliError(
          `prx prune session takes a single work-unit id; got ${positionals.length}`,
        );
      }
      return {
        command: "prune-session",
        repoPath: values["repo-path"],
        workUnitId: parseCanonicalWorkUnitId(workUnitArg, "prune session"),
        apply: !values["dry-run"],
        format: ensureChoice(values.format, ["plain", "json"], "--format"),
      };
    }

    if (rest.includes("--apply")) {
      throw new CliError(
        "`prx prune` no longer accepts --apply; the verb is active by default. Use `prx prune --dry-run` (or `prx reconcile --mode prune` without --apply) to preview.",
      );
    }

    // Pre-flight: catch unknown positionals before parseArgs so we can emit a
    // help-pointer + verb suggestion instead of Node's bare "Unexpected argument"
    // (GH-1132). Layer keywords come from the GH-804 layered-teardown vision.
    const pruneStringFlags = new Set([
      "--repo-path",
      "--mode",
      "--authority",
      "--scope",
      "--ticket",
      "--format",
    ]);
    const unknownPositional = ((): string | undefined => {
      for (let i = 0; i < rest.length; i += 1) {
        const tok = rest[i]!;
        if (tok === "--") return undefined;
        if (tok.startsWith("--")) {
          const eq = tok.indexOf("=");
          const name = eq === -1 ? tok : tok.slice(0, eq);
          if (eq === -1 && pruneStringFlags.has(name)) i += 1;
          continue;
        }
        if (tok.startsWith("-")) continue;
        return tok;
      }
      return undefined;
    })();
    if (unknownPositional !== undefined) {
      const layerSuggestions: Record<string, string> = {
        session:
          "The 'session' layer is not yet wired into `prx prune` (see #804); for now use:\n  prx plan handoff <GH-N>",
        beads:
          "The 'beads' layer is not yet wired into `prx prune` (see #804); for now use:\n  bd close <id>",
        worktree:
          "The 'worktree' layer is already covered by `prx prune` itself — drop the positional and re-run.",
        refs:
          "The 'refs' layer is already covered by `prx prune` itself — drop the positional and re-run.",
      };
      const suggestion = layerSuggestions[unknownPositional];
      const header = `unknown positional '${unknownPositional}' — \`prx prune\` takes flags only.`;
      const footer = "Run `prx prune --help` for the full flag list.";
      if (suggestion !== undefined) {
        throw new CliError(`${header}\n${suggestion}\n${footer}`);
      }
      throw new CliError(
        `${header}\nAccepted flags: --repo-path, --authority, --scope, --ticket, --dry-run, --format.\n${footer}`,
      );
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        mode: { type: "string" },
        authority: { type: "string", default: "issue" },
        scope: { type: "string", default: "all" },
        ticket: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "merged-only": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (values.mode !== undefined) {
      throw new CliError("--mode is not supported with `prune`; use `prx reconcile --mode prune` instead.");
    }

    const ticket = parseTicketFlag(values.ticket);
    const mergedOnly = values["merged-only"] === true;
    const authority = ensureChoice(values.authority, ["issue", "pr", "local"], "--authority") as SurfaceSyncAuthority;
    const scope = ensureChoice(values.scope, ["local", "remote", "all"], "--scope") as SurfaceSyncScope;
    const dryRun = values["dry-run"] === true;
    const format = ensureChoice(values.format, ["plain", "json"], "--format");

    // 2l4ua: `prx prune --ticket <id>` with gc-teardown-equivalent defaults
    // (scope=all, authority=issue, no --merged-only) is a deprecation alias for
    // `prx gc teardown <id>` — `runTeardown` makes the identical buildParityChain
    // call and both act by default (no default inversion). Route through the gc
    // handler; `viaAlias` emits PRX_PRUNE_GC_ALIAS_HINT once. The
    // batch/scope/authority/merged-only modes have no faithful gc equivalent yet
    // and stay as `command:"prune"` (their handler emits the hint).
    if (ticket !== undefined && scope === "all" && authority === "issue" && !mergedOnly) {
      return {
        command: "gc",
        argv: [
          "teardown",
          ticket,
          ...(dryRun ? ["--dry-run"] : []),
          ...(format === "json" ? ["--format", "json"] : []),
        ],
        viaAlias: true,
      };
    }

    return {
      command: "prune",
      repoPath: values["repo-path"],
      mode: "prune",
      authority,
      scope,
      apply: !values["dry-run"],
      ...(ticket !== undefined ? { ticket } : {}),
      ...(mergedOnly ? { mergedOnly } : {}),
      format,
    };
  }

  if (command === "reconcile" || command === "backfill") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        mode: { type: "string" },
        authority: { type: "string", default: "issue" },
        scope: { type: "string", default: "all" },
        apply: { type: "boolean", default: false },
        ticket: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    const repoPath = values["repo-path"];
    const authority = ensureChoice(values.authority, ["issue", "pr", "local"], "--authority") as SurfaceSyncAuthority;
    const scope = ensureChoice(values.scope, ["local", "remote", "all"], "--scope") as SurfaceSyncScope;
    const apply = values.apply;
    const format = ensureChoice(values.format, ["plain", "json"], "--format");
    const ticket = parseTicketFlag(values.ticket);

    if (command === "reconcile") {
      return {
        command: "reconcile",
        repoPath,
        mode: ensureChoice(values.mode ?? "full", ["prune", "backfill", "full"], "--mode") as SurfaceSyncMode,
        authority,
        scope,
        apply,
        ...(ticket !== undefined ? { ticket } : {}),
        format,
      };
    }

    if (values.mode !== undefined) {
      throw new CliError(`--mode is not supported with \`${command}\`; use \`prx reconcile --mode ${command}\` instead.`);
    }

    return {
      command,
      repoPath,
      mode: command,
      authority,
      scope,
      apply,
      ...(ticket !== undefined ? { ticket } : {}),
      format,
    };
  }

  if (command === "chains") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        remote: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      remote: values.remote,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "repair-bd") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        all: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "repair-bd" as const,
      repoPath: values["repo-path"],
      all: values.all,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "delegate-next") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        epic: { type: "string" },
        area: { type: "string" },
        priority: { type: "string" },
        type: { type: "string" },
        all: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    let priorityNum: number | undefined;
    if (values.priority !== undefined) {
      const parsed = Number.parseInt(values.priority, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
        throw new CliError(
          `--priority must be an integer 0-10 (got '${values.priority}')`,
        );
      }
      priorityNum = parsed;
    }

    let epic: string | undefined;
    if (values.epic !== undefined) {
      if (!/^GH-\d+$/.test(values.epic)) {
        throw new CliError(
          `--epic must be a GH-NNN issue id (got '${values.epic}')`,
        );
      }
      epic = values.epic;
    }

    return {
      command: "delegate-next" as const,
      repoPath: values["repo-path"],
      filters: {
        epic,
        area: values.area,
        priority: priorityNum,
        type: values.type,
        all: values.all,
      },
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "delegate-assign") {
    // GH-1874: bd-canonical assignment verb. Sibling of `delegate next` — the
    // picker surfaces a candidate; `assign` puts an owner on the hook.
    //   `prx delegate assign GH-N <agent>`     → assign named operator
    //   `prx delegate assign GH-N --self`      → resolve via `gh api user --jq .login` (GH-2012)
    //   `prx delegate assign GH-N --unassign`  → clear bd assignee
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        self: { type: "boolean", default: false },
        unassign: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length < 1) {
      throw new CliError(
        "prx delegate assign: missing <id> positional (expected GH-NNN)",
      );
    }
    if (positionals.length > 2) {
      throw new CliError(
        `prx delegate assign: too many positionals (got ${positionals.length}, expected <id> [<agent>])`,
      );
    }
    const id = positionals[0]!;
    const agent = positionals[1];

    return {
      command: "delegate-assign" as const,
      repoPath: values["repo-path"],
      id,
      agent,
      self: values.self,
      unassign: values.unassign,
    };
  }

  if (command === "delegate-repair-assignees") {
    // GH-2012: one-time repair for bd records whose assignee column is a
    // display-name string (legacy `git config user.name` resolver behavior).
    //   `prx delegate repair-assignees --from "<name>" --to <login>` (dry-run)
    //   `prx delegate repair-assignees --from "<name>" --to <login> --apply`
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        from: { type: "string" },
        to: { type: "string" },
        apply: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    if (typeof values.from !== "string" || values.from.length === 0) {
      throw new CliError(
        "prx delegate repair-assignees: missing required --from <name>",
      );
    }
    if (typeof values.to !== "string" || values.to.length === 0) {
      throw new CliError(
        "prx delegate repair-assignees: missing required --to <login>",
      );
    }

    return {
      command: "delegate-repair-assignees" as const,
      repoPath: values["repo-path"],
      from: values.from,
      to: values.to,
      apply: values.apply,
    };
  }

  if (command === "refresh") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        "no-push": { type: "boolean", default: false },
        local: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command: "refresh",
      repoPath: values["repo-path"],
      noPush: values["no-push"],
      local: values["local"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (
    command === "actions" ||
    command === "next-action" ||
    command === "phase" ||
    command === "snapshot" ||
    command === "statusline"
  ) {
    if (rest.includes("--help") || rest.includes("-h")) {
      return { command: "plan-namespace-help" };
    }
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

      return {
        command,
        repoPath: values["repo-path"],
        format: ensureChoice(values.format, ["plain", "json"], "--format"),
      };
  }

  if (command === "do") {
    return parseActionDoCommand(rest);
  }

  if (command === "actors") {
    const { values } = parseArgs({
      args: rest,
      options: {
        scope: { type: "string", default: "pr" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      scope: ensureChoice(values.scope, ["pr", "workflow"], "--scope"),
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "model") {
    const { values } = parseArgs({
      args: rest,
      options: {
        scope: { type: "string", default: "pr" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      scope: ensureChoice(values.scope, ["pr", "workflow"], "--scope"),
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "sprint") {
    const [action, ...sprintArgs] = rest;
    const sprintAction = ensureChoice(
      action ?? "",
      ["init", "bind", "metric", "status", "sync-notion"],
      "sprint action",
    );

    if (sprintAction === "init") {
      const normalizedSprintArgs = [...sprintArgs];
      const targetIndex = normalizedSprintArgs.indexOf("--target-delta");
      if (
        targetIndex >= 0 &&
        targetIndex + 1 < normalizedSprintArgs.length &&
        normalizedSprintArgs[targetIndex + 1]!.startsWith("-")
      ) {
        normalizedSprintArgs[targetIndex] = `--target-delta=${normalizedSprintArgs[targetIndex + 1]}`;
        normalizedSprintArgs.splice(targetIndex + 1, 1);
      }
      const { values } = parseArgs({
        args: normalizedSprintArgs,
        options: {
          state: { type: "string", default: ".pr/local/sprint.json" },
          "repo-path": { type: "string", default: "." },
          id: { type: "string" },
          goal: { type: "string" },
          metric: { type: "string" },
          "target-delta": { type: "string" },
          "week-start": { type: "string" },
          "week-end": { type: "string" },
          format: { type: "string", default: "plain" },
        },
        strict: true,
        allowPositionals: false,
      });

      if (!values.id) throw new CliError("--id is required");
      if (!values.goal) throw new CliError("--goal is required");
      if (!values.metric) throw new CliError("--metric is required");
      if (!values["target-delta"]) throw new CliError("--target-delta is required");
      const targetDelta = Number.parseFloat(values["target-delta"]);
      if (!Number.isFinite(targetDelta)) throw new CliError("--target-delta must be numeric");

      return {
        command: "sprint",
        action: "init",
        sprintPath: values.state,
        repoPath: values["repo-path"],
        format: ensureChoice(values.format, ["plain", "json"], "--format"),
        apply: false,
        sprintId: values.id,
        goal: values.goal,
        metricName: values.metric,
        targetDelta,
        weekStart: values["week-start"],
        weekEnd: values["week-end"],
      };
    }

    if (sprintAction === "bind") {
      const { values } = parseArgs({
        args: sprintArgs,
        options: {
          state: { type: "string", default: ".pr/local/sprint.json" },
          "repo-path": { type: "string", default: "." },
          pr: { type: "string" },
          ticket: { type: "string" },
          unit: { type: "string" },
          format: { type: "string", default: "plain" },
        },
        strict: true,
        allowPositionals: false,
      });
      if (!values.pr) throw new CliError("--pr is required");
      const pr = Number.parseInt(values.pr, 10);
      if (!Number.isFinite(pr)) throw new CliError("--pr must be an integer");
      const ticket = values.ticket
        ? parseCanonicalWorkUnitId(values.ticket, "--ticket")
        : undefined;
      const unit = values.unit
        ? parseCanonicalWorkUnitId(values.unit, "--unit")
        : undefined;
      if (!ticket && !unit) {
        throw new CliError("--ticket or --unit is required");
      }
      if (ticket && unit && ticket !== unit) {
        throw new CliError("--ticket and --unit must match when both are provided");
      }
      return {
        command: "sprint",
        action: "bind",
        sprintPath: values.state,
        repoPath: values["repo-path"],
        format: ensureChoice(values.format, ["plain", "json"], "--format"),
        apply: false,
        pr,
        ticket,
        unit,
      };
    }

    if (sprintAction === "metric") {
      const { values } = parseArgs({
        args: sprintArgs,
        options: {
          state: { type: "string", default: ".pr/local/sprint.json" },
          "repo-path": { type: "string", default: "." },
          baseline: { type: "string" },
          current: { type: "string" },
          format: { type: "string", default: "plain" },
        },
        strict: true,
        allowPositionals: false,
      });
      const baseline = values.baseline !== undefined ? Number.parseFloat(values.baseline) : undefined;
      const current = values.current !== undefined ? Number.parseFloat(values.current) : undefined;
      if (baseline !== undefined && !Number.isFinite(baseline)) throw new CliError("--baseline must be numeric");
      if (current !== undefined && !Number.isFinite(current)) throw new CliError("--current must be numeric");
      return {
        command: "sprint",
        action: "metric",
        sprintPath: values.state,
        repoPath: values["repo-path"],
        format: ensureChoice(values.format, ["plain", "json"], "--format"),
        apply: false,
        baseline,
        current,
      };
    }

    if (sprintAction === "status") {
      const { values } = parseArgs({
        args: sprintArgs,
        options: {
          state: { type: "string", default: ".pr/local/sprint.json" },
          "repo-path": { type: "string", default: "." },
          format: { type: "string", default: "plain" },
        },
        strict: true,
        allowPositionals: false,
      });
      return {
        command: "sprint",
        action: "status",
        sprintPath: values.state,
        repoPath: values["repo-path"],
        format: ensureChoice(values.format, ["plain", "json"], "--format"),
        apply: false,
      };
    }

    const { values } = parseArgs({
      args: sprintArgs,
      options: {
        state: { type: "string", default: ".pr/local/sprint.json" },
        "repo-path": { type: "string", default: "." },
        apply: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      command: "sprint",
      action: "sync-notion",
      sprintPath: values.state,
      repoPath: values["repo-path"],
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      apply: values.apply,
    };
  }

  if (command === "update") {
    const { values } = parseArgs({
      args: rest,
      options: {
        contract: { type: "string", default: ".pr/local/pr.json" },
        output: { type: "string", default: ".pr/local/pr.md" },
        pr: { type: "string" },
        "repo-path": { type: "string", default: "." },
        apply: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      contract: values.contract,
      outputPath: values.output,
      pr: values.pr,
      repoPath: values["repo-path"],
      apply: values.apply,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "sync-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        apply: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      apply: values.apply,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "sync-issues") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "repo-path": { type: "string", default: "." },
        apply: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      repoPath: values["repo-path"],
      apply: values.apply,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "stately") {
    const { values } = parseArgs({
      args: rest,
      options: {
        url: { type: "string", default: "https://stately.ai/registry/editor/" },
        "no-wait": { type: "boolean", default: false },
        model: { type: "string", default: "lifecycle" },
      },
      strict: true,
      allowPositionals: false,
    });

    return {
      command,
      url: values.url,
      noWait: values["no-wait"],
      model: ensureChoice(values.model, ["lifecycle", "system"], "--model"),
    };
  }

  if (command === "intake") {
    // GH-950: `prx intake agent` is the operator-session shape (search →
    // file-or-merge → mirror → comment, no edits). Route it to the
    // `intake-session` handler before validating the type positional, since
    // `agent` is not a member of INTAKE_TYPES.
    // GH-2380: `agent` is the canonical verb (headless-first); the hard-removed
    // `session` token errors with a removal hint.
    if (rest[0] === "agent") {
      return parseIntakeSessionCommand(rest.slice(1));
    }
    if (rest[0] === "session") {
      throw new CliError(
        "prx intake session: removed; use prx intake agent (add --interactive for the tmux/PTY session).",
      );
    }
    // GH-1000: `prx intake view <id>` is the read primitive for the intake
    // session. Routed before the type-positional validator since `view` is
    // not a member of INTAKE_TYPES.
    if (rest[0] === "view") {
      return parseIntakeViewCommand(rest.slice(1));
    }
    // GH-999: `prx intake search <query>` is the unified GH+bd dedupe search.
    // Routed before the type-positional validator since `search` is not a
    // member of INTAKE_TYPES.
    if (rest[0] === "search") {
      return parseIntakeSearchCommand(rest.slice(1));
    }
    // GH-1218: `prx intake status` is the intake-side mirror of triage status.
    if (rest[0] === "status") {
      return parseIntakeStatusCommand(rest.slice(1));
    }
    // GH-1001: `prx intake merge <dup> <canonical>` is the dedupe verb —
    // pointer comment + close. Routed before the type-positional validator
    // since `merge` is not a member of INTAKE_TYPES.
    if (rest[0] === "merge") {
      return parseIntakeMergeCommand(rest.slice(1));
    }
    // GH-1323: `prx intake comment <canonical> --body …` is the pointer-
    // comment-without-close verb (sister of `intake merge`). Routed before
    // the type-positional validator since `comment` is not a member of
    // INTAKE_TYPES.
    if (rest[0] === "comment") {
      return parseIntakeCommentCommand(rest.slice(1));
    }
    // GH-1002: `prx intake mirror <gh-id>` is the idempotent bd-create verb.
    // Routed before the type-positional validator since `mirror` is not a
    // member of INTAKE_TYPES.
    if (rest[0] === "mirror") {
      return parseIntakeMirrorCommand(rest.slice(1));
    }
    // prx-lfv: `prx intake result --disposition … --uow … [--reason …]` — the
    // structured tool the headless intake agent calls to REPORT its outcome
    // (filed | merged | duplicate | no_action). A non-MCP tool in the agent's
    // Bash(prx intake:*) allowlist; it writes the reported-result file the
    // parent reads post-run to surface the UoW (or the reason).
    if (rest[0] === "result") {
      return parseIntakeResultCommand(rest.slice(1));
    }
    // GH-1003: `prx intake bd …` is the narrow bd surface (ls + memory verbs)
    // that subsumes raw `bd list` / `bd memories` for the intake session.
    // Routed before the type-positional validator since `bd` is not a member
    // of INTAKE_TYPES.
    if (rest[0] === "bd") {
      return parseIntakeBdCommand(rest.slice(1));
    }
    // GH-1194: `prx intake dispatch …` redirects to the dispatch envelope.
    if (rest[0] === "dispatch") {
      return parseCommand(["dispatch", "--source=intake", ...rest.slice(1)]);
    }

    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        title: { type: "string" },
        scope: { type: "string" },
        body: { type: "string" },
        "body-stdin": { type: "boolean", default: false },
        description: { type: "string" },
        design: { type: "string" },
        acceptance: { type: "string" },
        notes: { type: "string" },
        label: { type: "string", multiple: true },
        assignee: { type: "string", multiple: true },
        repo: { type: "string" },
        // GH-1607: opt-in projection target. Default (omitted) is bd-only;
        // `--to gh` adds the publishOne projection step. Enum is narrowed to
        // `gh` until other adapters land (GH-1500 §2).
        to: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    const typePositional = positionals[0]?.trim();
    if (!typePositional) {
      throw new CliError(
        `intake requires a type positional: ${INTAKE_INTENTS.join(" | ")} | session | view | search | status | merge | mirror | bd`,
      );
    }
    if (!(INTAKE_INTENTS as readonly string[]).includes(typePositional)) {
      throw new CliError(
        `intake: unknown type '${typePositional}'. Valid types: ${INTAKE_INTENTS.join(", ")} | session | view | search | status | merge | mirror | bd`,
      );
    }

    // Title can come from --title or as a second positional ("prx intake bug 'broken thing'").
    let title = values.title;
    const titlePositional = positionals[1];
    if (titlePositional) {
      if (title) {
        throw new CliError(
          "intake: title given via both --title and positional; use one",
        );
      }
      title = titlePositional;
    }
    if (!title || title.trim().length === 0) {
      throw new CliError("intake requires a title (--title TEXT or positional)");
    }
    if (positionals.length > 2) {
      throw new CliError(
        `intake: unexpected extra positionals: ${positionals.slice(2).join(" ")}`,
      );
    }

    // --body-stdin and --body / @file are mutually exclusive.
    if (values["body-stdin"] && values.body !== undefined) {
      throw new CliError("intake: --body and --body-stdin are mutually exclusive");
    }

    // Detect `--body @path` so we can route through bodyFile in the intake module
    // (the body string carries the @-prefix which intakeOptionsSchema treats as
    // free text otherwise).
    let bodyValue = values.body;
    let bodyFile: string | undefined;
    if (bodyValue !== undefined && bodyValue.startsWith("@") && bodyValue.length > 1) {
      bodyFile = bodyValue.slice(1);
      bodyValue = undefined;
    }

    const to = values.to === undefined
      ? undefined
      : ensureChoice(values.to, ["gh"] as const, "--to");

    return {
      command: "intake",
      type: typePositional as IntakeIntent,
      title,
      scope: values.scope,
      body: bodyValue,
      bodyFile,
      bodyStdin: values["body-stdin"],
      description: values.description,
      design: values.design,
      acceptance: values.acceptance,
      notes: values.notes,
      labels: values.label ?? [],
      assignees: values.assignee ?? [],
      repo: values.repo,
      to,
      dryRun: values["dry-run"],
      yes: values.yes,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "triage-result") {
    return parseTriageResultCommand(rest);
  }

  if (command === "triage-status") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        format: { type: "string", default: "plain" },
        limit: { type: "string", default: "0" },
        "include-intentional": { type: "boolean", default: false },
        "rate-limit": { type: "boolean", default: false },
        // GH-1786: read-time freshness budget; symmetric with `scout issues`.
        "max-staleness": { type: "string", default: "24h" },
        "no-refresh": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(`triage status: --limit must be a non-negative integer (got ${values.limit})`);
    }

    return {
      command: "triage-status",
      repo: values.repo,
      limit: limitNum,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      includeIntentional: values["include-intentional"] === true,
      rateLimit: values["rate-limit"] === true,
      maxStaleness: (values["max-staleness"] as string | undefined) ?? "24h",
      noRefresh: values["no-refresh"] === true,
    };
  }

  if (command === "triage-session") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        // GH-1689: --repo retargets at a registered bare's mainx and skips
        // the in-cwd mainx guard. Mirrors `triage-classify --repo`.
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
        // GH-2380: headless-first. Default is the headless SDK job;
        // --interactive opts into the legacy tmux/PTY session.
        interactive: { type: "boolean", default: false },
      },
      strict: true,
      // prx-383: an optional positional work-unit id seeds triage at THAT item
      // (`prx triage agent prx-0v5`) instead of sweeping the whole queue.
      allowPositionals: true,
    });

    return {
      command: "triage-session",
      repoSlug: values.repo,
      dryRun: values["dry-run"] ?? false,
      check: values.check ?? false,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
      interactive: values.interactive === true ? true : undefined,
      ...(typeof positionals[0] === "string" ? { message: positionals[0] } : {}),
    };
  }

  if (command === "triage-classify") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        from: { type: "string" },
        format: { type: "string", default: "json" },
        limit: { type: "string", default: "0" },
        "require-budget": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage classify: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    let requireBudget: number | undefined;
    if (values["require-budget"] !== undefined) {
      const parsedBudget = Number.parseInt(values["require-budget"], 10);
      if (!Number.isFinite(parsedBudget) || parsedBudget < 0) {
        throw new CliError(
          `triage classify: --require-budget must be a non-negative integer (got ${values["require-budget"]})`,
        );
      }
      requireBudget = parsedBudget;
    }
    return {
      command: "triage-classify",
      repo: values.repo,
      from: values.from,
      limit: limitNum,
      format: ensureChoice(values.format, ["json", "tsv"], "--format"),
      requireBudget,
    };
  }

  if (command === "triage-apply") {
    const { values } = parseArgs({
      args: rest,
      options: {
        plan: { type: "string" },
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        sync: { type: "boolean", default: false },
        "no-sync": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage apply: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    if (values.sync && values["no-sync"]) {
      throw new CliError("triage apply: --sync and --no-sync are mutually exclusive");
    }
    // GH-971 — sync defaults on. `--no-sync` opts out.
    const sync = !values["no-sync"];
    return {
      command: "triage-apply",
      plan: values.plan,
      repo: values.repo,
      dryRun: values["dry-run"] ?? false,
      limit: limitNum,
      sync,
    };
  }

  if (command === "triage-promote") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        from: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        only: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage promote: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    let only: number | undefined;
    if (values.only !== undefined) {
      const onlyNum = Number.parseInt(values.only, 10);
      if (!Number.isFinite(onlyNum) || onlyNum <= 0) {
        throw new CliError(
          `triage promote: --only must be a positive issue number (got ${values.only})`,
        );
      }
      only = onlyNum;
    }
    return {
      command: "triage-promote",
      repo: values.repo,
      from: values.from,
      dryRun: values["dry-run"] ?? false,
      limit: limitNum,
      only,
    };
  }

  if (command === "triage-promote-children") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        only: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "triage promote-children requires a staging-dir positional argument",
      );
    }
    if (positionals.length > 1) {
      throw new CliError(
        `triage promote-children accepts a single staging-dir positional (got ${positionals.length})`,
      );
    }
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage promote-children: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    return {
      command: "triage-promote-children",
      dir: positionals[0]!,
      dryRun: values["dry-run"] ?? false,
      limit: limitNum,
      only: values.only,
    };
  }

  if (command === "triage-close") {
    // GH-1719: actor-tied close wrapper for bd-only records. Positional
    // <bd-id> is REQUIRED — this verb performs a real bd `update -s closed`
    // write, so operator intent must be explicit (mirrors `plan close`).
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        reason: { type: "string", default: "not-planned" },
        note: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length === 0) {
      throw new CliError(
        "triage close requires a bd-id positional (e.g., `prx triage close ai-home-mgwqw --reason not-planned`)",
      );
    }
    if (positionals.length > 1) {
      throw new CliError("triage close accepts at most one bd-id positional");
    }
    const bdId = positionals[0]!.trim();
    if (!bdId) {
      throw new CliError("triage close: bd-id must not be empty");
    }
    const reason = ensureChoice(
      values.reason,
      ["completed", "not-planned", "duplicate"] as const,
      "--reason",
    );
    const format = ensureChoice(values.format, ["plain", "json"], "--format");
    return {
      command: "triage-close",
      bdId,
      reason,
      ...(values.note !== undefined ? { note: values.note } : {}),
      dryRun: values["dry-run"] ?? false,
      format,
    };
  }

  if (command === "triage-close-stale") {
    // GH-1782: bulk-close beads whose linked GH issue is closed. Default
    // reason is `completed` (vs `not-planned` for `triage close`) because the
    // dominant cause of a stale bead is "GH issue closed → PR merged → work
    // shipped".
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        reason: { type: "string", default: "completed" },
        note: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    const reason = ensureChoice(
      values.reason,
      ["completed", "not-planned", "duplicate"] as const,
      "--reason",
    );
    const format = ensureChoice(values.format, ["plain", "json"], "--format");
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage close-stale: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    return {
      command: "triage-close-stale",
      ...(values.repo !== undefined ? { repo: values.repo } : {}),
      reason,
      ...(values.note !== undefined ? { note: values.note } : {}),
      dryRun: values["dry-run"] ?? false,
      limit: limitNum,
      format,
    };
  }

  if (command === "triage-drift-fix") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        from: { type: "string" },
        apply: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        axes: { type: "string" },
        "no-sync": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage drift-fix: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    let axes: DriftFixAxis[] = ["type", "priority", "status"];
    if (values.axes !== undefined) {
      const parts = values.axes.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const valid = new Set<DriftFixAxis>(["type", "priority", "status"]);
      for (const part of parts) {
        if (!valid.has(part as DriftFixAxis)) {
          throw new CliError(
            `triage drift-fix: --axes must be a comma-separated subset of {type,priority,status} (got "${values.axes}")`,
          );
        }
      }
      if (parts.length === 0) {
        throw new CliError("triage drift-fix: --axes must list at least one axis");
      }
      axes = parts as DriftFixAxis[];
    }
    const apply = values.apply ?? false;
    if (apply && values.from !== undefined) {
      throw new CliError("triage drift-fix: --apply and --from are mutually exclusive");
    }
    return {
      command: "triage-drift-fix",
      repo: values.repo,
      from: values.from,
      apply,
      dryRun: values["dry-run"] ?? false,
      limit: limitNum,
      axes,
      sync: !values["no-sync"],
    };
  }

  if (command === "triage-migrate-axis-value") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        axis: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        apply: { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        "no-sync": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.axis) {
      throw new CliError("triage migrate-axis-value: --axis is required");
    }
    if (!(LABEL_AXES as readonly string[]).includes(values.axis)) {
      throw new CliError(
        `triage migrate-axis-value: --axis must be one of ${LABEL_AXES.join(", ")} (got "${values.axis}")`,
      );
    }
    if (!values.from) {
      throw new CliError("triage migrate-axis-value: --from is required");
    }
    if (!values.to) {
      throw new CliError("triage migrate-axis-value: --to is required");
    }
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage migrate-axis-value: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    return {
      command: "triage-migrate-axis-value",
      repo: values.repo,
      axis: values.axis as LabelAxis,
      from: values.from,
      to: values.to,
      apply: values.apply ?? false,
      limit: limitNum,
      sync: !values["no-sync"],
    };
  }

  if (command === "triage-prioritize") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "0" },
        sync: { type: "boolean", default: false },
        "no-sync": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage prioritize: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    if (values.sync && values["no-sync"]) {
      throw new CliError("triage prioritize: --sync and --no-sync are mutually exclusive");
    }
    // Sync defaults on (mirrors `triage apply`, GH-971).
    const sync = !values["no-sync"];
    return {
      command: "triage-prioritize",
      repo: values.repo,
      dryRun: values["dry-run"] ?? false,
      limit: limitNum,
      sync,
    };
  }

  if (command === "triage-type-pass") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        model: { type: "string" },
        "batch-size": { type: "string" },
        limit: { type: "string", default: "0" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage type-pass: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    let batchSize = 30;
    if (values["batch-size"] !== undefined) {
      const parsed = Number.parseInt(values["batch-size"], 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliError(
          `triage type-pass: --batch-size must be a positive integer (got ${values["batch-size"]})`,
        );
      }
      batchSize = parsed;
    }
    return {
      command: "triage-type-pass",
      repo: values.repo,
      model: values.model ?? "claude-haiku-4-5-20251001",
      batchSize,
      limit: limitNum,
      dryRun: values["dry-run"] ?? false,
    };
  }

  if (command === "triage-prioritize-bulk") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        model: { type: "string", default: "claude-haiku-4-5-20251001" },
        "batch-size": { type: "string", default: "30" },
        limit: { type: "string", default: "0" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const limitNum = Number.parseInt(values.limit ?? "0", 10);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      throw new CliError(
        `triage prioritize-bulk: --limit must be a non-negative integer (got ${values.limit})`,
      );
    }
    const batchSizeNum = Number.parseInt(values["batch-size"] ?? "30", 10);
    if (!Number.isFinite(batchSizeNum) || batchSizeNum <= 0) {
      throw new CliError(
        `triage prioritize-bulk: --batch-size must be a positive integer (got ${values["batch-size"]})`,
      );
    }
    return {
      command: "triage-prioritize-bulk",
      repo: values.repo,
      model: values.model ?? "claude-haiku-4-5-20251001",
      batchSize: batchSizeNum,
      limit: limitNum,
      dryRun: values["dry-run"] ?? false,
    };
  }

  if (command === "triage-prime") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "auto-prioritize": { type: "boolean", default: false },
        // GH-1342: chain `prx triage drift-fix --apply` into each iteration.
        "auto-drift-fix": { type: "boolean", default: false },
        "max-iterations": { type: "string", default: "5" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    const maxIter = Number.parseInt(values["max-iterations"] ?? "5", 10);
    if (!Number.isFinite(maxIter) || maxIter <= 0) {
      throw new CliError(
        `triage prime: --max-iterations must be a positive integer (got ${values["max-iterations"]})`,
      );
    }
    const fmt = values.format ?? "plain";
    if (fmt !== "plain" && fmt !== "json") {
      throw new CliError(`triage prime: --format must be plain|json (got ${fmt})`);
    }
    return {
      command: "triage-prime",
      repo: values.repo,
      dryRun: values["dry-run"] ?? false,
      autoPrioritize: values["auto-prioritize"] ?? false,
      autoDriftFix: values["auto-drift-fix"] ?? false,
      maxIterations: maxIter,
      format: fmt,
    };
  }

  if (command === "map-create") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        tickets: { type: "string" },
        rationale: { type: "string" },
        "from-file": { type: "string" },
        parents: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });

    const name = positionals[0];
    if (!name || name.startsWith("-")) {
      throw new CliError("map create: <name> positional is required");
    }

    const fromFile = values["from-file"];
    if (fromFile) {
      // `--from-file` overrides inline tickets/rationale; treat the remaining
      // flags as ignored rather than refused so operators can iterate.
      return {
        command: "map-create",
        name,
        tickets: [],
        rationale: "",
        parents: [],
        fromFile,
      };
    }

    const tickets = (values.tickets ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tickets.length === 0) {
      throw new CliError(
        "map create: --tickets <id,id,...> is required (or use --from-file <path>)",
      );
    }
    const rationale = values.rationale;
    if (!rationale) {
      throw new CliError(
        "map create: --rationale <text> is required (or use --from-file <path>)",
      );
    }
    const parents = (values.parents ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    return { command: "map-create", name, tickets, rationale, parents };
  }

  if (command === "map-show") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: true,
    });

    const name = positionals[0];
    if (!name || name.startsWith("-")) {
      throw new CliError("map show: <name> positional is required");
    }

    return {
      command: "map-show",
      name,
      format: ensureChoice(values.format, ["plain", "json"], "--format"),
    };
  }

  if (command === "ci") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return { command: "plan-namespace-help" };
    }
    const { values } = parseArgs({
      args: rest,
      options: {
        phase: { type: "string" },
        format: { type: "string", default: "plain" },
      },
      strict: true,
      allowPositionals: false,
    });
    let phase: CiPhase | undefined;
    if (values.phase !== undefined) {
      if (!CI_PHASES.includes(values.phase as CiPhase)) {
        throw new CliError(
          `prx ci: --phase must be one of ${CI_PHASES.join("|")} (got ${values.phase})`,
        );
      }
      phase = values.phase as CiPhase;
    }
    const fmt = values.format ?? "plain";
    if (fmt !== "plain" && fmt !== "json") {
      throw new CliError(`prx ci: --format must be plain|json (got ${fmt})`);
    }
    return {
      command: "ci",
      phase,
      format: fmt,
    };
  }

  throw new CliError(`Unknown subcommand: ${command}`);
}

const repoRootPath = fileURLToPath(new URL("../../", import.meta.url));

function runCommand(command: string[], cwd = process.cwd()): CommandRunnerResult {
  const file = command[0] ?? "";
  const args = command.slice(1);
  try {
    const result = procRunner([file, ...args], {
      cwd,
      env: commandEnv(command),
      check: false,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function tryCommand(command: string[], cwd?: string): string | null {
  const result = runCommand(command, cwd);

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function canonicalBeadsRepoIdFromGithubRepo(githubRepo: string): string | null {
  const [owner, repo] = githubRepo.split("/");
  if (!owner || !repo) {
    return null;
  }
  return `io.github.${owner}/${repo}`;
}

export function canonicalBeadsRepoIdFromRemote(url: string): string | null {
  const githubRepo = parseGithubRepo(url);
  if (!githubRepo) {
    return null;
  }
  return canonicalBeadsRepoIdFromGithubRepo(githubRepo);
}

export function canonicalBeadsDatabaseName(canonicalRepoId: string): string {
  return canonicalRepoId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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

export function ensureBeadsInitSetup(
  cwd = process.cwd(),
  runner: CommandRunner = runCommand,
  options: { force: boolean } = { force: false },
): BeadsInitSetupResult {
  const bdVersion = runner(["bd", "version"], cwd);
  if (bdVersion.error || bdVersion.status !== 0) {
    return { status: "skipped", reason: "`bd` is unavailable" };
  }

  const originResult = runner(["git", "remote", "get-url", "origin"], cwd);
  if (originResult.error || originResult.status !== 0) {
    return { status: "skipped", reason: "git origin remote is unavailable" };
  }

  const originUrl = originResult.stdout.trim();
  const githubRepo = parseGithubRepo(originUrl);
  if (!githubRepo) {
    return { status: "skipped", reason: `unsupported git remote: ${originUrl}` };
  }

  const canonicalRepoId = canonicalBeadsRepoIdFromGithubRepo(githubRepo);
  if (!canonicalRepoId) {
    return { status: "skipped", reason: `unsupported git remote: ${originUrl}` };
  }

  const database = canonicalBeadsDatabaseName(canonicalRepoId);
  const repoName = githubRepo.split("/")[1] ?? "";
  const forceInitialize = (): BeadsInitSetupResult => {
    const forcedInitResult = runner(
      ["bd", "init", "--prefix", repoName, "--database", database, "--force", "--destroy-token", `DESTROY-${repoName}`],
      cwd,
    );
    if (forcedInitResult.error) {
      throw forcedInitResult.error;
    }
    if (forcedInitResult.status !== 0) {
      const message = (forcedInitResult.stderr || forcedInitResult.stdout).trim() || "Failed to force beads initialization";
      throw new Error(message);
    }
    configureGithubRepository();
    runner(["bd", "config", "set", "doctor.suppress.git-hooks", "true"], cwd);
    runner(["bd", "vc", "commit", "-m", "prx init: stabilize config state"], cwd);
    return {
      status: "forced",
      canonicalRepoId,
      database,
      githubRepository: githubRepo,
      prefix: repoName,
    };
  };

  const configureGithubRepository = (): void => {
    const configured = runner(["bd", "config", "get", "github.repository"], cwd);
    if (!configured.error && configured.status === 0 && parseBeadsConfigValue(configured.stdout) === githubRepo) {
      return;
    }

    const configResult = runner(["bd", "config", "set", "github.repository", githubRepo], cwd);
    if (configResult.error) {
      throw configResult.error;
    }
    if (configResult.status !== 0) {
      const message = (configResult.stderr || configResult.stdout).trim() || "Failed to configure beads GitHub repository";
      throw new Error(message);
    }
  };

  const contextResult = runner(["bd", "context", "--json"], cwd);
  if (!contextResult.error && contextResult.status === 0) {
    try {
      const context = JSON.parse(contextResult.stdout) as { database?: string };
      if (context.database === database) {
        configureGithubRepository();
        return { status: "unchanged", canonicalRepoId, database, githubRepository: githubRepo };
      }

      if (options.force) {
        return forceInitialize();
      }

      return {
        status: "skipped",
        reason: `existing beads database ${context.database ?? "unknown"} does not match ${database}`,
        canonicalRepoId,
        database,
        githubRepository: githubRepo,
      };
    } catch {
      return {
        status: "skipped",
        reason: "could not parse current beads context",
        canonicalRepoId,
        database,
        githubRepository: githubRepo,
      };
    }
  }

  if (options.force) {
    return forceInitialize();
  }

  const initResult = runner(["bd", "init", "--prefix", repoName, "--database", database], cwd);
  if (initResult.error) {
    throw initResult.error;
  }
  if (initResult.status !== 0) {
    const message = (initResult.stderr || initResult.stdout).trim() || "Failed to initialize beads";
    throw new Error(message);
  }
  configureGithubRepository();

  runner(["bd", "config", "set", "doctor.suppress.git-hooks", "true"], cwd);
  runner(["bd", "vc", "commit", "-m", "prx init: stabilize config state"], cwd);

  return {
    status: "initialized",
    canonicalRepoId,
    database,
    githubRepository: githubRepo,
    prefix: repoName,
  };
}

function parseBeadsConfigValue(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as { value?: unknown };
    if (typeof parsed?.value === "string") {
      return parsed.value;
    }
  } catch {
    // Fall back to legacy plain-text output from bd config get.
  }

  return trimmed;
}

async function detectInitTitle(cwd = process.cwd()): Promise<string> {
  const resolved = await tryResolveCanonicalFromCwd(cwd);
  if (resolved?.title) {
    return resolved.title;
  }
  return (
    tryCommand(["gh", "pr", "view", "--json", "title", "--jq", ".title"], cwd) ??
    tryCommand(["git", "branch", "--show-current"], cwd) ??
    "TODO.title"
  );
}

// Best-effort: init's fallback chain stays usable when the resolver errors
// (missing NOTION_TOKEN, network failure, Notion API error). `check-issue`
// is the explicit verification command and propagates errors.
async function tryResolveCanonicalFromCwd(cwd: string): Promise<ResolvedWorkUnit | null> {
  const helpers = ensureCanonicalHelpers();
  const candidate = helpers.normalize(basename(cwd));
  if (!helpers.isCanonical(candidate)) {
    return null;
  }
  const config = ensureIdentityConfig();
  const resolver = resolverForCanonicalId(candidate, config, cwd);
  if (!resolver) {
    return null;
  }
  try {
    return await resolver.fetch(candidate);
  } catch {
    return null;
  }
}

function detectInitSummary(): string {
  return "TODO.describe the change succinctly";
}

const VALID_CHANGE_TYPES = ["feature", "bugfix", "refactor", "housekeeping"] as const;
type ChangeType = (typeof VALID_CHANGE_TYPES)[number];

type InitialContractOptions = {
  title: string;
  summary: string;
  generatedBy: string;
  ready: boolean;
  changeType: string[];
};

// Port of skills/pr-contract/scripts/init_pr_contract.py#build_contract.
// All other Python args (why_problem, why_needed_for, ticket, notion, fixes,
// parent_ticket, entrypoint, risk_level, stack_position, ready_reason) keep
// their Python defaults — the current cli.ts call-site never passed them.
export function buildInitialPrContract(
  options: InitialContractOptions,
): Record<string, unknown> {
  const invalid = options.changeType.filter(
    (t) => !(VALID_CHANGE_TYPES as readonly string[]).includes(t),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid change type(s): ${invalid.join(", ")}. Must be one of: ${VALID_CHANGE_TYPES.join(", ")}`,
    );
  }
  const changeType: ChangeType[] = [
    ...new Set(options.changeType as ChangeType[]),
  ];
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ready = options.ready;
  return {
    version: "1.2.0",
    pr: {
      title: options.title,
      summary: options.summary,
      why: {
        problem: "TODO.describe the concrete problem",
        needed_for: "TODO.describe why this change needs to exist now",
        basis: "other",
        impact_of_not_doing: null,
        source_of_truth: null,
        quality: null,
        checked_by: null,
        notes: [],
      },
      ready: {
        value: ready,
        reason: null,
        checked_by: null,
        notes: ready
          ? []
          : ["Default behavior is to open or keep the PR as draft until pr.ready.value is true."],
      },
      lifecycle: {
        state: ready ? "ready_for_review" : "drafting",
        updated_by: "pr-contract:init",
        reason: ready ? null : "Initial PR state defaults to drafting.",
        notes: [],
      },
      ticket: null,
      change_type: changeType,
      links: { notion: null, fixes: null, parent_ticket: null },
    },
    author_assertions: {
      scope: {
        in_scope: [],
        non_goals: [
          "No formatting changes",
          "No unrelated refactors",
          "No dependency updates",
        ],
      },
      behavior: {
        entrypoint: "TODO.entrypoint",
        steps: ["TODO.describe primary workflow step"],
        constraints: [],
        error_handling: [],
      },
      validation: {
        unit_tests: [{ name: "TODO.test_name", covers: [], status: "not_run" }],
        integration: { executed: false, verified_output: false, notes: [] },
        commands: [],
        results: [],
      },
      failures_investigated: {
        all_traced_to_root_cause: false,
        tests_skipped_or_disabled: false,
        regression_test_added: null,
        root_cause: null,
        notes: [],
      },
      refactoring: { introduced_copy_paste: false, extractions: [] },
      risk: {
        level: "low",
        data_migration: false,
        breaking_change: false,
        external_side_effects: [],
        rollback: null,
      },
      stack: { position: null, depends_on: [], followed_by: [] },
    },
    observed_evidence: {
      ci: { status: "unknown", checks: [] },
      diff: {
        changed_files: null,
        additions: null,
        deletions: null,
        size_justified: null,
      },
      tickets: { notion_present: false },
    },
    claims: [],
    evidence: [],
    findings: [],
    observations: { verification_runs: [], external_effects: [] },
    assessments: [],
    invariants: [],
    review_state: {
      review_decision: null,
      unresolved_threads: null,
      focus_areas: [],
      known_tradeoffs: [],
    },
    provenance: {
      generated_by: options.generatedBy,
      generated_at: nowIso,
      source_tool: "pr-contract:init",
      tool_version: "1.2.0",
      commit_sha: null,
      diff_base: null,
      input_sources: [],
      human_edited: null,
    },
  };
}

export async function initContract(
  outputPath: string,
  options: {
    title?: string | undefined;
    summary?: string | undefined;
    ready: boolean;
    forceBeads: boolean;
    changeType: string[];
    generatedBy: string;
    untracked?: boolean | undefined;
  },
): Promise<{
  outputPath: string;
  title: string;
  summary: string;
  excludePath: string | null;
  excludeRules: string[];
  excludeUpdatedRules: string[];
  excludeRemovedRules: string[];
  prxGitignorePaths: string[];
  beadsSetup: BeadsInitSetupResult;
  workspaceTrack: boolean;
  workspaceConfigPath: string | null;
  workspaceTrackPersisted: boolean;
  trackedPrxFiles: string[];
}> {
  const title = options.title ?? (await detectInitTitle());
  const summary = options.summary ?? detectInitSummary();
  const contract = buildInitialPrContract({
    title,
    summary,
    generatedBy: options.generatedBy,
    ready: options.ready,
    changeType: options.changeType,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`);

  const repoRoot = tryCommand(["git", "rev-parse", "--show-toplevel"], process.cwd());

  // Resolve effective workspace.track: CLI flag (--untracked) pins to false;
  // otherwise honor the persisted value in prx.toml (default true).
  let workspaceTrack = true;
  let workspaceConfigPath: string | null = null;
  let workspaceTrackPersisted = false;
  if (repoRoot) {
    workspaceConfigPath = join(repoRoot, "prx.toml");
    const persisted = loadWorkspaceConfig(repoRoot);
    workspaceTrack = persisted.track;
    if (options.untracked) {
      workspaceTrack = false;
      if (persisted.track !== false) {
        persistWorkspaceTrack(repoRoot, false);
        workspaceTrackPersisted = true;
      }
    }
  }

  const excludeResult: EnsurePrxExcludesResult = repoRoot
    ? ensurePrxExcludes({ repoRoot, workspaceTrack })
    : { excludePath: null, excludeRules: workspaceTrack ? [".pr/"] : [".pr/", ".prx/"], excludeUpdatedRules: [], excludeRemovedRules: [] };
  const excludePath = excludeResult.excludePath;
  const excludeRules = excludeResult.excludeRules;
  const excludeUpdatedRules = excludeResult.excludeUpdatedRules;
  const excludeRemovedRules = excludeResult.excludeRemovedRules;
  const prxGitignorePaths: string[] = [];

  const trackedPrxFiles: string[] = [];
  if (repoRoot && workspaceTrack) {
    const prxRoot = join(repoRoot, ".prx");
    const prxRootGitignore = join(prxRoot, ".gitignore");
    const prxReposDir = join(prxRoot, "repos");
    const prxReposGitignore = join(prxReposDir, ".gitignore");

    mkdirSync(prxRoot, { recursive: true });
    mkdirSync(prxReposDir, { recursive: true });

    const desiredPrxRootGitignore = [
      "*",
      "!.gitignore",
      "!branch_protection/",
      "!branch_protection/**",
      "!repos/",
      "!repos/.gitignore",
      "!repos/config.json",
    ].join("\n");
    const desiredPrxReposGitignore = [
      "*",
      "!.gitignore",
      "!config.json",
    ].join("\n");

    if (!existsSync(prxRootGitignore) || readFileSync(prxRootGitignore, "utf8").trim() !== desiredPrxRootGitignore) {
      writeFileSync(prxRootGitignore, `${desiredPrxRootGitignore}\n`);
    }
    if (!existsSync(prxReposGitignore) || readFileSync(prxReposGitignore, "utf8").trim() !== desiredPrxReposGitignore) {
      writeFileSync(prxReposGitignore, `${desiredPrxReposGitignore}\n`);
    }

    prxGitignorePaths.push(prxRootGitignore, prxReposGitignore);
  } else if (repoRoot && !workspaceTrack) {
    // Untracked mode: .prx/ is excluded via info/exclude, so the internal
    // .gitignore allowlist is unnecessary. Detect already-tracked .prx/ files
    // so the CLI can print a cleanup nudge.
    const lsFiles = tryCommand(["git", "ls-files", "--", ".prx/"], repoRoot);
    if (lsFiles) {
      for (const entry of lsFiles.split("\n")) {
        if (entry.length > 0) {
          trackedPrxFiles.push(entry);
        }
      }
    }
  }

  const beadsSetup = ensureBeadsInitSetup(process.cwd(), runCommand, { force: options.forceBeads });

  return {
    outputPath,
    title,
    summary,
    excludePath,
    excludeRules,
    excludeUpdatedRules,
    excludeRemovedRules,
    prxGitignorePaths,
    beadsSetup,
    workspaceTrack,
    workspaceConfigPath,
    workspaceTrackPersisted,
    trackedPrxFiles,
  };
}

export function formatCreateCommand(mode: StateMode): string {
  return mode === "draft" ? "gh pr create --draft" : "gh pr create";
}

export function formatReadyCommand(mode: StateMode, state: LifecycleState, prRef: string): string {
  if (mode === "ready") {
    return `gh pr ready ${prRef}`;
  }

  return `echo 'PR ${prRef} should remain draft while lifecycle state is ${state}'`;
}

function formatWorkflowBackboneMermaidLines(): string[] {
  const initial = workflowMachine.config.initial;
  const states = workflowMachine.config.states;
  if (typeof initial !== "string" || !states || typeof states !== "object") {
    return [];
  }
  const lines = [
    '  state "workflowBackbone" as workflowBackbone {',
    `    [*] --> ${initial}`,
  ];
  for (const [stateName, stateCfg] of Object.entries(states)) {
    const on = (stateCfg as { on?: Record<string, unknown> }).on;
    if (!on) continue;
    for (const [eventType, target] of Object.entries(on)) {
      let tgt: string;
      if (typeof target === "string") {
        tgt = target;
      } else if (target && typeof target === "object" && "target" in target) {
        const t = (target as { target: unknown }).target;
        tgt = typeof t === "string" ? t : String(t);
      } else {
        continue;
      }
      lines.push(`    ${stateName} --> ${tgt}: ${eventType}`);
    }
  }
  lines.push("  }");
  return lines;
}

export function formatGraph(
  format:
    | "plain"
    | "json"
    | "xstate-json"
    | "xstate-ts"
    | "xstate-mermaid"
    | "mermaid"
    | "xstate-system-json"
    | "xstate-system-ts"
    | "xstate-system-mermaid"
    | "system-mermaid",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        id: "prSystem",
        type: "parallel",
        axes: ["lifecycle", "review", "ci", "mergeability", "workflowBackbone"],
        merge_gate: "lifecycle=open && ci=passed && review=approved && mergeability=clean",
      },
      null,
      2,
    );
  }

  if (format === "xstate-json" || format === "xstate-system-json") {
    return JSON.stringify(prSystemMachine.config, null, 2);
  }

  if (format === "xstate-ts" || format === "xstate-system-ts") {
    const config = JSON.stringify(prSystemMachine.config, null, 2);
    // GH-1275 (PR-3 of GH-1261): export `depResearchMachine` alongside the
    // PR-system machine so the dep-research per-run lifecycle is inspectable
    // in the same emit. GH-1537: same for `domainSyncMachine` (the per-pair
    // beads↔external-mirror reconcile). Additive — existing consumers reading
    // `machine` keep working.
    const depConfig = JSON.stringify(depResearchMachine.config, null, 2);
    const domainSyncConfig = JSON.stringify(domainSyncMachine.config, null, 2);
    // GH-1603: surface `fetchMachine` (the native-GraphQL write path's per-
    // run state machine) alongside the other introspectable machines so
    // `prx model --scope workflow --format xstate-system-ts` is a single
    // source of truth for the fetch verb's transitions.
    const fetchConfig = JSON.stringify(fetchMachine.config, null, 2);
    return [
      'import { createMachine } from "xstate";',
      "",
      "export const machine = createMachine(",
      `${config},`,
      ").provide({",
      "  actions: {",
      "    // Add action implementations here",
      "  },",
      "  guards: {",
      "    // Add guard implementations here",
      "  },",
      "});",
      "",
      "export const depResearchMachine = createMachine(",
      `${depConfig},`,
      ").provide({",
      "  actions: {",
      "    // Add action implementations here",
      "  },",
      "  guards: {",
      "    // Add guard implementations here",
      "  },",
      "});",
      "",
      "export const domainSyncMachine = createMachine(",
      `${domainSyncConfig},`,
      ").provide({",
      "  actions: {",
      "    // Add action implementations here",
      "  },",
      "  guards: {",
      "    // Add guard implementations here",
      "  },",
      "});",
      "",
      "export const fetchMachine = createMachine(",
      `${fetchConfig},`,
      ").provide({",
      "  actions: {",
      "    // Add action implementations here",
      "  },",
      "  guards: {",
      "    // Add guard implementations here",
      "  },",
      "});",
    ].join("\n");
  }

  if (
    format === "mermaid" ||
    format === "xstate-mermaid" ||
    format === "system-mermaid" ||
    format === "xstate-system-mermaid"
  ) {
    return [
      "stateDiagram-v2",
      "  state \"lifecycle\" as lifecycle {",
      "    [*] --> drafting",
      "    drafting --> open: SUBMIT",
      "    drafting --> closed: CLOSE",
      "    open --> drafting: CONVERT_TO_DRAFT",
      "    open --> merged: MERGE [isMergeable]",
      "    open --> closed: CLOSE",
      "    closed --> open: REOPEN",
      "  }",
      "  state \"review\" as review {",
      "    [*] --> none",
      "    none --> in_review: REQUEST_REVIEW",
      "    in_review --> changes_requested: REQUEST_CHANGES",
      "    in_review --> approved: APPROVE",
      "    in_review --> none: PUSH_COMMIT",
      "    changes_requested --> in_review: REQUEST_REVIEW",
      "    changes_requested --> none: PUSH_COMMIT",
      "    approved --> changes_requested: REQUEST_CHANGES",
      "    approved --> none: PUSH_COMMIT",
      "  }",
      "  state \"ci\" as ci {",
      "    [*] --> pending",
      "    pending --> running: CI_START",
      "    pending --> passed: CI_PASS",
      "    pending --> failed: CI_FAIL",
      "    running --> passed: CI_PASS",
      "    running --> failed: CI_FAIL",
      "    passed --> pending: PUSH_COMMIT",
      "    failed --> pending: PUSH_COMMIT",
      "  }",
      "  state \"mergeability\" as mergeability {",
      "    [*] --> unknown",
      "    unknown --> clean: MERGEABILITY_CLEAN",
      "    unknown --> blocked: MERGEABILITY_BLOCKED",
      "    unknown --> dirty: MERGEABILITY_DIRTY",
      "    clean --> unknown: PUSH_COMMIT",
      "    blocked --> unknown: PUSH_COMMIT",
      "    dirty --> unknown: PUSH_COMMIT",
      "  }",
      ...formatWorkflowBackboneMermaidLines(),
    ].join("\n");
  }

  return [
    "PR System State Machine",
    "=======================",
    "",
    "Model: parallel axes (lifecycle, review, ci, mergeability, workflowBackbone)",
    "Merge gate: lifecycle=open AND ci=passed AND review=approved AND mergeability=clean",
    "",
    "workflowBackbone: derived phase / parity chain (worktree, branch, PR, CI); entry into ready_to_merge is guarded live (merge gate: review approved + ci passed); other transitions documentary.",
    "",
    "Use --format xstate-json or --format xstate-ts for full machine config.",
  ].join("\n");
}

function formatTaskGraph(format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(taskRoleMachine.config, null, 2);
  }

  return [
    "Task Role Machine",
    "=================",
    "",
    "planning -> executing -> testing -> reviewing -> done",
    "blocked is entered when tester completes before CI is passed",
    "review rejection or reviewer failure sends work back to executing",
    "planner confirmations gate the handoff into execution",
  ].join("\n");
}

function refreshTaskSignals(taskPath: string): TaskContract {
  if (!taskContractExists(taskPath)) {
    throw new Error(`task contract missing at ${taskPath}`);
  }

  let updated = loadTaskContract(taskPath);
  let dirty = false;

  const reviewConfig = loadReviewConfig(updated.identity.worktree);
  const successPatch = {
    requireCommentsResolved: reviewConfig.requireCommentsResolved,
    requireAgentReview: reviewConfig.requireAgentReview,
    requireHumanReview: reviewConfig.requireHumanReview,
    requireAutoMergeEnabled: reviewConfig.requireAutoMergeEnabled,
  };
  const successUpdated =
    updated.success.requireCommentsResolved !== successPatch.requireCommentsResolved ||
    updated.success.requireAgentReview !== successPatch.requireAgentReview ||
    updated.success.requireHumanReview !== successPatch.requireHumanReview ||
    updated.success.requireAutoMergeEnabled !== successPatch.requireAutoMergeEnabled;
  if (successUpdated) {
    updated = setTaskSuccessRequirements(updated, successPatch);
    dirty = true;
  }

  const branch = currentBranchName(updated.identity.worktree);
  if (!branch) {
    if (dirty) {
      writeTaskContract(taskPath, updated);
    }
    return updated;
  }

  const info = fetchPrSignalInfo(updated.identity.worktree, branch);
  if (!info) {
    if (dirty) {
      writeTaskContract(taskPath, updated);
    }
    return updated;
  }

  if (info.reviewAdded && !updated.signals.reviewAdded) {
    updated = setTaskReviewAdded(updated, true);
    dirty = true;
  }
  if (info.reviewApproved && !updated.signals.reviewApproved) {
    updated = setTaskReviewApproved(updated, true);
    dirty = true;
  }
  if (info.agentReview !== updated.signals.agentReview) {
    updated = setTaskAgentReview(updated, info.agentReview);
    dirty = true;
  }
  if (info.humanReview !== updated.signals.humanReview) {
    updated = setTaskHumanReview(updated, info.humanReview);
    dirty = true;
  }
  if (info.commentsResolved !== updated.signals.commentsResolved) {
    updated = setTaskCommentsResolved(updated, info.commentsResolved);
    dirty = true;
  }
  if (info.autoMergeEnabled !== updated.signals.autoMergeEnabled) {
    updated = setTaskAutoMergeEnabled(updated, info.autoMergeEnabled);
    dirty = true;
  }

  const needsRebaseSignal = info.mergeStateStatus === "BEHIND";
  if (needsRebaseSignal !== updated.signals.needsRebase) {
    updated = setTaskNeedsRebase(updated, needsRebaseSignal);
    dirty = true;
  }

  const mergeConflictSignal = info.mergeable === "CONFLICTING";
  if (mergeConflictSignal !== updated.signals.mergeConflict) {
    updated = setTaskMergeConflict(updated, mergeConflictSignal);
    dirty = true;
  }

  if (dirty) {
    writeTaskContract(taskPath, updated);
  }

  return updated;
}

function formatTaskStatus(task: TaskContract, format: "plain" | "json"): string {
  const status = deriveTaskStatus(task);

  if (format === "json") {
    return JSON.stringify({ task, status }, null, 2);
  }

  const lines = [
    `workUnit=${task.identity.workUnitId}`,
    `bead=${task.identity.beadId ?? "unlinked"}`,
    `currentRole=${task.rolePlan.currentRole}`,
    `machine=${status.machineState}`,
    `handoff=${status.handoffStatus}`,
    `nextRole=${status.nextRole ?? "none"}`,
    `implementations=${taskRoles.map((role) => `${role}:${task.rolePlan.assignedImplementations[role]}`).join(", ")}`,
    `confirmations=spec:${task.confirmations.specSynced} scope:${task.confirmations.scopeConfirmed} success:${task.confirmations.successCriteriaConfirmed}`,
    `signals=remoteCi:${task.signals.remoteCiPassed} reviewAdded:${task.signals.reviewAdded} review:${task.signals.reviewApproved} agentReview:${task.signals.agentReview} humanReview:${task.signals.humanReview} commentsResolved:${task.signals.commentsResolved} autoMerge:${task.signals.autoMergeEnabled} rebase:${task.signals.needsRebase} conflict:${task.signals.mergeConflict}`,
  ];
  const executionByRole = task.execution as Record<string, TaskContract["execution"][TaskRole]>;
  for (const role of taskRoles) {
    const execution = executionByRole[role];
    if (execution) {
      lines.push(`execution.${role}=${execution.status}`);
    }
  }
  if (
    status.machineState === "blocked" &&
    status.nextRole === "planner" &&
    !task.signals.remoteCiPassed
  ) {
    lines.push("nextAction=Draft and push the PR to trigger remote CI");
  }
  if (task.signals.mergeConflict) {
    lines.push("nextAction=Resolve merge conflicts (planner)");
  } else if (task.signals.needsRebase) {
    lines.push("nextAction=Branch is behind origin/main; run `prx worktree refresh`");
  }
  if (status.machineState === "reviewing" && !task.signals.reviewAdded) {
    lines.push("nextAction=Wait for the reviewer to add feedback (reviewAdded)");
  } else if (status.machineState === "reviewing" && task.signals.reviewAdded && !task.signals.reviewApproved) {
    lines.push("nextAction=Resolve review threads/outdated items and mark approval");
  }
  if (task.success.requireCommentsResolved && !task.signals.commentsResolved) {
    lines.push("nextAction=Resolve review comments (scout)");
  } else {
    if (task.success.requireAgentReview && task.signals.agentReview && !task.signals.reviewApproved) {
      lines.push("nextAction=Scout confirm agent review comments are cleared");
    }
    if (task.success.requireHumanReview && task.signals.humanReview && !task.signals.reviewApproved) {
      lines.push("nextAction=Resolve human review feedback");
    }
  }
  if (task.success.requireAutoMergeEnabled && !task.signals.autoMergeEnabled) {
    lines.push("nextAction=Enable auto-merge on the PR (scout)");
  }
  if (status.blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of status.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }
  return lines.join("\n");
}

function missingExecutorConfirmations(task: TaskContract): string[] {
  const missing: string[] = [];
  if (!task.confirmations.specSynced) {
    missing.push("spec not synced");
  }
  if (!task.confirmations.scopeConfirmed) {
    missing.push("scope not confirmed");
  }
  if (!task.confirmations.successCriteriaConfirmed) {
    missing.push("success criteria not confirmed");
  }
  return missing;
}

function printStatus(contractPath: string, format: "plain" | "mode" | "json", output: Output): number {
  const info = deriveInfo(loadContract(contractPath));

  if (format === "mode") {
    output.log(info.mode);
    return 0;
  }

  if (format === "json") {
    output.log(JSON.stringify(info, null, 2));
    return 0;
  }

  const taskPath = defaultTaskPath();
  if (taskContractExists(taskPath)) {
    refreshTaskSignals(taskPath);
  }

  const base = `${info.state} (${info.mode})`;
  output.log(info.reason ? `${base} - ${info.reason}` : base);
  return 0;
}

function loadOrCreateTaskContract(taskPath: string, workUnitId: string, beadId?: string): TaskContract {
  if (taskContractExists(taskPath)) {
    return loadTaskContract(taskPath);
  }
  return createTaskContract({
    workUnitId,
    worktree: process.cwd(),
    beadId,
  });
}

/** Full subcommand catalog — pure projection over the Zod registry (GH-976). */
function formatFullCommandCatalogHelp(): string {
  return HelpAll(prxCommandRegistry);
}

/** Top-level help — overview surface from the registry, scoped to the current session context (GH-976). */
function formatHelp(): string {
  return HelpOverview(prxCommandRegistry, getCurrentSessionContext());
}

/**
 * Per-verb help (GH-1227) — registry-backed renderer fired when `--help` /
 * `-h` follows the canonical verb (e.g. `prx plan show GH-X --help`). The
 * registry does not yet track per-verb option metadata (that lives under
 * GH-974 / GH-975), so this surface lists the registry-owned fields and
 * points the operator at `prx help-all` for the broader catalog.
 */
// GH-1767: per-verb "See also" pointer for the bd-canonical PR-body
// convention. The registry's `description` is capped at 4-12 words
// (help-surface §6.4), so cross-references render out-of-band here.
// Keyed by canonical verb name (matches `CommandSpec.name`).
const VERB_HELP_SEE_ALSO: Record<string, string[]> = {
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

function formatVerbHelp(verb: string): string {
  const canonicalName = verb.replace(/-/g, " ");
  const spec = findCommand(canonicalName);
  if (!spec) {
    return formatHelp();
  }
  const lines: string[] = [];
  lines.push(`prx ${spec.name}`);
  lines.push("=".repeat(`prx ${spec.name}`.length));
  lines.push("");
  lines.push(spec.description);
  lines.push("");
  lines.push(`domain:   ${spec.domain}`);
  lines.push(`binding:  ${spec.binding}`);
  if (spec.session_profile) {
    lines.push(`profile:  ${spec.session_profile}`);
  }
  if (spec.deprecation) {
    lines.push("");
    lines.push(`deprecated: alias for \`${spec.deprecation.alias_for}\``);
    lines.push(`removal:    ${spec.deprecation.removal_target}`);
    lines.push(spec.deprecation.stderr_hint);
  }
  const seeAlso = VERB_HELP_SEE_ALSO[spec.name];
  if (seeAlso) {
    lines.push("");
    lines.push("See also:");
    for (const entry of seeAlso) {
      lines.push(`  ${entry}`);
    }
  }
  lines.push("");
  lines.push("Per-verb option lists are not yet in the registry (GH-974/975).");
  lines.push("Run `prx help-all` for the full subcommand catalog.");
  return lines.join("\n");
}

/**
 * Plan-namespace help (GH-1055) — rendered when a plan-namespace verb whose
 * canonical parser has no native `--help` (close, ci, phase, next-action) is
 * invoked with `--help`. We fall back to the parent namespace summary rather
 * than the top-level prx banner so operators see the relevant subcommand list.
 */
function formatPlanNamespaceHelp(): string {
  // GH-1311: groups the plan namespace by `session_role` (lifecycle / toolset
  // / preflight) so the cleavage between session-bootstrapping verbs and
  // verbs called from inside an open session is visible at the help surface.
  const planEntries = prxCommandRegistry.filter(
    (entry) => entry.parent === "plan",
  );
  const lines: string[] = ["prx plan", "==========", ""];
  lines.push(ActorSection("Subcommands", planEntries));
  lines.push("");
  lines.push(
    "Per-verb flag listings: run `prx plan session --help` or `prx plan ultrareview --help` for canonical-parser usage.",
  );
  return lines.join("\n");
}

/**
 * GH-1474: intake-namespace help — twin of `formatPlanNamespaceHelp`. Renders
 * when the operator runs `prx intake --help` so they see every intake
 * subcommand instead of the top-level prx banner. Per-subcommand flag
 * listings come from `formatVerbHelp` via `prx intake <sub> --help`.
 */
function formatIntakeNamespaceHelp(): string {
  const intakeEntries = prxCommandRegistry.filter(
    (entry) => entry.parent === "intake",
  );
  const lines: string[] = ["prx intake", "==========", ""];
  lines.push(ActorSection("Subcommands", intakeEntries));
  lines.push("");
  lines.push("Per-subcommand flag listings: run `prx intake <sub> --help`.");
  return lines.join("\n");
}

function formatSessionHelp(): string {
  // prx-rgr: `prx session` is retired — there is no `prx session` surface. This
  // help is now a redirect map from the old verbs to their canonical homes.
  return [
    "prx session (retired)",
    "=====================",
    "",
    "`prx session` no longer exists. Every verb moved to a canonical home:",
    "",
    "Redirect map:",
    "  prx session open <id>        → prx plan session <id>   (interactive planning)",
    "                               → prx plan agent <id>     (headless pipeline entry)",
    "  prx session plan <id>        → prx plan session <id>",
    "  prx session <id>             → prx plan session <id>",
    "  prx session open-claude <id> → prx claude <id>         (internal claude runtime launcher)",
    "  prx session close            → prx plan handoff        (post-merge teardown)",
    "  prx session next             → prx next",
    "  prx session status / phase   → prx phase",
    "",
    "Canonical entries:",
    "  prx plan session GH-456 [--interactive] [--check] [--dry-run] [--create [--from github|notion|beads]] [--repo SLUG] [--format plain|json]",
    "      Canonical planning entry; default --print + auto-save to <UoW>:plan@draft. `--interactive` opens a live plan-mode tmux session.",
    "  prx plan agent GH-456 [--create] [--dry-run] [--format plain|json]",
    "      Headless planning agent — the pipeline-flow entry. `--create` materializes the local work unit (source auto-resolved).",
    "  prx implement agent GH-456 [--plan PATH] [--dry-run] [--background] [--format plain|json]",
    "      Canonical executor entry (Edit/Write enabled).",
    "  prx claude GH-456 [--dry-run] [--no-attach] [--background] [--format plain|json]",
    "      Internal claude runtime-bootstrap launcher (formerly `prx session open-claude`).",
    "  prx plan handoff GH-456 [--dry-run] [--force] [--format plain|json]",
    "      Post-merge teardown.",
    "",
    "Notes:",
    "  `--create --from=<source>` materializes the worktree for a canonical id whose authority lives outside GitHub. `--from` requires `--create`; without it, the source is inferred from prefix routing (`--create` alone auto-resolves it).",
    "  `--repo <slug>` retargets `prx plan session` at a registered bare repo from `.prx/repos/index.json`.",
  ].join("\n");
}

function detectVersion(cwd = repoRootPath): string {
  // prx-1ab: a release build bakes the version tag — report it (e.g. `v0.1.14`,
  // with the SHA appended for traceability). __PRX_BUILD_*__ are replaced at
  // compile time via bun build --define (build-info.ts), so compiled binaries
  // report correctly even when run outside the repo. Untagged dev builds and
  // `bun run` fall back to the git-SHA identity.
  const version = bakedReleaseVersion();
  const baked = bakedGitSha();
  if (version) {
    return baked ? `${version} (git-${baked})` : version;
  }
  if (baked) {
    return `git-${baked}`;
  }
  const sha = tryCommand(["git", "rev-parse", "--short=12", "HEAD"], cwd);
  return sha ? `git-${sha}` : "git-unknown";
}

/**
 * prx-1ab: the newest local release tag (`v*`, semver-sorted), or null when none
 * is known. The update check compares the binary's *release* against this rather
 * than counting commits to origin/main (which advances every merged PR, so a
 * just-released binary always looked "behind"). Reads local tags only — no
 * network; a stale tag set just means no nag, same as the prior origin/main read.
 */
function latestReleaseTag(cwd: string): string | null {
  const out = tryCommand(["git", "tag", "--list", "v*", "--sort=-v:refname"], cwd);
  if (!out) return null;
  const newest = out.split("\n").map((l) => l.trim()).find((l) => /^v\d/.test(l));
  return newest ?? null;
}

/**
 * prx-j4a: human label for where a UoW lives, for the `prx plan agent`
 * input-artifact framing (`prx-0v5 (beads) → …`). Best-effort — omitted when the
 * id's domain isn't recognized.
 */
function planSourceLabel(unit: string): string | undefined {
  const domain = adapterForCanonicalId(unit)?.config?.domain;
  if (domain === "bd") return "beads";
  if (domain === "gh") return "github";
  return domain;
}

/**
 * prx-bs4: surface an agent-result artifact-contract violation (the agent
 * misreported — e.g. `filed` with no UoW) so it is not silently swallowed by the
 * best-effort CAS pin. The result still renders; the diagnostics warn the operator.
 */
function warnAgentContractDiagnostics(
  output: Output,
  actor: string,
  diagnostics: readonly { code: string; path: string; message: string }[],
): void {
  if (diagnostics.length === 0) return;
  output.error(`⚠ ${actor} result failed its artifact contract — not pinned to CAS:`);
  for (const d of diagnostics) {
    output.error(`  [${d.code}] ${d.path || "(root)"}: ${d.message}`);
  }
}

/** Shared release-update warning so all session-entry call sites stay in sync. */
export function formatBinaryUpdateWarning(update: { current: string; latest: string }): string {
  return (
    `⚠ prx ${update.current} — a newer release ${update.latest} is available. ` +
    "Update with `home-manager switch` (or rebuild via `bun run prx:build`) to pick up recent fixes."
  );
}

/**
 * GH-528 / prx-1ab: compare the running prx binary's baked *release* against the
 * newest local release tag and return update info if a newer release exists —
 * otherwise null. Used as an early precheck in session-entry so users are warned
 * when their installed binary predates a release (e.g. nix-managed and not
 * switched since a new tag landed).
 *
 * Release-based (not commit-distance from origin/main): a just-released binary
 * is no longer reported as "behind" simply because main advanced — only a newer
 * *tag* triggers the nag, which is what operators actually act on.
 *
 * Returns null (silent) when:
 *   - no baked release version (dev / `bun run` / untagged build)
 *   - no local release tags are known (nothing to compare against)
 *   - the binary's release is the newest known tag (up to date)
 *   - the binary's release is newer than any known tag (ahead — local tags stale)
 */
export function checkPrxBinaryUpstream(
  cwd: string = process.cwd(),
  bakedVersion: string | undefined = bakedReleaseVersion(),
): { current: string; latest: string } | null {
  if (!bakedVersion) return null;
  const latest = latestReleaseTag(cwd);
  if (!latest) return null;
  if (latest === bakedVersion) return null;
  // Only warn when `latest` is strictly newer than the binary's release. The tag
  // list is semver-sorted descending, so `latest` is the max; if it sorts at or
  // below the binary's version, the binary is current-or-ahead → stay silent.
  const ordered = tryCommand(
    ["git", "tag", "--list", "v*", "--sort=-v:refname"],
    cwd,
  );
  if (ordered) {
    const tags = ordered.split("\n").map((l) => l.trim()).filter((l) => /^v\d/.test(l));
    const latestIdx = tags.indexOf(latest);
    const binaryIdx = tags.indexOf(bakedVersion);
    // binaryIdx === -1 ⇒ the binary's tag isn't local (can't compare) → silent.
    // latestIdx >= binaryIdx ⇒ binary is current or ahead → silent.
    if (binaryIdx === -1 || latestIdx >= binaryIdx) return null;
  }
  return { current: bakedVersion, latest };
}

// prx-ktw: `checkVersionUpstream` (local-checkout-vs-origin/main distance) was
// removed — `prx --version` is release-based now (see `checkPrxBinaryUpstream`).

function formatRuntimeProfile(profile: RuntimeProfileProjection, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(profile, null, 2);
  }
  return [
    profile.command,
    ...profile.args.map((arg) => {
      if (arg.includes(" ") || arg === "") {
        return `'${arg}'`;
      }
      return arg;
    }),
  ].join(" \\\n  ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type RunRecord = {
  id: string;
  agent: string;
  input_hash: string;
  output_hash: string;
  status: string;
  latency_ms: number;
  timestamp: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function appendExecutionLog(cwd: string, entry: Record<string, unknown>): void {
  const logPath = join(cwd, ".pr", "local", "runtime", "executions.log.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  appendFileSync(logPath, line, "utf8");
}

function createRunRecord(input: Omit<RunRecord, "id">): RunRecord {
  return {
    ...input,
    id: sha256(`${input.agent}:${input.timestamp}:${input.input_hash}:${input.output_hash}`).slice(0, 16),
  };
}

function buildPrompt(input: string): string {
  return `Return ONLY valid JSON.\n${input}`;
}

function executeOpenCommand(
  command: string,
  args: string[],
  cwd = process.cwd(),
): { status: number; stdout: string; stderr: string } {
  return {
    status: runInheritStatus([command, ...args], { cwd }),
    stdout: "",
    stderr: "",
  };
}

function stripPrintOnlyArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (
      arg === "--json-schema" ||
      arg === "--output-format" ||
      arg === "--input-format"
    ) {
      index += 1;
      continue;
    }
    if (arg === "--no-session-persistence") {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function buildExecutedWorkProfile(
  profile: RuntimeProfileProjection,
  options: { prompt?: string | undefined },
): RuntimeProfileProjection {
  if (profile.command === "codex") {
    if (options.prompt) {
      return {
        ...profile,
        args: [
          "exec",
          "-s",
          "workspace-write",
          "--output-schema",
          getLocalRuntimeArtifactPaths().schemaPath,
          "--json",
          options.prompt,
        ],
        fallbackArgs: undefined,
      };
    }

    return profile;
  }

  if (profile.command === "gh") {
    if (options.prompt) {
      const command = profile.args[0] ?? "";
      const separator = profile.args[1] ?? "";
      return {
        ...profile,
        args: [command, separator, "-p", options.prompt],
      };
    }

    return profile;
  }

  if (profile.command === "gemini") {
    if (options.prompt) {
      return {
        ...profile,
        args: ["-p", options.prompt, "--output-format", "json"],
      };
    }

    return profile;
  }

  if (profile.command === "cursor-agent") {
    if (options.prompt) {
      return {
        ...profile,
        args: ["--print", "--output-format", "json", "--trust", options.prompt],
      };
    }

    return profile;
  }

  if (options.prompt) {
    const args = [...profile.args];
    const filteredArgs: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === undefined) continue;
      if (arg === "--input-format") {
        index += 1;
        continue;
      }
      filteredArgs.push(arg);
    }
    filteredArgs.push("--print", options.prompt);
    return {
      ...profile,
      args: filteredArgs,
    };
  }

  return {
    ...profile,
    args: [...stripPrintOnlyArgs(profile.args), "--continue"],
  };
}

type SubprocessMcpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type HttpMcpServerConfig = {
  type: "http";
  url: string;
};

type McpServerConfig = SubprocessMcpServerConfig | HttpMcpServerConfig;

type RuntimeArtifactDeps = {
  notionIdentity?: NotionIdentityConfig | null;
};

/**
 * Provision the project MCP config (`.pr/local/runtime/mcp.json`) without a
 * work-unit binding. Used by `prx triage session` (GH-893) on mainx, where
 * there is no GH-N to key agents.json on but the launched Claude still needs
 * the project's optional Notion MCP server visible.
 *
 * GH-1587: no `beads` MCP server is ever written here. Planner/operator agents
 * reach beads via the `prx tools bd` / `bd-safe` CLI wrappers — the `beads`
 * workflow actor is `kind: cli`, and `notion_mcp` is the only `mcp_server`
 * actor in the model. `--strict-mcp-config --mcp-config .pr/local/runtime/mcp.json`
 * makes this generated file the only MCP config, so anything written here loads
 * in every prx-managed session.
 */
export function ensureOpsRuntimeMcp(
  cwd = process.cwd(),
  deps: RuntimeArtifactDeps = {},
): RuntimeArtifactStatus {
  const paths = getLocalRuntimeArtifactPaths();
  const runtimeDir = dirname(join(cwd, paths.mcpPath));
  mkdirSync(runtimeDir, { recursive: true });

  const mcpServers: Record<string, McpServerConfig> = {};
  const notionIdentity = deps.notionIdentity !== undefined
    ? deps.notionIdentity
    : findFirstSourceOfKind(ensureIdentityConfig(), "notion")?.notion ?? null;
  if (notionIdentity?.auth === "notion-cli" || notionIdentity?.auth === "claude-mcp") {
    mcpServers.notion = { type: "http", url: "https://mcp.notion.com/mcp" };
  }
  const mcpConfig = {
    mcpServers,
  };
  writeFileSync(join(cwd, paths.mcpPath), JSON.stringify(mcpConfig, null, 2));

  return {
    mcpServers: Object.keys(mcpServers),
  };
}

export function ensureLocalRuntimeArtifacts(
  workUnitId: string,
  cwd = process.cwd(),
  deps: RuntimeArtifactDeps = {},
): RuntimeArtifactStatus {
  const paths = getLocalRuntimeArtifactPaths();
  const runtimeDir = dirname(join(cwd, paths.agentsPath));
  mkdirSync(runtimeDir, { recursive: true });

  const agents = {
    [workUnitId]: {
      description: `Bound work-unit agent for ${workUnitId}`,
      prompt: buildWorkUnitMachineFirstPromptText(workUnitId),
    },
    [buildTaskRoleAgentId(workUnitId, "planner")]: {
      description: `Bound planner agent for ${workUnitId}`,
      prompt: buildWorkUnitMachineFirstPromptText(workUnitId, "planner"),
    },
    [buildTaskRoleAgentId(workUnitId, "executor")]: {
      description: `Bound executor agent for ${workUnitId}`,
      prompt: buildWorkUnitMachineFirstPromptText(workUnitId, "executor"),
    },
    [buildTaskRoleAgentId(workUnitId, "tester")]: {
      description: `Bound tester agent for ${workUnitId}`,
      prompt: buildWorkUnitMachineFirstPromptText(workUnitId, "tester"),
    },
    [buildTaskRoleAgentId(workUnitId, "reviewer")]: {
      description: `Bound reviewer agent for ${workUnitId}`,
      prompt: buildWorkUnitMachineFirstPromptText(workUnitId, "reviewer"),
    },
  };
  writeFileSync(join(cwd, paths.agentsPath), JSON.stringify(agents, null, 2));

  const status = ensureOpsRuntimeMcp(cwd, deps);

  const outputSchema = buildRuntimeOutputSchema();
  writeFileSync(join(cwd, paths.schemaPath), JSON.stringify(outputSchema, null, 2));

  return status;
}

type SpawnLikeResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

type SpawnLike = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; env?: NodeJS.ProcessEnv },
) => SpawnLikeResult;

type WorktreeResolutionEntry = {
  branch: string;
  path: string;
  states: string[];
};

function resolveRepoRootWithSpawn(
  cwd: string,
  spawn: SpawnLike,
): string {
  const repoRootResult = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (repoRootResult.error) {
    throw repoRootResult.error;
  }
  if ((repoRootResult.status ?? 1) !== 0) {
    const msg = (repoRootResult.stderr ?? repoRootResult.stdout ?? "").trim() || "git rev-parse failed";
    throw new CliError(msg);
  }
  return (repoRootResult.stdout ?? "").trim();
}

function listResolvedWorktrees(
  repoRoot: string,
  runner: GithubCommandRunner,
): WorktreeResolutionEntry[] {
  // prx-native: read worktrees straight from git. Detached worktrees (branch
  // null) are kept with an empty branch so findWorktreeByDirectoryPrefix can
  // still match a drifted work-unit directory by its on-disk name.
  return listWorktrees(repoRoot, runner).map((entry) => ({
    branch: entry.branch ?? "",
    path: entry.path,
    states: [],
  }));
}

/**
 * GH-521: match a Worktrunk-created worktree directory to the canonical
 * work unit id. Worktrunk names work-unit worktrees `gh_<num>_<suffix>`
 * (e.g., `gh_515_azi` for GH-515). When a worktree exists at that path
 * but its branch has drifted (reset to main, detached, etc.), the exact
 * `entry.branch === workUnitId` match fails — but the user still wants
 * to reuse that directory rather than materialize a new one.
 *
 * Returns the first entry whose path basename begins with the expected
 * `gh_<num>_` prefix, or `undefined` if none match.
 */
export function findWorktreeByDirectoryPrefix(
  entries: ReadonlyArray<WorktreeResolutionEntry>,
  workUnitId: string,
): WorktreeResolutionEntry | undefined {
  const normalized = workUnitId.toLowerCase();
  const match = /^([a-z]+)-(\d+)$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const prefix = `${match[1]}_${match[2]}_`;
  return entries.find((entry) => basename(entry.path).toLowerCase().startsWith(prefix));
}

function materializeWorkUnitBranchWithGit(
  repoRoot: string,
  workUnitId: string,
  spawn: SpawnLike,
): void {
  // Delegates to the shared placement core (src/tools/worktree_layout.ts)
  // so the work-unit path and the `workspace.materialize` actor path can
  // never drift (ai-home-rkg1w.1 §3.3). Rewrap the worktree-add failure as
  // a CliError to preserve this surface's error contract.
  const targetPath = expectedWorktreePath(repoRoot, workUnitId);

  // prx-4xb: converge `--create` materialization onto the workspace actor so
  // the worktree is ledger-tracked (one materialization owner — `prx workspace
  // service/teardown` can then see `--create`-materialized units). The actor
  // shares the same placement core, so the worktree path is identical (branch =
  // workUnitId, base origin/main). `local_only` preserves this surface's
  // local-branch-no-remote-push semantics. The actor derives its `workspace_id`
  // from the GitHub origin, so we gate on a recognized workspace context and
  // fall back to the direct placement when there is none (non-GitHub repos /
  // fixtures the actor cannot reserve).
  // Only converge when the resolved workspace context genuinely belongs to
  // `repoRoot` — the actor's git resolution can leak `process.cwd()`, and
  // materializing against the wrong repo (or a fixture cwd) must fall back to
  // the direct placement below.
  const wsContext = resolveWorkspaceContext({ cwd: repoRoot, branch: workUnitId });
  if (wsContext !== null && resolve(wsContext.worktreePath) === resolve(repoRoot)) {
    const reserve = runWorkspaceReserve(
      ReserveInput.parse({ branch: workUnitId, local_only: true }),
      repoRoot,
    );
    if (reserve.status === "error") {
      throw new CliError(reserve.error ?? `workspace reserve failed for ${workUnitId}`);
    }
    const materialized = runWorkspaceMaterialize(
      MaterializeInput.parse({ workspace_id: reserve.workspace_id }),
      repoRoot,
      { spawn },
    );
    if (materialized.status === "error") {
      throw new CliError(
        materialized.error ?? `workspace materialize failed for ${workUnitId}`,
      );
    }
    return;
  }

  try {
    addWorktreeForBranch(repoRoot, workUnitId, targetPath, spawn);
  } catch (err) {
    if (err instanceof WorktreeAddError) {
      throw new CliError(err.message);
    }
    throw err;
  }
}

// GH-2366: non-destructive `git fetch origin`. Shared by prepareMainxWorktree
// and the work-unit materialize path, so the latter can refresh origin/main
// without prepareMainxWorktree's destructive mainx `checkout --detach`.
function fetchOriginOrThrow(repoRoot: string, spawn: SpawnLike): void {
  const fetchResult = spawn("git", ["-C", repoRoot, "fetch", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (fetchResult.error) {
    throw fetchResult.error;
  }
  if ((fetchResult.status ?? 1) !== 0) {
    const detail = (fetchResult.stderr ?? fetchResult.stdout ?? "").trim()
      || `git fetch exited with status ${fetchResult.status}`;
    throw new CliError(`git fetch origin failed: ${detail}`);
  }
}

export function prepareMainxWorktree(
  cwd = process.cwd(),
  rawSpawn: SpawnLike = procSpawnLike,
): string {
  // ai-home-bbdm1: a crashed sibling git process can leave a stale index.lock in
  // any of these worktrees' git dirs, making fetch/worktree/checkout abort with
  // "Another git process seems to be running". Recover the lock (if no process
  // holds it and it is stale) and retry once, instead of bubbling git's raw
  // error up to the operator.
  const spawn: SpawnLike = withGitLockRecovery(rawSpawn, {
    onRecover: (recovery) => {
      if (recovery.recovered && recovery.removed) {
        process.stderr.write(
          `prx: removed stale git lock ${recovery.path}, retrying\n`,
        );
      }
    },
  });
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
  const worktreeParent = dirname(repoRoot);
  const worktreePath = join(worktreeParent, "mainx");

  // Fetch latest from origin
  fetchOriginOrThrow(repoRoot, spawn);

  // Check if mainx worktree already exists
  const listResult = spawn("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listResult.error) {
    throw listResult.error;
  }
  if ((listResult.status ?? 1) !== 0) {
    const detail = (listResult.stderr ?? listResult.stdout ?? "").trim()
      || `git worktree list exited with status ${listResult.status}`;
    throw new CliError(`mainx: ${detail}`);
  }
  const worktreeExists = (listResult.stdout ?? "")
    .split("\n")
    .some((line) => line === `worktree ${worktreePath}`);

  if (!worktreeExists) {
    if (existsSync(worktreePath)) {
      throw new CliError(
        `mainx: target path exists and is not a registered worktree: ${worktreePath}`,
      );
    }
    const addResult = spawn(
      "git",
      ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, "origin/main"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (addResult.error) {
      throw addResult.error;
    }
    if ((addResult.status ?? 1) !== 0) {
      const msg = (addResult.stderr ?? "").trim() || "git worktree add failed";
      throw new CliError(`mainx: ${msg}`);
    }
  }

  // GH-2366: never clobber a dirty mainx. This resets to detached origin/main;
  // refuse with a clear message (not git's cryptic "you need to resolve your
  // current index first") when the worktree has uncommitted changes, so the
  // operator's work is never silently lost.
  const statusResult = spawn("git", ["-C", worktreePath, "status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if ((statusResult.status ?? 1) === 0 && (statusResult.stdout ?? "").trim() !== "") {
    throw new CliError(
      `mainx: worktree has uncommitted changes; commit or stash them before resetting to origin/main (${worktreePath})`,
    );
  }

  // Checkout detached origin/main
  const checkoutResult = spawn(
    "git",
    ["-C", worktreePath, "checkout", "--detach", "origin/main"],
    { cwd: worktreePath, encoding: "utf8" },
  );
  if (checkoutResult.error) {
    throw checkoutResult.error;
  }
  if ((checkoutResult.status ?? 1) !== 0) {
    const msg = (checkoutResult.stderr ?? "").trim() || "git checkout failed";
    throw new CliError(`mainx: ${msg}`);
  }

  return worktreePath;
}

export type CloseSessionOptions = {
  workUnitId: string;
  dryRun: boolean;
  mainxReset: boolean;
  emitNext: boolean;
  emitFile?: string | undefined;
  force: boolean;
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

export type CloseSessionDeps = {
  cwd?: string;
  runner?: GithubCommandRunner;
  spawn?: SpawnLike;
  prepareMainx?: typeof prepareMainxWorktree;
  writeFile?: (path: string, content: string) => void;
};

/**
 * GH-643: run the in-place "landing ritual" from inside a merged feature
 * worktree and emit the fresh-shell handoff block. The verb must not try
 * to remove its own cwd — that's what strands the session. Exit codes:
 * `0` already-gone (idempotent re-run), `2` handoff required (happy path),
 * `1` refusal.
 */
export function closeSession(
  options: CloseSessionOptions,
  deps: CloseSessionDeps = {},
): CloseSessionResult {
  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? defaultRunner;
  const spawn = deps.spawn ?? procSpawnLike;
  const prepareMainx = deps.prepareMainx ?? prepareMainxWorktree;
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c));

  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
  const worktrees = listWorktrees(repoRoot, runner);
  // Prefer path match so detached-HEAD worktrees (where `branch` is null)
  // still resolve correctly when invoked from inside the worktree.
  const entryByPath = worktrees.find((w) => resolve(w.path) === resolve(repoRoot)) ?? null;
  const entryByBranch = worktrees.find((w) => w.branch === options.workUnitId) ?? null;
  const entry = entryByPath ?? entryByBranch;

  const baseResult: CloseSessionResult = {
    workUnitId: options.workUnitId,
    worktreePath: entry?.path ?? null,
    branch: entry?.branch ?? null,
    prNumber: null,
    prState: "none",
    issueState: null,
    remoteBranchPresent: null,
    mainxReset: "skipped",
    handoff: [],
    handoffRequired: false,
    refusalReason: null,
    dryRun: options.dryRun,
  };

  if (!entry) {
    return baseResult;
  }

  const worktreePath = entry.path;
  // Worktrees in a detached-HEAD state expose `branch: null`. In this
  // project the work-unit id IS the branch name by convention, so fall
  // back to `options.workUnitId` for downstream git + gh calls.
  const branch = entry.branch ?? options.workUnitId;

  const pr = maybeViewCurrentPr(worktreePath, runner);
  const prState = (pr ? prMergeStateLabel(pr) : "none") as CloseSessionResult["prState"];

  if (!pr && !options.force) {
    return {
      ...baseResult,
      prState: "none",
      refusalReason: `no PR found for branch ${branch}`,
    };
  }

  if (pr && prState !== "merged" && !options.force) {
    return {
      ...baseResult,
      prNumber: pr.number,
      prState,
      refusalReason: `PR #${pr.number} is ${prState}, not merged`,
    };
  }

  const repoSlug = repoNameWithOwner(worktreePath, runner);
  const issue = viewIssueFresh(repoSlug, options.workUnitId, runner);
  const issueState = issue ? (issue.state ?? "").toUpperCase() || null : null;

  const lsRemote = runner(
    ["git", "-C", worktreePath, "ls-remote", "--exit-code", "--heads", "origin", branch],
    { check: false },
  );
  // `git ls-remote --exit-code` returns 0 for present, 2 for absent;
  // any other non-zero code (commonly 128) is a transport/auth failure
  // and must not be conflated with "branch gone".
  const remoteBranchPresent =
    lsRemote.status === 0 ? true : lsRemote.status === 2 ? false : null;

  let mainxReset: CloseSessionResult["mainxReset"] = "skipped";
  if (options.mainxReset) {
    if (options.dryRun) {
      mainxReset = "dry-run";
    } else {
      try {
        prepareMainx(worktreePath, spawn);
        mainxReset = "done";
      } catch {
        mainxReset = "failed";
      }
    }
  }

  const handoff: string[] = [
    `prx worktree-remove ${options.workUnitId} --delete-branch --force`,
  ];
  if (options.emitNext) {
    handoff.push("prx delegate next");
  }

  if (options.emitFile && !options.dryRun) {
    writeFile(options.emitFile, handoff.join("\n") + "\n");
  }

  return {
    workUnitId: options.workUnitId,
    worktreePath,
    branch: entry.branch,
    prNumber: pr?.number ?? null,
    prState,
    issueState,
    remoteBranchPresent,
    mainxReset,
    handoff,
    handoffRequired: true,
    refusalReason: null,
    dryRun: options.dryRun,
  };
}

// GH-1057: `prx plan close` — operator-context wrapper for issue
// close-without-merge. Distinct from `closeSession` (post-merge cleanup) in
// that this verb actually invokes `gh issue close` with a structured reason
// + optional upstream-pointer comment, then runs `bd github sync` to mirror
// the closed state into beads. Carries actor identity for hooks gating raw
// `gh issue close` from non-plan profiles.

export type PlanCloseReason = "completed" | "not-planned" | "duplicate";

// GH-1720: `gh issue close --reason` accepts {completed|not planned|duplicate}
// (space form). Our canonical surface is hyphen form per
// feedback_no_raw_gh_close. Translate at the spawn boundary only.
export function planCloseReasonToGhReason(reason: PlanCloseReason): string {
  return reason === "not-planned" ? "not planned" : reason;
}

export type PlanCloseOptions = {
  workUnitId: string;
  reason: PlanCloseReason;
  upstream: string | null;
  dryRun: boolean;
  emitNext: boolean;
};

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

export type PlanCloseDeps = {
  cwd?: string;
  runner?: GithubCommandRunner;
  bdRunner?: BdGithubRunner;
  /**
   * Canonical reconcile (GH-2011: replaces the retired `bdSync` slot that
   * dispatched the bd-side reconcile shell-out). Tests override this seam
   * to assert the chain is invoked.
   */
  beadsSync?: typeof runBeadsSync;
  /**
   * GH-2110: bd-record close seams. Tests inject stubs to assert the
   * close-and-verify shape without spawning bd. Production wires the
   * defaults from `tools/bd_issue_close.ts` + `tools/bd.ts` + `triage.ts`.
   */
  execBdIssueClose?: typeof execBdIssueClose;
  bdShow?: typeof runBdShow;
  loadAllBeads?: () => BeadsRecord[];
};

export async function planClose(
  options: PlanCloseOptions,
  deps: PlanCloseDeps = {},
): Promise<PlanCloseResult> {
  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? defaultRunner;
  const beadsSync = deps.beadsSync ?? runBeadsSync;

  const issueNumberMatch = options.workUnitId.match(/-(\d+)$/);
  const issueNumber = issueNumberMatch ? Number(issueNumberMatch[1]) : null;

  const baseResult: PlanCloseResult = {
    workUnitId: options.workUnitId,
    issueNumber,
    reason: options.reason,
    upstream: options.upstream,
    upstreamCommentPosted: false,
    issueClosed: false,
    bdRecord: null,
    bdSyncExitCode: null,
    handoff: [
      `prx worktree-remove ${options.workUnitId} --delete-branch --force`,
    ],
    refusalReason: null,
    dryRun: options.dryRun,
  };
  if (options.emitNext) {
    baseResult.handoff.push("prx delegate next");
  }

  if (issueNumber === null) {
    return {
      ...baseResult,
      refusalReason: `cannot extract issue number from ${options.workUnitId}`,
    };
  }

  const repoSlug = repoNameWithOwner(cwd, runner);

  // Idempotency: skip if already closed. Surface as refusal so re-runs from a
  // shell hook don't silently no-op.
  const issue = viewIssueFresh(repoSlug, options.workUnitId, runner);
  const issueState = issue ? (issue.state ?? "").toUpperCase() : null;
  if (issueState === "CLOSED") {
    return {
      ...baseResult,
      refusalReason: `issue #${issueNumber} is already closed`,
    };
  }

  if (options.dryRun) {
    return baseResult;
  }

  let upstreamCommentPosted = false;
  if (options.upstream) {
    const body =
      `Closing in favor of upstream: ${options.upstream}\n\n` +
      `Reason: ${options.reason}`;
    const commentResult = runner(
      [
        "gh",
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repoSlug,
        "--body",
        body,
      ],
      { check: false },
    );
    if (commentResult.status !== 0) {
      return {
        ...baseResult,
        refusalReason:
          `failed to post upstream pointer comment: ` +
          (commentResult.stderr || commentResult.stdout || "unknown error").trim(),
      };
    }
    upstreamCommentPosted = true;
  }

  const closeResult = runner(
    [
      "gh",
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repoSlug,
      "--reason",
      planCloseReasonToGhReason(options.reason),
    ],
    { check: false },
  );
  if (closeResult.status !== 0) {
    return {
      ...baseResult,
      upstreamCommentPosted,
      refusalReason:
        `gh issue close failed: ` +
        (closeResult.stderr || closeResult.stdout || "unknown error").trim(),
    };
  }

  // GH-2110: end-of-line bd-record close-and-verify. Done by the close *actor*
  // for this work unit so the operator-visible outcome reflects the linked bd
  // record's actual status — the reconcile chain below can return 0 while
  // skipping per-pair closes (unpinned, limit, eventual-consistency lag), and
  // the previous `bd_sync=ok` line did not distinguish those cases from a
  // landed close.
  const bdRecord = await resolveAndCloseLinkedBeads(
    { issueNumber, reason: options.reason, cwd },
    {
      execBdIssueClose: deps.execBdIssueClose,
      bdShow: deps.bdShow,
      loadAllBeads: deps.loadAllBeads,
    },
  );

  // GH-2011: chain the canonical reconcile rather than the destructive bd
  // verb. Reconcile lag is still expected — surface the exit code so the
  // caller can re-run.
  const repoSlugTrimmed = repoSlug.trim();
  const syncResult = await beadsSync(
    {
      repo: repoSlugTrimmed.length > 0 ? repoSlugTrimmed : undefined,
      domain: "gh",
      dryRun: false,
      limit: DEFAULT_SYNC_LIMIT,
      format: "plain",
    },
    { log: () => {}, error: () => {} },
    { cwd: () => cwd },
  );

  // GH-2074 PR-3: this actor just mutated the unit — the GH issue and its
  // linked beads are now closed. Drop the unit's read-projection entries so a
  // subsequent read re-hydrates fresh instead of serving the stale pre-close
  // ("open") state within the TTL window (ai-home-udqx2.12 self-mutation
  // invalidation). Best-effort; a missing entry is a no-op.
  invalidateUnit(repoSlug, options.workUnitId);
  for (const per of bdRecord.perId ?? []) {
    invalidateUnit(cwd, per.id);
  }

  return {
    ...baseResult,
    upstreamCommentPosted,
    issueClosed: true,
    bdRecord,
    bdSyncExitCode: syncResult.exitCode,
  };
}

export type ReviewVerbOptions = {
  workUnitId?: string | undefined;
  ultra: boolean;
};

export type ReviewVerbDeps = {
  cwd?: string | undefined;
  runner?: GithubCommandRunner | undefined;
  muxRunner?: GithubCommandRunner | undefined;
  spawn?: SpawnLike | undefined;
  sendMuxKeys?: typeof sendMuxKeys | undefined;
  muxSessionState?: typeof muxSessionState | undefined;
  worktreeMap?: typeof worktreeMap | undefined;
};

export type ReviewVerbResult = {
  workUnitId: string | null;
  worktreePath: string;
  sessionName: string;
  sent: { keys: string; submit: boolean };
  handoff: string[];
};

/**
 * GH-review: send `/review` or `/ultrareview` into the work unit's
 * claude pane via `tmux send-keys`. The wrapper never executes the
 * skill directly — `/review` is interactive-only in Claude Code, and
 * `/ultrareview` requires the human to confirm the billing dialog.
 * Refuses (and nudges toward `prx session open`) when the mux session
 * is absent or only resurrectable.
 */
export function reviewVerb(
  options: ReviewVerbOptions,
  deps: ReviewVerbDeps = {},
): ReviewVerbResult {
  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? defaultRunner;
  const muxRunner = deps.muxRunner ?? defaultRunner;
  const spawn = deps.spawn ?? procSpawnLike;
  const stateFn = deps.muxSessionState ?? muxSessionState;
  const send = deps.sendMuxKeys ?? sendMuxKeys;
  const worktrees = deps.worktreeMap ?? worktreeMap;

  let worktreePath: string;
  let workUnitId: string | null = null;
  if (options.workUnitId) {
    const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
    const map = worktrees(repoRoot, runner);
    const found = map[options.workUnitId];
    if (!found) {
      throw new CliError(
        `no worktree for ${options.workUnitId}; run \`prx plan session ${options.workUnitId}\` to materialize it.`,
      );
    }
    worktreePath = found;
    workUnitId = options.workUnitId;
  } else {
    worktreePath = resolveRepoRootWithSpawn(cwd, spawn);
  }

  // GH-1172: a worktree may now host plan + implement sessions
  // concurrently. Prefer the implement-tagged session (where edits land)
  // and fall back to plan, then to the legacy un-suffixed name. The
  // surface map is the single source of truth for which sessions are
  // actually live.
  const surface = readTmuxSurface(muxRunner);
  let sessionName: string;
  if (workUnitId) {
    const entries = surface.get(workUnitId);
    const primary = entries ? pickPrimaryTmuxEntry(entries) : null;
    sessionName = primary?.sessionName ?? muxSessionName(worktreePath);
  } else {
    sessionName = muxSessionName(worktreePath);
  }
  const state = stateFn(sessionName, worktreePath, muxRunner);
  if (state === "absent" || state === "exited-resurrectable") {
    const hint = workUnitId
      ? `prx implement agent ${workUnitId}`
      : `prx plan session`;
    throw new CliError(
      `no live tmux session for ${sessionName}; run \`${hint}\` first.`,
    );
  }

  const keys = options.ultra ? "/ultrareview" : "/review";
  const submit = !options.ultra;
  send({ name: sessionName, keys, submit, run: muxRunner });

  const handoff = [`tmux -L ${PRX_TMUX_SOCKET} attach-session -t ${sessionName}`];
  if (options.ultra) {
    handoff.push(
      "/ultrareview is pre-filled and not submitted — press Enter in the pane to see Claude Code's billing confirmation (~$5–20/run).",
    );
  }
  return {
    workUnitId,
    worktreePath,
    sessionName,
    sent: { keys, submit },
    handoff,
  };
}

export function runBeadsInit(
  cwd: string,
  importGh: boolean,
  dryRun: boolean,
  output: { log: (msg: string) => void },
  spawn: SpawnLike = procSpawnLike,
): number {
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);

  // Verify git repo and required tools
  const originUrl = spawn("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (originUrl.status !== 0 || !originUrl.stdout?.trim()) {
    throw new CliError("beads-init: no 'origin' remote found");
  }

  const url = originUrl.stdout.trim();
  const match = url.match(/github\.com[:/]([^\s]+)$/);
  if (!match) {
    throw new CliError(`beads-init: unsupported git remote: ${url}`);
  }

  const githubRepo = match[1]!.replace(/\.git$/, "");
  const repoParts = githubRepo.split("/");
  const owner = repoParts[0] ?? "";
  const repo = repoParts[1] ?? "";
  const canonicalRepoId = `io.github.${owner}/${repo}`;
  const database = canonicalRepoId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const metadataPath = join(repoRoot, ".beads", "metadata.json");

  const info = {
    originUrl: url,
    githubRepo,
    canonicalRepoId,
    database,
    issuePrefix: repo,
  };

  // Read current metadata database
  let metadataDatabase: string | null = null;
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      metadataDatabase = typeof metadata.dolt_database === "string" ? metadata.dolt_database : null;
    } catch {
      // ignore parse errors
    }
  }

  const run = (cmd: string, args: string[]): { status: number; stdout: string; stderr: string } => {
    if (dryRun) {
      output.log(`[dry-run] ${cmd} ${args.join(" ")}`);
      return { status: 0, stdout: "", stderr: "" };
    }
    const env = { ...processEnv() };
    delete env.BEADS_DIR;
    const result = spawn(cmd, args, { cwd: repoRoot, encoding: "utf8", env });
    if (result.error) {
      const cmdLine = [cmd, ...args].join(" ");
      throw new CliError(`Failed to run "${cmdLine}": ${result.error.message}`);
    }
    const status = result.status ?? 1;
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    if (status !== 0) {
      const cmdLine = [cmd, ...args].join(" ");
      const details = [stderr, stdout].filter(Boolean).join("\n");
      throw new CliError(`Command failed with exit code ${status}: ${cmdLine}${details ? `\n${details}` : ""}`);
    }
    return { status, stdout, stderr };
  };

  const canonicalContextIsUsable = (): boolean => {
    const env = { ...processEnv() };
    delete env.BEADS_DIR;
    const probeResult = spawn("bd", ["info"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    return (probeResult.status ?? 1) === 0;
  };

  const bootstrapRuntimeRepair = (): void => {
    output.log("repair: canonical metadata matches, but database is unavailable; running beads bootstrap");
    run("bd", dryRun ? ["bootstrap", "--dry-run"] : ["bootstrap", "--yes"]);
  };

  // Patch metadata if needed
  if (existsSync(metadataPath) && metadataDatabase !== database) {
    output.log(`repair: rewriting ${metadataPath} dolt_database ${metadataDatabase ?? "unset"} -> ${database}`);
    if (!dryRun) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        metadata.dolt_database = database;
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
      } catch {
        throw new CliError(
          `beads-init: ${metadataPath} contains invalid JSON; fix or delete it and re-run`,
        );
      }
    }
  }

  // Check current bd context database
  let currentDatabase: string | null = null;
  {
    const env = { ...processEnv() };
    delete env.BEADS_DIR;
    const ctxResult = spawn("bd", ["context", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    if (ctxResult.status === 0 && ctxResult.stdout) {
      try {
        const ctx = JSON.parse(ctxResult.stdout);
        currentDatabase = typeof ctx.database === "string" ? ctx.database : null;
      } catch {
        // ignore
      }
    }
  }

  output.log(`origin:            ${url}`);
  output.log(`github repo:       ${githubRepo}`);
  output.log(`canonical repo id: ${canonicalRepoId}`);
  output.log(`canonical db:      ${database}`);
  output.log(`issue prefix:      ${repo}`);
  output.log(`metadata db:       ${metadataDatabase ?? "unset"}`);
  output.log(`bd context db:     ${currentDatabase ?? "unavailable"}`);

  // Init if needed
  if (currentDatabase !== database) {
    const beadsDir = join(repoRoot, ".beads");
    if (existsSync(beadsDir)) {
      output.log("repair: running forced canonical Beads init");
      run("bd", ["init", "--prefix", repo, "--database", database, "--force", "--destroy-token", `DESTROY-${repo}`]);
    } else {
      output.log("repair: running canonical Beads init");
      run("bd", ["init", "--prefix", repo, "--database", database]);
    }
    // Re-patch metadata after init
    if (existsSync(metadataPath) && !dryRun) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        if (metadata.dolt_database !== database) {
          metadata.dolt_database = database;
          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
        }
      } catch {
        throw new CliError(
          `beads-init: ${metadataPath} contains invalid JSON; fix or delete it and re-run`,
        );
      }
    }
  } else {
    if (canonicalContextIsUsable()) {
      output.log("status:            canonical context already active");
    } else {
      bootstrapRuntimeRepair();
    }
  }

  // Configure repo
  run("bd", ["config", "set", "github.repository", githubRepo]);
  run("bd", ["config", "set", "doctor.suppress.git-hooks", "true"]);

  if (importGh) {
    run("bd", ["github", "sync", "--pull-only", "--prefer-github"]);
  }

  // Verify
  if (!dryRun) {
    const env = { ...processEnv() };
    delete env.BEADS_DIR;
    const verifyResult = spawn("bd", ["context", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    if (verifyResult.status === 0 && verifyResult.stdout) {
      try {
        const ctx = JSON.parse(verifyResult.stdout);
        const verifiedDb = typeof ctx.database === "string" ? ctx.database : null;
        output.log(`verified db:       ${verifiedDb}`);
        if (verifiedDb !== database) {
          output.log(`beads-init: expected canonical database ${database}, got ${verifiedDb}`);
          return 1;
        }
      } catch {
        // ignore
      }
    }

    const readyResult = spawn("beads", ["ready"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    if (readyResult.status === 0) {
      output.log("verified:          beads ready");
    }
  }

  return 0;
}

export function materializeWorkUnitBranch(
  workUnitId: string,
  cwd = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
  runner: GithubCommandRunner = defaultRunner,
  noVerify = false,
): void {
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
  const routingConfig = loadPrefixRoutingConfig(repoRoot, runner);
  const issueFeature = resolveFeatureForPrefix(workUnitId, routingConfig);
  const [, numStr] = workUnitId.split("-");
  if (numStr) {
    const issueNumber = parseInt(numStr, 10);
    if (!Number.isNaN(issueNumber)) {
      if (issueFeature === "gh_issue") {
        checkWorkUnitIssue(workUnitId, repoRoot, runner);
      } else if (issueFeature === "beads_issue") {
        validateBeadsIssue(repoRoot, workUnitId, runner);
      }
    }
  }

  // GH-2366: the read-only plan/launch-cwd path must NOT mutate the shared
  // mainx worktree. materializeWorkUnitBranchWithGit (addWorktreeForBranch)
  // attaches the work-unit worktree directly from repoRoot — it needs origin
  // fetched (so the branch is cut from the latest origin/main) but does NOT
  // need mainx. The prior prepareMainxWorktree call additionally ran
  // `git checkout --detach origin/main` against mainx, clobbering it (hard
  // abort on a dirty tree, silent branch-abandon on a clean one). Fetch only.
  fetchOriginOrThrow(repoRoot, spawn);
  materializeWorkUnitBranchWithGit(repoRoot, workUnitId, spawn);
}

// ai-home-ozbjp / I-WS5 (launch boundary): a work-unit session must NEVER
// launch with the read-only `mainx` replica as its working tree. This mirrors
// the openSession materialize guard (src/session/open.ts) at the legacy
// launcher: even if cwd resolution regresses or the operator runs
// `launchFromCurrentWorkspace` from mainx, we fail loud instead of spawning an
// agent that edits/commits against the shared replica. "Never work off mainx."
export function assertLaunchCwdNotMainx(cwd: string, workUnitId: string): string {
  if (isMainxPath(cwd)) {
    throw new CliError(
      `refusing to launch a ${workUnitId} session in the read-only mainx replica ` +
        `(${cwd}) — materialize a sibling worktree first. Never work off mainx ` +
        `(ai-home-ozbjp).`,
    );
  }
  return cwd;
}

export function resolveWorkUnitLaunchCwd(
  workUnitId: string,
  cwd = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
  pathExists: (path: string) => boolean = existsSync,
  runner: GithubCommandRunner = defaultRunner,
  noVerify = false,
): string {
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
  let entries = listResolvedWorktrees(repoRoot, runner);
  let target = entries.find((entry) => entry.branch === workUnitId);

  // GH-521: when the exact branch match fails, look for an existing worktree
  // whose directory name follows the work-unit convention (`gh_<num>_*`).
  // This reuses a directory that was created for the work unit but has since
  // drifted (e.g., branch reset to main, or detached HEAD) instead of
  // materializing yet another worktree.
  if (!target) {
    target = findWorktreeByDirectoryPrefix(entries, workUnitId);
  }

  if (!target) {
    // Always skip hooks for internal reconciliation — prx session open already
    // validated the work unit. materializeWorkUnitBranch attaches the worktree
    // via `git worktree add` (creating the branch from origin/main if needed).
    materializeWorkUnitBranch(workUnitId, cwd, spawn, runner, /* noVerify */ true);
    entries = listResolvedWorktrees(repoRoot, runner);
    target = entries.find((entry) => entry.branch === workUnitId);
  }

  const rawPath = target?.path;
  if (!rawPath) {
    throw new CliError(`No worktree path found for ${workUnitId} after reconciliation`);
  }

  // ai-home-ozbjp / I-WS5: never hand back the mainx replica as a launch cwd.
  return assertLaunchCwdNotMainx(rawPath, workUnitId);
}

/** Uses default spawn, pathExists, and gh runner; only `noVerify` is non-default vs `resolveWorkUnitLaunchCwd` defaults. */
function resolveWorkUnitLaunchCwdUsingDefaults(workUnitId: string, cwd: string, noVerify: boolean): string {
  return resolveWorkUnitLaunchCwd(workUnitId, cwd, undefined, undefined, undefined, noVerify);
}

/**
 * GH-519: drop stale origin/GH-NNN remote-tracking refs before the parity
 * chain evaluates remote state.
 *
 * After a PR merges with `--delete-branch`, the remote branch is gone but
 * the local `origin/GH-NNN` ref lingers. The parity chain then sees a
 * "dirty" remote branch and demands `delete_remote_branch` against a ref
 * that's already gone, blocking `prx session open`.
 *
 * Best-effort: network errors or detached/sandbox runs should not abort
 * session open — we silently ignore fetch failures.
 */
export function pruneStaleRemoteRefs(
  cwd: string = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
): void {
  const repoRoot = resolveRepoRootWithSpawn(cwd, spawn);
  spawn("git", ["-C", repoRoot, "fetch", "--prune", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withWorktreeRuntimeLock<T>(
  worktreePath: string,
  reason: string,
  deps: Pick<CliDeps, "lockWorktree" | "unlockWorktree">,
  run: () => T,
): T {
  const acquireLock = deps.lockWorktree ?? lockWorktree;
  const releaseLock = deps.unlockWorktree ?? unlockWorktree;
  acquireLock(worktreePath, reason);

  let result!: T;
  let runError: unknown;
  try {
    result = run();
  } catch (error) {
    runError = error;
  }

  try {
    releaseLock(worktreePath);
  } catch (unlockError) {
    if (runError) {
      throw new Error(
        `${formatUnknownError(runError)} (also failed to unlock worktree ${worktreePath}: ${formatUnknownError(unlockError)})`,
      );
    }
    throw unlockError;
  }

  if (runError) {
    throw runError;
  }

  return result;
}

function maybeWithWorktreeRuntimeLock<T>(
  enabled: boolean,
  worktreePath: string,
  reason: string,
  deps: Pick<CliDeps, "lockWorktree" | "unlockWorktree">,
  run: () => T,
): T {
  if (!enabled) {
    return run();
  }
  return withWorktreeRuntimeLock(worktreePath, reason, deps, run);
}

function formatInitResult(
  result: {
    outputPath: string;
    title: string;
    summary: string;
    excludePath: string | null;
    excludeRules: string[];
    excludeUpdatedRules: string[];
    excludeRemovedRules: string[];
    prxGitignorePaths: string[];
    beadsSetup?: BeadsInitSetupResult;
    workspaceTrack?: boolean;
    workspaceConfigPath?: string | null;
    workspaceTrackPersisted?: boolean;
    trackedPrxFiles?: string[];
  },
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines = [
    `Initialized PR contract at ${result.outputPath}`,
    `title=${result.title}`,
    `summary=${result.summary}`,
  ];
  if (result.excludePath) {
    for (const rule of result.excludeRemovedRules) {
      lines.push(`Removed legacy ${rule} from ${result.excludePath}`);
    }
    for (const rule of result.excludeRules) {
      lines.push(
        result.excludeUpdatedRules.includes(rule)
          ? `Added ${rule} to ${result.excludePath}`
          : `${rule} already present in ${result.excludePath}`,
      );
    }
  }
  for (const gitignorePath of result.prxGitignorePaths) {
    lines.push(`Ensured ${gitignorePath}`);
  }
  if (result.workspaceTrackPersisted && result.workspaceConfigPath) {
    lines.push(`Persisted [workspace] track = false in ${result.workspaceConfigPath}`);
  }
  if (result.workspaceTrack === false && result.trackedPrxFiles && result.trackedPrxFiles.length > 0) {
    lines.push(
      "Detected tracked .prx/ files. To complete the transition, run:",
      "    git rm -r --cached .prx/",
      "    git commit -m \"chore(prx): stop tracking .prx/ after --untracked opt-in\"",
    );
  }
  if (result.beadsSetup?.status === "initialized") {
    lines.push(
      `Initialized beads for ${result.beadsSetup.canonicalRepoId} (database=${result.beadsSetup.database}, prefix=${result.beadsSetup.prefix}, github=${result.beadsSetup.githubRepository})`,
    );
  } else if (result.beadsSetup?.status === "forced") {
    lines.push(
      `Forced beads to ${result.beadsSetup.canonicalRepoId} (database=${result.beadsSetup.database}, prefix=${result.beadsSetup.prefix}, github=${result.beadsSetup.githubRepository})`,
    );
  } else if (result.beadsSetup?.status === "unchanged") {
    lines.push(
      `Beads already matched ${result.beadsSetup.canonicalRepoId} (database=${result.beadsSetup.database}, github=${result.beadsSetup.githubRepository})`,
    );
  } else if (result.beadsSetup?.status === "skipped") {
    lines.push(`Skipped beads setup: ${result.beadsSetup.reason}`);
  }
  return lines.join("\n");
}

function copyToClipboard(text: string): void {
  let status: number | null = null;
  try {
    status = procRunner(["/usr/bin/pbcopy"], { input: text, check: false }).status;
  } catch {
    // procRunner throws if pbcopy can't be spawned (e.g. not macOS); the
    // prior raw spawn surfaced that as a null status, which fails the check.
    status = null;
  }
  if (status !== 0) {
    throw new Error("Failed to copy machine output to clipboard.");
  }
}

function openAfterEnter(url: string): void {
  const promptStatus = runInheritStatus(["/bin/zsh", "-lc", 'printf "Machine copied. Press Enter to open Stately..."; read -r _']);
  if (promptStatus !== 0) {
    throw new Error("Interactive prompt cancelled.");
  }
  if (runInheritStatus(["/usr/bin/open", url]) !== 0) {
    throw new Error(`Failed to open ${url}`);
  }
}

function openUrl(url: string): void {
  if (runInheritStatus(["/usr/bin/open", url]) !== 0) {
    throw new Error(`Failed to open ${url}`);
  }
}

function isJsonGraphFormat(
  format:
    | "plain"
    | "json"
    | "xstate-json"
    | "xstate-ts"
    | "xstate-mermaid"
    | "mermaid"
    | "xstate-system-json"
    | "xstate-system-ts"
    | "xstate-system-mermaid"
    | "system-mermaid",
): boolean {
  return format === "json" || format === "xstate-json" || format === "xstate-system-json";
}

function formatUpdateResult(
  result: { exitCode: number; lines: string[] },
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return result.lines.join("\n");
}

function formatSkillCatalog(
  contractPath: string,
  format: "plain" | "json",
): string {
  const currentState =
    existsSync(contractPath) ? deriveInfo(loadContract(contractPath)).state : null;
  const allowed = currentState ? new Set(allowedTransitions(currentState)) : null;
  const skills = prSkillNames.map((skill) => {
    const definition = eventForSkill(skill);
    return {
      skill,
      event: definition.event,
      kind: definition.kind,
      to: definition.kind === "transition" ? definition.to : null,
      allowedFromCurrent:
        definition.kind === "transition" && allowed
          ? allowed.has(definition.to)
          : null,
    };
  });

  if (format === "json") {
    return JSON.stringify(
      {
        contractPath,
        currentState,
        skills,
      },
      null,
      2,
    );
  }

  const lines = [
    "pr skill catalog",
    currentState ? `current state: ${currentState}` : "current state: unknown (contract missing)",
    "",
  ];

  for (const item of skills) {
    if (item.kind === "transition") {
      const allowedText =
        item.allowedFromCurrent === null ? "allowed=unknown" : `allowed=${item.allowedFromCurrent ? "yes" : "no"}`;
      lines.push(
        `${item.skill} -> ${item.event} -> ${item.to} (${allowedText})`,
      );
    } else {
      lines.push(`${item.skill} -> ${item.event} (observe)`);
    }
  }

  return lines.join("\n");
}

function formatOverview(overview: OverviewResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(overview, null, 2);
  }

  const truncate = (value: string, max = 56): string =>
    value.length > max ? `${value.slice(0, max - 3)}...` : value;

  const checksLabel = (checks: OverviewResult["createdByYou"][number]["checks"]): string => {
    if (checks === "green") return "✓ Checks passing";
    if (checks === "pending") return "- Checks pending";
    if (checks === "red") return "× All checks failing";
    return "? Checks unknown";
  };

  const reviewLabel = (
    review: OverviewResult["createdByYou"][number]["review"],
    approvals: number,
  ): string => {
    if (review === "approved") return `✓ ${approvals > 0 ? approvals : 1} Approved`;
    if (review === "changes_requested") return "X Changes requested";
    if (review === "review_required") return "Review required";
    if (review === "commented") return "Commented";
    return "Review unknown";
  };

  const lines = [`Relevant pull requests in ${overview.repo}`, "", "Current branch"];

  const detailSuffix = (row: OverviewResult["createdByYou"][number]): string => {
    const parts: string[] = [];
    if (row.mergeable === "conflicting") {
      parts.push("merge conflicts");
    } else if (row.mergeable === "mergeable") {
      parts.push("mergeable");
    }
    if (row.worktree) {
      if (row.worktree.clean) {
        parts.push("wt clean");
      } else {
        parts.push(
          `wt dirty s=${row.worktree.staged} u=${row.worktree.unstaged} ?=${row.worktree.untracked} c=${row.worktree.conflicts}`,
        );
      }
    }
    if (row.diff) {
      parts.push(`diff ${row.diff.files}f +${row.diff.additions}/-${row.diff.deletions}`);
    }
    if (row.local) {
      parts.push(`local ${row.local.lifecycle} (${row.local.mode})`);
    } else {
      parts.push("local none");
    }
    return parts.join(" | ");
  };

  if (overview.currentBranch) {
    const row = overview.currentBranch;
    lines.push(`  #${row.number}  ${truncate(row.title)} [${row.branch}]`);
    lines.push(`  ${checksLabel(row.checks)} - ${reviewLabel(row.review, row.approvals)} | ${detailSuffix(row)}`);
  } else {
    lines.push("  no PR associated with the current branch");
  }

  lines.push("", "Created by you");
  if (overview.createdByYou.length === 0) {
    lines.push("  none");
  } else {
    for (const row of overview.createdByYou) {
      lines.push(`  #${row.number}  ${truncate(row.title)} [${row.branch}]`);
      lines.push(`  ${checksLabel(row.checks)} - ${reviewLabel(row.review, row.approvals)} | ${detailSuffix(row)}`);
    }
  }

  return lines.join("\n");
}

// GH-1701: pick the best fs cwd to read a repo's `.beads/` and origin from.
// Prefers an attached worktree (where per-project `.beads/` lives after
// hydrate); falls back to the bare commonDir, which classifies as `none` or
// `ambiguous` if no worktree has been hydrated yet.
function repoAuditInspectionCwd(repo: LocalRepo): string {
  if (repo.worktrees.length > 0) {
    return repo.worktrees[0]!.path;
  }
  return repo.mainWorktree ?? repo.commonDir;
}

// GH-1701: `git --git-dir=<commonDir> remote get-url origin`. Returns null
// when origin is unset, the spawn fails, or output is empty. Read-only.
function readRepoOriginUrl(repo: LocalRepo): string | null {
  let result;
  try {
    result = procRunner(
      ["git", `--git-dir=${repo.commonDir}`, "remote", "get-url", "origin"],
      { check: false },
    );
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  return url && url.length > 0 ? url : null;
}

// GH-1701: count issues via `bd list --all --json --limit 0`. Honors I-RA2 —
// never invokes `bd sql`. Returns null on probe failure or unparseable JSON.
function countRepoBeadsIssues(repo: LocalRepo): number | null {
  const cwd = repoAuditInspectionCwd(repo);
  const result = execBd({
    subcommand: "list",
    args: ["--all", "--json", "--limit", "0"],
    cwd,
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function formatRepos(inventory: RepoInventory, format: "plain" | "json", localOnly = false): string {
  if (format === "json") {
    return JSON.stringify(inventory, null, 2);
  }

  const lines = [
    localOnly ? "Local-only branches" : "Local repos",
    localOnly ? "===================" : "===========",
    "",
  ];
  if (inventory.bareRoot) {
    lines.push(`Configured bare root: ${inventory.bareRoot}`);
  }
  if (inventory.indexPath) {
    lines.push(`Index: ${inventory.indexPath}`);
  }
  if (inventory.bareRoot || inventory.indexPath) {
    lines.push("");
  }
  if (inventory.repos.length === 0) {
    lines.push(localOnly ? "No local-only branches detected." : "No local repos discovered.");
    return lines.join("\n");
  }

  for (const repo of inventory.repos) {
    lines.push(`${repo.name} (${repo.kind})`);
    lines.push(`  common: ${repo.commonDir}`);
    lines.push(`  main: ${repo.mainWorktree ?? "none"}`);
    if (repo.primaryRemote) {
      lines.push(
        `  remote: ${repo.primaryRemote.name} ${repo.primaryRemote.githubRepo ?? repo.primaryRemote.url}`,
      );
    }
    if (repo.upstreamRemote) {
      lines.push(
        `  upstream: ${repo.upstreamRemote.name} ${repo.upstreamRemote.githubRepo ?? repo.upstreamRemote.url}`,
      );
    }
    lines.push(`  worktrees: ${repo.worktrees.length}`);
    for (const worktree of repo.worktrees) {
      const branch = worktree.branch ?? "detached";
      const current = worktree.current ? " current" : "";
      lines.push(`  - ${branch} @ ${worktree.path}${current}`);
    }
    const repoFindingTypes = Array.from(
      new Set(repo.findings.filter((finding) => !finding.branch).map((finding) => finding.type)),
    );
    if (repoFindingTypes.length > 0) {
      lines.push(`  findings: ${repoFindingTypes.join(", ")}`);
    }
    const orphanBranches = repo.findings
      .filter((finding) => finding.type === "orphan_branch" && finding.branch)
      .map((finding) => finding.branch as string);
    if (orphanBranches.length > 0) {
      lines.push(`  orphan-branches: ${orphanBranches.join(", ")}`);
    }
    if (repo.localOnlyBranches.length > 0) {
      lines.push(`  local-only: ${repo.localOnlyBranches.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatRepoSet<T>(
  slug: string,
  axis: "canonical" | "stale-threshold-days" | "bd-workspace-prefix" | "dolt-remote",
  delta: SetRepoAxisDelta<T>,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify({ slug, axis, previous: delta.previous, current: delta.current }, null, 2);
  }
  const prev = delta.previous === undefined ? "(unset)" : String(delta.previous);
  return `repo set: ${slug}.${axis}: ${prev} -> ${String(delta.current)}`;
}

function formatRepoAdd(result: RepoAddResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    `Added repo: ${result.parsed.owner}/${result.parsed.name} (host: ${result.parsed.host})`,
    `  bare:    ${result.barePath}`,
    `  mainx:   ${result.mainxPath}  (detached at origin/${result.defaultBranch})`,
    `  default: ${result.defaultBranch}`,
    `  fetch refspec: ${result.fetchRefspecAdded ? "set (heads + tags + notes)" : "unchanged"}`,
    `  origin/HEAD: ${result.originHeadSet ? "set (git remote set-head --auto)" : "unchanged"}`,
    `  bd workspace prefix: ${result.bdWorkspacePrefix}`,
    `  canonical: ${result.canonical}`,
  ];
  if (result.overlay) {
    if (result.overlay.written) {
      lines.push(`  overlay: wrote stub ${result.overlay.path}`);
    } else {
      lines.push(`  overlay: skipped (already exists) ${result.overlay.path}`);
    }
  }
  // GH-1680: surface the beads hydrate outcome. `clone-failed` is the only
  // status that gets a remediation hint — every other status (success or a
  // healthy skip) is informational. The hint forward-refs `prx repo refresh
  // <slug>` (PR-C, GH-1681); the slug shape matches `findRepoBySlug`'s
  // LocalRepo.name lookup so an operator can copy-paste it.
  const hydrate = result.beadsHydrate;
  if (hydrate.status === "clone-failed") {
    lines.push(`  beads: clone-failed — mirror clone failed for ${hydrate.doltRemote ?? "<unknown remote>"}`);
    lines.push(`         → run \`prx repo refresh ${result.parsed.name}\` once reachable`);
  } else if (hydrate.status === "hydrated" || hydrate.status === "already-hydrated") {
    const db = hydrate.doltDatabase ?? "<unknown db>";
    lines.push(`  beads: ${hydrate.status} — ${db}`);
  } else {
    lines.push(`  beads: ${hydrate.status} — ${hydrate.message}`);
  }
  return lines.join("\n");
}

function formatRepoAdoptResult(
  result: AdoptRepoResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const verb = result.kind === "adopted" ? "Adopted" : "Already adopted";
  const lines = [
    `${verb} repo: ${result.row.repo_id}`,
    `  bare_path:      ${result.row.bare_path}`,
    `  remote_url:     ${result.row.remote_url}`,
    `  default_branch: ${result.row.default_branch}`,
    `  adopted_at:     ${result.row.adopted_at}`,
  ];
  return lines.join("\n");
}

function formatBranchAdoptResult(
  result: AdoptBranchResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const verb = result.kind === "adopted" ? "Adopted" : "Already adopted";
  const lines = [
    `${verb} branch: ${result.row.branch_id}`,
    `  repo_id:    ${result.row.repo_id}`,
    `  name:       ${result.row.name}`,
    `  head_sha:   ${result.row.head_sha}`,
    `  purpose:    ${result.row.purpose}`,
    `  state:      ${result.row.state}`,
    `  adopted_at: ${result.row.adopted_at}`,
  ];
  return lines.join("\n");
}

function formatWorkspaceAdoptResult(
  result: AdoptWorkspaceResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const verb = result.kind === "adopted" ? "Adopted" : "Already adopted";
  const lines = [
    `${verb} workspace: ${result.row.workspace_id}`,
    `  path:       ${result.row.path}`,
    `  mode:       ${result.row.mode}`,
    `  state:      ${result.row.state}`,
    `  dirty:      ${result.row.dirty}`,
    `  adopted_at: ${result.row.adopted_at}`,
  ];
  const cascaded: string[] = [];
  if (result.chain.repo.kind === "adopted") cascaded.push("repo");
  if (result.chain.branch.kind === "adopted") cascaded.push("branch");
  if (cascaded.length > 0) {
    lines.push(`  (also adopted: ${cascaded.join(", ")})`);
  }
  return lines.join("\n");
}

function formatRepoRefresh(
  result: RepoRefreshResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const dryTag = result.dryRun ? " (dry-run)" : "";
  const lines = [`Refreshed repo: ${result.slug}${dryTag}`];
  lines.push(`  bare:    ${result.barePath}`);
  lines.push(`  mainx:   ${result.mainxPath}${result.mainxCreated ? "  (created)" : ""}`);
  if (result.refspecUpgraded) {
    const action = result.dryRun ? "would upgrade" : "upgraded";
    lines.push(`  refspec: ${action} (${result.refspecBefore.length} → ${result.refspecAfter.length} lines)`);
  } else {
    lines.push(`  refspec: unchanged (${result.refspecAfter.length} lines)`);
  }
  if (result.fetched) {
    lines.push(`  fetch:   ran (git fetch --prune origin)`);
  } else if (result.dryRun) {
    lines.push(`  fetch:   skipped (dry-run)`);
  } else {
    lines.push(`  fetch:   skipped (--no-fetch)`);
  }
  if (result.originHeadSet) {
    lines.push(`  origin/HEAD: set (git remote set-head --auto)`);
  } else if (result.dryRun) {
    lines.push(`  origin/HEAD: skipped (dry-run)`);
  } else {
    lines.push(`  origin/HEAD: skipped (--no-fetch)`);
  }
  const hydrate = result.beadsHydrate;
  if (hydrate.status === "clone-failed") {
    lines.push(`  beads:   clone-failed — mirror clone failed for ${hydrate.doltRemote ?? "<unknown remote>"}`);
  } else if (hydrate.status === "hydrated" || hydrate.status === "already-hydrated") {
    const db = hydrate.doltDatabase ?? "<unknown db>";
    lines.push(`  beads:   ${hydrate.status} — ${db}`);
  } else {
    lines.push(`  beads:   ${hydrate.status} — ${hydrate.message}`);
  }
  return lines.join("\n");
}

function formatMaterialize(result: MaterializeResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const dryTag = result.dryRun ? " (dry-run)" : "";
  const lines = [
    `repo materialize: ${result.repo}${dryTag}`,
    `  action: ${result.action}`,
    `  bare:   ${result.barePath}`,
  ];
  if (result.lastFetchedAtMs !== null) {
    lines.push(`  fetched: ${new Date(result.lastFetchedAtMs).toISOString()}`);
  }
  // GH-1752: combined stanza when the CLI handler composed
  // `refreshLocalRepo` on top of the bare leg. Shape mirrors
  // `formatRepoRefresh` so operators see the same lines whether they
  // run `repo refresh` or `repo materialize`.
  const post = result.postMaterialize;
  if (post) {
    lines.push(`  mainx:  ${post.mainxPath}${post.mainxCreated ? "  (created)" : ""}`);
    if (post.refspecUpgraded) {
      const action = result.dryRun ? "would upgrade" : "upgraded";
      lines.push(
        `  refspec: ${action} (${post.refspecBefore.length} → ${post.refspecAfter.length} lines)`,
      );
    } else {
      lines.push(`  refspec: unchanged (${post.refspecAfter.length} lines)`);
    }
    const hydrate = post.beadsHydrate;
    if (hydrate.status === "clone-failed") {
      lines.push(
        `  beads:  clone-failed — mirror clone failed for ${hydrate.doltRemote ?? "<unknown remote>"}`,
      );
    } else if (hydrate.status === "hydrated" || hydrate.status === "already-hydrated") {
      const db = hydrate.doltDatabase ?? "<unknown db>";
      lines.push(`  beads:  ${hydrate.status} — ${db}`);
    } else {
      lines.push(`  beads:  ${hydrate.status} — ${hydrate.message}`);
    }
  }
  return lines.join("\n");
}

function formatRepoNormalization(result: RepoNormalizationResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    result.apply ? "Repo normalization (apply)" : "Repo normalization (dry-run)",
    "============================",
    "",
  ];

  if (result.bareRoot) {
    lines.push(`Configured bare root: ${result.bareRoot}`);
    lines.push("");
  }

  if (result.repos.length === 0) {
    lines.push("No normalization actions planned.");
    return lines.join("\n");
  }

  for (const repo of result.repos) {
    lines.push(`${repo.name} (${repo.kind})`);
    lines.push(`  common: ${repo.commonDir}`);
    if (repo.canonicalBarePath) {
      lines.push(`  canonical-bare: ${repo.canonicalBarePath}`);
    }
    for (const action of repo.actions) {
      const detail = action.branch ?? action.path ?? "";
      const suffix = detail ? ` ${detail}` : "";
      lines.push(`  - ${action.type}${suffix}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatWorktree(summary: WorktreeStatus, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const branchName = summary.branch.detached
    ? "detached"
    : summary.branch.name ?? "unknown";
  const upstream = summary.branch.upstream ?? "none";
  const lines = [
    `branch=${branchName} sync=${summary.branch.sync} upstream=${upstream} ahead=${summary.branch.ahead} behind=${summary.branch.behind}`,
    `worktree=${summary.clean ? "clean" : "dirty"} staged=${summary.counts.staged} unstaged=${summary.counts.unstaged} untracked=${summary.counts.untracked} conflicts=${summary.counts.conflicts} ignored=${summary.counts.ignored}`,
  ];

  return lines.join("\n");
}

function formatWtStatus(summary: WtStatusResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  if (!summary.wt_available) {
    return "wt list unavailable. Install/configure wt to see multi-worktree status.";
  }

  if (summary.worktrees.length === 0) {
    return "No worktrees reported by wt.";
  }

  const lines = ["Worktrunk status", "================", ""];
  for (const item of summary.worktrees) {
    lines.push(`${item.branch} (${item.integration})`);
    lines.push(`  path: ${item.path}`);
    lines.push(
      `  sync: ${item.sync.state} (ahead=${item.sync.ahead} behind=${item.sync.behind}) | cleanliness: ${item.clean ? "clean" : `dirty [${item.dirty_flags.join(", ")}]`}`,
    );
    lines.push(
      `  structural: detached=${item.structural.detached} mismatch=${item.structural.mismatch}${item.structural.states.length ? ` states=${item.structural.states.join(",")}` : ""}`,
    );
    if (item.symbols.length) {
      lines.push(
        `  symbols: ${item.symbols.join(" ")} (${item.symbol_meanings.join(", ")})`,
      );
    }
    if (item.git) {
      lines.push(
        `  git: ${item.git.clean ? "clean" : "dirty"} staged=${item.git.counts.staged} unstaged=${item.git.counts.unstaged} untracked=${item.git.counts.untracked} conflicts=${item.git.counts.conflicts}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatRepoStatus(summary: RepoStatusResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const prLabel = summary.pr.exists
    ? `#${summary.pr.number} ${summary.pr.draft ? "draft" : "ready"} checks=${summary.pr.checks} review=${summary.pr.review} mergeable=${summary.pr.mergeable}`
    : "none";

  const lines = [
    `repo=${summary.repo_root}`,
    `operation=${summary.operation}`,
    `local=${summary.local.clean ? "clean" : "dirty"} sync=${summary.local.branch.sync} staged=${summary.local.counts.staged} unstaged=${summary.local.counts.unstaged} untracked=${summary.local.counts.untracked} conflicts=${summary.local.counts.conflicts}`,
    `remote=${summary.remote.freshness} fetch_status=${summary.remote.fetch_status} fetch_required=${summary.remote.fetch_required} updated_refs=${summary.remote.updated_refs.length} new_refs=${summary.remote.new_refs.length} deleted_refs=${summary.remote.deleted_refs.length}`,
    `worktrees=${summary.worktrees.wt_available ? summary.worktrees.worktrees.length : 0}`,
    `pr=${prLabel}`,
  ];

  return lines.join("\n");
}

function formatCloseSession(result: CloseSessionResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [`close=${result.workUnitId}`];

  if (!result.worktreePath) {
    lines.push("worktree=gone");
    lines.push("result=already-gone");
    return lines.join("\n");
  }

  lines.push(`worktree=${result.worktreePath}`);
  lines.push(`branch=${result.branch ?? "detached"}`);

  if (result.refusalReason) {
    lines.push(`refusal=${result.refusalReason}`);
    lines.push("result=refused");
    return lines.join("\n");
  }

  const prLabel = result.prNumber ? `#${result.prNumber} ${result.prState}` : result.prState;
  lines.push(`pr=${prLabel}`);
  lines.push(`issue=${result.issueState ?? "unknown"}`);
  lines.push(`remote_branch=${result.remoteBranchPresent === null ? "unknown" : result.remoteBranchPresent ? "present" : "gone"}`);
  lines.push(`mainx_reset=${result.mainxReset}`);
  lines.push(`dry_run=${result.dryRun}`);

  if (result.handoff.length > 0) {
    lines.push("handoff:");
    for (const cmd of result.handoff) {
      lines.push(`  ${cmd}`);
    }
  }

  return lines.join("\n");
}

function formatPlanCloseResult(
  result: PlanCloseResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [`plan-close=${result.workUnitId}`];
  lines.push(`reason=${result.reason}`);
  lines.push(`upstream=${result.upstream ?? "none"}`);
  lines.push(`dry_run=${result.dryRun}`);

  if (result.refusalReason) {
    lines.push(`refusal=${result.refusalReason}`);
    lines.push("result=refused");
    return lines.join("\n");
  }

  lines.push(`upstream_comment=${result.upstreamCommentPosted ? "posted" : "skipped"}`);
  lines.push(`issue=${result.dryRun ? "preview" : result.issueClosed ? "closed" : "unchanged"}`);
  // GH-2110: bd_record is the operator-facing headline — whether the linked
  // bd record was actually closed. Distinct from `reconcile` below, which
  // only reports whether the periodic reconcile tick exited cleanly.
  lines.push(`bd_record=${result.bdRecord ? result.bdRecord.outcome : "skipped"}`);
  lines.push(
    `reconcile=${
      result.bdSyncExitCode === null
        ? "skipped"
        : result.bdSyncExitCode === 0
          ? "ok"
          : `exit-${result.bdSyncExitCode}`
    }`,
  );

  if (result.handoff.length > 0) {
    lines.push("handoff:");
    for (const cmd of result.handoff) {
      lines.push(`  ${cmd}`);
    }
  }

  return lines.join("\n");
}

function formatWorktreeRemove(summary: WorktreeRemoveResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [
    `target=${summary.target}`,
    `path=${summary.path}`,
    `branch=${summary.branch ?? "detached"}`,
    `force=${summary.force}`,
    `prune=${summary.prune}`,
    `delete_branch=${summary.deleteBranch}`,
    `dry_run=${summary.dryRun}`,
  ];

  lines.push(summary.dryRun ? "result=dry-run" : "result=removed");
  if (summary.branchDeleted) {
    lines.push("branch_result=deleted");
  }

  return lines.join("\n");
}

function formatRemoteCiCheck(summary: RemoteCiCheckResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [
    `remote ci check`,
    `repo=${summary.repoPath} pr=${summary.pr}`,
  ];

  if (summary.failingChecks.length === 0) {
    lines.push("no failing checks");
    return lines.join("\n");
  }

  for (const check of summary.failingChecks) {
    lines.push("");
    lines.push(`- ${check.name} [${check.state}]`);
    if (check.description) lines.push(`  description: ${check.description}`);
    if (check.link) lines.push(`  link: ${check.link}`);
    if (check.codebuild) {
      lines.push(`  codebuild: ${check.codebuild.buildId}`);
      if (check.codebuild.reportArn) {
        lines.push(`  report: ${check.codebuild.reportArn}`);
      }
      if (check.codebuild.error) {
        lines.push(`  error: ${check.codebuild.error}`);
      } else {
        lines.push(`  failed_tests: ${check.codebuild.failures.length}`);
      }
    }
  }

  return lines.join("\n");
}

function formatScoutLogs(result: ScoutLogsResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    `scout logs for pr=${result.pr}`,
    `failing_checks=${result.checks.length}`,
  ];

  if (result.checks.length === 0) {
    lines.push("no failing checks — CI is clean");
    return lines.join("\n");
  }

  for (const check of result.checks) {
    lines.push("");
    lines.push(`=== ${check.name} [${check.state}] ===`);
    if (check.link) lines.push(`link: ${check.link}`);
    if (check.runId) lines.push(`run_id: ${check.runId}`);
    if (check.error) {
      lines.push(`error: ${check.error}`);
    }
    if (check.logs) {
      lines.push("--- log output ---");
      lines.push(check.logs);
      lines.push("--- end ---");
    }
  }

  return lines.join("\n");
}

function defaultPrCommentsOutputPath(repoPath: string): string {
  return join(repoPath, ".pr", "local", "review-comments.json");
}

function formatPrComments(summary: PrCommentsResult, format: "plain" | "json", savedTo?: string): string {
  if (format === "json") {
    return JSON.stringify(savedTo ? { ...summary, savedTo } : summary, null, 2);
  }

  const lines = [
    `pr comments for #${summary.pr.number} ${summary.pr.title}`,
    `url=${summary.pr.url}`,
    `draft=${summary.pr.isDraft} reviewDecision=${summary.pr.reviewDecision ?? "none"} mergeState=${summary.pr.mergeStateStatus ?? "unknown"} mergeable=${summary.pr.mergeable ?? "unknown"} autoMerge=${summary.pr.autoMergeEnabled}`,
    `reviews=added:${summary.reviewAdded} approved:${summary.reviewApproved} agent:${summary.agentReview} human:${summary.humanReview}`,
    `unresolved_threads=${summary.unresolvedThreads}`,
  ];
  for (const thread of summary.threads) {
    const status = thread.isResolved ? "resolved" : "unresolved";
    lines.push(`- ${status} outdated=${thread.isOutdated} path=${thread.path ?? "(none)"} id=${thread.id}`);
    for (const comment of thread.comments) {
      lines.push(`  - ${comment.authorLogin ?? "unknown"}: ${comment.body}`);
    }
  }
  if (savedTo) {
    lines.push(`saved=${savedTo}`);
  }
  return lines.join("\n");
}

function formatPrCommentsResolution(
  resolvedThreads: PrReviewThreadResolution[],
  postResolution: PrCommentsResult,
  format: "plain" | "json",
  savedTo?: string,
): string {
  if (format === "json") {
    return JSON.stringify(
      savedTo ? { resolvedThreads, postResolution, savedTo } : { resolvedThreads, postResolution },
      null,
      2,
    );
  }

  const lines = [
    `resolved_threads=${resolvedThreads.length}`,
    ...resolvedThreads.map((thread) => `- id=${thread.id} resolved=${thread.isResolved}`),
    "",
    "=== POST-RESOLUTION ===",
    formatPrComments(postResolution, "plain", savedTo),
  ];
  return lines.join("\n");
}

function formatRepoChecks(result: RepoCheckNamesResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    `check names for ${result.repo} @ ${result.branch}`,
    `sha=${result.sha}`,
  ];

  if (result.checks.length === 0) {
    lines.push("no check runs found");
    return lines.join("\n");
  }

  for (const check of result.checks) {
    lines.push(`- ${check}`);
  }

  return lines.join("\n");
}

function formatProtectMain(result: ProtectMainBranchResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const mode = result.apply ? "APPLIED" : "WOULD APPLY";
  return [
    `${mode} main protection`,
    `backend=${result.backend}`,
    `repo=${result.repo}`,
    `branch=${result.branch}`,
    `viewer=${result.viewer}`,
    `owner=${result.owner}`,
    `solo=${result.solo}`,
    ...(result.rulesetName ? [`ruleset=${result.rulesetName}`] : []),
    ...(result.rulesetId !== null ? [`ruleset_id=${result.rulesetId}`] : []),
    `approval_contributors=${result.approvalContributorCount ?? "unknown"}`,
    `enforce_admins=${result.enforceAdmins}`,
    `require_conversation_resolution=${result.requireConversationResolution}`,
    `required_approving_review_count=${result.requiredApprovingReviewCount}`,
    `require_last_push_approval=${result.requireLastPushApproval}`,
    ...(result.requiredApprovingReviewCountSuppressed ? ["required_approving_review_count_suppressed=true"] : []),
    ...(result.requireLastPushApprovalSuppressed ? ["require_last_push_approval_suppressed=true"] : []),
    `require_linear_history=${result.requireLinearHistory}`,
    `required_status_checks=${result.requiredStatusChecks.join(",") || "none"}`,
    `command=${result.command.join(" ")}`,
  ].join("\n");
}

function formatProtectMainCheck(result: ProtectMainBranchCheckResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const mode = result.matches ? "MATCH" : "DRIFT";
  return [
    `${mode} main protection`,
    `backend=${result.backend}`,
    `repo=${result.repo}`,
    `branch=${result.branch}`,
    `viewer=${result.viewer}`,
    `owner=${result.owner}`,
    `solo=${result.solo}`,
    ...(result.rulesetName ? [`ruleset=${result.rulesetName}`] : []),
    ...(result.rulesetId !== null ? [`ruleset_id=${result.rulesetId}`] : []),
    `approval_contributors=${result.approvalContributorCount ?? "unknown"}`,
    `enforce_admins=${result.enforceAdmins}`,
    `require_conversation_resolution=${result.requireConversationResolution}`,
    `required_approving_review_count=${result.requiredApprovingReviewCount}`,
    `require_last_push_approval=${result.requireLastPushApproval}`,
    ...(result.requiredApprovingReviewCountSuppressed ? ["required_approving_review_count_suppressed=true"] : []),
    ...(result.requireLastPushApprovalSuppressed ? ["require_last_push_approval_suppressed=true"] : []),
    `require_linear_history=${result.requireLinearHistory}`,
    `required_status_checks=${result.requiredStatusChecks.join(",") || "none"}`,
  ].join("\n");
}

/**
 * GH-520: result of actually executing one reconciliation action from a
 * parity chain (previously `--apply` only printed an "APPLY" header).
 */
export type ParityChainApplyResult = {
  action: SurfaceSyncAction;
  command: string;
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * GH-520: execute each surface-sync action, returning one result per action.
 * Continue-on-error: a failure in one action does not halt the remaining
 * actions — they are independent reconciliation steps and the caller decides
 * the overall exit status.
 *
 * The action is an env-agnostic intent; this executor maps it to a command via
 * `commandForSurfaceSyncAction(intent, ctx)` (github.ts implements the spec),
 * then invokes `/bin/sh -c "<command>"`. The derived command is recorded on
 * the result.
 */
export function applyParityChainActions(
  summary: SurfaceSyncResult,
  cwd: string = process.cwd(),
  spawn: SpawnLike = procSpawnLike,
  ctx: SurfaceSyncExecContext = surfaceSyncExecContext(cwd),
): ParityChainApplyResult[] {
  return summary.actions.map((action) => {
    const command = commandForSurfaceSyncAction(action, ctx);
    const result = spawn("/bin/sh", ["-c", command], {
      cwd,
      encoding: "utf8",
    });
    return {
      action,
      command,
      status: result.status ?? 1,
      stdout: (result.stdout ?? "").toString(),
      stderr: (result.stderr ?? "").toString(),
    };
  });
}

function formatParityChainApplyResults(
  results: ParityChainApplyResult[],
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify({ results }, null, 2);
  }

  if (results.length === 0) {
    return "";
  }

  const lines: string[] = ["", "Applied:"];
  for (const result of results) {
    const label = result.status === 0 ? "ok " : "err";
    const subject = result.action.type === "close_issue"
      ? `GH-${result.action.issue}`
      : result.action.branch;
    lines.push(`  [${label}] ${result.action.type} ${subject}`);
    lines.push(`    $ ${result.command}`);
    if (result.stderr.trim()) {
      for (const line of result.stderr.trim().split("\n")) {
        lines.push(`      ${line}`);
      }
    } else if (result.status !== 0 && result.stdout.trim()) {
      for (const line of result.stdout.trim().split("\n")) {
        lines.push(`      ${line}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Enumerate worktrees that should be considered for bd schema repair (GH-1152).
 * Includes the main worktree plus every linked worktree that has a `.beads`
 * directory. Skips paths without `.beads` because the probe is meaningless
 * there (no DB to repair).
 */
export function listFeatureWorktreesForRepair(repoPath: string): string[] {
  let entries: ReturnType<typeof listWorktrees>;
  try {
    entries = listWorktrees(repoPath);
  } catch {
    return [repoPath];
  }
  return entries
    .map((entry) => entry.path)
    .filter((path) => existsSync(join(path, ".beads")));
}

export type RepairBdEntry = { cwd: string; result: BdSchemaRepairResult };

export function formatRepairBdResults(
  entries: RepairBdEntry[],
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(entries, null, 2);
  }
  if (entries.length === 0) {
    return "repair-bd: no worktrees with .beads found";
  }
  return entries
    .map(({ cwd, result }) => {
      const tail = result.message ? ` — ${result.message}` : "";
      return `${cwd}: ${result.status} (${result.durationMs}ms via ${result.command})${tail}`;
    })
    .join("\n");
}

function formatChainsStatus(summary: ChainStatusResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [
    `Chains view for ${summary.repo}`,
    `remote_freshness=${summary.remote_freshness}`,
    "",
  ];

  if (summary.rows.length === 0) {
    lines.push("No work units derived (wt unavailable or no worktrees).");
    return lines.join("\n");
  }

  for (const row of summary.rows) {
    const identifier = row.ticket === null ? row.id : row.display_id;
    const pr = row.pr.exists ? `#${row.pr.number} ${row.pr.draft ? "draft" : "ready"}` : "no-pr";
    const local = row.local.clean === null
      ? "local=unknown"
      : row.local.clean
        ? "local=clean"
        : `local=dirty(s=${row.local.staged} u=${row.local.unstaged} ?=${row.local.untracked} c=${row.local.conflicts})`;
    const status = row.status
      ? ` | remote=gh_issue:${row.status.remote.gh_issue},beads_issue:${row.status.remote.beads_issue},project_item:${row.status.remote.project_item},branch:${row.status.remote.branch},pr:${row.status.remote.pr},merge_state:${row.status.remote.merge_state},ci:${row.status.remote.ci},problem:${row.status.remote.problem} | local=branch:${row.status.local.branch},worktree:${row.status.local.worktree},dir:${row.status.local.dir},problem:${row.status.local.problem}`
      : ` | ${local}`;
    const tmux = row.tmux ? ` | tmux=${row.tmux.present ? "✓" : "✗"}` : "";
    const disposition = row.disposition ? ` | disposition=${row.disposition}` : "";
    lines.push(`${identifier} | ${row.state} | ${pr}${status}${tmux}${disposition}`);
  }

  return lines.join("\n");
}

// GH-983: bd enrichment for `prx delegate next` filters that need facts
// outside the bd-ready cache (labels for --area, parent-child links for
// --epic). Performs at most one bd subprocess call per active filter;
// returns empty enrichment when no filter requires it (zero-cost on the
// hot path). Failures degrade gracefully — an empty result map means
// "no matches for that filter" and the projection falls through to the
// exit-1 hint path.
function buildDelegateEnrichment(
  repoPath: string,
  filters: {
    epic?: string | undefined;
    area?: string | undefined;
    priority?: number | undefined;
    type?: string | undefined;
    all: boolean;
  },
  result: NextWorkResult,
): DelegateNextEnrichment {
  const enrichment: { labelsByBdId?: Map<string, string[]>; epicChildBdIds?: Set<string> } = {};

  if (filters.area !== undefined) {
    const bdIds = new Set<string>();
    for (const thread of result.threads) {
      for (const c of thread.candidates) bdIds.add(c.bd_id);
    }
    const labelsByBdId = new Map<string, string[]>();
    for (const id of bdIds) {
      const labels = readBdLabels(repoPath, id);
      if (labels !== null) labelsByBdId.set(id, labels);
    }
    enrichment.labelsByBdId = labelsByBdId;
  }

  if (filters.epic !== undefined) {
    enrichment.epicChildBdIds = resolveEpicChildBdIds(repoPath, filters.epic);
  }

  return enrichment;
}

function readBdLabels(repoPath: string, bdId: string): string[] | null {
  // bd auto-discovers `.beads/*.db` from cwd; passing repoPath as the
  // child's cwd is the right surface — `bd --db` takes a .db file path,
  // not a directory.
  const raw = tryCommand(["bd", "show", bdId, "--json"], repoPath);
  if (!raw) return null;
  return parseLabelsFromBdShow(raw);
}

function parseLabelsFromBdShow(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const rec = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!rec || typeof rec !== "object") return null;
    const labels = (rec as Record<string, unknown>).labels;
    if (!Array.isArray(labels)) return [];
    return labels.filter((l): l is string => typeof l === "string");
  } catch {
    return null;
  }
}

function resolveEpicChildBdIds(repoPath: string, epic: string): Set<string> {
  const out = new Set<string>();
  // Step 1: locate the bd id whose external_ref matches the GH-N issue.
  // `bd query "external_ref contains <epic>"` does a substring match on
  // the URL — works for both `https://github.com/.../issues/N` and the
  // legacy `GH-N` token. The result set is small (≤ 1 expected).
  const queryRaw = tryCommand(
    ["bd", "query", `external_ref contains ${epic}`, "--json"],
    repoPath,
  );
  if (!queryRaw) return out;
  let queryParsed: unknown;
  try {
    queryParsed = JSON.parse(queryRaw);
  } catch {
    return out;
  }
  const rows = Array.isArray(queryParsed) ? queryParsed : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const epicBdId = (row as Record<string, unknown>).id;
    if (typeof epicBdId !== "string") continue;
    // Step 2: list children via `bd children <epic-bd-id> --json`.
    const childrenRaw = tryCommand(
      ["bd", "children", epicBdId, "--json"],
      repoPath,
    );
    if (!childrenRaw) continue;
    let childrenParsed: unknown;
    try {
      childrenParsed = JSON.parse(childrenRaw);
    } catch {
      continue;
    }
    const childRows = Array.isArray(childrenParsed) ? childrenParsed : [];
    for (const child of childRows) {
      if (!child || typeof child !== "object") continue;
      const id = (child as Record<string, unknown>).id;
      if (typeof id === "string") out.add(id);
    }
  }
  return out;
}

function formatNextWork(result: NextWorkResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  const cacheState = result.cache.stale
    ? "stale (refreshed)"
    : result.cache.refreshed
      ? "refreshed"
      : "fresh";
  lines.push(`next-work (${result.repo}) — cache=${cacheState} ttl=${result.cache.ttl_seconds}s`);
  for (const thread of result.threads) {
    if (thread.candidates.length === 0) continue;
    lines.push(`\n[${thread.kind}] (${thread.candidates.length}) — ${thread.reason}`);
    lines.push(`  recommended: ${thread.recommended_action}`);
    for (const c of thread.candidates.slice(0, 5)) {
      const ghPart = c.gh_issue !== null ? ` (GH-${c.gh_issue})` : "";
      lines.push(`  - ${c.bd_id}${ghPart} p${c.priority} ${c.issue_type} | ${c.title}`);
      if (c.command) lines.push(`      → ${c.command}`);
    }
    if (thread.candidates.length > 5) {
      lines.push(`  … +${thread.candidates.length - 5} more`);
    }
  }
  if (!lines.some((l) => l.startsWith("["))) {
    lines.push("\nAll threads empty — clean board.");
  }
  return lines.join("\n");
}

export type RefreshResult = {
  status: "up_to_date" | "refreshed" | "conflict" | "dirty_worktree" | "blocked";
  branch: string | null;
  behindBefore: number;
  behindAfter: number;
  pushed: boolean;
  conflicts: string[];
  staleReviewWarning: boolean;
};

function parseDivergence(repoPath: string): { ahead: number; behind: number } {
  const result = tryCommand(
    ["git", "-C", repoPath, "rev-list", "--left-right", "--count", "HEAD...origin/main"],
  );
  if (!result) return { ahead: 0, behind: 0 };
  const [aheadStr, behindStr] = result.split(/\s+/);
  return {
    ahead: parseInt(aheadStr ?? "0", 10) || 0,
    behind: parseInt(behindStr ?? "0", 10) || 0,
  };
}

export type AutoRebaseResult =
  | { status: "up_to_date" }
  | { status: "rebased"; behind: number }
  | { status: "conflict"; conflicts: string[] }
  | { status: "skipped"; reason: string };

export type AutoRebaseOptions = {
  skipFetch?: boolean;
  // prx-0yf: injectable stale-lock recovery probes (defaults to the real
  // lsof/fs seam). Tests pass deterministic holder/stat probes so recovery
  // doesn't depend on lsof being installed in CI.
  lockRecovery?: LockRecoveryHooks;
};

// GH-704: on session open, rebase work-unit branches onto origin/main before
// handing off to the agent. Local-only — never pushes. On conflict, leaves the
// rebase in progress so the operator can resolve inside the session.
export function autoRebaseOnSessionOpen(
  repoPath: string,
  options: AutoRebaseOptions = {},
): AutoRebaseResult {
  const branch = tryCommand(["git", "-C", repoPath, "symbolic-ref", "--short", "HEAD"]);
  if (!branch) {
    return { status: "skipped", reason: "detached HEAD" };
  }
  if (branch === "main" || branch === "master" || branch === "trunk") {
    return { status: "skipped", reason: `protected branch '${branch}'` };
  }
  const statusOutput = tryCommand(["git", "-C", repoPath, "status", "--porcelain=v1"]);
  if (statusOutput) {
    return { status: "skipped", reason: "dirty worktree" };
  }
  const rebaseHead = tryCommand(["git", "-C", repoPath, "rev-parse", "--verify", "REBASE_HEAD"]);
  const mergeHead = tryCommand(["git", "-C", repoPath, "rev-parse", "--verify", "MERGE_HEAD"]);
  const cherryPickHead = tryCommand(["git", "-C", repoPath, "rev-parse", "--verify", "CHERRY_PICK_HEAD"]);
  if (rebaseHead || mergeHead || cherryPickHead) {
    const op = rebaseHead ? "rebase" : mergeHead ? "merge" : "cherry-pick";
    return { status: "skipped", reason: `${op} already in progress` };
  }
  // Session-open already fetches via pruneStaleRemoteRefs in
  // validateWorkSessionEntry; standalone callers still need the fetch.
  if (!options.skipFetch) {
    // prx-0yf: recover a stale index.lock (crashed sibling git) + retry once,
    // instead of failing the rebase. Mirrors execGit's lock recovery.
    const fetchResult = runWithGitLockRecovery(
      () => runCommand(["git", "-C", repoPath, "fetch", "origin"]),
      options.lockRecovery,
    );
    if (fetchResult.status !== 0) {
      return { status: "skipped", reason: "git fetch failed" };
    }
  }
  const { behind } = parseDivergence(repoPath);
  if (behind === 0) {
    return { status: "up_to_date" };
  }
  const rebaseResult = runWithGitLockRecovery(
    () => runCommand(["git", "-C", repoPath, "rebase", "origin/main"]),
    options.lockRecovery,
  );
  if (rebaseResult.status !== 0) {
    // Only classify as "conflict" when git actually left unmerged paths.
    // Other non-zero exits (missing upstream, hook failures, config errors)
    // report the trimmed stderr so the conflict-resolution guidance isn't
    // rendered on non-conflict failures.
    const conflictOutput = tryCommand(["git", "-C", repoPath, "diff", "--name-only", "--diff-filter=U"]);
    const conflicts = conflictOutput ? conflictOutput.split("\n").filter(Boolean) : [];
    if (conflicts.length > 0) {
      return { status: "conflict", conflicts };
    }
    const stderr = (rebaseResult.stderr ?? "").trim();
    const detail = stderr ? stderr.split("\n")[0] : `git rebase exited with status ${rebaseResult.status}`;
    return { status: "skipped", reason: `git rebase failed: ${detail}` };
  }
  return { status: "rebased", behind };
}

// GH-1983: plan-session preflight — refuse when the launch worktree is on a
// detached HEAD. Returns null on a named branch (session may proceed) or a
// structured refusal payload that the caller renders and converts into a
// non-zero exit. autoRebaseOnSessionOpen has a similar detached-HEAD branch
// but only warns; this preflight runs before it so the warning path becomes
// unreachable from primePlanSession (the helper's branch is kept for direct
// callers and existing tests).
export type DetachedHeadRefusal = {
  status: "blocked";
  reason: "detached_head";
  launchCwd: string;
  expectedBranch: string;
  recoveryHint: string;
};

export function assertWorktreeOnNamedBranch(
  launchCwd: string,
  expectedBranch: string,
): DetachedHeadRefusal | null {
  // Bail out cleanly when the launch path is not a git work tree at all
  // (e.g. tests that hand in a bare mkdtemp dir). "Not a git repo" is a
  // distinct failure mode that downstream steps surface on their own —
  // mis-classifying it as detached HEAD would mask the real problem.
  const insideWorkTree = tryCommand(["git", "-C", launchCwd, "rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") return null;
  const branch = tryCommand(["git", "-C", launchCwd, "symbolic-ref", "--short", "HEAD"]);
  if (branch) return null;
  return {
    status: "blocked",
    reason: "detached_head",
    launchCwd,
    expectedBranch,
    recoveryHint: `git -C ${launchCwd} checkout ${expectedBranch}`,
  };
}

// GH-1056: pre-tmux setup of `prx plan session`. Lifted into a reusable helper
// so the (1) interactive `session-open-claude`, (2) prompt/codex `session`, and
// (3) standalone `plan-prime` handlers run identical validate → materialize →
// rebase → hydrate → ensure-runtime-artifacts → ensure-allowlist sequences. All
// four pre-tmux steps are individually idempotent — re-running on an already-
// primed unit re-validates and refreshes hydration without erroring.
//
// Side effects (warnings emitted via `output`) are preserved verbatim from the
// original inline blocks so behavior in the session handlers is unchanged. The
// plan-prime handler propagates the returned statuses into its status line and
// exits 1 on `clone-failed` — see executePlanPrime.
type PrimePlanSessionInput = {
  workUnitId: string;
  launchFromCurrentWorkspace?: boolean | undefined;
  create: boolean;
  noVerify: boolean;
  from?: WorkUnitSource | undefined;
  agent: ExecutionWorkAgent;
  isInteractiveClaude: boolean;
  format: "plain" | "json";
  // GH-1643: when set, primePlanSession resolves <slug> against the repo
  // inventory and force-materializes the target worktree (implies create).
  // launchCwd is then resolved against the target bare's worktree tree
  // instead of process.cwd(), so the planner session opens against that
  // repo. The OPEN_PLAN_SESSION event payload is unchanged — repo
  // resolution happens before dispatch.
  repoSlug?: string | undefined;
};

type PrimePlanSessionAllowlistStatus =
  | EnsureClaudeAllowlistResult["status"]
  | "skipped-not-interactive";

type PrimePlanSessionResult = {
  launchCwd: string;
  runtimeArtifacts: RuntimeArtifactStatus;
  hasPriorClaudeSession: boolean;
  hydrateStatus: HydrateStatus | "error";
  rebaseStatus: AutoRebaseResult["status"];
  allowlistStatus: PrimePlanSessionAllowlistStatus;
  /**
   * GH-1766: the canonical-form id used for the branch, worktree
   * directory, and parity-chain row. Identical to `input.workUnitId`
   * for `canonical=gh` repos; for `canonical=bd` repos this is the
   * normalised `BD-<8hex>` short surface form (or the bd long-id when
   * the workspace uses semantic ids that have no hex8 tail).
   */
  workUnitId: string;
};

async function primePlanSession(
  input: PrimePlanSessionInput,
  output: Output,
  deps: CliDeps,
): Promise<PrimePlanSessionResult> {
  // GH-1643: --repo retargets the priming pipeline (validate → materialize →
  // launchCwd resolution) at a different registered bare repo. Resolution
  // happens up front so every downstream call uses the same target tree;
  // --repo implies --create so the worktree is guaranteed to exist before
  // launchCwd resolves against it.
  let targetRepoCwd = process.cwd();
  let effectiveCreate = input.create;
  if (input.repoSlug) {
    const resolved = (deps.resolveTargetRepoCwd ?? resolveTargetRepoCwd)(
      { slug: input.repoSlug, cwd: process.cwd(), skipMaterialize: true },
      {
        loadRepoInventoryConfig: deps.loadRepoInventoryConfig,
        discoverLocalRepos: deps.discoverLocalRepos,
        findRepoBySlug: deps.findRepoBySlug,
        materializeBareRepo: deps.materializeBareRepo,
      },
    );
    targetRepoCwd = resolved.targetCwd;
    effectiveCreate = true;
  }

  // GH-1766: canonical=bd fork. Hydrate via `bd show --json` instead of
  // `gh issue view`, claim the bd record via `bd update --claim`, and
  // normalise the input id to the canonical `BD-<8hex>` short surface
  // form. The branch, worktree directory, and parity-chain row id all
  // key off the normalised form so cross-input-shape calls converge on a
  // single worktree per record.
  let effectiveWorkUnitId = input.workUnitId;
  let effectiveFrom: WorkUnitSource | undefined = input.from;
  const localRepo = localRepoForCwd(targetRepoCwd);
  const canonical = localRepo ? repoCanonical(localRepo) : "gh";

  if (canonical === "bd") {
    const beadsResolver = new BeadsResolver(targetRepoCwd);
    let longId: string;
    try {
      longId = beadsResolver.toBdLongId(input.workUnitId);
    } catch (error) {
      // recognizeBareWorkspaceLongId is the only remaining input shape the
      // resolver does not auto-detect (it does not consult the workspace
      // prefix). Try once more before failing.
      const bare = recognizeBareWorkspaceLongId(input.workUnitId, targetRepoCwd);
      if (bare) {
        longId = bare;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(`bd canonical hydrate failed for ${input.workUnitId}: ${message}`);
      }
    }

    // Hydrate via `bd show --json` so the operator sees the bd record's
    // status / title rather than the cryptic "GitHub issue #NaN not found"
    // that would surface if this fell through to the GH path.
    let fetched: ResolvedWorkUnit;
    try {
      fetched = await beadsResolver.fetch(input.workUnitId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`bd canonical hydrate failed for ${input.workUnitId}: ${message}`);
    }
    if (fetched.state === "closed") {
      throw new CliError(
        `Cannot open session for ${input.workUnitId}: bd record is closed. Reopen with \`bd reopen\` before retrying.`,
      );
    }

    // Normalise to `BD-<8hex>` for the branch / worktree / parity-chain row.
    // `normalizeToBdSurfaceShort` reads the trailing 8-hex tail off any of
    // the three accepted input shapes; semantic-id workspaces (no hex8 tail)
    // pass through with the bare id form, matching the parity-chain row id
    // the chain builder emits for non-GH-prefixed branches.
    const normalised = normalizeToBdSurfaceShort(input.workUnitId)
      ?? normalizeToBdSurfaceShort(longId);
    if (normalised) {
      effectiveWorkUnitId = normalised;
    } else {
      // Semantic-id workspace fallback — surface the bd long-id as-is. The
      // branch name will be the bd id; downstream materialize uses this
      // string verbatim.
      effectiveWorkUnitId = longId;
    }
    effectiveFrom = "beads";

    // Claim before materialize so a failed claim does not leave a worktree
    // staged on a record the operator does not own. `bd update --claim`
    // is policy-admitted (planner / all states) and is not on the bd
    // wrapper's BLOCKED list. Failure is treated as a warning rather than
    // a hard refusal — the operator can claim manually via `bd update`
    // and re-enter the session.
    const claim = runBdUpdateClaim(longId, targetRepoCwd);
    if (claim.exitCode !== 0) {
      const detail = (claim.stderr || claim.stdout || "").trim();
      output.error(
        `warning: bd update --claim ${longId} exited ${claim.exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }
  }

  // GH-2014: bracket each pre-claude phase in `runStep` so the operator
  // gets a start banner, a 5s heartbeat for silent windows, and a finish
  // line with elapsed ms. Hard-silent under --format=json (the JSON payload
  // on stdout must stay adjacent to clean stderr). Outside JSON mode,
  // delegate to runStep's auto-silent default — that suppresses progress
  // when stderr is not a TTY (tests, CI, piped output) unless the operator
  // opts in via PRX_PROGRESS=1.
  const progressOpts = {
    ...(input.format === "json" ? { silent: true as const } : {}),
    write: (line: string) => output.error(line.replace(/\n$/, "")),
  };
  await runStep(
    "validate-work-session",
    async () =>
      validateWorkSessionEntry(
        effectiveWorkUnitId,
        targetRepoCwd,
        effectiveCreate,
        deps.boardStatus ?? boardStatus,
        deps.buildParityChain ?? buildParityChain,
        deps.validateGitHubIssue ?? validateGitHubIssue,
        deps.pruneStaleRemoteRefs ?? pruneStaleRemoteRefs,
        effectiveFrom,
        deps.findEpicChildren ?? findEpicChildren,
        deps.wtStatus ?? wtStatus,
      ),
    progressOpts,
  );
  if (effectiveCreate) {
    await runStep(
      "materialize-worktree",
      async () => {
        if (deps.materializeWorktree) {
          deps.materializeWorktree(effectiveWorkUnitId, targetRepoCwd, input.noVerify);
        } else {
          materializeWorkUnitBranch(effectiveWorkUnitId, targetRepoCwd, undefined, undefined, input.noVerify);
        }
      },
      progressOpts,
    );
  }
  // GH-1643: --repo overrides launchFromCurrentWorkspace — the operator
  // explicitly asked for a different repo, so the launchCwd must point
  // at the target's worktree.
  const launchCwd = input.launchFromCurrentWorkspace && !input.repoSlug
    ? assertLaunchCwdNotMainx(process.cwd(), effectiveWorkUnitId)
    : deps.resolveWorkUnitCwd
      ? deps.resolveWorkUnitCwd(effectiveWorkUnitId, targetRepoCwd, input.noVerify)
      : resolveWorkUnitLaunchCwdUsingDefaults(effectiveWorkUnitId, targetRepoCwd, input.noVerify);

  // GH-1983: a detached HEAD here would anchor the plan against an unnamed
  // ref and silently skip auto-rebase. Refuse before any rebase / hydrate
  // work so the operator gets a structured hint and a non-zero exit.
  const detached = (deps.assertWorktreeOnNamedBranch ?? assertWorktreeOnNamedBranch)(
    launchCwd,
    effectiveWorkUnitId,
  );
  if (detached) {
    if (input.format === "json") {
      output.log(JSON.stringify(detached, null, 2));
    } else {
      output.error(
        `error: refusing to open plan session for ${effectiveWorkUnitId}: detached HEAD in ${launchCwd}`,
      );
      output.error(`  expected branch: ${detached.expectedBranch}`);
      output.error(`  recover with: ${detached.recoveryHint}`);
    }
    throw new CliError("detached HEAD");
  }

  const rebase = await runStep(
    "auto-rebase",
    async () => (deps.autoRebaseOnSessionOpen ?? autoRebaseOnSessionOpen)(launchCwd, { skipFetch: true }),
    progressOpts,
  );
  if (rebase.status === "rebased") {
    // Gate on format: stdout in --format=json mode would corrupt the
    // machine-readable payload emitted later by the calling handler.
    if (input.format === "json") {
      output.error(`rebased ${rebase.behind} commit${rebase.behind === 1 ? "" : "s"} onto origin/main`);
    } else {
      output.log(`rebased ${rebase.behind} commit${rebase.behind === 1 ? "" : "s"} onto origin/main`);
    }
  } else if (rebase.status === "conflict") {
    output.error("rebase onto origin/main hit conflicts — session will continue; resolve before you commit");
    output.error("conflicted files:");
    for (const f of rebase.conflicts) {
      output.error(`  ${f}`);
    }
    output.error("resolve with: git status, edit files, git add <files>, git rebase --continue  (or git rebase --abort to escape)");
  } else if (rebase.status === "skipped") {
    output.error(`warning: auto-rebase skipped (${rebase.reason})`);
  }

  let hydrateStatus: HydrateStatus | "error";
  try {
    const hydrateResult = await runStep(
      "hydrate-beads",
      async () => (deps.hydrateBeads ?? hydrateBeads)({ cwd: launchCwd }),
      progressOpts,
    );
    if (hydrateResult.status === "hydrated" || hydrateResult.status === "clone-failed") {
      output.error(hydrateResult.message);
    }
    hydrateStatus = hydrateResult.status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(`warning: beads hydration failed unexpectedly: ${message}`);
    hydrateStatus = "error";
  }

  const runtimeArtifacts = await runStep(
    "runtime-artifacts",
    async () =>
      (deps.ensureRuntimeArtifacts ?? ensureLocalRuntimeArtifacts)(
        effectiveWorkUnitId,
        launchCwd,
      ),
    progressOpts,
  );

  // GH-1147: this allowlist is the post-ratchet auto-approve list in
  // .claude/settings.local.json (Bash(prx:*) skip-prompt entry). Distinct
  // from SESSION_PROFILES.plan.allowedTools, which is the capability-layer
  // toolset enforced via --allowedTools / --disallowedTools at launch.
  let allowlistStatus: PrimePlanSessionAllowlistStatus;
  if (input.isInteractiveClaude) {
    const allowlist = await runStep(
      "claude-allowlist",
      async () => (deps.ensureClaudeAllowlist ?? ensureClaudeInteractiveAllowlist)(launchCwd),
      progressOpts,
    );
    if (allowlist.status === "skipped-malformed") {
      output.error(buildMalformedAllowlistWarning(allowlist.path));
    }
    allowlistStatus = allowlist.status;
  } else {
    allowlistStatus = "skipped-not-interactive";
  }

  const hasPriorClaudeSession = input.isInteractiveClaude
    ? (deps.findSavedClaudeSession ?? findSavedClaudeSession)(launchCwd)
    : false;

  return {
    launchCwd,
    runtimeArtifacts,
    hasPriorClaudeSession,
    hydrateStatus,
    rebaseStatus: rebase.status,
    allowlistStatus,
    workUnitId: effectiveWorkUnitId,
  };
}

function executeRefresh(
  parsed: Extract<ParsedCommand, { command: "refresh" }>,
  output: Output,
): number {
  const repoPath = parsed.repoPath;
  const format = parsed.format;

  const branch = tryCommand(["git", "-C", repoPath, "symbolic-ref", "--short", "HEAD"]);
  if (!branch) {
    const result: RefreshResult = {
      status: "blocked",
      branch: null,
      behindBefore: 0,
      behindAfter: 0,
      pushed: false,
      conflicts: [],
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error("error: not on a branch (detached HEAD or bare repo)");
    }
    return 1;
  }

  if (branch === "main" || branch === "master" || branch === "trunk") {
    const result: RefreshResult = {
      status: "blocked",
      branch,
      behindBefore: 0,
      behindAfter: 0,
      pushed: false,
      conflicts: [],
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error(`error: refusing to rebase protected branch '${branch}'`);
    }
    return 1;
  }

  // Check for clean worktree
  const statusOutput = tryCommand(["git", "-C", repoPath, "status", "--porcelain=v1"]);
  if (statusOutput) {
    const result: RefreshResult = {
      status: "dirty_worktree",
      branch,
      behindBefore: 0,
      behindAfter: 0,
      pushed: false,
      conflicts: [],
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error("error: worktree has uncommitted changes; commit or stash before refreshing");
    }
    return 1;
  }

  // Check for in-progress git operation
  const rebaseHead = tryCommand(["git", "-C", repoPath, "rev-parse", "--verify", "REBASE_HEAD"]);
  const mergeHead = tryCommand(["git", "-C", repoPath, "rev-parse", "--verify", "MERGE_HEAD"]);
  const cherryPickHead = tryCommand(["git", "-C", repoPath, "rev-parse", "--verify", "CHERRY_PICK_HEAD"]);
  if (rebaseHead || mergeHead || cherryPickHead) {
    const op = rebaseHead ? "rebase" : mergeHead ? "merge" : "cherry-pick";
    const result: RefreshResult = {
      status: "blocked",
      branch,
      behindBefore: 0,
      behindAfter: 0,
      pushed: false,
      conflicts: [],
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error(`error: ${op} already in progress; resolve it before refreshing`);
    }
    return 1;
  }

  // Fetch origin
  const fetchResult = runCommand(["git", "-C", repoPath, "fetch", "origin"]);
  if (fetchResult.status !== 0) {
    const result: RefreshResult = {
      status: "blocked",
      branch,
      behindBefore: 0,
      behindAfter: 0,
      pushed: false,
      conflicts: [],
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error("error: git fetch origin failed");
    }
    return 1;
  }

  // Check divergence from origin/main
  const { behind: behindBefore } = parseDivergence(repoPath);
  if (behindBefore === 0) {
    const result: RefreshResult = {
      status: "up_to_date",
      branch,
      behindBefore: 0,
      behindAfter: 0,
      pushed: false,
      conflicts: [],
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.log("already up to date with origin/main");
    }
    return 0;
  }

  const pr = parsed.local || parsed.noPush ? null : maybeViewCurrentPr(repoPath);
  const headSha = pr ? tryCommand(["git", "-C", repoPath, "rev-parse", "HEAD"]) : null;
  const remoteSha = pr ? tryCommand(["git", "-C", repoPath, "rev-parse", `origin/${branch}`]) : null;
  const mode = selectRefreshExecutionMode({ local: parsed.local, noPush: parsed.noPush, pr, headSha, remoteSha });
  if (mode === "local" || !pr) {
    return runLocalRefresh(parsed, output, branch, behindBefore);
  }
  return runServerRefresh(parsed, output, branch, behindBefore, pr);
}

export function selectRefreshExecutionMode(options: {
  local: boolean;
  noPush: boolean;
  pr: PrView | null | undefined;
  headSha: string | null;
  remoteSha: string | null;
}): "local" | "server" {
  if (options.local || options.noPush) return "local";
  if (!options.pr) return "local";
  if (!options.headSha || !options.remoteSha || options.headSha !== options.remoteSha) return "local";
  return "server";
}

function countPrReviews(pr: PrView): number {
  const r = pr.reviews;
  if (!r) return 0;
  if (Array.isArray(r)) return r.length;
  return Array.isArray(r.nodes) ? r.nodes.length : 0;
}

function runLocalRefresh(
  parsed: Extract<ParsedCommand, { command: "refresh" }>,
  output: Output,
  branch: string,
  behindBefore: number,
): number {
  const repoPath = parsed.repoPath;
  const format = parsed.format;

  // Rebase onto origin/main
  const rebaseResult = runWithGitLockRecovery(() =>
    runCommand(["git", "-C", repoPath, "rebase", "origin/main"]),
  );
  if (rebaseResult.status !== 0) {
    // Capture conflicted files before aborting
    const conflictOutput = tryCommand(["git", "-C", repoPath, "diff", "--name-only", "--diff-filter=U"]);
    const conflicts = conflictOutput ? conflictOutput.split("\n").filter(Boolean) : [];
    runCommand(["git", "-C", repoPath, "rebase", "--abort"]);
    const result: RefreshResult = {
      status: "conflict",
      branch,
      behindBefore,
      behindAfter: behindBefore,
      pushed: false,
      conflicts,
      staleReviewWarning: false,
    };
    if (format === "json") {
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error(`error: rebase onto origin/main failed with conflicts`);
      if (conflicts.length > 0) {
        output.error("conflicted files:");
        for (const f of conflicts) {
          output.error(`  ${f}`);
        }
      }
      output.error("resolve manually: git rebase origin/main, fix conflicts, git rebase --continue");
    }
    return 1;
  }

  // Rebase succeeded
  const { behind: behindAfter } = parseDivergence(repoPath);

  // Check for stale review warning (PR with reviews)
  let staleReviewWarning = false;
  const prCheck = tryCommand(
    ["gh", "pr", "view", "--json", "reviews,number", "--jq", ".reviews | length"],
    repoPath,
  );
  if (prCheck && parseInt(prCheck, 10) > 0) {
    staleReviewWarning = true;
  }

  // Push unless --no-push
  let pushed = false;
  if (!parsed.noPush) {
    const pushResult = runCommand(["git", "-C", repoPath, "push", "--force-with-lease", "origin", branch]);
    pushed = pushResult.status === 0;
    if (!pushed) {
      const result: RefreshResult = {
        status: "refreshed",
        branch,
        behindBefore,
        behindAfter,
        pushed: false,
        conflicts: [],
        staleReviewWarning,
      };
      if (format === "json") {
        output.log(JSON.stringify(result, null, 2));
      } else {
        output.error("error: push --force-with-lease failed; run manually");
      }
      return 1;
    }
  }

  const result: RefreshResult = {
    status: "refreshed",
    branch,
    behindBefore,
    behindAfter,
    pushed,
    conflicts: [],
    staleReviewWarning,
  };
  if (format === "json") {
    output.log(JSON.stringify(result, null, 2));
  } else {
    output.log(`refreshed: rebased ${behindBefore} commit${behindBefore === 1 ? "" : "s"} from origin/main`);
    if (pushed) {
      output.log(`pushed ${branch} to origin (force-with-lease)`);
    }
    if (pushed && staleReviewWarning) {
      output.error("warning: existing PR reviews may be dismissed depending on branch protection settings (e.g., dismiss_stale_reviews)");
    }
  }
  return 0;
}

function makeBlockedRefreshResult(branch: string, behindBefore: number): RefreshResult {
  return { status: "blocked", branch, behindBefore, behindAfter: behindBefore, pushed: false, conflicts: [], staleReviewWarning: false };
}

function emitRefreshFailure(result: RefreshResult, format: string, output: Output, errors: string[]): number {
  if (format === "json") {
    output.log(JSON.stringify(result, null, 2));
  } else {
    for (const e of errors) output.error(e);
  }
  return 1;
}

function runServerRefresh(
  parsed: Extract<ParsedCommand, { command: "refresh" }>,
  output: Output,
  branch: string,
  behindBefore: number,
  pr: PrView,
): number {
  const repoPath = parsed.repoPath;
  const format = parsed.format;

  const ub = runCommand(
    ["gh", "pr", "update-branch", String(pr.number), "--rebase"],
    repoPath,
  );
  if (ub.status !== 0) {
    const stderr = (ub.stderr || ub.stdout || "").trim();
    const isConflict = /conflict/i.test(stderr);
    const result: RefreshResult = isConflict
      ? { status: "conflict", branch, behindBefore, behindAfter: behindBefore, pushed: false, conflicts: [], staleReviewWarning: false }
      : makeBlockedRefreshResult(branch, behindBefore);
    return emitRefreshFailure(result, format, output, [
      "error: server-side rebase via `gh pr update-branch` failed",
      ...(stderr ? [stderr] : []),
      "hint: rerun with `prx worktree refresh --local` to rebase locally and see file-level conflicts",
    ]);
  }

  const fetch = runCommand(["git", "-C", repoPath, "fetch", "origin", branch]);
  if (fetch.status !== 0) {
    const stderr = (fetch.stderr || "").trim();
    return emitRefreshFailure(makeBlockedRefreshResult(branch, behindBefore), format, output, [
      `error: git fetch origin ${branch} failed after server-side rebase`,
      ...(stderr ? [stderr] : []),
    ]);
  }

  const reset = runCommand(["git", "-C", repoPath, "reset", "--hard", `origin/${branch}`]);
  if (reset.status !== 0) {
    const stderr = (reset.stderr || "").trim();
    return emitRefreshFailure(makeBlockedRefreshResult(branch, behindBefore), format, output, [
      `error: git reset --hard origin/${branch} failed`,
      ...(stderr ? [stderr] : []),
    ]);
  }

  const fetchMain = runCommand(["git", "-C", repoPath, "fetch", "origin", "main"]);
  if (fetchMain.status !== 0) {
    const stderr = (fetchMain.stderr || "").trim();
    return emitRefreshFailure(makeBlockedRefreshResult(branch, behindBefore), format, output, [
      "error: git fetch origin main failed before recomputing divergence",
      ...(stderr ? [stderr] : []),
    ]);
  }

  const { behind: behindAfter } = parseDivergence(repoPath);
  const staleReviewWarning = countPrReviews(pr) > 0;

  const result: RefreshResult = {
    status: "refreshed",
    branch,
    behindBefore,
    behindAfter,
    pushed: true,
    conflicts: [],
    staleReviewWarning,
  };
  if (format === "json") {
    output.log(JSON.stringify(result, null, 2));
  } else {
    output.log(`refreshed (server-side): rebased ${behindBefore} commit${behindBefore === 1 ? "" : "s"} from origin/main via \`gh pr update-branch\``);
    output.log(`pushed ${branch} to origin (server-side)`);
    if (staleReviewWarning) {
      output.error("warning: existing PR reviews may be dismissed depending on branch protection settings (e.g., dismiss_stale_reviews)");
    }
  }
  return 0;
}

function formatActionPlan(
  plan: ActionPlan,
  mode: "actions" | "next-action",
  format: "plain" | "json",
): string {
  if (format === "json") {
    if (mode === "next-action") {
      return JSON.stringify(
        {
          snapshot: plan.snapshot,
          next: plan.next,
        },
        null,
        2,
      );
    }
    return JSON.stringify(plan, null, 2);
  }

  if (mode === "next-action") {
    if (!plan.next) {
      return "No action available.";
    }
    return [
      "Suggested next step: derived from the XState workflow model plus local repo signals",
      `${plan.next.id} (${plan.next.surface})`,
      plan.next.label,
      `reason=${plan.next.reason}`,
      `run=${plan.next.command}`,
    ].join("\n");
  }

  const lines = [
    `Workflow phase: ${plan.snapshot.phase} (XState-derived)`,
    `Invariants: ${plan.snapshot.invariants.valid ? "valid" : "invalid"} findings=${plan.snapshot.invariants.findings.length}`,
    `Current state: lifecycle=${plan.snapshot.system.lifecycle} review=${plan.snapshot.system.review} ci=${plan.snapshot.system.ci} mergeability=${plan.snapshot.system.mergeability}`,
    `remote=${plan.snapshot.remoteFreshness} operation=${plan.snapshot.operation} contract=${plan.snapshot.contractExists ? "present" : "missing"}`,
    "",
    "Derived actions (enabled and disabled, from the XState workflow model plus local repo signals):",
  ];

  for (const action of plan.actions) {
    lines.push(`  ${action.id} [${action.enabled ? "enabled" : "disabled"}] (${action.surface}) -> ${action.command}`);
    if (action.reason) {
      lines.push(`    reason: ${action.reason}`);
    }
    if (!action.enabled && action.disabledReason) {
      lines.push(`    blocked: ${action.disabledReason}`);
    }
  }

  return lines.join("\n");
}

function formatActionExecutionResult(
  action: ResolvedAction,
  format: "plain" | "json",
  result: { status: "executed" | "blocked" | "unsupported"; message: string },
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        action,
        result,
      },
      null,
      2,
    );
  }
  return [
    `${action.id}: ${result.status}`,
    action.label,
    result.message,
  ].join("\n");
}

function withRepoPath<T>(repoPath: string, fn: () => T | Promise<T>): T | Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(repoPath);
  const restore = () => process.chdir(previousCwd);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function skillForActionId(actionId: string): PrSkillName | null {
  switch (actionId) {
    case "pr.fix_changes":
      return "pr-fix";
    case "pr.validate":
      return "pr-validate";
    case "pr.request_review":
      return "pr-ready";
    case "pr.next":
      return "pr-next";
    default:
      return null;
  }
}

function formatPhase(plan: ActionPlan, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(
      {
        phase: plan.snapshot.phase,
        snapshot: plan.snapshot,
        next: plan.next,
      },
      null,
      2,
    );
  }
  return plan.snapshot.phase;
}

function formatSnapshot(state: DomainStateV1, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(state, null, 2);
  }

  const lines = [
    `phase=${state.workflowState.phase}`,
    `merge_ready=${state.prState.mergeReady}`,
    `invariants=${state.invariants.valid ? "valid" : "invalid"}`,
    `unresolved_threads=${state.reviewState.unresolvedThreads}`,
  ];
  if (state.invariants.findings.length > 0) {
    lines.push("findings:");
    for (const finding of state.invariants.findings) {
      lines.push(`  - [${finding.severity}] ${finding.id}: ${finding.message}`);
    }
  }
  return lines.join("\n");
}

function formatStatusLine(plan: ActionPlan, format: "plain" | "json"): string {
  const unit = plan.snapshot.currentUnit?.ticket ?? plan.snapshot.branch ?? basename(plan.snapshot.repoRoot);
  const prLabel = plan.snapshot.pr.exists
    ? `#${plan.snapshot.pr.number}${plan.snapshot.pr.draft ? " draft" : ""}`
    : "none";
  const wtLabel = plan.snapshot.local.staged === 0 &&
      plan.snapshot.local.unstaged === 0 &&
      plan.snapshot.local.untracked === 0 &&
      plan.snapshot.local.conflicts === 0
    ? "clean"
    : `s${plan.snapshot.local.staged}/u${plan.snapshot.local.unstaged}/?${plan.snapshot.local.untracked}/c${plan.snapshot.local.conflicts}`;
  // GH-1172: surface the active session mode so tmux status-right and
  // operator inspection answer "am I in plan or implement?" without
  // resorting to listing tmux session names.
  const mode = getCurrentSessionContext();
  const payload = {
    unit,
    mode,
    phase: plan.snapshot.phase,
    pr: prLabel,
    ci: plan.snapshot.pr.checks,
    review: plan.snapshot.pr.review,
    unresolvedThreads: plan.snapshot.rawState.signals.review.unresolvedThreads,
    mergeability: plan.snapshot.pr.mergeable,
    worktree: wtLabel,
    contract: plan.snapshot.contractExists,
    next: plan.next?.id ?? "none",
  };

  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }

  return [
    unit,
    `mode=${payload.mode}`,
    `phase=${payload.phase}`,
    `pr=${payload.pr}`,
    `ci=${payload.ci}`,
    `review=${payload.review}`,
    `threads=${payload.unresolvedThreads}`,
    `merge=${payload.mergeability}`,
    `wt=${payload.worktree}`,
    `contract=${payload.contract ? "yes" : "no"}`,
    `next=${payload.next}`,
  ].join(" | ");
}

function formatActors(scope: ActorScope, format: "plain" | "json"): string {
  const actors = actorsForScope(scope);
  if (format === "json") {
    return JSON.stringify(
      {
        scope,
        actors,
      },
      null,
      2,
    );
  }

  const lines = [`Tool actors (${scope})`, "==================", ""];
  for (const actor of actors) {
    lines.push(`${actor.actor} (${actor.kind})`);
    lines.push(`  tier: ${actor.tier}`);
    lines.push(`  emits: ${actor.emits.join(", ") || "none"}`);
    lines.push(`  accepts: ${actor.accepts.join(", ") || "none"}`);
    if (actor.implementations && actor.implementations.length > 0) {
      lines.push(`  implementations: ${actor.implementations.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatModel(scope: ActorScope, format: "plain" | "json"): string {
  const actors = actorsForScope(scope);
  const eventOwners = eventOwnersForScope(scope);
  const rawFieldOwners = rawFieldOwnersForScope(scope);

  if (format === "json") {
    return JSON.stringify(
      {
        scope,
        architecture: "actors -> owned raw facts -> invariants -> derived phase",
        actors,
        rawFieldOwners,
        eventOwners,
        canonicalEventAliases: canonicalPrEventAliases,
        derived: {
          phaseOrder: phasePrecedence,
        },
        invariants: invariantSpecs,
        roleLifecycle: scope === "workflow" ? taskRoleMachine.config : undefined,
        workflowBackbone: scope === "workflow" ? workflowMachine.config : undefined,
        // GH-1603: per-run fetch lifecycle (idle → projecting → fetching →
        // writing → advancing → completed | failed_mid_fetch).
        fetchLifecycle: scope === "workflow" ? fetchMachine.config : undefined,
      },
      null,
      2,
    );
  }

  const lines = [
    `Model (${scope})`,
    "==============",
    "",
    "Architecture",
    "  actors -> owned raw facts -> invariants -> derived phase",
    ...(scope === "workflow"
      ? [
          "",
          "Workflow backbone (documentary; parity + raw snapshots are authoritative)",
          "  parallel region `workflowBackbone` on prSystem + standalone `workflowMachine` config in JSON",
          "",
          "Role lifecycle",
          "  planning -> executing -> testing -> reviewing -> done|blocked",
          "",
          "Fetch lifecycle (GH-1603)",
          "  idle -> projecting -> fetching -> writing -> advancing -> completed | failed_mid_fetch",
        ]
      : []),
    "",
    "Actors",
  ];
  for (const actor of actors) {
    lines.push(`  ${actor.actor} (${actor.tier}/${actor.kind})`);
  }
  lines.push("", "Phase precedence");
  for (const phase of phasePrecedence) {
    lines.push(`  ${phase}`);
  }
  lines.push("", "Invariants");
  for (const invariant of invariantSpecs) {
    lines.push(`  ${invariant}`);
  }
  return lines.join("\n");
}

function isoDate(offsetDays = 0): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function loadSprintState(path: string): SprintStateV1 {
  return sprintStateV1Schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function writeSprintState(path: string, state: SprintStateV1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function mapPrChecks(pr: PrView): SprintPrSnapshot["checks"] {
  const rollup = pr.statusCheckRollup;
  if (rollup && !Array.isArray(rollup) && typeof rollup === "object" && "state" in rollup) {
    const state = (rollup.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "green";
    if (state === "FAILURE" || state === "ERROR" || state === "TIMED_OUT" || state === "CANCELLED") return "red";
    if (state === "PENDING" || state === "IN_PROGRESS" || state === "QUEUED") return "pending";
  }
  return "unknown";
}

function mapPrReview(pr: PrView): SprintPrSnapshot["review"] {
  const decision = (pr.reviewDecision ?? "").toLowerCase();
  if (decision === "approved") return "approved";
  if (decision === "changes_requested") return "changes_requested";
  if (decision === "review_required") return "review_required";
  if (decision === "commented") return "commented";
  return "unknown";
}

function mapPrMergeable(pr: PrView): SprintPrSnapshot["mergeable"] {
  const mergeable = (pr.mergeable ?? "").toLowerCase();
  if (mergeable === "mergeable") return "mergeable";
  if (mergeable === "conflicting") return "conflicting";
  return "unknown";
}

function mapPrState(pr: PrView): SprintPrSnapshot["state"] {
  const state = (pr.state ?? "").toLowerCase();
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  if (state === "open") return "open";
  return "open";
}

function collectSprintPrSnapshots(
  repoPath: string,
  prNumbers: number[],
  view: typeof viewPr,
): SprintPrSnapshot[] {
  const rows: SprintPrSnapshot[] = [];
  for (const number of prNumbers) {
    try {
      const pr = view(repoPath, String(number));
      rows.push({
        number,
        state: mapPrState(pr),
        draft: pr.isDraft,
        checks: mapPrChecks(pr),
        review: mapPrReview(pr),
        mergeable: mapPrMergeable(pr),
      });
    } catch {
      rows.push({
        number,
        state: "none",
        draft: false,
        checks: "unknown",
        review: "unknown",
        mergeable: "unknown",
      });
    }
  }
  return rows;
}

function formatSprintState(state: SprintStateV1, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(state, null, 2);
  }
  return [
    `sprint=${state.sprintId}`,
    `status=${state.derived.sprintStatus}`,
    `outcome=${state.derived.outcomeStatus}`,
    `progress=${state.derived.executionProgress.merged}/${state.derived.executionProgress.total}`,
    `metric=${state.goal.metricName} baseline=${state.metric.baseline ?? "null"} current=${state.metric.current ?? "null"} target_delta=${state.goal.targetDelta}`,
  ].join(" ");
}

function formatSprintSyncResult(
  payload: { apply: boolean; statePath: string; sprintId: string; notion: Record<string, unknown> },
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }
  const action = payload.apply ? "SYNCED" : "WOULD SYNC";
  return `${action} SprintX -> Notion projection for ${payload.sprintId} (${payload.statePath})`;
}

// GH-1173: stdin/stdout binary IO defaults for the plan-store verbs. Pulled
// out so tests can inject in-memory replacements via CliDeps.
function readStdinSyncDefault(): Buffer {
  return readFileSync(0);
}

function writeStdoutBinaryDefault(buf: Buffer): void {
  process.stdout.write(buf);
}

// GH-1239: auto-step preflight wrapper used by the `session` and
// `session-open-claude` plan-session handlers. Returns:
//   - null on pass — caller continues with session entry
//   - an exit code (1 on refusal, 2 on preflight error) on non-pass — caller
//     returns this directly without entering the session
//
// Output is a stderr block prefixed by `plan-session preflight refused`,
// followed by the same plain-format renderer the standalone verb uses, so
// operators see one consistent shape across the verb and the auto-step.
async function runPreflightAutoStepRefusal(
  workUnitId: string,
  deps: CliDeps,
  output: Output,
): Promise<number | null> {
  try {
    const handler = deps.runPlanPreflight ?? runPlanPreflight;
    const result = await handler({ unit: workUnitId });
    if (result.status === "pass") return null;
    output.error(
      `plan-session preflight refused for ${workUnitId} (status=${result.status}); pass --skip-preflight to override`,
    );
    output.error(formatPreflightPlain(result));
    return 1;
  } catch (error) {
    output.error(
      `plan-session preflight: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

// GH-1274 (PR-2 of GH-1261): `prx dep research <dep> [--dry-run]` runtime.
//
// Both forms route through the same fetch → buildSnapshot → writeSnapshot
// pipeline; only the destination directory differs. The `--dry-run` form
// writes to a private mktemp dir and unlinks it on exit so invariant I-DR4
// (no on-disk writes outside tmp) holds even if `writeSnapshot` materializes
// a `<runId>/` subdir there. The bare form writes atomically under
// `<repoRoot>/.prx/dep-research/<dep>/<run_id>/`.
async function runDepResearch(
  parsed: { command: "dep-research"; dep: string; dryRun: boolean },
  output: Output,
  deps: CliDeps,
): Promise<number> {
  const repoRoot = process.cwd();
  let entries;
  try {
    entries = loadDepManifest(repoRoot);
  } catch (err) {
    if (err instanceof DepManifestError) {
      output.error(`dep manifest ${err.code}: ${err.message}`);
      return err.code === "NOT_FOUND" ? 66 : 65;
    }
    return handleRunCliError(err, output);
  }
  const entry = entries.find((e) => e.name === parsed.dep);
  if (!entry) {
    const available = entries.map((e) => e.name).join(", ");
    output.error(
      `dep research: unknown dep '${parsed.dep}'. Available: ${available}`,
    );
    return 66;
  }

  const fetcher = deps.depResearchFetcher ?? defaultFetchSource();
  const now = (deps.depResearchNow ?? (() => new Date()))();
  const runId = formatRunId(now);
  const fetchedAt = now.toISOString();

  const scratchParent = mkdtempSync(join(tmpdir(), "dep-research-"));
  const baseDir = parsed.dryRun
    ? mkdtempSync(join(tmpdir(), "dep-research-out-"))
    : join(repoRoot, ".prx", "dep-research");

  try {
    const result = await fetchSources(entry, scratchParent, fetcher);
    const snapshot = buildSnapshot({
      dep: entry.name,
      runId,
      fetchedAt,
      fetched: result.paths,
      failures: result.failures,
    });
    writeSnapshot(snapshot, baseDir);
    output.log(JSON.stringify(snapshot, null, 2));
    if (snapshot.run_state === "failed") {
      for (const [path, reason] of Object.entries(result.failures)) {
        output.error(`  ${path}: ${reason}`);
      }
      return 1;
    }
    return 0;
  } catch (err) {
    return handleRunCliError(err, output);
  } finally {
    try {
      rmSync(scratchParent, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (parsed.dryRun) {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

function handleRunCliError(error: unknown, output: Output): number {
  if (error instanceof CliError) {
    output.error(error.message);
    return error.exitCode;
  }
  const nodeError = error as NodeError;
  if (
    nodeError?.code === "ENOENT" &&
    typeof nodeError.path === "string" &&
    nodeError.path.endsWith(".pr/local/pr.json")
  ) {
    output.error(`Missing PR contract at ${nodeError.path}`);
    output.error("Run `prx contract init` to create one, pass --contract, or use `prx overview` for a GitHub-only view.");
    return 1;
  }
  output.error(error instanceof Error ? error.message : String(error));
  return 1;
}

// GH-1533: map a `ParsedCommand` to the short verb name stamped onto `gh_call`
// audit rows. Post-namespace-rewrite `parsed.command` tokens are hyphen-joined
// (`triage-status`, `plan-preflight`, `intake-search`); render the namespace
// separator as `.` so audit rows read `triage.status` etc. `doctor` carries
// its action in a separate `verb` field, so handle it explicitly.
function auditVerbName(parsed: ParsedCommand): string {
  if (parsed.command === "doctor") return `doctor.${parsed.verb}`;
  if (parsed.command === "publisher") return `publisher.${parsed.verb}`;
  if (parsed.command === "publisher-pr") return `publisher.pr.${parsed.verb}`;
  if (parsed.command === "doctor-gh-budget") return "doctor.gh-budget";
  if (parsed.command === "doctor-dedupe-bd") return "doctor.dedupe-bd";
  return parsed.command.replace(/-/g, ".");
}

// GH-1533: `prx doctor gh-budget` — read-back over `rate-limit.jsonl`. Reads
// the rows whose `ts` falls in [now − since, now], groups the GraphQL ones by
// prx verb, sums measured cost, counts calls + budget-exhaustion rows. `cost`
// is a lower bound: rows logged without `PRX_GH_AUDIT_COST=1` and without a
// `rateLimit { … }` block in the query carry no `cost` and contribute only to
// `costRowsMissing`.
type GhBudgetRow = {
  /** `"(no verb)"` when the `gh` call ran outside a prx verb (no ambient context). */
  verb: string;
  calls: number;
  cost: number;
  costRowsMissing: number;
  exhausted: number;
};

// `api` is optional on rows written before GH-1533 — fall back to the bucket.
function ghCallApi(row: RateLimitAuditEntry): "graphql" | "rest" {
  return row.api ?? (row.bucket === "graphql" ? "graphql" : "rest");
}

function summarizeGhBudget(rows: readonly RateLimitAuditEntry[]): {
  graphqlRows: GhBudgetRow[];
  restCalls: number;
  totals: { calls: number; cost: number; costRowsMissing: number; exhausted: number };
} {
  const byVerb = new Map<string, GhBudgetRow>();
  let restCalls = 0;
  for (const row of rows) {
    if (ghCallApi(row) !== "graphql") {
      restCalls += 1;
      continue;
    }
    const key = row.verb ?? "(no verb)";
    let entry = byVerb.get(key);
    if (!entry) {
      entry = { verb: key, calls: 0, cost: 0, costRowsMissing: 0, exhausted: 0 };
      byVerb.set(key, entry);
    }
    entry.calls += 1;
    if (typeof row.cost === "number") entry.cost += row.cost;
    else entry.costRowsMissing += 1;
    if (row.threw === "BUDGET_EXHAUSTED") entry.exhausted += 1;
  }
  const graphqlRows = [...byVerb.values()].sort(
    (a, b) => b.cost - a.cost || b.calls - a.calls || a.verb.localeCompare(b.verb),
  );
  const totals = graphqlRows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      cost: acc.cost + r.cost,
      costRowsMissing: acc.costRowsMissing + r.costRowsMissing,
      exhausted: acc.exhausted + r.exhausted,
    }),
    { calls: 0, cost: 0, costRowsMissing: 0, exhausted: 0 },
  );
  return { graphqlRows, restCalls, totals };
}

function formatGhBudgetWindow(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function runDoctorGhBudget(
  opts: { sinceMs: number; format: "plain" | "json" },
  output: Output,
  deps: CliDeps,
): number {
  const now = (deps.now ?? (() => new Date()))();
  const fromMs = now.getTime() - opts.sinceMs;
  const reader = deps.rateLimitAuditReader ?? (() => readRateLimitAuditRows());
  const rows = reader().filter((r) => {
    const t = Date.parse(r.ts);
    return !Number.isNaN(t) && t >= fromMs;
  });
  const { graphqlRows, restCalls, totals } = summarizeGhBudget(rows);

  if (opts.format === "json") {
    output.log(
      JSON.stringify({
        since: new Date(fromMs).toISOString(),
        now: now.toISOString(),
        windowMs: opts.sinceMs,
        rows: graphqlRows.map((r) => ({
          verb: r.verb === "(no verb)" ? null : r.verb,
          calls: r.calls,
          cost: r.cost,
          costRowsMissing: r.costRowsMissing,
          exhausted: r.exhausted,
        })),
        restCalls,
        totals,
      }),
    );
    return 0;
  }

  output.log(
    `gh GraphQL spend — last ${formatGhBudgetWindow(opts.sinceMs)} (since ${new Date(fromMs).toISOString()})`,
  );
  output.log("");
  if (graphqlRows.length === 0) {
    output.log("  (no gh GraphQL calls recorded in this window)");
  } else {
    const verbWidth = Math.max(4, "total".length, ...graphqlRows.map((r) => r.verb.length));
    const sep = `  ${"─".repeat(verbWidth)}  ${"─".repeat(6)}  ${"─".repeat(8)}  ─────────`;
    output.log(`  ${"verb".padEnd(verbWidth)}  ${"calls".padStart(6)}  ${"cost".padStart(8)}  exhausted`);
    output.log(sep);
    for (const r of graphqlRows) {
      const cost = r.costRowsMissing > 0 ? `${r.cost}+` : `${r.cost}`;
      output.log(
        `  ${r.verb.padEnd(verbWidth)}  ${String(r.calls).padStart(6)}  ${cost.padStart(8)}  ${String(r.exhausted).padStart(9)}`,
      );
    }
    output.log(sep);
    const totalCost = totals.costRowsMissing > 0 ? `${totals.cost}+` : `${totals.cost}`;
    output.log(
      `  ${"total".padEnd(verbWidth)}  ${String(totals.calls).padStart(6)}  ${totalCost.padStart(8)}  ${String(totals.exhausted).padStart(9)}`,
    );
  }
  output.log("");
  if (restCalls > 0) {
    output.log(`  (+${restCalls} REST/core/search calls — not GraphQL-budget-charged)`);
  }
  if (totals.costRowsMissing > 0) {
    output.log(
      `  cost is a lower bound — ${totals.costRowsMissing} call(s) logged without a measured cost;`,
    );
    output.log(
      `  re-run with PRX_GH_AUDIT_COST=1 (free post-call rate_limit probe) for exact figures.`,
    );
  }
  return 0;
}

/**
 * GH-1697: shared `--repo <slug>` resolver for triage-* verbs. Mirrors the
 * routing block that `prx triage session --repo` proved out (GH-1689):
 * resolve the slug against the repo inventory, probe `.beads/` mode
 * (GH-1684), and return a `cwdFn` that the dispatched handler uses to
 * re-root reads at the target's mainx. Unknown slug → `CliError` from
 * `resolveTargetRepoCwd`; beads-less or embedded-mode target → `CliError`
 * via `beadsModeHint`.
 */
function resolveTriageRepoCwd(
  slug: string | undefined,
  deps: CliDeps,
): { cwdFn: (() => string) | undefined } {
  if (!slug) return { cwdFn: undefined };
  const resolved = (deps.resolveTargetRepoCwd ?? resolveTargetRepoCwd)(
    { slug, cwd: process.cwd() },
    {
      loadRepoInventoryConfig: deps.loadRepoInventoryConfig,
      discoverLocalRepos: deps.discoverLocalRepos,
      findRepoBySlug: deps.findRepoBySlug,
      materializeBareRepo: deps.materializeBareRepo,
    },
  );
  const mode = (deps.classifyBeadsWorkspace ?? classifyBeadsWorkspace)(resolved.targetCwd);
  const hint = beadsModeHint(mode, slug);
  if (hint !== null) {
    throw new CliError(hint);
  }
  const targetCwd = resolved.targetCwd;
  return { cwdFn: () => targetCwd };
}

export function runCli(argv: string[], output: Output = console, deps: CliDeps = {}): number | Promise<number> {
  try {
    // Clear memoized canonical-ID helpers so tests (which share the process
    // and chdir between cases) don't observe stale helpers from a prior run.
    // Helpers load lazily on first validator access via ensureCanonicalHelpers.
    resetCanonicalHelpers();

    // GH-1595: one `BeadsCache` per CLI invocation, threaded into every verb
    // whose deps already plumb `loadAllBeads?`. First `load()` runs the
    // canonical `bd list --all --json --limit 0` read; writers
    // (`bd update --external-ref`, …) call `invalidate()` before the next
    // read. Empty until a verb actually consumes it.
    const beadsCache: BeadsCache = createBeadsCache();

    const parsed = parseCommand(argv);

    // GH-1533: stamp the parsed verb into the ambient audit context so the
    // GH-1141 `gh`-call wrapper can attribute each `gh_call` row to a prx verb.
    setAuditRuntimeContext({ verb: auditVerbName(parsed) });

    if (parsed.command === "help") {
      output.log(formatHelp());
      return 0;
    }

    if (parsed.command === "help-all") {
      output.log(formatFullCommandCatalogHelp());
      return 0;
    }

    if (parsed.command === "help-verb") {
      output.log(formatVerbHelp(parsed.verb));
      return 0;
    }

    if (parsed.command === "session-help") {
      output.log(formatSessionHelp());
      return 0;
    }

    if (parsed.command === "plan-namespace-help") {
      output.log(formatPlanNamespaceHelp());
      return 0;
    }

    if (parsed.command === "intake-namespace-help") {
      output.log(formatIntakeNamespaceHelp());
      return 0;
    }

    if (parsed.command === "version") {
      output.log(detectVersion());
      // prx-ktw: `prx --version` reports the binary's release and flags a newer
      // *release* only (via the release-based binary check). The former
      // "update available: N commits behind origin/main" line measured the local
      // repo checkout's distance from origin/main — unrelated to the binary
      // version, and noisy from any feature worktree — so it is dropped.
      const binaryUpdate = (deps.checkPrxBinaryUpstream ?? checkPrxBinaryUpstream)();
      if (binaryUpdate) {
        output.error(formatBinaryUpdateWarning(binaryUpdate));
      }
      return 0;
    }

    if (parsed.command === "tui") {
      // procRunner throws on a spawn error (matching the prior `throw
      // result.error`); check:false lets a non-zero tui exit return as status.
      const result = procRunner(["bun", "run", "prx:tui", ...parsed.forwardArgs], {
        cwd: repoRootPath,
        stdio: "inherit",
        env: processEnv(),
        check: false,
      });
      return result.status;
    }

    if (parsed.command === "check-issue") {
      const start = performance.now();
      if (/^GH-\d+$/.test(parsed.workUnitId)) {
        const result = (deps.checkWorkUnitIssue ?? checkWorkUnitIssue)(parsed.workUnitId, process.cwd());
        const elapsed = performance.now() - start;
        output.log(formatWorkUnitIssueCheck(result, parsed.format));
        process.stderr.write(`check-issue: ${elapsed.toFixed(0)}ms\n`);
        return 0;
      }
      return (async () => {
        try {
          const config = ensureIdentityConfig();
          const resolver = resolverForCanonicalId(parsed.workUnitId, config, process.cwd());
          if (!resolver) {
            throw new CliError(
              `${prxSessionCannotOpenPrefix(parsed.workUnitId)} no issue-authority resolver is configured for this canonical id. Add a [sources.<name>] block to prx.toml (kind = "github" | "notion" | "beads") or use a GH-<n> id.`,
            );
          }
          const resolved = await resolver.fetch(parsed.workUnitId);
          if (resolved.state === "closed") {
            throw new CliError(
              `${prxSessionCannotOpenPrefix(parsed.workUnitId)} ${resolved.source} page is ${resolved.state}, so issue authority is not active.`,
            );
          }
          const elapsed = performance.now() - start;
          output.log(formatResolvedWorkUnitCheck(parsed.workUnitId, resolved, parsed.format));
          process.stderr.write(`check-issue: ${elapsed.toFixed(0)}ms\n`);
          return 0;
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "check-session") {
      const start = performance.now();
      const result = (deps.checkWorkUnitSession ?? checkWorkUnitSession)(
        parsed.workUnitId,
        process.cwd(),
        undefined,
        { log: (line) => output.error(line) },
      );
      const elapsed = performance.now() - start;
      output.log(formatWorkUnitSessionCheck(result, parsed.format));
      process.stderr.write(`check-session: ${elapsed.toFixed(0)}ms\n`);
      return 0;
    }

    if (parsed.command === "check-chain") {
      return (async () => {
        const start = performance.now();
        try {
          const result = await (deps.checkWorkUnitChain ?? checkWorkUnitChain)(
            parsed.workUnitId,
            process.cwd(),
            true,
            deps.boardStatus ?? boardStatus,
            deps.buildParityChain ?? buildParityChain,
          );
          const elapsed = performance.now() - start;
          output.log(formatWorkUnitChainCheck(result, parsed.format));
          process.stderr.write(`check-chain: ${elapsed.toFixed(0)}ms\n`);
          return 0;
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "mainx") {
      const worktreePath = prepareMainxWorktree(process.cwd());
      if (parsed.format === "json") {
        output.log(JSON.stringify({ path: worktreePath }, null, 2));
      } else {
        output.log(worktreePath);
      }
      return 0;
    }

    if (parsed.command === "close") {
      const result = (deps.closeSession ?? closeSession)({
        workUnitId: parsed.workUnitId,
        dryRun: parsed.dryRun,
        mainxReset: parsed.mainxReset,
        emitNext: parsed.emitNext,
        emitFile: parsed.emitFile,
        force: parsed.force,
      });
      output.log(formatCloseSession(result, parsed.format));
      if (!result.worktreePath) {
        return 0;
      }
      if (result.refusalReason) {
        return 1;
      }
      return result.handoffRequired ? 2 : 0;
    }

    if (parsed.command === "plan-close") {
      // GH-1057: plan-mode close-without-merge. Distinct from `close`
      // (post-merge cleanup) — actually closes the GH issue + syncs beads.
      return (deps.planClose ?? planClose)({
        workUnitId: parsed.workUnitId,
        reason: parsed.reason,
        upstream: parsed.upstream,
        dryRun: parsed.dryRun,
        emitNext: parsed.emitNext,
      }).then((result) => {
        output.log(formatPlanCloseResult(result, parsed.format));
        if (result.refusalReason) return 1;
        // GH-2110: bd-record failure raises the verb's exit code even when
        // the GH close succeeded — shell hooks downstream need to see the
        // failure to avoid a silent half-close.
        if (result.bdRecord && !result.bdRecord.ok) return 1;
        return 0;
      });
    }

    // GH-1173: CAS plan-store verbs.
    if (parsed.command === "plan-save") {
      return (async () => {
        try {
          let content: Buffer;
          if (parsed.source.kind === "stdin") {
            content = (deps.readStdinSync ?? readStdinSyncDefault)();
          } else {
            content = (deps.readPlanFile ?? readFileSync)(parsed.source.path);
          }
          // GH-1336: validate the move-to destination BEFORE calling
          // runPlanSave so a missing/non-directory dest fails fast — never
          // a half-done state with the slot persisted but the staging
          // file abandoned at its original path.
          if (parsed.cleanup.kind === "move-to") {
            const destPath = parsed.cleanup.dest;
            const stat = deps.statPath ?? ((p: string) => statSync(p));
            try {
              const info = stat(destPath);
              if (!info.isDirectory()) {
                throw new CliError(
                  `plan save: --cleanup=move-to=${destPath} must point to an existing directory`,
                );
              }
            } catch (err) {
              if (err instanceof CliError) throw err;
              throw new CliError(
                `plan save: --cleanup=move-to=${destPath} must point to an existing directory`,
              );
            }
          }
          // GH-1277: --skip-validate is the loud escape hatch for the
          // symmetric shape gate; warn before persisting so operators see
          // the slot will fail at consume.
          if (parsed.skipValidate) {
            output.error(
              "warning: plan save skipped shape validation (--skip-validate); slot will fail at consume",
            );
          }
          const result = await (deps.runPlanSave ?? runPlanSave)({
            unit: parsed.workUnitId!,
            slot: parsed.slot,
            content,
            skipValidate: parsed.skipValidate,
          });
          // GH-1336: cleanup runs strictly after runPlanSave returns
          // success. CAS writers throw PlanStoreError on failure so the
          // exception bubbles past this site — the staging file is never
          // touched on save failure (atomicity invariant).
          if (parsed.cleanup.kind !== "none" && parsed.source.kind === "file") {
            const stagingPath = parsed.source.path;
            if (parsed.cleanup.kind === "delete") {
              (deps.unlinkPlanFile ?? unlinkSync)(stagingPath);
            } else {
              const destFile = join(
                parsed.cleanup.dest,
                basename(stagingPath),
              );
              (deps.renamePlanFile ?? renameSync)(stagingPath, destFile);
            }
          }
          // GH-2028: persist-on-failure. The body is always written; when the
          // shape gate flagged diagnostics (and --skip-validate did not force
          // it consumable) emit a stderr note. Exit 0 — the write succeeded and
          // the slot is recoverable; refusal happens at consume.
          if (!result.validated_ok && result.diagnostics.length > 0) {
            output.error(
              `note: plan saved with validated_ok=false (${result.diagnostics.length} diagnostic${result.diagnostics.length === 1 ? "" : "s"}); \`prx implement agent ${parsed.workUnitId}\` will refuse until resolved:`,
            );
            for (const d of result.diagnostics) {
              output.error(`  [${d.code}] ${d.path}: ${d.message}`);
            }
          }
          if (parsed.format === "json") {
            output.log(
              JSON.stringify(
                {
                  unit: parsed.workUnitId,
                  slot: parsed.slot,
                  sha: result.sha,
                  ref: result.ref,
                  body_sha: result.body_sha,
                  envelope_sha: result.envelope_sha,
                  validated_ok: result.validated_ok,
                  diagnostics: result.diagnostics,
                  size: content.length,
                },
                null,
                2,
              ),
            );
          } else {
            output.log(result.sha);
          }
          return 0;
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "plan-load") {
      return (async () => {
        try {
          const result = await (deps.runPlanLoad ?? runPlanLoad)({
            unit: parsed.workUnitId,
            slot: parsed.slot,
            fallbackToDraft: !parsed.slotExplicit,
          });
          if (result.fellBackToDraft) {
            output.error(
              `note: no approved plan for ${parsed.workUnitId}, falling back to draft (sha=${result.sha})`,
            );
          }
          if (parsed.format === "json") {
            output.log(
              JSON.stringify(
                {
                  unit: parsed.workUnitId,
                  slot: result.slot,
                  sha: result.sha,
                  size: result.content.length,
                  body: result.content.toString("utf8"),
                },
                null,
                2,
              ),
            );
          } else {
            (deps.writeStdoutBinary ?? writeStdoutBinaryDefault)(result.content);
          }
          return 0;
        } catch (error) {
          if (error instanceof PlanRefNotFound) {
            output.error(`FAIL: ${error.message}`);
            return 1;
          }
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "plan-show") {
      return (async () => {
        try {
          // GH-1226: --paths surfaces the resolved CAS root + which env-var
          // branch fired without reading any blob. Skips runPlanShow because
          // the operator's question is "where would my plans land", which is
          // useful even when no plan has been saved yet.
          if (parsed.paths) {
            const resolution = resolveStoreRootForDisplay("plans");
            // GH-1175: surface the staging dir alongside cas_root so the
            // operator can see where `prx plan save --from-file` may read
            // from (and where the plan-profile Write allowlist carve-out
            // lands). Resolution is best-effort — if neither
            // XDG_CACHE_HOME nor HOME is set the staging dir is reported
            // as null so callers can still inspect the CAS root.
            let stagingDir: string | null = null;
            let stagingSource: string | null = null;
            try {
              const staging = resolvePlanStagingDirForDisplay();
              stagingDir = staging.dir;
              stagingSource = staging.source;
            } catch (error) {
              // GH-1175 Copilot review: only swallow the documented
              // NO_STAGING_ROOT case (env-var underpopulated). Bare
              // `catch {}` would hide INVALID_STAGING_ROOT (forbidden
              // chars in env value) and any unexpected runtime error.
              if (!(error instanceof PlanStoreError) || error.code !== "NO_STAGING_ROOT") {
                throw error;
              }
            }
            if (parsed.format === "json") {
              output.log(
                JSON.stringify(
                  {
                    unit: parsed.workUnitId,
                    domain: "plans",
                    cas_root: resolution.root,
                    source: resolution.source,
                    staging: stagingDir,
                    staging_source: stagingSource,
                  },
                  null,
                  2,
                ),
              );
            } else {
              output.log(`unit:           ${parsed.workUnitId}`);
              output.log(`domain:         plans`);
              output.log(`cas_root:       ${resolution.root}`);
              output.log(`source:         ${resolution.source}`);
              output.log(`staging:        ${stagingDir ?? "(unresolved — set XDG_CACHE_HOME or HOME)"}`);
              output.log(`staging_source: ${stagingSource ?? "(none)"}`);
            }
            return 0;
          }
          const result = await (deps.runPlanShow ?? runPlanShow)({
            unit: parsed.workUnitId,
            slot: parsed.slot,
          });
          if (parsed.format === "json") {
            output.log(
              JSON.stringify(
                {
                  unit: result.unit,
                  slot: result.slot,
                  sha: result.sha,
                  size: result.size,
                  body: result.body.toString("utf8"),
                },
                null,
                2,
              ),
            );
          } else {
            output.log(`unit: ${result.unit}`);
            output.log(`slot: ${result.slot}`);
            output.log(`sha:  ${result.sha}`);
            output.log(`size: ${result.size} bytes`);
            output.log("---");
            const text = result.body.toString("utf8");
            const lines = text.split("\n");
            const head = lines.slice(0, 20);
            for (const line of head) output.log(line);
            if (lines.length > 20) {
              output.log(`... (${lines.length - 20} more lines; use --format json for full body)`);
            }
          }
          return 0;
        } catch (error) {
          if (error instanceof PlanRefNotFound) {
            output.error(`FAIL: ${error.message}`);
            return 1;
          }
          return handleRunCliError(error, output);
        }
      })();
    }

    // GH-1239: deterministic pre-draft preflight. Pure read; exit 0 on pass,
    // 1 on any axis failure (already-done / infeasible-action /
    // infeasible-blocker / mixed-failure).
    if (parsed.command === "plan-preflight") {
      return (async () => {
        try {
          const handler = deps.runPlanPreflight ?? runPlanPreflight;
          const result = await handler({ unit: parsed.workUnitId });
          if (parsed.format === "json") {
            output.log(JSON.stringify(result, null, 2));
          } else {
            output.log(formatPreflightPlain(result));
          }
          return result.status === "pass" ? 0 : 1;
        } catch (error) {
          // Errors from the preflight itself (network, parse) get exit 2 so
          // operators can distinguish "the check ran and refused" (1) from
          // "the check could not run" (2).
          const message = error instanceof Error ? error.message : String(error);
          output.error(`plan preflight: ${message}`);
          return 2;
        }
      })();
    }

    // GH-1186: planner-side read primitives. Mirror intake-view / intake-search
    // dispatch — pure reads that route through the shared `src/issues/` core.
    if (parsed.command === "plan-view") {
      const handler = deps.runPlanView ?? runPlanView;
      const validated: PlanViewOptions = planViewOptionsSchema.parse({
        id: parsed.id,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "plan-search") {
      const handler = deps.runPlanSearch ?? runPlanSearch;
      const validated: PlanSearchOptions = planSearchOptionsSchema.parse({
        query: parsed.query,
        state: parsed.state,
        source: parsed.source,
        limit: parsed.limit,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    // GH-1194 (sub-ticket D): scout grep handler. Walks the filesystem
    // root (resolved from --in or cwd) and prints JSON-lines matches.
    // When invoked under dispatch, the envelope captures stdout into CAS
    // and replaces it with the resulting `scout://sha256:…` handle.
    if (parsed.command === "scout-grep") {
      return (async () => {
        try {
          const result = await runScoutGrep({
            pattern: parsed.pattern,
            in: parsed.in,
            pathPrefix: parsed.pathPrefix,
            maxResults: parsed.maxResults,
          });
          if (parsed.format === "json") {
            output.log(JSON.stringify(result, null, 2));
          } else {
            const text = formatScoutGrepJsonLines(result);
            // formatScoutGrepJsonLines already terminates with `\n`.
            output.log(text.replace(/\n$/, ""));
          }
          return 0;
        } catch (err) {
          if (err instanceof ScoutGrepError) {
            output.error(`scout grep ${err.code}: ${err.message}`);
            return err.code === "MISSING_PATTERN" || err.code === "INVALID_PATTERN" ? 64 : 65;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1384 PR-1: scout files handler — bounded glob walk over a directory
    // root. Sibling of scout-grep with a single-field {path} match shape.
    if (parsed.command === "scout-files") {
      return (async () => {
        try {
          const result = await runScoutFiles({
            pattern: parsed.pattern,
            in: parsed.in,
            maxResults: parsed.maxResults,
          });
          if (parsed.format === "json") {
            output.log(JSON.stringify(result, null, 2));
          } else {
            const text = formatScoutFilesJsonLines(result);
            output.log(text.replace(/\n$/, ""));
          }
          return 0;
        } catch (err) {
          if (err instanceof ScoutFilesError) {
            output.error(`scout files ${err.code}: ${err.message}`);
            return err.code === "MISSING_PATTERN" || err.code === "INVALID_PATTERN" ? 64 : 65;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1384 PR-2: scout read handler — single-file bounded read; emits a
    // single JSON envelope so the dispatch envelope captures one CAS record.
    if (parsed.command === "scout-read") {
      return (async () => {
        try {
          const result = await runScoutRead({
            path: parsed.path,
            in: parsed.in,
            maxBytes: parsed.maxBytes,
          });
          if (parsed.ledger !== undefined) {
            const store = openAnchoredChain(parsed.ledger);
            try {
              await recordScoutReadDerivation(store.derivations, result);
            } finally {
              store.close();
            }
          }
          output.log(
            parsed.provenance
              ? JSON.stringify(scoutReadProvenance(result))
              : JSON.stringify(result),
          );
          return 0;
        } catch (err) {
          if (err instanceof ScoutReadError) {
            output.error(`scout read ${err.code}: ${err.message}`);
            const usageCodes = new Set([
              "MISSING_PATH",
              "INVALID_MAX_BYTES",
            ]);
            return usageCodes.has(err.code) ? 64 : 65;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1245 → GH-1603 — `prx fetch gh-issues` handler. The verb's
    // failure-mode catalog maps to exit codes as:
    //   • plan.decision = "fail"  ⇒ exit 65 (I-F3)
    //   • plan.decision = "skip"  ⇒ exit 0  (I-F2)
    //   • plan.decision = "go"    ⇒ exit 0 (dry-run) or exit 0 / 65 (live;
    //                              FETCH_WRITE_FAILED from a partial-page
    //                              bd write surfaces as 65, with the prior
    //                              committed pages already on disk + the
    //                              watermark at their max(updatedAt) —
    //                              I-F4 + I-F5)
    //   • thrown FetchGhIssuesError or BucketBudgetExhaustedError ⇒ exit 65
    if (parsed.command === "fetch-gh-issues") {
      return (async () => {
        try {
          const result = runFetchGhIssues(
            {
              source: "gh-issues",
              repo: parsed.repo,
              since: parsed.since,
              budget: parsed.budget,
              dryRun: parsed.dryRun,
            },
            { cwd: process.cwd() },
          );
          output.log(formatFetchGhIssuesJson(result));
          if (result.plan.decision === "fail") {
            output.error(`fetch gh-issues: ${result.plan.rationale}`);
            return 65;
          }
          if (result.plan.decision === "skip") {
            output.error(`fetch gh-issues: ${result.plan.rationale}`);
          }
          return 0;
        } catch (err) {
          if (err instanceof FetchGhIssuesError) {
            output.error(`fetch gh-issues ${err.code}: ${err.message}`);
            return 65;
          }
          if (err instanceof BucketBudgetExhaustedError) {
            output.error(`fetch gh-issues BUDGET_EXHAUSTED: ${err.message}`);
            return 65;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1423: rules verbs. Three handlers share `src/rules/cli.ts`
    // under `runRulesCli`. All read-only with respect to the filesystem
    // in PR-1 — `render` emits to stdout, `validate` reads `--path`, and
    // `inputs` dumps the typed input set as JSON.
    if (
      parsed.command === "rules-render" ||
      parsed.command === "rules-validate" ||
      parsed.command === "rules-inputs"
    ) {
      return (async () => {
        const { runRulesCli, RulesCliError } = await import("../rules/cli.ts");
        const verbMap = {
          "rules-render": "render",
          "rules-validate": "validate",
          "rules-inputs": "inputs",
        } as const;
        try {
          return runRulesCli(
            {
              verb: verbMap[parsed.command],
              validatePath:
                parsed.command === "rules-validate" ? parsed.path : undefined,
              format: parsed.format,
            },
            {
              log: (line) => output.log(line),
              error: (line) => output.error(line),
            },
          );
        } catch (err) {
          if (err instanceof RulesCliError) {
            output.error(`rules ${err.code}: ${err.message}`);
            return err.exitCode;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1768: derive verbs. Five handlers share a single CLI module
    // (`src/derive/cli.ts`) under `runDeriveCli`. All verbs are
    // read-only — they project facts, evaluate rules, and emit the
    // three observability events through the optional `emit` hook.
    if (
      parsed.command === "derive-ready" ||
      parsed.command === "derive-drift" ||
      parsed.command === "derive-eligible" ||
      parsed.command === "derive-why" ||
      parsed.command === "derive-dump-facts"
    ) {
      return (async () => {
        const { runDeriveCli, DeriveCliError } = await import("../derive/cli.ts");
        const verbMap = {
          "derive-ready": "ready",
          "derive-drift": "drift",
          "derive-eligible": "eligible",
          "derive-why": "why",
          "derive-dump-facts": "dump-facts",
        } as const;
        try {
          return runDeriveCli(
            {
              verb: verbMap[parsed.command],
              fixturePath: parsed.fixturePath,
              issueFilter: parsed.issueFilter,
              args: parsed.positionals,
              format: parsed.format === "json" ? "json" : "table",
            },
            {
              log: (line) => output.log(line),
              error: (line) => output.error(line),
            },
          );
        } catch (err) {
          if (err instanceof DeriveCliError) {
            output.error(`derive ${err.code}: ${err.message}`);
            return err.exitCode;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1244: scout issues handler — read-only beads/Dolt projection.
    // Emits JSONL on stdout (one record per match + trailing _summary line)
    // so the dispatch envelope captures one CAS record per invocation.
    if (parsed.command === "scout-issues") {
      return (async () => {
        try {
          const result = await runScoutIssues({
            query: parsed.query,
            state: parsed.state,
            repo: parsed.repo,
            max: parsed.max,
            maxStaleness: parsed.maxStaleness,
            format: parsed.format,
          });
          const text = formatScoutIssuesJsonLines(result);
          output.log(text.replace(/\n$/, ""));
          return 0;
        } catch (err) {
          if (err instanceof ScoutIssuesError) {
            output.error(`scout issues ${err.code}: ${err.message}`);
            const usageCodes = new Set([
              "BD_NOT_FOUND",
              "INVALID_MAX",
              "INVALID_REPO",
            ]);
            return usageCodes.has(err.code) ? 64 : 65;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1420: scout notion handler — Notion page UUID/Task-ID resolver.
    // Emits a single JSON envelope so dispatch captures one CAS record.
    if (parsed.command === "scout-notion") {
      return (async () => {
        try {
          const result = await runScoutNotion({
            id: parsed.id,
            noMirrors: parsed.noMirrors,
            ghExec: parsed.noMirrors ? undefined : execGh,
            bdExec: parsed.noMirrors ? undefined : execBd,
          });
          // formatScoutNotionJson terminates with `\n`; strip the trailing
          // newline so output.log doesn't double-print it.
          output.log(formatScoutNotionJson(result).replace(/\n$/, ""));
          return 0;
        } catch (err) {
          if (err instanceof ScoutNotionError) {
            output.error(`scout notion ${err.code}: ${err.message}`);
            const usageCodes = new Set(["MISSING_ID", "INVALID_ID"]);
            return usageCodes.has(err.code) ? 64 : 65;
          }
          return handleRunCliError(err, output);
        }
      })();
    }

    // GH-1194: per-actor dispatch handler. The XState dispatch machine
    // owns the capability/depth guard; on success we print the CAS handle
    // and exit 0, otherwise emit `dispatch <reason>: <detail>` to stderr
    // and use a stable exit-code map (64=usage, 65=execution/depth, 70=other).
    if (parsed.command === "dispatch") {
      return (async () => {
        try {
          const { outcome } = await runDispatch({
            parsed: {
              source: parsed.source,
              target: parsed.target,
              action: parsed.action,
              argv: parsed.argv,
            },
          });
          const rendered = renderDispatchOutcome(outcome);
          if (rendered.stdout.length > 0) output.log(rendered.stdout.replace(/\n$/, ""));
          if (rendered.stderr.length > 0) output.error(rendered.stderr.replace(/\n$/, ""));
          return rendered.exitCode;
        } catch (err) {
          return handleRunCliError(err, output);
        }
      })();
    }

    if (parsed.command === "review") {
      const result = (deps.reviewVerb ?? reviewVerb)(
        { workUnitId: parsed.workUnitId, ultra: parsed.ultra },
        { muxRunner: deps.muxRunner },
      );
      if (parsed.format === "json") {
        output.log(JSON.stringify(result, null, 2));
      } else {
        for (const line of result.handoff) output.log(line);
      }
      return 0;
    }

    if (parsed.command === "beads-init") {
      return runBeadsInit(process.cwd(), parsed.importGh, parsed.dryRun, output);
    }

    // GH-1706: embedded → shared-server bd migration. Result is a
    // discriminated union; map each arm to a stable exit code (0 on
    // applied/dry-run; 64=usage refusal; 65=runtime failure).
    if (parsed.command === "beads-migrate") {
      const result = runBeadsMigrate({
        slug: parsed.slug,
        dryRun: parsed.dryRun,
        patchMetadata: parsed.patchMetadata,
        staleThresholdSeconds: parsed.staleThresholdSeconds,
      });
      if (result.kind === "dry-run") {
        output.log(`beads migrate: dry-run for ${result.slug}`);
        output.log(`  planned backup dir: ${result.plannedBackupDir}`);
        for (const step of result.plannedSteps) {
          output.log(`  - ${step}`);
        }
        return 0;
      }
      if (result.kind === "applied") {
        output.log(`beads migrate: applied for ${result.slug}`);
        output.log(`  backup dir: ${result.backupDir}`);
        output.log(`  events: ${result.events.join(", ")}`);
        if (result.patchedMetadata) {
          output.log("  metadata patched: dolt_mode=server (GH-1695 workaround)");
        }
        output.log(`  ${result.hint}`);
        return 0;
      }
      if (result.kind === "refused") {
        output.error(`beads migrate refused: ${result.reason}`);
        if (result.detail) output.error(`  ${result.detail}`);
        if (result.hint) output.error(`  hint: ${result.hint}`);
        return 64;
      }
      // failed
      output.error(`beads migrate failed at ${result.failedAt}: ${result.detail}`);
      output.error(`  backup preserved at ${result.backupDir}`);
      output.error(`  events emitted: ${result.events.join(", ")}`);
      return 65;
    }

    // GH-1261 (PR-1): print resolved dep-research manifest.
    if (parsed.command === "dep-manifest") {
      try {
        const entries = loadDepManifest(process.cwd());
        if (parsed.format === "json") {
          output.log(formatDepManifestJson(entries));
        } else {
          output.log(formatDepManifestPlain(entries));
        }
        return 0;
      } catch (err) {
        if (err instanceof DepManifestError) {
          output.error(`dep manifest ${err.code}: ${err.message}`);
          return err.code === "NOT_FOUND" ? 66 : 65;
        }
        return handleRunCliError(err, output);
      }
    }

    // GH-1274 (PR-2 of GH-1261): `prx dep research <dep> [--dry-run]`.
    if (parsed.command === "dep-research") {
      return runDepResearch(parsed, output, deps);
    }

    // GH-1275 (PR-3 of GH-1261): read-only `prx dep status`.
    if (parsed.command === "dep-status") {
      try {
        const rows = loadDepStatus(process.cwd());
        if (parsed.format === "json") {
          output.log(formatDepStatusJson(rows));
        } else {
          output.log(formatDepStatusPlain(rows));
        }
        return 0;
      } catch (err) {
        if (err instanceof DepManifestError) {
          output.error(`dep status ${err.code}: ${err.message}`);
          return err.code === "NOT_FOUND" ? 66 : 65;
        }
        return handleRunCliError(err, output);
      }
    }

    if (parsed.command === "init") {
      // GH-357: top-level scaffold of the cross-agent convention layer.
      try {
        const result = scaffoldRepo({ force: parsed.force });
        output.log(formatScaffoldResult(result, parsed.format));
        return 0;
      } catch (error) {
        if (error instanceof ScaffoldError) {
          output.error(error.message);
          return 2;
        }
        return handleRunCliError(error, output);
      }
    }

    if (parsed.command === "contract-init") {
      return (async () => {
        try {
          const result = await (deps.initContract ?? initContract)(parsed.outputPath, {
            title: parsed.title,
            summary: parsed.summary,
            ready: parsed.ready,
            forceBeads: parsed.forceBeads,
            changeType: parsed.changeType,
            generatedBy: parsed.generatedBy,
            untracked: parsed.untracked,
          });
          output.log(formatInitResult(result, parsed.format));
          return 0;
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "status") {
      return printStatus(parsed.contract, parsed.format, output);
    }

    if (parsed.command === "transition") {
      const contract = loadContract(parsed.contract);
      const currentState = deriveInfo(contract).state;

      try {
        assertValidTransition(currentState, parsed.to);
      } catch (error) {
        output.error(`FAIL: ${(error as Error).message}`);
        return 1;
      }

      try {
        validateActorOwnership(parsed.actor);
      } catch (error) {
        output.error(`FAIL: ${(error as Error).message}`);
        return 1;
      }

      const nextContract = applyTransition(contract, parsed.to, parsed.actor, parsed.reason);
      writeContract(parsed.contract, nextContract);

      const branch = detectBranchNameFromCwd();
      const commit = tryCommand(["git", "rev-parse", "--short=12", "HEAD"], process.cwd());
      const logEntry: TransitionEntry = {
        id: parsed.id ?? crypto.randomUUID(),
        issue: branch,
        state_from: currentState,
        state_to: parsed.to,
        actor: parsed.actor,
        artifact: branch ? `branch:${branch}` : null,
        timestamp: new Date().toISOString(),
        proof: { commit },
      };
      appendTransitionLog(parsed.log, logEntry);

      const info = deriveInfo(loadContract(parsed.contract));
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              state: info.state,
              mode: info.mode,
              title: info.title,
              reason: info.reason,
              transition: {
                to: parsed.to,
                actor: parsed.actor,
                reason: parsed.reason ?? null,
              },
            },
            null,
            2,
          ),
        );
        return 0;
      }
      return printStatus(parsed.contract, "plain", output);
    }

    // GH-1821: contract-trinity read path. `prx contract show --kind=...`
    // pivots to the AgentContract / ArtifactContract / TransitionContract
    // registries; `--list` enumerates the registry; positional id selects a
    // single entry. Falls through to the legacy pr.json path when neither
    // flag is set.
    if (
      parsed.command === "contract" &&
      (parsed.kind !== undefined || parsed.list === true)
    ) {
      const fmt = parsed.format === "json" ? "json" : "plain";
      const writeOne = (kind: string, entry: unknown, slug: string): number => {
        if (fmt === "json") {
          output.log(JSON.stringify({ kind, id: slug, entry }, null, 2));
        } else {
          output.log(`# ${kind} ${slug}`);
          output.log(JSON.stringify(entry, null, 2));
        }
        return 0;
      };

      if (parsed.list === true && parsed.kind === undefined) {
        const payload = {
          agents: listAgentContracts().map((c) => c.role),
          artifacts: listArtifactContracts().map((c) => c.type),
          transitions: listTransitionContracts().map((c) => transitionKey(c)),
        };
        if (fmt === "json") {
          output.log(JSON.stringify(payload, null, 2));
        } else {
          output.log(`agents:`);
          for (const r of payload.agents) output.log(`  - ${r}`);
          output.log(`artifacts:`);
          for (const t of payload.artifacts) output.log(`  - ${t}`);
          output.log(`transitions:`);
          for (const k of payload.transitions) output.log(`  - ${k}`);
        }
        return 0;
      }

      if (parsed.kind === "agent") {
        if (parsed.list === true) {
          const entries = listAgentContracts();
          if (fmt === "json") {
            output.log(JSON.stringify(entries, null, 2));
          } else {
            for (const e of entries) output.log(e.role);
          }
          return 0;
        }
        if (!parsed.id) {
          output.error("FAIL: prx contract show --kind=agent requires a role (e.g. executor)");
          return 1;
        }
        const entry = getAgentContract(parsed.id);
        if (!entry) {
          output.error(`FAIL: no agent contract registered for role ${parsed.id}`);
          return 1;
        }
        return writeOne("agent", entry, parsed.id);
      }

      if (parsed.kind === "artifact") {
        if (parsed.list === true) {
          const entries = listArtifactContracts();
          if (fmt === "json") {
            output.log(JSON.stringify(entries, null, 2));
          } else {
            for (const e of entries) output.log(e.type);
          }
          return 0;
        }
        if (!parsed.id) {
          output.error("FAIL: prx contract show --kind=artifact requires a type (e.g. test_run)");
          return 1;
        }
        const entry = getArtifactContract(parsed.id);
        if (!entry) {
          output.error(`FAIL: no artifact contract registered for type ${parsed.id}`);
          return 1;
        }
        return writeOne("artifact", entry, parsed.id);
      }

      if (parsed.kind === "transition") {
        if (parsed.list === true) {
          const entries = listTransitionContracts();
          if (fmt === "json") {
            output.log(JSON.stringify(entries, null, 2));
          } else {
            for (const e of entries) output.log(transitionKey(e));
          }
          return 0;
        }
        if (!parsed.id) {
          output.error(
            "FAIL: prx contract show --kind=transition requires a key (e.g. role:testing->reviewing)",
          );
          return 1;
        }
        const entry = getTransitionContract(parsed.id);
        if (!entry) {
          output.error(`FAIL: no transition contract registered for key ${parsed.id}`);
          return 1;
        }
        return writeOne("transition", entry, parsed.id);
      }

      output.error(`FAIL: unknown --kind=${parsed.kind ?? ""}`);
      return 1;
    }

    if (parsed.command === "event" || parsed.command === "contract") {
      const skill: PrSkillName = parsed.command === "contract" ? "pr-contract" : parsed.skill;
      const contract = loadContract(parsed.contract);
      const from = deriveInfo(contract).state;
      const definition: SkillEventDefinition = eventForSkill(skill);
      let nextContract = contract;
      let appliedTransition = false;
      let blockedTransition: { from: LifecycleState; to: LifecycleState } | null = null;

      if (definition.kind === "transition") {
        try {
          assertValidTransition(from, definition.to);
          nextContract = applyTransition(contract, definition.to, parsed.actor, parsed.reason ?? definition.event);
          appliedTransition = true;
        } catch {
          nextContract = recordEvent(
            contract,
            definition.event,
            parsed.actor,
            parsed.reason ?? `Transition blocked from ${from} to ${definition.to}`,
          );
          blockedTransition = { from, to: definition.to };
        }
      } else {
        nextContract = recordEvent(contract, definition.event, parsed.actor, parsed.reason);
      }

      writeContract(parsed.contract, nextContract);

      if (appliedTransition && definition.kind === "transition" && parsed.command === "event") {
        const branch = detectBranchNameFromCwd();
        const commit = tryCommand(["git", "rev-parse", "--short=12", "HEAD"], process.cwd());
        const logEntry: TransitionEntry = {
          id: parsed.id ?? crypto.randomUUID(),
          issue: branch,
          state_from: from,
          state_to: definition.to,
          actor: parsed.actor,
          artifact: branch ? `branch:${branch}` : null,
          timestamp: new Date().toISOString(),
          proof: { commit },
        };
        appendTransitionLog(parsed.log, logEntry);
      }

      const info = deriveInfo(loadContract(parsed.contract));
      const payload = {
        skill,
        event: definition.event,
        kind: definition.kind === "transition" && !appliedTransition ? "observe" : definition.kind,
        from,
        to: definition.kind === "transition" ? definition.to : from,
        transitionApplied: appliedTransition,
        blockedTransition,
        state: info.state,
        mode: info.mode,
        title: info.title,
        reason: info.reason,
      };

      if (parsed.format === "json") {
        output.log(JSON.stringify(payload, null, 2));
        return 0;
      }

      output.log(`${payload.state} (${payload.mode}) - ${payload.event} via ${skill}`);
      return 0;
    }

    if (parsed.command === "open-mode") {
      const info = deriveInfo(loadContract(parsed.contract));

      if (parsed.format === "mode") {
        output.log(info.mode);
        return 0;
      }

      if (parsed.format === "json") {
        output.log(JSON.stringify(info, null, 2));
        return 0;
      }

      if (parsed.format === "gh-create") {
        output.log(formatCreateCommand(info.mode));
        return 0;
      }

      if (!parsed.pr) {
        output.error("--pr is required with --format gh-ready");
        return 1;
      }

      output.log(formatReadyCommand(info.mode, info.state, parsed.pr));
      return 0;
    }

    if (parsed.command === "graph") {
      const graphText = formatGraph(parsed.format);
      if (parsed.validate) {
        if (!isJsonGraphFormat(parsed.format)) {
          output.error(`--validate requires a JSON graph format; got ${parsed.format}`);
          return 1;
        }
        try {
          JSON.parse(graphText);
        } catch (error) {
          output.error(`Graph JSON validation failed: ${(error as Error).message}`);
          return 1;
        }
      }

      if (parsed.outputPath) {
        writeFileSync(parsed.outputPath, graphText);
        const details = [
          `Wrote graph output to ${parsed.outputPath}`,
          ...(parsed.validate ? ["json-ok"] : []),
        ];
        output.log(details.join(" | "));
      } else {
        output.log(graphText);
      }

      if (parsed.open) {
        (deps.openUrl ?? openUrl)(parsed.url);
      }
      return 0;
    }

    if (parsed.command === "stately") {
      const machineText = formatGraph("xstate-ts");
      (deps.copyToClipboard ?? copyToClipboard)(machineText);

      if (parsed.noWait) {
        if (runInheritStatus(["/usr/bin/open", parsed.url]) !== 0) {
          throw new Error(`Failed to open ${parsed.url}`);
        }
      } else {
        (deps.openAfterEnter ?? openAfterEnter)(parsed.url);
      }

      output.log(`Copied machine to clipboard and opened ${parsed.url}`);
      return 0;
    }

    if (parsed.command === "runtime-profile") {
      const profile = parsed.profile === "user"
        ? buildUserClaudeRuntimeProfile()
        : buildWorkUnitClaudeRuntimeProfile({
          agentId: parsed.agent ?? parsed.workUnitId,
          workUnitId: parsed.workUnitId,
          ioFormat: parsed.ioFormat,
          mode: parsed.mode,
        });
      const renderedProfile = parsed.interactive && parsed.profile === "work-unit"
        ? buildExecutedWorkProfile(profile, {})
        : profile;
      output.log(formatRuntimeProfile(renderedProfile, parsed.format));
      return 0;
    }

    if (parsed.command === "session") {
      return (async (): Promise<number> => {
        try {
      if (parsed.invokedViaDeprecatedWorkAlias) {
        output.error(PRX_SESSION_DEPRECATION_WORK);
      }
      if (parsed.invokedViaDeprecatedSessionShorthand) {
        output.error("Prefer `prx plan session <id>` over `prx session <id>`.");
      }
      if (parsed.invokedViaDeprecatedRootOpen) {
        output.error("Prefer `prx plan session <id>` over `prx open`.");
      }
      // GH-950: when invoked via `prx plan session`, emit the plan-session
      // banner so the operator sees which shape they entered. GH-977: the
      // alias-deprecation hint for `prx session open` is now emitted from
      // the session-entry machine action, not from a one-off if-shim here.
      if (parsed.invokedViaPlanSession) {
        output.error(SESSION_PROFILES.plan.banner);
      }

      // GH-1239: auto-step preflight for `prx plan session`. Refuses session
      // entry when the planner would draft against an already-done artifact,
      // an infeasible action shape, or a still-open blocker. `--check` /
      // `--dry-run` skip the gate (read-only inspections; preflight itself
      // is a separate verb the operator can run for the same audit). The
      // exit-2 path mirrors the tmux + plan-mode refusal precedent — the
      // error stream carries the structured reason.
      if (
        parsed.invokedViaPlanSession &&
        !parsed.check &&
        !parsed.dryRun &&
        !parsed.skipPreflight
      ) {
        const refusal = await runPreflightAutoStepRefusal(
          parsed.workUnitId,
          deps,
          output,
        );
        if (refusal !== null) return refusal;
      } else if (parsed.invokedViaPlanSession && parsed.skipPreflight) {
        output.error(
          `note: --skip-preflight bypasses the GH-1239 pre-draft check for ${parsed.workUnitId}`,
        );
      }

      // GH-549: `--check` is a read-only inspection. It never spawns hooks or
      // mutates local state, so the re-entrancy guard below (which protects
      // the materialization path) does not apply. Short circuit here — after
      // the chain pre-check, before any worktree lookup or `wt switch` — so
      // the command stays a pure inspection on all four branch states
      // (absent / local-only / remote-only / worktree-exists).
      if (parsed.check) {
        // Read-only: skip pruneStaleRemoteRefs (network I/O + mutates refs)
        await validateWorkSessionEntry(
          parsed.workUnitId,
          process.cwd(),
          parsed.create,
          deps.boardStatus ?? boardStatus,
          deps.buildParityChain ?? buildParityChain,
          deps.validateGitHubIssue ?? validateGitHubIssue,
          () => {},
          parsed.from,
          deps.findEpicChildren ?? findEpicChildren,
          deps.wtStatus ?? wtStatus,
        );
        const report = (deps.inspectSessionOpenState ?? inspectSessionOpenState)(
          parsed.workUnitId,
          process.cwd(),
        );
        output.log(formatSessionOpenCheck(report, parsed.format));
        return 0;
      }

      // Re-entrancy guard: prevent prx session open → wt switch → hooks → prx session open loops.
      // The env var is inherited by child processes (wt switch hooks), detecting when prx session
      // open is called from within itself.
      const PRX_SESSION_OPEN_ENV = "PRX_SESSION_OPEN";
      if (getEnv(PRX_SESSION_OPEN_ENV)) {
        throw new CliError(
          `Re-entrant prx session open detected for ${parsed.workUnitId} — aborting to prevent loop. ` +
          `(${PRX_SESSION_OPEN_ENV} is already set in the environment.)`,
        );
      }
      setEnv(PRX_SESSION_OPEN_ENV, "1");
      try {

      // GH-528: warn if the installed prx binary is behind origin/main.
      // Non-fatal — we still run the session, but surface the staleness so
      // users can choose to rebuild before they hit recently-fixed bugs.
      {
        const update = (deps.checkPrxBinaryUpstream ?? checkPrxBinaryUpstream)();
        if (update) {
          output.error(
            formatBinaryUpdateWarning(update),
          );
        }
      }
      const policy = POLICY;
      const isInteractiveClaude = parsed.agent === "claude" && parsed.prompt === undefined;
      // GH-1056: pre-tmux setup is shared with `prx plan prime` and
      // `prx session open-claude`; primePlanSession() emits the same warnings
      // (rebase, hydrate, mcp, allowlist) inline so the session handler
      // experience is unchanged.
      const primed = await primePlanSession(
        {
          workUnitId: parsed.workUnitId,
          launchFromCurrentWorkspace: parsed.launchFromCurrentWorkspace,
          create: parsed.create,
          noVerify: parsed.noVerify,
          from: parsed.from,
          agent: parsed.agent,
          isInteractiveClaude,
          format: parsed.format,
          repoSlug: parsed.repoSlug,
        },
        output,
        deps,
      );
      const launchCwd = primed.launchCwd;
      const runtimeArtifacts = primed.runtimeArtifacts;
      const hasPriorClaudeSession = primed.hasPriorClaudeSession;
      // GH-977: route the interactive-claude profile through the
      // session-entry XState machine so the alias hint
      // (`prx session open` → `prx plan session`) and PRX_SESSION_CONTEXT
      // env injection are consolidated into one transition action.
      const sessionProfile: RuntimeProfileProjection = isInteractiveClaude
        ? dispatchSessionEntryEvent({
            type: "OPEN_PLAN_SESSION",
            workUnitId: parsed.workUnitId,
            viaAlias: parsed.invokedViaSessionOpen === true,
            hasPriorSession: hasPriorClaudeSession,
          })
        : buildExecutedWorkProfile(
            buildWorkAutomationProfile(parsed.agent, parsed.workUnitId, parsed.ioFormat, parsed.mode),
            { prompt: parsed.prompt },
          );
      const codexResolved = parsed.agent === "codex" && !parsed.prompt
        ? resolveCodexSessionProfile(sessionProfile, parsed.workUnitId, launchCwd)
        : { profile: sessionProfile, message: null };
      if (codexResolved.message) {
        output.error(codexResolved.message);
      }
      if (parsed.dryRun) {
        output.log(formatRuntimeProfile(codexResolved.profile, parsed.format));
        return 0;
      }
      // GH-678: session execution runs inside a durable tmux session so the
      // agent survives terminal close and (with tmux-resurrect) reboot.
      // The outer `prx session open` process spawns/attaches the mux session;
      // the agent runtime lives inside the session's agent pane as a
      // bootstrap_command. Telemetry + appendExecutionLog that was attached
      // to the old synchronous execRuntime path is dropped here (plan D1):
      // the agent no longer has an owning parent process for us to
      // observe. `agent-smoke` keeps the execRuntime path separately — it's
      // non-interactive and doesn't need the mux layer.
      //
      // GH-685: for interactive claude (no prompt), codexResolved.profile is
      // the new buildWorkUnitClaudeInteractiveRuntimeProfile output — so the
      // bootstrap_command is --permission-mode plan + --append-system-prompt,
      // not the bound-agent print-mode shape. Tmux-attach supplies the TTY.
      const muxRunner = deps.muxRunner ?? defaultRunner;
      const muxName = muxSessionName(launchCwd);
      const fullBootstrapCommand = [codexResolved.profile.command, ...codexResolved.profile.args]
        .map(shellQuoteArg)
        .join(" ");
      // GH-780: `tmux send-keys` replays the bootstrap command as typed input
      // through the pane's PTY. `new-session -d` returns before zsh finishes
      // its init (.zshrc, .zprofile) — during that window the PTY is still in
      // default canonical mode, whose line buffer drops bytes past MAX_CANON
      // (1024 on Darwin). The interactive executor's --append-system-prompt
      // pushes the full command past that threshold, so the tail (including
      // the closing quote's content, not the quote itself) gets silently
      // dropped before ZLE takes over. Write the command to a per-worktree
      // runtime artifact and send a short POSIX `.` replay instead — the
      // typed input stays well under MAX_CANON and tmux-resurrect replays
      // the same short line on restore. `writeFileSync(..., { mode })` only
      // applies mode on create, so an explicit chmod guarantees the bootstrap
      // is 0o600 even when the file pre-existed from a prior session open.
      const bootstrapPath = getLocalRuntimeArtifactPaths().bootstrapPath;
      const bootstrapAbsPath = join(launchCwd, bootstrapPath);
      mkdirSync(dirname(bootstrapAbsPath), { recursive: true });
      writeFileSync(bootstrapAbsPath, `${fullBootstrapCommand}\n`, { mode: 0o600 });
      chmodSync(bootstrapAbsPath, 0o600);
      const bootstrapCommand = `. ${shellQuoteArg(bootstrapPath)}`;
      const initialMuxState = muxSessionState(muxName, launchCwd, muxRunner);
      const spawnFresh = () => {
        spawnMuxSession({
          name: muxName,
          cwd: launchCwd,
          layout: { bootstrap_command: bootstrapCommand },
          run: muxRunner,
        });
      };

      if (initialMuxState === "absent") {
        spawnFresh();
      } else if (initialMuxState === "exited-resurrectable") {
        // Slice 5: restoreMuxSession discovers the resurrect plugin's
        // restore.sh via the `@prx-resurrect-script` user option that
        // home-manager bakes in at build time. If the option isn't set
        // (user hasn't re-switched, server predates Slice 5, or tmux-prx
        // isn't enabled), the call throws and we fall back to fresh spawn.
        //
        // Copilot #716: post-restore flow also re-runs muxSessionState so
        // the D2 collision guard gets a second pass — `restore.sh` is
        // server-wide and can materialize a session whose `session_path`
        // doesn't match the caller's `launchCwd`.
        try {
          restoreMuxSession({ run: muxRunner });
          const postRestoreState = muxSessionState(muxName, launchCwd, muxRunner);
          // Restore didn't actually bring this session back (or resurrect
          // wasn't configured to include it) — spawn a fresh one.
          if (postRestoreState === "absent" || postRestoreState === "exited-resurrectable") {
            spawnFresh();
          }
          // On running-detached / running-attached after restore, fall
          // through to attach. muxSessionState's collision guard will have
          // raised if session_path mismatched.
        } catch {
          spawnFresh();
        }
      }
      // running-detached and running-attached (and post-restore running-*)
      // all fall through to attach.

      // GH-678 Copilot #716: in JSON mode we skip attach entirely so the
      // JSON payload lands on stdout without tmux UI escapes mixing in,
      // and without blocking until the user detaches. Emit the same
      // metadata shape with `attached: false` and return 0.
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              profile: codexResolved.profile,
              cwd: launchCwd,
              runtimeArtifacts,
              policy,
              mux: {
                socket: PRX_TMUX_SOCKET,
                session: muxName,
                state: initialMuxState,
              },
              attached: false,
              status: 0,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      const attachResult = attachMuxSession({ name: muxName, run: deps.attachRunner });
      return attachResult.status;

      } finally {
        deleteEnv(PRX_SESSION_OPEN_ENV);
      }
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "session-open-claude") {
      return (async (): Promise<number> => {
        try {
      if (parsed.invokedViaDeprecatedWorkAlias) {
        output.error(PRX_SESSION_DEPRECATION_WORK);
      }
      // GH-950: plan-session banner (see the mirror block in the `session`
      // handler). GH-977: alias-deprecation hint for `prx session open` is
      // emitted from the session-entry machine action.
      if (parsed.invokedViaPlanSession) {
        output.error(SESSION_PROFILES.plan.banner);
      }
      // GH-1239: auto-step preflight on the canonical interactive-claude
      // dispatch. Mirrors the gate in the legacy `session` handler so both
      // entry shapes refuse identically. `--dry-run` skips so the operator
      // can still inspect the resolved profile without preflight network
      // calls; `prx implement` (which routes here without
      // `invokedViaPlanSession`) is unaffected.
      if (
        parsed.invokedViaPlanSession &&
        !parsed.dryRun &&
        !parsed.skipPreflight
      ) {
        const refusal = await runPreflightAutoStepRefusal(
          parsed.workUnitId,
          deps,
          output,
        );
        if (refusal !== null) return refusal;
      } else if (parsed.invokedViaPlanSession && parsed.skipPreflight) {
        output.error(
          `note: --skip-preflight bypasses the GH-1239 pre-draft check for ${parsed.workUnitId}`,
        );
      }
      // GH-819: launch claude as tmux pane PID 1 — no shell parent, no
      // `send-keys` replay, no bootstrap.sh indirection on the hot path.
      // Reuses `buildWorkUnitClaudeInteractiveRuntimeProfile` so argv is
      // the single source of truth shared with `prx session open`.
      // GH-1044: `prx implement` shares this dispatch (and re-entrancy
      // guard) with `prx session open` and `prx session open-claude` —
      // they all parse to `command: "session-open-claude"`.
      const PRX_SESSION_OPEN_ENV = "PRX_SESSION_OPEN";
      if (getEnv(PRX_SESSION_OPEN_ENV)) {
        throw new CliError(
          `Re-entrant prx session open-claude detected for ${parsed.workUnitId} — aborting to prevent loop. ` +
          `(${PRX_SESSION_OPEN_ENV} is already set in the environment.)`,
        );
      }
      setEnv(PRX_SESSION_OPEN_ENV, "1");
      try {
        {
          const update = (deps.checkPrxBinaryUpstream ?? checkPrxBinaryUpstream)();
          if (update) {
            output.error(
              formatBinaryUpdateWarning(update),
            );
          }
        }
        const policy = POLICY;
        // GH-1056: shared pre-tmux setup with `prx session open` and
        // `prx plan prime`. session-open-claude is always interactive claude
        // (no --create, no --no-verify, no --from), so the input is fixed.
        const primed = await primePlanSession(
          {
            workUnitId: parsed.workUnitId,
            launchFromCurrentWorkspace: parsed.launchFromCurrentWorkspace,
            create: false,
            noVerify: false,
            agent: "claude",
            isInteractiveClaude: true,
            format: parsed.format,
            repoSlug: parsed.repoSlug,
          },
          output,
          deps,
        );
        const launchCwd = primed.launchCwd;
        const runtimeArtifacts = primed.runtimeArtifacts;
        const hasPriorClaudeSession = primed.hasPriorClaudeSession;
        // GH-977: same session-entry machine path as the `session` handler;
        // viaAlias is true when the user typed `prx session open` (the
        // alias) rather than `prx plan session` (canonical).
        // GH-2014: thread the --background flag through the event payload so
        // the projection carries `attachMode` for the post-spawn gate below.
        const sessionProfile: RuntimeProfileProjection = dispatchSessionEntryEvent({
          type: "OPEN_PLAN_SESSION",
          workUnitId: parsed.workUnitId,
          viaAlias: parsed.invokedViaSessionOpen === true,
          hasPriorSession: hasPriorClaudeSession,
          planPath: parsed.planPath,
          attachMode: parsed.attachMode,
        });
        if (parsed.dryRun) {
          output.log(formatRuntimeProfile(sessionProfile, parsed.format));
          return 0;
        }
        const muxRunner = deps.muxRunner ?? defaultRunner;
        // GH-1172: tag the tmux session with `-plan` so it coexists with
        // a same-worktree implement session on the prx socket.
        const muxName = muxSessionName(launchCwd, "plan");
        // GH-819: still write .pr/local/runtime/bootstrap.sh as a side
        // artifact so manual replay / debugging keeps working. The pane
        // itself does NOT source it — tmux execs the argv directly.
        const fullBootstrapCommand = [sessionProfile.command, ...sessionProfile.args]
          .map(shellQuoteArg)
          .join(" ");
        const bootstrapPath = getLocalRuntimeArtifactPaths().bootstrapPath;
        const bootstrapAbsPath = join(launchCwd, bootstrapPath);
        mkdirSync(dirname(bootstrapAbsPath), { recursive: true });
        writeFileSync(bootstrapAbsPath, `${fullBootstrapCommand}\n`, { mode: 0o600 });
        chmodSync(bootstrapAbsPath, 0o600);
        const paneArgv = [sessionProfile.command, ...sessionProfile.args];
        const initialMuxState = muxSessionState(muxName, launchCwd, muxRunner);
        const spawnFresh = () => {
          spawnMuxSession({
            name: muxName,
            cwd: launchCwd,
            layout: { pane_command: { argv: paneArgv, remain_on_exit: true } },
            run: muxRunner,
          });
        };
        if (initialMuxState === "absent") {
          spawnFresh();
        } else if (initialMuxState === "exited-resurrectable") {
          try {
            restoreMuxSession({ run: muxRunner });
            const postRestoreState = muxSessionState(muxName, launchCwd, muxRunner);
            if (postRestoreState === "absent" || postRestoreState === "exited-resurrectable") {
              spawnFresh();
            }
          } catch {
            spawnFresh();
          }
        }
        if (parsed.format === "json") {
          output.log(
            JSON.stringify(
              {
                profile: sessionProfile,
                cwd: launchCwd,
                runtimeArtifacts,
                policy,
                mux: {
                  socket: PRX_TMUX_SOCKET,
                  session: muxName,
                  state: initialMuxState,
                  paneCommand: paneArgv,
                },
                attached: false,
                status: 0,
              },
              null,
              2,
            ),
          );
          return 0;
        }
        if (parsed.noAttach) {
          return 0;
        }
        // GH-2014: --background skips the interactive attach and prints a
        // re-entry hint instead, so the operator can boot the session and
        // return control to their shell. A follow-up `prx plan session <id>`
        // reuses the running mux session via the existing `running-detached`
        // branch above.
        if (sessionProfile.attachMode === "background") {
          output.error(
            `session booted in background — re-enter with: prx plan session ${parsed.workUnitId}`,
          );
          return 0;
        }
        const attachResult = attachMuxSession({ name: muxName, run: deps.attachRunner });
        return attachResult.status;
      } finally {
        deleteEnv(PRX_SESSION_OPEN_ENV);
      }
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "session-open-implement") {
      return (async (): Promise<number> => {
        try {
          // GH-1981: emit the one-shot deprecation hint when the operator
          // entered via the renamed `prx implement session <UoW>` shape.
          // Single firing per invocation; the parser sets the flag.
          if (parsed.invokedViaDeprecatedImplementSession) {
            output.error(
              "prx implement session is deprecated; use `prx implement agent [GH-NNN]`.",
            );
          }
          // GH-1172: refuse `prx implement` invoked from inside an already-
          // open plan-mode tmux session. The previous implementation
          // dispatched `OPEN_PLAN_SESSION` — which (because the session name
          // collided with the live plan session) silently attached the
          // operator back into the read-only plan toolset. Now that
          // session names carry a mode suffix, `prx implement` from the
          // plan tmux would spawn a fresh implement session as a sibling
          // process; that's still operator-hostile (two interactive
          // claude windows fighting over one TTY), so we refuse and emit
          // a fresh-shell handoff. Matches the prune-session
          // self-destruct guard pattern (status 2).
          const ctx = getCurrentSessionContext();
          if (ctx === "plan" && getEnv("TMUX")) {
            output.error(
              `refused: prx implement agent ${parsed.workUnitId} would attach a new tmux session from inside a plan-mode session.`,
            );
            output.error("Run from a fresh shell:");
            output.error(
              `  prx implement agent ${parsed.workUnitId}${parsed.planPath ? ` --plan ${parsed.planPath}` : ""}`,
            );
            return 2;
          }

          // GH-1238 / GH-1284: auto-prime from the saved plan slot. Precedence:
          // explicit --plan PATH (GH-1044) > approved slot > draft slot > refusal.
          // Mirrors `prx plan show` default precedence so an approved plan is
          // consumed when present, falling back to draft. Refuses BEFORE the
          // PRX_SESSION_OPEN env latch so no tmux session is spawned and the
          // operator can re-enter cleanly. Same exit-code-2 shape as the
          // plan-mode-from-tmux refusal above.
          //
          // GH-2028: the consumer is the trust boundary. The producer always
          // persists; here we read the envelope's content-validation verdict
          // and refuse `validated_ok: false` drafts, surfacing each diagnostic
          // plus the canonical actor-scoped `prx plan session` hint. The
          // persisted body is echoed so the failed draft is recoverable.
          let primedPlanBody: string | undefined;
          if (!parsed.planPath) {
            const planShow = deps.runPlanShow ?? runPlanShow;
            try {
              const slot = await planShow({ unit: parsed.workUnitId });
              if (!slot.validated_ok) {
                output.error(
                  `refused: ${slot.slot} slot for ${parsed.workUnitId} failed plan-shape validation (validated_ok=false). Refine via \`prx plan session ${parsed.workUnitId}\`.`,
                );
                for (const d of slot.diagnostics) {
                  output.error(`  [${d.code}] ${d.path}: ${d.message}`);
                }
                output.error(
                  `persisted draft body (view with \`prx plan show ${parsed.workUnitId} --slot ${slot.slot}\`):`,
                );
                output.error(slot.body.toString("utf8"));
                return 2;
              }
              primedPlanBody = slot.body.toString("utf8");
            } catch (error) {
              if (error instanceof PlanRefNotFound) {
                output.error(
                  `refused: no plan slot for ${parsed.workUnitId} (checked approved + draft). Run \`prx plan session ${parsed.workUnitId}\` first to draft a plan.`,
                );
                return 2;
              }
              throw error;
            }
          }

          const PRX_SESSION_OPEN_ENV = "PRX_SESSION_OPEN";
          if (getEnv(PRX_SESSION_OPEN_ENV)) {
            throw new CliError(
              `Re-entrant prx implement agent detected for ${parsed.workUnitId} — aborting to prevent loop. ` +
              `(${PRX_SESSION_OPEN_ENV} is already set in the environment.)`,
            );
          }
          setEnv(PRX_SESSION_OPEN_ENV, "1");
          try {
            {
              const update = (deps.checkPrxBinaryUpstream ?? checkPrxBinaryUpstream)();
              if (update) {
                output.error(
                  formatBinaryUpdateWarning(update),
                );
              }
            }
            const policy = POLICY;
            const primed = await primePlanSession(
              {
                workUnitId: parsed.workUnitId,
                launchFromCurrentWorkspace: parsed.launchFromCurrentWorkspace,
                create: false,
                noVerify: false,
                agent: "claude",
                isInteractiveClaude: parsed.interactive === true,
                format: parsed.format,
              },
              output,
              deps,
            );
            const launchCwd = primed.launchCwd;
            // headless-first step 2b-ii: the DEFAULT (and explicit --headless)
            // runs the implement work as a headless SDK job in-process and
            // awaits it — no tmux. State is the typed envelope, liveness is the
            // worktree runtime lock. `--interactive` is the explicit opt-in to
            // the tmux/PTY pairing path below. Guardrail: the GH-1238 plan-gate
            // above already refused unless an approved/draft plan exists, and
            // the profile's acceptEdits+allowlist posture bounds the run.
            //
            // "Outlives the shell" (detached self-reexec) is a deferred
            // follow-up: it needs a real-machine smoke test before it's trusted
            // on the autonomous path, so the default stays run-and-wait for now.
            if (!parsed.interactive) {
              const headlessProfile = buildWorkUnitClaudeImplementSdkRuntimeProfile({
                workUnitId: parsed.workUnitId,
                ...(parsed.planPath !== undefined ? { planPath: parsed.planPath } : {}),
                // prx-pe1: embed the validated plan slot the gate already loaded
                // so the headless executor has confirmed scope from the artifact
                // (parity with the interactive path's `planBody: primedPlanBody`).
                ...(primedPlanBody !== undefined ? { planBody: primedPlanBody } : {}),
              });
              if (parsed.dryRun) {
                output.log(formatRuntimeProfile(headlessProfile, parsed.format));
                return 0;
              }
              // prx-pe1 (slice 4b): snapshot HEAD so we only pin an implement
              // artifact when the executor actually produced a NEW commit.
              const headBefore = (() => {
                const r = runCommand(["git", "-C", launchCwd, "rev-parse", "HEAD"]);
                return r.status === 0 ? r.stdout.trim() : null;
              })();
              const dispatched = await maybeWithWorktreeRuntimeLock(
                true,
                launchCwd,
                `prx implement agent runtime active for ${parsed.workUnitId} (pid ${process.pid})`,
                deps,
                () => executeAgentProfile(headlessProfile, {
                  cwd: launchCwd,
                  format: "json",
                  // prx-who: implement does real, multi-file refactors — default
                  // to the longer anti-hang ceiling so a legitimate run isn't cut
                  // off mid-work at the 15-min blanket default (which it was).
                  timeoutMs: DEFAULT_IMPLEMENT_WATCHDOG_MS,
                  ...(deps.execRuntime ? { subprocessExecutor: deps.execRuntime } : {}),
                }),
              );
              const result = agentProfileExecutionAsRuntimeResult(dispatched);
              if (result.stdout) output.log(result.stdout);
              if (result.status !== 0 && result.stderr) output.error(result.stderr);
              // prx-pe1 (slice 4b): on a clean run that left a new commit, pin
              // `<unit>:implement@latest` so the implement step is a typed
              // artifact, not a bare commit. Best-effort: never break the run on
              // capture failure. The `checks/v1` attestation (prx-ux2) is keyed
              // by the same commit and wired separately.
              if (result.status === 0) {
                try {
                  // prx-ub4 (slice 4c): when a signer + canonical ledger are
                  // configured, run the project checks against the produced
                  // commit and emit a signed `checks/v1` per clean step (prx
                  // signs its OWN verdict, not the executor's word). Gated so the
                  // default path (no PRX_PROVENANCE_KEY) is unchanged.
                  const signer = resolveProvenanceSigner();
                  const canonicalLedger = resolveCanonicalChainLedger(launchCwd)?.ledgerPath;
                  const attestChecks = signer !== null && canonicalLedger !== undefined
                    ? async (cwd: string, commit: string): Promise<boolean> => {
                        mkdirSync(dirname(canonicalLedger), { recursive: true });
                        const store = openAnchoredChain(canonicalLedger);
                        try {
                          return await runAttestedChecks(
                            localProcExecutor(),
                            { signer, store: store.derivations },
                            commit,
                            cwd,
                            IMPLEMENT_CHECK_STEPS,
                          );
                        } finally {
                          store.close();
                        }
                      }
                    : undefined;
                  const fin = await finalizeImplementRun(
                    {
                      unit: parsed.workUnitId,
                      summary: summarizeAgentStdout(result.stdout ?? ""),
                      cwd: launchCwd,
                    },
                    {
                      resolveHead: (cwd) => {
                        const r = runCommand(["git", "-C", cwd, "rev-parse", "HEAD"]);
                        const head = r.status === 0 ? r.stdout.trim() : null;
                        return head && head !== headBefore ? head : null;
                      },
                      listChangedFiles: (cwd, commit) => {
                        const r = runCommand([
                          "git", "-C", cwd, "show", "--name-only", "--pretty=format:", commit,
                        ]);
                        return r.status === 0
                          ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
                          : [];
                      },
                      ...(attestChecks ? { attestChecks } : {}),
                    },
                  );
                  if (fin.ref) {
                    const checks = fin.checksAttested ? "; checks/v1 signed" : "";
                    output.log(
                      `implement: ${parsed.workUnitId} → ${fin.ref} (commit ${fin.artifact?.commit.slice(0, 7)}${checks})`,
                    );
                  }
                } catch {
                  // capture is best-effort; the implement run already succeeded.
                }
              }
              return result.status;
            }
            const runtimeArtifacts = primed.runtimeArtifacts;
            const hasPriorClaudeSession = primed.hasPriorClaudeSession;
            // GH-1172: dispatch the dedicated implement event so the executor
            // gets the Edit/Write-enabled toolset (was OPEN_PLAN_SESSION).
            // GH-1238: forward the auto-primed draft slot body when the operator
            // did NOT pass --plan PATH; the system prompt embeds the plan inline.
            // GH-2014: thread --background through so the projection carries
            // attachMode for the post-spawn gate below.
            const sessionProfile: RuntimeProfileProjection = dispatchSessionEntryEvent({
              type: "OPEN_IMPLEMENT_SESSION",
              workUnitId: parsed.workUnitId,
              hasPriorSession: hasPriorClaudeSession,
              planPath: parsed.planPath,
              planBody: primedPlanBody,
              attachMode: parsed.attachMode,
            });
            if (parsed.dryRun) {
              output.log(formatRuntimeProfile(sessionProfile, parsed.format));
              return 0;
            }
            const muxRunner = deps.muxRunner ?? defaultRunner;
            // GH-1172: tag the tmux session with `-implement` so it coexists
            // with a same-worktree plan session on the prx socket.
            const muxName = muxSessionName(launchCwd, "implement");
            const fullBootstrapCommand = [sessionProfile.command, ...sessionProfile.args]
              .map(shellQuoteArg)
              .join(" ");
            const bootstrapPath = getLocalRuntimeArtifactPaths().bootstrapPath;
            const bootstrapAbsPath = join(launchCwd, bootstrapPath);
            mkdirSync(dirname(bootstrapAbsPath), { recursive: true });
            writeFileSync(bootstrapAbsPath, `${fullBootstrapCommand}\n`, { mode: 0o600 });
            chmodSync(bootstrapAbsPath, 0o600);
            const paneArgv = [sessionProfile.command, ...sessionProfile.args];
            const initialMuxState = muxSessionState(muxName, launchCwd, muxRunner);
            const spawnFresh = () => {
              spawnMuxSession({
                name: muxName,
                cwd: launchCwd,
                layout: { pane_command: { argv: paneArgv, remain_on_exit: true } },
                run: muxRunner,
              });
            };
            if (initialMuxState === "absent") {
              spawnFresh();
            } else if (initialMuxState === "exited-resurrectable") {
              try {
                restoreMuxSession({ run: muxRunner });
                const postRestoreState = muxSessionState(muxName, launchCwd, muxRunner);
                if (postRestoreState === "absent" || postRestoreState === "exited-resurrectable") {
                  spawnFresh();
                }
              } catch {
                spawnFresh();
              }
            }
            if (parsed.format === "json") {
              output.log(
                JSON.stringify(
                  {
                    profile: sessionProfile,
                    cwd: launchCwd,
                    runtimeArtifacts,
                    policy,
                    mux: {
                      socket: PRX_TMUX_SOCKET,
                      session: muxName,
                      state: initialMuxState,
                      paneCommand: paneArgv,
                    },
                    attached: false,
                    status: 0,
                  },
                  null,
                  2,
                ),
              );
              return 0;
            }
            if (parsed.noAttach) {
              return 0;
            }
            // GH-2014: --background skips the interactive attach and prints a
            // re-entry hint pointing at the canonical implement re-entry verb.
            if (sessionProfile.attachMode === "background") {
              output.error(
                `session booted in background — re-enter with: prx implement agent ${parsed.workUnitId}`,
              );
              return 0;
            }
            const attachResult = attachMuxSession({ name: muxName, run: deps.attachRunner });
            return attachResult.status;
          } finally {
            deleteEnv(PRX_SESSION_OPEN_ENV);
          }
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "plan-prime") {
      return (async (): Promise<number> => {
        try {
          // GH-1056: re-entrancy guard mirrors the session handlers — plan-prime
          // materializes the worktree (which can invoke `wt switch`'s
          // post-switch hooks), so the same env-var loop guard applies even
          // though we never spawn tmux.
          const PRX_SESSION_OPEN_ENV = "PRX_SESSION_OPEN";
          if (getEnv(PRX_SESSION_OPEN_ENV)) {
            throw new CliError(
              `Re-entrant prx plan prime detected for ${parsed.workUnitId} — aborting to prevent loop. ` +
              `(${PRX_SESSION_OPEN_ENV} is already set in the environment.)`,
            );
          }
          setEnv(PRX_SESSION_OPEN_ENV, "1");
          try {
            {
              const update = (deps.checkPrxBinaryUpstream ?? checkPrxBinaryUpstream)();
              if (update) {
                output.error(
                  formatBinaryUpdateWarning(update),
                );
              }
            }
            const primed = await primePlanSession(
              {
                workUnitId: parsed.workUnitId,
                launchFromCurrentWorkspace: parsed.launchFromCurrentWorkspace,
                create: parsed.create,
                noVerify: parsed.noVerify,
                from: parsed.from,
                agent: parsed.agent,
                isInteractiveClaude: parsed.isInteractiveClaude,
                format: parsed.format,
              },
              output,
              deps,
            );
            const mcpStatus = primed.runtimeArtifacts.mcpServers.join(",") || "none";
            const statusLine = `primed: worktree=${primed.launchCwd}, branch=${parsed.workUnitId}, beads=${primed.hydrateStatus}, mcp=${mcpStatus}, allowlist=${primed.allowlistStatus}`;
            if (parsed.format === "json") {
              output.log(
                JSON.stringify(
                  {
                    workUnitId: parsed.workUnitId,
                    launchCwd: primed.launchCwd,
                    runtimeArtifacts: primed.runtimeArtifacts,
                    hydrateStatus: primed.hydrateStatus,
                    rebaseStatus: primed.rebaseStatus,
                    allowlistStatus: primed.allowlistStatus,
                  },
                  null,
                  2,
                ),
              );
            } else {
              output.log(statusLine);
            }
            // Loud-failure path: prime is the explicit pre-flight, so a
            // clone-failed hydration exits non-zero (the session handlers
            // surface-and-continue because they can still hand a partial
            // workspace to the agent; prime cannot).
            if (primed.hydrateStatus === "clone-failed" || primed.hydrateStatus === "error") {
              return 1;
            }
            return 0;
          } finally {
            deleteEnv(PRX_SESSION_OPEN_ENV);
          }
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "session-plan") {
      return (async (): Promise<number> => {
        try {
      // GH-1982: alias-deprecation hint when the operator typed
      // `prx session plan` instead of the canonical `prx plan session`.
      // Emitted exactly once at the start of dispatch, before any banner.
      if (parsed.viaAlias) {
        output.error(PRX_SESSION_PLAN_ALIAS_HINT);
      }
      // GH-1164: banner prefix swaps with invocation namespace so user-facing
      // lines match the verb the operator typed. GH-1982: the alias path now
      // sets `invokedViaPlanSession: true` too (for the auto-save chain), so
      // we also check `viaAlias` to keep the banner reading "session plan".
      const bannerPrefix = parsed.viaAlias
        ? "prx session plan"
        : parsed.invokedViaPlanSession
          ? "prx plan session"
          : "prx session plan";
      if (parsed.check) {
        // GH-2113 / GH-2120: forward `parsed.from` (+ findEpicChildren / wtStatus)
        // so the GH-2140 entry guard — which rejects `--from=notion|beads` against
        // a GH-keyed id before any `gh` round-trip — actually fires on the
        // operator-facing `prx plan session ... --check` path. This mirrors the
        // sibling `command: "session"` dispatch above; omitting `from` here left
        // the guard dead through `session-plan`, so the operator hit a confusing
        // upstream `gh` not-found instead of the precise rejection (GH-2112).
        await validateWorkSessionEntry(
          parsed.workUnitId,
          process.cwd(),
          parsed.create,
          deps.boardStatus ?? boardStatus,
          deps.buildParityChain ?? buildParityChain,
          deps.validateGitHubIssue ?? validateGitHubIssue,
          () => {},
          parsed.from,
          deps.findEpicChildren ?? findEpicChildren,
          deps.wtStatus ?? wtStatus,
        );
        const report = (deps.inspectSessionOpenState ?? inspectSessionOpenState)(
          parsed.workUnitId,
          process.cwd(),
        );
        output.log(formatSessionOpenCheck(report, parsed.format));
        return 0;
      }

      const PRX_SESSION_OPEN_ENV = "PRX_SESSION_OPEN";
      if (getEnv(PRX_SESSION_OPEN_ENV)) {
        throw new CliError(
          `Re-entrant ${bannerPrefix} detected for ${parsed.workUnitId} — aborting to prevent loop. ` +
          `(${PRX_SESSION_OPEN_ENV} is already set in the environment.)`,
        );
      }
      setEnv(PRX_SESSION_OPEN_ENV, "1");
      try {
        {
          const update = (deps.checkPrxBinaryUpstream ?? checkPrxBinaryUpstream)();
          if (update) {
            output.error(
              formatBinaryUpdateWarning(update),
            );
          }
        }
        const policy = POLICY;
        // GH-1164: when reached via the canonical `prx plan session` entry,
        // route the pre-runtime setup through primePlanSession so --repo
        // (GH-1643), bd canonical hydration (GH-1766), and auto-rebase all
        // work on the print path. GH-1982: the alias path also sets
        // `invokedViaPlanSession: true`, so this primePlanSession branch now
        // covers both entries; the inline back-compat branch below is dead
        // pending the alias's hard removal in the next cycle.
        let launchCwd: string;
        let runtimeArtifacts: RuntimeArtifactStatus;
        let hasPriorSession: boolean;
        let effectiveWorkUnitId: string;
        if (parsed.invokedViaPlanSession) {
          const primed = await primePlanSession(
            {
              workUnitId: parsed.workUnitId,
              create: parsed.create,
              noVerify: parsed.noVerify,
              from: parsed.from,
              agent: "claude",
              isInteractiveClaude: parsed.interactive,
              format: parsed.format,
              repoSlug: parsed.repoSlug,
            },
            output,
            deps,
          );
          launchCwd = primed.launchCwd;
          runtimeArtifacts = primed.runtimeArtifacts;
          hasPriorSession = primed.hasPriorClaudeSession;
          effectiveWorkUnitId = primed.workUnitId;
        } else {
          await validateWorkSessionEntry(
            parsed.workUnitId,
            process.cwd(),
            parsed.create,
            deps.boardStatus ?? boardStatus,
            deps.buildParityChain ?? buildParityChain,
            deps.validateGitHubIssue ?? validateGitHubIssue,
            deps.pruneStaleRemoteRefs ?? pruneStaleRemoteRefs,
          );
          if (parsed.create) {
            if (deps.materializeWorktree) {
              deps.materializeWorktree(parsed.workUnitId, process.cwd(), parsed.noVerify);
            } else {
              materializeWorkUnitBranch(parsed.workUnitId, process.cwd(), undefined, undefined, parsed.noVerify);
            }
          }
          launchCwd = deps.resolveWorkUnitCwd
            ? deps.resolveWorkUnitCwd(parsed.workUnitId, process.cwd(), parsed.noVerify)
            : resolveWorkUnitLaunchCwdUsingDefaults(parsed.workUnitId, process.cwd(), parsed.noVerify);
          {
            const { behind } = parseDivergence(launchCwd);
            if (behind > 0) {
              output.error(`warning: branch is ${behind} commit${behind === 1 ? "" : "s"} behind origin/main — run \`prx worktree refresh\` to rebase`);
            }
          }
          try {
            const hydrateResult = (deps.hydrateBeads ?? hydrateBeads)({ cwd: launchCwd });
            if (hydrateResult.status === "hydrated" || hydrateResult.status === "clone-failed") {
              output.error(hydrateResult.message);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.error(`warning: beads hydration failed unexpectedly: ${message}`);
          }
          runtimeArtifacts = (deps.ensureRuntimeArtifacts ?? ensureLocalRuntimeArtifacts)(
            parsed.workUnitId,
            launchCwd,
          );
          if (parsed.interactive) {
            const allowlist = (deps.ensureClaudeAllowlist ?? ensureClaudeInteractiveAllowlist)(launchCwd);
            if (allowlist.status === "skipped-malformed") {
              output.error(buildMalformedAllowlistWarning(allowlist.path));
            }
          }
          hasPriorSession = parsed.interactive
            ? (deps.findSavedClaudeSession ?? findSavedClaudeSession)(launchCwd)
            : false;
          effectiveWorkUnitId = parsed.workUnitId;
        }
        // GH-1825: when --resume-from-draft is set, read the prior partial
        // capture from `<UoW>:plan@draft` and thread it into the planner
        // prompt as continuation context. Empty/missing slot raises a typed
        // refusal pointing the operator at the fresh-draft verb.
        let resumePartialPlan: string | undefined;
        if (parsed.resumeFromDraft) {
          if (parsed.interactive) {
            throw new CliError(
              `${bannerPrefix}: --resume-from-draft only applies to the non-interactive SDK call site; drop --interactive or remove --resume-from-draft`,
            );
          }
          try {
            const loaded = await (deps.runPlanLoad ?? runPlanLoad)({
              unit: effectiveWorkUnitId,
              slot: "draft",
            });
            const text = loaded.content.toString("utf8");
            if (text.trim().length === 0) {
              throw new CliError(
                `${bannerPrefix}: draft slot ${refName(effectiveWorkUnitId, "draft")} is empty — run \`${bannerPrefix} ${effectiveWorkUnitId}\` first to draft a plan`,
              );
            }
            resumePartialPlan = text;
          } catch (err) {
            if (err instanceof PlanRefNotFound) {
              throw new CliError(
                `${bannerPrefix}: no draft slot for ${effectiveWorkUnitId} — run \`${bannerPrefix} ${effectiveWorkUnitId}\` first to draft a plan`,
              );
            }
            throw err;
          }
        }
        const profile = parsed.interactive
          ? buildWorkUnitClaudeInteractiveRuntimeProfile({
              workUnitId: effectiveWorkUnitId,
              role: "planner",
              hasPriorSession,
            })
          : buildWorkUnitClaudePlanPrintRuntimeProfile({
              workUnitId: effectiveWorkUnitId,
              ...(resumePartialPlan !== undefined ? { resumePartialPlan } : {}),
            });
        if (parsed.dryRun) {
          output.log(formatRuntimeProfile(profile, parsed.format));
          return 0;
        }
        // Interactive claude needs a TTY (stdio inherit via "plain"). Non-interactive
        // --print streams to stdout too; we switch to "json" (stdio pipe) when
        // the caller needs captured stdout for --emit-file, the post-exec JSON
        // envelope, or the GH-1164 runPlanSave chain into the draft slot.
        const needsCapture = !parsed.interactive && (
          parsed.emitFile !== undefined ||
          parsed.format === "json" ||
          parsed.invokedViaPlanSession === true
        );
        const planExecutionFormat = needsCapture ? ("json" as const) : ("plain" as const);
        const startedAt = Date.now();
        // GH-1828: non-interactive plan-print routes through the Anthropic
        // Agent SDK; interactive runs stay on `localRuntimeExecutor` (TTY
        // inherit). When `deps.execRuntime` is injected by tests, the
        // subprocess path runs regardless of `profile.agentRuntime` so the
        // pre-1828 test seam keeps working.
        const draftSinkForSdk = !parsed.interactive && profile.agentRuntime === "sdk" && !deps.execRuntime
          ? makeWorkUnitDraftSink(effectiveWorkUnitId, { runPlanSave: deps.runPlanSave ?? runPlanSave })
          : undefined;
        // GH-1407 — fold draftSink + noCache into a single sdkOpts object.
        // noCache is plan-print-only; the interactive flow rejects it at the parser.
        const sdkOptsForCall: Partial<RunClaudeAgentNonInteractiveOpts> = {
          ...(draftSinkForSdk ? { draftSink: draftSinkForSdk } : {}),
          ...(parsed.noCache ? { noCache: true } : {}),
        };
        // GH-1825: opt-in watchdog. Interactive runs keep their existing
        // posture (interactiveTimeoutMs gates the policy default by format).
        // Print runs no longer carry an implicit policy.timeout_ms default —
        // `undefined` means "no watchdog", matching spike §3.2 §6 item 4.
        // The operator opts in via `--timeout=<duration>`; the subprocess
        // fallback (--interactive or test-injected execRuntime) honors the
        // same value when present.
        const effectiveTimeoutMs = parsed.interactive
          ? interactiveTimeoutMs(planExecutionFormat, policy.timeout_ms)
          : parsed.timeoutMs;
        const dispatched = await maybeWithWorktreeRuntimeLock(
          true,
          launchCwd,
          `${bannerPrefix} runtime active for ${effectiveWorkUnitId} (pid ${process.pid})`,
          deps,
          () => executeAgentProfile(profile, {
            cwd: launchCwd,
            format: planExecutionFormat,
            ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
            ...(deps.execRuntime ? { subprocessExecutor: deps.execRuntime } : {}),
            ...(Object.keys(sdkOptsForCall).length > 0 ? { sdkOpts: sdkOptsForCall } : {}),
          }),
        );
        // SDK cancellation surface (spike §6.3): typed line names the
        // configured timeout, elapsed time, draft-slot ref, and resume verb.
        // GH-1825: when a draft was captured, point the operator at
        // `--resume-from-draft` (continues drafting) rather than
        // `prx plan view --slot draft` (read-only inspection).
        if (dispatched.kind === "sdk" && dispatched.result.kind === "cancelled") {
          const c = dispatched.result;
          const timeoutClause = c.configured_timeout_ms !== null
            ? ` (configured --timeout=${c.configured_timeout_ms}ms)`
            : "";
          const draftClause = c.draftRef
            ? `; partial plan saved to draft slot ${c.draftRef} — resume with \`${bannerPrefix} ${effectiveWorkUnitId} --resume-from-draft\``
            : "; no partial content captured";
          output.error(
            `${bannerPrefix}: cancelled after ${c.elapsed_ms}ms${timeoutClause} (reason=${c.reason})${draftClause}.`,
          );
        }
        // SDK typed failure surface: distinguishes rate_limit / network /
        // model / cancelled (today's collapse-to-status-1 disappears).
        if (dispatched.kind === "sdk" && dispatched.result.kind === "failed") {
          const f = dispatched.result;
          output.error(
            `${bannerPrefix}: [${f.errorKind}] ${f.message}${f.retryAfter !== undefined ? ` (retry after ${f.retryAfter}ms)` : ""}`,
          );
        }
        // Collapse the dispatched result back into the legacy
        // `RuntimeExecutionResult` shape so the existing telemetry +
        // emit-file + runPlanSave wiring below stays uniform. Plan-print
        // wants the raw assistant text (not the JSON envelope), so we
        // prefer `success.text` for the SDK success branch.
        const result = (() => {
          if (dispatched.kind === "subprocess") return dispatched.execution;
          const sdk = dispatched.result;
          if (sdk.kind === "success") {
            return { status: 0, stdout: sdk.text, stderr: "" };
          }
          if (sdk.kind === "cancelled") {
            return { status: 124, stdout: sdk.partialStdout, stderr: `cancelled (${sdk.reason})` };
          }
          return { status: 1, stdout: "", stderr: `[${sdk.errorKind}] ${sdk.message}` };
        })();
        if (result.status !== 0 && !(dispatched.kind === "sdk" && (dispatched.result.kind === "cancelled" || dispatched.result.kind === "failed"))) {
          const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
          const modeLabel = parsed.interactive ? `resume=${hasPriorSession ? "yes" : "no"}` : "mode=print";
          output.error(
            `${bannerPrefix}: claude exited ${result.status} (${modeLabel})${stderrTail ? ` — ${stderrTail}` : ""}`,
          );
        }
        if (result.status === 0 && parsed.emitFile !== undefined) {
          const writeFileFn = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
          const emitPath = resolve(launchCwd, parsed.emitFile);
          mkdirSync(dirname(emitPath), { recursive: true });
          writeFileFn(emitPath, result.stdout);
          output.error(`${bannerPrefix}: wrote plan to ${emitPath}`);
        }
        // GH-1164: chain captured stdout into `prx plan save --slot draft` so
        // the print-mode planner-handoff artifact lands in the CAS slot that
        // `prx implement` (GH-1238) consumes. Gated on non-interactive
        // success with non-empty stdout, fired whenever the dispatch was
        // reached via `prx plan session` — GH-1982 promoted the alias
        // `prx session plan` to set the same flag, so both entries now
        // populate the draft slot identically.
        if (
          parsed.invokedViaPlanSession &&
          !parsed.interactive &&
          result.status === 0
        ) {
          const stdoutContent = result.stdout ?? "";
          if (stdoutContent.trim().length === 0) {
            output.error(
              `${bannerPrefix}: claude produced no plan content; nothing saved to draft slot`,
            );
          } else {
            // GH-2028: the save always persists now (persist-on-failure), so
            // narrate real state instead of the GH-1473 misleading
            // "(not saved…)" branch. When the body failed the shape gate the
            // slot still lands; flag validated_ok=false so the operator knows
            // `prx implement` will refuse until it is refined.
            const saved = await (deps.runPlanSave ?? runPlanSave)({
              unit: effectiveWorkUnitId,
              slot: "draft",
              content: stdoutContent,
            });
            // prx-j4a: surface the result through the shared printer, framed as
            // input-artifact (the UoW) → output-artifact (the plan draft ref),
            // instead of a prose "saved draft slot" line.
            emit(
              output,
              {
                schema: planAgentResultSchema,
                data: {
                  actor: "plan" as const,
                  unit: effectiveWorkUnitId,
                  ...(planSourceLabel(effectiveWorkUnitId)
                    ? { source: planSourceLabel(effectiveWorkUnitId)! }
                    : {}),
                  ref: saved.ref,
                  validated: saved.validated_ok,
                  diagnostics: saved.diagnostics.length,
                  ...(saved.validated_ok
                    ? {}
                    : { view: `prx plan show ${effectiveWorkUnitId} --slot draft` }),
                },
                pretty: renderPlanAgentResult,
              },
              parsed.format,
            );
          }
        }
        const telemetry = {
          agent: "claude",
          status: result.status === 0 ? "success" : "error",
          input_hash: sha256(JSON.stringify({
            command: profile.command,
            args: profile.args,
            cwd: launchCwd,
            policy,
          })),
          output_hash: sha256(`${result.stdout}\n${result.stderr}`),
          latency_ms: Date.now() - startedAt,
        };
        appendExecutionLog(
          launchCwd,
          createRunRecord({
            agent: "claude",
            input_hash: telemetry.input_hash,
            output_hash: telemetry.output_hash,
            status: telemetry.status,
            latency_ms: telemetry.latency_ms,
            timestamp: Date.now(),
          }),
        );
        if (parsed.format === "json") {
          output.log(
            JSON.stringify(
              {
                profile,
                cwd: launchCwd,
                runtimeArtifacts,
                policy,
                telemetry,
                status: result.status,
                stdout: result.stdout,
                stderr: result.stderr,
              },
              null,
              2,
            ),
          );
        }
        // prx-j4a: the plan body is no longer dumped to stdout — the agent's
        // output is the structured input→output result (emitted above), and the
        // full plan is the output artifact in the CAS draft slot, reachable via
        // the `view:` command in that result. (Was: GH-1164 relayed result.stdout
        // for format=plain; that play-by-play is what prx-j4a quiets.)
        return result.status;
      } finally {
        deleteEnv(PRX_SESSION_OPEN_ENV);
      }
        } catch (error) {
          // GH-2067: structured stderr envelope for `--format json`. When the
          // throw carries `details` (set on the not-yet-materialized branch),
          // emit a JSON blob to stderr so downstream consumers (canonical=bd
          // hydration smoke, automated retry branches) can parse the result
          // without scraping prose. Stream stays stderr to match the prior
          // plain-text emission — `2>` captures keep working. Plain-text mode
          // and any error without `details` fall through to the unchanged
          // `handleRunCliError` path.
          if (
            parsed.format === "json" &&
            error instanceof CliError &&
            error.details !== undefined
          ) {
            output.error(
              JSON.stringify(
                { error: error.details, exitCode: error.exitCode },
                null,
                2,
              ),
            );
            return error.exitCode;
          }
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "agent-smoke") {
      return (async (): Promise<number> => {
        try {
      const policy = POLICY;
      await validateWorkSessionEntry(
        parsed.workUnitId,
        process.cwd(),
        parsed.create,
        deps.boardStatus ?? boardStatus,
        deps.buildParityChain ?? buildParityChain,
        deps.validateGitHubIssue ?? validateGitHubIssue,
        deps.pruneStaleRemoteRefs ?? pruneStaleRemoteRefs,
      );
      if (parsed.create) {
        if (deps.materializeWorktree) {
          deps.materializeWorktree(parsed.workUnitId, process.cwd(), parsed.noVerify);
        } else {
          materializeWorkUnitBranch(parsed.workUnitId, process.cwd(), undefined, undefined, parsed.noVerify);
        }
      }
      const launchCwd = parsed.launchFromCurrentWorkspace
        ? assertLaunchCwdNotMainx(process.cwd(), parsed.workUnitId)
        : deps.resolveWorkUnitCwd
          ? deps.resolveWorkUnitCwd(parsed.workUnitId, process.cwd(), parsed.noVerify)
          : resolveWorkUnitLaunchCwdUsingDefaults(parsed.workUnitId, process.cwd(), parsed.noVerify);
      // Side effect only: writes .pr/local/runtime/{agents,mcp,output.schema}.json
      // so the launched claude can boot with --mcp-config (GH-1587: no beads
      // MCP server is provisioned — the status object is no longer surfaced).
      (deps.ensureRuntimeArtifacts ?? ensureLocalRuntimeArtifacts)(
        parsed.workUnitId,
        launchCwd,
      );
      const smokeChecks = [
        {
          name: "liveness" as const,
          prompt: "echo:hello",
        },
        {
          name: "contract" as const,
          prompt: "Return EXACT JSON:\n{\"status\":\"success\",\"data\":{\"echo\":\"hello\"},\"meta\":{\"latency_ms\":0}}",
        },
        {
          name: "timeout" as const,
          prompt: "wait 60 seconds then respond",
        },
      ];
      const results = maybeWithWorktreeRuntimeLock(
        !parsed.launchFromCurrentWorkspace,
        launchCwd,
        `prx agent-smoke runtime active for ${parsed.workUnitId} (pid ${process.pid})`,
        deps,
        () => policy.allowed_agents.map((agent) => {
          const runRaw = (prompt: string) => {
            const profile = buildExecutedWorkProfile(
              buildWorkAutomationProfile(agent, parsed.workUnitId, validateWorkIoFormat(agent, parsed.ioFormat), parsed.mode),
              { prompt: buildPrompt(prompt) },
            );
            const startedAt = Date.now();
            const execution = deps.execRuntime
              ? deps.execRuntime(profile, "json", launchCwd)
              : localRuntimeExecutor(profile, "json", launchCwd, policy.timeout_ms);
            return {
              profile,
              execution,
              latencyMs: Date.now() - startedAt,
            };
          };
          const livenessRun = runRaw(smokeChecks[0]!.prompt);
          const contractRun = executeValidatedAgentWithRetry(
            buildExecutedWorkProfile(
              buildWorkAutomationProfile(agent, parsed.workUnitId, validateWorkIoFormat(agent, parsed.ioFormat), parsed.mode),
              { prompt: buildPrompt(smokeChecks[1]!.prompt) },
            ),
            launchCwd,
            (profile, format, cwd) => deps.execRuntime
              ? deps.execRuntime(profile, format, cwd)
              : localRuntimeExecutor(profile, format, cwd ?? launchCwd, policy.timeout_ms),
            policy.max_retries + 1,
          );
          const timeoutRun = runRaw(smokeChecks[2]!.prompt);
          const timeoutLike = timeoutRun.execution.status !== 0 &&
            (/timed out|timeout/i.test(timeoutRun.execution.stderr) || /timed out|timeout/i.test(timeoutRun.execution.stdout));
          const checks = [
            {
              name: smokeChecks[0]!.name,
              compliant: livenessRun.execution.status === 0 && livenessRun.latencyMs <= policy.timeout_ms,
              status: livenessRun.execution.status,
              latency_ms: livenessRun.latencyMs,
              error: livenessRun.execution.status === 0 ? undefined : (livenessRun.execution.stderr || livenessRun.execution.stdout),
            },
            {
              name: smokeChecks[1]!.name,
              compliant: contractRun.result.status === "success",
              status: contractRun.result.status,
              latency_ms: contractRun.result.meta.latency_ms,
              attempts: contractRun.attempts,
              error: contractRun.result.error?.message,
            },
            {
              name: smokeChecks[2]!.name,
              compliant: timeoutLike,
              status: timeoutRun.execution.status,
              latency_ms: timeoutRun.latencyMs,
              error: timeoutRun.execution.stderr || timeoutRun.execution.stdout,
            },
          ];
          const compliant = checks.every((check) => check.compliant);
          const inputHash = sha256(JSON.stringify({
            checks: smokeChecks.map((check) => check.prompt),
            command: livenessRun.profile.command,
            args: livenessRun.profile.args,
            policy,
          }));
          const outputHash = sha256(JSON.stringify(checks));
          appendExecutionLog(
            launchCwd,
            createRunRecord({
              agent,
              input_hash: inputHash,
              output_hash: outputHash,
              status: compliant ? "success" : "error",
              latency_ms: checks.reduce((sum, check) => sum + check.latency_ms, 0),
              timestamp: Date.now(),
            }),
          );
          return {
            agent,
            compliant,
            latency_ms: checks.reduce((sum, check) => sum + check.latency_ms, 0),
            input_hash: inputHash,
            output_hash: outputHash,
            checks,
          };
        }),
      );
      const failed = results.filter((entry) => !entry.compliant);
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              workUnitId: parsed.workUnitId,
              mode: parsed.mode,
              ioFormat: parsed.ioFormat,
              policy,
              results,
            },
            null,
            2,
          ),
        );
      } else {
        output.log(`agent-smoke ${parsed.workUnitId} io-format=${parsed.ioFormat} timeout-ms=${policy.timeout_ms}`);
        for (const entry of results) {
          output.log(`  ${entry.agent}: ${entry.compliant ? "compliant" : "non-compliant"} (latency ${entry.latency_ms}ms)`);
          for (const check of entry.checks) {
            output.log(`    ${check.name}: ${check.compliant ? "pass" : "fail"} (${check.status})`);
            if (check.error) {
              const firstLine = check.error.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
              if (firstLine) {
                output.log(`      ${firstLine}`);
              }
            }
          }
        }
      }
      return failed.length > 0 ? 1 : 0;
        } catch (error) {
          return handleRunCliError(error, output);
        }
      })();
    }

    if (parsed.command === "desktop") {
      const launchCwd = parsed.launchFromCurrentWorkspace
        ? assertLaunchCwdNotMainx(process.cwd(), parsed.workUnitId)
        : (deps.resolveWorkUnitCwd ?? resolveWorkUnitLaunchCwd)(
          parsed.workUnitId,
          process.cwd(),
        );
      const openCommand = "codex";
      const openArgs = ["app", launchCwd];
      if (parsed.dryRun) {
        const rendered = formatRuntimeProfile(
          {
            profile: "work-unit",
            mode: "dev",
            command: openCommand,
            args: openArgs,
            trustTiers: {
              tierA_controlled: ["canonical worktree resolution"],
              tierB_partial: ["user-scoped Codex config"],
              tierC_ambient: ["desktop app defaults"],
            },
            sourcesOfTruth: {
              agents: "inline_prompt",
              mcp: "codex-config",
              plugins: [],
              connectors: [],
            },
            allowedActors: ["prx", "wt", "llm_agent"],
            disallowedActors: ["gmail", "gcal"],
            notes: ["Open the resolved worktree in Codex Desktop."],
          },
          parsed.format,
        );
        output.log(rendered);
        return 0;
      }

      const result = (deps.execOpen ?? executeOpenCommand)(openCommand, openArgs, launchCwd);
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              command: openCommand,
              args: openArgs,
              cwd: launchCwd,
              status: result.status,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
      }
      return result.status;
    }

    if (parsed.command === "task-spec") {
      if (parsed.action === "init") {
        const task = createTaskContract({
          workUnitId: parsed.workUnitId,
          worktree: process.cwd(),
          beadId: parsed.beadId,
        });
        if (!parsed.dryRun) {
          writeTaskContract(parsed.taskPath, task);
        }
        output.log(formatTaskStatus(task, parsed.format));
        return 0;
      }

      const task = loadTaskContract(parsed.taskPath);
      if (parsed.action === "show") {
        output.log(formatTaskStatus(task, parsed.format));
        return 0;
      }

      const validated = taskContractSchema.parse(task);
      output.log(parsed.format === "json"
        ? JSON.stringify({ valid: true, task: validated }, null, 2)
        : `task spec valid for ${validated.identity.workUnitId}`);
      return 0;
    }

    if (parsed.command === "task") {
      if (parsed.action === "graph") {
        output.log(formatTaskGraph(parsed.format));
        return 0;
      }

      let task = loadOrCreateTaskContract(parsed.taskPath, parsed.workUnitId, parsed.beadId);

      if (parsed.action === "sync") {
        task = syncTaskContract(task, {
          cwd: process.cwd(),
          beadId: parsed.beadId,
          sourceVersion: parsed.sourceVersion,
          sourceHash: parsed.sourceHash,
        });
        if (parsed.confirmScope) {
          task = confirmTaskScope(task);
        }
        if (parsed.confirmSuccess) {
          task = confirmTaskSuccessCriteria(task);
        }
        if (!parsed.dryRun) {
          writeTaskContract(parsed.taskPath, task);
        }
        output.log(formatTaskStatus(task, parsed.format));
        return 0;
      }

      if (parsed.action === "status") {
        output.log(formatTaskStatus(task, parsed.format));
        return 0;
      }

      const status = deriveTaskStatus(task);
      const roleToRun = status.nextRole ?? task.rolePlan.currentRole;
      const implementation = parsed.agent ?? task.rolePlan.assignedImplementations[roleToRun];
      const started = startTaskRole(task, roleToRun, implementation);
      if (!parsed.dryRun) {
        writeTaskContract(parsed.taskPath, started);
      }

      const runtimeProfile = implementation === "codex"
        ? buildTaskRoleCodexRuntimeProfile({
          workUnitId: parsed.workUnitId,
          role: roleToRun,
          ioFormat: "json",
          mode: "full",
        })
        : implementation === "copilot"
          ? buildTaskRoleCopilotRuntimeProfile({
            workUnitId: parsed.workUnitId,
            role: roleToRun,
            ioFormat: "json",
            mode: "full",
          })
          : implementation === "gemini"
            ? buildTaskRoleGeminiRuntimeProfile({
              workUnitId: parsed.workUnitId,
              role: roleToRun,
              ioFormat: "json",
              mode: "full",
            })
            : implementation === "cursor"
              ? buildTaskRoleCursorRuntimeProfile({
                workUnitId: parsed.workUnitId,
                role: roleToRun,
                ioFormat: "json",
                mode: "full",
              })
          : buildTaskRoleClaudeRuntimeProfile({
            workUnitId: parsed.workUnitId,
            role: roleToRun,
            ioFormat: "json",
            mode: "full",
          });
      const executedProfile = buildExecutedWorkProfile(runtimeProfile, {});
      if (parsed.dryRun) {
        output.log(formatRuntimeProfile(executedProfile, parsed.format));
        return 0;
      }
      const result = (deps.execRuntime ?? localRuntimeExecutor)(executedProfile, parsed.format, started.identity.worktree);
      if (parsed.format === "json") {
        output.log(JSON.stringify({
          task: started,
          profile: executedProfile,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        }, null, 2));
      }
      return result.status;
    }

    if (parsed.command === "role") {
      let task = loadOrCreateTaskContract(parsed.taskPath, parsed.workUnitId);
      if (parsed.action === "start") {
        if (parsed.role === "executor") {
          const missingConfirmations = missingExecutorConfirmations(task);
          if (missingConfirmations.length > 0) {
            output.error("Cannot start executor:");
            for (const line of missingConfirmations) {
              output.error(`- ${line}`);
            }
            return 1;
          }
        }
        task = startTaskRole(task, parsed.role, parsed.agent);
        const implementation = parsed.agent ?? task.rolePlan.assignedImplementations[parsed.role];
        if (!parsed.dryRun) {
          writeTaskContract(parsed.taskPath, task);
        }
        const runtimeProfile = implementation === "codex"
          ? buildTaskRoleCodexRuntimeProfile({
            workUnitId: parsed.workUnitId,
            role: parsed.role,
            ioFormat: "json",
            mode: "full",
          })
          : implementation === "copilot"
            ? buildTaskRoleCopilotRuntimeProfile({
              workUnitId: parsed.workUnitId,
              role: parsed.role,
              ioFormat: "json",
              mode: "full",
            })
            : implementation === "gemini"
              ? buildTaskRoleGeminiRuntimeProfile({
                workUnitId: parsed.workUnitId,
                role: parsed.role,
                ioFormat: "json",
                mode: "full",
              })
              : implementation === "cursor"
                ? buildTaskRoleCursorRuntimeProfile({
                  workUnitId: parsed.workUnitId,
                  role: parsed.role,
                  ioFormat: "json",
                  mode: "full",
                })
            : buildTaskRoleClaudeRuntimeProfile({
              workUnitId: parsed.workUnitId,
              role: parsed.role,
              ioFormat: "json",
              mode: "full",
            });
        const executedProfile = buildExecutedWorkProfile(runtimeProfile, {});
        if (parsed.dryRun) {
          output.log(formatRuntimeProfile(executedProfile, parsed.format));
          return 0;
        }
        const result = (deps.execRuntime ?? localRuntimeExecutor)(executedProfile, parsed.format, task.identity.worktree);
        if (parsed.format === "json") {
          output.log(JSON.stringify({
            task,
            profile: executedProfile,
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2));
        }
        return result.status;
      }

      task = parsed.action === "complete"
        ? completeTaskRole(task, parsed.role, parsed.reason)
        : failTaskRole(task, parsed.role, parsed.reason);
      if (!parsed.dryRun) {
        writeTaskContract(parsed.taskPath, task);
      }
      output.log(formatTaskStatus(task, parsed.format));
      return 0;
    }

    if (parsed.command === "skills") {
      output.log(formatSkillCatalog(parsed.contract, parsed.format));
      return 0;
    }

    if (parsed.command === "overview") {
      // GH-1757: when a slug positional is supplied, resolve via the
      // shared `locateRepo` helper (sibling `repo *` verbs already use
      // the same pattern) so `prx repo overview <slug>` works from any
      // cwd. When no slug is given, fall through to the cwd / `--repo-path`
      // flow that existed before this change.
      let resolvedRepoPath = parsed.repoPath;
      if (parsed.slug !== null) {
        const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
        if (!repoInventoryConfig.indexPath) {
          throw new CliError(
            "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo overview` from a prx-managed checkout, or omit the slug to use the current directory.",
          );
        }
        const inventory = (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath);
        if (!inventory) {
          throw new CliError(
            `No repo inventory index at ${repoInventoryConfig.indexPath}. Run \`prx repo add\` first to create one.`,
          );
        }
        const located = locateRepo(inventory, { slug: parsed.slug, cwd: process.cwd() });
        if (located.kind === "not_found") {
          throw new CliError(located.detail);
        }
        resolvedRepoPath = located.repo.mainWorktree ?? located.repo.commonDir;
      }
      const overview = (deps.overviewStatus ?? overviewStatus)(
        resolvedRepoPath,
        parsed.includeDiffStats,
      );
      output.log(formatOverview(overview, parsed.format));
      return 0;
    }

    if (parsed.command === "repos") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      const configuredBareRoot = repoInventoryConfig.bareRoot ? resolve(repoInventoryConfig.bareRoot) : null;
      const requestedRoots = parsed.roots.length > 0
        ? parsed.roots.map((root) => resolve(root))
        : (parsed.everywhere ? repoInventoryConfig.everywhereRoots : repoInventoryConfig.roots);
      if (!parsed.everywhere && configuredBareRoot) {
        const outsideRoots = requestedRoots.filter((root) =>
          root !== configuredBareRoot && !root.startsWith(`${configuredBareRoot}/`)
        );
        if (outsideRoots.length > 0) {
          throw new CliError(
            `Root outside configured bare root: ${outsideRoots[0]}. Use --everywhere to scan outside ${configuredBareRoot}.`,
          );
        }
      }
      const derived = {
        ...(deps.discoverLocalRepos ?? discoverLocalRepos)(requestedRoots),
        bareRoot: repoInventoryConfig.bareRoot,
        configPath: repoInventoryConfig.configPath,
        indexPath: repoInventoryConfig.indexPath,
      };
      // GH-1727: `discoverLocalRepos` only sees disk — the three operator-set
      // axes (`canonical`, `bd_workspace_prefix`, `stale_threshold_days`) live
      // only in the index. Layer them back on before the round-trip so a
      // refresh doesn't silently clobber an operator's `prx repo set`.
      const priorIndex = repoInventoryConfig.indexPath
        ? (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath)
        : null;
      const inventory = preservePerRepoAxes(priorIndex, derived);
      if (repoInventoryConfig.indexPath) {
        (deps.writeRepoInventoryIndex ?? writeRepoInventoryIndex)(repoInventoryConfig.indexPath, inventory);
      }
      if (parsed.action === "normalize") {
        const normalization = (deps.normalizeLocalRepos ?? normalizeLocalRepos)(inventory, {
          apply: parsed.apply,
          names: parsed.names,
        });
        output.log(formatRepoNormalization(normalization, parsed.format));
        return 0;
      }
      const filteredInventory = parsed.local
        ? {
          ...inventory,
          repos: inventory.repos.filter((repo) => repo.findings.length > 0),
        }
        : inventory;
      output.log(formatRepos(filteredInventory, parsed.format, parsed.local));
      if (parsed.local) {
        return filteredInventory.repos.length > 0 ? 1 : 0;
      }
      return filteredInventory.repos.length > 0 ? 0 : 1;
    }

    if (parsed.command === "repo-audit") {
      // GH-1701: fleet-wide beads-state inventory. Read-only by construction
      // (I-RA1): no `writeRepoInventoryIndex`, no `.beads/` mutation, no
      // `bd sql` (I-RA2 — issue counts go through `bd list --all --json`).
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      let inventory: RepoInventory | null = null;
      if (repoInventoryConfig.indexPath) {
        inventory = (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath);
      }
      if (!inventory) {
        throw new CliError(
          "No .prx/repos/index.json yet — run `prx repo list` first to populate the inventory.",
        );
      }

      const auditDeps: RepoAuditDeps = {
        classify: (repo) => classifyBeadsWorkspace(repoAuditInspectionCwd(repo)),
        getGitOrigin: (repo) => readRepoOriginUrl(repo),
        countIssues: (repo) => countRepoBeadsIssues(repo),
        dolthubOwner: getEnv("BEADS_DOLTHUB_OWNER")?.trim() || null,
      };
      const rows = auditRegisteredRepos(inventory, auditDeps);

      // GH-1760: append `adopted (registry.sqlite): N repos, M branches`. The
      // sqlite open is best-effort — a non-existent registry file is opened
      // fresh (count 0/0), and any other error degrades quietly to omitting
      // the line so the existing audit output stays intact for operators who
      // have not yet adopted anything.
      let adoptedCounts: { repos: number; branches: number } | undefined;
      try {
        const registry = (deps.openRegistry ?? openRegistry)(defaultRegistryPath());
        try {
          adoptedCounts = {
            repos: new RepositoryStore(registry).count(),
            branches: new BranchStore(registry).count(),
          };
        } finally {
          registry.close();
        }
      } catch {
        adoptedCounts = undefined;
      }

      output.log(
        formatRepoAudit(rows, parsed.format, new Date().toISOString(), adoptedCounts),
      );
      return 0;
    }

    if (parsed.command === "repos-add") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      if (!repoInventoryConfig.bareRoot) {
        throw new CliError(
          "No configured bare root. Configure prx via ~/.config/prx/config.json or .prx/repos/config.json before running `prx repo add`.",
        );
      }
      const wtRoot = resolveWorktreePath().base;

      // GH-1682: `--repair` makes `prx repo add <git-url>` idempotent. When the
      // bare already exists on disk and the registered entry's URL matches,
      // delegate to the PR-C refresh path (`refreshLocalRepo`) instead of
      // throwing `bare_path_exists`. Identity is resolved on the parsed URL
      // triple (`{host, owner, name}`) so ssh vs https on the same repo does
      // not trip a false mismatch, and on `commonDir` for the index lookup so
      // a stale `primaryRemote.githubRepo` cannot mask the registered entry.
      if (parsed.repair) {
        const parsedUrl = parseRepoUrl(parsed.url);
        if (!parsedUrl) {
          throw new CliError(`Could not parse git URL: ${parsed.url}`);
        }
        const repairBarePath = canonicalBarePathFromParsed(repoInventoryConfig.bareRoot, parsedUrl);
        if (existsSync(repairBarePath)) {
          const priorIndexForRepair = repoInventoryConfig.indexPath
            ? (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath)
            : null;
          const registered = priorIndexForRepair?.repos.find(
            (repo) => repo.commonDir === repairBarePath,
          ) ?? null;
          if (!registered) {
            throw new CliError(
              `Bare path already exists: ${repairBarePath}. Refusing to clobber.`,
            );
          }
          const registeredUrl = registered.primaryRemote?.url;
          const registeredParsed = registeredUrl ? parseRepoUrl(registeredUrl) : null;
          const sameTriple = !!registeredParsed
            && registeredParsed.host === parsedUrl.host
            && registeredParsed.owner === parsedUrl.owner
            && registeredParsed.name === parsedUrl.name;
          if (!sameTriple) {
            throw new CliError(
              `URL mismatch under --repair: registered=${registeredUrl ?? "<none>"}, requested=${parsed.url}. ` +
                "Refusing to silently rewrite. Use `prx repo refresh <slug>` against the registered repo, or remove the entry first.",
            );
          }
          try {
            const refreshResult = (deps.refreshLocalRepo ?? refreshLocalRepo)({
              repo: registered,
              wtRoot,
              dryRun: parsed.repairDryRun,
              noFetch: parsed.repairNoFetch,
            });
            output.log(formatRepoRefresh(refreshResult, parsed.format));
            return refreshResult.beadsHydrate.exitCode;
          } catch (err) {
            if (err instanceof RepoAddError) {
              throw new CliError(err.message);
            }
            throw err;
          }
        }
        // barePath absent → fall through to a fresh add. `--dry-run` /
        // `--no-fetch` are nonsensical on a fresh clone; the parser already
        // requires `--repair` to set them, but defense-in-depth.
        if (parsed.repairDryRun || parsed.repairNoFetch) {
          throw new CliError(
            "repo add --repair: --dry-run / --no-fetch only apply when the bare clone already exists; cannot use them on a fresh add.",
          );
        }
      }

      try {
        const addResult = (deps.addLocalRepo ?? addLocalRepo)({
          url: parsed.url,
          bareRoot: repoInventoryConfig.bareRoot,
          wtRoot,
          operatorConfigRoot: repoInventoryConfig.repoRoot,
          overlay: parsed.overlay,
          bdWorkspacePrefixOverride: parsed.bdWorkspacePrefix ?? undefined,
          canonical: parsed.canonical,
        });

        // GH-1657 (WP1): enforce bd_workspace_prefix uniqueness across the
        // index before the post-add refresh writes the new entry. Read the
        // existing on-disk index (tolerant of "no file yet"), look for an
        // entry that already owns this prefix, and if one exists, roll back
        // the freshly-cloned bare + mainx and error out naming both repos.
        const priorIndex = repoInventoryConfig.indexPath
          ? (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath)
          : null;
        if (priorIndex) {
          const newRepoKey = `${addResult.parsed.host}/${addResult.parsed.owner}/${addResult.parsed.name}`;
          for (const repo of priorIndex.repos) {
            if (!repo.bd_workspace_prefix || repo.bd_workspace_prefix !== addResult.bdWorkspacePrefix) {
              continue;
            }
            // GH-1682: direct disk-identity self-skip. Complements the
            // URL-identity skip below — fires before the prefix-match branch
            // evaluates, so a stale index entry whose `commonDir` matches
            // the freshly-cloned bare cannot trip the uniqueness check.
            if (repo.commonDir === addResult.barePath) {
              continue;
            }
            const existingGh = repo.primaryRemote?.githubRepo;
            const existingKey = existingGh
              ? `github.com/${existingGh}`
              : `${repo.name} (${repo.commonDir})`;
            if (existingKey === newRepoKey) {
              continue;
            }
            (deps.rollbackRepoAdd ?? rollbackRepoAdd)(addResult);
            throw new CliError(
              `Workspace prefix '${addResult.bdWorkspacePrefix}' already in use by ${existingKey}; attempted add of ${newRepoKey}. ` +
                `Re-run with --bd-workspace-prefix <distinct-value> if both clones must coexist.`,
            );
          }
        }

        output.log(formatRepoAdd(addResult, parsed.format));

        // Refresh the inventory index so `prx repo list` reflects the new
        // repo + mainx immediately (clears the no_attached_worktree finding
        // that would otherwise show until the next inventory pass).
        // Always union the resolved wtRoot into the scan roots so the new
        // mainx is visible even when a user config overrides everywhereRoots
        // and does not include the wt base.
        if (repoInventoryConfig.indexPath) {
          const refreshRoots = repoInventoryConfig.everywhereRoots.includes(wtRoot)
            ? repoInventoryConfig.everywhereRoots
            : [...repoInventoryConfig.everywhereRoots, wtRoot];
          const refreshed = {
            ...(deps.discoverLocalRepos ?? discoverLocalRepos)(refreshRoots),
            bareRoot: repoInventoryConfig.bareRoot,
            configPath: repoInventoryConfig.configPath,
            indexPath: repoInventoryConfig.indexPath,
          };

          // GH-1727: layer the prior on-disk axes (canonical /
          // bd_workspace_prefix / stale_threshold_days) onto the refreshed
          // inventory through the shared helper, then stamp the just-added
          // repo's bd_workspace_prefix + canonical on its new entry. The
          // new repo's `commonDir` is `addResult.barePath`.
          const preserved = preservePerRepoAxes(priorIndex, refreshed);
          const merged = {
            ...preserved,
            repos: preserved.repos.map((repo: LocalRepo) =>
              repo.commonDir === addResult.barePath
                ? {
                  ...repo,
                  bd_workspace_prefix: addResult.bdWorkspacePrefix,
                  canonical: addResult.canonical,
                }
                : repo
            ),
          };

          (deps.writeRepoInventoryIndex ?? writeRepoInventoryIndex)(repoInventoryConfig.indexPath, merged);
        }
        return 0;
      } catch (err) {
        if (err instanceof RepoAddError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repos-adopt") {
      // GH-1760: read-only git inference + idempotent sqlite upsert. The
      // CliError surface from `adoptRepo` already carries the curated
      // mismatch / no-origin / no-symref messages; runCli just routes
      // formatter output and closes the database.
      const registry = (deps.openRegistry ?? openRegistry)(defaultRegistryPath());
      try {
        const store = new RepositoryStore(registry);
        const result = (deps.adoptRepo ?? adoptRepo)({
          worktreePath: parsed.fromWorktree,
          store,
        });
        output.log(formatRepoAdoptResult(result, parsed.format));
        return 0;
      } finally {
        registry.close();
      }
    }

    if (parsed.command === "branch-adopt") {
      // GH-1761: register the current branch in `registry.sqlite`. Refuses
      // detached HEAD without `--detached-as <name>`, and refuses if the
      // owning repo has not been adopted yet.
      const registry = (deps.openRegistry ?? openRegistry)(defaultRegistryPath());
      try {
        const repoStore = new RepositoryStore(registry);
        const branchStore = new BranchStore(registry);
        const result = (deps.adoptBranch ?? adoptBranch)({
          worktreePath: parsed.fromWorktree,
          repoStore,
          branchStore,
          detachedAs: parsed.detachedAs,
        });
        output.log(formatBranchAdoptResult(result, parsed.format));
        return 0;
      } finally {
        registry.close();
      }
    }

    if (parsed.command === "workspace-adopt") {
      // GH-1762: register the on-disk worktree in `registry.sqlite`, auto-
      // chaining `repo adopt` + `branch adopt` (both idempotent). Curated
      // errors bubble from the upstream verbs and from adoptWorkspace
      // itself (path-mismatch on re-run).
      const registry = (deps.openRegistry ?? openRegistry)(defaultRegistryPath());
      try {
        const repoStore = new RepositoryStore(registry);
        const branchStore = new BranchStore(registry);
        const workspaceStore = new WorkspaceStore(registry);
        const result = (deps.adoptWorkspace ?? adoptWorkspace)({
          worktreePath: parsed.fromWorktree,
          repoStore,
          branchStore,
          workspaceStore,
          mode: parsed.mode,
          detachedAs: parsed.detachedAs,
        });
        output.log(formatWorkspaceAdoptResult(result, parsed.format));
        return 0;
      } finally {
        registry.close();
      }
    }

    if (parsed.command === "repos-set") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      if (!repoInventoryConfig.indexPath) {
        throw new CliError(
          "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo set` from a prx-managed checkout.",
        );
      }
      try {
        if (parsed.axis === "canonical") {
          const value = ensureChoice(parsed.to, ["gh", "bd"], "--to") as "gh" | "bd";
          const delta = (deps.setRepoCanonical ?? setRepoCanonical)(
            repoInventoryConfig.indexPath,
            parsed.slug,
            value,
          );
          output.log(formatRepoSet(parsed.slug, "canonical", delta, parsed.format));
          return 0;
        }
        if (parsed.axis === "bd-workspace-prefix") {
          const delta = (deps.setRepoBdWorkspacePrefix ?? setRepoBdWorkspacePrefix)(
            repoInventoryConfig.indexPath,
            parsed.slug,
            parsed.to,
          );
          output.log(formatRepoSet(parsed.slug, "bd-workspace-prefix", delta, parsed.format));
          return 0;
        }
        if (parsed.axis === "dolt-remote") {
          const delta = (deps.setRepoDoltRemote ?? setRepoDoltRemote)(
            repoInventoryConfig.indexPath,
            parsed.slug,
            parsed.to,
          );
          output.log(formatRepoSet(parsed.slug, "dolt-remote", delta, parsed.format));
          return 0;
        }
        const numericValue = Number.parseInt(parsed.to, 10);
        if (!Number.isFinite(numericValue) || String(numericValue) !== parsed.to) {
          throw new CliError(
            `--to=<n> for stale-threshold-days must be an integer; got '${parsed.to}'.`,
          );
        }
        const delta = (deps.setRepoStaleThresholdDays ?? setRepoStaleThresholdDays)(
          repoInventoryConfig.indexPath,
          parsed.slug,
          numericValue,
        );
        output.log(formatRepoSet(parsed.slug, "stale-threshold-days", delta, parsed.format));
        return 0;
      } catch (err) {
        if (err instanceof RepoAddError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repos-backfill") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      const wtRoot = resolveWorktreePath().base;
      try {
        const report = runRepoBackfill({
          config: repoInventoryConfig,
          wtRoot,
          dryRun: parsed.dryRun,
          dolthubOwner: getEnv("BEADS_DOLTHUB_OWNER")?.trim() || null,
        });
        output.log(formatRepoBackfill(report, parsed.format));
        return report.failed > 0 ? 1 : 0;
      } catch (err) {
        if (err instanceof RepoBackfillError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repo-refresh") {
      // GH-1681: operator recovery surface — `git fetch --prune origin`,
      // lazy refspec upgrade, and a re-run of `hydrateAfterMaterialize` on
      // the registered mainx. Exit code mirrors `beadsHydrate.exitCode`
      // (0 on every success/skip, 1 on `clone-failed`) so a still-broken
      // hydrate fails loud per GH-657's convention.
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      if (!repoInventoryConfig.indexPath) {
        throw new CliError(
          "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo refresh` from a prx-managed checkout.",
        );
      }
      const inventory = (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath);
      if (!inventory) {
        throw new CliError(
          `No repo inventory index at ${repoInventoryConfig.indexPath}. Run \`prx repo add\` first to create one.`,
        );
      }
      const lookup = (deps.findRepoBySlug ?? findRepoBySlug)(inventory, parsed.slug);
      if (!lookup.ok) {
        if (lookup.error.kind === "ambiguous") {
          throw new CliError(
            `Slug '${parsed.slug}' is ambiguous; candidates: ${lookup.error.candidates.join(", ")}. Use the full owner/name form.`,
          );
        }
        throw new CliError(
          `No bare repo registered with slug '${parsed.slug}' in ${repoInventoryConfig.indexPath}. Run \`prx repo add <url>\` first.`,
        );
      }
      const wtRoot = resolveWorktreePath().base;
      try {
        const result = (deps.refreshLocalRepo ?? refreshLocalRepo)({
          repo: lookup.repo,
          wtRoot,
          dryRun: parsed.dryRun,
          noFetch: parsed.noFetch,
        });
        output.log(formatRepoRefresh(result, parsed.format));

        if (!parsed.dryRun && repoInventoryConfig.indexPath) {
          // Refresh the inventory so a cold-mainx recovery (or any other
          // disk-state change) is visible to `prx repo list` immediately.
          // Mirrors the post-write merge in `repos-add` keyed by commonDir so
          // bd_workspace_prefix / canonical / stale_threshold_days survive
          // the round-trip through `discoverLocalRepos` (which does not read
          // those fields off disk).
          const refreshRoots = repoInventoryConfig.everywhereRoots.includes(wtRoot)
            ? repoInventoryConfig.everywhereRoots
            : [...repoInventoryConfig.everywhereRoots, wtRoot];
          const refreshed = {
            ...(deps.discoverLocalRepos ?? discoverLocalRepos)(refreshRoots),
            bareRoot: repoInventoryConfig.bareRoot,
            configPath: repoInventoryConfig.configPath,
            indexPath: repoInventoryConfig.indexPath,
          };
          const prefixByCommonDir = new Map<string, string>();
          const canonicalByCommonDir = new Map<string, "gh" | "bd">();
          const staleByCommonDir = new Map<string, number>();
          for (const repo of inventory.repos) {
            if (repo.bd_workspace_prefix) {
              prefixByCommonDir.set(repo.commonDir, repo.bd_workspace_prefix);
            }
            if (repo.canonical) {
              canonicalByCommonDir.set(repo.commonDir, repo.canonical);
            }
            if (typeof repo.stale_threshold_days === "number") {
              staleByCommonDir.set(repo.commonDir, repo.stale_threshold_days);
            }
          }
          refreshed.repos = refreshed.repos.map((repo: LocalRepo) => {
            const prefix = prefixByCommonDir.get(repo.commonDir);
            const canonical = canonicalByCommonDir.get(repo.commonDir);
            const stale = staleByCommonDir.get(repo.commonDir);
            let next = repo;
            if (prefix) next = { ...next, bd_workspace_prefix: prefix };
            if (canonical) next = { ...next, canonical };
            if (typeof stale === "number") next = { ...next, stale_threshold_days: stale };
            return next;
          });
          (deps.writeRepoInventoryIndex ?? writeRepoInventoryIndex)(repoInventoryConfig.indexPath, refreshed);
        }

        return result.beadsHydrate.exitCode;
      } catch (err) {
        if (err instanceof RepoAddError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repos-gc") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      const wtRoot = resolveWorktreePath().base;
      try {
        const report = runRepoGc({
          config: repoInventoryConfig,
          wtRoot,
          slug: parsed.slug ?? undefined,
          apply: parsed.apply,
          yes: parsed.yes,
        });
        output.log(formatRepoGcReport(report, parsed.format));
        return 0;
      } catch (err) {
        if (err instanceof RepoGcError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repos-add-dolthub") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      try {
        const result = runRepoAddDolthub({
          config: repoInventoryConfig,
          slug: parsed.slug,
          dolthubUserOverride: parsed.dolthubUser,
          nameOverride: parsed.name,
          noPush: parsed.noPush,
          dolthubOwnerDefault: getEnv("BEADS_DOLTHUB_OWNER")?.trim() || null,
          cwd: process.cwd(),
        });
        output.log(formatRepoAddDolthub(result, parsed.format));
        return result.kind === "refused" ? 1 : 0;
      } catch (err) {
        if (err instanceof AddDolthubError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repos-bootstrap") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      try {
        const result = runRepoBootstrap(
          {
            config: repoInventoryConfig,
            slug: parsed.slug,
            prefixOverride: parsed.prefix,
            shipMetadata: parsed.shipMetadata,
            cwd: process.cwd(),
          },
          {
            dolthubOwnerDefault:
              getEnv("BEADS_DOLTHUB_OWNER")?.trim() || null,
          },
        );
        output.log(formatRepoBootstrap(result, parsed.format));
        return result.kind === "refused" ? 1 : 0;
      } catch (err) {
        if (err instanceof RepoBootstrapError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "repos-materialize") {
      // GH-1752: extend `prx repo materialize` so it leaves the inventory
      // entry in the "ready-to-use" shape that `prx repo add` produces.
      // The bare leg (`materializeBareRepo`) stays pure — composition with
      // `refreshLocalRepo` (mainx create + lazy refspec upgrade + beads
      // `.beads/` hydrate) and the post-write inventory rescan happen at
      // this CLI layer. Mirrors the `prx repo add --repair` delegation
      // pattern (GH-1682) so the two operator entry points share one
      // downstream rather than open-coding three compositions.
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      const wtRoot = resolveWorktreePath().base;
      try {
        const bareResult = (deps.materializeBareRepo ?? materializeBareRepo)({
          name: parsed.name,
          dryRun: parsed.dryRun,
          ttlSeconds: parsed.ttlSeconds ?? undefined,
        });
        recordCatalogEvent("BARE_MATERIALIZED", {
          repo: bareResult.repo,
          details: {
            barePath: bareResult.barePath,
            action: bareResult.action,
            dryRun: bareResult.dryRun,
          },
        });

        // The bare leg above guaranteed the inventory entry exists (or
        // threw `name_not_in_index`). Re-resolve here so the refresh
        // delegation gets the registered `LocalRepo` shape that
        // `refreshLocalRepo` needs.
        const inventory = repoInventoryConfig.indexPath
          ? (deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex)(repoInventoryConfig.indexPath)
          : null;
        const lookup = inventory
          ? (deps.findRepoBySlug ?? findRepoBySlug)(inventory, parsed.name)
          : null;
        if (!inventory || !lookup || !lookup.ok) {
          // Should not happen: `materializeBareRepo` already proved the
          // slug resolves. Fall back to bare-only output rather than
          // throw, matching the prior behavior.
          output.log(formatMaterialize(bareResult, parsed.format));
          return 0;
        }

        const refreshResult = (deps.refreshLocalRepo ?? refreshLocalRepo)({
          repo: lookup.repo,
          wtRoot,
          dryRun: parsed.dryRun,
          // We just fetched on the bare leg (or short-circuited on
          // freshness); avoid a second pass.
          noFetch: true,
        });

        const combinedResult: MaterializeResult = {
          ...bareResult,
          postMaterialize: {
            mainxPath: refreshResult.mainxPath,
            mainxCreated: refreshResult.mainxCreated,
            refspecUpgraded: refreshResult.refspecUpgraded,
            refspecBefore: refreshResult.refspecBefore,
            refspecAfter: refreshResult.refspecAfter,
            beadsHydrate: refreshResult.beadsHydrate,
          },
        };

        if (!parsed.dryRun && refreshResult.mainxCreated) {
          recordCatalogEvent("WORKTREE_CREATED", {
            repo: bareResult.repo,
            details: {
              mainxPath: refreshResult.mainxPath,
            },
          });
        }

        // Post-write inventory rescan — mirrors `repos-refresh` and
        // `repos-add`. Flips `mainWorktree: null` to the resolved path
        // immediately so `prx repo bootstrap` / `prx repo audit` no
        // longer refuse with `no-worktree`. Layer prior axes through
        // `preservePerRepoAxes` (GH-1727) so a `prx repo set` doesn't
        // get clobbered by the round-trip through `discoverLocalRepos`.
        if (!parsed.dryRun && repoInventoryConfig.indexPath) {
          const refreshRoots = repoInventoryConfig.everywhereRoots.includes(wtRoot)
            ? repoInventoryConfig.everywhereRoots
            : [...repoInventoryConfig.everywhereRoots, wtRoot];
          const refreshed = {
            ...(deps.discoverLocalRepos ?? discoverLocalRepos)(refreshRoots),
            bareRoot: repoInventoryConfig.bareRoot,
            configPath: repoInventoryConfig.configPath,
            indexPath: repoInventoryConfig.indexPath,
          };
          const preserved = preservePerRepoAxes(inventory, refreshed);
          (deps.writeRepoInventoryIndex ?? writeRepoInventoryIndex)(
            repoInventoryConfig.indexPath,
            preserved,
          );
        }

        output.log(formatMaterialize(combinedResult, parsed.format));
        return refreshResult.beadsHydrate.exitCode;
      } catch (err) {
        if (err instanceof MaterializeError) {
          throw new CliError(err.message);
        }
        if (err instanceof RepoAddError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    }

    if (parsed.command === "hooks-apply" || parsed.command === "hooks-status") {
      const repoInventoryConfig = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(process.cwd());
      const requestedRoots = parsed.everywhere
        ? repoInventoryConfig.everywhereRoots
        : repoInventoryConfig.roots;
      const inventory: RepoInventory = {
        ...(deps.discoverLocalRepos ?? discoverLocalRepos)(requestedRoots),
        bareRoot: repoInventoryConfig.bareRoot,
        configPath: repoInventoryConfig.configPath,
        indexPath: repoInventoryConfig.indexPath,
      };
      if (parsed.command === "hooks-apply") {
        const result = (deps.applyHooks ?? applyHooks)(inventory, parsed.hooksPath);
        output.log(formatHookApply(result, parsed.format));
        return hookApplyHasErrors(result) ? 1 : 0;
      }
      const statusResult = (deps.hookStatus ?? hookStatus)(inventory, parsed.hooksPath);
      output.log(formatHookStatus(statusResult, parsed.format));
      return hookStatusHasDrift(statusResult) ? 1 : 0;
    }

    if (parsed.command === "home-update") {
      const handler = deps.homeUpdate ?? runHomeUpdate;
      return handler(
        {
          flakeDir: parsed.flakeDir,
          input: parsed.input,
          dryRun: parsed.dryRun,
          format: parsed.format,
          verbose: parsed.verbose,
        },
        output,
      );
    }

    if (parsed.command === "home-sync") {
      const handler = deps.homeSync ?? runHomeSync;
      return handler(
        {
          flakeDir: parsed.flakeDir,
          input: parsed.input,
          dryRun: parsed.dryRun,
          format: parsed.format,
        },
        output,
        { prepareMainx: prepareMainxWorktree },
      );
    }

    if (parsed.command === "dolt-reconcile") {
      const handler = deps.runDoltReconcile ?? runDoltReconcile;
      return handler(
        {
          repoPath: parsed.repoPath,
          dryRun: parsed.dryRun,
          format: parsed.format,
          resolve: parsed.resolve,
        },
        output,
      );
    }

    if (parsed.command === "dolt-status") {
      const handler = deps.runDoltStatus ?? runDoltStatus;
      return handler(
        { repoPath: parsed.repoPath, format: parsed.format },
        output,
      );
    }

    if (parsed.command === "dolt-stub") {
      // GH-2129: typed not-implemented outcome for an unwired dolt verb. Exit 2
      // distinguishes "declared but not yet built" from a real op failure (1)
      // or success (0); the message names the tracking ticket so an operator
      // who hit the verb in `prx help-all` learns where the work lives.
      const result: DoltStubOutput = {
        verb: parsed.verb,
        status: "not-implemented",
        tracking: parsed.tracking,
        message: `dolt ${parsed.verb} is not yet implemented — tracked: ${parsed.tracking}`,
      };
      if (parsed.format === "json") {
        output.log(JSON.stringify(result, null, 2));
      } else {
        output.log(result.message);
      }
      return 2;
    }

    if (parsed.command === "tmux-reconcile") {
      const handler = deps.runTmuxReconcile ?? runTmuxReconcile;
      return handler(
        {
          socket: parsed.socket,
          configPath: parsed.configPath,
          dryRun: parsed.dryRun,
          format: parsed.format,
        },
        output,
      );
    }

    if (parsed.command === "intake-view") {
      const handler = deps.runIntakeView ?? runIntakeView;
      const validated: IntakeViewOptions = intakeViewOptionsSchema.parse({
        id: parsed.id,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-search") {
      const handler = deps.runIntakeSearch ?? runIntakeSearch;
      const validated: IntakeSearchOptions = intakeSearchOptionsSchema.parse({
        query: parsed.query,
        state: parsed.state,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-status") {
      const handler = deps.runIntakeStatus ?? runIntakeStatus;
      const validated: IntakeStatusOptions = intakeStatusOptionsSchema.parse({
        repo: parsed.repo,
        format: parsed.format,
        limit: parsed.limit,
        includeIntentional: parsed.includeIntentional,
        rateLimit: parsed.rateLimit,
      });
      return handler(validated, output, {
        loadAllBeads: () => beadsCache.load(),
      });
    }

    if (parsed.command === "intake-merge") {
      const handler = deps.runIntakeMerge ?? runIntakeMerge;
      const validated: IntakeMergeOptions = intakeMergeOptionsSchema.parse({
        dupId: parsed.dupId,
        canonicalId: parsed.canonicalId,
        ...(parsed.template !== undefined ? { template: parsed.template } : {}),
        reason: parsed.reason,
        label: parsed.label,
        repo: parsed.repo,
        dryRun: parsed.dryRun,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-comment") {
      const handler = deps.runIntakeComment ?? runIntakeComment;
      // Body resolution lives at the CLI layer (matches the `prx intake
      // <type>` body cluster). The schema receives an already-resolved
      // string and only validates non-empty.
      let body: string;
      if (parsed.bodyStdin) {
        body = readFileSync(0, "utf8");
      } else if (parsed.bodyFile !== undefined) {
        body = readFileSync(parsed.bodyFile, "utf8");
      } else {
        body = parsed.body ?? "";
      }
      const validated: IntakeCommentOptions = intakeCommentOptionsSchema.parse({
        canonicalId: parsed.canonicalId,
        body,
        repo: parsed.repo,
        dryRun: parsed.dryRun,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    // GH-1318: submit actor verbs.
    if (parsed.command === "submit-body-template") {
      const handler = deps.runBodyTemplate ?? runBodyTemplate;
      const validated: BodyTemplateOptions = bodyTemplateOptionsSchema.parse({
        closes: parsed.closes,
        repo: parsed.repo,
        prefix: parsed.prefix,
        suffix: parsed.suffix,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "submit-postmerge") {
      const handler = deps.runPostmerge ?? runPostmerge;
      const validated: PostmergeOptions = postmergeOptionsSchema.parse({
        prNumber: parsed.prNumber,
        repo: parsed.repo,
        dryRun: parsed.dryRun,
        format: parsed.format,
        ...(parsed.commentTemplate !== undefined
          ? { commentTemplate: parsed.commentTemplate }
          : {}),
      });
      return handler(validated, output);
    }

    // GH-2262: producer of the submit artifact. Resolves git state, writes the
    // patch + metadata into the submit CAS, and advances `<UoW>:submit@<slot>`
    // — the ref the `publish` consumer reads.
    if (parsed.command === "submit-stage") {
      const stageOpts: StageOptions = {
        workUnitId: parsed.workUnitId,
        slot: parsed.slot,
        baseRef: parsed.baseRef,
        dryRun: parsed.dryRun,
        format: parsed.format,
        ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      };
      return (async () => {
        try {
          const render = await runSubmitStage(stageOpts);
          output.log(formatStageRender(render, parsed.format));
          return render.exitCode;
        } catch (err) {
          if (err instanceof StageError) {
            output.error(err.message);
            return err.exitCode;
          }
          throw err;
        }
      })();
    }

    // GH-1900: consumer of the submit-session artifact. Reads the CAS-backed
    // artifact, runs the parity preflight, pushes the head branch, opens the
    // PR, and advances `<UoW>:submit@<slot>` to `<UoW>:submit@published`.
    if (parsed.command === "submit-publish") {
      const publishOpts: PublishOptions = {
        fromCas: parsed.fromCas,
        dryRun: parsed.dryRun,
        ready: parsed.ready,
        format: parsed.format,
      };
      return (async () => {
        // GH-2269 / GH-2338: when a signer is configured (PRX_PROVENANCE_KEY=dev),
        // inject provenance deps so a clean push emits a signed SLSA `push/v1`
        // derivation. The ledger is `--ledger` if given (explicit override), else
        // the canonical per-UoW anchored-chain ledger (GH-2338) — the same path
        // the merge-guard later reads, so AC-1 closes end-to-end. `resolveCanon-
        // icalChainLedger` returns null off a reserved UoW and on the read-only
        // mainx replica (I-WS5), so emission stays off there. Emission is best-
        // effort/fail-open; a null signer (the prod default until Sigstore lands)
        // leaves emission off.
        let store: ReturnType<typeof openAnchoredChain> | null = null;
        const publishDeps: PublishDeps = {};
        const emissionLedger =
          parsed.ledger ?? resolveCanonicalChainLedger(process.cwd())?.ledgerPath;
        if (emissionLedger !== undefined) {
          const signer = resolveProvenanceSigner();
          if (signer !== null) {
            // `info/provenance/` may not exist yet; bun:sqlite creates the file
            // but not the parent dir.
            mkdirSync(dirname(emissionLedger), { recursive: true });
            store = openAnchoredChain(emissionLedger);
            publishDeps.attest = { signer, store: store.derivations };
          }
        }
        // GH-2249 publisher-tier enforcement (I-PROV1): the surface reads its own
        // flag and resolves the matching verifier; the core publish function
        // stays env-free. Unset flag ⇒ no verification (unchanged behaviour).
        if (requireSignedDerivations()) {
          publishDeps.requireSigned = true;
          const verifier = resolveProvenanceVerifier();
          if (verifier !== null) publishDeps.verifier = verifier;
        }
        try {
          const render = await runSubmitPublish(publishOpts, publishDeps);
          output.log(formatPublishRender(render, parsed.format));
          return render.exitCode;
        } catch (err) {
          if (err instanceof PublishError) {
            output.error(err.message);
            return err.exitCode;
          }
          throw err;
        } finally {
          store?.close();
        }
      })();
    }

    // GH-1559 (GH-1398 ADR §4): shared dispatcher for the publisher
    // publication-transition verbs. Consumed both by the `prx publisher`
    // command and by the `prx doctor merge|ready|draft` deprecation aliases.
    const dispatchPublisherVerb = async (
      verb: "merge" | "ready" | "draft",
      target: { workUnitId: string; repoPath: string },
      format: "plain" | "json",
      method: "MERGE" | "SQUASH" | "REBASE" | undefined,
      noUpdateBranch: boolean | undefined,
      ledgerPath: string | undefined,
      pubOutput: { log: (line: string) => void; error: (line: string) => void },
    ): Promise<number> => {
      // GH-2249 (I-PROV1): for the gated transitions, re-verify the head
      // commit's ledger derivations and inject the verdict so the synchronous
      // gate reads it as a derived axis. `undefined` ⇒ the gate is unchanged.
      const provenanceAxis =
        verb === "draft"
          ? undefined
          : await resolveMergeGuardProvenanceAxis(target.repoPath, ledgerPath);
      const provDeps = provenanceAxis === undefined ? {} : { provenanceAxis };
      if (verb === "merge") {
        const handler = deps.runPublisherMerge ?? publisherRunMerge;
        return handler(
          target,
          {
            method: method ?? "SQUASH",
            noUpdateBranch: noUpdateBranch ?? false,
          },
          format,
          pubOutput,
          provDeps,
        );
      }
      if (verb === "ready") {
        const handler = deps.runPublisherReady ?? publisherRunReady;
        return handler(target, format, pubOutput, provDeps);
      }
      const handler = deps.runPublisherDraft ?? publisherRunDraft;
      return handler(target, format, pubOutput);
    };

    // GH-2282: read-only print of the persisted dev provenance identity.
    // Generate-on-demand (via the same resolver the signer uses) so the command
    // doubles as a bootstrap-and-inspect for the zero-config dev verify loop.
    if (parsed.command === "provenance-dev-pubkey") {
      const { path, source } = resolveDevKeyPathForDisplay();
      const kp = loadOrCreateDevKeypair();
      if (parsed.format === "json") {
        output.log(
          JSON.stringify({ point: kp.point, keyid: kp.keyid, path, source }),
        );
      } else {
        output.log(`point:  ${kp.point}`);
        output.log(`keyid:  ${kp.keyid}`);
        output.log(`path:   ${path}`);
        output.log(`source: ${source}`);
      }
      return 0;
    }

    // GH-885 + GH-882: doctor actor — read-only `inventory`. GH-1559: the
    // `merge` / `ready` / `draft` verbs moved to `prx publisher`; they stay
    // here one release window as deprecation aliases that print a one-line
    // notice to stderr, then delegate to the publisher handler so stdout/JSON
    // stays clean.
    if (parsed.command === "doctor") {
      const target = {
        workUnitId: parsed.workUnitId,
        repoPath: process.cwd(),
      };
      const doctorOutput = {
        log: (line: string) => output.log(line),
        error: (line: string) => output.error(line),
      };
      if (parsed.verb === "inventory") {
        const handler = deps.runDoctorInventory ?? doctorRunInventory;
        return handler(target, parsed.format, doctorOutput);
      }
      doctorOutput.error(
        `prx doctor ${parsed.verb} is deprecated; use \`prx publisher ${parsed.verb}\``,
      );
      return dispatchPublisherVerb(
        parsed.verb,
        target,
        parsed.format,
        parsed.method,
        parsed.noUpdateBranch,
        parsed.ledger,
        doctorOutput,
      );
    }

    // GH-1559 (GH-1398 ADR §4): publisher actor verbs.
    if (parsed.command === "publisher") {
      const target = {
        workUnitId: parsed.workUnitId,
        repoPath: process.cwd(),
      };
      const publisherOutput = {
        log: (line: string) => output.log(line),
        error: (line: string) => output.error(line),
      };
      return dispatchPublisherVerb(
        parsed.verb,
        target,
        parsed.format,
        parsed.method,
        parsed.noUpdateBranch,
        parsed.ledger,
        publisherOutput,
      );
    }

    // GH-1560: `prx publisher pr open|update` — forge PR-open / update-branch.
    if (parsed.command === "publisher-pr") {
      const target = {
        workUnitId: parsed.workUnitId,
        repoPath: process.cwd(),
      };
      const publisherOutput = {
        log: (line: string) => output.log(line),
        error: (line: string) => output.error(line),
      };
      if (parsed.verb === "open") {
        const open = deps.runPublisherPrOpen ?? publisherRunPrOpen;
        return open(
          target,
          {
            summary: parsed.title ?? "",
            ...(parsed.closes !== undefined ? { closes: parsed.closes } : {}),
            ...(parsed.base !== undefined ? { base: parsed.base } : {}),
            ready: parsed.ready,
          },
          parsed.format,
          publisherOutput,
        );
      }
      // ai-home-2ow2v: forge comment/edit verbs (gh pr comment / gh pr edit).
      if (parsed.verb === "comment") {
        const comment = deps.runPublisherPrComment ?? publisherRunPrComment;
        return comment(
          target,
          { body: parsed.body ?? "" },
          parsed.format,
          publisherOutput,
        );
      }
      if (parsed.verb === "edit") {
        const edit = deps.runPublisherPrEdit ?? publisherRunPrEdit;
        return edit(
          target,
          {
            ...(parsed.title !== undefined ? { title: parsed.title } : {}),
            ...(parsed.bodyFile !== undefined ? { bodyFile: parsed.bodyFile } : {}),
          },
          parsed.format,
          publisherOutput,
        );
      }
      const update = deps.runPublisherPrUpdate ?? publisherRunPrUpdate;
      return update(
        target,
        parsed.title !== undefined ? { title: parsed.title } : {},
        parsed.format,
        publisherOutput,
      );
    }

    // GH-1533: audit read-back — `gh` GraphQL spend grouped by prx verb.
    if (parsed.command === "doctor-gh-budget") {
      return runDoctorGhBudget({ sinceMs: parsed.sinceMs, format: parsed.format }, output, deps);
    }

    // GH-1508: ADR §6 substrate-tier dedupe verb.
    if (parsed.command === "doctor-dedupe-bd") {
      const handler = deps.runDoctorDedupeBd ?? doctorRunDedupeBd;
      return handler(
        { apply: parsed.apply, only: parsed.only, format: parsed.format },
        { log: (line: string) => output.log(line), error: (line: string) => output.error(line) },
      );
    }

    // GH-1823: audit verb — adherence metrics over the artifact graph.
    if (parsed.command === "audit-ingest") {
      return runAuditIngest(
        { ...(parsed.since !== undefined ? { since: parsed.since } : {}), format: parsed.format },
        output,
      );
    }
    if (parsed.command === "audit-uow") {
      return runAuditUow(
        { workUnitId: parsed.workUnitId, format: parsed.format },
        output,
      );
    }
    if (parsed.command === "audit-system") {
      return runAuditSystem(
        { ...(parsed.since !== undefined ? { since: parsed.since } : {}), format: parsed.format },
        output,
      );
    }

    // GH-1407: services verb — Anthropic prompt-cache hit-rate projector.
    if (parsed.command === "services-status") {
      return runServicesStatus(
        {
          anthropic: parsed.anthropic,
          ...(parsed.window !== undefined ? { window: parsed.window } : {}),
          by: parsed.by,
          format: parsed.format,
        },
        output,
      );
    }

    if (parsed.command === "intake-mirror") {
      const handler = deps.runIntakeMirror ?? runIntakeMirror;
      const validated: IntakeMirrorOptions = intakeMirrorOptionsSchema.parse({
        ghId: parsed.ghId,
        repo: parsed.repo,
        dryRun: parsed.dryRun,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-bd-ls") {
      const handler = deps.runIntakeBdLs ?? runIntakeBdLs;
      const validated: IntakeBdLsOptions = intakeBdLsOptionsSchema.parse({
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        limit: parsed.limit,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-bd-memory-ls") {
      const handler = deps.runIntakeBdMemoryLs ?? runIntakeBdMemoryLs;
      const validated: IntakeBdMemoryLsOptions = intakeBdMemoryLsOptionsSchema.parse({
        ...(parsed.search !== undefined ? { search: parsed.search } : {}),
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-bd-memory-get") {
      const handler = deps.runIntakeBdMemoryGet ?? runIntakeBdMemoryGet;
      const validated: IntakeBdMemoryGetOptions = intakeBdMemoryGetOptionsSchema.parse({
        key: parsed.key,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake-bd-memory-set") {
      const handler = deps.runIntakeBdMemorySet ?? runIntakeBdMemorySet;
      const validated: IntakeBdMemorySetOptions = intakeBdMemorySetOptionsSchema.parse({
        key: parsed.key,
        body: parsed.body,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "intake") {
      const handler = deps.runIntake ?? runIntake;
      // GH-876: default --scope from cwd worktree when unset. Explicit --scope
      // always wins because we only fill on undefined.
      let scope = parsed.scope;
      if (parsed.scope === undefined) {
        const infer = deps.inferOperatorScopeFromCwd ?? inferOperatorScopeFromCwd;
        const inferred = infer(process.cwd());
        if (inferred.scope) {
          scope = inferred.scope;
          output.error(`scope (inferred from cwd): ${inferred.scope}`);
        }
      }
      const validated: IntakeOptions = intakeOptionsSchema.parse({
        type: parsed.type,
        title: parsed.title,
        scope,
        body: parsed.body,
        bodyFile: parsed.bodyFile,
        bodyStdin: parsed.bodyStdin,
        description: parsed.description,
        design: parsed.design,
        acceptance: parsed.acceptance,
        notes: parsed.notes,
        labels: parsed.labels,
        assignees: parsed.assignees,
        repo: parsed.repo,
        to: parsed.to,
        dryRun: parsed.dryRun,
        yes: parsed.yes,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "triage-status") {
      const handler = deps.runTriageStatus ?? runTriageStatus;
      // GH-1697: `--repo <slug>` is a registered-repo router, not a gh
      // `owner/repo` passthrough. Resolve the slug to the target's mainx
      // and clear `opts.repo` so the handler derives the gh identity from
      // the routed cwd's `.git/config`.
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageStatusOptions = triageStatusOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        format: parsed.format,
        limit: parsed.limit,
        includeIntentional: parsed.includeIntentional,
        rateLimit: parsed.rateLimit,
        maxStaleness: parsed.maxStaleness,
        noRefresh: parsed.noRefresh,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "triage-classify") {
      const handler = deps.runTriageClassify ?? runTriageClassify;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageClassifyOptions = triageClassifyOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        from: parsed.from,
        format: parsed.format,
        limit: parsed.limit,
        requireBudget: parsed.requireBudget,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "triage-apply") {
      const handler = deps.runTriageApply ?? runTriageApply;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageApplyOptions = triageApplyOptionsSchema.parse({
        plan: parsed.plan,
        repo: cwdFn ? undefined : parsed.repo,
        dryRun: parsed.dryRun,
        limit: parsed.limit,
        sync: parsed.sync,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "triage-promote") {
      const handler = deps.runTriagePromote ?? runTriagePromote;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriagePromoteOptions = triagePromoteOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        from: parsed.from,
        dryRun: parsed.dryRun,
        limit: parsed.limit,
        only: parsed.only,
      });
      return handler(validated, output, {
        loadAllBeads: () => beadsCache.load(),
        invalidateBeadsCache: beadsCache.invalidate,
        ...(cwdFn ? { cwd: cwdFn } : {}),
      });
    }

    if (parsed.command === "triage-promote-children") {
      const handler =
        deps.runTriagePromoteChildren ?? runTriagePromoteChildren;
      const validated: TriagePromoteChildrenOptions =
        triagePromoteChildrenOptionsSchema.parse({
          dir: parsed.dir,
          dryRun: parsed.dryRun,
          limit: parsed.limit,
          only: parsed.only,
        });
      return handler(validated, output);
    }

    if (parsed.command === "triage-close") {
      const handler = deps.runTriageClose ?? runTriageClose;
      const validated: TriageCloseOptions = triageCloseOptionsSchema.parse({
        bdId: parsed.bdId,
        reason: parsed.reason,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        dryRun: parsed.dryRun,
        format: parsed.format,
      });
      const result = handler(validated, output, {
        loadAllBeads: () => beadsCache.load(),
        invalidateBeadsCache: beadsCache.invalidate,
      });
      if (parsed.format === "json") {
        output.log(formatTriageCloseResult(result, "json"));
      }
      if (result.refusalReason !== null) return 1;
      return 0;
    }

    if (parsed.command === "triage-close-stale") {
      const handler = deps.runTriageCloseStale ?? runTriageCloseStale;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageCloseStaleOptions = triageCloseStaleOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        reason: parsed.reason,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        dryRun: parsed.dryRun,
        limit: parsed.limit,
        format: parsed.format,
      });
      const result = handler(validated, output, {
        invalidateBeadsCache: beadsCache.invalidate,
        ...(cwdFn ? { cwd: cwdFn } : {}),
      });
      if (parsed.format === "json") {
        output.log(formatTriageCloseStaleResult(result, "json"));
      }
      return result.errors > 0 ? 1 : 0;
    }

    if (parsed.command === "triage-drift-fix") {
      const handler = deps.runTriageDriftFix ?? runTriageDriftFix;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageDriftFixOptions = triageDriftFixOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        from: parsed.from,
        apply: parsed.apply,
        dryRun: parsed.dryRun,
        limit: parsed.limit,
        axes: parsed.axes,
        sync: parsed.sync,
      });
      return handler(validated, output, {
        loadAllBeads: () => beadsCache.load(),
        invalidateBeadsCache: beadsCache.invalidate,
        ...(cwdFn ? { cwd: cwdFn } : {}),
      });
    }

    if (parsed.command === "triage-migrate-axis-value") {
      const handler = deps.runTriageMigrateAxisValue ?? runTriageMigrateAxisValue;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageMigrateAxisValueOptions = triageMigrateAxisValueOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        axis: parsed.axis,
        from: parsed.from,
        to: parsed.to,
        apply: parsed.apply,
        limit: parsed.limit,
        sync: parsed.sync,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "triage-prioritize") {
      const handler = deps.runTriagePrioritize ?? runTriagePrioritize;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriagePrioritizeOptions = triagePrioritizeOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        dryRun: parsed.dryRun,
        limit: parsed.limit,
        sync: parsed.sync,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "triage-type-pass") {
      const handler = deps.runTriageTypePass ?? runTriageTypePass;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriageTypePassOptions = triageTypePassOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        model: parsed.model,
        batchSize: parsed.batchSize,
        limit: parsed.limit,
        dryRun: parsed.dryRun,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "triage-prioritize-bulk") {
      const handler = deps.runTriagePrioritizeBulk ?? runTriagePrioritizeBulk;
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriagePrioritizeBulkOptions = triagePrioritizeBulkOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        model: parsed.model,
        batchSize: parsed.batchSize,
        limit: parsed.limit,
        dryRun: parsed.dryRun,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "map-create") {
      return (async () => {
        const opts: MapCreateOptions = mapCreateOptionsSchema.parse(
          parsed.fromFile
            ? {
                kind: "from-file",
                path: parsed.fromFile,
                repoRoot: process.cwd(),
              }
            : {
                kind: "inline",
                name: parsed.name,
                tickets: parsed.tickets,
                rationale: parsed.rationale,
                parents: parsed.parents,
                repoRoot: process.cwd(),
              },
        );
        const result = await runMapCreate(opts);
        output.log(
          `wrote ${result.path} — ${result.record.sequence.length} ticket(s)`,
        );
        return 0;
      })();
    }

    if (parsed.command === "map-show") {
      return (async () => {
        const opts: MapShowOptions = mapShowOptionsSchema.parse({
          name: parsed.name,
          repoRoot: process.cwd(),
          format: parsed.format,
        });
        try {
          const result = await runMapShow(opts);
          output.log(result.rendered);
          return 0;
        } catch (err) {
          if (err instanceof MapRecordNotFoundError) {
            output.error(`map show: ${err.message}`);
            return 1;
          }
          throw err;
        }
      })();
    }

    if (parsed.command === "triage-prime") {
      const handler = deps.runTriagePrime ?? runTriagePrime;
      // GH-1697: slug resolves so unknown slugs reject; opts.repo is cleared
      // so the inner `runStatusActor` loop derives the gh identity from cwd
      // instead of echoing the operator's input.
      // GH-1734: cwdFn now also threads into deps so the inter-iteration
      // `runStatusActor` re-roots at the target's mainx instead of process.cwd.
      const { cwdFn } = resolveTriageRepoCwd(parsed.repo, deps);
      const validated: TriagePrimeOptions = triagePrimeOptionsSchema.parse({
        repo: cwdFn ? undefined : parsed.repo,
        dryRun: parsed.dryRun,
        autoPrioritize: parsed.autoPrioritize,
        autoDriftFix: parsed.autoDriftFix,
        maxIterations: parsed.maxIterations,
        format: parsed.format,
      });
      return handler(validated, output, cwdFn ? { cwd: cwdFn } : {});
    }

    if (parsed.command === "ci") {
      const handler = deps.runCi ?? runCi;
      const validated: CiOptions = ciOptionsSchema.parse({
        phase: parsed.phase,
        format: parsed.format,
      });
      return handler(validated, output);
    }

    if (parsed.command === "triage-session") {
      // GH-2258: triage no longer runs *on* mainx. The session opens onto a
      // dedicated ephemeral worktree (`triage/<yyyymmdd>-<short>` off
      // origin/main) reserved via the `session_open` actor (I-SO1); see
      // docs/prx/triage-surface.md. `queueCwd` here is only used for the
      // canonical-beads queue read (decision 1: read canonical, never the
      // fresh worktree's `.beads`) and serves the `--check`/`--dry-run`
      // no-reserve paths.
      //
      // GH-1689: `--repo <slug>` retargets the queue read (and the reserve
      // base) at a registered bare's mainx worktree. We materialize the bare
      // first so the cwd points at fresh state, then probe `.beads/` mode
      // (GH-1684) before reading.
      let queueCwd: string;
      if (parsed.repoSlug) {
        const resolved = (deps.resolveTargetRepoCwd ?? resolveTargetRepoCwd)(
          { slug: parsed.repoSlug, cwd: process.cwd() },
          {
            loadRepoInventoryConfig: deps.loadRepoInventoryConfig,
            discoverLocalRepos: deps.discoverLocalRepos,
            findRepoBySlug: deps.findRepoBySlug,
            materializeBareRepo: deps.materializeBareRepo,
          },
        );
        queueCwd = resolved.targetCwd;
        const mode = (deps.classifyBeadsWorkspace ?? classifyBeadsWorkspace)(queueCwd);
        const hint = beadsModeHint(mode, parsed.repoSlug);
        if (hint !== null) {
          throw new CliError(hint);
        }
      } else {
        // Resolve the git toplevel so subdirectory invocations don't create a
        // nested .pr/ tree or set BEADS_WORKING_DIR to a non-root path.
        // GH-2258: the mainx-worktree guard is removed — the verb is now
        // cwd-independent (it reserves its own surface). Any git worktree of
        // the repo resolves the same canonical beads for the queue read.
        const invocationCwd = process.cwd();
        let gitToplevel: { status: number; stdout: string; stderr: string };
        try {
          gitToplevel = procRunner(["git", "rev-parse", "--show-toplevel"], {
            cwd: invocationCwd,
            check: false,
          });
        } catch (error) {
          gitToplevel = { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
        }
        if (gitToplevel.status !== 0) {
          const detail = gitToplevel.stderr.trim();
          throw new CliError(
            detail
              ? `prx triage agent: must run inside a git worktree. git rev-parse --show-toplevel failed: ${detail}`
              : "prx triage agent: must run inside a git worktree.",
          );
        }
        queueCwd = gitToplevel.stdout.trim();
        if (invocationCwd !== queueCwd) {
          output.error(`triage-session: using git toplevel '${queueCwd}' instead of invocation cwd '${invocationCwd}'`);
        }
      }

      // Hydrate queue summary (also serves as --check output).
      let queueSummary: TriageStatusResult | null = null;
      const queueOutput: Output = {
        log: () => {},
        error: () => {},
      };
      const triageHandler = deps.runTriageStatus ?? runTriageStatus;
      const triageOpts: TriageStatusOptions = triageStatusOptionsSchema.parse({
        format: "json",
        limit: 0,
      });
      // Capture the result by intercepting the formatted log line.
      let captured = "";
      const captureOutput: Output = {
        log: (line: string) => {
          captured = line;
          queueOutput.log(line);
        },
        error: (line: string) => queueOutput.error(line),
      };
      // GH-1689 / GH-2258: pin the queue-summary read at the resolved cwd
      // (canonical beads) — never the fresh ephemeral worktree's `.beads`.
      const triageStatus = triageHandler(triageOpts, captureOutput, { cwd: () => queueCwd });
      if (triageStatus !== 0) {
        return triageStatus;
      }
      try {
        queueSummary = JSON.parse(captured) as TriageStatusResult;
      } catch {
        // Fall through; queueSummary remains null, summary line is omitted.
      }

      if (parsed.check) {
        if (parsed.format === "json") {
          output.log(captured);
        } else if (queueSummary) {
          output.log(
            `triage queue: ${queueSummary.totalUntriaged} untriaged of ${queueSummary.totalOpen} open issues in ${queueSummary.repo}`,
          );
        } else {
          output.log("triage queue: status unavailable");
        }
        return 0;
      }

      if (queueSummary) {
        output.error(
          `triage queue: ${queueSummary.totalUntriaged} untriaged of ${queueSummary.totalOpen} open issues in ${queueSummary.repo}`,
        );
      }

      // prx-9p9: no pre-run banner (noise + a false "No execution"); the result
      // line is the signal — matches the intake agent.

      if (parsed.dryRun) {
        // Preview only: show the branch this call *would* reserve plus the
        // built profile. No worktree side-effect (no reserve). The profile is
        // built directly for display — a dry-run does not open a session, so
        // it does not route through `session_open` (I-SO1 governs the live
        // open path below).
        const branch = deriveSessionBranch({ actor: "triage" });
        output.error(`triage-session: would reserve ${branch} off origin/main`);
        const profile = dispatchFromArgv([
          "triage",
          "agent",
          ...(parsed.interactive ? ["--interactive"] : []),
          ...(parsed.message ? [parsed.message] : []),
        ]);
        output.log(formatRuntimeProfile(profile, parsed.format));
        return 0;
      }

      // GH-2258 (I-SO1): route the live open through the `session_open` actor.
      // It derives a fresh `triage/<yyyymmdd>-<short>` branch (I-SO2), reserves
      // the ephemeral worktree off origin/main, prepares it, dispatches the
      // session-entry machine to build the profile, and emits SESSION_OPEN_*
      // audit rows carrying workspace_id + uow_id (I-SO3). Wrapped in an async
      // IIFE (mirrors the other async handlers) since the enclosing dispatcher
      // body is synchronous.
      //
      // `liveCwd` starts at the resolved queue cwd (the reserve base — so
      // `--repo` reserves against the target repo), and the injected `chdir`
      // advances it to the reserved worktree before `prepare`/`dispatch` run,
      // matching `openSession`'s default process.cwd()/process.chdir() flow.
      return (async (): Promise<number> => {
      let liveCwd = queueCwd;
      const opened = await (deps.openSession ?? openSession)(
        {
          actor: "triage",
          // GH-2380: default headless; --interactive opts into tmux/PTY.
          ...(parsed.interactive ? { interaction: "interactive" } : {}),
          // prx-383: a positional work-unit id seeds triage at one item.
          ...(parsed.message ? { message: parsed.message } : {}),
        },
        {
          cwd: () => liveCwd,
          chdir: (p: string) => {
            liveCwd = p;
            process.chdir(p);
          },
        },
      );
      if (opened.status === "prepared") {
        output.log(
          `prx triage agent: prepared ${opened.worktree_path} (no-launch; PRX_SESSION_NO_LAUNCH set)`,
        );
        return 0;
      }
      if (opened.status === "error" || !opened.profile) {
        output.error(
          `prx triage agent: session-open failed at ${opened.stage ?? "dispatch"}: ${opened.error ?? "no profile built"}`,
        );
        return 1;
      }
      const profile = opened.profile;
      const spawnCwd = opened.worktree_path;

      // GH-1545: pre-approve the triage operator's own Bash(…) verbs into
      // .claude/settings.local.json so they skip the auto-mode permission
      // classifier once the operator ratchets out of plan mode — mirrors the
      // work-unit session-open precedent (`ensureClaudeInteractiveAllowlist`).
      // Pointed at the reserved ephemeral worktree (not the invocation cwd).
      const triageSessionAllowlist =
        (deps.ensureClaudeSessionAllowlist ?? ensureClaudeSessionProfileAllowlist)(spawnCwd, "triage");
      if (triageSessionAllowlist.status === "skipped-malformed") {
        output.error(buildMalformedAllowlistWarning(triageSessionAllowlist.path));
      }

      // prx-9p9: ensure the runtime MCP config exists (side effect); the triage
      // banner that surfaced its status is gone — the structured result speaks.
      (deps.ensureOpsRuntimeMcp ?? ensureOpsRuntimeMcp)(spawnCwd);

      const policy = POLICY;
      const startedAt = Date.now();
      // prx-9p9: snapshot beads to report the UoW(s) this triage run touched.
      const beadsBefore = snapshotBeadIds(queueCwd);
      // GH-2380: backend is derived — headless SDK by default,
      // subprocess/PTY under --interactive (or when tests inject execRuntime).
      const result = resolveAgentBackend(profile) === "sdk"
        ? agentProfileExecutionAsRuntimeResult(
            await executeAgentProfile(profile, {
              cwd: spawnCwd,
              format: "json",
              ...(deps.execRuntime ? { subprocessExecutor: deps.execRuntime } : {}),
            }),
          )
        : (deps.execRuntime ?? localRuntimeExecutor)(
            profile,
            "plain",
            spawnCwd,
            interactiveTimeoutMs("plain", policy.timeout_ms),
          );
      if (result.status !== 0) {
        const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
        output.error(
          `prx triage agent: claude exited ${result.status}${stderrTail ? ` — ${stderrTail}` : ""}`,
        );
      }
      const telemetry = {
        agent: "claude",
        status: result.status === 0 ? "success" : "error",
        input_hash: sha256(JSON.stringify({
          command: profile.command,
          args: profile.args,
          cwd: spawnCwd,
          policy,
        })),
        output_hash: sha256(`${result.stdout}\n${result.stderr}`),
        latency_ms: Date.now() - startedAt,
      };
      appendExecutionLog(
        spawnCwd,
        createRunRecord({
          agent: "claude",
          input_hash: telemetry.input_hash,
          output_hash: telemetry.output_hash,
          status: telemetry.status,
          latency_ms: telemetry.latency_ms,
          timestamp: Date.now(),
        }),
      );
      // prx-9p9: surface the result — read what the agent reported via
      // `prx triage result`, capture + pin to CAS, emit the schema-backed result.
      const beadsAfter = snapshotBeadIds(queueCwd);
      const reported = readReportedResult(spawnCwd);
      const { result: agentResult, diagnostics: triageDiagnostics } = await captureAgentResult({
        actor: "triage",
        workspaceId: opened.workspace_id,
        status: result.status,
        stdout: result.stdout ?? "",
        before: beadsBefore,
        after: beadsAfter,
        reported,
      });
      warnAgentContractDiagnostics(output, "triage", triageDiagnostics);
      emit(
        output,
        { schema: agentResultSchema, data: agentResult, pretty: renderAgentResult },
        parsed.format,
      );
      return result.status;
      })();
    }

    if (parsed.command === "intake-result") {
      // prx-lfv: the headless intake agent reports its outcome here (a non-MCP
      // CLI tool in its allowlist). Write the reported-result file in the
      // agent's worktree cwd; the parent reads it post-run to surface the UoW.
      const reported: ReportedResult = {
        disposition: parsed.disposition,
        ...(parsed.uow ? { uow: parsed.uow } : {}),
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      };
      writeReportedResult(process.cwd(), reported);
      output.log(
        `intake result: ${parsed.disposition}${parsed.uow ? ` ${parsed.uow}` : ""}${parsed.reason ? ` — ${parsed.reason}` : ""}`,
      );
      return 0;
    }

    if (parsed.command === "triage-result") {
      // prx-9p9: the headless triage agent reports its outcome here (a non-MCP
      // CLI tool in its allowlist), mirroring `prx intake result`. The parent
      // reads this file post-run to surface the disposition + UoW.
      const reported: ReportedResult = {
        disposition: parsed.disposition,
        ...(parsed.uow ? { uow: parsed.uow } : {}),
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      };
      writeReportedResult(process.cwd(), reported);
      output.log(
        `triage result: ${parsed.disposition}${parsed.uow ? ` ${parsed.uow}` : ""}${parsed.reason ? ` — ${parsed.reason}` : ""}`,
      );
      return 0;
    }

    if (parsed.command === "intake-session") {
      // GH-950: intake-session is the operator-session shape for pre-triage
      // intake (search → file-or-merge → mirror → comment).
      // GH-2258: like triage, intake no longer runs *on* mainx — the session
      // opens onto a dedicated ephemeral worktree (`intake/<yyyymmdd>-<short>`
      // off origin/main) reserved via the `session_open` actor (I-SO1); see
      // docs/prx/triage-surface.md. The mainx-worktree guard is removed; the
      // resolved git toplevel is used only for the `--check` readiness probe.
      const invocationCwd = process.cwd();
      let gitToplevel: { status: number; stdout: string; stderr: string };
      try {
        gitToplevel = procRunner(["git", "rev-parse", "--show-toplevel"], {
          cwd: invocationCwd,
          check: false,
        });
      } catch (error) {
        gitToplevel = { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      if (gitToplevel.status !== 0) {
        const detail = gitToplevel.stderr.trim();
        throw new CliError(
          detail
            ? `prx intake agent: must run inside a git worktree. git rev-parse --show-toplevel failed: ${detail}`
            : "prx intake agent: must run inside a git worktree.",
        );
      }
      const queueCwd = gitToplevel.stdout.trim();
      if (invocationCwd !== queueCwd) {
        output.error(`intake-session: using git toplevel '${queueCwd}' instead of invocation cwd '${invocationCwd}'`);
      }

      if (parsed.check) {
        // No queue analog for intake; --check just confirms readiness — and
        // must not reserve a worktree. `binding` still reads "mainx" from the
        // intake profile config; the badge/identity rename is child 3 (GH-2256).
        if (parsed.format === "json") {
          output.log(JSON.stringify({ profile: "intake", binding: "mainx", cwd: queueCwd }));
        } else {
          output.log(`intake agent: ready on ${queueCwd}`);
        }
        return 0;
      }

      // prx-lfv: no pre-run banner — it was noise and its "No execution" clause
      // was false for the headless agent. The result line (`prx intake agent:
      // filed/merged/…`) is the operator's signal.

      if (parsed.dryRun) {
        // Preview only (no reserve): show the would-be branch + the built
        // profile. A dry-run does not open a session, so it builds the profile
        // directly rather than routing through `session_open` (I-SO1 governs
        // the live open path below).
        const branch = deriveSessionBranch({ actor: "intake" });
        output.error(`intake-session: would reserve ${branch} off origin/main`);
        const profile = dispatchFromArgv([
          "intake",
          "agent",
          ...(parsed.interactive ? ["--interactive"] : []),
          ...(parsed.message ? ["--message", parsed.message] : []),
        ]);
        output.log(formatRuntimeProfile(profile, parsed.format));
        return 0;
      }

      // GH-2258 (I-SO1): route the live open through the `session_open` actor —
      // fresh `intake/<yyyymmdd>-<short>` branch (I-SO2), reserve off
      // origin/main, prepare, dispatch the profile, emit SESSION_OPEN_* audit
      // rows carrying workspace_id + uow_id (I-SO3). Wrapped in an async IIFE
      // (mirrors the other async handlers) since the dispatcher body is sync.
      // `liveCwd` (reserve base → reserved worktree via the injected chdir)
      // mirrors `openSession`'s default process.cwd()/process.chdir() flow.
      return (async (): Promise<number> => {
      let liveCwd = queueCwd;
      const opened = await (deps.openSession ?? openSession)(
        {
          actor: "intake",
          // GH-2380: default headless; --interactive opts into tmux/PTY.
          ...(parsed.interactive ? { interaction: "interactive" } : {}),
          // prx-28w: free-text seed aims intake at one item.
          ...(parsed.message ? { message: parsed.message } : {}),
        },
        {
          cwd: () => liveCwd,
          chdir: (p: string) => {
            liveCwd = p;
            process.chdir(p);
          },
        },
      );
      if (opened.status === "prepared") {
        output.log(
          `prx intake agent: prepared ${opened.worktree_path} (no-launch; PRX_SESSION_NO_LAUNCH set)`,
        );
        return 0;
      }
      if (opened.status === "error" || !opened.profile) {
        output.error(
          `prx intake agent: session-open failed at ${opened.stage ?? "dispatch"}: ${opened.error ?? "no profile built"}`,
        );
        return 1;
      }
      const profile = opened.profile;
      const spawnCwd = opened.worktree_path;

      // GH-1545: pre-approve the intake operator's own Bash(…) verbs into
      // .claude/settings.local.json so `prx intake …` skips the auto-mode
      // permission classifier once the operator ratchets out of plan mode —
      // mirrors the work-unit session-open precedent. Pointed at the reserved
      // ephemeral worktree (not the invocation cwd).
      const intakeSessionAllowlist =
        (deps.ensureClaudeSessionAllowlist ?? ensureClaudeSessionProfileAllowlist)(spawnCwd, "intake");
      if (intakeSessionAllowlist.status === "skipped-malformed") {
        output.error(buildMalformedAllowlistWarning(intakeSessionAllowlist.path));
      }

      // Provision the ops-runtime MCP (side effect); the status is no longer
      // surfaced now that the run emits the schema-backed AgentResult.
      (deps.ensureOpsRuntimeMcp ?? ensureOpsRuntimeMcp)(spawnCwd);

      const policy = POLICY;
      const startedAt = Date.now();
      // prx-lfv: snapshot the bead set so we can report the UoW(s) this run
      // produces — the difference after/before is what intake created.
      const beadsBefore = snapshotBeadIds(queueCwd);
      // GH-2380: backend is derived — headless SDK by default,
      // subprocess/PTY under --interactive (or when tests inject execRuntime).
      const result = resolveAgentBackend(profile) === "sdk"
        ? agentProfileExecutionAsRuntimeResult(
            await executeAgentProfile(profile, {
              cwd: spawnCwd,
              format: "json",
              ...(deps.execRuntime ? { subprocessExecutor: deps.execRuntime } : {}),
            }),
          )
        : (deps.execRuntime ?? localRuntimeExecutor)(
            profile,
            "plain",
            spawnCwd,
            interactiveTimeoutMs("plain", policy.timeout_ms),
          );
      if (result.status !== 0) {
        const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
        output.error(
          `prx intake agent: claude exited ${result.status}${stderrTail ? ` — ${stderrTail}` : ""}`,
        );
      }
      const telemetry = {
        agent: "claude",
        status: result.status === 0 ? "success" : "error",
        input_hash: sha256(JSON.stringify({
          command: profile.command,
          args: profile.args,
          cwd: spawnCwd,
          policy,
        })),
        output_hash: sha256(`${result.stdout}\n${result.stderr}`),
        latency_ms: Date.now() - startedAt,
      };
      appendExecutionLog(
        spawnCwd,
        createRunRecord({
          agent: "claude",
          input_hash: telemetry.input_hash,
          output_hash: telemetry.output_hash,
          status: telemetry.status,
          latency_ms: telemetry.latency_ms,
          timestamp: Date.now(),
        }),
      );
      // prx-lfv: surface the run's result + pin it to the CAS (the uniform
      // return channel) — never a silent success. Prefer the disposition the
      // agent reported via `prx intake result` (existing-issue / reason);
      // fall back to the bead diff.
      const beadsAfter = snapshotBeadIds(queueCwd);
      const reported = readReportedResult(spawnCwd);
      const { ref: resultRef, result: agentResult, diagnostics: intakeDiagnostics } =
        await captureAgentResult({
          actor: "intake",
          workspaceId: opened.workspace_id,
          status: result.status,
          stdout: result.stdout ?? "",
          before: beadsBefore,
          after: beadsAfter,
          reported,
        });
      // prx-bs4: surface an artifact-contract violation (intake misreported its
      // disposition) instead of silently dropping the CAS pin.
      warnAgentContractDiagnostics(output, "intake", intakeDiagnostics);
      // prx-9kd: one schema-backed structured value, one printer. The `--json`
      // surface is the validated AgentResult contract; plain is its render.
      void resultRef; // pinned to CAS for the return channel; not in the surface.
      emit(
        output,
        {
          schema: agentResultSchema,
          data: agentResult,
          pretty: renderAgentResult,
        },
        parsed.format,
      );
      return result.status;
      })();
    }

    if (parsed.command === "submit-session") {
      // GH-1740: submit-session is the operator-session shape for the submit
      // operator. GH-1900: flipped to work-unit-bound — mirrors author-session
      // (cwd guard → banner → dispatch with workUnitId → ensure allowlist
      // → execRuntime → telemetry); the mainx-worktree guard is dropped
      // because the session is per-unit, not unit-less.
      const invocationCwd = process.cwd();
      let gitToplevel: { status: number; stdout: string; stderr: string };
      try {
        gitToplevel = procRunner(["git", "rev-parse", "--show-toplevel"], {
          cwd: invocationCwd,
          check: false,
        });
      } catch (error) {
        gitToplevel = { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      if (gitToplevel.status !== 0) {
        const detail = gitToplevel.stderr.trim();
        throw new CliError(
          detail
            ? `prx submit agent: must run inside a git worktree. git rev-parse --show-toplevel failed: ${detail}`
            : "prx submit agent: must run inside a git worktree.",
        );
      }
      const cwd = gitToplevel.stdout.trim();
      if (invocationCwd !== cwd) {
        output.error(`submit-session: using git toplevel '${cwd}' instead of invocation cwd '${invocationCwd}'`);
      }

      if (parsed.check) {
        // Cwd/profile readiness probe. The check path may run without a
        // work-unit positional (matches author-session).
        if (parsed.format === "json") {
          output.log(JSON.stringify({ profile: "submit", binding: "work-unit", cwd }));
        } else {
          output.log(`submit agent: ready on ${cwd}`);
        }
        return 0;
      }

      output.error(SESSION_PROFILES.submit.banner);

      if (parsed.dryRun) {
        // Preview only (no reserve): build the profile directly for display.
        // A dry-run does not open a session, so it does not route through
        // `session_open` (I-SO1 governs the live open path below).
        const profile = dispatchSessionEntryEvent({
          type: "OPEN_SUBMIT_SESSION",
          workUnitId: parsed.workUnitId,
          // GH-2380: default headless; --interactive opts into tmux/PTY.
          ...(parsed.interactive ? { interaction: "interactive" } : {}),
        });
        output.log(formatRuntimeProfile(profile, parsed.format));
        return 0;
      }

      // GH-2280 (I-SO1): the live submit session MUST route through the
      // `session_open` actor — direct `dispatchSessionEntryEvent` here ran the
      // session in the operator's cwd (the mainx-leak GH-2027 exists to kill).
      if (!parsed.workUnitId) {
        throw new CliError(
          "prx submit session: requires a work-unit id",
        );
      }

      // GH-2280 (I-SO1): reserve a `<workUnitId>` worktree off origin/main,
      // prepare it, dispatch the session-entry machine to build the profile,
      // and emit SESSION_OPEN_* audit rows carrying workspace_id + uow_id
      // (I-SO3). Wrapped in an async IIFE (mirrors triage/intake) since the
      // enclosing dispatcher body is synchronous. `liveCwd` starts at the
      // resolved git toplevel (the reserve base) and the injected `chdir`
      // advances it to the reserved worktree, matching `openSession`'s default
      // process.cwd()/process.chdir() flow.
      return (async (): Promise<number> => {
      let liveCwd = cwd;
      const opened = await (deps.openSession ?? openSession)(
        {
          actor: "submit",
          workUnitId: parsed.workUnitId,
          // GH-2380: default headless; --interactive opts into tmux/PTY.
          ...(parsed.interactive ? { interaction: "interactive" } : {}),
        },
        {
          cwd: () => liveCwd,
          chdir: (p: string) => {
            liveCwd = p;
            process.chdir(p);
          },
        },
      );
      if (opened.status === "prepared") {
        output.log(
          `prx submit session: prepared ${opened.worktree_path} (no-launch; PRX_SESSION_NO_LAUNCH set)`,
        );
        return 0;
      }
      if (opened.status === "error" || !opened.profile) {
        output.error(
          `prx submit session: session-open failed at ${opened.stage ?? "dispatch"}: ${opened.error ?? "no profile built"}`,
        );
        return 1;
      }
      const profile = opened.profile;
      const spawnCwd = opened.worktree_path;

      const submitSessionAllowlist =
        (deps.ensureClaudeSessionAllowlist ?? ensureClaudeSessionProfileAllowlist)(spawnCwd, "submit");
      if (submitSessionAllowlist.status === "skipped-malformed") {
        output.error(buildMalformedAllowlistWarning(submitSessionAllowlist.path));
      }

      const mcpStatus = (deps.ensureOpsRuntimeMcp ?? ensureOpsRuntimeMcp)(spawnCwd);

      const policy = POLICY;
      const startedAt = Date.now();
      // GH-2380: backend is derived — headless SDK by default,
      // subprocess/PTY under --interactive (or when tests inject execRuntime).
      // GH-2280: every execution targets the reserved worktree (spawnCwd).
      const result = resolveAgentBackend(profile) === "sdk"
        ? agentProfileExecutionAsRuntimeResult(
            await executeAgentProfile(profile, {
              cwd: spawnCwd,
              format: "json",
              ...(deps.execRuntime ? { subprocessExecutor: deps.execRuntime } : {}),
            }),
          )
        : (deps.execRuntime ?? localRuntimeExecutor)(
            profile,
            "plain",
            spawnCwd,
            interactiveTimeoutMs("plain", policy.timeout_ms),
          );
      if (result.status !== 0) {
        const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
        output.error(
          `prx submit agent: claude exited ${result.status}${stderrTail ? ` — ${stderrTail}` : ""}`,
        );
      }
      const telemetry = {
        agent: "claude",
        status: result.status === 0 ? "success" : "error",
        input_hash: sha256(JSON.stringify({
          command: profile.command,
          args: profile.args,
          cwd: spawnCwd,
          policy,
        })),
        output_hash: sha256(`${result.stdout}\n${result.stderr}`),
        latency_ms: Date.now() - startedAt,
      };
      appendExecutionLog(
        spawnCwd,
        createRunRecord({
          agent: "claude",
          input_hash: telemetry.input_hash,
          output_hash: telemetry.output_hash,
          status: telemetry.status,
          latency_ms: telemetry.latency_ms,
          timestamp: Date.now(),
        }),
      );
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              profile,
              cwd: spawnCwd,
              workspace_id: opened.workspace_id,
              branch_ref: opened.branch_ref,
              mcpStatus,
              policy,
              telemetry,
              status: result.status,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
      }
      return result.status;
      })();
    }

    // GH-1206: `prx author body-template --unit <id>` — pure renderer that
    // emits a CLAUDE.md PR-Standards run-sheet body for paste into
    // `gh pr create --body-file` or `gh pr edit --body-file`.
    if (parsed.command === "author-body-template") {
      const validated: AuthorBodyTemplateOptions = authorBodyTemplateOptionsSchema.parse({
        unit: parsed.unit,
        base: parsed.base,
        format: parsed.format,
      });
      return runAuthorBodyTemplate(validated, output);
    }

    if (parsed.command === "author-session") {
      // GH-1206: author-session is the work-unit PR author profile between
      // implement and prune. Read+gh-pr-only (no Edit/Write on source, no
      // `git push`, no `gh pr merge`). Shape mirrors submit/intake-session
      // (cwd guard → banner → dispatch → ensure allowlist → execRuntime →
      // telemetry) but adds a work-unit-id positional and binds via
      // OPEN_AUTHOR_SESSION instead of OPEN_SUBMIT_SESSION.
      const invocationCwd = process.cwd();
      let gitToplevel: { status: number; stdout: string; stderr: string };
      try {
        gitToplevel = procRunner(["git", "rev-parse", "--show-toplevel"], {
          cwd: invocationCwd,
          check: false,
        });
      } catch (error) {
        gitToplevel = { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      if (gitToplevel.status !== 0) {
        const detail = gitToplevel.stderr.trim();
        throw new CliError(
          detail
            ? `prx author agent: must run inside a git worktree. git rev-parse --show-toplevel failed: ${detail}`
            : "prx author agent: must run inside a git worktree.",
        );
      }
      const cwd = gitToplevel.stdout.trim();
      if (invocationCwd !== cwd) {
        output.error(`author-session: using git toplevel '${cwd}' instead of invocation cwd '${invocationCwd}'`);
      }

      if (parsed.check) {
        if (parsed.format === "json") {
          output.log(JSON.stringify({ profile: "author", binding: "work-unit", cwd }));
        } else {
          output.log(`author agent: ready on ${cwd}`);
        }
        return 0;
      }

      output.error(SESSION_PROFILES.author.banner);

      if (parsed.dryRun) {
        // Preview only (no reserve): build the profile directly for display.
        // A dry-run does not open a session, so it does not route through
        // `session_open` (I-SO1 governs the live open path below).
        const profile = dispatchSessionEntryEvent({
          type: "OPEN_AUTHOR_SESSION",
          workUnitId: parsed.workUnitId,
          // GH-2380: default headless; --interactive opts into tmux/PTY.
          ...(parsed.interactive ? { interaction: "interactive" } : {}),
        });
        output.log(formatRuntimeProfile(profile, parsed.format));
        return 0;
      }

      // GH-2280 (I-SO1): the live author session MUST route through the
      // `session_open` actor — direct `dispatchSessionEntryEvent` here ran the
      // session in the operator's cwd (the mainx-leak GH-2027 exists to kill).
      if (!parsed.workUnitId) {
        throw new CliError(
          "prx author session: requires a work-unit id",
        );
      }

      // GH-2280 (I-SO1): reserve a `<workUnitId>` worktree off origin/main,
      // prepare it, dispatch the session-entry machine to build the profile,
      // and emit SESSION_OPEN_* audit rows carrying workspace_id + uow_id
      // (I-SO3). Wrapped in an async IIFE (mirrors triage/intake) since the
      // enclosing dispatcher body is synchronous. `liveCwd` starts at the
      // resolved git toplevel (the reserve base) and the injected `chdir`
      // advances it to the reserved worktree, matching `openSession`'s default
      // process.cwd()/process.chdir() flow.
      return (async (): Promise<number> => {
      let liveCwd = cwd;
      const opened = await (deps.openSession ?? openSession)(
        {
          actor: "author",
          workUnitId: parsed.workUnitId,
          // GH-2380: default headless; --interactive opts into tmux/PTY.
          ...(parsed.interactive ? { interaction: "interactive" } : {}),
        },
        {
          cwd: () => liveCwd,
          chdir: (p: string) => {
            liveCwd = p;
            process.chdir(p);
          },
        },
      );
      if (opened.status === "prepared") {
        output.log(
          `prx author session: prepared ${opened.worktree_path} (no-launch; PRX_SESSION_NO_LAUNCH set)`,
        );
        return 0;
      }
      if (opened.status === "error" || !opened.profile) {
        output.error(
          `prx author session: session-open failed at ${opened.stage ?? "dispatch"}: ${opened.error ?? "no profile built"}`,
        );
        return 1;
      }
      const profile = opened.profile;
      const spawnCwd = opened.worktree_path;

      const authorSessionAllowlist =
        (deps.ensureClaudeSessionAllowlist ?? ensureClaudeSessionProfileAllowlist)(spawnCwd, "author");
      if (authorSessionAllowlist.status === "skipped-malformed") {
        output.error(buildMalformedAllowlistWarning(authorSessionAllowlist.path));
      }

      const mcpStatus = (deps.ensureOpsRuntimeMcp ?? ensureOpsRuntimeMcp)(spawnCwd);

      const policy = POLICY;
      const startedAt = Date.now();
      // GH-2380: backend is derived — headless SDK by default,
      // subprocess/PTY under --interactive (or when tests inject execRuntime).
      // GH-2280: every execution targets the reserved worktree (spawnCwd).
      const result = resolveAgentBackend(profile) === "sdk"
        ? agentProfileExecutionAsRuntimeResult(
            await executeAgentProfile(profile, {
              cwd: spawnCwd,
              format: "json",
              ...(deps.execRuntime ? { subprocessExecutor: deps.execRuntime } : {}),
            }),
          )
        : (deps.execRuntime ?? localRuntimeExecutor)(
            profile,
            "plain",
            spawnCwd,
            interactiveTimeoutMs("plain", policy.timeout_ms),
          );
      if (result.status !== 0) {
        const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
        output.error(
          `prx author agent: claude exited ${result.status}${stderrTail ? ` — ${stderrTail}` : ""}`,
        );
      }
      const telemetry = {
        agent: "claude",
        status: result.status === 0 ? "success" : "error",
        input_hash: sha256(JSON.stringify({
          command: profile.command,
          args: profile.args,
          cwd: spawnCwd,
          policy,
        })),
        output_hash: sha256(`${result.stdout}\n${result.stderr}`),
        latency_ms: Date.now() - startedAt,
      };
      appendExecutionLog(
        spawnCwd,
        createRunRecord({
          agent: "claude",
          input_hash: telemetry.input_hash,
          output_hash: telemetry.output_hash,
          status: telemetry.status,
          latency_ms: telemetry.latency_ms,
          timestamp: Date.now(),
        }),
      );
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              profile,
              cwd: spawnCwd,
              workspace_id: opened.workspace_id,
              branch_ref: opened.branch_ref,
              mcpStatus,
              policy,
              telemetry,
              status: result.status,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
      }
      return result.status;
      })();
    }

    if (parsed.command === "scratch") {
      // GH-2394: `prx scratch` — ad-hoc, work-unit-UNBOUND least-privilege
      // session, safe by default (`--unsafe` is the escape hatch). Unlike the
      // mainx intake/triage sessions, scratch does NOT reserve a worktree: it
      // launches in the current cwd, so there is no `session_open` reserve and
      // no `.pr/local/runtime/mcp.json` dependency (the profile passes an
      // inline empty MCP map). Shape otherwise mirrors author/submit-session
      // (banner → dispatch → execRuntime → telemetry).
      if (parsed.help) {
        // --help early-exits to the safe/unsafe contract (the banner).
        output.log(SESSION_PROFILES.scratch.banner);
        return 0;
      }

      const cwd = process.cwd();

      if (parsed.check) {
        if (parsed.format === "json") {
          output.log(JSON.stringify({ profile: "scratch", binding: "mainx", cwd, unsafe: parsed.unsafe }));
        } else {
          output.log(`scratch session: ready on ${cwd}${parsed.unsafe ? " (unsafe)" : " (safe)"}`);
        }
        return 0;
      }

      output.error(SESSION_PROFILES.scratch.banner);

      const profile = dispatchSessionEntryEvent({
        type: "OPEN_SCRATCH_SESSION",
        cwd,
        unsafe: parsed.unsafe,
      });

      if (parsed.dryRun) {
        output.log(formatRuntimeProfile(profile, parsed.format));
        return 0;
      }

      const policy = POLICY;
      const startedAt = Date.now();
      const result = (deps.execRuntime ?? localRuntimeExecutor)(
        profile,
        "plain",
        cwd,
        interactiveTimeoutMs("plain", policy.timeout_ms),
      );
      if (result.status !== 0) {
        const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
        output.error(
          `prx scratch: claude exited ${result.status}${stderrTail ? ` — ${stderrTail}` : ""}`,
        );
      }
      const telemetry = {
        agent: "claude",
        status: result.status === 0 ? "success" : "error",
        input_hash: sha256(JSON.stringify({
          command: profile.command,
          args: profile.args,
          cwd,
          policy,
        })),
        output_hash: sha256(`${result.stdout}\n${result.stderr}`),
        latency_ms: Date.now() - startedAt,
      };
      appendExecutionLog(
        cwd,
        createRunRecord({
          agent: "claude",
          input_hash: telemetry.input_hash,
          output_hash: telemetry.output_hash,
          status: telemetry.status,
          latency_ms: telemetry.latency_ms,
          timestamp: Date.now(),
        }),
      );
      if (parsed.format === "json") {
        output.log(
          JSON.stringify(
            {
              profile,
              cwd,
              policy,
              telemetry,
              status: result.status,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
      }
      return result.status;
    }

    if (parsed.command === "worktree") {
      const summary = (deps.worktreeStatus ?? worktreeStatus)(parsed.repoPath);
      output.log(formatWorktree(summary, parsed.format));
      return 0;
    }

    if (parsed.command === "worktrees") {
      const summary = (deps.wtStatus ?? wtStatus)(parsed.repoPath, parsed.includeGitDetails);
      output.log(formatWtStatus(summary, parsed.format));
      return 0;
    }

    if (parsed.command === "worktree-remove") {
      const muxHandle: WorktreeRemoveMuxHandle = deps.muxHandle ?? {
        cleanup: (worktreePath) => {
          // GH-1172: a worktree may host plan + implement sessions
          // concurrently. Kill every session whose path matches this
          // worktree, plus the legacy un-suffixed name as a safety net.
          // Surface map is the source of truth for which sessions are live.
          const surface = readTmuxSurface();
          const matching = Array.from(surface.values())
            .flatMap((entries) => entries)
            .filter((e) => e.sessionPath.replace(/\/+$/, "") === worktreePath.replace(/\/+$/, ""));
          const targets = new Set<string>(matching.map((e) => e.sessionName));
          // Derive the un-suffixed name from the *resolved* worktree path
          // that `removeWorktree` hands us — not from `parsed.target`,
          // which may be a ticket id (`GH-678`) whose basename wouldn't
          // match the actual session tied to the on-disk worktree
          // (`gh_678_<slug>`).
          targets.add(muxSessionName(worktreePath));
          for (const name of targets) {
            killMuxSession({ name });
          }
        },
      };
      const summary = (deps.removeWorktree ?? removeWorktree)(parsed.repoPath, parsed.target, {
        force: parsed.force,
        prune: parsed.prune,
        deleteBranch: parsed.deleteBranch,
        dryRun: parsed.dryRun,
        muxHandle,
      });
      output.log(formatWorktreeRemove(summary, parsed.format));
      return 0;
    }

    if (parsed.command === "workspace") {
      // GH-1978: `prx workspace <verb>` retires wtctl's
      // sync / ignore sync / up / down surface. The actor lives at
      // src/workspace/actor.ts; the verb parser at src/workspace/cli.ts.
      try {
        const args = parseWorkspaceArgs(parsed.argv);
        const result = runWorkspaceCli(args);
        if (result.output) {
          if (result.exitCode === 0) {
            output.log(result.output);
          } else {
            output.error(result.output);
          }
        }
        return result.exitCode;
      } catch (err) {
        if (err instanceof WorkspaceCliError) {
          output.error(err.message);
          return 1;
        }
        throw err;
      }
    }

    if (parsed.command === "gc") {
      // GH-2026/GH-2327: `prx gc <verb>`. The actor lives at
      // src/machine/gc/actor.ts; the verb parser at src/machine/gc/cli.ts.
      // `gc teardown` reuses the prune teardown path — inject those deps here
      // (where they're in scope) so the gc modules never statically import
      // this file (avoids an ESM cycle).
      // runGcCli is async (the sweep verbs fan out over async drivers); wrap in
      // an async IIFE so this synchronous dispatch arm can await it.
      return (async (): Promise<number> => {
        // 2l4ua: reached via the deprecated `prx prune --ticket` alias.
        if (parsed.viaAlias) {
          output.error(PRX_PRUNE_GC_ALIAS_HINT);
        }
        try {
          const args = parseGcArgs(parsed.argv);
          const result = await runGcCli(args, {
            buildParityChain: deps.buildParityChain ?? buildParityChain,
            applyParityChainActions:
              deps.applyParityChainActions ?? applyParityChainActions,
            // GH-2331: the `hooks` reshape driver. Built here (where the repo
            // discovery + `defaultHooksPath` live) so the gc modules never
            // statically import this file. Resolver is lazy — only the `hooks`
            // component pays the repo-inventory walk. Mirrors `prx hooks status`
            // (everywhere roots, the managed hooks path).
            hooks: {
              status: deps.hookStatus ?? hookStatus,
              apply: deps.applyHooks ?? applyHooks,
              resolve: () => {
                const cfg = (deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig)(
                  process.cwd(),
                );
                const inventory: RepoInventory = {
                  ...(deps.discoverLocalRepos ?? discoverLocalRepos)(cfg.everywhereRoots),
                  bareRoot: cfg.bareRoot,
                  configPath: cfg.configPath,
                  indexPath: cfg.indexPath,
                };
                return { inventory, expectedPath: defaultHooksPath() };
              },
            },
          });
          if (result.output) {
            if (result.exitCode === 0) {
              output.log(result.output);
            } else {
              output.error(result.output);
            }
          }
          return result.exitCode;
        } catch (err) {
          if (err instanceof GcCliError) {
            output.error(err.message);
            return 1;
          }
          throw err;
        }
      })();
    }

    if (parsed.command === "tools-wt") {
      if (parsed.action === "path") {
        const result = resolveWorktreePath();
        output.log(formatWorktreePath(result, parsed.format));
        return 0;
      }
      if (parsed.action === "env") {
        const result = worktreeEnv();
        output.log(formatWorktreeEnv(result, parsed.format));
        return 0;
      }
      if (parsed.action === "exec") {
        const result = execWorktrunk({
          args: parsed.execArgs,
          source: parsed.source,
          parentPid: parsed.parentPid,
        });
        const out = formatExecResult(result, parsed.format);
        if (out) output.log(out);
        return result.exitCode;
      }
      if (parsed.action === "ensure-branch") {
        const result: EnsureBranchResult = ensureBranch({
          name: parsed.branchName!,
          base: parsed.base,
          skip: parsed.skip,
        });
        const out = formatEnsureBranchResult(result, parsed.format);
        if (out) {
          if (result.status === "error" || result.status === "base-unresolved") {
            output.error(out);
          } else {
            output.log(out);
          }
        }
        // Best-effort: always exit 0. The pre-switch hook must not turn a
        // real wt-switch failure into a hook failure.
        return 0;
      }
      if (parsed.action === "ensure-prx-excludes") {
        const repoRoot = tryCommand(["git", "rev-parse", "--show-toplevel"], process.cwd());
        if (!repoRoot) {
          output.error("ensure-prx-excludes: not inside a git repository");
          // Best-effort: hooks must not turn this into a worktrunk failure.
          return 0;
        }
        const persisted = loadWorkspaceConfig(repoRoot);
        const result = ensurePrxExcludes({
          repoRoot,
          workspaceTrack: persisted.track,
        });
        if (parsed.format === "json") {
          output.log(JSON.stringify(result, null, 2));
        } else {
          if (result.excludePath) {
            for (const rule of result.excludeRemovedRules) {
              output.log(`Removed legacy ${rule} from ${result.excludePath}`);
            }
            for (const rule of result.excludeRules) {
              output.log(
                result.excludeUpdatedRules.includes(rule)
                  ? `Added ${rule} to ${result.excludePath}`
                  : `${rule} already present in ${result.excludePath}`,
              );
            }
          }
        }
        return 0;
      }
      if (parsed.action === "run-hook") {
        const result = runHook({
          event: parsed.hookEvent!,
          cwd: process.cwd(),
        });
        const out = formatRunHookResult(result, parsed.format);
        if (out) {
          if (result.source === "skipped" && parsed.format !== "json") {
            output.error(out);
          } else {
            output.log(out);
          }
        }
        // Default: best-effort, always exit 0 — a worktrunk lifecycle hook
        // (pre-start, post-switch, post-start) must not turn into a
        // worktrunk failure. Strict callers (e.g. the git pre-commit shim,
        // GH-1124) opt in to exit-code propagation.
        if (parsed.strict) {
          return result.exitCode;
        }
        return 0;
      }
      if (parsed.action === "bootstrap") {
        return (async () => {
          const bootstrapDeps = buildDefaultBootstrapDeps(async (outputPath) => {
            await (deps.initContract ?? initContract)(outputPath, {
              ready: false,
              forceBeads: false,
              changeType: ["feature"],
              generatedBy: "codex",
            });
          });
          const result = await bootstrapWorktree(process.cwd(), bootstrapDeps);
          const out = formatBootstrapResult(result, parsed.format);
          if (out) {
            if (result.exitCode !== 0) {
              output.error(out);
            } else {
              output.log(out);
            }
          }
          // Best-effort: always exit 0. The post-create hook must not turn a
          // real wt-switch failure into a hook failure.
          return 0;
        })();
      }
      return 0;
    }

    if (parsed.command === "tools-git") {
      const result = execGit({
        subcommand: parsed.subcommand,
        args: parsed.passArgs,
        cwd: parsed.cwd,
      });
      const out = formatGitExecResult(result, parsed.format);
      if (out) output.log(out);
      return result.exitCode;
    }

    if (parsed.command === "keeper") {
      // GH-2346: `keeper commit` finalizes the worktree headlessly — stage all
      // changes then commit, both under role=keeper (no manual git, no TTY).
      // `git add` + `git commit` are already in keeper's allowlist; producing a
      // real commit that `prx submit stage` (rev-parse HEAD) then consumes.
      if (parsed.verb === "commit") {
        const added = execGit({
          subcommand: "add",
          args: ["-A"],
          cwd: parsed.cwd,
          role: "keeper",
        });
        if (added.exitCode !== 0) {
          const addOut = formatGitExecResult(added, parsed.format);
          if (addOut) output.log(addOut);
          return added.exitCode;
        }
        const committed = execGit({
          subcommand: "commit",
          args: ["-m", parsed.message ?? ""],
          cwd: parsed.cwd,
          role: "keeper",
        });
        const commitOut = formatGitExecResult(committed, parsed.format);
        if (commitOut) output.log(commitOut);
        return committed.exitCode;
      }
      // GH-2348.2: `keeper push` under role=keeper. With `--ledger` + a
      // configured signer, the push emits a signed SLSA push/v1 derivation
      // (via attestingGit) — the git-boundary counterpart of submit-publish's
      // attested push. Without it, a bare push (no emission), as before.
      if (parsed.verb === "push") {
        return (async () => {
          let store: ReturnType<typeof openAnchoredChain> | null = null;
          const pushDeps: KeeperPushDeps = {};
          if (parsed.ledger !== undefined) {
            const signer = resolveProvenanceSigner();
            if (signer !== null) {
              store = openAnchoredChain(parsed.ledger);
              pushDeps.attest = { signer, store: store.derivations };
            }
          }
          try {
            const result = await runKeeperPush(parsed.passArgs, parsed.cwd, pushDeps);
            const pushOut = formatGitExecResult(result, parsed.format);
            if (pushOut) output.log(pushOut);
            return result.exitCode;
          } finally {
            if (store !== null) store.close();
          }
        })();
      }
      // GH-2348.3: run the remaining git-write (branch) under the keeper policy
      // role (the capability lives on keeper, not the default executor).
      const result = execGit({
        subcommand: parsed.verb,
        args: parsed.passArgs,
        cwd: parsed.cwd,
        role: "keeper",
      });
      const out = formatGitExecResult(result, parsed.format);
      if (out) output.log(out);
      return result.exitCode;
    }

    if (parsed.command === "tools-bd") {
      const result = execBd({
        subcommand: parsed.subcommand,
        args: parsed.passArgs,
        cwd: parsed.cwd,
      });
      const out = formatBdExecResult(result, parsed.format);
      if (out) output.log(out);
      return result.exitCode;
    }

    if (parsed.command === "tools-labels-sync") {
      const result = syncLabels({
        repo: parsed.repo,
        prune: parsed.prune,
        dryRun: parsed.dryRun,
      });
      output.log(formatSyncLabelsResult(result, parsed.format));
      return 0;
    }

    if (parsed.command === "tools-mux-clear-resurrect") {
      // GH-1133: idempotent persistent-state cleanup. The helper is a
      // no-op when the resurrect save file is missing or the session
      // name is not mentioned, so this verb is safe to re-run.
      clearResurrectEntry({ name: parsed.sessionName });
      if (parsed.format === "json") {
        output.log(JSON.stringify({ session: parsed.sessionName, cleared: true }));
      } else {
        output.log(`cleared resurrect entry for ${parsed.sessionName}`);
      }
      return 0;
    }

    if (parsed.command === "preflight-claude") {
      return (async () => {
      const result = await runClaudePreflight();
      const out = formatClaudePreflight(result, parsed.format);
      if (result.ok) {
        output.log(out);
      } else {
        output.error(out);
      }
      return result.ok ? 0 : 1;
      })();
    }

    if (parsed.command === "preflight-notion-mcp") {
      // GH-1828: probe routes through the Anthropic Agent SDK (async); wrap
      // the branch so runCli stays sync-or-Promise-of-number for callers.
      return (async (): Promise<number> => {
        const result = await runNotionMcpPreflight();
        const out = formatNotionMcpPreflight(result, parsed.format);
        if (result.ok) {
          output.log(out);
        } else {
          output.error(out);
        }
        return result.ok ? 0 : 1;
      })();
    }

    if (parsed.command === "repos-local") {
      return (async () => {
      const result = await discoverLocalGitRepos({
        scanHome: parsed.scanHome,
        strict: parsed.strict,
      });
      output.log(formatLocalReposResult(result, parsed.format, parsed.countOnly));
      return 0;
      })();
    }

    if (parsed.command === "beads-hydrate") {
      const result = hydrateBeads({
        cwd: parsed.cwd,
        dryRun: parsed.dryRun,
      });
      const out = formatHydrateResult(result, parsed.format);
      if (out) {
        if (result.exitCode === 0) {
          output.log(out);
        } else {
          output.error(out);
        }
      }
      return result.exitCode;
    }

    if (parsed.command === "beads-issue") {
      const findFn = deps.findBeadsIssuesByGithubIssue ?? findBeadsIssuesByGithubIssue;
      const matches = findFn(parsed.issueNumber, beadsCache.load);
      if (matches.length === 0 && parsed.format === "id") {
        output.error(`No Beads issues linked to GitHub issue #${parsed.issueNumber}.`);
        return 1;
      }
      output.log(formatBeadsIssueMatches(parsed.issueNumber, matches, parsed.format));
      return matches.length > 0 ? 0 : 1;
    }

    if (parsed.command === "beads-publish") {
      const handler = deps.runBeadsPublish ?? runBeadsPublish;
      const validated: BeadsPublishOptions = beadsPublishOptionsSchema.parse({
        bdId: parsed.bdId,
        repo: parsed.repo,
        dryRun: parsed.dryRun,
        noAdopt: parsed.noAdopt,
        format: parsed.format,
      });
      return handler(validated, output, {
        loadAllBeads: () => beadsCache.load(),
        invalidateBeadsCache: beadsCache.invalidate,
      });
    }

    if (parsed.command === "beads-sync") {
      if (parsed.allRepos) {
        // GH-1662: cross-repo daemon mode. Walks `.prx/repos/index.json` and
        // runs the single-repo `runBeadsSync` once per indexed bare repo,
        // sharing the GitHub-API budget. The in-tree orchestrator builds
        // a per-repo cwd-bound `loadAllBeads` (each repo's bare path); the
        // per-invocation `beadsCache` here is intentionally not threaded —
        // it caches the cwd-bound `bd list`, which is wrong for every repo
        // after the first.
        const acrossOpts: RunBeadsSyncAcrossReposOptions = {
          domain: parsed.domain,
          dryRun: parsed.dryRun,
          budget: parsed.budget,
          limit: parsed.limit,
          format: parsed.format,
        };
        return (deps.beadsSyncAcrossRepos ?? runBeadsSyncAcrossRepos)(acrossOpts, output)
          .then((result) => result.exitCode);
      }
      const syncOpts: RunBeadsSyncOptions = {
        repo: parsed.repo,
        domain: parsed.domain,
        dryRun: parsed.dryRun,
        budget: parsed.budget,
        limit: parsed.limit,
        format: parsed.format,
      };
      return (deps.beadsSync ?? runBeadsSync)(syncOpts, output, {
        loadAllBeads: () => beadsCache.load(),
        invalidateBeadsCache: beadsCache.invalidate,
      }).then((result) => result.exitCode);
    }

    if (parsed.command === "beads-sync-all") {
      // GH-1702: cross-repo fan-out of `prx dolt reconcile`. The candidate
      // set is the filtered inventory (dolt_remote + reconcile-ready beads
      // state). On `--repo <slug>`, resolution happens here via
      // `findRepoBySlug` so the orchestrator never sees an unresolved
      // (label-only) flag — guards against the GH-1697 anti-pattern.
      const handler = deps.beadsSyncAllAcrossRepos ?? runDoltReconcileAcrossRepos;

      let candidates: DoltReconcileCandidate[] | undefined;
      if (parsed.repo !== undefined) {
        // Resolve the slug against the inventory and run only over that
        // repo. The eligibility filter still applies (it may surface a
        // `skipped: no-remote` or `legacy-embedded` row).
        const loadConfig = deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig;
        const loadIndex = deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex;
        const cfg = loadConfig(process.cwd());
        if (!cfg.indexPath) {
          output.error(
            "beads sync-all: no repo inventory index — run `prx repo add` first to register a bare repo",
          );
          return 1;
        }
        const inventory = loadIndex(cfg.indexPath);
        if (!inventory) {
          output.error(
            "beads sync-all: repo inventory index is missing or unreadable; run `prx repo refresh` first",
          );
          return 1;
        }
        const resolution = findRepoBySlug(inventory, parsed.repo);
        if (!resolution.ok) {
          const err = resolution.error;
          if (err.kind === "ambiguous") {
            output.error(
              `beads sync-all: --repo "${err.slug}" is ambiguous (matches ${err.candidates.join(", ")}); ` +
                "pass the OWNER/REPO form instead",
            );
          } else {
            output.error(
              `beads sync-all: --repo "${err.slug}" did not match any registered bare repo`,
            );
          }
          return 1;
        }
        candidates = listIndexedReposForDoltReconcile(
          { repos: [resolution.repo], roots: [] },
          (barePath) => (deps.classifyBeadsWorkspace ?? classifyBeadsWorkspace)(barePath).kind,
        );
      }

      const acrossOpts: RunDoltReconcileAcrossReposOptions = {
        mode: parsed.mode,
        dryRun: parsed.dryRun,
        format: parsed.format,
        ...(parsed.resolve ? { resolve: parsed.resolve } : {}),
        ...(candidates !== undefined ? { candidates } : {}),
      };
      return handler(acrossOpts, output).then((r) => r.exitCode);
    }

    if (parsed.command === "sync-issues-pair") {
      // GH-1990: only the `gh → bd` pair is wired for now. The actor and
      // per-pair machine (`src/sync/machine.ts`) already support direction
      // choice; the verb intentionally rejects unwired pairs with a clear
      // message rather than silently succeeding or falling back.
      //
      // GH-2011: the `gh → bd` pair now routes through `runBeadsSync`
      // (canonical reconcile) instead of the retired `bd github sync
      // --pull-only --prefer-github` shell-out.
      const from = parsed.from.toLowerCase();
      const to = parsed.to.toLowerCase();
      if (from === "gh" && to === "bd") {
        const syncOpts: RunBeadsSyncOptions = {
          domain: "gh",
          dryRun: parsed.dryRun,
          limit: DEFAULT_SYNC_LIMIT,
          format: parsed.format,
        };
        return (deps.beadsSync ?? runBeadsSync)(syncOpts, output).then((result) => result.exitCode);
      }
      output.error(
        `sync issues: pair --from ${parsed.from} --to ${parsed.to} is not wired yet; ` +
          `only --from gh --to bd ships in GH-1990 (other pairs are tracked as follow-ups).`,
      );
      return 2;
    }

    if (parsed.command === "sync-backfill") {
      // GH-1469: range-backfill of cursor-skipped external records. Shares the
      // CLI-entry `BeadsCache` so the resolve snapshot + per-record dedup hit
      // one warmed `bd list` read.
      const backfillOpts: RunBackfillOptions = {
        repo: parsed.repo,
        domain: parsed.domain,
        from: parsed.from,
        to: parsed.to,
        dryRun: parsed.dryRun,
        budget: parsed.budget,
        format: parsed.format,
      };
      return (deps.backfill ?? runBackfill)(backfillOpts, output, {
        loadAllBeads: () => beadsCache.load(),
        invalidateBeadsCache: beadsCache.invalidate,
      }).then((result) => result.exitCode);
    }

    if (parsed.command === "memory-compact") {
      const result = (deps.memoryCompact ?? runMemoryCompact)(
        {
          repo: parsed.repo,
          apply: parsed.apply,
          horizonDays: parsed.horizonDays,
          messageHorizonDays: parsed.messageHorizonDays,
          messageIssueTypes: parsed.messageIssueTypes,
          preservedTypes: parsed.preservedTypes,
          limit: parsed.limit,
          format: parsed.format,
        },
        output,
      );
      return result.exitCode;
    }

    // GH-1397: handoff queue dispatch.
    if (parsed.command === "handoff-enqueue") {
      return runHandoffEnqueue(
        {
          target: parsed.target,
          verb: parsed.verb,
          ...(parsed.workUnitId ? { workUnitId: parsed.workUnitId } : {}),
          ...(parsed.argsFile ? { argsFile: parsed.argsFile } : {}),
          ...(parsed.argsLiteral ? { argsLiteral: parsed.argsLiteral } : {}),
          ...(parsed.dedupKey ? { dedupKey: parsed.dedupKey } : {}),
          ...(parsed.sourceActor ? { sourceActor: parsed.sourceActor } : {}),
          format: parsed.format,
        },
        output,
      );
    }

    if (parsed.command === "handoff-status") {
      return runHandoffStatus(
        {
          ...(parsed.target ? { target: parsed.target } : {}),
          ...(parsed.workUnitId ? { workUnitId: parsed.workUnitId } : {}),
          ...(parsed.state ? { state: parsed.state } : {}),
          showStale: parsed.showStale,
          format: parsed.format,
        },
        output,
      );
    }

    if (parsed.command === "handoff-drain") {
      return runHandoffDrain(
        {
          actor: parsed.actor,
          once: parsed.once,
          max: parsed.max,
          format: parsed.format,
        },
        output,
      );
    }

    if (parsed.command === "handoff-replay") {
      return runHandoffReplay(
        { id: parsed.id, format: parsed.format },
        output,
      );
    }

    if (parsed.command === "transcripts-digest") {
      return runTranscriptsDigest(
        {
          source: parsed.source,
          ...(parsed.inputPath ? { inputPath: parsed.inputPath } : {}),
          ...(parsed.project ? { project: parsed.project } : {}),
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          ...(parsed.since ? { since: parsed.since } : {}),
          ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
          mode: parsed.mode,
          format: parsed.format,
        },
        output,
      ).then((r) => r.exitCode);
    }

    if (parsed.command === "transcripts-status") {
      const result = runTranscriptsStatus({ format: parsed.format }, output);
      return result.exitCode;
    }

    if (parsed.command === "transcripts-list-sources") {
      const result = runTranscriptsListSources({ format: parsed.format }, output);
      return result.exitCode;
    }

    if (parsed.command === "repo-status") {
      const summary = (deps.repoStatus ?? repoStatus)(
        parsed.repoPath,
        { includeGitDetails: parsed.includeGitDetails, fetch: parsed.fetch },
      );
      output.log(formatRepoStatus(summary, parsed.format));
      return 0;
    }

    if (parsed.command === "remote-ci-check") {
      const prRef = parsed.pr ?? (deps.resolveCurrentPrRef ?? resolveCurrentPrRef)(parsed.repoPath);
      const summary = (deps.remoteCiCheck ?? remoteCiCheck)(parsed.repoPath, prRef);
      output.log(formatRemoteCiCheck(summary, parsed.format));
      return summary.failingChecks.length > 0 ? 1 : 0;
    }

    if (parsed.command === "scout-logs") {
      const prRef = parsed.pr ?? (deps.resolveCurrentPrRef ?? resolveCurrentPrRef)(parsed.repoPath);
      const result = (deps.scoutLogs ?? scoutLogs)(parsed.repoPath, prRef, undefined, parsed.maxLines);
      output.log(formatScoutLogs(result, parsed.format));
      return result.checks.length > 0 ? 1 : 0;
    }

    if (parsed.command === "pr-comments") {
      if (parsed.action === "resolve") {
        const beforeResolution = (deps.fetchPrComments ?? fetchPrComments)(parsed.repoPath, parsed.pr);
        const threadIds = parsed.resolveAll
          ? beforeResolution.threads.filter((thread) => !thread.isResolved).map((thread) => thread.id)
          : parsed.threadIds;
        if (threadIds.length === 0) {
          throw new CliError("No unresolved review threads found to resolve");
        }
        const resolvedThreads = (deps.resolvePrReviewThreads ?? resolvePrReviewThreads)(parsed.repoPath, threadIds);
        const postResolution = (deps.fetchPrComments ?? fetchPrComments)(parsed.repoPath, parsed.pr);
        const outputPath = parsed.outputPath ?? (parsed.write ? defaultPrCommentsOutputPath(parsed.repoPath) : undefined);
        if (outputPath) {
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, `${JSON.stringify(postResolution, null, 2)}\n`);
        }
        output.log(formatPrCommentsResolution(resolvedThreads, postResolution, parsed.format, outputPath));
        return postResolution.unresolvedThreads === 0 ? 0 : 1;
      }

      const summary = (deps.fetchPrComments ?? fetchPrComments)(parsed.repoPath, parsed.pr);
      const outputPath = parsed.outputPath ?? (parsed.write ? defaultPrCommentsOutputPath(parsed.repoPath) : undefined);
      if (outputPath) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
      }
      output.log(formatPrComments(summary, parsed.format, outputPath));
      return summary.unresolvedThreads === 0 ? 0 : 1;
    }

    if (parsed.command === "repo-checks") {
      const summary = (deps.repoCheckNames ?? repoCheckNames)(parsed.repoPath, {
        repo: parsed.repo,
        branch: parsed.branch,
      });
      output.log(formatRepoChecks(summary, parsed.format));
      return summary.checks.length > 0 ? 0 : 1;
    }

    if (parsed.command === "protect-main") {
      if (parsed.check) {
        const result = (deps.checkMainBranchProtection ?? checkMainBranchProtection)(parsed.repoPath, {
          backend: parsed.backend,
          repo: parsed.repo,
          branch: parsed.branch,
          solo: parsed.solo,
          enforceAdmins: parsed.enforceAdmins,
          requireConversationResolution: parsed.requireConversationResolution,
          requireLastPushApproval: parsed.requireLastPushApproval,
          requireLinearHistory: parsed.requireLinearHistory,
          requiredStatusChecks: parsed.requiredStatusChecks,
        });
        output.log(formatProtectMainCheck(result, parsed.format));
        return result.matches ? 0 : 1;
      }

      const result = (deps.protectMainBranch ?? protectMainBranch)(parsed.repoPath, {
        backend: parsed.backend,
        repo: parsed.repo,
        branch: parsed.branch,
        solo: parsed.solo,
        apply: parsed.apply,
        enforceAdmins: parsed.enforceAdmins,
        requireConversationResolution: parsed.requireConversationResolution,
        requireLastPushApproval: parsed.requireLastPushApproval,
        requireLinearHistory: parsed.requireLinearHistory,
        requiredStatusChecks: parsed.requiredStatusChecks,
      });
      output.log(formatProtectMain(result, parsed.format));
      return 0;
    }

    if (parsed.command === "prune-session") {
      output.error(PRX_PRUNE_GC_ALIAS_HINT); // 2l4ua: prune is deprecated
      // GH-1133: session-layer prune — kill_tmux_session +
      // close_prx_session, nothing else. Self-destruct guard: when the
      // caller is inside the target unit's own tmux session, refuse
      // the kill and emit a fresh-shell handoff block (mirrors the
      // worktree self-destruct pattern in closeSession).
      const result = (deps.buildSessionLayerPrune ?? buildSessionLayerPrune)(
        parsed.repoPath,
        parsed.workUnitId,
        { apply: parsed.apply },
      );

      const insideOwnSession = (() => {
        if (!getEnv("TMUX")) return false;
        const killAction = result.actions.find((a) => a.type === "kill_tmux_session");
        if (!killAction || killAction.type !== "kill_tmux_session") return false;
        const currentName = deps.tmuxCurrentSession
          ? deps.tmuxCurrentSession()
          : (() => {
              let probe;
              try {
                probe = procRunner(
                  ["tmux", "-L", PRX_TMUX_SOCKET, "display-message", "-p", "#S"],
                  { check: false },
                );
              } catch {
                return null;
              }
              if (probe.status !== 0) return null;
              const name = probe.stdout.trim();
              return name || null;
            })();
        if (!currentName) return false;
        // Use the structured sessionName field (avoids parsing the shell-quoted command).
        return currentName === killAction.sessionName;
      })();

      if (insideOwnSession && parsed.apply) {
        const handoff = [
          `prx prune session ${parsed.workUnitId}`,
        ];
        if (parsed.format === "json") {
          output.log(
            JSON.stringify(
              { ...result, handoffRequired: true, handoff, applied: false },
              null,
              2,
            ),
          );
        } else {
          output.log(formatSurfaceSync(result, "plain"));
          output.log("");
          output.log(
            "refused: prx prune session would kill the caller's own tmux session.",
          );
          output.log("Run from a fresh shell:");
          for (const line of handoff) {
            output.log(`  ${line}`);
          }
        }
        return 2;
      }

      output.log(formatSurfaceSync(result, parsed.format));
      if (parsed.apply && result.actions.length > 0) {
        const applyResults = (deps.applyParityChainActions ?? applyParityChainActions)(
          result,
          parsed.repoPath,
        );
        const applyOutput = formatParityChainApplyResults(applyResults, parsed.format);
        if (applyOutput) output.log(applyOutput);
        if (applyResults.some((r) => r.status !== 0)) return 1;
      }
      return 0;
    }

    if (
      parsed.command === "reconcile"
      || parsed.command === "prune"
      || parsed.command === "backfill"
    ) {
      // 2l4ua: bare/scope/authority/merged-only `prx prune` has no faithful gc
      // equivalent yet — keep behavior, emit the deprecation hint (reconcile +
      // backfill are not deprecated).
      if (parsed.command === "prune") {
        output.error(PRX_PRUNE_GC_ALIAS_HINT);
      }
      // GH-830: on the apply path, refresh remote-tracking refs before
      // planning so a remote branch GitHub already deleted doesn't trigger
      // a doomed `delete_remote_branch` action. Read-only previews stay
      // network-free. Mirrors the ordering validateWorkSessionEntry uses
      // for `prx session open` (GH-519).
      if (parsed.apply) {
        (deps.pruneStaleRemoteRefs ?? pruneStaleRemoteRefs)(parsed.repoPath);
      }
      const result = (deps.buildParityChain ?? buildParityChain)(parsed.repoPath, {
        mode: parsed.mode,
        authority: parsed.authority,
        scope: parsed.scope,
        apply: parsed.apply,
        ...(parsed.ticket !== undefined ? { ticket: parsed.ticket } : {}),
        ...(parsed.mergedOnly ? { mergedOnly: parsed.mergedOnly } : {}),
      });
      output.log(formatSurfaceSync(result, parsed.format));
      // GH-520: --apply used to only print an "APPLY" header; actually run
      // each action's shell command now. Continue-on-error, exit non-zero
      // if any action fails so callers/CI can detect partial failures.
      if (parsed.apply && result.actions.length > 0) {
        const applyResults = (deps.applyParityChainActions ?? applyParityChainActions)(result, parsed.repoPath);
        const applyOutput = formatParityChainApplyResults(applyResults, parsed.format);
        if (applyOutput) {
          output.log(applyOutput);
        }
        // GH-1125: surface the merged-only pre-step summary the ticket
        // calls for. Counts walk the apply results so the line reflects
        // what actually succeeded, not what the chain proposed. The M
        // term reports 0 until GH-1126 ships the parity-chain
        // `remove_worktree` arm — the summary shape is stable across that
        // ticket so consumers (triage prime per-iteration log) don't need
        // to change when it merges.
        if (parsed.command === "prune" && parsed.mergedOnly && parsed.format === "plain") {
          const closedIssues = applyResults.filter(
            (r) => r.status === 0 && r.action.type === "close_issue",
          ).length;
          const removedWorktrees = 0;
          output.log(`pruned ${closedIssues} stale issues / ${removedWorktrees} worktrees`);
        }
        if (applyResults.some((r) => r.status !== 0)) {
          return 1;
        }
      }
      return 0;
    }

    if (parsed.command === "chains") {
      const summary = (deps.chainStatus ?? chainStatus)(parsed.repoPath, { remote: parsed.remote });
      output.log(formatChainsStatus(summary, parsed.format));
      return 0;
    }

    if (parsed.command === "repair-bd") {
      // GH-1152: repair bd schema drift on one or more worktrees by running a
      // single `bd stats --json` (idempotent — triggers compat migration 017
      // on a drifted DB; no-op on a healthy DB).
      const listTargets = deps.listFeatureWorktreesForRepair ?? listFeatureWorktreesForRepair;
      const repair = deps.repairBdSchema ?? repairBdSchema;
      const targets = parsed.all ? listTargets(parsed.repoPath) : [parsed.repoPath];
      const results = targets.map((cwd) => ({ cwd, result: repair(cwd) }));
      output.log(formatRepairBdResults(results, parsed.format));
      const anyFailed = results.some((entry) => entry.result.status === "repair_failed");
      return anyFailed ? 1 : 0;
    }

    if (parsed.command === "delegate-next") {
      // GH-983: filter-aware portfolio picker. Sibling of `prx next` —
      // `next` dumps the full eight-thread surface; `delegate next`
      // projects to a top-1 (default) or filtered list (`--all`) with a
      // suggested operator command. Supersedes the retired `prx worktree
      // next` alias (which itself was a GH-1510 deprecation alias for
      // `prx next`).
      const result = (deps.nextWork ?? nextWork)(parsed.repoPath);

      const enrichment = buildDelegateEnrichment(parsed.repoPath, parsed.filters, result);
      const projection = selectDelegateCandidate(result, {
        filters: parsed.filters,
        enrichment,
      });

      if (parsed.format === "json") {
        output.log(JSON.stringify(projection, null, 2));
      } else if (parsed.filters.all) {
        output.log(formatDelegateNextList(projection));
      } else {
        output.log(formatDelegateNext(projection));
      }

      if (projection.candidates.length === 0) {
        if (parsed.filters.epic !== undefined && enrichment.epicChildBdIds?.size === 0) {
          output.error(
            `prx delegate next: no bd children found for --epic ${parsed.filters.epic}. ` +
              `Promote children to beads (e.g. \`bd link <child> <epic-bd-id> --type parent-child\`) ` +
              `or check that the epic is itself a bd record.`,
          );
        }
        return 1;
      }
      return 0;
    }

    if (parsed.command === "delegate-assign") {
      // GH-1874: bd-canonical assignment write. The mirror's `push()` picks
      // up the bd assignee on the normal sync cadence (synchronous mirror
      // projection is out of scope).
      const result = runDelegateAssign({
        id: parsed.id,
        agent: parsed.agent,
        self: parsed.self,
        unassign: parsed.unassign,
        repoPath: parsed.repoPath,
      });
      if (result.exitCode === 0) {
        output.log(result.message);
      } else {
        output.error(result.message);
      }
      return result.exitCode;
    }

    if (parsed.command === "delegate-repair-assignees") {
      // GH-2012: bulk-rewrite legacy display-name assignees to GH logins.
      const result = runRepairAssignees({
        from: parsed.from,
        to: parsed.to,
        apply: parsed.apply,
        repoPath: parsed.repoPath,
      });
      if (result.exitCode === 0) {
        output.log(result.message);
      } else {
        output.error(result.message);
      }
      return result.exitCode;
    }

    if (parsed.command === "refresh") {
      return executeRefresh(parsed, output);
    }

    if (parsed.command === "actions" || parsed.command === "next-action") {
      const plan = (deps.nextAction ?? nextAction)(parsed.repoPath);
      // GH-1510: portfolio mode — when there's no branch context (no
      // current work unit) the in-unit derived-action ranker has nothing
      // useful to say; delegate to the multi-thread bd-canonical picker.
      // The `actions` verb keeps the legacy shape for `prx do` scripting.
      if (parsed.command === "next-action" && plan.snapshot.branch === null) {
        const result = (deps.nextWork ?? nextWork)(parsed.repoPath);
        output.log(formatNextWork(result, parsed.format));
        return result.threads.some((t) => t.candidates.length > 0) ? 0 : 1;
      }
      output.log(formatActionPlan(plan, parsed.command, parsed.format));
      return plan.next ? 0 : 1;
    }

    if (parsed.command === "do") {
      const plan = (deps.nextAction ?? nextAction)(parsed.repoPath);
      const action = plan.actions.find((candidate) => candidate.id === parsed.actionId);
      if (!action) {
        output.error(
          `Unknown action id \`${parsed.actionId}\`. Available actions: ${plan.actions.map((candidate) => candidate.id).join(", ")}`,
        );
        return 1;
      }
      if (!action.enabled) {
        const reason = action.disabledReason ?? "action is not currently enabled";
        if (parsed.format === "json") {
          output.log(formatActionExecutionResult(action, parsed.format, { status: "blocked", message: reason }));
        } else {
          output.error(`Action \`${action.id}\` is disabled: ${reason}`);
        }
        return 1;
      }

      if (action.id === "contract.init") {
        return withRepoPath(parsed.repoPath, () =>
          runCli(
            ["init", "--output", parsed.contract, "--format", parsed.format],
            output,
            deps,
          ));
      }

      if (action.id === "survey.overview") {
        return withRepoPath(parsed.repoPath, () =>
          runCli(
            ["overview", "--format", parsed.format],
            output,
            deps,
          ));
      }

      const skill = skillForActionId(action.id);
      if (skill) {
        const actor = parsed.actor ?? action.actor;
        const reason = parsed.reason ?? action.reason;
        return withRepoPath(parsed.repoPath, () =>
          runCli(
            [
              "event",
              "--skill",
              skill,
              "--contract",
              parsed.contract,
              "--actor",
              actor,
              ...(reason ? ["--reason", reason] : []),
              "--format",
              parsed.format,
              "--log",
              parsed.log,
              ...(parsed.id ? ["--id", parsed.id] : []),
            ],
            output,
            deps,
          ));
      }

      const unsupportedMessage = `Action \`${action.id}\` is enabled but not dispatchable via \`prx do\` yet. Run manually: ${action.command}`;
      if (parsed.format === "json") {
        output.log(formatActionExecutionResult(action, parsed.format, { status: "unsupported", message: unsupportedMessage }));
      } else {
        output.error(unsupportedMessage);
      }
      return 1;
    }

    if (parsed.command === "phase") {
      const plan = (deps.nextAction ?? nextAction)(parsed.repoPath);
      output.log(formatPhase(plan, parsed.format));
      return 0;
    }

    if (parsed.command === "snapshot") {
      const state = (deps.buildDomainState ?? buildDomainState)(parsed.repoPath);
      output.log(formatSnapshot(state, parsed.format));
      return 0;
    }

    if (parsed.command === "statusline") {
      const plan = (deps.nextAction ?? nextAction)(parsed.repoPath);
      output.log(formatStatusLine(plan, parsed.format));
      return 0;
    }

    if (parsed.command === "actors") {
      output.log(formatActors(parsed.scope, parsed.format));
      return 0;
    }

    if (parsed.command === "model") {
      output.log(formatModel(parsed.scope, parsed.format));
      return 0;
    }

    if (parsed.command === "sprint") {
      if (parsed.action === "init") {
        const state = createSprintState({
          sprintId: parsed.sprintId as string,
          week: {
            startDate: parsed.weekStart ?? isoDate(0),
            endDate: parsed.weekEnd ?? isoDate(6),
          },
          goal: {
            summary: parsed.goal as string,
            metricName: parsed.metricName as string,
            targetDelta: parsed.targetDelta as number,
          },
        });
        writeSprintState(parsed.sprintPath, state);
        output.log(formatSprintState(state, parsed.format));
        return 0;
      }

      if (parsed.action === "bind") {
        const current = loadSprintState(parsed.sprintPath);
        const next = sprintStateV1Schema.parse({
          ...current,
          bindings: {
            prNumbers: [...new Set([...current.bindings.prNumbers, parsed.pr as number])],
            ticketIds: parsed.ticket
              ? [...new Set([...current.bindings.ticketIds, parsed.ticket])]
              : current.bindings.ticketIds,
            unitIds: parsed.unit
              ? [...new Set([...current.bindings.unitIds, parsed.unit])]
              : current.bindings.unitIds,
          },
        });
        const snapshots = collectSprintPrSnapshots(
          parsed.repoPath,
          next.bindings.prNumbers,
          deps.viewPr ?? viewPr,
        );
        const refreshed = refreshSprintDerived(next, snapshots);
        const invariantReport = assertSprintInvariants(refreshed);
        writeSprintState(parsed.sprintPath, refreshed);
        if (!invariantReport.valid) {
          if (parsed.format === "json") {
            output.log(JSON.stringify({ state: refreshed, invariants: invariantReport }, null, 2));
          } else {
            output.error(`Sprint invariant violations: ${invariantReport.findings.map((f) => f.id).join(", ")}`);
          }
          return 1;
        }
        output.log(formatSprintState(refreshed, parsed.format));
        return 0;
      }

      if (parsed.action === "metric") {
        const currentState = loadSprintState(parsed.sprintPath);
        const next = sprintStateV1Schema.parse({
          ...currentState,
          metric: {
            ...currentState.metric,
            baseline: parsed.baseline ?? currentState.metric.baseline,
            current: parsed.current ?? currentState.metric.current,
          },
        });
        const snapshots = collectSprintPrSnapshots(
          parsed.repoPath,
          next.bindings.prNumbers,
          deps.viewPr ?? viewPr,
        );
        const refreshed = refreshSprintDerived(next, snapshots);
        const invariantReport = assertSprintInvariants(refreshed);
        writeSprintState(parsed.sprintPath, refreshed);
        if (!invariantReport.valid) {
          if (parsed.format === "json") {
            output.log(JSON.stringify({ state: refreshed, invariants: invariantReport }, null, 2));
          } else {
            output.error(`Sprint invariant violations: ${invariantReport.findings.map((f) => f.id).join(", ")}`);
          }
          return 1;
        }
        output.log(formatSprintState(refreshed, parsed.format));
        return 0;
      }

      if (parsed.action === "status") {
        const state = loadSprintState(parsed.sprintPath);
        const snapshots = collectSprintPrSnapshots(
          parsed.repoPath,
          state.bindings.prNumbers,
          deps.viewPr ?? viewPr,
        );
        const refreshed = refreshSprintDerived(state, snapshots);
        const invariantReport = assertSprintInvariants(refreshed);
        if (!invariantReport.valid) {
          if (parsed.format === "json") {
            output.log(JSON.stringify({ state: refreshed, invariants: invariantReport }, null, 2));
          } else {
            output.error(`Sprint invariant violations: ${invariantReport.findings.map((f) => f.id).join(", ")}`);
          }
          return 1;
        }
        output.log(formatSprintState(refreshed, parsed.format));
        return 0;
      }

      const state = loadSprintState(parsed.sprintPath);
      const snapshots = collectSprintPrSnapshots(
        parsed.repoPath,
        state.bindings.prNumbers,
        deps.viewPr ?? viewPr,
      );
      const refreshed = refreshSprintDerived(state, snapshots);
      const notionPayload = {
        sprint_id: refreshed.sprintId,
        goal: refreshed.goal.summary,
        metric_name: refreshed.goal.metricName,
        baseline: refreshed.metric.baseline,
        current: refreshed.metric.current,
        target_delta: refreshed.goal.targetDelta,
        outcome_status: refreshed.derived.outcomeStatus,
        sprint_status: refreshed.derived.sprintStatus,
        pr_numbers: refreshed.bindings.prNumbers,
        ticket_ids: refreshed.bindings.ticketIds,
        unit_ids: refreshed.bindings.unitIds,
      };
      const result = {
        apply: parsed.apply,
        statePath: parsed.sprintPath,
        sprintId: refreshed.sprintId,
        notion: notionPayload,
      };
      output.log(formatSprintSyncResult(result, parsed.format));
      return 0;
    }

    if (parsed.command === "update") {
      const result = (deps.updatePrFromContract ?? updatePrFromContract)(
        parsed.repoPath,
        parsed.contract,
        parsed.outputPath,
        parsed.pr,
        parsed.apply,
      );
      output.log(formatUpdateResult(result, parsed.format));
      return result.exitCode;
    }

    if (parsed.command === "sync-issues") {
      if (parsed.apply) {
        (deps.ensureBeadsInitSetup ?? ensureBeadsInitSetup)(parsed.repoPath, runCommand, { force: true });
      }
      return Promise.resolve(
        (deps.syncGitHubIssuesToBeads ?? syncGitHubIssuesToBeads)(
          parsed.repoPath,
          parsed.apply,
        ),
      ).then((result: SyncGitHubIssuesToBeadsResult) => {
        output.log(formatUpdateResult(result, parsed.format));
        return result.exitCode;
      });
    }

    const result = (deps.syncStatus ?? syncStatus)(parsed.repoPath, parsed.apply);
    output.log(formatUpdateResult(result, parsed.format));
    return result.exitCode;
  } catch (error) {
    return handleRunCliError(error, output);
  }
}
