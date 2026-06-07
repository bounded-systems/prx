# Local CI in the pipeline — the `checking` gate + where health/OTEL belongs

**Status:** shipped. Slices 1–4 implemented (the signed `checking` gate, the real
`prx ci` seam, seam telemetry + the `prx ci` timeout, and the anchored telemetry
digest in the signed summary) plus the operator surface (`prx observe`); the
canonical pipeline overview now lives in
[`pipeline-orchestrator.md`](./pipeline-orchestrator.md) — this doc is the
detailed design + rationale it links to. Pairs with the `ci: add job timeouts`
workflow-hygiene PR and the act local-CI work (`docs/local-ci.md`).

This answers two asks:

1. Put **local CI (`prx ci`)** into the signed pipeline as a real gate.
2. Decide **where health verification (heartbeat / OTEL) sits in the chain.**

The short version: local CI becomes a new **deterministic, signed `checking`
gate** between `executing` and `testing`, mirroring the existing remote CI gate.
Health/heartbeat/OTEL is **observability, not a chain gate** — it rides the
telemetry seam (`recordEvent` → log → NATS → OTel), and only touches the signed
chain as an *anchored* `observed@<leg>` side-link, never as a merge gate.

---

## 1. Where the pipeline checks today (and the gap)

The pilot machine (`packages/prx/src/machine/machines/pilot.ts`) drives one unit:

```
intaking → planning → executing → testing → reviewing → awaiting_ci → ready_to_merge → sealing → merged
   0          1           2          3          4           5              6              7
```

Every step emits a signed in-toto link; `sealing` mints a `prx.pilot/v1` summary
over the whole chain. There are two kinds of step:

- **LLM legs** (`runLeg`): planner/executor/tester/reviewer — a headless
  `query()` against a scoped subagent (`pilot.ts:319-322`, `pilot-real.ts:151`).
- **Deterministic seams**: `intaking` (`prx intake source`), `awaiting_ci`
  (`prx scout ci`), `ready_to_merge` (`prx publisher merge`) — plain shell-outs
  that sign a link, no LLM (`pilot-real.ts:244,282,303`).

Today there are **three** check points, and **none of them runs the real CI
surface** (`install → typecheck → docs → build → test`, i.e. `prx ci`):

| Where | What it runs | Signs | Source |
| --- | --- | --- | --- |
| executor opportunistic checks | typecheck + test | `checks/v1` (only on success) | `cli.ts` `IMPLEMENT_CHECK_STEPS` |
| `test-gate` | typecheck + test | `gate@test` (always) | `pr-state/test-gate.ts` |
| `awaiting_ci` | **remote** GitHub CI | `gate@ci-remote` | `pilot-real.ts:244` |
| `tester` leg | LLM *validation* (reads, comments) | `gate@ci` ⚠️ | `pilot.ts:42`, `tester.md` |

Two problems:

- The **full CI surface only runs remotely.** A docs-drift or build break is
  caught after the push, on the PR — not before. The local gates run a *subset*.
- The `tester` role **signs `gate@ci`** but is an LLM validator that doesn't run
  the checks — a naming/semantics smell next to `gate@ci-remote`.

## 2. The `checking` gate

Add a new **deterministic signed gate** `checking`, run by a `runChecks` seam
that shells `dist/prx ci` and signs `<unit>:gate@checks-local`. It mirrors
`buildRealCiGate` almost exactly — same shape, local instead of remote.

```
intaking → planning → executing → checking → testing → reviewing → awaiting_ci → ready_to_merge → sealing → merged
   0          1           2          3          4         5             6              7              8
```

- **Placement: after `executing`, before `testing`.** Fail fast on the real CI
  surface *locally* before spending the (LLM) tester/reviewer legs and before the
  remote CI gate. `executing` advances to `checking` (was `testing`).
- **On red → retreat to `executing`** (spend retreat budget), exactly like
  `awaiting_ci` red (`pilot.ts:345-358`). On green → `testing`.
- **Signs** `<unit>:gate@checks-local`, predicate `checks.passed|checks.failed`,
  over `sha256(prx ci output)` — same `signStageLink` path as the other seams.

### Deterministic seam, not an LLM `checker` role

