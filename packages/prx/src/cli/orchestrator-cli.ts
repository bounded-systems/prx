/**
 * Bridge: the real `prx` CLI (`pr-state/cli.ts`) → the spec-driven verbs
 * (`verb-registry.ts`). The cli.ts execute handler delegates here for any verb
 * authored as a `VerbSpec`, running it through the canonical dispatch so the
 * command, its MCP tool, its OpenAPI op, and its plugin slash-command stay one
 * registry. Started with `pilot`/`fleet`; grows as scripts migrate (`health`, …).
 *
 * EXPERIMENTAL (pilot/fleet): without `PRX_PILOT_REAL` the pilot runs its stub (a
 * fast demo that prints a synthetic `merged`); the real path (headless subagents
 * + signed provenance + the dolt-backed pipeline) needs `PRX_PILOT_REAL=1` + a
 * live unit.
 */

import { dispatch, render } from "./verbspec.ts";
import { verbRegistry } from "./verb-registry.ts";

export async function runSpecVerb(
  verb: string,
  args: readonly string[],
  output: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    const res = await dispatch(verbRegistry, [verb, ...args]);
    output.log(res.kind === "help" ? res.text : render(res.output));
    return 0;
  } catch (e) {
    output.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
