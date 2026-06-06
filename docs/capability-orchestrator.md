# Capability-Poor Orchestrator

**Status:** Implemented (prx-g88) · **Owner:** bobby · **Spec'd:** 2026-06-04 ·
**Updated:** 2026-06-06

> **Implementation status.** This started as a draft spec ("no code lands from
> this PR"). The epic has since landed and this document has been re-grounded
> against the shipped code: the original `[NEEDS CLARIFICATION]` markers below are
> now annotated **Resolved** with the file that answers them, and the acceptance
> criteria are checked against tests. The one part still in flight is the
> delegation-**edge recorder** in §2 (the verify gate itself ships and is tested;
> see the note there). Each section's claims are kept honest by executable
> grounding — the generated Gherkin features in `features/` and the
> forcing-function value props (`packages/prx/src/value_props.ts`) — not just by
> this prose.

A core/orchestration agent that drives the prx pipeline must hold **no capability
of its own** — only the capability to **delegate** to actor sub-agents. Every
privileged operation is owned by an actor; the orchestrator can name an actor and
hand it work, but it cannot perform the actor's work itself. When that constraint
holds, ambient-authority leaks stop being invisible: they surface as ownership
denials or as provenance-verification failures.

This document defines the threat, the enforcement mechanism, the
identity/isolation model, the projection that generates the sub-agents, and the
child beads + sequence — now cross-referenced to the modules that implement each.

---

## 0. Motivating evidence

Driving the first beads unit to a merged PR (#85), the orchestrator (a core
agent) ran, from **one ambient Bash context**:

- `gh api PATCH /repos/... allow_auto_merge=true` — **forge**'s job
- `git push origin prx-2c4` — **keeper**'s job
- `prx publisher merge` — **publisher/forge**
- `bd show`, `git rebase`, `git switch` — scattered ownership

Nothing stopped any of it. Two of the gotchas that cost real time
(`bd show` failing in the wrong worktree → prx-lrw; `git switch -C` colliding
across worktrees → prx-5l3) were *symptoms* of ambient authority: the
orchestrator could run privileged ops in the wrong context, so the system
produced confusing raw failures instead of "you don't own this / you're not
where this lives."

Both gotchas are now patched (#86, #87), but the patches make the *ambient* path
more forgiving. This spec removes the ambient path.

---

## 1. Threat — ambient authority

**Definition.** *Ambient authority* is a privileged effect performed by a
principal that holds the capability merely by virtue of its execution
environment (here: an agent with unrestricted `Bash`), rather than by holding a
narrow, delegated capability for that specific effect.

**Why it's bad here.**

- It collapses the actor-ownership model the rest of prx is built on (policy
  table roles, keeper-owns-git, forge-owns-gh, per-actor signing keys). Ownership
  becomes documentation, not enforcement.
- It hides context/ownership errors as raw tool failures (prx-lrw, prx-5l3).
- It makes provenance incomplete: an effect can happen with no signed record of
  *which actor* was authorized to cause it.

**Threat model (what we defend against).**

- T1 — orchestrator performs an actor-owned effect directly (commit, push, gh
  write, bd mutate) instead of delegating.
- T2 — an actor performs an effect outside its policy allowlist (e.g. executor
  attempts `gh merge`).
- T3 — an effect appears with no attributable, signed owning-actor derivation
  ("orphan effect").

**Non-goals.** This is not a sandbox/escape defense against a malicious local
operator with shell access. It is an *integrity + auditability* model for agent
runs: make delegation mandatory and make violations detectable.

---

## 2. Enforcement — the delegation DAG (in-toto / SLSA)

Enforcement is a **signed dependency graph**, reusing the existing
`Derivation` substrate (`packages/anchored-chain/src/types.ts:25`):

```ts
manifest: {
  producer: string;                 // builder.id — which actor produced this
  inputs:  Record<string, Digest>;  // resolvedDependencies / materials
  outputs: Record<string, Digest>;  // the effects this derivation owns
  contracts: readonly string[];
  params: Record<string, unknown>;
}
envelope?: DsseEnvelope;            // per-actor DSSE signature (keymaker key)
```

**Delegation is an input edge.** When orchestrator/agent `A` delegates to actor
`B`:

1. `B` runs in its own context and emits its own derivation `D_B`
   (`producer = B@<digest>`, `envelope` signed with **B's** key) whose `outputs`
   record the privileged effects (e.g. `{ "push/v1": <sha> }`).
2. `A` records the delegation as an input: `D_A.inputs["delegate:B/<call>"] =
   D_B.derivationId`.

The result is a DAG of signed derivations linked `inputs ↔ outputs` by digest —
exactly SLSA `resolvedDependencies` / in-toto nested provenance.

**Verification gate.** For a derivation `D`:

- For each delegation input, resolve the referenced derivation; require its
  `producer` is the expected actor and its `envelope` verifies under that actor's
  key (`resolveActorVerifierForDerivation`, `packages/prx/src/provenance/signer.ts`).
- For each privileged `output` `e` of `D`, require there exists an input
  derivation whose `producer` is the **owning actor** of `e` (per the policy
  table) and whose envelope verifies.

> **Implemented (prx-1dz):** the ownership half ships in
> `packages/prx/src/provenance/effect-ownership.ts` — `verifyEffectOwnership(D)`
> returns `ok: false` ("orphan/ambient effect") when the `producer` actor is not
> a policy-table owner of the effect, when the effect is hard-blocked, or when the
> producer is unparseable. Owners come straight from the policy table
> (`findOwningRoles`), so the gate tightens automatically as prx-gr1 narrows git
> custody. It is wired into the merge path via `provenance/merge-guard.ts` and
> proven by the value-prop forcing function "a push produced by reviewer is
> rejected" (`value_props.test.ts`). **Still in flight:** the delegation-**edge
> recorder** (writing `D_A.inputs["delegate:B/<call>"] = D_B.derivationId` into the
> parent agent-run / `merge/v1` derivation) — the key format is pinned today via
> `delegationInputKey()`, but the emitter lands with `merge/v1` as a tracked
> follow-up.

**The enforceable definition of the threat:**

> **Ambient authority := a privileged output with no matching owning-actor input
> derivation.** The verify gate fails closed on orphan effects (T3). T1 is the
> special case where the orphan effect's would-be owner is *not the orchestrator*.
> T2 is caught because `B`'s derivation for an out-of-allowlist effect is refused
> at production time by the policy check (§5) and so never exists to be cited.

**Owning-actor map.** `owner(effect)` is derived from the policy table: the role
that holds the effect's `(tool, subcommand)` in any state. `git push → keeper`,
`gh merge|ready|create|... → forge`, etc. Hard-blocked subcommands (`git reset`,
`gh close`) have no owner and may never appear as an output.

- **Resolved (granularity).** v1 attests **git `commit`/`push`** — `effectKindOf`
  reads `params.subcommand` off the derivation (`attestingGit` records it). The gh
  custody effects (`merge`/`ready`) "join here once forge attests them"; `bd`
  mutates are out of scope for v1. Non-policy-role producers (session-profile
  actors like `work`/`implement`) pass through until the profile→role table lands —
  the role-named custody actors (keeper, forge) are enforced strictly.
- **Resolved (who writes `D_A.inputs`).** The dispatch/recorder side owns the edge
  (so `A` cannot forge it), keyed by `delegationInputKey(actor, call)` →
  `delegate:<actor>/<call>`. The recorder itself lands with `merge/v1` (see the
  in-flight note above).

---

## 3. Identity — the intake ⊗ actor salt

Every actor context is bound to a **salt**, layered so neither half can be
forged or shared:

- **Intake mints the unit-root salt.** Intake is the chain root — where
  `<unit>:source@pinned` is established (`pinWorkUnitSource`,
  `packages/prx/src/pipeline/source-pin.ts`). The unit salt is born there:
  `unit_salt = H(source@pinned digest)` — a per-unit token that travels with the
  unit and binds everything downstream to a legitimate entry. An actor cannot
  fabricate a context for a unit it was never handed.
- **Each actor derives its own salt.** `actor_salt = H(unit_salt ⊗ actor_identity)`
  where `actor_identity = actor@sha256(authority-contract)` — the existing
  identity from `actorIdentity` / `digestOfContract`
  (`packages/prx/src/provenance/actor-identity.ts`), which rotates with the
  actor's *powers* (allow/deny lists), not its code.

**Why layered:** actor-only salt isn't bound to a real intake (forgeable unit
association); intake-only salt is one shared context across all actors
(re-introduces impure shared mutable state). Intake establishes the capability;
the actor scopes it to itself.

The actor's signing key continues to be `HMAC(deployment-master,
actor_identity)` (keymaker); the salt governs *isolation/addressing* (§4), not
key material.

> **Implemented (prx-g88.4 / C4):** `packages/prx/src/provenance/actor-salt.ts`.

- **Resolved (`H` and `⊗`).** `H = sha256`, hex, truncated to a 12-char
  (`SALT_LENGTH`) git-short-sha-style addressable token; `⊗` is a `/`-join with a
  domain-separation prefix: `unitSalt = sha256("prx/unit-salt/" + sourcePinnedDigest)`
  and `actorSalt = sha256("prx/actor-salt/" + unitSalt + "/" + actorSigningIdentity)`.
  Deterministic and recomputable by a verifier; two actors on one unit get
  different salts (no sharing), one actor across units gets different salts (intake-bound).
- **Resolved (persisted vs derived).** **Derived on demand** from
  `source@pinned` — no new ref kind. `actorSaltForSource(sourcePinnedDigest, actor)`
  recomputes it straight from the pinned digest.

---

## 4. Isolation — ephemeral salted worktrees

Each actor sub-agent runs in its **own salted worktree on its own salted
branch**, both **ephemeral**:

- Worktree path: `.wt/<actor>-<actor_salt>` (e.g. `.wt/keeper-<salt>`).
- Working branch: `<actor>/<unit>-<actor_salt>`.
- Created on sub-agent start; **removed on sub-agent finish** (cf. the Workflow
  tool's `isolation: 'worktree'` auto-clean).

**The only durable state is the signed CAS artifact** the actor hands off.
Branches are projections, never source of truth. The **single** branch that
escapes to origin is keeper's published PR branch, materialized from the artifact
at publish, and GC'd post-merge.

**This eliminates the prx-5l3 class structurally:** if every actor's branch is
salted + ephemeral + worktree-scoped, there is never a persistent foreign branch
checkout for `git switch -C` to collide with, and no manual
`git push origin --delete` cleanup is ever needed. #87's ownership error becomes
unreachable — kept as a backstop.

> **Implemented (prx-g88.5 / C5):** `packages/prx/src/pipeline/ephemeral-worktree.ts`.

- **Resolved (lifecycle owner).** A scoped wrapper owns it:
  `withEphemeralActorWorktree(spec, fn)` calls `createEphemeralActorWorktree`
  on entry and `destroyEphemeralActorWorktree` in a `finally` (so the worktree +
  salted branch live exactly as long as the agent's work, then vanish even on
  throw). All git ops run with `role: "keeper"`.
- **Resolved (crash cleanup).** `sweepOrphanedActorWorktrees(repoRoot)` lists
  worktrees under `.wt/` and force-removes the orphans (default posture: all),
  ready to wire into `gc inventory` / `gc run` (that wiring is the remaining bit).

---

## 5. Projection — policy table → sub-agent allowlists

The actor sub-agents are **generated**, not hand-written, from the policy table
(`packages/policy/src/index.ts`: `POLICY_TABLE` keyed `<tool>:<state>:<role>`,
roles `planner | executor | reviewer | tester | keeper | forge`) plus the actor
vocabulary (`packages/prx/src/machine/actor_names.ts`). Same codegen engine as
the README/rules ideas (prx-a6p / the `rules` actor).

For each actor, emit `.claude/agents/<actor>.md` whose tool allowlist is the
projection of that role's policy entries into runnable surfaces:

```
.claude/agents/keeper.md
---
name: keeper
description: Owns git refs — materialize, commit, push. Runs in its own worktree only.
tools: Bash(git push:*), Bash(prx keeper:*)
---
You own git refs for one unit, in your own ephemeral worktree. You materialize
and push where your branch lives. You never touch gh, bd, or another actor's tree.

.claude/agents/forge.md
---
name: forge
description: Owns ALL gh writes — PRs, merges, labels, comments.
tools: Bash(gh:*), Bash(prx publisher:*), Bash(prx forge:*)
---
You own every gh write. PR open/ready/merge, labels, comments. You never touch
git refs (that is keeper) or the working tree.
```

The **orchestrator** definition has **no** `Bash` to git/gh/bd/prx-actor verbs —
only the `Agent`/dispatch capability. Any attempt to do owned work has no tool →
it must delegate.

**Enforcement layer.** Claude sub-agent `tools` frontmatter restricts which
*tools* an agent may call, but the policy table is *subcommand-granular*
(`git:push` allowed, `git:reset` blocked; `gh:merge` only for forge). Projecting
that requires command-level enforcement, not just tool-level. Candidate
mechanisms (pick in the build):

1. **PreToolUse hook** keyed on the running sub-agent's actor identity → calls
   `checkPolicy(tool, sub, state, role)` and denies on refusal. (Reuses the
   existing policy engine; single source of truth.)
2. Per-agent `Bash(... :*)` globs in frontmatter approximating the allowlist
   (coarser; drifts from the table).

Recommendation: (1) — the hook *is* the projection at runtime; the generated
`.claude/agents/*.md` are the human-readable/dispatch surface. A drift test
asserts the generated files match `POLICY_TABLE`.

> **Implemented (prx-g88.1/.2):** mechanism **(1)** shipped. The agents are
> generated by `packages/prx/scripts/gen-agents.ts` (`generate.ts`) and emit
> `tools: Read, Grep, Glob, Bash` plus a `PreToolUse` `hooks:` block calling
> `.claude/hooks/policy-guard.ts` — **not** the per-glob `Bash(git push:*)`
> frontmatter sketched above (that approach was rejected as drift-prone). The hook
> resolves the firing subagent's role from `agent_type` and denies via the pure,
> unit-tested `decideAgentToolCall` (`packages/prx/src/agents/policy_guard.ts`).
> Drift is held by `test/agents/generate.test.ts`; the orchestrator's empty
> capability is asserted by `value_props.ts` ("the orchestrator owns nothing").

- **Resolved (existing hook?).** New, and it now ships: `.claude/hooks/policy-guard.ts`,
  the single runtime projection of the policy engine.
- **Resolved (state selection).** The runtime guard decides on `(tool, subcommand,
  role)` via `findOwningRoles`'s union across states (`owningRolesUnion`) — i.e.
  "owned in *some* state" — rather than threading a per-dispatch phase, so an
  actor's allowlist is fixed per actor at the hook layer.

---

## 6. Child beads + sequence

Parent epic: **prx-g88**. Children (status as of 2026-06-06):

1. ✅ **C1 — policy-table → sub-agent codegen + drift test** (the projection, §5).
   `scripts/gen-agents.ts` + `test/agents/generate.test.ts`.
2. ✅ **C2 — runtime policy hook** (§5 enforcement). `.claude/hooks/policy-guard.ts`
   over `agents/policy_guard.ts:decideAgentToolCall`.
3. ✅ **C3 — capability-poor orchestrator profile** (§1/§5). `.claude/agents/orchestrator.md`
   (`tools: Agent, Read, Grep, Glob` — no Bash); asserted by `value_props.ts`.
4. 🟡 **prx-1dz — delegation-DAG provenance** (§2). Verify gate **landed**
   (`provenance/effect-ownership.ts`, wired via `merge-guard.ts`); the
   delegation-**edge recorder** lands with `merge/v1` (follow-up).
5. ✅ **C4 — intake ⊗ actor salt** (§3). `provenance/actor-salt.ts`.
6. ✅ **C5 — ephemeral salted worktrees** (§4). `pipeline/ephemeral-worktree.ts`;
   `sweepOrphanedActorWorktrees` awaits `gc` wiring.

The §7 *external-audit surface* also landed: the policy table and the capability
envelope each project to a generated Gherkin `.feature` (`features/`), kept
faithful — not just drift-free — by `test/agents/capability_feature.test.ts` and
`capability_envelope.test.ts`.

**Sequence rationale.** C1 is the cheapest demonstrable slice ("orchestrator can
only delegate, by construction"). C2 makes the allowlist real. prx-1dz makes
violations *auditable after the fact*. C4/C5 make violations *structurally
impossible* for the worktree/branch class. Land C1→C2→prx-1dz first (the
authority spine), then C4→C5 (the isolation spine).

## Acceptance criteria (epic)

- [x] The orchestrator agent has no tool path to `git`/`gh`/`bd`/`prx <actor>`
      privileged verbs; a test proves a denied attempt.
      *(`value_props.ts` "the orchestrator owns nothing"; capability feature scenario.)*
- [x] Each actor sub-agent is generated from `POLICY_TABLE`; a drift test holds.
      *(`gen-agents.ts` + `test/agents/generate.test.ts`.)*
- [x] An out-of-allowlist subcommand by any actor is denied at runtime by the
      policy hook (T2). *(`policy-guard.ts` + `decideAgentToolCall`; "forge is
      denied a git push".)*
- [~] A privileged effect with no owning-actor signed input derivation fails the
      verify gate (T3 / T1). *(Gate live + tested via `verifyEffectOwnership`;
      the input-edge recorder lands with `merge/v1`.)*
- [x] No two actors share a worktree or branch checkout; actor branches are
      ephemeral and removed on finish (prx-5l3 class structurally gone).
      *(`ephemeral-worktree.ts:withEphemeralActorWorktree`.)*
- [x] The salt is deterministic and recomputable by a verifier; intake-minted,
      actor-scoped. *(`actor-salt.ts`.)*

## Open questions (consolidated)

The per-section `[NEEDS CLARIFICATION]` markers above are now **Resolved** inline.
Remaining:

- **Mostly resolved (headless vs Claude-only).** The engine is harness-agnostic
  pure TypeScript — the policy table, `verifyEffectOwnership`, `actor-salt`, and
  the ephemeral-worktree lifecycle all run headlessly (they're exercised in CI by
  the unit tests and value-prop checks with no Claude harness). Only the
  `.claude/agents/*.md` + the `PreToolUse` hook are Claude-Code-specific surfaces
  *over* that engine.
- [ ] **Open — `isPerActorMode`.** Per-actor DSSE envelopes are a prerequisite for
      the §2 delegation-edge recorder (the gate already keys on the per-actor
      producer); confirm the opt-out interaction when `merge/v1` lands.
- [ ] **Open — `gc` wiring.** `sweepOrphanedActorWorktrees` exists but is not yet
      called from `gc inventory` / `gc run`.
- [ ] **Open — gh + non-role producers in the verify gate.** §2 attests git
      `commit`/`push` today; gh custody effects and the session-profile→role table
      are tracked follow-ups.
