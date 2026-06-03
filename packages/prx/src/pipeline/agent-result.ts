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
import { spawnSync } from "node:child_process";

import { z } from "zod";

import { type ArtifactEdge, defineEdge, emitArtifact } from "./edge.ts";

export const agentResultSchema = z.object({
  /** The producing actor (intake, triage, …). */
  actor: z.string().min(1),
  /** The agent process exit status (0 = ok). */
  status: z.number().int(),
  /** UoW(s) the run produced — bead ids created during it. */
  uows: z.array(z.string()),
  /** Short human summary (the agent's final result text, truncated). */
  summary: z.string(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

/** The result edge: an agent pins its outcome for the operator to read. */
const agentResultEdge: ArtifactEdge<AgentResult> = defineEdge({
  kind: "agent_result",
  slot: "latest",
  source: "agent",
  target: "operator",
  schema: agentResultSchema,
});

/** Injected bead-id reader (the impure `bd list`); overridable in tests. */
export type BeadIdReader = (cwd: string) => string[];

const defaultBeadIdReader: BeadIdReader = (cwd) => {
  const r = spawnSync("bd", ["list", "--json"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<{ id?: unknown }>;
    return rows
      .map((x) => x?.id)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
};

/** Snapshot the bead-id set — call before AND after the run to diff UoWs. */
export function snapshotBeadIds(
  cwd: string,
  read: BeadIdReader = defaultBeadIdReader,
): Set<string> {
  return new Set(read(cwd));
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
}): Promise<{ ref: string; result: AgentResult }> {
  const uows = [...input.after].filter((id) => !input.before.has(id)).sort();
  const result: AgentResult = {
    actor: input.actor,
    status: input.status,
    uows,
    summary: summarizeAgentStdout(input.stdout),
  };
  const { ref } = await emitArtifact(agentResultEdge, input.workspaceId, result);
  return { ref, result };
}

/** One-line plain-mode rendering: the UoW + the CAS ref. Never silent. */
export function renderAgentResult(ref: string, result: AgentResult): string {
  const uow =
    result.uows.length > 0 ? `UoW: ${result.uows.join(", ")}` : "no new UoW";
  return `prx ${result.actor} agent → ${uow} · result ${ref}`;
}
