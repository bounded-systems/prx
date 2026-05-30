/**
 * `prx intake bd {ls, memory ls|get|set}` — narrow bd surface for the intake
 * operator session (GH-1003, part of GH-998). Wraps `bd list`, `bd memories`,
 * `bd recall`, and `bd remember` so GH-1004 can drop the raw `bd list:*` and
 * `bd memories:*` allowlist entries from the intake profile.
 *
 * Mirrors src/intake/intake-view.ts: pure CLI leaves, no XState events, no
 * schema scaffolding. All bd calls route through `execBd` (policy-enforced)
 * with explicit state="planning"/role="planner" so the verbs work the same
 * whether invoked from inside an intake session or from a fresh shell.
 *
 * Out of scope (deferred): destructive verbs (`bd close`, `bd forget`),
 * cross-source verbs (`bd github sync`), and the intake profile allowlist
 * narrowing (GH-1004).
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { execBd, type BdExecResult } from "@bounded-systems/bd";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export class IntakeBdError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "IntakeBdError";
    this.exitCode = exitCode;
  }
}

export type IntakeBdDeps = {
  execBd?: typeof execBd;
};

// ---------------------------------------------------------------------------
// `prx intake bd ls`
// ---------------------------------------------------------------------------

// `--status` is forwarded verbatim to `bd list --status <value>`. We do not
// re-validate the vocabulary at the wrapper layer (bd's status set has grown
// past the documented `open|in_progress|blocked|deferred|closed` to include
// `pinned`/`hooked`, and may grow further). bd's own error message is the
// canonical surface for unknown statuses.
export const intakeBdLsOptionsSchema = z.object({
  status: z.string().trim().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(0, "--limit must be a non-negative integer")
    .default(20),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeBdLsOptions = z.infer<typeof intakeBdLsOptionsSchema>;

const VERB_LS = "prx intake bd ls";

export function runIntakeBdLs(
  opts: IntakeBdLsOptions,
  output: Output,
  deps: IntakeBdDeps = {},
): number {
  const bdExec = deps.execBd ?? execBd;
  const args: string[] = ["--limit", String(opts.limit)];
  if (opts.status) {
    args.push("--status", opts.status);
  }
  if (opts.format === "json") {
    args.push("--json");
  }

  const result = bdExec(
    { subcommand: "list", args, state: "planning", role: "planner" },
    processEnv(),
  );

  return emitBdResult(result, output, VERB_LS, opts.format);
}

// ---------------------------------------------------------------------------
// `prx intake bd memory ls [search]`
// ---------------------------------------------------------------------------

export const intakeBdMemoryLsOptionsSchema = z.object({
  search: z.string().trim().min(1).optional(),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeBdMemoryLsOptions = z.infer<typeof intakeBdMemoryLsOptionsSchema>;

const VERB_MEMORY_LS = "prx intake bd memory ls";

export function runIntakeBdMemoryLs(
  opts: IntakeBdMemoryLsOptions,
  output: Output,
  deps: IntakeBdDeps = {},
): number {
  const bdExec = deps.execBd ?? execBd;
  const args: string[] = [];
  if (opts.search) {
    args.push(opts.search);
  }
  if (opts.format === "json") {
    args.push("--json");
  }

  const result = bdExec(
    { subcommand: "memories", args, state: "planning", role: "planner" },
    processEnv(),
  );

  return emitBdResult(result, output, VERB_MEMORY_LS, opts.format);
}

// ---------------------------------------------------------------------------
// `prx intake bd memory get <key>`
// ---------------------------------------------------------------------------

export const intakeBdMemoryGetOptionsSchema = z.object({
  key: z.string().trim().min(1, "key must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeBdMemoryGetOptions = z.infer<typeof intakeBdMemoryGetOptionsSchema>;

const VERB_MEMORY_GET = "prx intake bd memory get";

export function runIntakeBdMemoryGet(
  opts: IntakeBdMemoryGetOptions,
  output: Output,
  deps: IntakeBdDeps = {},
): number {
  const bdExec = deps.execBd ?? execBd;
  const args: string[] = [opts.key];
  if (opts.format === "json") {
    args.push("--json");
  }

  const result = bdExec(
    { subcommand: "recall", args, state: "planning", role: "planner" },
    processEnv(),
  );

  return emitBdResult(result, output, VERB_MEMORY_GET, opts.format);
}

// ---------------------------------------------------------------------------
// `prx intake bd memory set <key> --body "<text>"`
// ---------------------------------------------------------------------------

export const intakeBdMemorySetOptionsSchema = z.object({
  key: z.string().trim().min(1, "key must not be empty"),
  body: z.string().min(1, "--body must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeBdMemorySetOptions = z.infer<typeof intakeBdMemorySetOptionsSchema>;

const VERB_MEMORY_SET = "prx intake bd memory set";

export function runIntakeBdMemorySet(
  opts: IntakeBdMemorySetOptions,
  output: Output,
  deps: IntakeBdDeps = {},
): number {
  const bdExec = deps.execBd ?? execBd;
  const args: string[] = [opts.body, "--key", opts.key];
  if (opts.format === "json") {
    args.push("--json");
  }

  const result = bdExec(
    { subcommand: "remember", args, state: "planning", role: "planner" },
    processEnv(),
  );

  return emitBdResult(result, output, VERB_MEMORY_SET, opts.format);
}

// ---------------------------------------------------------------------------
// Shared output emitter
// ---------------------------------------------------------------------------

// Pass bd's own stdout through to the operator. We add `--json` to the bd
// argv when format=json, so stdout is already JSON when the caller asked for
// it; plain stdout is what bd renders for humans. Errors collapse to a single
// `<verb>: <detail>` line on stderr, matching the sibling intake verbs.
function emitBdResult(
  result: BdExecResult,
  output: Output,
  verb: string,
  _format: "plain" | "json",
): number {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "bd command failed").trim();
    output.error(`${verb}: ${detail}`);
    return result.exitCode || 1;
  }

  output.log(result.stdout.trimEnd());
  return 0;
}
