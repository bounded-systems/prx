// GH-1397 — structured handoff envelope for executor-blocked verbs.
//
// When any prx actor session hits a harness-denied verb today, it emits a
// free-text "run this from a fresh shell" string. The handoff queue replaces
// that with a typed envelope routed to the recipient actor (publisher /
// triage / submit / author). GH-1398's recipient-actor ADR settled the
// recipient-actor model and named `publisher` as the primary recipient;
// this package owns the wire-shape contract every downstream recipient
// ticket builds against.
//
// `intent.verb` is opaque (string) and `intent.args` is `unknown` — each
// drainer validates its own arg shape with a per-recipient Zod at the drain
// boundary. The discriminated-union alternative becomes a god-type every
// drainer imports the moment a fourth recipient lands; mirror the
// `appendAuditRow` boundary contract (src/audit/sink.ts:67) instead.
//
// Large `intent.args` (PR bodies, diffs) spill to plan-store CAS by
// `sha256:` handle; the handle lives in `inputRefs[]`. Satisfies I-AUD2
// (artifact lineage) by construction; the bd row stays small for cheap
// prefix scans.

import { z } from "zod";

import { workUnitIdSchema } from "./brands.ts";

// ── recipient actors ──────────────────────────────────────────────────────
//
// The open set of recipient actors. Extend as new recipients land — each
// recipient registers a drain adapter and lands its own Zod schemas for the
// verbs it accepts. GH-1397 ships infrastructure only; the first real
// adapter is `publisher` (GH-1564, blocked-by GH-1397).
export const handoffTargetActor = z.enum([
  "publisher",
  // GH-2348.3: keeper owns git-write (push/branch) — the recipient for denied
  // git-tool verbs, split out of publisher (which keeps the forge pr.* surface).
  "keeper",
  "triage",
  "submit",
  "author",
  // Generic no-op adapter — drain plumbing for end-to-end test coverage.
  // Real recipients ship in their own tickets; `noop` stays as the
  // contract-stable hook for tests and as a safety net when a real
  // recipient adapter has not been registered.
  "noop",
]);
export type HandoffTargetActor = z.infer<typeof handoffTargetActor>;

// ── envelope status ───────────────────────────────────────────────────────
//
// Mirror of the `handoffMachine` state graph (src/machine/machines/handoff.ts).
// The bd row is the durable projection of the machine's state.
export const handoffStatus = z.enum([
  "pending",
  "claimed",
  "draining",
  "done",
  "failed",
  "abandoned",
]);
export type HandoffStatus = z.infer<typeof handoffStatus>;

// ── denial provenance ─────────────────────────────────────────────────────
//
// Mirrors `FeasibilityReason` (src/tools/policy.ts:179) for the policy-table
// deny path, and adds `flag-layer-deny` for the `disallowedTools` /
// `runtime_profiles.ts` rejection seam.
export const handoffDenialReason = z.enum([
  "blocked",
  "not-allowlisted-for-role",
  "unknown-tool",
  "flag-layer-deny",
]);
export type HandoffDenialReason = z.infer<typeof handoffDenialReason>;

// ── intent payload ────────────────────────────────────────────────────────
//
// `verb` is opaque to the queue. `args` is `unknown` — the drainer for each
// recipient validates the verb-specific arg shape with its own Zod at the
// drain boundary (per I-HQ2: drain-time re-auth is the recipient's job).
export const handoffIntent = z.object({
  verb: z.string().min(1),
  args: z.unknown(),
});
export type HandoffIntent = z.infer<typeof handoffIntent>;

// ── policy-key tag (audit join hint) ──────────────────────────────────────
//
// Optional tag carried on policy-table denies so the audit substrate can
// answer "denies without enqueue" with a cheap join. Absent on flag-layer
// denies (the disallowedTools list does not carry tool/subcommand).
export const handoffPolicyKey = z.object({
  tool: z.string(),
  subcommand: z.string(),
  state: z.string(),
  role: z.string(),
});
export type HandoffPolicyKey = z.infer<typeof handoffPolicyKey>;

// ── worktree ref (publisher / author adapters need this) ──────────────────
export const handoffWorkTreeRef = z.object({
  path: z.string(),
  branch: z.string(),
});
export type HandoffWorkTreeRef = z.infer<typeof handoffWorkTreeRef>;

// ── envelope ──────────────────────────────────────────────────────────────
//
// One row per harness-denied verb. Persisted in bd memory keyed
// `handoff/<targetActor>/<workUnitId|none>/<id>`; large `args` spill to
// plan-store CAS, with handles in `inputRefs[]`.
//
// Cross-repo handoff is out of scope: enqueue refuses when
// `repoSlug ≠ currentRepo`. A future epic owns cross-repo routing.
export const handoffEnvelope = z.object({
  /** ULID. Stable identity for replay and audit joins. */
  id: z.string().min(1),
  /**
   * `sha256(uow_id | targetActor | verb | argsCanonical)` — idempotency
   * key per I-HQ3. A second enqueue with the same `dedupKey` returns the
   * existing `handoff_id` without writing a new row.
   */
  dedupKey: z.string().min(1),
  /** UoW (work-unit) lineage. Nullable for ambient enqueues (rare). */
  workUnitId: workUnitIdSchema.nullable(),
  /** Refuses cross-repo enqueue when this disagrees with the current repo. */
  repoSlug: z.string().min(1),
  /** Originating actor that produced the deny: "executor" | "intake" | ... */
  sourceActor: z.string().min(1),
  /** Originating session id (for audit lookup of the deny event). */
  sourceSessionId: z.string().optional(),
  /** Recipient actor. Each one registers a drain adapter. */
  targetActor: handoffTargetActor,
  /** Verb + opaque args. Drainer validates `args` at the boundary. */
  intent: handoffIntent,
  /** CAS handles (`cas://sha256:...`, `scout://`, `plan://`, `submit://`). */
  inputRefs: z.array(z.string()).default([]),
  /** `event_id` of the deny that produced this handoff (audit join). */
  causedBy: z.string().optional(),
  denialReason: handoffDenialReason,
  /** Optional join-tag for policy-table denies. */
  policyKey: handoffPolicyKey.optional(),
  enqueuedAt: z.string().datetime({ offset: true }),
  status: handoffStatus,
  /** Claimant ("publisher", "triage", ...) — set on CLAIM, cleared on RELEASE. */
  claimedBy: z.string().optional(),
  claimAt: z.string().datetime({ offset: true }).optional(),
  claimTtlSec: z.number().int().positive().optional(),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  lastError: z.string().optional(),
  workTreeRef: handoffWorkTreeRef.optional(),
});
export type HandoffEnvelope = z.infer<typeof handoffEnvelope>;
export type HandoffEnvelopeInput = z.input<typeof handoffEnvelope>;

// ── drain outcome ─────────────────────────────────────────────────────────
//
// Adapter contract: every recipient adapter returns one of these. The
// drainer turns `{ ok: false }` into `HANDOFF_FAILED` and the machine
// decides retry vs. abandon via `attempts < maxAttempts`.
export const handoffDrainOutcome = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type HandoffDrainOutcome = z.infer<typeof handoffDrainOutcome>;
