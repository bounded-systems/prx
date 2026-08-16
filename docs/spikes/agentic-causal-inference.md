# Agentic causal inference — Netflix's human-augmenting OCI workflow, mapped to prx (spike)

> Design-only spike. Reads Netflix's *A Human-Augmenting Agentic Workflow for
> Causal Inference* (Chou, Alexandre, Olds, Zhang, Hagemann, Kallus — Netflix
> Tech Blog) and maps its workflow onto prx's existing primitives. No
> `src/`/`packages/` changes in this unit — the **mapping and the resulting
> recommendation are the deliverable**. Written 2026-06-09. Branch
> `claude/agentic-causal-inference-rr8atj`.

## 0. Status

**Exploratory — no decision forced.** The finding is that prx and the Netflix
workflow are *the same shape*: an actor-critic loop over a human "principal,"
where validity is established by **auditing the process, not the outcome**.
prx already pays for that shape (`anchored-chain`, `ci-as-derivation`,
`disposition`). The one thing prx lacks a first-class name for is the
**Critic** persona. The recommendation (§6) is to name it — not to build a
causal-inference engine into prx.

This is a pattern-mapping spike, not an `oci-agent`-on-prx implementation
proposal. That concrete sketch is called out as a non-goal in §7.

## 1. The source, in one paragraph

Observational Causal Inference (OCI) under unconfoundedness is judgment-heavy
and has **no ground truth** outside simulated data — you cannot eval an agent's
answer against a known truth. Netflix's response is a workflow with three
personas (Principal / Actor / Critic), a fixed suite of **design diagnostics**
(covariate balance, overlap, placebo outcome, sensitivity to hidden
confounders), a **remediation playbook** (e.g. Crump trimming when overlap
fails), and — the load-bearing idea — **process audits**: agents emit
version-controlled, re-executable artifacts (plans, specs, notebooks, plots) so
a human audits *how* the answer was produced, not just *what* it is. Their evals
on the 2016 ACIC datasets show the scaffolding is what makes the LLM useful, and
that the Critic's diagnostic-driven grade separates reliable estimates from
unreliable ones.

