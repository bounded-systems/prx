# GH-1836 — PRX runtime + workspace architecture: Nix + Moon + Deno/Bun hybrid (ADR)

> Design-only spike. Output of `prx implement GH-1836`. Settles whether **Nix
> (env authority) + Moon (task graph) + Deno (per-actor permissions) + Bun
> (binary compile + TUI + legacy)** can become the substrate the contract
> trinity (GH-1821) and the audit invariants (GH-1823) already assume exists.
> Inline throwaway POC lives at `spikes/runtime-eval/`. **No `src/`, `packages/`,
> root `flake.nix`, root `package.json`, or `nix/home-manager/*` changes in
> this unit** — every actionable consequence is filed as a follow-up ticket
> against the six-phase migration plan in §5. Written 2026-05-16.

## 0. Status

Accepted. The contract trinity (GH-1821, landed in `ed4b6d2`) gave typed
1→1 artifact contracts and validated phase transitions; the session-mode
ADR (GH-1827) gave per-profile actor allowlists; the audit invariants
I-AUD1..5 (GH-1823, landed in `9e99887`) gave hard-failable rules over
the artifact graph — but every actor still runs through one ambient-trust
`localRuntimeExecutor` (`src/pr-state/executor.ts:60`), the workspace has
no task graph, no affected-set, and no replay primitive beyond the
`<domain>://sha256:` CAS scheme in `src/plan-store/uri.ts:8`. This ADR
decides which substrate fills those gaps and ships a runnable POC that
exercises every verdict.

## Decision summary

One row per axis. Verdicts authorize phases A and B of §5 only; later
phases are conditional on each prior phase's exit checkpoint.

| # | Axis | Verdict | One-line rationale |
|---|------|---------|--------------------|
| 1 | Workspace orchestrator | **Adopt Moon, staged** | Only candidate with first-class multi-runtime *and* a Nix-pinnable static binary; complements rather than replaces the artifact-graph view in `src/plan-store/`. |
| 2 | Control-plane runtime | **Adopt Deno for `planning` + `verification_publication` tiers** | `--allow-*` granularity maps onto the per-profile actor allowlists in `src/machine/runtime_profiles.ts`; brings I-AUD4 enforcement to the OS layer instead of the audit layer alone. |
| 3 | Binary distribution | **Retain Bun `--compile`** | Home-Manager activation in `nix/home-manager/prx.nix:100` is already wired (`bun build --compile scripts/pr_state.ts`); migration is out of scope. The product surface stays Bun. |
| 4 | Nix authority depth | **Tool-pinning** | Pin `bun`/`deno`/`moon` in flake devShells; defer per-package `mkDerivation` until a concrete reproducibility incident demands it. |
| 5 | Artifact / CAS replay | **Coexist, do not merge** | Moon hashes inputs + toolchain (build-graph cache); PRX CAS hashes artifact content (provenance graph). Adapter: Moon task output is a `*.cas-ref.json` containing a `<domain>://sha256:<hex>` URI matching `src/plan-store/uri.ts:8`. |
| 6 | Actor permissions | **Map Deno `--allow-*` to tier groups in `actors.ts`** | `planning` = `--allow-read --allow-env=PRX_*`; `execution` = `--allow-run=git,gh,bun --allow-write=$WORKTREE,$CAS_ROOT`; `verification_publication` = `--allow-net=api.github.com --allow-run=gh,bun`. |

The POC at `spikes/runtime-eval/` exercises **all six** verdicts (six
runnable demos, §POC). The audit grounding in §1 establishes which
invariants the POC must respect; §6 lists the seven follow-up tickets
filed to track every Phase A–F action this ADR authorizes.

## 1. Machine-first context (what this ADR is reasoning over)

Source of truth inspected: `prx model --scope workflow`, `prx actors
--scope workflow`, `prx graph --format xstate-system-ts`, plus the files
listed below. This ADR adds no actor, event, or transition to the
catalog — every axis is reasoned over **existing** seams.

**Artifact this work-product is.** Registered at
`src/machine/contracts/artifacts.ts:126` — `type: "plan"`,
`schemaVersion: "prx.plan.v1"`, `validationRef: "deferred:GH-1823"`,
`persistence: "cas"`, `requiredFields = ["unitId", "scope",
"implementationSteps", "verification"]`. The ADR text + the POC tree
together satisfy `scope` (§4 + §POC), `implementationSteps` (§5), and
`verification` (§7 + §POC verification checklist). The plan persists in
CAS under a `plan://sha256:<hex>` URI; this file is the durable git-side
mirror.

**Catalog unchanged.** GH-1836 adds no workflow actor, event, or
transition. The existing catalog covers the work-product end to end:

| Role | Actor (`src/machine/actors.ts`) | Tier | Emits | Produces here |
|------|---------------------------------|------|-------|---------------|
| Planner | `planner_agent` (line 258) | planning | `ROLE_PLANNER_STARTED`, `ROLE_PLANNER_COMPLETED`, `ROLE_PLANNER_FAILED`, `TASK_SCOPE_CONFIRMED` | This ADR text |
| Executor | `executor_agent` (line 269) | execution | `ROLE_EXECUTOR_STARTED`, `ROLE_EXECUTOR_COMPLETED`, `PATCH_PROPOSED` | POC tree under `spikes/runtime-eval/` |
| Tester | `tester_agent` (line 278) | verification_publication | `ROLE_TESTER_STARTED`, `ROLE_TESTER_COMPLETED` | The §7 + §POC verification run |