`prx ci` is deterministic, so the gate should be a **seam** (like intake/ci-gate),
not an LLM subagent. It's still a "new signed leg" in the pipeline — it just
doesn't burn a model call or introduce nondeterminism. (An LLM `checker` role
would add a `TaskRole`, an agent definition, cost, and flakiness for zero gain.)

### Termination proof stays intact

The well-founded measure is `[retreatBudget, MERGED_RANK − rank]` (`pilotMeasure`,
`pilot.ts:163`). `checking` slots in like `awaiting_ci`:

- forward (`checking → testing`): budget unchanged, distance ↓.
- retreat (`checking → executing` on red): budget ↓ (dominates).

Mechanical changes: insert `checking: 3` and shift `testing..sealing` to `4..8`
in `pilotPhaseRank`; bump `MERGED_RANK` 8 → 9; update the proof comment. No new
cycle, no new unbounded edge — the proof is preserved by construction.

### Naming cleanup (sub-decision)

With a real local gate, the names are disambiguated: local = `gate@checks-local`,
remote = `gate@ci-remote`, and the `tester` LLM leg now signs `review@validated`
(was the ambiguous `gate@ci`). **Decided:** `tester` stays an LLM validation leg
after `checking` (the deterministic gate runs the checks; the tester leg reviews)
— not folded in.

## 3. Where health / heartbeat / OTEL belongs

**The signed chain is authority; telemetry is observability. They are
orthogonal, and health must never gate a merge.** (Same split as
`docs/capability-orchestrator.md` / the XState-vs-chain distinction: XState +
telemetry surface *what's happening*; the signed DAG decides *what's allowed*.)

What already exists (GH-261, `pilot-real.ts:76-101,160-209`): a per-leg
**heartbeat** (turns/chars/elapsed/last-snippet) and an **IDLE watchdog**
(`DEFAULT_PILOT_LEG_IDLE_MS = 5min`) feeding `recordEvent("TELEMETRY_LEG_OBSERVED")`.
A silent leg trips the watchdog → the leg throws → the pilot **retreats**
(budget-bounded). That is liveness *enforcement* — the operational complement to
the termination *proof* (which only assumes legs terminate).

Three gaps and where each lands relative to the chain:

1. **Heartbeat coverage** — the heartbeat is on **LLM legs only**. The
   deterministic seams (intake, the new `checking`, ci-gate, merge) emit nothing
   while they shell out. Fix: emit `TELEMETRY_LEG_OBSERVED` around each seam
   (start/finish + elapsed). **Off-chain** — pure telemetry.

