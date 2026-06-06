// The typed intermediate `bun run health` emits — schema-first, like the README
// model. `scripts/code-health.ts` gathers the metrics (knip / dependency-cruiser
// / type-coverage / value_props), builds a `CodeHealthReport`, and `.parse()`s
// it against THIS schema before printing `--json`. `scripts/export-health-schema.ts`
// projects the schema to the committed Draft-7 artifact
// `schemas/health/health.schema.json` (via `bun run schemas:export`), so the
// report shape and its JSON Schema cannot drift.
//
// The numbers themselves are volatile (line counts move every commit), so the
// rendered markdown is NOT a committed/drift-checked artifact — the schema'd JSON
// is the grounded surface; `docs/code-health.md` carries only the durable
// narrative (architecture + backlog).

import { z } from "zod";

export const CODE_HEALTH_SCHEMA_NAME = "CodeHealthReport";

/** One oversized-file entry in the sprawl lens. */
export const SprawlFile = z
  .object({
    file: z.string().min(1),
    lines: z.number().int().nonnegative(),
  })
  .strict();
export type SprawlFile = z.infer<typeof SprawlFile>;

export const CodeHealthReport = z
  .object({
    /** Largest source files + totals — the god-file watch. */
    sprawl: z
      .object({
        totalLines: z.number().int().nonnegative(),
        fileCount: z.number().int().nonnegative(),
        largest: z.array(SprawlFile),
      })
      .strict(),
    /** Circular import edges (dependency-cruiser) — the up-import symptom. */
    coupling: z
      .object({
        circularChains: z.number().int().nonnegative(),
        samples: z.array(z.string()),
      })
      .strict(),
    /** Unused files (knip, reachability from declared entrypoints). */
    deadCode: z
      .object({
        count: z.number().int().nonnegative(),
        files: z.array(z.string()),
      })
      .strict(),
    /** Value props backed / total + modules traced to a forcing function. */
    productMap: z
      .object({
        valueProps: z.number().int().nonnegative(),
        backed: z.number().int().nonnegative(),
        modulesExercised: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type CodeHealthReport = z.infer<typeof CodeHealthReport>;