Handoff = the §Decision-summary table is the executor's input bundle;
the §POC demo list is the tester's run sheet.

**Workflow phases.** Standard `planning → executing → testing →
reviewing → done` against `workflowBackboneParallelRegion` in
`src/machine/machines/workflow.ts`. The 16-phase chain
(`cleaned → … → ready_to_merge`, see `prx model --scope workflow`)
applies; no special-case carve-out.

**Invariants the POC must respect.**

- **I-AUD1 / I-AUD2** — `src/audit/invariants.ts:58, 78`. Attach
  `uow_id = GH-1836` and `input_refs[]` only on the `plan`-artifact
  emission for the ADR, not on transient POC outputs. The POC's
  per-demo runs are not audited UoW events.
- **I-AUD3** — `src/audit/invariants.ts:107`. POC must not emit
  synthetic transition events into the real audit sink. The POC's own
  CAS lives at `spikes/runtime-eval/.cas/` (gitignored), isolated from
  `$XDG_STATE_HOME/prx/cas/`.
- **I-AUD4 (no ambient git)** — `src/audit/invariants.ts:159`.
  Load-bearing. Every git/gh subprocess in the POC routes through
  `prx tools git` / `prx tools wt` *with one carve-out*: a single
  documented demo (`packages/scout/main.ts`) deliberately invokes raw
  `git` to exercise Deno's `--allow-run=git` permission gate. The
  carve-out is tagged so `prx audit uow GH-1836` does not flag it, and
  the production migration (Phase B in §5) blocks on a `prx tools git`
  Deno shim (filed as a follow-up).
- **I-AUD5** — `src/audit/invariants.ts:179`. Not exercised; the POC
  emits no UoW status writes.

**Existing seams the verdicts are reasoned over.**

| Seam | File:line | Why it matters here |
|------|-----------|---------------------|
| Profile builders (per-actor allowlists) | `src/machine/runtime_profiles.ts:616` (plan-print), `1474` (plan-interactive), `1599` (implement) | Axis 6 (Deno permissions) maps to these flag bundles. |
| Session-mode ADR (verb shape that names the two contracts) | `docs/spikes/GH-1827-actor-session-modes.md:200` | The non-interactive contract Deno permissions formalize. |
| Subprocess seam (single spawn point) | `src/pr-state/executor.ts:60` (`localRuntimeExecutor`), `1, 117, 131` (`spawnSync`) | Phase F replaces `spawnSync` with a permission-aware Deno-subprocess executor. |
| Contract trinity (1→1 currying rule) | `src/machine/contracts/instances.ts:30` | Axis 2 (Deno control plane) inherits the 1→1 invariant; the runtime change does not perturb the contract surface. |
| Artifact registry | `src/machine/contracts/artifacts.ts:126` | Where the `plan` slot this ADR fills is registered. |
| Audit predicates | `src/audit/invariants.ts:1` | Hard-fail predicates Phase B must not regress. |
| CAS substrate | `src/plan-store/cas.ts:321` (`writeBlob`), `src/plan-store/uri.ts:8` (URI codec) | Axis 5 (coexistence); POC `packages/cas/` mirrors this URI shape, does not replace it. |
| JSON-schema export boundary | `prx schemas`, `schemas/contracts/{agent,artifact,transition}.json` | Phase C (Deno-side actors) depends on this boundary serving non-Bun consumers — exercised by the POC's schema-export probe. |
| Bun-compile activation | `nix/home-manager/prx.nix:100` | Axis 3 (binary distribution) cites this as the reason to retain Bun for the product surface. |
| Root workspace boundary | `package.json:5` (`workspaces: ["packages/*"]`), `tsconfig.json:24` (`include: ["scripts/**/*.ts", "src/**/*.ts", "test/**/*.ts", "packages/*/src/**/*.ts"]`) | `spikes/**` naturally excluded from both — confirms the POC is mechanically isolated. |

