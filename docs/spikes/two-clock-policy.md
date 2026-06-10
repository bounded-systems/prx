# Two-clock policy — Netflix's slow-planner / fast-executor split, mapped to prx (spike)

> Design-only spike. Reads Netflix's *Thinking Fast & Slow for a Personalized
> Notification System* (Netflix Tech Blog) as a **general systems pattern** —
> separate strategy from action across two timescales — and tests it against
> prx's capability architecture. No `src/`/`packages/` changes in this unit —
> the **diagnosis and the one additive idea are the deliverable**. Written
> 2026-06-09. Companion to `agentic-causal-inference.md`.

## 0. Status

**Exploratory — no decision forced.** Finding: prx already has the *spatial*
half of Netflix's split (policy never touches Git; execution never invents
policy — the capability-poor-orchestrator rule). What it lacks is the *temporal*
half: nothing runs on a **longer cadence** that tunes the guardrails from
accumulated outcomes. The article's real novelty is two clocks, not two boxes.
The additive idea (§4) is a **slow policy loop — "earned autonomy"** — that
adjusts trust/budget/approval per `actor·repo` from track record. This spike
records the gap and the shape; it does not propose building the loop.

## 1. The pattern, stripped of notifications

Netflix split one model that answered two questions into two systems on two
clocks:

| | **Slow policy** | **Fast policy** |
|---|---|---|
| Question | *How often should we contact this member?* | *Should I send now, and what?* |
| Cadence | weekly | continuous |
| Optimizes | long-term utility (engagement **vs.** fatigue/opt-out) | the local decision, **inside** the slow loop's guardrails |
| Output | frequency/pacing/budget per member | one message, or none |

The trap they escaped: a single model maximizing *today's* click also maximizes
*notification fatigue*, so local optimization quietly degrades the long-term
objective. The fix is not a better model — it is **refusing to answer "what is
my long-term strategy?" and "what do I do in the next 100ms?" with the same
component.** That is mechanism-vs-policy separation given a *time* axis.

The pattern recurs: route planner → steering controller; k8s scheduler →
container runtime; agent planner → tool executor. Strategy thinks in the large;
action thinks in the small.

## 2. prx already has the spatial split

The Policy → Transition → Execution layering *is* prx's spine — the
capability-poor orchestrator owns no privileged tool and can only delegate:

| Layer | prx packages | Invariant |
|-------|--------------|-----------|
| **Policy** (strategy) | `@bounded-systems/policy`, `auth`, `audit-context` | decides allowlists / trust / attestation — owns no privileged tool |
| **Transition** (decision) | `machine-schema` (state/phase/handoff), `anchored-chain`, `disposition` | create/approve/reject a transition; emits signed derivations |
| **Execution** (action) | the seams: `git`, `fs`, `proc`, `env`, `host` | performs effects — never invents policy |

"Execution never invents policy; policy never touches Git" is the
sanctioned-access-point rule, enforced — not a convention. So the *separation of
concerns* half of the Netflix split is not an aspiration for prx; it is the
existing design.

## 3. …but only the spatial split

The half prx does **not** have is the one that makes the article interesting:
**two clocks.**

- prx's policy is **static and synchronous** — a declarative allowlist enforced
  on *every* call, in the *same tick* as the action it gates. There is no
  longer-cadence component.
- `@bounded-systems/github-budget` is the nearest guardrail-setter, but it is a
  *fast* gate (pre-call rate-limit gating + bucket classification), not a *slow*
  optimizer. It throttles within the tick; it does not learn across weeks.
- Nothing reads the audit trail on a long cadence to **adjust** the guardrails.

So prx maps cleanly onto Netflix's *fast* policy (decide-and-act inside fixed
guardrails) and has **no** analogue of the *slow* policy (set the guardrails by
optimizing long-horizon utility). The strategy is currently *authored by a
human in config*, not *optimized by a loop from feedback*.

## 4. The additive idea — a slow policy loop ("earned autonomy")

The transferable lesson is a component on prx's *weekly* clock that tunes the
guardrails per `actor · repo · state` from track record:

| Netflix (notifications) | prx (capabilities) |
|---|---|
| long-term engagement | sustained operator trust / merge-without-revert rate |
| fatigue, opt-out risk | revert risk, failed/again-required attestations, operator overrides |
| messaging budget (pushes/emails per week) | capability scope (allowlist width, approval-gate count, GH budget) |
| per-member frequency policy | per-`actor·repo` trust policy |

Concretely: an actor with a long history of clean, attested, un-reverted
transitions earns a **wider allowlist, fewer approval gates, a larger budget**;
an actor (or repo) with recent reverts or attestation failures gets its **trust
boundary tightened and review re-mandated.** That is exactly "optimize long-term
utility, balancing against fatigue/opt-out" — with *operator trust* as the
utility and *capability scope* as the budget.

The substrate already exists: `audit-context` + `anchored-chain` lineage **are**
the feedback signal a slow loop would consume. What's missing is (a) a
longer-cadence reader of that signal, and (b) `policy` accepting a *derived*
(not just authored) guardrail as input. Today the signal is written and never
read on a strategy clock.

## 5. The deepest takeaway, for prx specifically

Systems get brittle when one component answers both *"what is my long-term
strategy?"* and *"what do I do in the next 100ms?"*. prx avoided that **spatially**
from day one — that is the whole capability-seam discipline. The Netflix article
is the reminder that the same conflation can hide on the **time** axis: a static,
human-authored policy is the *fast* answer wearing the strategy layer's clothes.
A real slow loop would let prx's guardrails *move* in response to evidence —
which is the difference between a permission system and a **trust** system.

## 6. Recommendation

- **Adopt the framing, not (yet) the loop.** Name the two clocks explicitly in
  prx's mental model: `policy` is the *fast* guardrail today; "earned autonomy"
  would be the *slow* one. Keeping them named-but-distinct prevents the
  conflation the article warns about.
- **Make the trust signal legible first.** Before any optimizer, expose a
  per-`actor·repo` rollup over the existing `anchored-chain`/`audit-context`
  history (clean-merge rate, revert rate, attestation-failure rate). The slow
  loop is premature; the *read path* for its input is not.
- **Keep `policy` able to accept a derived guardrail.** Ensure the policy engine
  can take a guardrail value that was *computed* (from the rollup) and not only
  *authored* — the seam that would later let a slow loop write to it.

What prx should **not** do: bolt an online optimizer onto the per-call path
(that recreates the conflation), or let a slow loop bypass attestation — the
slow policy sets *budgets*, it never performs effects.

## 7. Non-goals & open questions

- **Non-goal:** implementing the slow loop / earned-autonomy optimizer. This
  spike argues the *separation exists spatially but not temporally* and names
  the additive shape; building it is a separate epic.
- **Open:** is "earned autonomy" a new package, or a slow driver over `policy` +
  `audit-context`? (Likely the latter — it owns no effect.)
- **Open:** what is the trust utility's exact form (clean-merge rate? a decayed
  reputation? operator-override count as the "opt-out" signal?), and on what
  cadence does it recompute?
- **Tension:** a moving guardrail must stay auditable — a transition's
  authorization has to record *which* guardrail value was in force, so the slow
  loop's outputs are themselves derivations on the chain, not hidden state.
