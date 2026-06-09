# Pilot & fleet — Claude subagents as a signed pipeline

> Spike `spike/pipeline-driven-task`. Design note + Layer-1 (`pilot`) prototype.

## The idea

A work unit flowing **plan → implement → submit → CI → merge** is a state
machine whose workers are **real Claude subagents**. The engine is the **Claude
Agent SDK host loop + XState**; each role is a leaf subagent with scoped tools
and a signing authority. Every surface (`prx pilot`, `/prx`, the fleet) is a
thin caller of the same machine — not a re-encoding of the sequence.

```
              ┌──────────────── surfaces (second arg = actor) ────────────────┐
   prx pilot <unit> ── drive ONE unit          /prx <unit> ── slash command
   prx fleet ──────── agents view (many)       prx do / prx next ── projections, NOT actors
              └───────────────────────────────┬───────────────────────────────┘
                                              │  all drive the same machine
                          ┌───────────────────▼────────────────────┐
        Layer 2  FLEET    │  fleetMachine: spawn 1 pilot / unit,    │  ← agents view / board
        (host loop)       │  bounded WIP, watch pilot snapshots     │
                          └───────────────────┬────────────────────┘
                                              │ spawns (Promise.all)
                          ┌───────────────────▼────────────────────┐
        Layer 1  PILOT    │  pilotMachine: each leg state invokes a │  ← pilot.ts (prototype)
        (host loop)       │  leg-runner → self-advances + signs     │
                          └───────────────────┬────────────────────┘
                                              │ injected leg-runner calls
                          ┌───────────────────▼────────────────────┐
        leaf workers      │  query() → ROLE SUBAGENT                │  planner│executor│tester│reviewer
        (real subagents)  │  scoped tools · signs in-toto link      │  AgentDefinition.tools = least-priv
                          └─────────────────────────────────────────┘
```

## Why pilot & fleet are NOT subagents

