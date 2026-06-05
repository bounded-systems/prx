/**
 * Bridge: the real `prx` CLI (`pr-state/cli.ts`) → the spec-driven orchestrator
 * verbs (`pilot` / `fleet`). The cli.ts execute handler delegates here, and this
 * runs the verb through the canonical `VerbSpec` dispatch so the command, its
 * MCP tool, its OpenAPI op, and its plugin slash-command stay one registry.
 *
 * EXPERIMENTAL: without `PRX_PILOT_REAL` the pilot runs its stub (a fast demo
 * that prints a synthetic `merged`); the real path (headless subagents + signed
 * provenance + the dolt-backed pipeline) needs `PRX_PILOT_REAL=1` + a live unit.
 */

import { dispatch, render } from "./verbspec.ts";
import { orchestratorRegistry } from "./pilot-verbs.ts";

export async function runOrchestratorVerb(
  verb: "pilot" | "fleet",
  args: readonly string[],
  output: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    const res = await dispatch(orchestratorRegistry, [verb, ...args]);
    output.log(res.kind === "help" ? res.text : render(res.output));
    return 0;
  } catch (e) {
    output.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
