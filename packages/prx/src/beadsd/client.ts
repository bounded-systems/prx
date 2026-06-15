/**
 * Host-side beadsd client (GH-228, slice 1).
 *
 * The host's handle on the isolated beads store: it builds a typed read request,
 * hands it to an injected {@link BeadsTransport}, and validates the reply against
 * the wire contract. The host holds no beads DB — it can only *ask* the in-VM
 * daemon. The agent queries for exactly the tasks it needs (shallow context)
 * instead of loading the DB into context.
 *
 * The transport is a seam, so this is fully offline-testable (a fake transport
 * in tests, slice 1). The real transport — the Lima-SSH framed-socket channel —
 * is the same `openConnection`/`unixSocketTransport` plumbing keeperd already
 * uses (`../door/transport`, `../keeperd/lima-transport`); beadsd reuses it.
 */

import {
  BeadsRequestSchema,
  BeadsResponseSchema,
  type BeadsRequest,
  type BeadsResponse,
} from "./contract.ts";

/**
 * The host→VM channel: send a validated request, get back the daemon's raw
 * decoded reply (validated by the client, not the transport, so the contract
 * boundary lives in one place).
 */
export type BeadsTransport = (request: BeadsRequest) => Promise<unknown>;

/** Thrown when beadsd replies but the reply doesn't satisfy the wire contract. */
export class BeadsProtocolError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BeadsProtocolError";
  }
}

/**
 * Typed facade over a {@link BeadsTransport}. Validates the request before it
 * leaves the host and the response when it returns — a malformed frame either
 * way is a {@link BeadsProtocolError} at the seam. A non-`ok` daemon result is
 * data, not an exception; only a contract violation throws.
 */
export class IsolatedBeadsClient {
  constructor(private readonly transport: BeadsTransport) {}

  /** Ask the in-VM beads store a read query (`ready`/`list`/`show`). */
  async query(request: BeadsRequest): Promise<BeadsResponse> {
    const validRequest = parseOrThrow(
      BeadsRequestSchema,
      request,
      "request failed the beadsd wire contract before send",
    );
    const raw = await this.transport(validRequest);
    return parseOrThrow(BeadsResponseSchema, raw, "beadsd reply failed the wire contract");
  }
}

function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown } },
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BeadsProtocolError(`${context}: ${stringifyIssue(result.error)}`, result.error);
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