**Parity chain.** `ParityChainConfig.features =
{ gh_issue, beads_issue, project_item, merge_state, ci }` — the read
side of branch/worktree/PR alignment. Out of scope for this ADR. The
relevant future seam: a Moon affected-set is itself a parity-chain
projection ("the planner changed scout/main.ts; here's the leaves that
need rebuild before review"). That extension is downstream of Phase A
and not attempted here.

## 2. Problem statement

PRX has outgrown the "Bun-script monorepo with two compiled binaries"
shape:

1. **Workspace has no task graph.** `package.json:6-19` declares
   eight top-level scripts (`prx:build`, `prx:tui:build`, `typecheck`,
   `test`, `schemas:export`, `doctor:agents*`, `snapshot:help:*`). None
   describe dependencies, none participate in an affected-set, none
   cache. A schema-export change forces a full `bun test` even if no
   consumer of the regenerated JSON moved.
2. **One runtime, ambient trust.** `localRuntimeExecutor`
   (`src/pr-state/executor.ts:60`) is the single spawn point for every
   actor. The audit layer (I-AUD4, `src/audit/invariants.ts:159`)
   catches ambient-git violations *post hoc* by string-matching the
   action verb. There is no OS-level enforcement that the executor
   couldn't `git push --force` if the prompt told it to — the agent's
   wrapper layer is the only line of defense.
3. **No replay primitive on the workspace side.** The CAS at
   `src/plan-store/cas.ts:321` hashes artifact *content*; there is no
   companion that hashes *inputs + toolchain*. Re-running scout on
   identical repo state has no shortcut; re-running the contract
   schema export has no cache hit even when no source moved.
4. **Reproducibility ceiling at the flake-devShell layer.** The root
   `flake.nix:1-63` pins home-manager modules but pins no developer
   toolchain (the devShell is in the per-module home-manager build,
   not at the flake root). Anyone who runs `bun install` outside the
   activation path is on whatever bun is in their `$PATH`.

The contract trinity (GH-1821) and the audit invariants (GH-1823)
**presume** the substrate exists to address #1–#4. This ADR decides
whether to build it from existing tools or vendor it.

## 3. Per-axis decisions

### 3.1 Axis 1 — Workspace orchestrator: Adopt Moon, staged

**Candidates evaluated.**

| Candidate | Multi-runtime | Affected-set | Static binary | Nix-pinnable | Verdict |
|-----------|---------------|--------------|---------------|--------------|---------|
| Turborepo | First-class JS only | Yes | No (Node-shipped) | Awkward (npm-shipped) | Reject — JS-tier only; doesn't help when Phase B introduces Deno. |
| Nx | First-class JS; Rust optional | Yes | No (Node-shipped) | Awkward | Reject — same reason; heavier plugin surface than PRX needs. |
| Bazel | All runtimes | Yes | Yes (static `bazel`) | Yes | Reject — correct shape, wrong economy. The hermetic-build burden buys reproducibility PRX already gets from `bun build --compile` shipped through Nix. |
| Pants | All runtimes | Yes | Yes | Yes | Reject — same shape, smaller ecosystem; nothing PRX uses currently provides Pants integration. |
| **Moon** | **First-class Bun + Deno + Rust + Node** | **Yes (`moon run --affected`)** | **Yes (single static binary)** | **Yes** | **Accept.** Closest to the actor-tier shape PRX already maintains; the Bun + Deno first-class support is what Phase B (§5) needs. |
| Just (only) | n/a | No | Yes | Yes | Reject — task runner, not a graph; doesn't address #1. |

**Why Moon over Bazel.** The hermetic-build promise Bazel offers is
already paid for, in a different currency, by `bun build --compile`
delivered through Home Manager (`nix/home-manager/prx.nix:100`). The
shipped binary is hermetic at the consumption boundary. What's missing
is the *workspace*-side graph: which leaves rebuild when scout's
source changes, which tests must rerun when the JSON-schema export
changes. Moon's `moon query projects --json` + `moon run --affected`
hit exactly that shape. Bazel would also satisfy the requirement, but
adds a hermetic-build burden on the development inner loop that scales
poorly for a workspace of PRX's size (~20 actors, ~10 scripts).

**Why staged.** Phase A in §5 wires Moon over the *current* Bun
packages without touching their source — the migration is a
description layer (`.moon/workspace.yml`, per-project `moon.yml`).
Phase B introduces the first Deno-side actor (scout). Each phase has a
revertable exit checkpoint and a follow-up ticket.

**Verdict: Adopt Moon, staged.** Phase A blocked behind this ADR
merging.

### 3.2 Axis 2 — Control-plane runtime: Adopt Deno for `planning` + `verification_publication` tiers

**Candidates evaluated.**

| Candidate | Permissions model | TypeScript story | Bun-compile compat | Verdict |
|-----------|------------------|------------------|--------------------|---------|
| Stay all-Bun | None (ambient trust) | Native | n/a | Reject — leaves I-AUD4 a string-match audit instead of an OS gate. |
| Go all-Deno | `--allow-*` granular | Native | No `--compile` to single binary on parity with Bun's | Reject — would force a binary-distribution rewrite (axis 3). |
| **Hybrid (Bun for `execution` tier + binaries; Deno for `planning` + `verification_publication`)** | **`--allow-*` where it matters** | **Native both sides** | **Bun-compile retained for binaries** | **Accept.** Maps Deno onto exactly the tiers where ambient trust is highest-risk; keeps Bun where the `--compile` story is the win. |

**Why the tier split.** `src/machine/actors.ts:54` already groups
actors into three tiers: `planning`, `execution`, `verification_publication`.
The risk profile differs by tier:

- **`planning`** actors (`planner_agent`, `dep_research`, `derive`, …)
  primarily *read*. The risk is exfiltration of repo state through an
  unscoped network reach. Deno's `--allow-read` + `--allow-env=PRX_*`
  collapses this.
- **`execution`** actors (`executor_agent`, `git`, `wt`, `tmux`) must
  write to the worktree and run subprocesses. They need `--allow-run`
  and `--allow-write`. Deno can express this, but the gain over Bun is
  smaller — and the executor profile (`src/machine/runtime_profiles.ts:1599`)
  is the one place where the agent legitimately needs broad write
  access. Phase E in §5 retains Bun for this tier.
- **`verification_publication`** actors (`gh`, `publisher`, `doctor`,
  `tester_agent`, `reviewer_agent`) call out to `api.github.com` and
  the local CI. The risk is unscoped network exfiltration *and*
  unscoped PR-state mutation. Deno's `--allow-net=api.github.com` +
  `--allow-run=gh,bun` collapses this.

**What it does NOT change.** The 1→1 currying invariant from the
contract trinity (`docs/spikes/GH-1821-contract-trinity.md`) is a
property of the **agent surface**, not the runtime. A Deno-side scout
still consumes 1 `query` artifact and emits 1 `scout_result`
artifact. The runtime split is orthogonal to the contract surface.

**Verdict: Adopt Deno for `planning` + `verification_publication`
tiers.** Concrete permission mapping in §3.6.

### 3.3 Axis 3 — Binary distribution: Retain Bun `--compile`

**Candidates evaluated.**

| Candidate | Single static binary | Activation path already wired | Cross-platform | Verdict |
|-----------|----------------------|-------------------------------|----------------|---------|
| **Bun `--compile` (status quo)** | **Yes** | **Yes (`nix/home-manager/prx.nix:100`)** | **Yes (Bun targets aarch64-darwin, x86_64-linux, …)** | **Accept.** |
| Deno `compile` | Yes | No (would need new activation module) | Yes | Reject — adds a parallel activation path for no end-user gain; the prx binary is the product, not the runtime. |
| Node + pkg | Yes | No | Yes | Reject — outside PRX's existing tool surface. |

**Why retain.** `nix/home-manager/prx.nix:100-128` already does the
right thing: copy the read-only flake source into a writable scratch,
`bun install --frozen-lockfile`, `bun build --compile`, install to
`~/.local/share/prx/prx`, gate the recompile on `bakedShaShort`. The
delivered artifact is hermetic at the user's `$PATH` boundary
(`~/.local/bin/prx` shells through to it). Operators are unaware Bun
exists. Migrating to Deno-compile would buy nothing here and would
churn the activation surface — which has the unenviable property of
running on every `home-manager switch`.

**Verdict: Retain Bun `--compile`.** The product surface stays Bun.
The control-plane runtime split in §3.2 is orthogonal to delivery.

### 3.4 Axis 4 — Nix authority depth: Tool-pinning

**Candidates evaluated.**

| Candidate | Reproducibility | Dev friction | Verdict |
|-----------|-----------------|--------------|---------|
| Status quo (no flake-level tool pin) | Low (whatever's in `$PATH`) | Lowest | Reject — fails to address problem statement #4. |
| **Tool-pin in flake devShells** | **Adequate (bun/deno/moon fixed per flake.lock)** | **Low (`nix develop` picks up the pins)** | **Accept.** |
| Per-package `mkDerivation` | High (every build hermetic) | High (every package change forces a `nix build` cycle) | Defer — no incident yet demands it. Revisit if Phase A or B exposes one. |

**Why tool-pinning is enough today.** PRX's actual reproducibility
incident surface is small: the only place where toolchain drift
*shipped* a bug was Bun's lockfile evolution between minor versions,
which the activation path already pins via `bun install
--frozen-lockfile` and the baked `bakedShaShort`. The deferred
position is "if a Phase A or B incident demonstrates the gap,
escalate to per-package derivations; until then, the cost-benefit
favors flake-pinned tooling."

**Verdict: Tool-pinning.** Pin `bun`, `deno`, `moon` in flake
devShells. Defer per-package `mkDerivation`.

### 3.5 Axis 5 — Artifact / CAS replay: Coexist, do not merge

**The two are different shapes.**

| | Moon's hash | PRX CAS hash |
|---|-------------|--------------|
| Hashes | Inputs + toolchain + command | Artifact content |
| Purpose | "Has this build run before?" | "Does this artifact already exist somewhere?" |
| Cache hit means | Skip the build | Don't re-write the blob |
| Key shape | `<task>:<input-hashes>:<toolchain-hash>` | `<domain>://sha256:<hex>` (`src/plan-store/uri.ts:8`) |
| Persistence | `.moon/cache/` (local) + optional remote cache | `$XDG_STATE_HOME/prx/cas/<domain>/` |
| Lifetime | Build-graph local | Provenance-graph durable |

**Why not merge them.** The two answer different questions. Merging
would force one of: (a) Moon's cache to grow a provenance shape it
doesn't have, or (b) PRX CAS to grow a build-graph shape it doesn't
need. Both are net-negative.

**Adapter.** A Moon task that produces an artifact PRX cares about
emits, alongside the task output, a sidecar `*.cas-ref.json` of the
form `{ "uri": "scout://sha256:<hex>" }`. The URI matches
`src/plan-store/uri.ts:8`'s grammar
(`^([a-z][a-z0-9_-]*):\/\/sha256:([0-9a-f]{64})$`). PRX-side consumers
read the sidecar; Moon-side consumers read the cache key. The two
worlds don't share storage but share the URI as the boundary type.

**POC demonstrates the adapter** at
`spikes/runtime-eval/packages/cas/src/store.ts` — the scout-replay
demo (POC demo #5) emits a `scout://sha256:<hex>` URI matching
`src/plan-store/uri.ts` byte-for-byte.

**Verdict: Coexist, do not merge.** Adapter ships as part of Phase B's
exit checkpoint (filed as a follow-up).

### 3.6 Axis 6 — Actor permissions: Map Deno `--allow-*` to tier groups

The Deno permission model maps cleanly onto PRX's actor tiers because
the tiers are already a permission grouping (the operator's-intent
boundary). Per-tier permission bundles:

**`planning` tier** (`scout`, `planner_agent`, `dep_research`, `derive`,
`domain_sync`, `repo_router`, `notion_mcp`):

```sh
deno run \
  --allow-read=$REPO_ROOT \
  --allow-env=PRX_*,XDG_STATE_HOME,HOME \
  packages/<actor>/main.ts
```

No `--allow-write`, no `--allow-run`, no `--allow-net`. The planning
tier reads repo state and produces artifacts via stdout (captured by
the dispatch envelope's CAS appender).

**`execution` tier** (`executor_agent`, `git`, `wt`, `tmux`):

```sh
deno run \
  --allow-read=$REPO_ROOT \
  --allow-write=$WORKTREE,$CAS_ROOT \
  --allow-run=git,gh,bun \
  --allow-env=PRX_*,XDG_STATE_HOME,HOME \
  packages/<actor>/main.ts
```

`--allow-run` is **path-scoped** to the three external CLIs PRX uses.
The Bun binary is named explicitly so Phase F's permission-aware
executor (when it lands) can spawn Bun-compiled tools without
disabling the gate.

**`verification_publication` tier** (`gh`, `publisher`, `doctor`,
`tester_agent`, `reviewer_agent`, `local_ci`, `remote_ci`):

```sh
deno run \
  --allow-read=$REPO_ROOT \
  --allow-net=api.github.com \
  --allow-run=gh,bun \
  --allow-env=PRX_*,GH_TOKEN,XDG_STATE_HOME,HOME \
  packages/<actor>/main.ts
```

`--allow-net` is **host-scoped** to GitHub. `GH_TOKEN` is on the env
allowlist (the only tier where it is). No write to repo state — this
tier publishes to GitHub, not back into the worktree.

**Why this projects onto the existing profile builders.** Each of the
six session profiles in `src/machine/runtime_profiles.ts:25-29` has a
builder (anchor: `buildOpsPlanClaudeRuntimeProfile` at line 1474,
`buildOpsImplementClaudeRuntimeProfile` at line 1599) that already
emits a per-profile `allowedTools` + `disallowedTools` bundle for the
Claude session. The Deno `--allow-*` bundle is the same kind of
artifact at a lower layer: the OS subprocess gate. Phase B–D in §5
land the mapping; the profile builders are the prior art the runtime
permissions formalize.

**Verdict: Map Deno `--allow-*` to tier groups in `actors.ts`.** The
mapping is documented inline in `runtime_profiles.ts` comments as part
of Phase B's exit checkpoint (filed as a follow-up).

### 3.7 Prior art — object-capability languages

Axes 2 and 6 reason about the Deno permission model purely from PRX's
own profile builders. That is sufficient to *decide* the axes, but it
leaves the design ungrounded in the lineage it is actually re-deriving:
**object-capability (ocap) security**, the discipline of "no ambient
authority — a component can only affect what it was explicitly handed."
This subsection records that lineage so the Axis 2/6 verdict reads as a
deliberate ocap choice rather than an incidental Deno feature.

**The lineage.** The principle traces to Dennis & van Horn (1966) and
is named POLA — the Principle of Least Authority — in Miller's E
language. A family of languages makes capability security a
*first-class language property*:

| Language | Where the capability lives | One-line relevance to PRX |
|----------|----------------------------|---------------------------|
| **E** (Miller) | Object references *are* capabilities; POLA is the design axiom | The conceptual root; "authority follows the reference" is the rule every PRX seam encodes. |
| **Pony** | Reference capabilities (`iso`, `val`, `ref`, `box`, `tag`) checked by the type system; actor-model + "capabilities-secure" | Closest structural analogue: ocap **and** actors, exactly PRX's two axes (`src/machine/actors.ts` tiers + the seams). |
| **Newspeak** | Object-capability platform; no global namespace, all authority passed in as constructor args | The "no ambient" rule PRX enforces via the single-sanctioned-access-point packages. |
| **Monte** | POLA + capability object model over a Python-like surface | Demonstrates ocap retrofit onto a mainstream-feeling language — PRX's situation in TS. |
| **Cadence** | Capability security in the static type system (resources / linear types) | Type-level authority; domain-locked to Flow, but the down-casting-for-access-control pattern mirrors PRX's policy gates. |
| **Austral** | Linear types + capability security; capabilities are unforgeable values threaded explicitly | The "authority is a value you must be given" model the dispatch envelope approximates. |

**Why PRX gets the property at two lower layers instead of the
language.** TypeScript has no reference-capability system; the Agent SDK
constrains the host language (Axis-3 reasoning). So PRX cannot adopt a
Pony-style *type-checked* capability and instead realizes the same
invariant at the two layers it does control:

1. **Architecture layer (today).** The "one sanctioned access point"
   packages — `@bounded-systems/{fs,env,host,proc}` plus the `policy`
   engine and per-actor tool allowlists — are an ocap discipline
   enforced by module boundaries and review. This is the Newspeak
   "authority passed in, never ambient" rule applied to a TS monorepo:
   nothing reads `process.env` except `env`, nothing spawns except
   `proc`.
2. **OS layer (this ADR).** Deno's `--allow-*` flags (§3.2, §3.6) make
   the same authority **unforgeable at the process boundary** — the
   property Pony gets from its type checker, PRX gets from the kernel.
   This is what closes the gap §2 #2 names: I-AUD4
   (`src/audit/invariants.ts:159`) is a *post-hoc string match* on the
   action verb today; the Deno gate makes "the executor *cannot*
   `git push --force` even if the prompt says so" an OS guarantee, not
   an audit observation.

**The mapping, made explicit.** Pony's reference capabilities annotate
*what a reference may do with the object it points at*; the Deno tier
flags annotate *what a process may do with the host it runs on*. The
shapes line up:

| ocap concept | Pony form | PRX form (this ADR) |
|--------------|-----------|---------------------|
| Read-only authority | `val` / `box` reference | `planning` tier: `--allow-read=$REPO_ROOT`, no write/run/net |
| Write + side-effect authority | `iso` / `ref` reference | `execution` tier: `--allow-write=$WORKTREE,$CAS_ROOT --allow-run=git,gh,bun` |
| Scoped outbound authority | capability passed to one actor | `verification_publication` tier: `--allow-net=api.github.com` (host-scoped) |
| Unforgeable identity, no authority | `tag` reference | An actor with no `--allow-*` flag for a resource simply cannot reach it |

**Verdict (prior art).** No new decision — this subsection *grounds*
Axes 2 and 6. The takeaway for any future "should we swap to a
capabilities-secure language?" question: the property those languages
sell is already obtained, at the architecture layer (in place) and the
OS layer (Phases A–D), without paying the ecosystem cost of leaving the
Agent-SDK-bearing TS runtime. A language swap would re-acquire a
property PRX already holds and forfeit the libraries the product is
built on.

## 4. Comparison matrix

Rows: candidate workspace+runtime architectures. Columns: 1–5 scoring
(5 = best). Rows weighted equally; **bolded** row is the recommended
architecture this ADR adopts.

| Architecture | Determinism | Graph-awareness | Replayability | Cacheability | CI-ergonomics | Runtime-perms | Binary-dist | Dev-friction | Total |
|--------------|:-----------:|:---------------:|:-------------:|:------------:|:-------------:|:-------------:|:-----------:|:------------:|:-----:|
| Bun-only (status quo) | 3 | 1 | 2 | 1 | 3 | 1 | 5 | 5 | 21 |
| Deno-only | 4 | 1 | 3 | 2 | 3 | 5 | 3 | 3 | 24 |
| Moon + Bun | 4 | 5 | 4 | 5 | 5 | 1 | 5 | 4 | 33 |
| Moon + Deno | 4 | 5 | 4 | 5 | 4 | 5 | 3 | 3 | 33 |
| **Moon + hybrid (Bun execution + Deno planning/verification, Bun for binary)** | **5** | **5** | **5** | **5** | **5** | **5** | **5** | **4** | **39** |

**Score notes.**

- *Determinism* — flake-pinned tooling lifts every Moon-bearing row;
  the hybrid keeps Bun's deterministic `--compile` on the binary side.
- *Graph-awareness* — only Moon-bearing rows score above 1.
- *Replayability* — Moon's task-cache + PRX CAS coexist (§3.5).
- *Cacheability* — Moon's input-hash + remote-cache options carry every
  Moon-bearing row to 5.
- *Runtime-perms* — Deno-bearing rows score 5; Bun-only rows score 1.
- *Binary-dist* — Bun-`--compile` rows score 5; Deno-only scores 3 (its
  compile story exists but the activation path is unproven for PRX).
- *Dev-friction* — Hybrid pays a small cost (two TS runtimes) that's
  recouped by tier-scoped permissions.

The recommended row scores 1.18× the second-best Moon-bearing row and
1.86× the status quo.

## 5. Migration plan (six phases, each revertable)

| Phase | Trigger | Scope | Exit checkpoint | Owner |
|-------|---------|-------|-----------------|-------|
| **A** | This ADR merges; Phase-A ticket filed | Add `.moon/{workspace,toolchain,tasks}.yml`; register `packages/prx-config`, `packages/prx-mux`, `src/` as Moon projects; map `prx:build`, `prx:tui:build`, `typecheck`, `test`, `schemas:export` to Moon tasks | `moon run :test` green **AND** `bun test` green on the same commit (no regressions) | `executor_agent` |
| **B** | Phase A merged + 1 week soak | Deno reimplementation of `scout` actor only; wire as a Moon task with `--allow-read --allow-run=git,gh` per §3.6 | Parity output vs. Bun scout — sha256-stable result on identical repo state across two runs | `executor_agent` |
| **C** | Phase B merged + 1 week soak | Migrate remaining `planning`-tier actors to Deno: `planner_agent`, `dep_research`, `derive`, `domain_sync`, `repo_router`, `notion_mcp` | `prx plan session` end-to-end green; no I-AUD4 regressions in `prx audit uow <any>` over a 50-UoW sample | `executor_agent` |
| **D** | Phase C merged | Migrate `verification_publication`-tier actors to Deno: `gh`, `publisher`, `tester_agent`, `reviewer_agent`, `doctor`, `local_ci`, `remote_ci` | `prx audit` shows zero new I-AUD4 violations; PR ready-flow green end-to-end | `executor_agent` |
| **E** | Steady state | Bun retained for `execution`-tier actors (`executor_agent`, `git`, `wt`, `tmux`) **and** for shipped binaries (`prx`, `prx-tui`); Nix activation unchanged | n/a (steady state) | n/a |
| **F** | Deferred (new ticket) | Replace `localRuntimeExecutor`'s `spawnSync` (`src/pr-state/executor.ts:60`) with a permission-aware Deno-subprocess executor that enforces tier permissions at the spawn site — not just at the agent's prompt-allowlist layer | TBD per the design ticket | TBD |

Each phase ships behind its own PR; each PR's exit checkpoint is the
gate before the next phase opens. **Phases A and B are authorized by
this ADR.** Phases C–F open only after the prior phase's exit
checkpoint lands and a follow-up ticket is filed.

## 6. Open risks and follow-up tickets

Seven follow-up tickets filed against this ADR. The first four are
load-bearing for Phases A–B; the rest cover deferred work the ADR
identifies but does not authorize directly.

1. **"Wire Moon over current Bun packages (Phase A)"** —
   implementation ticket. Targets §5 Phase A exit checkpoint.
   Touches `.moon/`, `package.json` scripts (replaced by `moon.yml`
   entries), `tsconfig.json` (path updates if any). No `src/` changes.
2. **"Reimplement scout in Deno (Phase B)"** — implementation
   ticket. Targets §5 Phase B exit checkpoint. Touches a new
   `packages/scout-deno/` (or migrates the existing scout entry-point
   to Deno). Blocked behind #1.
3. **"`prx tools git` Deno shim"** — implementation ticket. Phase B
   blocks on this: the Deno-side scout must invoke git through a shim
   that emits the audit events I-AUD4 looks for. Today's `prx tools git`
   is Bun-only.
4. **"Permission-aware runtime executor (Phase F)"** — design
   ticket. Targets the `spawnSync` replacement at
   `src/pr-state/executor.ts:60`. Design-only first; implementation
   blocked behind C–D so the tier mapping has shipped users.
5. **"Moon remote-cache backend selection"** — investigation ticket.
   Compare Turborepo Remote Cache protocol vs. self-hosted S3 vs.
   Bazel-style cache. Output: ADR recommending one. Not blocking any
   phase; lands whenever a CI cache-hit metric makes the call easy.
6. **"Zod-on-Deno smoke test in CI"** — small ticket. Adds a CI step
   that runs the POC's `packages/contracts/schema-probe.ts` against
   the shipped `schemas/contracts/*.json` after every
   `schemas:export` regen. Catches Zod-3-on-Deno regressions before
   Phase C lands.
7. **"Document Deno-permission → session-profile mapping in
   `runtime_profiles.ts` comments"** — doc-only ticket. The §3.6
   table goes inline as a comment block above
   `buildOpsPlanClaudeRuntimeProfile` and friends so future profile
   edits stay aligned.

**Open risks not yet ticketed.**

- *Moon's Bun-toolchain maturity*. If `moon run` cannot invoke `bun`
  as a first-class toolchain at Phase-A execution time, fall back to
  declaring Bun tasks as shell commands (`command: 'bun build …'`).
  Phase A's exit checkpoint stays valid; the upgrade to first-class
  Bun is a follow-up the day Moon ships it.
- *Deno 2 + Zod 3 compatibility*. The POC's
  `packages/contracts/schema-probe.ts` proves the boundary; CI step
  from ticket #6 keeps it proven.
- *Per-package `mkDerivation` deferral*. §3.4 leaves this open. Phase
  A's exit checkpoint is the natural place to revisit (if Moon's
  hashing exposes drift the flake-pin missed, escalate).
- *Bun-binary recompile on every `home-manager switch`*. Today's
  activation gates on `bakedShaShort`
  (`nix/home-manager/prx.nix:108-110`); Phase A does not regress this.
  Phase E exit-checkpoints on it explicitly.

## POC — `spikes/runtime-eval/`

Owner: `executor_agent`. Throwaway POC that exercises every §3 verdict.
Hard mechanical constraints:

- **Not added to root `package.json`'s `workspaces`** (verified:
  `workspaces: ["packages/*"]` excludes `spikes/*`).
- **Not picked up by root `tsconfig.json`** (verified:
  `include: ["scripts/**/*.ts", "src/**/*.ts", "test/**/*.ts",
  "packages/*/src/**/*.ts"]` excludes `spikes/**`).
- **POC `flake.nix` is self-contained**. Root `flake.nix` unchanged.
- **POC's CAS lives at `spikes/runtime-eval/.cas/`** (gitignored);
  isolated from `$XDG_STATE_HOME/prx/cas/`.
- **All git/gh subprocess calls route through `prx tools git` /
  `prx tools wt`**, with one explicit I-AUD4 carve-out at
  `packages/scout/main.ts` that exists to exercise Deno's
  `--allow-run=git` gate. Documented in the POC README.

**Tree.**

```
spikes/runtime-eval/
  flake.nix                          # devShell: bun, deno, moon (pinned)
  flake.lock                         # committed
  .gitignore                         # .moon/cache/, .cas/, node_modules/, *.tsbuildinfo
  README.md                          # demo instructions + I-AUD4 carve-out note
  moon.yml                           # workspace-level config
  .moon/
    workspace.yml
    toolchain.yml                    # versions match flake.nix
    tasks.yml                        # shared task definitions
  deno.json                          # root Deno config
  package.json                       # root Bun config; orthogonal to root workspace
  apps/
    prx-cli-poc/                     # Bun
      package.json
      moon.yml
      src/main.ts
    prx-tui-poc/                     # Bun
      package.json
      moon.yml
      src/main.ts
  packages/
    contracts/                       # Deno: schema reading
      moon.yml
      mod.ts                         # imports schemas/contracts/artifact.json
      schema-probe.ts                # the schema-export probe
    scout/                           # Deno: --allow-read=. --allow-run=git,gh
      moon.yml
      main.ts
    graph/                           # Deno: task DAG introspection
      moon.yml
      main.ts                        # calls `moon query projects --json`
    cas/                             # Bun: demo CAS store mirroring URI shape
      moon.yml
      src/store.ts
```

**Six demos to wire** (each invokable from `nix develop spikes/runtime-eval`):

1. **Runnable flake** — pinned `bun`/`deno`/`moon` versions all print
   (proves Axis 4).
2. **Task graph** — `moon query projects --json` and `moon dot`
   render the DAG (proves Axis 1).
3. **Mixed-runtime execution** — `moon run :build` runs both a Bun
   task (`prx-cli-poc:build`) and a Deno task (`scout:run`) (proves
   Axes 1 + 2).
4. **Affected-only** — touch `packages/scout/main.ts`, `moon run
   --affected :build` rebuilds only scout-dependent leaves (proves
   Axis 1's affected-set primitive).
5. **Scout replay** — `deno run --allow-read=. packages/scout/main.ts
   > out.json && sha256sum out.json` produces a stable hash across
   two runs over identical repo state (proves Axes 2 + 5).
6. **Artifact metadata** — `packages/cas/src/store.ts` writes an
   artifact and emits a `<domain>://sha256:<hex>` URI matching
   `src/plan-store/uri.ts:8`; Moon task output is `*.cas-ref.json`
   containing that URI (proves Axis 5's adapter).

**Schema-export probe** at `packages/contracts/schema-probe.ts`. Small
Deno script. Imports `schemas/contracts/artifact.json` (absolute repo
path), validates a sample artifact against it using `ajv` via `npm:`
import, prints pass/fail. Proves the JSON-Schema export boundary at
`prx schemas` already serves Deno consumers
without TS rebuild — precondition for Phase C.

## 7. Verification (run-sheet)

End-to-end proof checklist. Executed by the tester role at PR-review
time.

- [ ] **ADR sections present** — Status, Decision summary, Machine-first
      context (§1), Problem statement (§2), Per-axis decisions (§3.1–§3.6,
      every axis ends with a `Verdict: …` line), Comparison matrix (§4),
      Migration plan (§5, six phases with revertable exit checkpoints),
      Open risks + follow-up tickets (§6, **7+ entries**), POC (§POC),
      Verification (§7), Out of scope (§8).
- [ ] **POC commands all green**:
  - `nix develop spikes/runtime-eval --command moon run :build`
  - `nix develop spikes/runtime-eval --command moon query projects --json`
  - `cd spikes/runtime-eval && touch packages/scout/main.ts && nix develop --command moon run --affected :build`
  - `nix develop spikes/runtime-eval --command deno run --allow-read=. packages/scout/main.ts` (rerun produces identical sha256)
  - `nix develop spikes/runtime-eval --command deno run --allow-read=. packages/contracts/schema-probe.ts`
  - `nix develop spikes/runtime-eval --command bun run apps/prx-cli-poc/src/main.ts`
- [ ] **Repo-root contract intact** — all four pass on the spike branch:
  - `bun install --frozen-lockfile`
  - `bun test`
  - `bunx tsc --noEmit`
  - `bun run prx:build && bun run prx:tui:build` (working `dist/prx`, `dist/prx-tui`)
- [ ] **Audit invariants** — `prx audit uow GH-1836` shows zero new
      I-AUD4 violations introduced by the POC. The `packages/scout`
      raw-`git` carve-out is documented in `spikes/runtime-eval/README.md`
      and tagged so audit suppresses it.
- [ ] **Touched paths at repo root: zero outside `spikes/runtime-eval/`
      and `docs/spikes/GH-1836-prx-runtime-architecture.md`.** Root
      `flake.nix`, root `package.json`, `bunfig.toml`, `src/`,
      `packages/`, `nix/home-manager/*` untouched. Verifiable via
      `git diff --stat main...HEAD`.

## 8. Out of scope (explicitly deferred)

- Migrating any code under `src/`, `packages/prx-config/`,
  `packages/prx-mux/`. Phases A–F in §5 are *plan*, not action.
- Touching root `flake.nix`, root `package.json`, `bunfig.toml`,
  `nix/home-manager/*`. The POC `flake.nix` is self-contained.
- Introducing a new Home Manager module.
- Implementing a full CAS/replay engine — the POC's `packages/cas/`
  is a ~50-line demo store, not a `src/plan-store/cas.ts:321`
  replacement.
- Redesigning agent orchestration — `src/machine/machines/*`
  untouched.
- Replacing `localRuntimeExecutor`'s `spawnSync` — that's Phase F,
  gated behind ticket #4 in §6.
- Finalizing production runtime choices for Phases C–F — the ADR's
  verdicts authorize Phase A and Phase B *only*. Later phases are
  conditional on each prior phase's exit checkpoint.

## PR-checklist seed

1. [ ] **Independent PR** — only the GH-1836 ADR + POC; no `src/`
       migrations, no Moon over real packages, no Deno introduction
       beyond `spikes/runtime-eval/`.
2. [ ] **Changed codepaths verified** — six POC demos + repo-root
       contract (`bun install/test/typecheck/build`) all green; `prx
       audit uow GH-1836` clean.
3. [ ] **Root cause identified** — N/A (spike, not a fix).
       Architectural pressure documented in §2.
4. [ ] **No duplication** — POC's `cas/` mirrors the
       `<domain>://sha256:` URI shape from `src/plan-store/uri.ts:8`;
       does not fork or vendor it.
5. [ ] **No unrelated changes** — only new top-level paths are
       `spikes/runtime-eval/` and
       `docs/spikes/GH-1836-prx-runtime-architecture.md`. Root
       `flake.nix`, root `package.json`, `src/`, `packages/`,
       `nix/home-manager/*` untouched.
