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
import { skillsVerb } from "../pr-state/skills-verb.ts";
import { openModeVerb } from "../pr-state/open-mode-verb.ts";
import { statelyVerb } from "../pr-state/stately-verb.ts";
import { overviewVerb } from "../pr-state/overview-verb.ts";
import { worktreeVerb, worktreesVerb } from "../pr-state/worktree-verb.ts";
import { statusVerb } from "../pr-state/status-verb.ts";
import { transitionVerb } from "../pr-state/transition-verb.ts";
import { planCloseVerb } from "../pr-state/plan-close-verb.ts";
import { remoteCiCheckVerb, scoutLogsVerb } from "../pr-state/ci-check-verb.ts";
import { repoChecksVerb } from "../pr-state/repo-checks-verb.ts";
import { protectMainVerb } from "../pr-state/protect-main-verb.ts";
import { prCommentsVerb } from "../pr-state/pr-comments-verb.ts";
import { eventVerb } from "../pr-state/event-verb.ts";
import { contractVerb } from "../pr-state/contract-verb.ts";

export const verbRegistry: Registry = {
  ...orchestratorRegistry,
  [healthVerb.id]: healthVerb,
  [docsVerb.id]: docsVerb,
  [schemasVerb.id]: schemasVerb,
  [featuresVerb.id]: featuresVerb,
  [graphVerb.id]: graphVerb,
  [actorsVerb.id]: actorsVerb,
  [modelVerb.id]: modelVerb,
  [skillsVerb.id]: skillsVerb,
  [openModeVerb.id]: openModeVerb,
  [statelyVerb.id]: statelyVerb,
  [overviewVerb.id]: overviewVerb,
  [worktreeVerb.id]: worktreeVerb,
  [worktreesVerb.id]: worktreesVerb,
  [statusVerb.id]: statusVerb,
  [transitionVerb.id]: transitionVerb,
  [planCloseVerb.id]: planCloseVerb,
  [remoteCiCheckVerb.id]: remoteCiCheckVerb,
  [scoutLogsVerb.id]: scoutLogsVerb,
  [repoChecksVerb.id]: repoChecksVerb,
  [protectMainVerb.id]: protectMainVerb,
  [prCommentsVerb.id]: prCommentsVerb,
  [eventVerb.id]: eventVerb,
  [contractVerb.id]: contractVerb,
};
