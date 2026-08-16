// Help-surface session-context seam (GH-976).
//
// GH-977 wired the session-entry XState machine and added the env-var carrier
// (`PRX_SESSION_CONTEXT`). GH-1172 promoted that carrier to the help surface
// so `prx --help`, `prx session statusline`, and the in-CLI refuse-from-wrong-
// mode guards all read the same source of truth. We delegate to the canonical
// env-aware helper rather than re-encoding the lookup here.

import type { SessionContext } from "../../cli/registry.ts";
import { getCurrentSessionContext as getCurrentSessionContextFromEnv } from "../session-entry/get-current-session-context.ts";

export function getCurrentSessionContext(): SessionContext {
  return getCurrentSessionContextFromEnv();
}
