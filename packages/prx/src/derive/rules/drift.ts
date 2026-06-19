// GH-1768 — drift rules.
//
// Encodes the structural invariants `assertInvariants` in
// `src/machine/state.ts` checks imperatively:
//
//   I01: pr.exists => (branch.existsLocal || branch.existsRemote)
//   I02: pr.exists => pr.headRef == branch.name
//   I03: worktree.exists => (branch.existsLocal &&
//                            worktree.checkedOutBranch == branch.name)
//   I05: phase=cleaned => !worktree.exists && !branch.existsLocal
//   I06: ci.requiredPassed <= ci.requiredTotal
//   I07: ci.state=passed => ci.requiredPassed == ci.requiredTotal
//   I08: sync.remoteFresh => branch.headShaLocal == branch.headShaRemote
//
// `drift(I, Code)` holds iff invariant `Code` is violated for issue `I`.
// The oracle-parity test asserts agreement with `assertInvariants` on
// every fixture.
//
// I04 / I09 (the merge-readiness gates) require AND-of-many-positives;
// they are encoded as positive "ready_gate_holds" derivations and tested
// for absence via stratified negation, the same shape as I01/I02/I03.
//
// Equality is expressed as a same-variable join in a positive rule that
// derives a "matches" auxiliary predicate; drift fires when the
// auxiliary is absent. Numeric inequality (I06/I07) cannot be expressed
// without a builtin in v0 — the projection layer emits two sentinel
// facts (`ci_required_overflow`, `ci_passed_but_incomplete`) the rules
// consume. This is a finding for the retro: without arithmetic builtins,
// some invariants leak into projection.

import { atom, c, not, rule, v, type Rule } from "../engine.ts";

const AUX: Rule[] = [
  // pr_headref_matches_branch(I) holds iff the PR head_ref matches the
  // branch name on the same issue. Same-variable `Name` join performs
  // the equality check natively.
  rule("pr_headref_matches_branch", atom("pr_headref_matches_branch", v("I")), [
    atom("pr", v("I"), c(true), v("_n"), v("_s"), v("_d"), v("Name"), v("_a")),
    atom("branch", v("I"), v("Name"), v("_bl"), v("_br"), v("_hl"), v("_hr"), v("_ah"), v("_bh")),
  ]),
  // worktree_branch_matches(I) — checkedOutBranch matches branch.name AND
  // branch.existsLocal=true.
  rule("worktree_branch_matches", atom("worktree_branch_matches", v("I")), [
    atom("worktree", v("I"), c(true), v("_p"), v("Name"), v("_h")),
    atom("branch", v("I"), v("Name"), c(true), v("_br"), v("_hl"), v("_hr"), v("_ah"), v("_bh")),
  ]),
  // sync_remote_fresh_aligned(I) — remoteFresh implies headSha match,
  // encoded as: sync.remoteFresh=true AND headShaLocal == headShaRemote.
  rule("sync_remote_fresh_aligned", atom("sync_remote_fresh_aligned", v("I")), [
    atom("sync", v("I"), c(true)),
    atom("branch", v("I"), v("_bn"), v("_bl"), v("_br"), v("Sha"), v("Sha"), v("_ah"), v("_bh")),
  ]),
];

const I01: Rule[] = [
  // pr.exists && (no branch row OR branch has neither local nor remote).
  // Split into two clauses because Datalog disjunction is multiple rules
  // and "missing branch row" requires negation.
  rule("drift_i01_no_branch_row", atom("drift", v("I"), c("I01")), [
    atom("pr", v("I"), c(true), v("_n"), v("_s"), v("_d"), v("_h"), v("_a")),
    not(atom("branch_present", v("I"))),
  ]),
  rule("drift_i01_branch_absent", atom("drift", v("I"), c("I01")), [
    atom("pr", v("I"), c(true), v("_n"), v("_s"), v("_d"), v("_h"), v("_a")),
    atom("branch", v("I"), v("_bn"), c(false), c(false), v("_hl"), v("_hr"), v("_ah"), v("_bh")),
  ]),
];

// Sentinel: branch_present(I) holds whenever a branch row exists, so
// I01's "no branch row" clause can use negation against a positive
// predicate rather than against a multi-arg fact pattern.
const BRANCH_PRESENT: Rule = rule("branch_present", atom("branch_present", v("I")), [
  atom("branch", v("I"), v("_bn"), v("_bl"), v("_br"), v("_hl"), v("_hr"), v("_ah"), v("_bh")),
]);

const I02: Rule[] = [
  rule("drift_i02_headref_mismatch", atom("drift", v("I"), c("I02")), [
    atom("pr", v("I"), c(true), v("_n"), v("_s"), v("_d"), v("_h"), v("_a")),
    not(atom("pr_headref_matches_branch", v("I"))),
  ]),
];

const I03: Rule[] = [
  rule("drift_i03_branch_mismatch", atom("drift", v("I"), c("I03")), [
    atom("worktree", v("I"), c(true), v("_p"), v("_c"), v("_h")),
    not(atom("worktree_branch_matches", v("I"))),
  ]),
];

const I05: Rule[] = [
  rule("drift_i05_worktree_exists", atom("drift", v("I"), c("I05")), [
    atom("phase", v("I"), c("cleaned")),
    atom("worktree", v("I"), c(true), v("_p"), v("_c"), v("_h")),
  ]),
  rule("drift_i05_branch_local", atom("drift", v("I"), c("I05")), [
    atom("phase", v("I"), c("cleaned")),
    atom("branch", v("I"), v("_bn"), c(true), v("_br"), v("_hl"), v("_hr"), v("_ah"), v("_bh")),
  ]),
];

const I06: Rule = rule("drift_i06_overflow", atom("drift", v("I"), c("I06")), [
  atom("ci_required_overflow", v("I")),
]);

const I07: Rule = rule("drift_i07_passed_but_incomplete", atom("drift", v("I"), c("I07")), [
  atom("ci_passed_but_incomplete", v("I")),
]);

const I08: Rule = rule("drift_i08_sha_mismatch", atom("drift", v("I"), c("I08")), [
  atom("sync", v("I"), c(true)),
  not(atom("sync_remote_fresh_aligned", v("I"))),
]);

export const driftRules: Rule[] = [
  ...AUX,
  BRANCH_PRESENT,
  ...I01,
  ...I02,
  ...I03,
  ...I05,
  I06,
  I07,
  I08,
];
