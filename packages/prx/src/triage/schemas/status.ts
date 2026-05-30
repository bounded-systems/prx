// `prx triage status` snapshot — Zod schema promoted from the existing TS
// types in src/triage/triage.ts. The status verb stays read-only and is the
// machine's first actor (`loadStatusActor`), seeding context with the data
// decision-state guards read.

import { z } from "zod";

const triageMissingFieldSchema = z.enum(["priority", "type", "beads-link"]);
const triageWeakSignalSchema = z.enum(["area", "effort"]);

export const triageIssueRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  beadsId: z.string().nullable(),
  missing: z.array(triageMissingFieldSchema),
  unknownLabels: z.array(z.string()),
  weakSignals: z.array(triageWeakSignalSchema),
});
export type TriageIssueRow = z.infer<typeof triageIssueRowSchema>;

export const reverseOrphanRowSchema = z.object({
  beadsId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  issueType: z.string(),
  reason: z.literal("no-external-ref"),
});
export type ReverseOrphanRow = z.infer<typeof reverseOrphanRowSchema>;

const driftFieldStringPairSchema = z.object({
  gh: z.string(),
  bd: z.string(),
});
const driftFieldStatusPairSchema = z.object({
  gh: z.literal("open"),
  bd: z.literal("closed"),
});
const driftFieldNullablePairSchema = z.object({
  gh: z.string().nullable(),
  bd: z.string(),
});

export const driftRowSchema = z.object({
  issueNumber: z.number().int().positive(),
  beadsId: z.string(),
  fields: z.object({
    title: driftFieldStringPairSchema.optional(),
    status: driftFieldStatusPairSchema.optional(),
    type: driftFieldNullablePairSchema.optional(),
    priority: driftFieldNullablePairSchema.optional(),
  }),
});
export type DriftRow = z.infer<typeof driftRowSchema>;

// GH-1588: an open bead whose linked GH issue is CLOSED — the `bd open ↔ gh
// closed` direction `findDrift` cannot see (it iterates open issues only).
// Report-only; remediation is owned by GH-941 / GH-1537.
export const staleRowSchema = z.object({
  beadsId: z.string(),
  issueNumber: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  issueType: z.string(),
  reason: z.literal("gh-issue-closed"),
});
export type StaleRow = z.infer<typeof staleRowSchema>;

// GH-1710: bd-canonical row shapes (no GH counterpart). Surfaced when
// `canonical: "bd"` so consumers can render the bd-only buckets without
// re-reading the substrate.
export const bdUntriagedRowSchema = z.object({
  beadsId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  issueType: z.string(),
  missing: z.array(z.enum(["priority", "type"])),
});
export type BdUntriagedRow = z.infer<typeof bdUntriagedRowSchema>;

export const bdStaleRowSchema = z.object({
  beadsId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  issueType: z.string(),
  lastTouched: z.string(),
  daysSince: z.number().int().nonnegative(),
});
export type BdStaleRow = z.infer<typeof bdStaleRowSchema>;

// GH-1449: an open GH issue carrying ≥2 mutually-exclusive labels on the same
// axis (`type::*` / `priority::*` / `area::*` / `effort::*`). Report-only —
// detection is independent of the gh↔bd join (the bd substrate has no axis
// labels, so canonical=bd repos always emit `[]`). The values list is the
// in-vocab axis values surfaced; out-of-vocab labels never contribute, and the
// GH-1489 `type::spike` marker is excluded from the type-axis count.
export const axisConflictRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  conflicts: z.array(
    z.object({
      axis: z.enum(["type", "priority", "area", "effort"]),
      values: z.array(z.string()),
    }),
  ),
});
export type AxisConflictRow = z.infer<typeof axisConflictRowSchema>;

export const triageStatusSnapshotSchema = z.object({
  repo: z.string().min(1),
  // GH-1710: explicit canonical axis surfaced on the snapshot. Required —
  // `runStatusActor` / `runTriageStatus` always set it (defaulting to "gh"
  // when no repo entry is registered for the cwd).
  canonical: z.enum(["gh", "bd"]),
  totalOpen: z.number().int().nonnegative(),
  totalUntriaged: z.number().int().nonnegative(),
  totalReverseOrphans: z.number().int().nonnegative(),
  totalDrift: z.number().int().nonnegative(),
  totalStale: z.number().int().nonnegative(),
  // GH-1449: report-only axis-exclusivity bucket. Always present and matches
  // `axisConflicts.length`; bd-canonical repos always emit `0` / `[]`.
  totalAxisConflicts: z.number().int().nonnegative(),
  issues: z.array(triageIssueRowSchema),
  reverseOrphans: z.array(reverseOrphanRowSchema),
  drift: z.array(driftRowSchema),
  stale: z.array(staleRowSchema),
  axisConflicts: z.array(axisConflictRowSchema),
  bdUntriaged: z.array(bdUntriagedRowSchema).optional(),
  bdStale: z.array(bdStaleRowSchema).optional(),
});
export type TriageStatusSnapshot = z.infer<typeof triageStatusSnapshotSchema>;

export function validateTriageStatusSnapshot(input: unknown): TriageStatusSnapshot {
  return triageStatusSnapshotSchema.parse(input);
}
