// GH-1397 — generic drain harness for the structured handoff queue.
//
// One adapter ships in this ticket: `noop`. Real recipients (publisher,
// triage, submit, author) land in their own tickets. The harness owns:
//
//   1. Pull oldest `pending` row for a target actor.
//   2. CAS claim (machine guard `notAlreadyClaimed` + store-side fresh read).
//   3. Drain-time re-auth via `checkPolicy` at the recipient role (I-HQ2).
//   4. Invoke the adapter; turn `{ok:false}` into HANDOFF_FAILED.
//   5. Drive the machine through DRAIN_STARTED → DRAIN_SUCCEEDED|DRAIN_FAILED.
//   6. Persist the resulting envelope (status: done | failed | abandoned).
//   7. Emit HANDOFF_* audit rows via `appendAuditRow` (I-HQ1, I-AUD1).
//
// The harness is dependency-injected end-to-end: the store I/O via the
// injectable store functions, the audit sink via appendAuditRow. Production
// code gets defaults; tests can swap any of them.
//
// GH-1012: the bd-backed handoff store (`./store.ts`) was removed with the
// beads machinery. GitHub is now the write plane and Front Desk the read
// plane; there is no bd memory surface for the structured handoff queue, so
// the store operations below are local inert shims. The harness — adapter
// registry, drain-time policy re-auth, machine wiring, audit emission —
// stays intact and compiling until a non-bd handoff store lands.

import { createActor } from "xstate";

import type {
  HandoffDrainOutcome,
  HandoffEnvelope,
  HandoffTargetActor,
} from "@bounded-systems/machine-schema";

import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { handoffMachine } from "../machine/machines/handoff.ts";
import { checkPolicy as defaultCheckPolicy } from "@bounded-systems/policy";

// ── handoff store shims (GH-1012) ────────────────────────────────────────────
//
// The bd-backed handoff store (`./store.ts`) was removed with the beads
// machinery and has no non-bd replacement, so these local no-ops stand in for
// its persistence surface. They preserve the store's injectable dependency
// shape and function signatures so the drain harness keeps compiling; with no
// store to read, `listHandoffs` yields nothing and the drain loop is inert.

export type HandoffStoreDeps = {
  execBd?: unknown;
  /** Override for tests that want to bypass real CAS writes. */
  casWriteBlob?: ((content: string, domain: string) => Promise<{ sha: string }>) | undefined;
  now?: (() => Date) | undefined;
  currentRepoSlug?: (() => string) | undefined;
};

type ListOptions = {
  target?: HandoffEnvelope["targetActor"];
  workUnitId?: string | null;
  status?: HandoffEnvelope["status"];
};

type ClaimResult =
  | { kind: "claimed"; envelope: HandoffEnvelope }
  | { kind: "already-claimed"; by: string }
  | { kind: "not-found" }
  | { kind: "write-failed"; error: string };

async function listHandoffs(
  _opts: ListOptions = {},
  _deps: HandoffStoreDeps = {},
): Promise<HandoffEnvelope[]> {
  return [];
}

async function claimHandoff(
  _id: string,
  _claimant: string,
  _claimTtlSec: number,
  _deps: HandoffStoreDeps = {},
): Promise<ClaimResult> {
  return { kind: "not-found" };
}

async function writeEnvelope(
  _envelope: HandoffEnvelope,
  _exec?: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return { ok: true };
}

// ── adapter contract ───────────────────────────────────────────────────────

/**
 * A recipient adapter consumes one envelope and returns success/failure.
 *
 * `policyHint` (optional) is what makes I-HQ2 enforceable on the harness
 * side: when set, the harness re-runs `checkPolicy(tool, subcommand, state,
 * role)` against the *recipient's* role before invoking the adapter. A deny
 * at this seam turns into `DRAIN_FAILED { error: "drain-time-policy-deny" }`.
 *
 * Adapters that wrap entirely outside the policy table (e.g. `noop`) leave
 * `policyHint` undefined; the recipient is the trust boundary.
 */
export type RecipientAdapter = {
  /** Optional drain-time policy gate. See I-HQ2. */
  policyHint?: (envelope: HandoffEnvelope) => {
    tool: "git" | "gh" | "wt" | "bd" | "prx";
    subcommand: string;
    state: "planning" | "validating" | "merging";
    role: "planner" | "executor" | "reviewer" | "tester";
  } | null;
  /** Apply the envelope. */
  apply: (envelope: HandoffEnvelope) => Promise<HandoffDrainOutcome>;
};

