// GH-1768 — cache-scope rules (speculative).
//
// Demonstrates the rule shape future cache-invalidation work could
// adopt. The spike does NOT project real change-tree facts; the rule
// fires only when the caller supplies synthetic `scopeOwns` /
// `changedTree` tuples via `SyntheticInputs`. Retro-anchor: "the cost
// of a hypothetical rule vs the cost of writing the imperative cache
// invalidator."
//
//   affected(Scope, Sha) :- changedTree(Sha, Tree), scopeOwns(Scope, Tree)

import { atom, rule, v, type Rule } from "../engine.ts";

export const cacheScopeRules: Rule[] = [
  rule(
    "affected",
    atom("affected", v("Scope"), v("Sha")),
    [
      atom("changedTree", v("Sha"), v("Tree")),
      atom("scopeOwns", v("Scope"), v("Tree")),
    ],
  ),
];
