import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { deriveInfo, loadContract, type StateMode } from "./contract.ts";
import {
  type ScoutLogsResult,
  type OverviewResult,
  type ChainStatusResult,
  type RemoteCiCheckResult,
  type PrCommentsResult,
  type PrReviewThreadResolution,
  type ProtectMainBranchResult,
  type RepoCheckNamesResult,
  type ProtectMainBranchCheckResult,
  type RepoStatusResult,
  type WorktreeStatus,
  type WorktreeRemoveResult,
  type WtStatusResult,
} from "./github.ts";
import type { ResolvedWorkUnit } from "./resolvers/types.ts";
import { type ActionPlan, type ResolvedAction } from "./actions.ts";
import type { NextWorkResult } from "../beads/ready.ts";
import { type DomainStateV1 } from "./domain_state.ts";
import {
  type RepoAddResult,
  type RepoInventory,
  type RepoNormalizationResult,
  type RepoRefreshResult,
  type RepoSubmoduleFinding,
  type SetRepoAxisDelta,
} from "./repos.ts";
import { type MaterializeResult } from "./materialize.ts";
import {
  actorsForScope,
  eventOwnersForScope,
  rawFieldOwnersForScope,
  type ActorScope,
} from "./actors.ts";
import {
  allowedTransitions,
  canonicalPrEventAliases,
  eventForSkill,
  prSystemMachine,
  prSkillNames,
  type LifecycleState,
} from "./machine.ts";
import { invariantSpecs, phasePrecedence } from "./raw_state.ts";
import { type SprintStateV1 } from "./sprint.ts";
import { type RuntimeProfileProjection } from "../machine/runtime_profiles.ts";
import { deriveTaskStatus, type TaskContract } from "./task.ts";
import type { GateResult } from "../provenance/gate.ts";
import { taskRoleMachine, taskRoles, type TaskRole } from "../machine/machines/task.ts";
import { workflowMachine } from "../machine/machines/workflow.ts";
import { findCommand, prxCommandRegistry } from "../cli/registry.data.ts";
import { HelpOverview } from "./help/overview.ts";
import { HelpAll } from "./help/help-all.ts";
import { ActorSection } from "./help/components.ts";
import { getCurrentSessionContext } from "./help/session-context.ts";
import { depResearchMachine } from "../dep-research/machine.ts";
import { domainSyncMachine } from "../sync/machine.ts";
import { fetchMachine } from "../machine/machines/fetch.ts";
import {
  type BeadsGithubIssueMatch,
  type BeadsInitSetupResult,
  type CloseSessionResult,
  type ParityChainApplyResult,
  type RepairBdEntry,
  type SessionOpenCheckReport,
  VERB_HELP_SEE_ALSO,
  type WorkUnitChainCheckResult,
  type WorkUnitIssueCheckResult,
  type WorkUnitSessionCheckResult,
} from "./cli-types.ts";
import { type PlanCloseResult } from "./plan-close-bd.ts";

// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules.

export function formatWorkUnitIssueCheck(
  result: WorkUnitIssueCheckResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  return `Issue ${result.workUnitId} is open in ${result.repo} (#${result.issue.number}: ${result.issue.title}).`;
}

