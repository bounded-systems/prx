// GH-1423: wired loader — projects the verb-supply from `prxCommandRegistry`.
//
// This is the only input loader PR-1 ships in real form. It reads directly
// from `src/cli/registry.data.ts` (no I/O, no parse-from-source) so the
// renderer's claim "every backticked `prx <verb>` resolves" is anchored to
// the same registry the dispatcher reads at runtime.

import { prxCommandRegistry } from "../../cli/registry.data.ts";
import {
  type VerbSupply,
  verbSupplySchema,
} from "../schemas/inputs.ts";

export function loadVerbSupply(): VerbSupply {
  const entries = prxCommandRegistry.map((spec) => ({
    name: spec.name,
    parent: spec.parent,
    actor: spec.actor,
  }));
  return verbSupplySchema.parse(entries);
}
