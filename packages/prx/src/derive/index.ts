// GH-1768 — public API for the Datalog-as-derived-truth spike.
//
// `projectFacts` is the trust boundary; rules and the engine consume
// only validated `Fact[]` tuples. Callers get back a `DerivedView`
// holding the evaluated `FactSet`, the provenance map, and a thin
// query surface.

import {
  evaluate,
  explain,
  type DerivationTree,
  type Fact,
  type FactSet,
  type Provenance,
  type Rule,
} from "./engine.ts";
import { projectFacts, type ProjectInput } from "./project.ts";
import { readinessRules } from "./rules/readiness.ts";
import { driftRules } from "./rules/drift.ts";
import { eligibilityRules } from "./rules/eligibility.ts";
import { cacheScopeRules } from "./rules/cache_scope.ts";

export type DerivedView = {
  facts: FactSet;
  provenance: Provenance;
  rounds: number;
};

export const allRules: Rule[] = [
  ...readinessRules,
  ...driftRules,
  ...eligibilityRules,
  ...cacheScopeRules,
];

export function projectAndRun(
  input: ProjectInput,
  options: { rules?: Rule[] } = {},
): { edb: Fact[]; view: DerivedView } {
  const edb = projectFacts(input);
  const view = evaluate(options.rules ?? allRules, edb);
  return { edb, view };
}

export type ReadyRow = { issueId: string };
export function queryReady(view: DerivedView): ReadyRow[] {
  return view.facts.get("ready").map((f) => ({ issueId: String(f.args[0]) }));
}

export type DriftRow = { issueId: string; code: string };
export function queryDrift(view: DerivedView): DriftRow[] {
  return view.facts
    .get("drift")
    .map((f) => ({ issueId: String(f.args[0]), code: String(f.args[1]) }))
    .sort((a, b) => (a.issueId + a.code).localeCompare(b.issueId + b.code));
}

export type EligibleRow = { actor: string; issueId: string };
export function queryEligible(view: DerivedView, issueId?: string): EligibleRow[] {
  return view.facts
    .get("eligible")
    .map((f) => ({ actor: String(f.args[0]), issueId: String(f.args[1]) }))
    .filter((r) => issueId === undefined || r.issueId === issueId)
    .sort((a, b) => (a.issueId + a.actor).localeCompare(b.issueId + b.actor));
}

export function queryWhy(view: DerivedView, goal: Fact): DerivationTree | null {
  return explain(view.provenance, goal);
}

export {
  evaluate,
  explain,
  projectFacts,
  type DerivationTree,
  type Fact,
  type FactSet,
  type ProjectInput,
  type Provenance,
  type Rule,
};
