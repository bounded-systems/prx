// The typed intermediate the README is rendered from.
//
// `community/community.json` (variable governance facts) and the per-package
// `description` fields in `packages/*/package.json` are the two sources of
// truth. `build.ts` projects them into a `ReadmeModel`; the `prx docs` verb
// renders that model through `community/templates/readme.md`.
//
// The Zod schema here is the single definition of that shape: `z.infer` gives
// the static type the codegen consumes, and `toJsonSchemaArtifact` (see
// `prx schemas`) projects it to the committed Draft-7
// artifact `schemas/readme/readme.schema.json`, so the intermediate type and
// its JSON Schema cannot drift.

import { z } from "zod";

/** One workspace package as it appears in the generated Layout section. */
export const PackageEntry = z
  .object({
    /** Full package name, e.g. `@bounded-systems/cas`. */
    name: z.string().min(1),
    /** Short name without the `@bounded-systems/` scope, e.g. `cas`. */
    short: z.string().min(1),
    /** One-line `description` lifted verbatim from the package's package.json. */
    description: z.string().min(1),
  })
  .strict();
export type PackageEntry = z.infer<typeof PackageEntry>;

/** The validated data the README template is rendered from. */
export const ReadmeModel = z
  .object({
    project: z
      .object({
        name: z.string().min(1),
        tagline: z.string().min(1),
        description: z.string().min(1),
        org: z.string().min(1),
        repo: z.string().min(1),
        url: z.string().min(1),
      })
      .strict(),
    license: z
      .object({
        spdx: z.string().min(1),
        name: z.string().min(1),
        url: z.string().min(1),
      })
      .strict(),
    maintainerUrl: z.string().min(1),
    /** The `@bounded-systems/prx` package — the CLI, highlighted first. */
    cli: PackageEntry,
    /** The remaining `@bounded-systems/*` libraries, sorted by short name. */
    libraries: z.array(PackageEntry).min(1),
  })
  .strict();
export type ReadmeModel = z.infer<typeof ReadmeModel>;

/** Artifact name used in the `#/definitions/<name>` JSON Schema wrapper. */
export const README_MODEL_SCHEMA_NAME = "readme_model";
