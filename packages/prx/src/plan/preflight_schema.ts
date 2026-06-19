// GH-1239: Zod schemas for `prx plan preflight` output.
//
// The preflight is a deterministic three-axis check that runs before the
// planner drafts a plan. Each axis can pass or fail independently; the result
// is a structured report rather than a single bool so the CLI can render the
// concrete failure (which deliverable already exists, which action shape is
// blocked, which dep is open) without re-running any I/O.
//
// `findings` is a flat list because callers (CLI renderer + the auto-step in
// the plan-session handler) treat any non-empty list as a refusal signal —
// the per-axis discriminator on each finding is what drives the per-line
// rendering, not a nested grouping.

import { z } from "zod";

export const PreflightDeliverableShape = z.enum([
  "file",
  "issue-comment",
  "issue-body",
  "issue-state",
  "pr-merge",
]);
export type PreflightDeliverableShape = z.infer<typeof PreflightDeliverableShape>;

export const PreflightActionShape = z.enum(["edit", "write", "git", "gh-issue", "gh-pr", "bd"]);
export type PreflightActionShape = z.infer<typeof PreflightActionShape>;

// GH-1516: verb-context classification for file deliverables. A path inside
// `## Acceptance Criteria` may be a *target* the planner will produce
// (`create`), a file being *modified* (`modify`), or just a citation (`see X`,
// `(X)`, `cites X`). Extraction emits the context so axis-1
// (`checkAlreadyDone`) can suppress the false-positive that breaks GH-1514 /
// GH-1515 / GH-1548 — only `create` and `unknown` deliverables count as
// "should this artifact exist yet?".
export const DeliverableContext = z.enum(["create", "modify", "reference", "unknown"]);
export type DeliverableContext = z.infer<typeof DeliverableContext>;

// GH-1516: section-derived perspective for planned actions. An action verb
// that appears under `## Approach` / `## Implementation` describes what the
// executor will eventually run — under the planner role we should not refuse
// the plan-session entry just because the executor's later action is BLOCKED
// for the planner now (e.g. `git remote`, `git rev-parse --git-common-dir`).
// `planner-now` covers Acceptance-Criteria-style sections — contracts the
// planner is committing to here.
export const ActionPerspective = z.enum([
  "planner-now",
  "executor-later",
  "documentary",
  "unknown",
]);
export type ActionPerspective = z.infer<typeof ActionPerspective>;

// Axis 1 finding: an artifact already exists. `target` is the human-readable
// pointer (file path, "GH-N comment", PR ref) so the CLI can render it
// verbatim.
// GH-1516: `governingContext` carries the verb-context classification from
// extraction (`create` / `modify` / `reference` / `unknown`) when the mention
// was for a file. Optional and only set when extraction determined a
// meaningful context — preserves the pre-GH-1516 wire shape for callers that
// don't read the new field.
export const PreflightAlreadyDoneFinding = z.object({
  axis: z.literal("already-done"),
  shape: PreflightDeliverableShape,
  target: z.string().min(1),
  detail: z.string().optional(),
  governingContext: DeliverableContext.optional(),
});
export type PreflightAlreadyDoneFinding = z.infer<typeof PreflightAlreadyDoneFinding>;

// Axis 2 finding: a planned action shape is infeasible under the executor
// profile. `reason` carries the policy layer that refused.
// GH-1516: `perspective` carries the section-derived perspective when known.
// Optional, populated only for diagnostic surfacing; never auto-set by the
// emitter (preserves the pre-GH-1516 wire shape for callers comparing exact
// finding objects).
export const PreflightInfeasibleActionFinding = z.object({
  axis: z.literal("infeasible-action"),
  shape: PreflightActionShape,
  subcommand: z.string().min(1),
  reason: z.enum(["blocked", "not-allowlisted-for-role", "disallowed-by-profile", "unknown-tool"]),
  detail: z.string().optional(),
  perspective: ActionPerspective.optional(),
});
export type PreflightInfeasibleActionFinding = z.infer<typeof PreflightInfeasibleActionFinding>;

// GH-1579: axis-2 demotion — the action is feasible for SOME role at this
// state, just not the current role. Renders as an informational hint
// ("`bd update` is owned by planner — run `prx triage session` first") and
// does NOT cause the preflight to refuse. Preserved alongside the
// `infeasible-action` variant so existing JSON consumers keep working.
export const PreflightActionDeferredFinding = z.object({
  axis: z.literal("action-deferred-to-other-role"),
  shape: PreflightActionShape,
  subcommand: z.string().min(1),
  owningRoles: z
    .array(z.enum(["planner", "executor", "reviewer", "tester", "keeper", "forge"]))
    .min(1),
  owningProfiles: z
    .array(z.enum(["plan", "intake", "triage", "implement", "submit", "author"]))
    .optional(),
  suggestedUnblock: z.string().optional(),
  perspective: ActionPerspective.optional(),
});
export type PreflightActionDeferredFinding = z.infer<typeof PreflightActionDeferredFinding>;

