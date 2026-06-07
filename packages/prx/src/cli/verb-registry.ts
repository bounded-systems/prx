// The spec-driven slice of the prx CLI: the `VerbSpec` registry the early
// dispatch in pr-state/cli.ts routes to, ahead of the legacy handler union. It
// grows as scripts/handlers migrate to VerbSpecs ("scripts → prx verbs") — each
// added here is one verb, one Zod schema, projected to CLI / MCP / OpenAPI.

import type { Registry } from "./verbspec.ts";
import { orchestratorRegistry } from "./pilot-verbs.ts";
import { healthVerb } from "../health/verb.ts";
import { docsVerb } from "../docs/verb.ts";
import { schemasVerb } from "../schemas/verb.ts";
import { featuresVerb } from "../features/verb.ts";
import { graphVerb } from "../pr-state/graph-verb.ts";
import { actorsVerb, modelVerb } from "../pr-state/model-verb.ts";

export const verbRegistry: Registry = {
  ...orchestratorRegistry,
  [healthVerb.id]: healthVerb,
  [docsVerb.id]: docsVerb,
  [schemasVerb.id]: schemasVerb,
  [featuresVerb.id]: featuresVerb,
  [graphVerb.id]: graphVerb,
  [actorsVerb.id]: actorsVerb,
  [modelVerb.id]: modelVerb,
};