**Subagents cannot spawn subagents — leaf-only, one level deep**
([SDK docs](https://code.claude.com/docs/en/agent-sdk/subagents)). So
`fleet → pilot → role` can't be subagents all the way down. That constraint
*places the seam*: the two orchestration layers are the **SDK host loop** (where
XState lives); only the four roles are subagents. No nesting, no conflict.

| layer | what it is | where it runs |
| --- | --- | --- |
| `fleet` | XState machine, spawns N pilots | Agent SDK host (TS) |
| `pilot` | XState machine, sequences legs | Agent SDK host (TS) |
| role leg | real Claude subagent, scoped tools | `query()` leaf |

## Layer 1 — `pilot` (one unit, self-driving, signed)

**File:** `packages/prx/src/machine/machines/pilot.ts`.

- Each leg state (`planning/executing/testing/reviewing`) **`invoke`s** a
  `runLeg` actor on entry → launches the role subagent; its signed outcome fires
  the transition. No external `ROLE_*_COMPLETED` feed.
- The runner is **injected** (`LegRunner`) — the one seam every surface shares.
  Production: `query()` the role subagent, then sign with the role's authority.
  Tests: `stubLegRunner`.
- `roleProfile` binds each role to `{ agent, tools, signs }` — the subagent, its
  least-privilege tool allowlist (planner read-only; executor Edit/Write/Bash),
  and the artifact its authority signs.
- Failure edges from `task.ts` preserved: thrown leg retreats
  (`executor → planning`); non-advancing leg parks in `blocked` (still signs).

**Proven by** `pilot.test.ts`: the stub runner walks a unit to `done` with zero
events fed in, and the **signed provenance chain accumulates in order** —
`source@pinned → plan@draft → implement@latest → gate@checks-local →
review@validated → submit@ready → gate@ci-remote → merged@pr`. The four LLM
**legs** (planner/executor/tester/reviewer) sign `plan@draft / implement@latest /
review@validated / submit@ready`; the **deterministic seams** (intake, the local
`prx ci` gate, remote CI, merge) sign the rest. See
[`pipeline-local-checks.md`](./pipeline-local-checks.md) for the local-CI gate +
observability in detail.

## Provenance — a signed in-toto tree (legs → pilot → fleet)

Every actor is a **signing actor** (the existing prx anchored-chain / in-toto
direction — `gate actors as signed attestations`, `Signer`). Provenance is a
three-tier tree, each tier naming its children by digest (`provenance.ts`):

| tier | artifact | signed by | over |
| --- | --- | --- | --- |
| step | `LegAttestation` `{stage,subject,predicate,signedBy,sig}` | role / ci / publisher | one effect |
| unit | `Statement` `prx.pilot/v1` | the **pilot** | the unit's whole chain |
| board | `Statement` `prx.fleet/v1` | the **fleet** | the pilots it ran |

A leg (and the CI gate, and the merge) each push a signed step link. On
`sealing` the pilot mints its **summary statement** over the chain; on drain the
fleet mints a **batch statement** over the pilot summaries. Verify top-down:
fleet statement → pilot-summary digests → leg digests. This *encodes* the
capability-orchestrator rule (T3: no effect without a signed owning-actor) — the
executor can't advance without signing what it did, and the pilot/fleet can't
report done without signing what they supervised. Proven in the tests: chain
links, `prx.pilot/v1` summary, and `prx.fleet/v1` batch are all asserted.

Signing locus: the leg-runner signs at the host boundary with the role's key
(subagents return text; authority lives in the host that holds the key).
Self-signing via a `prx` signing tool in the subagent's allowlist is the
stronger v2 variant.

**Real signatures (not stubs).** `pilot-signing.ts` wires the artifacts to the
repo's actual provenance stack: `resolveProvenanceSigner()` returns an ed25519
`Signer` (`PRX_PROVENANCE_KEY=dev` / per-actor / stable `ed25519:<b64>`), and we
sign the standard DSSE pre-authentication encoding of each statement.
`realStatementSigner(signer)` drops straight into `createPilotMachine({
signSummary })` / `createFleetMachine(_, { signBatch })`; `realRoleSigner` does
the leg links. `verifyStatement` / `verifyLeg` check them. Proven in
`pilot-signing.test.ts`: a pilot summary and a fleet batch carry genuine sigs
that verify, a tampered predicate or wrong key is rejected, and the ambient
dev-mode resolver round-trips end to end. Open: store each leg's `outputHash` on
its link so step links are verifiable from the chain alone (today `verifyLeg`
needs the hash passed in).

## CI is a hard block — by construction (twice)

There are **two** signed gates, both deterministic seams that share one
`gateState` helper (green → advance; red → retreat to `executing`, budget-bounded;
budget spent → `abandoned`):

- **`checking`** (local) sits between `executing` and `testing`. It runs the full
  `prx ci` surface (install→typecheck→docs→build→test) in the unit's worktree and
  signs `gate@checks-local` — failing fast on the real CI surface *before* the
  LLM tester/reviewer legs and before remote CI. Runs under a hard timeout (the
  pipeline analogue of a GitHub job `timeout-minutes`).
- **`awaiting_ci`** (remote) is the tail `reviewing → awaiting_ci →
  ready_to_merge → sealing → merged`. It polls remote CI and **resolves only when
  CI has settled** — pending never resolves, so there is literally no edge to
  merge while CI is pending or red.

The "CI pending is a HARD BLOCK" rule stops being a prompt instruction and
becomes a property of the graph — at both the local and remote gate. Proven: a
permanently-red gate (either one) never produces a `merged@pr` link.

## No tmux — "claude over ssh"

tmux was only the *interactive-attach* mechanism (`attachMuxSession`). A headless
pipeline never needs it: each leg is a headless `query()` against a role
subagent — local, or against a remote Claude (ssh). The `interaction: "headless"`
axis already exists; the tmux/attach path simply drops out of the pilot lane.
tmux has since been removed entirely — the parity surface, the interactive
session attach, the `tmux` actor, and the `prx-mux` package are all gone.
Interactive `prx plan session` etc. now run directly in the foreground terminal.

## `next` is ocap-with-priority — and termination is proven, not assumed

`prx next` projects a **priority-ordered set of capabilities**: each ranked
thread carries a `recommended_action` the holder is authorized to exercise. The
`next → do` loop relies on **monotonic progress** — exercising a capability must
mutate state so it is no longer projected (the action "won't repeat"). Assuming
that is a livelock waiting to happen; the pilot *proves* it.

**The measure.** `pilotMeasure` maps every active state to a lexicographic pair
`[retreatBudget, distanceToDone] ∈ ℕ²`. Every autonomous transition strictly
decreases it:

- forward leg (`planning→executing→…`): budget unchanged, `distanceToDone` ↓.
- failure-retreat (`executor→planning`): `retreatBudget` ↓ (dominates the order,
  regardless of the phase jump).
- budget exhausted → `abandoned` (halt); a non-advancing leg → `blocked` (halt).

ℕ² is well-founded ⇒ no infinite descending chain ⇒ **no autonomous action
sequence runs forever**; the pilot reaches `done`/`abandoned`/`blocked` in
bounded steps. The ocap reading: each leg is a capability whose exercise
*consumes measure*, so it cannot be replayed into an unbounded regress. Proven
in `pilot.test.ts` — a permanently-failing executor halts at `abandoned`, and
the measure is asserted strictly decreasing across a whole run.

**Lifting it to `next`/`do` globally.** The same shape generalizes: model each
recommended action as a capability minted from a **state version** (a fact-set
hash). `do` validates the cap against the current version; the effect bumps the
version, invalidating every outstanding cap → replay/repeat is impossible by
construction (optimistic-concurrency / CAS on the derived-fact store). Proving
*global* termination is then: exhibit a well-founded measure over the projected
fact-set that every `do` strictly decreases. (Design target, not yet built.)

## Layer 2 — `fleet` (many units, the agents view)

**Prototype: `packages/prx/src/machine/machines/fleet.ts`.** A host machine that:

- takes a unit list (`prx next`'s ranked threads in prod) as input,
- spawns one `pilot` actor per unit through a WIP-bounded `fromCallback` pool,
  refilling slots as pilots halt,
- projects each pilot's live snapshot into `context.board` → **that board _is_
  the agents view** (unit → leg, signed-link count, running/halted),
- moves to `drained` when the queue is empty and nothing is in flight.

**Proven by** `fleet.test.ts`: 5 units at WIP 2 all reach `done` with full
4-link chains; the board never shows more than `wip` running; an empty list
drains immediately.

`makePilot` is the only seam — pass pilots bound to the real `LegRunner` (agents
+ signing) or to `stubLegRunner` for tests; the fleet code is identical. Still
open: fold `sprint.ts` derivations for the aggregate progress bar; treat
`blocked` (non-final) as a board-visible stall awaiting an external nudge.

`prx --repo` is the fleet's input axis: bind to a repo (or fan across repos) and
each repo's `prx next` feeds that repo's spawn queue → "open any repo."

## One machine, many interfaces

`session/open.ts` keeps `openSession` "driver-agnostic." Same principle up a
level: the pilot machine speaks only legs + signed outcomes. The injected runner
is the only thing that knows it's a Claude subagent over ssh.

- **`prx pilot <unit>`** → runner = `query(roleAgent)` + sign; one machine, run to `done`.
- **`/prx <unit>`** → today a prose loop in `.claude/commands/prx.md`; becomes a
  thin driver of this machine, so prose and CLI can't drift.
- **`prx fleet`** → runner unchanged; the supervisor owns N pilots.
- **tests** → `stubLegRunner`.

## Driving real subagents (`pilot-real.ts`)

The production wiring, gated behind `PRX_PILOT_REAL`. Each leg reuses the CLI's
own path: `openSession({actor})` materializes the unit's worktree + builds the
per-role runtime profile, then `runClaudeAgentNonInteractive` runs that role
headless; the result is signed with the role's authority via
`resolveProvenanceSigner`. `buildRealPilotDeps` also signs the pilot summary for
real. All three I/O seams (openSession, the agent run, the signer) are injected,
so `pilot-real.test.ts` drives the real machine with mocked I/O and a real
ed25519 key — the executor leg and the summary carry genuine, verifiable
signatures (not stubs), and a failed `openSession` retreats correctly.

Role → session actor: `planner→plan`, `executor→implement`, `tester→implement`
(runs the unit's tests in the implement worktree), `reviewer→author`.

A live probe (`PRX_PILOT_REAL=1 prx pilot prx-eky`) confirmed the path reaches
`openSession`; completing a live run is gated only on (a) a real `waitFor`
timeout — now 30 min in real mode vs. 4 s for stubs — and (b) the beads/Dolt
server being up (attached actors hydrate beads at session start).

The **tail is real too**: `buildRealChecks` resolves the implement worktree and
runs `prx ci` there (signing `gate@checks-local`, under a hard timeout),
`buildRealCiGate` polls `prx scout ci <unit>` until CI SETTLES — pending never
advances (the hard block, now against the live status rather than a stub) — and
`buildRealMerge` runs `prx publisher merge <unit>`; all sign their links. They
shell out through an injected `runPrx`, so the whole tail is tested driven to
`merged` with real signatures. `buildRealPilotDeps` wires all of it.

## Observability — off the chain, signed once

Telemetry is **orthogonal to the authority chain**: it surfaces *what's
happening*, never gates a merge. Each LLM leg emits a progress **heartbeat**
(`TELEMETRY_LEG_OBSERVED`, with an IDLE watchdog that retreats a silent leg), and
each deterministic seam emits **start/done** (`TELEMETRY_SEAM_OBSERVED`) — both as
`catalog-event` rows in the daily audit NDJSON, so a run is observable with
`tail`/`jq`, `PRX_AUDIT_STDOUT=1`, or `prx observe <unit>` (a read-only timeline).
For tamper-evidence without per-event signing, all telemetry folds into a per-unit
hash chain whose head rides in the `prx.pilot/v1` summary predicate as `observed:
{ digest, count }` — the pilot's existing signature commits to it. That anchored
digest is the *only* place health touches the chain; gates decide merge, health
rides along. Full rationale: [`pipeline-local-checks.md`](./pipeline-local-checks.md).

## No agent acts unsigned — and the CLI is a tty-actor

`agent-signing-guard.ts` makes the signing key a **launch precondition**:
`requireSigner(actorLabel)` resolves the actor's `Signer` or REFUSES to launch
(closing the T3 hole — no effect without a signed owner). The pilot's leg, CI
gate, and merge route their signer through it, so `buildRealPilotDeps` throws
without a key rather than running an unsigned agent.

The human is an actor too. The CLI is modeled as **an actor that inherits from
the controlling tty**: `cliActor()` resolves to the `human` operator when stdin
is a terminal, else the `noninteractive` actor — and `requireCliSigner` insists
that actor hold a key as well. A person at the terminal signs exactly like a
pipeline actor; the authority is the same shape top to bottom.