// GH-1516: action mention whose section-derived perspective ("the executor
// will run this later") is incompatible with the current role evaluating the
// preflight. Advisory — does NOT contribute to refusal flags. Distinct from
// `action-deferred-to-other-role` (GH-1579) because that variant fires when
// some other role at this state owns the verb; here the issue is the mention
// itself is describing executor-time work that the planner isn't being asked
// to run now.
export const PreflightActionPerspectiveMismatchFinding = z.object({
  axis: z.literal("action-perspective-mismatch"),
  shape: PreflightActionShape,
  subcommand: z.string().min(1),
  perspective: ActionPerspective,
  section: z.string().optional(),
  currentRole: z.enum(["planner", "executor", "reviewer", "tester", "keeper", "forge"]),
  detail: z.string().optional(),
});
export type PreflightActionPerspectiveMismatchFinding = z.infer<
  typeof PreflightActionPerspectiveMismatchFinding
>;

// Axis 3 finding: a still-open issue gates this work. `issue` is the GH
// number; `title` is included when the lookup succeeded so operators can see
// what is blocking without a second `gh issue view`.
export const PreflightInfeasibleBlockerFinding = z.object({
  axis: z.literal("infeasible-blocker"),
  issue: z.number().int().positive(),
  title: z.string().optional(),
  source: z.enum(["beads", "issue-body", "both"]),
});
export type PreflightInfeasibleBlockerFinding = z.infer<typeof PreflightInfeasibleBlockerFinding>;

// Soft-warn — the dep extractor saw a reference but couldn't resolve it
// (deleted issue, transferred repo, network failure). Render but don't fail.
export const PreflightWarning = z.object({
  axis: z.literal("warning"),
  message: z.string().min(1),
});
export type PreflightWarning = z.infer<typeof PreflightWarning>;

export const PreflightFinding = z.discriminatedUnion("axis", [
  PreflightAlreadyDoneFinding,
  PreflightInfeasibleActionFinding,
  PreflightActionDeferredFinding,
  PreflightActionPerspectiveMismatchFinding,
  PreflightInfeasibleBlockerFinding,
  PreflightWarning,
]);
export type PreflightFinding = z.infer<typeof PreflightFinding>;

// `status` collapses the per-axis outcomes for downstream consumers that just
// want a single verdict. Distinct from `findings.length === 0` because the
// `partially-done` status carries the "some deliverables landed but not all"
// signal that the CLI prints differently from "fully already-done".
export const PreflightStatus = z.enum([
  "pass",
  "already-done",
  "partially-done",
  "infeasible-action",
  "infeasible-blocker",
  "mixed-failure",
  "extraction-empty",
]);
export type PreflightStatus = z.infer<typeof PreflightStatus>;

export const PreflightResult = z.object({
  unit: z.string().min(1),
  status: PreflightStatus,
  findings: z.array(PreflightFinding),
  // Per-axis summary counters — render-only convenience for the CLI plain
  // formatter. Recomputable from `findings`, intentionally redundant.
  counts: z.object({
    deliverablesExtracted: z.number().int().nonnegative(),
    deliverablesAlreadyDone: z.number().int().nonnegative(),
    actionsExtracted: z.number().int().nonnegative(),
    actionsInfeasible: z.number().int().nonnegative(),
    // GH-1579: actions feasible for another role at this state but not the
    // current one. Demoted findings — does not contribute to refusal flags.
    actionsDeferredToOtherRole: z.number().int().nonnegative(),
    // GH-1516: action mentions whose section-derived perspective is
    // executor-later under a non-executor role. Advisory, does not refuse.
    actionsPerspectiveMismatched: z.number().int().nonnegative(),
    blockersExtracted: z.number().int().nonnegative(),
    blockersOpen: z.number().int().nonnegative(),
  }),
});
export type PreflightResult = z.infer<typeof PreflightResult>;

// GH-1516: Zod-bounded extractor outputs. Extraction → mentions → findings is
// the boundary where shape drift between layers historically caused regression
// (see GH-1359 trailing-comment thread). Mentions are validated at runtime so
// future callers cannot quietly remove `context` / `perspective` without test
// failure.
export const FileDeliverableMention = z.object({
  shape: z.literal("file"),
  path: z.string().min(1),
  context: DeliverableContext,
  governingVerb: z.string().optional(),
  section: z.string().optional(),
});
export type FileDeliverableMention = z.infer<typeof FileDeliverableMention>;

export const PlannedActionMention = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("edit"),
    target: z.string().optional(),
    perspective: ActionPerspective,
    section: z.string().optional(),
  }),
  z.object({
    shape: z.literal("write"),
    target: z.string().optional(),
    perspective: ActionPerspective,
    section: z.string().optional(),
  }),
  z.object({
    shape: z.literal("git"),
    subcommand: z.string().min(1),
    perspective: ActionPerspective,
    section: z.string().optional(),
  }),
  z.object({
    shape: z.literal("gh-issue"),
    subcommand: z.string().min(1),
    perspective: ActionPerspective,
    section: z.string().optional(),
  }),
  z.object({
    shape: z.literal("gh-pr"),
    subcommand: z.string().min(1),
    perspective: ActionPerspective,
    section: z.string().optional(),
  }),
  z.object({
    shape: z.literal("bd"),
    subcommand: z.string().min(1),
    perspective: ActionPerspective,
    section: z.string().optional(),
  }),
]);
export type PlannedActionMention = z.infer<typeof PlannedActionMention>;

export function preflightExitCode(status: PreflightStatus): 0 | 1 {
  return status === "pass" ? 0 : 1;
}
