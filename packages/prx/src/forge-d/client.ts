// Host/agent-side forge-d client: build a typed `lease` request, hand it to an
// injected transport (the framed unix/TCP socket — ../door/transport), and
// validate the reply against the contract. The caller holds no App key — it can
// only *ask* forge-d for a short-lived token. Mirrors IsolatedBeadsClient; the
// transport seam keeps it offline-testable.
import {
  ForgeDRequestSchema,
  ForgeDResponseSchema,
  type ForgeDRequest,
  type ForgeDResponse,
} from "./contract.ts";

/** Send a validated request, get back forge-d's raw decoded reply. */
export type ForgeDTransport = (request: ForgeDRequest) => Promise<unknown>;

/** Thrown when forge-d replies but the reply doesn't satisfy the wire contract. */
export class ForgeDProtocolError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ForgeDProtocolError";
  }
}

/**
 * Typed facade over a {@link ForgeDTransport}. Validates the request before send
 * and the reply on return — a malformed frame either way is a
 * {@link ForgeDProtocolError}. A `status: "error"` lease result is data, not an
 * exception; only a contract violation throws.
 */
export class IsolatedForgeDClient {
  constructor(private readonly transport: ForgeDTransport) {}

  /** Lease a short-lived installation token from forge-d. */
  async lease(request: ForgeDRequest): Promise<ForgeDResponse> {
    const validRequest = parseOrThrow(
      ForgeDRequestSchema,
      request,
      "request failed the forge-d wire contract before send",
    );
    const raw = await this.transport(validRequest);
    return parseOrThrow(ForgeDResponseSchema, raw, "forge-d reply failed the wire contract");
  }
}

function parseOrThrow<T>(
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown };
  },
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ForgeDProtocolError(`${context}: ${stringifyIssue(result.error)}`, result.error);
  }
  return result.data;
}

function stringifyIssue(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> })
      .issues;
    return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return String(error);
}
