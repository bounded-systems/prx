// `prx plan save` as a deps-bearing VerbSpec migrated off cli.ts (ADR
// docs/prx/cli-decomposition.md) — the first real consumer of the `warnings`
// (stderr) projection. It reads a plan body (stdin or --from-file), persists it
// to the GH-1174 CAS plan store, and optionally cleans up the staging file.
// GH-2028 persist-on-failure: the body is ALWAYS written (exit 0); a shape gate
// miss (or --skip-validate) surfaces as stderr warnings, not a refusal — refusal
// moved to the consumer (`prx implement agent`).

import { readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { CliError } from "./cli-error.ts";
import { detectWorkCommandTarget, parseCanonicalWorkUnitId } from "./cli-id.ts";
import { resolvePlanSessionUnit } from "../plan-store/session-context.ts";
import { runPlanSave, type RunPlanSaveResult } from "../plan-store/verbs.ts";

type PlanSaveCleanupSpec = { kind: "none" } | { kind: "delete" } | { kind: "move-to"; dest: string };

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
  throw new CliError(`plan save: invalid --cleanup value: ${raw}. Valid: none, delete, move-to=<path>`);
}

export type PlanSaveDeps = {
  runPlanSave: typeof runPlanSave;
  readStdinSync: () => Buffer;
  readPlanFile: (path: string) => Buffer;
  statPath: (path: string) => { isDirectory(): boolean };
  unlinkPlanFile: (path: string) => void;
  renamePlanFile: (from: string, to: string) => void;
};
const realPlanSaveDeps = (): PlanSaveDeps => ({
  runPlanSave,
  readStdinSync: () => readFileSync(0),
  readPlanFile: (path) => readFileSync(path),
  statPath: (path) => statSync(path),
  unlinkPlanFile: (path) => unlinkSync(path),
  renamePlanFile: (from, to) => renameSync(from, to),
});

type PlanSaveResultOutput = {
  unit: string;
  slot: "draft" | "approved";
  result: RunPlanSaveResult;
  size: number;
  warnings: string[];
};

const PlanSaveOutput = z
  .object({
    unit: z.string(),
    slot: z.enum(["draft", "approved"]),
    size: z.number(),
    warnings: z.array(z.string()),
  })
  .loose();

export const planSaveVerb = defineVerb({
  id: "plan-save",
  summary: "Persist a plan body (stdin or --from-file) to the CAS plan store; warns (not refuses) on shape misses.",
  actor: "plan",
  input: z.object({
    unit: z.string().optional().describe("work unit (defaults to the planner pane / branch / cwd)"),
    slot: z.enum(["draft", "approved"]).default("draft").describe("plan slot"),
    "from-stdin": z.coerce.boolean().default(false).describe("read the body from stdin"),
    "from-file": z.string().optional().describe("read the body from a staging file"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    "skip-validate": z.coerce.boolean().default(false).describe("persist even if the shape gate fails (loud)"),
    cleanup: z.string().default("none").describe("post-save staging cleanup: none | delete | move-to=<dir>"),
  }),
  output: PlanSaveOutput,
  deps: realPlanSaveDeps,
  run: async (input, deps: PlanSaveDeps = realPlanSaveDeps()): Promise<PlanSaveResultOutput> => {
    // Source resolution (mutually exclusive; piped stdin is the implicit default).
    if (input["from-stdin"] && input["from-file"] !== undefined) {
      throw new CliError("plan save: --from-stdin and --from-file are mutually exclusive");
    }
    let source: { kind: "stdin" } | { kind: "file"; path: string };
    if (input["from-file"] !== undefined) source = { kind: "file", path: input["from-file"] };
    else if (input["from-stdin"]) source = { kind: "stdin" };
    else if (!process.stdin.isTTY) source = { kind: "stdin" };
    else throw new CliError("plan save: pass --from-stdin or --from-file <path> (no piped stdin detected)");

    const cleanup = parseCleanupSpec(input.cleanup);
    if (cleanup.kind !== "none" && source.kind !== "file") {
      throw new CliError(
        "plan save: --cleanup requires --from-file (no staging path to clean up when reading from stdin)",
      );
    }

    const resolved = resolvePlanSessionUnit(input.unit, { detect: detectWorkCommandTarget });
    if (resolved.unit === null) {
      throw new CliError(
        "plan save: pass --unit GH-N or run from a feature worktree (PRX_PLAN_SESSION_UNIT must be set, or branch/cwd must match the canonical id)",
      );
    }
    const unit =
      resolved.source === "flag" ? parseCanonicalWorkUnitId(resolved.unit, "--unit") : resolved.unit;

    const content = source.kind === "stdin" ? deps.readStdinSync() : deps.readPlanFile(source.path);

    // GH-1336: validate the move-to dest BEFORE the write so we never half-persist.
    if (cleanup.kind === "move-to") {
      try {
        if (!deps.statPath(cleanup.dest).isDirectory()) {
          throw new CliError(`plan save: --cleanup=move-to=${cleanup.dest} must point to an existing directory`);
        }
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(`plan save: --cleanup=move-to=${cleanup.dest} must point to an existing directory`);
      }
    }

    const warnings: string[] = [];
    if (input["skip-validate"]) {
      warnings.push("warning: plan save skipped shape validation (--skip-validate); slot will fail at consume");
    }

    const result = await deps.runPlanSave({
      unit,
      slot: input.slot,
      content,
      skipValidate: input["skip-validate"],
    });

    // Cleanup runs strictly after a successful save (CAS writers throw on
    // failure, so a throw above never reaches here — the staging file is intact).
    if (cleanup.kind !== "none" && source.kind === "file") {
      if (cleanup.kind === "delete") deps.unlinkPlanFile(source.path);
      else deps.renamePlanFile(source.path, join(cleanup.dest, basename(source.path)));
    }

    // GH-2028 persist-on-failure note (stderr; exit stays 0).
    if (!result.validated_ok && result.diagnostics.length > 0) {
      warnings.push(
        `note: plan saved with validated_ok=false (${result.diagnostics.length} diagnostic${result.diagnostics.length === 1 ? "" : "s"}); \`prx implement agent ${unit}\` will refuse until resolved:`,
      );
      for (const d of result.diagnostics) warnings.push(`  [${d.code}] ${d.path}: ${d.message}`);
    }

    return { unit, slot: input.slot, result, size: content.length, warnings };
  },
  warnings: (out) => (out as PlanSaveResultOutput).warnings,
  render: (out, input) => {
    const o = out as PlanSaveResultOutput;
    if (input.format === "json") {
      return JSON.stringify(
        {
          unit: o.unit,
          slot: o.slot,
          sha: o.result.sha,
          ref: o.result.ref,
          body_sha: o.result.body_sha,
          envelope_sha: o.result.envelope_sha,
          validated_ok: o.result.validated_ok,
          diagnostics: o.result.diagnostics,
          size: o.size,
        },
        null,
        2,
      );
    }
    return o.result.sha;
  },
});
