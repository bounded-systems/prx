// GH-2098 — the repo's first Zod `.brand<>()` types. Nominal safety for the
// three core ID strings that flow through the raw-fact carrier
// (`rawStateV1Schema`) and the handoff envelope: a work-unit id, a branch
// name, and a git commit sha are no longer mutually assignable.
//
// Layering note: this package peer-depends only on `zod`. The *canonical*
// work-unit-id shape (the GH/NOTION/BD union) is registry-derived at runtime
// in `src/machine/work_unit.ts` and must NOT be duplicated here. Zod brands
// unify on the literal type argument, so `src/` can append
// `.brand<"WorkUnitId">()` to its canonical schema and produce the SAME TS
// type as the permissive carrier below — no symbol import across the layer.
//
// All three carriers are permissive on shape (`min(1)`): branding is nominal
// typing, not a new validation gate. `derivePhase`/`assertInvariants`
// re-`.parse()` the raw-fact schema, so tightening shape here would change
// runtime acceptance — out of scope for this pure type-nominalization step.

import { z } from "zod";

// ── git commit sha ─────────────────────────────────────────────────────────
export const shaSchema = z.string().min(1).brand<"Sha">();
export type Sha = z.infer<typeof shaSchema>;

// ── branch name ────────────────────────────────────────────────────────────
export const branchNameSchema = z.string().min(1).brand<"BranchName">();
export type BranchName = z.infer<typeof branchNameSchema>;

// ── work-unit id ───────────────────────────────────────────────────────────
//
// Permissive carrier. `src/machine/work_unit.ts` owns canonical-shape
// validation and brands its registry-derived schema with the same
// `"WorkUnitId"` tag, yielding an identical TS type.
export const workUnitIdSchema = z.string().min(1).brand<"WorkUnitId">();
export type WorkUnitId = z.infer<typeof workUnitIdSchema>;

// ── thin parse seams ─────────────────────────────────────────────────────────
//
// Brand a raw string on the way in at a validated boundary. Nullable variants
// pass `null` through untouched (the schema fields they back are nullable).
export const parseSha = (value: string): Sha => shaSchema.parse(value);
export const parseBranchName = (value: string): BranchName => branchNameSchema.parse(value);
export const parseWorkUnitId = (value: string): WorkUnitId => workUnitIdSchema.parse(value);

export const parseShaNullable = (value: string | null): Sha | null =>
  value === null ? null : shaSchema.parse(value);
export const parseBranchNameNullable = (value: string | null): BranchName | null =>
  value === null ? null : branchNameSchema.parse(value);
export const parseWorkUnitIdNullable = (value: string | null): WorkUnitId | null =>
  value === null ? null : workUnitIdSchema.parse(value);