// ── adapter registry ──────────────────────────────────────────────────────
//
// One adapter ships in GH-1397 — `noop`. Real recipients register via
// `registerAdapter` from their own tickets.

const REGISTRY: Map<HandoffTargetActor, RecipientAdapter> = new Map();

export function registerAdapter(target: HandoffTargetActor, adapter: RecipientAdapter): void {
  REGISTRY.set(target, adapter);
}

export function getAdapter(target: HandoffTargetActor): RecipientAdapter | undefined {
  return REGISTRY.get(target);
}

export function clearRegistryForTests(): void {
  REGISTRY.clear();
  registerNoopAdapter();
}

/**
 * GH-1397 default adapter. Resolves every envelope as `{ok:true}` without
 * side effects. Exists so the end-to-end drain path is exercisable from
 * day one; real recipients ship in their own tickets.
 */
export const noopAdapter: RecipientAdapter = {
  apply: async () => ({ ok: true }) as const,
};

function registerNoopAdapter(): void {
  REGISTRY.set("noop", noopAdapter);
}
registerNoopAdapter();

// ── drain ──────────────────────────────────────────────────────────────────

export type DrainDeps = HandoffStoreDeps & {
  appendAuditRow?: typeof defaultAppendAuditRow | undefined;
  checkPolicy?: typeof defaultCheckPolicy | undefined;
};

export type DrainOptions = {
  target: HandoffTargetActor;
  claimant?: string;
  claimTtlSec?: number;
  /** Max number of envelopes to drain. Default: 1 (single-shot). */
  max?: number;
};

export type DrainResult = {
  drained: number;
  failed: number;
  attempted: number;
  outcomes: Array<{
    id: string;
    outcome: "done" | "failed" | "abandoned" | "skipped";
    error?: string | undefined;
  }>;
};

export async function drain(opts: DrainOptions, deps: DrainDeps = {}): Promise<DrainResult> {
  const adapter = getAdapter(opts.target);
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const checkPolicy = deps.checkPolicy ?? defaultCheckPolicy;
  const claimant = opts.claimant ?? opts.target;
  const claimTtlSec = opts.claimTtlSec ?? 300;
  const max = opts.max ?? 1;

  const result: DrainResult = { drained: 0, failed: 0, attempted: 0, outcomes: [] };

  if (!adapter) {
    // No registered recipient → cannot drain. Caller exit non-zero per I-HQ5.
    return result;
  }

  // Oldest-first pending pull.
  const pending = (await listHandoffs({ target: opts.target, status: "pending" }, deps)).slice(
    0,
    max,
  );

  for (const envelope of pending) {
    result.attempted += 1;

    // CAS claim. `already-claimed` ⇒ another drainer won; skip without
    // counting as failure (I-HQ3).
    const claim = await claimHandoff(envelope.id, claimant, claimTtlSec, deps);
    if (claim.kind !== "claimed") {
      result.outcomes.push({ id: envelope.id, outcome: "skipped" });
      continue;
    }
    emitAudit("HANDOFF_CLAIMED", claim.envelope, appendAuditRow);

    // Drain-time re-auth (I-HQ2). Per the plan, the recipient's role is the
    // trust boundary, not the source role.
    if (adapter.policyHint) {
      const hint = adapter.policyHint(claim.envelope);
      if (hint) {
        const decision = checkPolicy(hint.tool, hint.subcommand, hint.state, hint.role);
        if (!decision.allowed) {
          // Mark failed and persist; don't even try the adapter.
          const failed: HandoffEnvelope = {
            ...claim.envelope,
            status: "failed",
            attempts: claim.envelope.attempts + 1,
            lastError: `drain-time policy deny: ${hint.tool} ${hint.subcommand} for ${hint.state}/${hint.role}`,
            claimedBy: undefined,
            claimAt: undefined,
            claimTtlSec: undefined,
          };
          await writeEnvelope(failed, deps.execBd);
          emitAudit("HANDOFF_FAILED", failed, appendAuditRow, {
            error: failed.lastError,
          });
          result.failed += 1;
          result.outcomes.push({
            id: envelope.id,
            outcome: "failed",
            error: failed.lastError,
          });
          continue;
        }
      }
    }

    // Drive the machine through the lifecycle. The machine's initial state
    // is `pending`; we replay the CLAIM here so the in-process actor
    // mirrors the bd-side state (`claimed`) without needing a custom
    // initial-state hydration path.
    const preClaimEnvelope = {
      ...claim.envelope,
      status: "pending" as const,
      claimedBy: undefined,
      claimAt: undefined,
      claimTtlSec: undefined,
    };
    const actor = createActor(handoffMachine, { input: preClaimEnvelope }).start();
    actor.send({
      type: "CLAIM",
      claimant,
      claimTtlSec,
      now: new Date().toISOString(),
    });
    actor.send({ type: "DRAIN_STARTED", now: new Date().toISOString() });

    let outcome: HandoffDrainOutcome;
    try {
      outcome = await adapter.apply(claim.envelope);
    } catch (err) {
      outcome = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.ok) {
      actor.send({ type: "DRAIN_SUCCEEDED", now: new Date().toISOString() });
      const next = actor.getSnapshot().context.envelope;
      await writeEnvelope(next, deps.execBd);
      emitAudit("HANDOFF_DRAINED", next, appendAuditRow);
      result.drained += 1;
      result.outcomes.push({ id: envelope.id, outcome: "done" });
      continue;
    }

    actor.send({
      type: "DRAIN_FAILED",
      error: outcome.error,
      now: new Date().toISOString(),
    });
    let next = actor.getSnapshot().context.envelope;

    // Decide retry vs. abandon. Machine guard mirrors `attempts < maxAttempts`.
    if (next.attempts < next.maxAttempts) {
      actor.send({ type: "RETRY", now: new Date().toISOString() });
    } else {
      actor.send({
        type: "ABANDON",
        reason: "max-attempts-exceeded",
        now: new Date().toISOString(),
      });
    }
    next = actor.getSnapshot().context.envelope;
    await writeEnvelope(next, deps.execBd);

    if (next.status === "abandoned") {
      emitAudit("HANDOFF_FAILED", next, appendAuditRow, {
        error: outcome.error,
      });
      emitAudit("HANDOFF_ABANDONED", next, appendAuditRow, {
        reason: next.lastError ?? "max-attempts-exceeded",
      });
      result.failed += 1;
      result.outcomes.push({
        id: envelope.id,
        outcome: "abandoned",
        error: outcome.error,
      });
    } else {
      // Re-enqueued; not yet done. Counts as a failure for this drain cycle.
      emitAudit("HANDOFF_FAILED", next, appendAuditRow, {
        error: outcome.error,
      });
      result.failed += 1;
      result.outcomes.push({
        id: envelope.id,
        outcome: "failed",
        error: outcome.error,
      });
    }
  }

  return result;
}

