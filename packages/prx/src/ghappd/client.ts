// Host/agent-side ghappd client: build a typed `lease` request, hand it to an
// injected transport (the framed unix/TCP socket — ../door/transport), and
// validate the reply against the contract. The caller holds no App key — it can
// only *ask* ghappd for a short-lived token. Mirrors IsolatedBeadsClient; the
// transport seam keeps it offline-testable.
import {
  GhappdRequestSchema,
  GhappdResponseSchema,
  type GhappdRequest,
  type GhappdResponse,
} from "./contract.ts";

/** Send a validated request, get back ghappd's raw decoded reply. */
export type GhappdTransport = (request: GhappdRequest) => Promise<unknown>;

/** Thrown when ghappd replies but the reply doesn't satisfy the wire contract. */
export class GhappdProtocolError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GhappdProtocolError";
  }
}

/**
 * Typed facade over a {@link GhappdTransport}. Validates the request before send
 * and the reply on return — a malformed frame either way is a
 * {@link GhappdProtocolError}. A `status: "error"` lease result is data, not an
 * exception; only a contract violation throws.
 */
export class IsolatedGhappdClient {
  constructor(private readonly transport: GhappdTransport) {}

  /** Lease a short-lived installation token from ghappd. */
  async lease(request: GhappdRequest): Promise<GhappdResponse> {
    const validRequest = parseOrThrow(
      GhappdRequestSchema,
      request,
      "request failed the ghappd wire contract before send",
    );
    const raw = await this.transport(validRequest);
    return parseOrThrow(GhappdResponseSchema, raw, "ghappd reply failed the wire contract");
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
    throw new GhappdProtocolError(`${context}: ${stringifyIssue(result.error)}`, result.error);
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
