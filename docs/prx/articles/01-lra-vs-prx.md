# Durable agents, two ways — and the half that's still missing

> Draft (Article #1 of the prx portfolio set, bead prx-5jk). **lra specifics
> below trace to a prior reading of the lra write-up; re-check them against the
> current lra source before publishing — the prx side is grounded in code and
> cited.**

Most writing about "reliable AI agents" is really about prompts: a better system
message, a cleverer chain, one more retry. That framing quietly assumes the
reliability lives *in the model*. It doesn't. The reliability that matters —
work survives a crash, progress is only recorded when it's earned, two agents
don't corrupt each other's state — is an **engineering** property. You build it
into the system around the model, the same way you build durability into a
database or a CI pipeline.

Two systems I've spent time with land on exactly that thesis from different
directions: **lra** (durable agents on a durable-execution engine) and **prx**
(my own — agents driving signed, content-addressed work-units to a merged PR).
What's interesting isn't that they disagree. It's how *much* they converge — and
then the one layer where they don't, which happens to be the layer the industry
hasn't solved.

## The shared thesis: durability is engineering

Both systems start by refusing to treat "the agent finished the task" as a
truth you can take on faith. Both make the *unit of work* a durable, external
record — not a variable in a running process. Both insist that a crash must not
lose work, and — crucially — that not losing work is **not** the same as the
work being correct.

That last distinction is the whole game, and both systems get it right: a
durable system protects *work*, not *correctness*. Correctness has to come from
somewhere else — a gate, a check, a verification step that the agent cannot skip
by being persuasive.

## A rough component map

| Concern | lra | prx |
| --- | --- | --- |
| Unit of durable work | its work/state unit | **beads** — issues as persistent state that travels in git |
| Progress | recorded only when earned | the beads ledger records no unearned progress |
| Durable execution | a durable-execution engine (Temporal-style replay) | a **signed, content-addressed derivation DAG** + a fail-closed merge gate |
| Concurrency / custody | single-writer partition (anti-swarm) | **keeperd** — one broker is the sole git-writer; agents hold only a socket |
| Crash semantics | protects work, not correctness | same — correctness lives in the gate, not the run |
| Governance / authority | gestured at | **ocap derivation chain + signed spawn + capability scoping** |

## Where they genuinely converge

These aren't surface similarities — they're the same hard-won design decisions:

- **The state unit is a first-class record, not memory.** lra's work unit and
  prx's beads are the same move: the thing that survives is a durable, queryable
  record outside the process. In prx, beads literally travel with the repo in
  git, so the state and the code can't drift apart.
- **No unearned progress.** Both refuse to mark a step "done" optimistically.
  Progress is recorded when it's *earned* — when a check actually passed — which
  is what makes a resumed run trustworthy instead of a guess.
- **Anti-swarm by custody partition.** Both reject the "spawn a hundred agents
  and hope" pattern. The discipline is single-writer custody: exactly one writer
  owns a given resource. prx makes this physical — `keeperd` is the only process
  that can write git history; nothing in the agent's box can `git push`, because
  there's nothing in the box to push with.
- **Crash protects work, not correctness.** Both are explicit that durability
  buys you "your work is still here," never "your work is right." That honesty
  is rarer than it should be.

## Where they actually diverge

Two real differences, and they're informative:

**Durable execution engine vs signed DAG.** lra leans on a durable-execution
engine — deterministic workflows, replay, the orchestrator as the source of
truth. prx instead makes each step a **signed, content-addressed derivation**:
the pipeline is a DAG of derivations, each one verifiable on its own, and the
merge gate re-verifies before anything lands. The trust models differ. Replay
trusts the orchestrator to faithfully re-run history; a signed DAG trusts the
*signatures and the gate*, and doesn't need to trust the runner at all.

**The correctness boundary is a gate you can't talk around.** In prx the
boundary is a fail-closed merge gate: it verifies the provenance of a git-write
and blocks the merge if the derivation isn't signed and verified
(`canEnterReadyToMerge` returns false on `unsigned`). The agent cannot
rhetorically convince its way past it — the gate checks signatures, not
arguments.

## The half that's still missing: governance

Here's the differentiator, and it's the part I think is actually unsolved in the
wider field. Durability answers *"did the work survive?"* It says nothing about
*"was this privileged effect allowed, and by whom?"*

prx treats that second question as a first-class engineering property:

- **Capability-scoped authority.** Every privileged effect flows through a
  capability, not ambient access. An agent doesn't *have* git; it has a door to
  a broker that does.
- **Signed spawn — no artifact, no spawn.** An agent can't bring a new actor
  into existence unless the spawn is signed; authority is derived, never
  conjured.
- **Single-writer custody, for real.** `keeperd` holds the credential and the
  signing key; the agent never sees either. A git-write carries a verifiable
  in-toto / SLSA provenance derivation, signed per-actor, content-addressed in a
  derivation ledger (`anchored-chain`), checked fail-closed at the merge gate.
- **A policy gate the model cannot route around.** Authority only ever
  *attenuates* — it narrows, never widens — so a compromised or confused agent
  can't escalate.

Call it **SLSA-for-agents**: the same supply-chain rigor that secured build
systems, applied to what an agent is *allowed to do*. lra gives you durability,
and that's genuinely hard and genuinely valuable. prx aims for durability **and**
governance — and the governance half is where the interesting, unsolved
engineering is.

## Why this comparison is worth making

Two independent systems converging on "durability is engineering, not a model
trick" is a signal the framing is right. The divergence — replay vs signed DAG —
is a real architectural fork worth understanding. And the gap — that almost
nobody is treating *authority* with the same seriousness as *durability* — is, I
think, the next thing the field has to build. That's the part prx is a bet on.

---

*Honesty note on grades: prx's provenance + broker mechanisms are implemented
and verified in code, but their unconditional enforcement is opt-in until
keyless signing fully lands — a "common path, named gap" the project grades
openly. The governance thesis is a bet stated as direction, not a solved result.*
