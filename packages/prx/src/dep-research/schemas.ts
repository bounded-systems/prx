// dep-research boundary schemas (GH-1261).
//
// These three Zod records lock the data contract for the dep-research routine:
// fetch upstream → snapshot → diff → flag material deltas as triage-ready GH
// issues. PR-1 only exercises `DepManifestEntry` (parses the on-disk manifest
// at the boundary); `DepSnapshot` and `DepDelta` ship now so PR-2/PR-3 build
// against a stable shape.
//
// Boundary-validation pattern matches src/intake/, src/triage/, src/scout/:
// JSON in/out is parsed via Zod at the seam; nothing else trusts raw JSON.

import { z } from "zod";

export const DepSourceKind = z.enum(["git", "npm", "docs", "flake-input"]);
export type DepSourceKind = z.infer<typeof DepSourceKind>;

export const DepClassification = z.enum([
  "schema",
  "state",
  "cli",
  "config",
  "breaking",
  "none",
]);
export type DepClassification = z.infer<typeof DepClassification>;

export const DepSource = z.object({
  kind: DepSourceKind,
  url: z.string().url(),
  paths: z.array(z.string().min(1)).min(1),
});
export type DepSource = z.infer<typeof DepSource>;

const PathHints = z.array(z.string().min(1)).default([]);

export const DepClassificationHints = z
  .object({
    schema: PathHints,
    state: PathHints,
    cli: PathHints,
    config: PathHints,
  })
  .default({ schema: [], state: [], cli: [], config: [] });
export type DepClassificationHints = z.infer<typeof DepClassificationHints>;

export const DepManifestEntry = z.object({
  name: z.string().min(1),
  source: DepSource,
  classification_hints: DepClassificationHints,
  notes: z.string().optional(),
});
export type DepManifestEntry = z.infer<typeof DepManifestEntry>;

export const DepManifest = z.object({
  version: z.literal(1),
  entries: z.array(DepManifestEntry).min(1),
});
export type DepManifest = z.infer<typeof DepManifest>;

const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected lowercase sha256 hex digest");

export const DepSnapshot = z.object({
  dep: z.string().min(1),
  run_id: z.string().min(1),
  fetched_at: z.string().datetime(),
  source_sha256: z.record(z.string().min(1), Sha256Hex),
  source_byte_len: z.record(z.string().min(1), z.number().int().nonnegative()),
  run_state: z.enum(["ok", "failed"]).default("ok"),
});
export type DepSnapshot = z.infer<typeof DepSnapshot>;

export const DepDeltaChange = z.object({
  path: z.string().min(1),
  kind: z.enum(["added", "removed", "modified"]),
  excerpt: z.string().default(""),
});
export type DepDeltaChange = z.infer<typeof DepDeltaChange>;

export const DepDelta = z.object({
  dep: z.string().min(1),
  prev_run_id: z.string().min(1).nullable(),
  curr_run_id: z.string().min(1),
  classification: DepClassification,
  changes: z.array(DepDeltaChange).default([]),
});
export type DepDelta = z.infer<typeof DepDelta>;
