// GH-1768 — provenance is a meta-feature, not a rule set.
//
// The engine (`engine.ts`) records derivations during evaluation; the
// `explain(provenance, goal)` helper walks them into a derivation
// tree. This module re-exports those facilities under the
// rules-directory naming convention and exposes no rule list of its
// own — the rule-set composition in `index.ts` skips it.
//
// Provenance is the deliverable PRX's imperative code does not give
// for free: today's `parity-disposition.ts` and `next_work.ts` return
// a label without citing the rule that produced it. The Datalog
// `explain()` output is the spike's positive-signal #3 demo.

export { explain, formatDerivationTree, type DerivationTree } from "../engine.ts";
