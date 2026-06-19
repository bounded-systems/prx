import { processEnv } from "@bounded-systems/env";
import { SESSION_CONTEXTS, type SessionContext } from "../../machine/machines/session-entry.ts";

/**
 * GH-977: env-var carrier for the active session context.
 *
 * `sessionEntryMachine` runs in the parent `prx` process and immediately
 * `exec`s into Claude (the cli adapter consumes `RuntimeProfileProjection.env`
 * and merges it into the spawn env). When Claude itself shells out to
 * a fresh `prx <something>` invocation, the child must know which session
 * context it was launched into. The machine's state value is the contract;
 * this env var is the carrier.
 *
 * Mainx (`mainx`) is the default — when `prx` runs outside any launched
 * session, the env var is unset and `mainx` is the implied surface.
 */
export const PRX_SESSION_CONTEXT_ENV = "PRX_SESSION_CONTEXT";

export function getCurrentSessionContext(): SessionContext {
  const raw = processEnv()[PRX_SESSION_CONTEXT_ENV];
  if (typeof raw !== "string") return "mainx";
  for (const ctx of SESSION_CONTEXTS) {
    if (ctx === raw) return ctx;
  }
  return "mainx";
}
