// Per-actor dispatch envelope (GH-1194). One actor (plan/triage/etc) calls
// another's verb headlessly; the target's stdout is captured into a CAS
// blob; the dispatch envelope returns a CAS URI handle, not raw bytes.
//
// Per memory `reference_zod_boundary_layer`, Zod is the boundary layer:
// dispatchRequestSchema validates argv-derived input, dispatchResultSchema
// validates the envelope returned to callers. The XState dispatch machine
// itself uses TypeScript types derived from these schemas.

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { actorNames } from "./actor_names.ts";
import { casUriFor, parseCasUri } from "../plan-store/uri.ts";

// ── dispatch actor taxonomy ────────────────────────────────────────────────
// Source/target vocabulary for dispatch. GH-1530 unifies this set with the CLI
// registry's `ActorName` enum: both consume the shared `actor_names.ts` leaf,
// so `dispatchActors` is now at full `ActorName` parity rather than the former
// hand-listed 8-name subset (plan/triage/intake/implement/submit/author/scout/
// gc). dispatch.ts imports the leaf (not `registry.ts`) to avoid the
// registry → runtime_profiles → … cycle. Most actors are terminal (no
// outbound targets); the explicit dispatch policy lives in
// `defaultDispatchCapabilities` below.

// GH-2394's `scratch` rides the shared `actor_names.ts` leaf alongside every
// other actor, so the full-parity set already includes it (and the
// fromEntries materialization below defaults it to a terminal empty list).
export const dispatchActors = actorNames;

export type DispatchActor = (typeof dispatchActors)[number];

export const dispatchActorSchema = z.enum(dispatchActors);

// ── failure reason union ───────────────────────────────────────────────────

export const dispatchFailureReasons = [
  "depth_exceeded",
  "capability_denied",
  "actor_unknown",
  "verb_unknown",
  "execution_failed",
] as const;

export type DispatchFailureReason = (typeof dispatchFailureReasons)[number];

export const dispatchFailureReasonSchema = z.enum(dispatchFailureReasons);

// ── envelope schemas ───────────────────────────────────────────────────────

// GH-1821: optional `inputArtifact` slot carries the AgentContract-typed
// artifact the dispatcher is handing to the target. The field is optional so
// existing callers keep working; when the contract-trinity rejection flag is
// on (see `assertTypedInputArtifact` below), dispatch to a target whose
// AgentContract declares an `inputArtifact` is denied if this slot is absent
// or its `type` mismatches the contract.
export const dispatchInputArtifactRefSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/),
    /** CAS handle (`<scheme>://sha256:<hex>`) when the payload lives in CAS. */
    casHandle: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*:\/\/sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export type DispatchInputArtifactRef = z.infer<typeof dispatchInputArtifactRefSchema>;

export const dispatchRequestSchema = z.object({
  source: dispatchActorSchema,
  target: dispatchActorSchema,
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  parentDispatchId: z.string().optional(),
  inputArtifact: dispatchInputArtifactRefSchema.optional(),
});

export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;

// ── typed-input rejection (GH-1821, feature-flagged) ───────────────────────
// When `rejectUntyped: true`, a dispatch call to a target whose AgentContract
// declares an inputArtifact is denied unless the request carries an
// `inputArtifact` whose `type` matches. Default flag is off so existing
// callers stay backwards-compatible; the implement-profile flips it on in a
// follow-up shard.

export const PRX_TYPED_DISPATCH_FLAG = "PRX_TYPED_DISPATCH_REJECTION";

