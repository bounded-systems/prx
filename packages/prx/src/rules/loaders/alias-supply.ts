// GH-1423: stub loader for alias-supply.
//
// PR-1 leaves this as a typed `[]` returner so the renderer can be developed
// against a partial substrate. The real loader (follow-up) sources from a
// `nix/home-manager/...` zsh-aliases module that does not exist today — the
// drift case at `claude/rules/core.md:96` (`za` / `zb` / `zc`) is precisely
// the gap this loader will close.
//
// Returning `[]` is load-bearing: the `aliasExists` assertion (PR-1) walks
// every alias token inside `<!-- assert:alias -->` fences and red-tests
// each one against this empty set, producing exactly the
// `RULES_ASSERTION_FAILED` event the spike thesis predicts.

import { type AliasSupply, aliasSupplySchema } from "../schemas/inputs.ts";

export const ALIAS_SUPPLY_STUB_TICKET = "GH-1423/follow-up/alias-supply";

export function loadAliasSupplyStub(): AliasSupply {
  return aliasSupplySchema.parse([]);
}