export function formatResolvedWorkUnitCheck(
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

export function formatArtifactProjectedWorkUnitCheck(
  workUnitId: string,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(
      { workUnitId, checked: true, valid: true, reason: "artifact_projected" },
      null,
      2,
    );
  }
  return `Issue ${workUnitId} is projected by a local CAS artifact (issue authority not reachable here); accepting on the artifact graph.`;
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

export function formatWorkUnitSessionCheck(
  result: WorkUnitSessionCheckResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (result.worktreePath) {
    return `No active session for ${result.workUnitId}; existing worktree ${result.worktreePath} is not locked.`;
  }

  return `No active session for ${result.workUnitId}; no matching worktree is currently attached.`;
}

export function formatWorkUnitChainCheck(
  result: WorkUnitChainCheckResult,
  format: "plain" | "json",
): string {
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

export function formatGateResult(result: GateResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify({
      gate: result.gate,
      pass: result.pass,
      ref: result.ref,
      derivationId: result.derivationId,
      verdict: result.verdict,
    });
  }
  const v = result.verdict;
  const lines = [
    `${result.gate}-gate: ${result.pass ? "PASS" : "FAIL"} (${v.unit})`,
    `  subject:     ${v.subject}`,
    `  verdict ref: ${result.ref}`,
    `  attestation: ${result.derivationId}`,
  ];
  if (v.reason) lines.push(`  reason:      ${v.reason}`);
  if (v.violations.length > 0) {
    lines.push("  violations:");
    for (const f of v.violations) lines.push(`    - ${f}`);
  }
  return lines.join("\n");
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
  const lines = ['  state "workflowBackbone" as workflowBackbone {', `    [*] --> ${initial}`];
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
      '  state "lifecycle" as lifecycle {',
      "    [*] --> drafting",
      "    drafting --> open: SUBMIT",
      "    drafting --> closed: CLOSE",
      "    open --> drafting: CONVERT_TO_DRAFT",
      "    open --> merged: MERGE [isMergeable]",
      "    open --> closed: CLOSE",
      "    closed --> open: REOPEN",
      "  }",
      '  state "review" as review {',
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
      '  state "ci" as ci {',
      "    [*] --> pending",
      "    pending --> running: CI_START",
      "    pending --> passed: CI_PASS",
      "    pending --> failed: CI_FAIL",
      "    running --> passed: CI_PASS",
      "    running --> failed: CI_FAIL",
      "    passed --> pending: PUSH_COMMIT",
      "    failed --> pending: PUSH_COMMIT",
      "  }",
      '  state "mergeability" as mergeability {',
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

export function formatTaskGraph(format: "plain" | "json"): string {
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

export function formatTaskStatus(task: TaskContract, format: "plain" | "json"): string {
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
  } else if (
    status.machineState === "reviewing" &&
    task.signals.reviewAdded &&
    !task.signals.reviewApproved
  ) {
    lines.push("nextAction=Resolve review threads/outdated items and mark approval");
  }
  if (task.success.requireCommentsResolved && !task.signals.commentsResolved) {
    lines.push("nextAction=Resolve review comments (scout)");
  } else {
    if (
      task.success.requireAgentReview &&
      task.signals.agentReview &&
      !task.signals.reviewApproved
    ) {
      lines.push("nextAction=Scout confirm agent review comments are cleared");
    }
    if (
      task.success.requireHumanReview &&
      task.signals.humanReview &&
      !task.signals.reviewApproved
    ) {
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

export function formatFullCommandCatalogHelp(): string {
  return HelpAll(prxCommandRegistry);
}

export function formatHelp(): string {
  return HelpOverview(prxCommandRegistry, getCurrentSessionContext());
}

export function formatVerbHelp(verb: string): string {
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

export function formatPlanNamespaceHelp(): string {
  // GH-1311: groups the plan namespace by `session_role` (lifecycle / toolset
  // / preflight) so the cleavage between session-bootstrapping verbs and
  // verbs called from inside an open session is visible at the help surface.
  const planEntries = prxCommandRegistry.filter((entry) => entry.parent === "plan");
  const lines: string[] = ["prx plan", "==========", ""];
  lines.push(ActorSection("Subcommands", planEntries));
  lines.push("");
  lines.push(
    "Per-verb flag listings: run `prx plan session --help` or `prx plan ultrareview --help` for canonical-parser usage.",
  );
  return lines.join("\n");
}

export function formatIntakeNamespaceHelp(): string {
  const intakeEntries = prxCommandRegistry.filter((entry) => entry.parent === "intake");
  const lines: string[] = ["prx intake", "==========", ""];
  lines.push(ActorSection("Subcommands", intakeEntries));
  lines.push("");
  lines.push("Per-subcommand flag listings: run `prx intake <sub> --help`.");
  return lines.join("\n");
}

export function formatSessionHelp(): string {
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

export function formatBinaryUpdateWarning(update: { current: string; latest: string }): string {
  return (
    `⚠ prx ${update.current} — a newer release ${update.latest} is available. ` +
    "Update with `home-manager switch` (or rebuild via `bun run prx:build`) to pick up recent fixes."
  );
}

export function formatRuntimeProfile(
  profile: RuntimeProfileProjection,
  format: "plain" | "json",
): string {
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

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatInitResult(
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
  if (
    result.workspaceTrack === false &&
    result.trackedPrxFiles &&
    result.trackedPrxFiles.length > 0
  ) {
    lines.push(
      "Detected tracked .prx/ files. To complete the transition, run:",
      "    git rm -r --cached .prx/",
      '    git commit -m "chore(prx): stop tracking .prx/ after --untracked opt-in"',
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

export function formatUpdateResult(
  result: { exitCode: number; lines: string[] },
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return result.lines.join("\n");
}

export function formatSkillCatalog(contractPath: string, format: "plain" | "json"): string {
  const currentState = existsSync(contractPath)
    ? deriveInfo(loadContract(contractPath)).state
    : null;
  const allowed = currentState ? new Set(allowedTransitions(currentState)) : null;
  const skills = prSkillNames.map((skill) => {
    const definition = eventForSkill(skill);
    return {
      skill,
      event: definition.event,
      kind: definition.kind,
      to: definition.kind === "transition" ? definition.to : null,
      allowedFromCurrent:
        definition.kind === "transition" && allowed ? allowed.has(definition.to) : null,
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
        item.allowedFromCurrent === null
          ? "allowed=unknown"
          : `allowed=${item.allowedFromCurrent ? "yes" : "no"}`;
      lines.push(`${item.skill} -> ${item.event} -> ${item.to} (${allowedText})`);
    } else {
      lines.push(`${item.skill} -> ${item.event} (observe)`);
    }
  }

  return lines.join("\n");
}

export function formatOverview(overview: OverviewResult, format: "plain" | "json"): string {
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
    lines.push(
      `  ${checksLabel(row.checks)} - ${reviewLabel(row.review, row.approvals)} | ${detailSuffix(row)}`,
    );
  } else {
    lines.push("  no PR associated with the current branch");
  }

  lines.push("", "Created by you");
  if (overview.createdByYou.length === 0) {
    lines.push("  none");
  } else {
    for (const row of overview.createdByYou) {
      lines.push(`  #${row.number}  ${truncate(row.title)} [${row.branch}]`);
      lines.push(
        `  ${checksLabel(row.checks)} - ${reviewLabel(row.review, row.approvals)} | ${detailSuffix(row)}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatRepos(
  inventory: RepoInventory,
  format: "plain" | "json",
  localOnly = false,
): string {
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

// `prx repo list --list-origins`: every discovered repo's `origin` remote
// URL, deduped and sorted — for scripting against every repo's upstream in
// one pass (e.g. piping into `gh repo view` or diffing against a prior run).
// Deliberately keys on a remote literally named "origin" rather than
// `primaryRemote` (which falls back to the first remote of any name) — a
// repo whose only remote is a local buffer cache has no real origin to list.
// Repos with no `origin` remote configured are silently omitted.
export function formatRepoOrigins(inventory: RepoInventory, format: "plain" | "json"): string {
  const origins = Array.from(
    new Set(
      inventory.repos
        .map((repo) => repo.remotes.find((remote) => remote.name === "origin")?.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0),
    ),
  ).sort();
  if (format === "json") {
    return JSON.stringify(origins, null, 2);
  }
  return origins.join("\n");
}

// `prx repo list --list-submodules`: every discovered repo's .gitmodules
// entries — an audit surface, not a repair; see findRepoSubmodules.
export function formatRepoSubmodules(
  findings: RepoSubmoduleFinding[],
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(findings, null, 2);
  }
  if (findings.length === 0) {
    return "No git submodules found.";
  }
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(`${finding.repoName} — ${finding.worktreePath}`);
    for (const sub of finding.submodules) {
      lines.push(`  ${sub.name} (${sub.path}) -> ${sub.url ?? "<no url>"}`);
    }
  }
  return lines.join("\n");
}

export function formatRepoSet<T>(
  slug: string,
  axis: "canonical" | "stale-threshold-days" | "bd-workspace-prefix" | "dolt-remote",
  delta: SetRepoAxisDelta<T>,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(
      { slug, axis, previous: delta.previous, current: delta.current },
      null,
      2,
    );
  }
  const prev = delta.previous === undefined ? "(unset)" : String(delta.previous);
  return `repo set: ${slug}.${axis}: ${prev} -> ${String(delta.current)}`;
}

export function formatRepoAdd(result: RepoAddResult, format: "plain" | "json"): string {
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
    lines.push(
      `  beads: clone-failed — mirror clone failed for ${hydrate.doltRemote ?? "<unknown remote>"}`,
    );
    lines.push(`         → run \`prx repo refresh ${result.parsed.name}\` once reachable`);
  } else if (hydrate.status === "hydrated" || hydrate.status === "already-hydrated") {
    const db = hydrate.doltDatabase ?? "<unknown db>";
    lines.push(`  beads: ${hydrate.status} — ${db}`);
  } else {
    lines.push(`  beads: ${hydrate.status} — ${hydrate.message}`);
  }
  return lines.join("\n");
}

export function formatRepoRefresh(result: RepoRefreshResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const dryTag = result.dryRun ? " (dry-run)" : "";
  const lines = [`Refreshed repo: ${result.slug}${dryTag}`];
  lines.push(`  bare:    ${result.barePath}`);
  lines.push(`  mainx:   ${result.mainxPath}${result.mainxCreated ? "  (created)" : ""}`);
  if (result.refspecUpgraded) {
    const action = result.dryRun ? "would upgrade" : "upgraded";
    lines.push(
      `  refspec: ${action} (${result.refspecBefore.length} → ${result.refspecAfter.length} lines)`,
    );
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
    lines.push(
      `  beads:   clone-failed — mirror clone failed for ${hydrate.doltRemote ?? "<unknown remote>"}`,
    );
  } else if (hydrate.status === "hydrated" || hydrate.status === "already-hydrated") {
    const db = hydrate.doltDatabase ?? "<unknown db>";
    lines.push(`  beads:   ${hydrate.status} — ${db}`);
  } else {
    lines.push(`  beads:   ${hydrate.status} — ${hydrate.message}`);
  }
  return lines.join("\n");
}

export function formatMaterialize(result: MaterializeResult, format: "plain" | "json"): string {
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

export function formatRepoNormalization(
  result: RepoNormalizationResult,
  format: "plain" | "json",
): string {
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

export function formatWorktree(summary: WorktreeStatus, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const branchName = summary.branch.detached ? "detached" : (summary.branch.name ?? "unknown");
  const upstream = summary.branch.upstream ?? "none";
  const lines = [
    `branch=${branchName} sync=${summary.branch.sync} upstream=${upstream} ahead=${summary.branch.ahead} behind=${summary.branch.behind}`,
    `worktree=${summary.clean ? "clean" : "dirty"} staged=${summary.counts.staged} unstaged=${summary.counts.unstaged} untracked=${summary.counts.untracked} conflicts=${summary.counts.conflicts} ignored=${summary.counts.ignored}`,
  ];

  return lines.join("\n");
}

export function formatWtStatus(summary: WtStatusResult, format: "plain" | "json"): string {
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
      lines.push(`  symbols: ${item.symbols.join(" ")} (${item.symbol_meanings.join(", ")})`);
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

export function formatRepoStatus(summary: RepoStatusResult, format: "plain" | "json"): string {
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

export function formatCloseSession(result: CloseSessionResult, format: "plain" | "json"): string {
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
  lines.push(
    `remote_branch=${result.remoteBranchPresent === null ? "unknown" : result.remoteBranchPresent ? "present" : "gone"}`,
  );
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

export function formatPlanCloseResult(result: PlanCloseResult, format: "plain" | "json"): string {
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

export function formatWorktreeRemove(
  summary: WorktreeRemoveResult,
  format: "plain" | "json",
): string {
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

export function formatRemoteCiCheck(
  summary: RemoteCiCheckResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const lines = [`remote ci check`, `repo=${summary.repoPath} pr=${summary.pr}`];

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

export function formatScoutLogs(result: ScoutLogsResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [`scout logs for pr=${result.pr}`, `failing_checks=${result.checks.length}`];

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

export function formatPrComments(
  summary: PrCommentsResult,
  format: "plain" | "json",
  savedTo?: string,
): string {
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
    lines.push(
      `- ${status} outdated=${thread.isOutdated} path=${thread.path ?? "(none)"} id=${thread.id}`,
    );
    for (const comment of thread.comments) {
      lines.push(`  - ${comment.authorLogin ?? "unknown"}: ${comment.body}`);
    }
  }
  if (savedTo) {
    lines.push(`saved=${savedTo}`);
  }
  return lines.join("\n");
}

export function formatPrCommentsResolution(
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

export function formatRepoChecks(result: RepoCheckNamesResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [`check names for ${result.repo} @ ${result.branch}`, `sha=${result.sha}`];

  if (result.checks.length === 0) {
    lines.push("no check runs found");
    return lines.join("\n");
  }

  for (const check of result.checks) {
    lines.push(`- ${check}`);
  }

  return lines.join("\n");
}

export function formatProtectMain(
  result: ProtectMainBranchResult,
  format: "plain" | "json",
): string {
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
    ...(result.requiredApprovingReviewCountSuppressed
      ? ["required_approving_review_count_suppressed=true"]
      : []),
    ...(result.requireLastPushApprovalSuppressed
      ? ["require_last_push_approval_suppressed=true"]
      : []),
    `require_linear_history=${result.requireLinearHistory}`,
    `required_status_checks=${result.requiredStatusChecks.join(",") || "none"}`,
    `command=${result.command.join(" ")}`,
  ].join("\n");
}

export function formatProtectMainCheck(
  result: ProtectMainBranchCheckResult,
  format: "plain" | "json",
): string {
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
    ...(result.requiredApprovingReviewCountSuppressed
      ? ["required_approving_review_count_suppressed=true"]
      : []),
    ...(result.requireLastPushApprovalSuppressed
      ? ["require_last_push_approval_suppressed=true"]
      : []),
    `require_linear_history=${result.requireLinearHistory}`,
    `required_status_checks=${result.requiredStatusChecks.join(",") || "none"}`,
  ].join("\n");
}

export function formatParityChainApplyResults(
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
    const subject =
      result.action.type === "close_issue" ? `GH-${result.action.issue}` : result.action.branch;
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

export function formatRepairBdResults(entries: RepairBdEntry[], format: "plain" | "json"): string {
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

export function formatChainsStatus(summary: ChainStatusResult, format: "plain" | "json"): string {
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
    const local =
      row.local.clean === null
        ? "local=unknown"
        : row.local.clean
          ? "local=clean"
          : `local=dirty(s=${row.local.staged} u=${row.local.unstaged} ?=${row.local.untracked} c=${row.local.conflicts})`;
    const status = row.status
      ? ` | remote=gh_issue:${row.status.remote.gh_issue},beads_issue:${row.status.remote.beads_issue},project_item:${row.status.remote.project_item},branch:${row.status.remote.branch},pr:${row.status.remote.pr},merge_state:${row.status.remote.merge_state},ci:${row.status.remote.ci},problem:${row.status.remote.problem} | local=branch:${row.status.local.branch},worktree:${row.status.local.worktree},dir:${row.status.local.dir},problem:${row.status.local.problem}`
      : ` | ${local}`;
    const disposition = row.disposition ? ` | disposition=${row.disposition}` : "";
    lines.push(`${identifier} | ${row.state} | ${pr}${status}${disposition}`);
  }

  return lines.join("\n");
}

export function formatNextWork(result: NextWorkResult, format: "plain" | "json"): string {
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

export function formatActionPlan(
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
    lines.push(
      `  ${action.id} [${action.enabled ? "enabled" : "disabled"}] (${action.surface}) -> ${action.command}`,
    );
    if (action.reason) {
      lines.push(`    reason: ${action.reason}`);
    }
    if (!action.enabled && action.disabledReason) {
      lines.push(`    blocked: ${action.disabledReason}`);
    }
  }

  return lines.join("\n");
}

export function formatActionExecutionResult(
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
  return [`${action.id}: ${result.status}`, action.label, result.message].join("\n");
}

export function formatPhase(plan: ActionPlan, format: "plain" | "json"): string {
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

export function formatSnapshot(state: DomainStateV1, format: "plain" | "json"): string {
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

export function formatStatusLine(plan: ActionPlan, format: "plain" | "json"): string {
  const unit =
    plan.snapshot.currentUnit?.ticket ?? plan.snapshot.branch ?? basename(plan.snapshot.repoRoot);
  const prLabel = plan.snapshot.pr.exists
    ? `#${plan.snapshot.pr.number}${plan.snapshot.pr.draft ? " draft" : ""}`
    : "none";
  const wtLabel =
    plan.snapshot.local.staged === 0 &&
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

export function formatActors(scope: ActorScope, format: "plain" | "json"): string {
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

export function formatModel(scope: ActorScope, format: "plain" | "json"): string {
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

export function formatSprintState(state: SprintStateV1, format: "plain" | "json"): string {
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

export function formatSprintSyncResult(
  payload: { apply: boolean; statePath: string; sprintId: string; notion: Record<string, unknown> },
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }
  const action = payload.apply ? "SYNCED" : "WOULD SYNC";
  return `${action} SprintX -> Notion projection for ${payload.sprintId} (${payload.statePath})`;
}

export function formatGhBudgetWindow(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}
