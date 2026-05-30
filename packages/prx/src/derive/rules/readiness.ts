// GH-1768 — readiness rules.
//
// Mirrors I-BD1 ("a unit surfaces in the ready_to_start thread only when
// bd.status='open' && bd.blocked_by ∩ {open units} == ∅") and the
// imperative `bd ready` closure consumed by `src/beads/ready.ts`.
//
// In Datalog this collapses to:
//   has_open_blocker(I)  :- blocked_by(I, J), issue(J, true, _)
//   ready(I)             :- issue(I, true, _), not has_open_blocker(I)
//
// The negation is stratified: `has_open_blocker` is fully derived in
// stratum 0; `ready` reads it in stratum 1.

import { atom, c, not, rule, v, type Rule } from "../engine.ts";

export const readinessRules: Rule[] = [
  rule(
    "has_open_blocker",
    atom("has_open_blocker", v("I")),
    [
      atom("blockedBy", v("I"), v("J")),
      atom("issue", v("J"), c(true), v("_jc")),
    ],
  ),
  rule(
    "ready",
    atom("ready", v("I")),
    [
      atom("issue", v("I"), c(true), v("_c")),
      not(atom("has_open_blocker", v("I"))),
    ],
  ),
];
