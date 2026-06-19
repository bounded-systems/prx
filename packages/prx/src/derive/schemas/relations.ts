// GH-1768 — Zod schemas for every fact relation the Datalog spike consumes.
//
// One schema per relation. Each schema:
//   • is `.strict()` — the projection is the trust boundary; unknown keys
//     surface as Zod failures rather than silently ignored fields.
//   • declares the relation name (`name`) and its column order so the
//     engine knows how positional args map to fields when projecting.
//
// The projection layer (`project.ts`) is the only writer; rules consume
// positional `Constant[]` tuples through the engine API. The Zod schemas
// gate the projection boundary; they're also exported to JSON Schema via
// `prx schemas` so downstream consumers can lint
// fact streams without importing the TS module.

import { z } from "zod";

export const issueSchema = z
  .object({
    id: z.string(),
    open: z.boolean(),
    closed: z.boolean(),
  })
  .strict();

export const blockedBySchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .strict();

export const branchSchema = z
  .object({
    issueId: z.string(),
    // Nullable: a row is emitted for every projected issue even when the
    // branch is unnamed, so equality joins against `pr.headRef` (also
    // nullable) work natively in Datalog without a special "both-null"
    // aux rule.
    name: z.string().nullable(),
    existsLocal: z.boolean(),
    existsRemote: z.boolean(),
    headShaLocal: z.string().nullable(),
    headShaRemote: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
  })
  .strict();

export const worktreeSchema = z
  .object({
    issueId: z.string(),
    exists: z.boolean(),
    path: z.string().nullable(),
    checkedOutBranch: z.string().nullable(),
    headSha: z.string().nullable(),
  })
  .strict();

export const prSchema = z
  .object({
    issueId: z.string(),
    exists: z.boolean(),
    number: z.number().int().nullable(),
    state: z.enum(["none", "open", "closed", "merged"]),
    isDraft: z.boolean().nullable(),
    headRef: z.string().nullable(),
    autoMergeEnabled: z.boolean(),
  })
  .strict();

export const ciRunSchema = z
  .object({
    issueId: z.string(),
    state: z.enum(["none", "queued", "in_progress", "passed", "failed", "cancelled"]),
    requiredTotal: z.number().int().nonnegative(),
    requiredPassed: z.number().int().nonnegative(),
  })
  .strict();

export const reviewSchema = z
  .object({
    issueId: z.string(),
    decision: z.enum(["none", "changes_requested", "approved"]),
    reviewersRequested: z.boolean(),
    unresolvedThreads: z.number().int().nonnegative(),
  })
  .strict();

export const syncSchema = z
  .object({
    issueId: z.string(),
    remoteFresh: z.boolean(),
  })
  .strict();

export const mergeabilitySchema = z
  .object({
    issueId: z.string(),
    state: z.enum(["unknown", "mergeable", "blocked", "conflicting", "behind", "draft"]),
  })
  .strict();

export const phaseSchema = z
  .object({
    issueId: z.string(),
    phase: z.string(),
  })
  .strict();

export const transitionSchema = z
  .object({
    id: z.string(),
    issueId: z.string().nullable(),
    fromState: z.string(),
    toState: z.string(),
    actor: z.string(),
    timestamp: z.string(),
  })
  .strict();

export const actorAllowedInPhaseSchema = z
  .object({
    actor: z.string(),
    phase: z.string(),
  })
  .strict();

// Speculative — see `rules/cache_scope.ts`. Synthetic in the spike;
// projection layer accepts caller-supplied tuples.
export const scopeOwnsSchema = z
  .object({
    scope: z.string(),
    tree: z.string(),
  })
  .strict();

export const changedTreeSchema = z
  .object({
    sha: z.string(),
    tree: z.string(),
  })
  .strict();

// Sentinel relations the projection emits for numeric-inequality
// invariants the engine cannot express natively (no arithmetic
// builtins in v0). Each is a single-column "issue has this defect"
// flag; rules in `rules/drift.ts` consume them as ordinary atoms.
// Documented in the retro as a finding: arithmetic leakage into
// projection.
export const ciRequiredOverflowSchema = z.object({ issueId: z.string() }).strict();

export const ciPassedButIncompleteSchema = z.object({ issueId: z.string() }).strict();

// Column order — the projection writer mirrors these tuples when calling
// `fact()`, and rules pattern-match positionally. Keep in sync with the
// Zod schemas above; the schema-roundtrip test asserts each relation
// appears here exactly once.
export const factColumns = {
  issue: ["id", "open", "closed"],
  blockedBy: ["from", "to"],
  branch: [
    "issueId",
    "name",
    "existsLocal",
    "existsRemote",
    "headShaLocal",
    "headShaRemote",
    "ahead",
    "behind",
  ],
  worktree: ["issueId", "exists", "path", "checkedOutBranch", "headSha"],
  pr: ["issueId", "exists", "number", "state", "isDraft", "headRef", "autoMergeEnabled"],
  ciRun: ["issueId", "state", "requiredTotal", "requiredPassed"],
  review: ["issueId", "decision", "reviewersRequested", "unresolvedThreads"],
  sync: ["issueId", "remoteFresh"],
  mergeability: ["issueId", "state"],
  phase: ["issueId", "phase"],
  transition: ["id", "issueId", "fromState", "toState", "actor", "timestamp"],
  actorAllowedInPhase: ["actor", "phase"],
  scopeOwns: ["scope", "tree"],
  changedTree: ["sha", "tree"],
  ci_required_overflow: ["issueId"],
  ci_passed_but_incomplete: ["issueId"],
} as const;

export const factRelations = Object.keys(factColumns) as Array<keyof typeof factColumns>;
export type FactRelation = (typeof factRelations)[number];

export const factSchemas = {
  issue: issueSchema,
  blockedBy: blockedBySchema,
  branch: branchSchema,
  worktree: worktreeSchema,
  pr: prSchema,
  ciRun: ciRunSchema,
  review: reviewSchema,
  sync: syncSchema,
  mergeability: mergeabilitySchema,
  phase: phaseSchema,
  transition: transitionSchema,
  actorAllowedInPhase: actorAllowedInPhaseSchema,
  scopeOwns: scopeOwnsSchema,
  changedTree: changedTreeSchema,
  ci_required_overflow: ciRequiredOverflowSchema,
  ci_passed_but_incomplete: ciPassedButIncompleteSchema,
} as const;

export type IssueFact = z.infer<typeof issueSchema>;
export type BlockedByFact = z.infer<typeof blockedBySchema>;
export type BranchFact = z.infer<typeof branchSchema>;
export type WorktreeFact = z.infer<typeof worktreeSchema>;
export type PrFact = z.infer<typeof prSchema>;
export type CiRunFact = z.infer<typeof ciRunSchema>;
export type ReviewFact = z.infer<typeof reviewSchema>;
export type SyncFact = z.infer<typeof syncSchema>;
export type MergeabilityFact = z.infer<typeof mergeabilitySchema>;
export type PhaseFact = z.infer<typeof phaseSchema>;
export type TransitionFact = z.infer<typeof transitionSchema>;
export type ActorAllowedInPhaseFact = z.infer<typeof actorAllowedInPhaseSchema>;
export type ScopeOwnsFact = z.infer<typeof scopeOwnsSchema>;
export type ChangedTreeFact = z.infer<typeof changedTreeSchema>;