2. **Watchdog parity = the pipeline's `timeout-minutes`.** LLM legs have the IDLE
   watchdog; deterministic seams have **no timeout** (a hung `prx ci` or a stuck
   poll hangs the machine — the same failure the workflow `timeout-minutes` PR
   just fixed for GitHub jobs). Fix: a hard per-seam timeout; on trip → throw →
   budget-bounded retreat. **Off-chain** (it's a guard), but it protects the
   chain's liveness.

3. **OTEL** — `recordEvent` is the seam; the roadmap is log → NATS → OTel
   (`docs` / observability epic). OTEL **spans mirror the XState leg lifecycle**
   (one span per state; heartbeats as span events; errors as span status), and
   carry the chain subject/digest as *attributes* for correlation. OTEL does
   **not** go in the chain — it's the projection of it.

### The one place health touches the chain: an anchored `observed@` side-link

If you want health to be **verifiable / tamper-evident** (not just emitted),
don't put raw telemetry on the chain and don't sign per event. **Anchor** it:
hash-chain each leg's telemetry batch and sign **one** `<unit>:observed@<leg>`
link (one ed25519 sig per leg), referenced by digest from the `prx.pilot/v1`
summary. That gives a cryptographic pointer "this is the health stream that
accompanied this leg" — verifiable, cheap, and still **never a gate**.

So: **gates** (`gate@checks-local`, `gate@ci-remote`) decide merge; **health**
lives off-chain as telemetry/OTEL, optionally pinned to the chain as an anchored
`observed@<leg>` side-attestation. Heartbeat-missing → watchdog/retreat (a
liveness guard), *not* a failed gate.

### Observing a run today (operators)

Every leg heartbeat (`TELEMETRY_LEG_OBSERVED`) and seam start/done
(`TELEMETRY_SEAM_OBSERVED`) is written as a `catalog-event` row to the daily
audit NDJSON sink — `$XDG_STATE_HOME/prx/audit/<YYYY-MM-DD>.ndjson` (default
`~/.local/state/prx/audit/`). So a run is observable with nothing more than
`tail`/`jq`:

```bash
# Live: follow a pilot as it runs, filtered to one unit's telemetry
tail -f ~/.local/state/prx/audit/$(date +%F).ndjson \
  | jq -c 'select(.event|startswith("TELEMETRY_")) | select(.workUnitId=="GH-123")
           | {ts, event, d:.details}'

# Or mirror every audit row to stderr as it's emitted
PRX_AUDIT_STDOUT=1 prx pilot GH-123
```

> Until this PR, `TELEMETRY_SEAM_OBSERVED` was **not registered in
> `eventOwnerMap`**, so the default sink threw `unknown catalog event` and the
> best-effort wrapper swallowed it — seam telemetry never reached the log.
> Registering it (owner `telemetry`) is what makes the seam stream observable.

Or read a unit's timeline directly:

```bash
prx observe GH-123            # all TELEMETRY_* rows for the unit (legs + seams)
prx observe GH-123 --limit 20 # just the most recent 20
```

`prx observe` is a read-only projection of that same NDJSON (`audit/observe.ts`
→ the `observe` orchestrator verb) — never a gate, just a view.

## 4. Implementation slices

To be filed as a bd epic once beads is back (the Dolt server is currently
unreachable). Each is an independent, testable PR.

1. **✅ Machine: `checking` state.** `runChecks` dep + default auto-pass stub;
   `checking` inserted between `executing`/`testing` (a shared `gateState` helper
   now backs both `checking` and `awaiting_ci`); `pilotPhaseRank` renumbered,
   `MERGED_RANK` 8→9, proof comment updated. Machine test: red `prx ci`
   retreats and never reaches merged. (`pilot.ts`, `pilot.test.ts`)
2. **✅ Real seam: `buildRealChecks`.** Resolves the implement worktree via
   `openSession` and runs `prx ci` THERE; signs `gate@checks-local`; non-zero
   exit → `passed:false`. Wired into `buildRealPilotDeps`. Tests mock
   `runPrx`/`openSession` and assert a verifiable ed25519 link + retreat on red.
   (`pilot-real.ts`, `pilot-real-tail.test.ts`)
3. **✅ Telemetry parity + checks timeout.** `RunPrx` gained an optional
   `timeoutMs`; the checks seam runs `prx ci` under a hard cap
   (`DEFAULT_PILOT_CHECKS_TIMEOUT_MS`, env `PRX_PILOT_CHECKS_TIMEOUT_MS`) — on
   timeout the spawn is killed → red → retreat (the pipeline analogue of a job
   `timeout-minutes`). An `observeSeam` decorator emits `TELEMETRY_SEAM_OBSERVED`
   (start/done/error + elapsed) around every deterministic seam, with an
   injectable sink (`onSeamObserved`) mirroring `onLegHeartbeat`. (`pilot-real.ts`,
   `pilot-real-tail.test.ts`)
   - **Still open:** timeouts on the intake/merge seams (quick GH calls; the CI
     gate is already bounded by `maxPolls`) — add if they ever hang in practice.
4. **✅ Anchored telemetry digest.** Implemented even cheaper than a separate
   `observed@<leg>` link: all telemetry (seam start/done + leg heartbeat) folds
   into a per-unit hash chain (`h = sha256(prev + json(entry))`), and its head is
   carried in the `prx.pilot/v1` summary predicate as `observed: { digest,
   count }`. The pilot's *existing* summary signature commits to it — **zero
   extra signatures**, tamper-evident, and never a gate (absent ⇒ no field, so
   it's back-compatible). (`pilot.ts` `observedAnchor`, `pilot-real.ts`
   `createTelemetryAnchor`)
5. **✅ Naming cleanup (partial).** `tester` now signs `review@validated`; local
   gate is `gate@checks-local`, remote stays `gate@ci-remote`.
6. **✅ Docs.** Folded the canonical overview (checking gate, the two hard-block
   gates, observability + `prx observe`) into
   `docs/prx/pipeline-orchestrator.md`; this doc remains the linked design detail.

Shipped: **slices 1 + 2 (+ the §2 naming)** — local CI is now a signed gate in
the pipeline. 3–4 harden health (incl. the deferred `prx ci` timeout); 6 is
cleanup.
