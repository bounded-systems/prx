/**
 * Agent → human dispatch seam (GH-231).
 *
 * The typed inverse of "human-in-the-loop": instead of the human being an
 * ambient supervisor whose authority the agent inherits, the agent EXPLICITLY
 * dispatches a {@link HumanRequest} to the human actor and gets back a validated,
 * kind-matched {@link HumanResponse}. This is the ONLY way the agent obtains a
 * human-held capability — it cannot borrow the human's ambient authority.
 *
 * The {@link HumanResponder} is an injected seam (a fake in tests). The live
 * responder — the approval/decision UI, audited like a `gh_call` row — lands in a
 * later slice; this slice is pure contract + dispatch, offline-testable.
 */

import {
  HumanRequestSchema,
  HumanResponseSchema,
  type HumanRequest,
  type HumanResponse,
} from "./contract.ts";

/**
 * The agent→human channel: hand a validated request to the human, get back their
 * raw decoded reply (validated by the dispatcher, not the responder, so the
 * contract boundary lives in one place). Implementations: a fake (tests), or the
 * live approval/decision surface (later slice).
 */
export type HumanResponder = (request: HumanRequest) => Promise<unknown>;

/** Thrown when a dispatch or reply violates the human-actor contract. */
export class HumanProtocolError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "HumanProtocolError";
  }
}

/**
 * Dispatch a typed request to the human actor and return their validated,
 * kind-matched response. The request is validated BEFORE it reaches the responder
 * (an off-envelope ask never leaves the agent), and the reply is validated and
 * checked to answer the SAME kind that was asked — so a human-held capability is
 * obtained only through this bounded, auditable seam, never by inheriting the
 * human's ambient authority.
 */
export async function dispatchToHuman(
  request: HumanRequest,
  responder: HumanResponder,
): Promise<HumanResponse> {
  const validRequest = parseOrThrow(
    HumanRequestSchema,
    request,
    "agent→human request failed the human-actor contract before dispatch",
  );
  const raw = await responder(validRequest);
  const response = parseOrThrow(
    HumanResponseSchema,
    raw,
    "human reply failed the human-actor contract",
  );
  if (response.kind !== validRequest.kind) {
    throw new HumanProtocolError(
      `human replied with a '${response.kind}' to a '${validRequest.kind}' request`,
    );
  }
  return response;
}

function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown } },
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HumanProtocolError(`${context}: ${stringifyIssue(result.error)}`, result.error);
  }
  return result.data;
}

function stringifyIssue(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
    return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return String(error);
}
