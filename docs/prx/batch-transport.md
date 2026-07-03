# ADR — the Message Batches API as a second model-call transport

> Status: **proposed**. Spec/design, not build. Scopes the lift to route
> prx's single-shot classifier surfaces (`triage type-pass`,
> `triage prioritize-bulk`, and eval fan-outs) through the asynchronous
> [Message Batches API](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
> for the 50% batch discount and a collapsed serial wall-clock. Does **not**
> touch the agentic surfaces (`plan`, `implement`, executor, pilot legs). See
> *Alternatives* for why "just add a flag" isn't the shape.

## Problem

Every model call prx makes today flows through **one transport**:
`@anthropic-ai/claude-agent-sdk`'s `query()`, wrapped by
`runClaudeAgentNonInteractive` (`packages/prx/src/claude/agent_service.ts`)
and dispatched from a `RuntimeProfileProjection` via `executeAgentProfile`
(`packages/prx/src/pr-state/executor.ts`). That path is a subprocess /
agentic-loop transport: streamed assistant deltas, an idle watchdog
(`armWatchdog`), live operator cancellation, `submit_plan` MCP capture, and a
per-run usage/audit row (`appendAuditRow`). It is the right shape for
interactive, latency-sensitive, tool-using work.

It is the wrong shape for the **classifier surfaces**, which are already
batch-shaped and pay for it:

- `prx triage type-pass` (`packages/prx/src/triage/type-pass.ts`) chunks the
  type-less issue queue, packs each chunk into **one Haiku prompt** (a JSON
  array of `{number, title, currentLabels}`), then runs the chunks in a
  **synchronous sequential `for` loop** (`type-pass.ts:400`).
- `prx triage prioritize-bulk` (`packages/prx/src/triage/prioritize-bulk.ts`)
  does the same over the priority axis (`prioritize-bulk.ts:396`).

These calls are tool-free, single-shot, order-independent (every row is keyed
by issue number), and entirely latency-tolerant — nobody is watching a
type-pass stream. Running them one chunk at a time through the interactive
transport pays full synchronous price for a workload the
[Batches API](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
was built for: **50% cheaper input and output**, submitted once, retrieved by
`custom_id`.

The catch that sets the lift: **batch is not a mode of the SDK prx already
uses.** `messages.batches.*` lives on the raw `@anthropic-ai/sdk`, which prx
does not depend on directly — it is only a transitive *peer* dep of the agent
SDK and is not installed at top level. So "prx can use batch" is not a flag on
the existing path. It is a **second, parallel model-call transport** with its
own lifecycle (submit → poll `processing_status` → stream `.jsonl` results),
its own 24-hour processing window, and its own credential model.

## Why the ratchet is already an async queue

The classifiers are the *easy* fit, but they are not the reason batch belongs
in prx. The reason is structural: **prx ratchets on artifacts, and humans are
never inside the agentic loop.** A pipeline leg's contract is "produce a signed
artifact" — the headless planner's `submit_plan` → `PlanArtifact`
(`agent_service.ts`'s capture seam), a `checks/v1` CI derivation, a findings
attestation, a predicate-bundle member. The workflow advances **only** when
that artifact appears and verifies (`canEnterReadyToMerge()` and the
predicate-bundle verdict, `docs/prx/predicate-bundle-verdict.md`). Humans and
actors interact *with the artifact*, asynchronously — never by sitting in a
synchronous model stream.

That is an async queue already. A leg that emits an artifact does not care
whether the model produced it in eight seconds on an open connection or forty
minutes in a batch worker — the ratchet is watching the artifact, not the
socket. The 24-hour batch window, which would be intolerable for an interactive
plan session, is a non-event for an artifact-gated leg: the unit of work is
"submit → artifact lands → verify → advance," and batch is a faithful transport
for exactly that unit.

So the async-queue framing raises the ceiling of what is *worth* batching from
"tool-free classifiers" to "**every non-interactive, artifact-producing leg**."
What keeps the near-term scope narrow is not the interaction model — it is the
transport gate in the next section.

## What fits, and what can't

The dividing line is **not** agentic-vs-classifier — it is *interactive* vs
*artifact-producing*, crossed with the transport each surface runs on today.

| Surface | Shape | Batch fit |
| --- | --- | --- |
| `triage type-pass` | chunked Haiku classify, serial loop | **direct** — already raw-Messages-shaped |
| `triage prioritize-bulk` | chunked Haiku classify, serial loop | **direct** — already raw-Messages-shaped |
| eval / claims-audit fan-outs | many independent scoring calls | **direct** |
| headless plan capture, headless executor | agentic, but artifact-gated ratchet leg | **strategic** — fits the async queue; gated by transport |
| `session open`, `plan session --interactive` | human in the stream | **no** — needs streaming / live feedback |

Two distinctions, not one:

- **Interactive surfaces (`session open`, `--interactive`) genuinely can't
  batch.** A human is in the stream; a 24-hour turnaround defeats the point.
  These stay on `query()` unconditionally.
- **Non-interactive agentic legs (headless plan capture, headless executor)
  fit the async-queue model** — their contract is "produce an artifact," and
  per *Why the ratchet is already an async queue* nothing waits synchronously.
  The docs confirm server tools and the agentic loop run *inside* a batch (with
  `pause_turn` continuation), so the interaction model is not the blocker. **The
  transport is.** prx runs those legs through the `claude` CLI subprocess driven
  by the agent SDK, not a loop over raw Messages, and `messages.batches` is raw
  Messages. Batching them requires either the agent SDK growing a batch mode, or
  reconstructing the loop over `messages.batches` + `custom_id` + `pause_turn`.
  That is real work — hence *strategic*, not near-term.

The classifiers are the near-term win because they are **already** the shape
`messages.batches` accepts (single-shot, tool-free, one Messages request per
`custom_id`), so routing them costs no loop reconstruction. The artifact-ratchet
legs are the target the async-queue framing unlocks once the transport gate is
paid down.

## Decision

Introduce a second transport — a `batch_service.ts` sibling to
`agent_service.ts` — and route only the classifier surfaces through it, behind
an explicit lifecycle flag. The interactive path is untouched.

```
                        ┌─ query()  ──────────────► plan / implement / executor / pilot
RuntimeProfileProjection┤   (agent SDK, streaming, watchdog, submit_plan)
                        └─ messages.batches ──────► triage classifiers / eval fan-outs
                            (raw SDK, submit → poll → results-by-custom_id, 50% off)
```

- **`src/claude/batch_service.ts`** — mirrors `agent_service.ts`'s typed-result
  contract: `submit(requests)` → `poll(batchId)` → `results(batchId)`, each
  request carrying a `custom_id` and the standard Messages `params`. Returns
  the same `UsageTelemetry` shape and emits the same audit rows via
  `appendAuditRow`, so batch runs are inspectable through the existing sink.
- **Classifier call sites swap the serial loop for one submit + a poll loop.**
  `type-pass.ts` / `prioritize-bulk.ts` keep their prompt-building,
  `parseHaikuEnvelope`, audit rows, and the bd reconcile chain
  (`runBeadsSync`). Only the dispatch changes: instead of N sequential
  `executeAgentProfile` calls, one `submit` with N `custom_id`-keyed requests,
  then re-join results to candidates by `custom_id`. The API's
  order-independence is a non-issue — these sites already key everything by
  issue number.
- **Lifecycle is an explicit surface, not a hidden block.** v0 exposes a
  blocking form (submit, poll until `ended`, apply — cheapest) and an
  `--async` form (submit, print the `batch_id`, exit), with
  `prx triage batch-status` / `batch-results` verbs to reattach. This keeps the
  24-hour window a first-class operator concern rather than a wedged CLI.

## The lift, in tiers

- **Tier 0 — the transport (foundation), ~2–4 days.** Add `@anthropic-ai/sdk`
  as a direct dep; write `batch_service.ts` with the submit/poll/results
  contract and audit-row parity; decide where the `{batch_id, custom_id →
  work-item}` map lives across the poll window (a blocking command needs only
  in-memory state; a durable/resumable job needs a store — there is no generic
  job store today, and the `beadsd`/`keeperd` daemons are for other concerns).
- **Tier 1 — route the classifiers, ~2–3 days on top of Tier 0.** Swap the
  serial loops in `type-pass.ts` and `prioritize-bulk.ts`; add the
  `--async`/blocking flag and status/results verbs. This is where the 50%
  saving and the collapsed wall-clock actually land.
- **Tier 2 — generalize, ~1 week+.** A reusable batch-job abstraction (durable
  store, resume, cancel wired to the cancel endpoint,
  `prx runtime-profile`-inspectable like the SDK path) so future
  many-independent-call surfaces (evals, bulk labeling, doc generation) opt in
  without re-solving lifecycle. Most of the total cost lives here; defer it
  until a second consumer exists.

**Honest total for a real v0:** ~1 week (Tier 0 + Tier 1) — the classifiers on
batch behind an explicit lifecycle flag. It earns its keep *because* those
flows are already prompt-batched, tool-free, and latency-tolerant.

## Gotchas to decide up front

- **Credentials.** The agent SDK authenticates via the bundled `claude` CLI
  (OAuth). `messages.batches` wants a workspace `ANTHROPIC_API_KEY`, and
  batches are **workspace-scoped** (visible only to keys in that workspace).
  This is a deliberate credential decision, not a reuse of the existing auth.
- **Lifecycle persistence.** Blocking poll vs. a durable resumable job across
  the 24-hour window is a design call that decides whether this stays a 1-week
  job (Tier 1) or grows into Tier 2.
- **Unsupported params.** Batch rejects `stream`, `speed`, `store`,
  `previous_thread_event_id`, `cache_hint`/`context_hint`, `max_tokens: 0`, and
  `research_preview_2026_02`. The classifier requests use none of these, but a
  generalized Tier 2 submitter should validate against the list.
- **Best-effort caching.** The classifiers rely on a cache-stable system prompt
  (`buildTriageHaikuClassifierRuntimeProfile` puts `TYPE_PASS_SYSTEM_PROMPT` in
  `systemPromptStable`). In batch, cache hits are best-effort (30–98%); keep the
  identical `cache_control` prefix across every request in a submission and,
  for large runs, weigh the 1-hour cache duration.

## Alternatives considered

- **Add a `--batch` flag to the existing SDK path.** Rejected: the agent SDK's
  `query()` does not expose `messages.batches` at all. There is no flag to add;
  batch is a different SDK and a different lifecycle.
- **Batch the non-interactive agentic legs now.** Deferred, not rejected: the
  artifact ratchet makes headless plan capture and the headless executor a
  genuine async-queue fit (see *Why the ratchet is already an async queue*), but
  they run on the CLI-subprocess transport, so batching them means the agent SDK
  gaining a batch mode or reconstructing the loop over raw Messages +
  `pause_turn`. Sequenced behind the classifiers, which need neither.
- **Batch the interactive surfaces.** Rejected outright: a human in the stream
  cannot wait on a 24-hour window; `session open` / `--interactive` stay on
  `query()`.
- **Do the full generic job abstraction first (Tier 2 up front).** Rejected as
  premature: with a single consumer (the triage classifiers), a blocking or
  `--async` command captures the value; the durable store earns its complexity
  only when a second surface needs it.
