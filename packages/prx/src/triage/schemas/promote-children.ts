// `prx triage promote-children` Zod boundary (GH-1351).
//
// This schema is the contract between the producer (Ultraplan / `prx plan
// supply` / GH-1186) and the consumer (`prx triage promote-children`). The
// staging-dir layout is `<dir>/manifest.json` + body files referenced by the
// manifest. Existing freeform README + numbered-body legacy dirs are NOT
// consumed by this verb — they get a clear refusal and an upstream pointer.
//
// Upstream-source-citation discipline (reference_upstream_source_discipline):
//   - Body fields and intake types mirror `IntakeOptions` from
//     src/intake/intake.ts; INTAKE_TYPES is re-imported, not redefined.
//   - Area scope reuses the `AREA` enum from src/triage/labels.ts.
//   - Slot is a free-form durable handle Ultraplan picks before any GH-N
//     exists; idempotency hangs on slot, not title.
//
// Audit-row schema parallels `PromoteAuditEntry` in src/triage/promote.ts but
// records the dep-edge actions in addition to the file-issue actions.

import { z } from "zod";

// Manifest bodies stay narrow on `INTAKE_TYPES` (bd-axis types only). Spike
// is intentionally out-of-set here: spike-shaped staging through Ultraplan is
// an operator anti-pattern — a spike is operator-initiated planning work and
// should come through `prx intake spike` directly so the GH-only `type::spike`
// marker is stamped explicitly. The narrowed `INTAKE_TYPES` (GH-1489) makes
// that refusal mechanical.
import { INTAKE_TYPES } from "../../intake/types.ts";
import { AREA } from "../labels.ts";

export const DEP_TYPES = ["parent-child", "blocks"] as const;
export type DepType = (typeof DEP_TYPES)[number];

/**
 * One filed-out child issue declared by the manifest.
 *
 * `slot` is the durable handle Ultraplan stamps into the manifest before any
 * GH-N has been minted; `.filed.json` keys off slot for idempotency on re-run.
 * `file` is resolved relative to the manifest's directory.
 */
export const promoteChildBodySchema = z.object({
  slot: z.string().min(1),
  file: z.string().min(1),
  type: z.enum(INTAKE_TYPES),
  title: z.string().min(1),
  scope: AREA.optional(),
});
export type PromoteChildBody = z.infer<typeof promoteChildBodySchema>;

/**
 * One declared dep edge. `from` / `to` accept either a manifest slot
 * (resolved post-filing to the just-minted GH-N) or a literal `GH-NNN` /
 * `ai-home-NNN` reference for already-merged shared substrate (e.g. the
 * dep wiring `feature → GH-707` shape).
 */
export const promoteChildDepSchema = z.object({
  type: z.enum(DEP_TYPES),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type PromoteChildDep = z.infer<typeof promoteChildDepSchema>;

/**
 * Full staging-dir manifest. Schema lives here so any non-Ultraplan producer
 * (test fixture, hand-written one-off) targets the same shape. Defaults to an
 * empty `deps` array so plans without explicit edges parse cleanly.
 */
export const promoteChildrenManifestSchema = z.object({
  parentUnit: z.string().regex(/^GH-\d+$/),
  parentBead: z.string().regex(/^ai-home-\d+$/),
  generatedAt: z.string().datetime(),
  bodies: z.array(promoteChildBodySchema).min(1),
  deps: z.array(promoteChildDepSchema).default([]),
});
export type PromoteChildrenManifest = z.infer<typeof promoteChildrenManifestSchema>;

/**
 * `.filed.json` row written after a slot is filed successfully. Keyed by
 * slot so re-runs can skip already-filed bodies without re-parsing GH state.
 */
export const promoteChildrenFiledRowSchema = z.object({
  slot: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
});
export type PromoteChildrenFiledRow = z.infer<typeof promoteChildrenFiledRowSchema>;

export const promoteChildrenFiledStateSchema = z.object({
  rows: z.array(promoteChildrenFiledRowSchema).default([]),
});
export type PromoteChildrenFiledState = z.infer<typeof promoteChildrenFiledStateSchema>;

/**
 * One audit-log row. JSONL, one row per slot or dep edge processed; the
 * `kind` discriminator separates them. Mirrors the row-shape conventions in
 * src/triage/promote.ts:148.
 */
export const promoteChildrenAuditEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("body"),
    ts: z.string(),
    slot: z.string(),
    title: z.string(),
    type: z.enum(INTAKE_TYPES),
    action: z.enum(["create", "skip", "error", "title-mismatch"]),
    issue: z.number().int().positive().optional(),
    url: z.string().url().optional(),
    actor: z.literal("claude-code"),
    dryRun: z.boolean(),
    exitCode: z.number().int(),
    stderr: z.string().optional(),
  }),
  z.object({
    kind: z.literal("dep"),
    ts: z.string(),
    depType: z.enum(DEP_TYPES),
    from: z.string(),
    to: z.string(),
    fromBead: z.string().optional(),
    toBead: z.string().optional(),
    action: z.enum(["wire", "skip", "error"]),
    actor: z.literal("claude-code"),
    dryRun: z.boolean(),
    exitCode: z.number().int(),
    stderr: z.string().optional(),
  }),
]);
export type PromoteChildrenAuditEntry = z.infer<typeof promoteChildrenAuditEntrySchema>;
