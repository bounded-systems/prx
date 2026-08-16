// `prx --help` overview renderer (GH-976).
//
// Pure projection over the registry: filter promoted entries for the current
// session context, render under fixed-width alignment. Cap of 6 (§6.2) is
// enforced by `test/pr-state/registry.test.ts`; this layer trusts a valid
// registry.

import type { CommandSpec, SessionContext } from "../../cli/registry.ts";
import { FooterPointers, Identity, PromotedList, SessionContextLine } from "./components.ts";

export function HelpOverview(registry: CommandSpec[], ctx: SessionContext): string {
  const promoted = registry.filter((c) => c.promoted_in.includes(ctx) && !c.deprecation);
  return [
    Identity(),
    SessionContextLine(ctx),
    "Primary workflow:\n" + PromotedList(promoted),
    FooterPointers("overview"),
  ].join("\n\n");
}
