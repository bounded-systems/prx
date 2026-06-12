// `prx health` authored as a spec-driven VerbSpec — the template for migrating
// `scripts/*.ts` into first-class, projectable verbs (the "scripts → prx verbs"
// backlog item). One Zod schema, projected to CLI / MCP / OpenAPI by @bounded-systems/verbspec;
// `run` calls the shared `computeHealthReport()` so `prx health` and `bun run
// health --json` emit the identical structured report. The input is empty (the
// scan takes no flags); the output IS the CodeHealthReport schema — a verb whose
// output contract is reused verbatim from the model is exactly the convergence
// the VerbSpec coverage lens is pushing toward.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { CodeHealthReport } from "./model.ts";
import { computeHealthReport } from "./report.ts";

export const healthVerb = defineVerb({
  id: "health",
  summary: "Report code sprawl, coupling, dead code, and spec-driven-CLI readiness.",
  actor: "work",
  input: z.object({}),
  output: CodeHealthReport,
  run: () => computeHealthReport(),
});