The open-source [`oci-agent`](https://github.com/Netflix-Skunkworks/oci-agent)
makes the workflow concrete, and the structure is what matters here. The loop is
explicit — `plan → actor.draft → spec → nb_runner → results.json →
critic.evaluate → oci_report.md`, with `actor.revise ← critique.json` closing
it — and each persona is a module (`actor.py`, `critic.py`, `nb_runner.py`). Two
details sharpen the mapping below: (1) the **Critic's verdict is graded, not
binary** — `fully_satisfactory` / `satisfactory_with_caveats` /
`not_satisfactory`; and (2) the **scaffolding is runtime-loaded markdown
"skills"** (`writing-specs`, `running-notebooks`, `suggesting-remedies`, …), not
hard-coded logic. The eval punchline: the scaffolded loop reaches mean |error|
**0.054** vs **2.572** (~48×) for a single unscaffolded model call on the same
plan — the scaffolding, not the model, is the product.

## 2. The three personas map straight onto prx's role model

| Netflix persona | Responsibility | prx equivalent |
|-----------------|----------------|----------------|
| **Principal** (human) | Frames the question, names the threats/confounders, picks the tools and data, audits artifacts | the human operator; the `planner`/`Plan` tier writes the plan, the operator approves |
| **Actor** (software) | Refines plan → spec, uses *only* provided tools, runs the core analysis **plus** all four diagnostics, emits checkable artifacts, reports remediations | `executor` actor under `@bounded-systems/policy` (subcommand allowlists by tool/state/role) + capability seams (`fs`/`proc`/`env`) |
| **Critic** (`critic.py`) | Synthesizes results, checks plan↔spec↔execution alignment, assigns a graded **verdict** (`fully_satisfactory`/`satisfactory_with_caveats`/`not_satisfactory`), flags how the estimand differs from the target, suggests alternatives | `reviewer` + `@bounded-systems/disposition` (the pure `ok/prune/repair/review` classifier) — but prx has no persona *named* "critic" (§6) |

The "Actor uses only the tools the Principal provided" rule is exactly prx's
policy engine: an allowlist of subcommands by tool, state, and role. Netflix
enforces it by convention in a prompt; prx enforces it with
`@bounded-systems/policy` + the capability seams. **prx's enforcement is
strictly stronger** — it is the sanctioned-access-point discipline, not a
prompt instruction.

## 3. The load-bearing idea is one prx already bet on

Netflix's core principle:

> *Without discounting the need for evals … one of our key principles is to
> augment human evaluation by making each analytic step as transparent as
> possible … In the absence of ground truth, we rely on these "process audits"
> — coupled with human oversight — to build good agents.*

This is the **same bet** `docs/prx/ci-as-derivation.md` (GH-352) makes for CI:
a green run is not a trusted boolean, it is a **content-addressed, signed
derivation** recording *which tree-state* was validated, *by whom*, and
*whether the result still holds*. Netflix audits the process because there is
no ground truth; prx records the process as a derivation because *"CI was
green" on faith is not an artifact*. Same disease, same cure.

The substrate is already present:

- **Re-executable, version-controlled artifacts** → `@bounded-systems/cas`
  (bytes addressed by SHA-256) is the "file store" Netflix uploads executed
  notebooks to; `@bounded-systems/scout` gives content-addressed surface reads
  **with `anchored-chain` provenance** — i.e. an artifact you can re-fetch *and*
  prove the lineage of.
- **Lineage / staleness / invalidation** → `@bounded-systems/anchored-chain`
  already distinguishes "the chain" (content-addressed lineage edges,
  `isStale`/`invalidate`) from bare vouchers. A diagnostic result *is* a
  derivation over a tree-state; when the inputs move, it goes stale — which is
  precisely the "keep track of multiple iterations" toil Netflix calls out.

## 4. Pattern-by-pattern

| Netflix pattern | prx primitive | Gap? |
|-----------------|---------------|------|
| Actor-critic loop over a human principal | actor subagents + `capability-orchestrator` | none — orchestrator owns no privileged tool |
| Process audits over outcome evals | `ci-as-derivation`, `anchored-chain` | none conceptually; not yet generalized past CI |
| Critic grades a **3-level verdict** (`fully`/`with-caveats`/`not` satisfactory) | `@bounded-systems/disposition` (`ok/prune/repair/review`) | the *graded axis* exists; the caveats-tier maps cleanly to `review` (see §6/§7) |
| Scaffolding as **runtime-loaded markdown skills** (`writing-specs`, `suggesting-remedies`, …) | prx's Skill mechanism (skills loaded by name, e.g. the `prx` work-unit skill) | none — both load prose playbooks at runtime rather than hard-coding them |
| Diagnostics as gates | `prx ci` phases / `checking` gate (`pipeline-local-checks.md`) | gates are pass/fail, not a *suite of named diagnostics* with per-check artifacts |
| Remediation playbook (Crump trimming → record it) | `repair` disposition + actor remediation loop | none; prx already requires remediations be recorded |
| Tools restricted to what the principal allowed | `@bounded-systems/policy` allowlists | none — stronger than the source |
| Re-executable artifacts in a file store | `cas` + `scout` | none |
| Scaffolding so agents follow best practice *by design* | capability seams + templated pipeline phases | none — this *is* prx's thesis |

The table's "Gap?" column is the actual yield of the spike: the conceptual
machinery is all present; the gaps are **naming and generality**, not missing
infrastructure.

## 5. The one genuinely new idea

prx drives a **PR / code work-unit** through plan → implement → submit. The
Netflix piece is the proof that the *same machine* drives a **judgment-heavy
analytical investigation**: the Principal frames the question and audits, the
Actor runs the exacting, repetitive diagnostics, the Critic grades credibility.
"Investigation-as-work-unit" is a real generalization of prx's surface — the
handoff envelope (`@bounded-systems/machine-schema`) and disposition classifier
do not care whether the unit's deliverable is a merged PR or a credibility-graded
estimate. **This spike does not propose building it** (§7); it records that the
abstraction would carry.

## 6. Recommendation

Adopt the **vocabulary and the framing**, not a causal-inference engine:

1. **Name the Critic persona.** prx has `reviewer` (gh PR review) and
   `disposition` (the classifier), but no persona whose job is *synthesize +
   grade credibility + flag estimand drift + propose alternatives*. Netflix
   shows the Critic is distinct from the Actor and is where most of the
   no-ground-truth value lives. Worth a follow-up to decide whether `reviewer`
   *is* the Critic or whether the Critic is a thinner, disposition-driven role.
2. **Generalize "process audit" past CI.** `ci-as-derivation` proves the
   pattern for one phase. The transferable rule — *every gate emits a
   content-addressed, re-executable artifact, and the merge/accept decision
   reads artifacts, not booleans* — should be the default for new gates, not a
   CI special case.
3. **Treat a diagnostic suite as a first-class shape.** Netflix's four
   diagnostics + remediation playbook is a reusable template: a named set of
   checks, each emitting an artifact, each with a recorded remediation on
   failure. prx's gates are currently pass/fail; a "diagnostic suite" with
   per-check provenance is the richer form. `oci-agent` ships these as
   runtime-loaded markdown skills — the same shape as prx's Skill mechanism, so
   the template can be *authored as a skill*, not built into the CLI.

What prx should **not** do: pull statistics/`EconML`/notebook execution into the
CLI, or take a dependency on `oci-agent`. The value here is structural.

## 7. Non-goals & open questions

- **Non-goal:** an `oci-agent`-on-prx implementation (causal-inference work-unit
  type with diagnostics as signed derivations). It is a coherent sketch and a
  plausible *demonstrator* of "investigation-as-work-unit," but it is a separate
  unit and was explicitly scoped out of this spike.
- **Open:** is the Critic a rename of `reviewer`, or a new disposition-driven
  role? (Recommendation §1 defers this.)
- **Mostly settled:** the graded "credibility level" maps onto `disposition`'s
  existing axis — `oci-agent`'s `fully_satisfactory`/`satisfactory_with_caveats`/
  `not_satisfactory` is `ok` / `review` / `repair`. The residual question is
  only whether the caveat text rides on the derivation or on the disposition.
- **Source:** the standalone [`oci-agent`](https://github.com/Netflix-Skunkworks/oci-agent)
  (`actor.py`/`critic.py`/`nb_runner.py`, EconML DRLearner backend, ACIC-2016
  smoketest + scaffolded-vs-baseline evals) is the reference if the §5
  demonstrator is ever pursued — but it is research code (no PRs, no maintenance
  commitment, single hard-coded notebook), so it is a *shape* to copy, not a
  dependency to take.
