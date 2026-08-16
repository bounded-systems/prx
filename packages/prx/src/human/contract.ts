/**
 * Human-actor wire contract (GH-231).
 *
 * The human is a **bounded registered actor**, not the ambient-authority root.
 * This is the typed envelope of what the agent may ASK of the human: a
 * discriminated union of request kinds, each with a kind-matched response. The
 * agent obtains a human-held capability ONLY by dispatching one of these
 * (see {@link ./dispatch.dispatchToHuman}) — it can never borrow the human's
 * ambient authority. Adding a kind here is a deliberate widening of the human's
 * envelope; there is no wildcard and no "run anything" escape hatch.
 *
 * Spec-as-schema: both the request (before it leaves the agent) and the response
 * (when it returns) are `parse()`d, so a malformed dispatch is a validation error
 * at the seam — the human-actor analog of keeperd's wire contract.
 */

import { z } from "zod";

/**
 * The human actor's bounded capability envelope — the request kinds the agent is
 * permitted to dispatch. Enumerable on purpose: the envelope is an allowlist.
 */
export const HUMAN_REQUEST_KINDS = ["decision", "approval", "secret-op"] as const;
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];

/**
 * A typed ask to the human. The agent branches on the kind-matched response; it
 * never receives ambient capability, only the bounded answer to what it asked.
 */
export const HumanRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decision"),
    /** What the human is being asked to decide. */
    question: z.string().min(1),
    /** The choices the agent will branch on (at least two — a real decision). */
    options: z.array(z.string().min(1)).min(2),
  }),
  z.object({
    kind: z.literal("approval"),
    /** The gated action awaiting the human's go/no-go. */
    action: z.string().min(1),
    /** Optional detail the human needs to decide (diff summary, scope, …). */
    detail: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("secret-op"),
    /**
     * An out-of-band action ONLY the human performs (e.g. rotate a key, flip an
     * org setting). The agent never sees the secret — it only learns the op
     * completed, so no credential crosses into the agent's authority.
     */
    op: z.string().min(1),
    /** Optional human-facing detail / instructions for the op. */
    detail: z.string().min(1).optional(),
  }),
]);
export type HumanRequest = z.infer<typeof HumanRequestSchema>;

/**
 * The human's reply. A discriminated union keyed on the SAME kind as the request
 * so the dispatcher can reject a mismatched reply. Each variant carries only the
 * bounded result the agent asked for — never a transferable capability.
 */
export const HumanResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decision"),
    /** The chosen option (the agent validates membership in its own options). */
    choice: z.string().min(1),
  }),
  z.object({
    kind: z.literal("approval"),
    approved: z.boolean(),
    /** Why — required to make a denial actionable; optional on approve. */
    reason: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("secret-op"),
    /** Whether the human performed the out-of-band op. */
    done: z.boolean(),
    /** Optional non-secret note (e.g. "rotated; new key id k3"). */
    note: z.string().min(1).optional(),
  }),
]);
export type HumanResponse = z.infer<typeof HumanResponseSchema>;
