/**
 * Agent-result return channel (prx-lfv, epic prx-997).
 *
 * A headless `prx <actor> agent` run was silent in plain mode — the operator saw
 * a banner and nothing else, no UoW. Per the design (UoW = the beads issue; CAS
 * is the uniform return channel), every agent run now:
 *   1. detects the UoW(s) it produced — the bead(s) created during the run
 *      (a `bd list` diff, since the agent files through its own tools), and
 *   2. pins a typed result artifact to the CAS (`emitArtifact`), so the return
 *      is content-addressed and fetchable — the same store every other pipeline
 *      artifact uses.
 *
 * The CLI then surfaces the UoW + the CAS ref; it never reports a silent success.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { bdCommandRunner } from "../beadsd/bd-command-runner.ts";

import {
  type ArtifactDiagnostic,
  type ArtifactEdge,
  type ArtifactValidator,
  defineEdge,
  emitArtifact,
  runArtifactContract,
} from "./edge.ts";

export const agentResultSchema = z.object({
  /** The producing actor (intake, triage, …). */
  actor: z.string().min(1),
  /** The agent process exit status (0 = ok). */
  status: z.number().int(),
  /**
   * What the agent reported via `prx <actor> result` (the structured tool):
   *   filed     — created a new UoW (`uow` = the new bead/issue)
   *   merged    — folded into an existing UoW (`uow` = the canonical one)
   *   duplicate — an existing UoW already covers it (`uow` = that one)
   *   no_action — nothing filed (`reason` says why)
   * Absent when the agent did not report (older agents / it skipped the tool).
   */
  disposition: z
    .enum(["filed", "merged", "duplicate", "classified", "promoted", "deferred", "no_action"])
    .optional(),
  /** The UoW the disposition refers to — new OR the existing one matched. */
  uow: z.string().optional(),
  /** Why, for `merged`/`duplicate`/`no_action`. */
  reason: z.string().optional(),
  /** Fallback UoW signal: bead(s) created during the run (a `bd list` diff). */
  uows: z.array(z.string()),
  /** Short human summary (the agent's final result text, truncated). */
  summary: z.string(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

/** The structured result an actor's `prx <actor> result` tool reports. */
export const reportedResultSchema = z.object({
  disposition: z.enum([
    "filed",
    "merged",
    "duplicate",
    "classified",
    "promoted",
    "deferred",
    "no_action",
  ]),
  uow: z.string().optional(),
  reason: z.string().optional(),
});
export type ReportedResult = z.infer<typeof reportedResultSchema>;

/**
 * prx-bs4: the semantic contract for an agent result, beyond the schema. A
 * disposition that names an existing or new UoW must carry that `uow`, and a
 * `no_action` outcome must say why. This is the configurable validator the
 * uniform save seam runs on every emit/consume of an `agent_result`.
 */
const UOW_DISPOSITIONS = new Set([
  "filed",
  "merged",
  "duplicate",
  "classified",
  "promoted",
  "deferred",
]);
const agentResultContract: ArtifactValidator<AgentResult> = (r) => {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (r.disposition && UOW_DISPOSITIONS.has(r.disposition) && !r.uow) {
    diagnostics.push({
      code: "missing-uow",
      path: "uow",
      message: `disposition '${r.disposition}' must reference a UoW (uow)`,
    });
  }
  if (r.disposition === "no_action" && !r.reason) {
    diagnostics.push({
      code: "missing-reason",
      path: "reason",
      message: "disposition 'no_action' must include a reason",
    });
  }
  return diagnostics;
};

/** The result edge: an agent pins its outcome for the operator to read. */
const agentResultEdge: ArtifactEdge<AgentResult> = defineEdge({
  kind: "agent_result",
  slot: "latest",
  source: "agent",
  target: "operator",
  schema: agentResultSchema,
  validators: [agentResultContract],
});

/** Injected bead-id reader (the impure `bd list`); overridable in tests. */
export type BeadIdReader = (cwd: string) => string[];

const defaultBeadIdReader: BeadIdReader = (cwd) => {
  // Route through @bounded-systems/proc (no raw subprocess in src/ — the
  // ambient-authority guard). Best-effort: a missing `bd` (ENOENT, e.g. CI with
  // no beads workspace) makes defaultRunner THROW, and a non-zero exit returns
  // status≠0 — both yield [] so the result-capture never breaks the agent run.
  try {
    const r = bdCommandRunner(["bd", "list", "--json"], { cwd, check: false });
    if (r.status !== 0) return [];
    const rows = JSON.parse(r.stdout) as Array<{ id?: unknown }>;
    return rows.map((x) => x?.id).filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
};

/**
 * Snapshot the bead-id set — call before AND after the run to diff UoWs.
 * Best-effort: a throwing reader (bd absent / spawn error) yields an empty set
 * so UoW detection degrades to "no new UoW" rather than breaking the agent run.
 */
export function snapshotBeadIds(
  cwd: string,
  read: BeadIdReader = defaultBeadIdReader,
): Set<string> {
  try {
    return new Set(read(cwd));
  } catch {
    return new Set();
  }
}

/** Extract a short summary from the SDK result envelope (or raw stdout). */
export function summarizeAgentStdout(stdout: string, max = 280): string {
  let text = stdout.trim();
  try {
    const env = JSON.parse(stdout) as { result?: unknown };
    if (typeof env.result === "string") text = env.result.trim();
  } catch {
    // not a JSON envelope — fall back to the raw stdout
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Capture an agent run's outcome: the new UoW(s) (after − before) and a summary,
 * pinned to the CAS at `<workspaceId>:agent_result@latest`. Returns the ref +
 * UoWs for the CLI to surface.
 */
export async function captureAgentResult(input: {
  actor: string;
  workspaceId: string;
  status: number;
  stdout: string;
  before: Set<string>;
  after: Set<string>;
  /** What the agent reported via `prx <actor> result` (preferred over the diff). */
  reported?: ReportedResult | undefined;
}): Promise<{ ref: string; result: AgentResult; diagnostics: readonly ArtifactDiagnostic[] }> {
  const uows = [...input.after].filter((id) => !input.before.has(id)).sort();
  const result: AgentResult = {
    actor: input.actor,
    status: input.status,
    ...(input.reported
      ? {
          disposition: input.reported.disposition,
          ...(input.reported.uow ? { uow: input.reported.uow } : {}),
          ...(input.reported.reason ? { reason: input.reported.reason } : {}),
        }
      : {}),
    uows,
    summary: summarizeAgentStdout(input.stdout),
  };
  // prx-bs4: run the artifact contract (schema + validators). A contract
  // violation (e.g. the agent reported `filed` with no UoW) is surfaced via the
  // returned diagnostics — the caller warns the operator — and the invalid
  // artifact is NOT pinned. A clean result is pinned best-effort: a CAS write
  // failure must never break the agent run (return an empty ref then).
  const { diagnostics } = runArtifactContract(agentResultEdge, result);
  if (diagnostics.length > 0) {
    return { ref: "", result, diagnostics };
  }
  try {
    const { ref } = await emitArtifact(agentResultEdge, input.workspaceId, result);
    return { ref, result, diagnostics: [] };
  } catch {
    return { ref: "", result, diagnostics: [] };
  }
}

/**
 * One-line plain-mode rendering. Prefers the agent's reported disposition (the
 * existing-issue / reason the operator asked for); falls back to the bd-diff.
 * Never silent.
 */
export function renderAgentResult(result: AgentResult): string {
  const head = `prx ${result.actor} agent`;
  switch (result.disposition) {
    case "filed":
      return `${head}: filed ${result.uow ?? "(unknown)"}`;
    case "merged":
      return `${head}: merged into ${result.uow ?? "(unknown)"}${result.reason ? ` — ${result.reason}` : ""}`;
    case "duplicate":
      return `${head}: already tracked by ${result.uow ?? "(unknown)"}${result.reason ? ` — ${result.reason}` : ""}`;
    case "classified":
    case "promoted":
    case "deferred":
      return `${head}: ${result.disposition} ${result.uow ?? "(unknown)"}${result.reason ? ` — ${result.reason}` : ""}`;
    case "no_action":
      return `${head}: no action — ${result.reason ?? "nothing to do"}`;
    default:
      // No reported disposition — fall back to the bead diff.
      return result.uows.length > 0
        ? `${head}: created ${result.uows.join(", ")}`
        : `${head}: no result reported`;
  }
}

// ── plan-agent result (prx-j4a) ─────────────────────────────────────────────
//
// `prx plan agent` consumes a UoW (the bead / issue) and produces a plan
// artifact in the CAS draft slot. Its result is framed as input-artifact →
// output-artifact (the pipeline DAG model) and printed through the shared `emit`
// printer instead of a play-by-play of pipeline steps.
export const planAgentResultSchema = z.object({
  actor: z.literal("plan"),
  /** Input artifact: the UoW (bead / issue) the plan was drafted from. */
  unit: z.string().min(1),
  /** Where the UoW lives (e.g. `beads`, `github`) — omitted when unknown. */
  source: z.string().optional(),
  /** Output artifact: the CAS ref the plan draft landed at. */
  ref: z.string().min(1),
  /** Whether the draft passed the shape gate (else `prx implement` refuses). */
  validated: z.boolean(),
  /** Count of shape-gate diagnostics on the draft. */
  diagnostics: z.number().int(),
  /** The command to read the full plan. */
  view: z.string().optional(),
});
export type PlanAgentResult = z.infer<typeof planAgentResultSchema>;

/** One-line-plus input→output rendering for `prx plan agent`. */
export function renderPlanAgentResult(r: PlanAgentResult): string {
  const src = r.source ? ` (${r.source})` : "";
  const lines = [`plan: ${r.unit}${src} → ${r.ref}`];
  const diag =
    r.diagnostics > 0 ? ` (${r.diagnostics} diagnostic${r.diagnostics === 1 ? "" : "s"})` : "";
  lines.push(`  validated=${r.validated}${diag}`);
  if (!r.validated && r.view) {
    lines.push(`  view: ${r.view}`);
  }
  return lines.join("\n");
}

// ── reported-result file (the `prx <actor> result` tool ↔ the parent) ───────
//
// The agent reports its disposition by running `prx <actor> result …` (a plain
// CLI tool in its Bash allowlist — NOT an MCP server). That tool writes this
// file in the worktree; the parent reads it after the run. A file (not CAS)
// because the parent already holds the worktree path (spawnCwd), so no ref
// agreement is needed.
const REPORTED_RESULT_RELPATH = join(".prx", "run", "agent-result.json");

/** Path the `prx <actor> result` tool writes / the parent reads (in `cwd`). */
export function reportedResultPath(cwd: string): string {
  return join(cwd, REPORTED_RESULT_RELPATH);
}

/** Write the reported result (called by the `prx <actor> result` tool). */
export function writeReportedResult(cwd: string, reported: ReportedResult): void {
  const path = reportedResultPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reportedResultSchema.parse(reported)), "utf8");
}

/** Read the reported result if the agent wrote one (parent, post-run). */
export function readReportedResult(cwd: string): ReportedResult | undefined {
  const path = reportedResultPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    return reportedResultSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}