// ── audit ──────────────────────────────────────────────────────────────────

/**
 * Emit a `catalog-event` audit row for a handoff lifecycle event. Carries
 * `uow_id` (I-HQ1; grounds I-AUD1) and `handoff_id`. Sink-side errors are
 * intentionally swallowed (parity with `makeAuditInspector`).
 */
export function emitHandoffEvent(
  event:
    | "HANDOFF_ENQUEUED"
    | "HANDOFF_CLAIMED"
    | "HANDOFF_DRAINED"
    | "HANDOFF_FAILED"
    | "HANDOFF_ABANDONED",
  envelope: HandoffEnvelope,
  appendAuditRow: typeof defaultAppendAuditRow = defaultAppendAuditRow,
  details?: Record<string, unknown>,
): void {
  emitAudit(event, envelope, appendAuditRow, details);
}

function emitAudit(
  event:
    | "HANDOFF_ENQUEUED"
    | "HANDOFF_CLAIMED"
    | "HANDOFF_DRAINED"
    | "HANDOFF_FAILED"
    | "HANDOFF_ABANDONED",
  envelope: HandoffEnvelope,
  appendAuditRow: typeof defaultAppendAuditRow,
  details?: Record<string, unknown>,
): void {
  try {
    appendAuditRow({
      ts: new Date().toISOString(),
      kind: "catalog-event" as const,
      event,
      actor: "prx",
      ...(envelope.workUnitId ? { workUnitId: envelope.workUnitId } : {}),
      repo: envelope.repoSlug,
      details: {
        handoff_id: envelope.id,
        target_actor: envelope.targetActor,
        source_actor: envelope.sourceActor,
        verb: envelope.intent.verb,
        denial_reason: envelope.denialReason,
        input_refs: envelope.inputRefs,
        attempts: envelope.attempts,
        ...(details ?? {}),
      },
    });
  } catch {
    // sink-side errors are intentionally swallowed
  }
}
