// GH-1768 — eligibility rules.
//
// Mirrors the imperative `runtime_profiles.ts` decision: which actor
// (planner / executor / tester / reviewer / doctor) is allowed to act
// on an issue at a given workflow phase, given the issue's blocker
// state. The synthetic input table `actorAllowedInPhase` is the spike's
// stand-in for `runtime_profiles.ts`'s per-phase actor allow-list; a
// follow-up ticket can promote it to the canonical source.
//
//   eligible(Actor, I)   :- phase(I, P),
//                            actorAllowedInPhase(Actor, P),
//                            issue(I, true, _),
//                            not has_open_blocker(I)
//
// `has_open_blocker` is reused from readiness.ts so the negation is
// stratified against an already-derived predicate.

import { atom, c, not, rule, v, type Rule } from "../engine.ts";

export const eligibilityRules: Rule[] = [
  rule(
    "eligible",
    atom("eligible", v("Actor"), v("I")),
    [
      atom("phase", v("I"), v("P")),
      atom("actorAllowedInPhase", v("Actor"), v("P")),
      atom("issue", v("I"), c(true), v("_c")),
      not(atom("has_open_blocker", v("I"))),
    ],
  ),
];