export function readTypedDispatchFlag(env: NodeJS.ProcessEnv = processEnv()): boolean {
  const raw = env[PRX_TYPED_DISPATCH_FLAG];
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export interface AssertTypedInputArtifactInput {
  request: DispatchRequest;
  /** AgentContract.inputArtifact for `request.target`. */
  expectedInputType: string | null;
  rejectUntyped?: boolean;
}

export function assertTypedInputArtifact(
  input: AssertTypedInputArtifactInput,
): { ok: true } | { ok: false; reason: DispatchFailureReason; detail: string } {
  const flag = input.rejectUntyped ?? false;
  if (!flag) return { ok: true };
  if (input.expectedInputType == null) return { ok: true };
  const got = input.request.inputArtifact;
  if (!got) {
    return {
      ok: false,
      reason: "capability_denied",
      detail:
        `target ${input.request.target} requires inputArtifact type ${input.expectedInputType}; ` +
        "dispatch request carries no inputArtifact (typed-dispatch flag on)",
    };
  }
  if (got.type !== input.expectedInputType) {
    return {
      ok: false,
      reason: "capability_denied",
      detail:
        `target ${input.request.target} requires inputArtifact type ${input.expectedInputType}; ` +
        `request carries type ${got.type}`,
    };
  }
  return { ok: true };
}

const CAS_HANDLE_RE = /^[a-z][a-z0-9_-]*:\/\/sha256:[0-9a-f]{64}$/;

export const dispatchResultSchema = z.object({
  casHandle: z.string().regex(CAS_HANDLE_RE),
  target: dispatchActorSchema,
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
});

export type DispatchResult = z.infer<typeof dispatchResultSchema>;

export const dispatchFailureSchema = z.object({
  reason: dispatchFailureReasonSchema,
  detail: z.string(),
});

export type DispatchFailure = z.infer<typeof dispatchFailureSchema>;

// ── capability map (advisory) ──────────────────────────────────────────────
// GH-1530 PR-6: this per-source caller→targets map is NO LONGER a gate. The
// dispatch authority flipped to target-authoritative — `canDispatch` consults
// only the target's `allowedCallers` (see below). What remains here is the
// inspectable outbound *declaration* ("the targets this source intends to
// reach"), still projected into the runtime-profile contract
// (`SESSION_PROFILES[...].allowedDispatchTargets`, `contracts/instances.ts`)
// and surfaced in banners/discovery. It does not deny anything.

// GH-1530: the explicit caller→targets declarations. Every other actor in
// `dispatchActors` defaults to a frozen empty list (declares no outbound
// dispatch) when `defaultDispatchCapabilities` is materialized below, so the
// map stays exhaustive over the full `ActorName`-parity set without hand-
// listing ~30 terminal actors.
const EXPLICIT_DISPATCH_CAPABILITIES: Partial<Record<DispatchActor, readonly DispatchActor[]>> = {
  plan: ["scout"],
  triage: ["scout"],
  intake: ["scout"],
  implement: ["scout", "plan"],
  submit: ["scout"],
  // GH-1206: author reads via scout for body composition. ai-home-2ow2v: the
  // author profile's PR writes go through the forge actor (publisher: pr
  // open/comment/edit, ready/draft) and PR-thread reads through repo
  // (pr-comments) — declared here as the inspectable outbound set (advisory;
  // the gate is target-authoritative via each target's allowedCallers).
  author: ["scout", "publisher", "repo"],
  scout: [],
  gc: [],
  // GH-2394: scratch never dispatches — ad-hoc, work-unit-unbound session.
  // (Covered by the empty-default below; listed for legibility.)
  scratch: [],
};

export const defaultDispatchCapabilities: Readonly<
  Record<DispatchActor, readonly DispatchActor[]>
> = Object.freeze(
  Object.fromEntries(
    dispatchActors.map((actor) => [
      actor,
      Object.freeze([...(EXPLICIT_DISPATCH_CAPABILITIES[actor] ?? [])]),
    ]),
  ),
) as Record<DispatchActor, readonly DispatchActor[]>;

// ── depth tracking ─────────────────────────────────────────────────────────

export const MAX_DISPATCH_DEPTH = 2;
export const DISPATCH_DEPTH_ENV = "PRX_DISPATCH_DEPTH";
export const DISPATCH_PARENT_ENV = "PRX_DISPATCH_PARENT";
// GH-352: the dispatch source (the initiating actor) carried into the target's
// subprocess, so its audit/signing context attributes provenance to that
// authority. Set by the parent when spawning; read at child startup.
export const DISPATCH_SOURCE_ENV = "PRX_DISPATCH_SOURCE";

export function readDispatchDepth(env: NodeJS.ProcessEnv = processEnv()): number {
  const raw = env[DISPATCH_DEPTH_ENV];
  if (!raw || raw.length === 0) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** The dispatch source carried in the env, or null for a direct (non-dispatched)
 *  invocation. The child's audit context uses it as the provenance authority. */
export function readDispatchSource(env: NodeJS.ProcessEnv = processEnv()): string | null {
  const raw = env[DISPATCH_SOURCE_ENV];
  return raw && raw.length > 0 ? raw : null;
}

// ── capability chokepoint ──────────────────────────────────────────────────
// Single helper used by both the XState guard and the CLI argv layer (sub-
// ticket C). Returns the failure reason on deny, null on allow.

export interface CanDispatchInput {
  source: DispatchActor;
  target: DispatchActor;
  action: string;
  /**
   * GH-1530 PR-6 (target-authoritative ocap flip): the TARGET actor's inbound
   * capability — the set of callers it admits, resolved from
   * `actorSpecFor(target).allowedCallers` and injected by the handler/guard.
   * This is now the SOLE cross-actor authority: the prior caller-side outbound
   * gate (`allowedTargets` / `defaultDispatchCapabilities`) was retired once
   * every dispatchable target carried a complete `allowedCallers`, so the
   * target alone decides who may dispatch to it. Omitted ⇒ treated as the
   * empty set (admits no caller) — deny-by-default; production always injects
   * it (a non-dispatchable target resolves to `[]`). Self-dispatch bypasses
   * this gate.
   */
  allowedCallers?: readonly DispatchActor[] | undefined;
  /** Current dispatch nesting depth (0 = top-level). */
  depth: number;
}

export function canDispatch(
  input: CanDispatchInput,
): { ok: true } | { ok: false; reason: DispatchFailureReason; detail: string } {
  if (!dispatchActors.includes(input.source)) {
    return { ok: false, reason: "actor_unknown", detail: `unknown source: ${input.source}` };
  }
  if (!dispatchActors.includes(input.target)) {
    return { ok: false, reason: "actor_unknown", detail: `unknown target: ${input.target}` };
  }
  if (typeof input.action !== "string" || input.action.length === 0) {
    return { ok: false, reason: "verb_unknown", detail: "empty verb" };
  }
  if (input.depth >= MAX_DISPATCH_DEPTH) {
    return {
      ok: false,
      reason: "depth_exceeded",
      detail: `depth ${input.depth} >= ${MAX_DISPATCH_DEPTH}`,
    };
  }
  // Self-dispatch (headless variant of an actor's own verb — GH-1164
  // generalization): always allowed, since the actor can already run its
  // own verbs interactively. The capability whitelist governs cross-actor
  // delegation, not self.
  if (input.source === input.target) {
    return { ok: true };
  }
  // Target-authoritative inbound gate (GH-1530 PR-6): the TARGET actor's
  // `allowedCallers` is the sole cross-actor authority. The caller-side
  // outbound gate (`allowedTargets` / `defaultDispatchCapabilities`) was
  // retired once every dispatchable target carried a complete `allowedCallers`
  // — the target alone decides who may reach it. A target admits a caller iff
  // it lists that caller; an absent or empty list admits none (deny-by-default,
  // e.g. a non-dispatchable target resolves to `[]`).
  const allowedCallers = input.allowedCallers ?? [];
  if (!allowedCallers.includes(input.source)) {
    return {
      ok: false,
      reason: "capability_denied",
      detail: `${input.target} does not admit caller ${input.source}`,
    };
  }
  return { ok: true };
}

// ── re-export URI helpers for dispatch consumers ──────────────────────────
// Keep the boundary in one import for downstream actors that need to mint
// or parse CAS handles produced by the dispatch envelope.
export { casUriFor, parseCasUri };
