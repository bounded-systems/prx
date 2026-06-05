/**
 * Host-side keeperd client (GH-201, slice 1).
 *
 * The host's ONLY handle on the isolated keeper: it builds a typed request,
 * hands it to an injected {@link KeeperTransport}, and validates the reply
 * against the wire contract. The host holds no `role=keeper` git-write, no push
 * credential, and no signing key — it can only *ask* the in-VM daemon to do the
 * git-write. That asymmetry is the capability isolation: deny the host the
 * transport and it cannot push or sign at all.
 *
 * The transport is a seam so this is fully offline-testable (a fake transport in
 * tests, slice 1). The real transport — frame the request over the Lima-SSH
 * channel to the in-VM daemon socket — lands in slice 3 and slots in here
 * unchanged.
 */

import {
  KeeperRemoteRequestSchema,
  KeeperRemoteResponseSchema,
  type KeeperRemoteRequest,
  type KeeperRemoteResponse,
} from "./contract.ts";

/**
 * The host→VM channel: send a validated request, get back the daemon's raw
 * decoded reply (validated by the client, not the transport, so the contract
 * boundary lives in one place). Implementations: a fake (tests), or the
 * Lima-SSH framed-socket channel (slice 3).
 */
export type KeeperTransport = (request: KeeperRemoteRequest) => Promise<unknown>;

/** Thrown when keeperd replies but the reply doesn't satisfy the wire contract. */
export class KeeperProtocolError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "KeeperProtocolError";
  }
}

/**
 * Typed facade over a {@link KeeperTransport}. Validates the request before it
 * leaves the host and the response when it returns — a malformed frame in either
 * direction is a {@link KeeperProtocolError} at the seam, never a silently
 * mis-parsed git-write result.
 */
export class IsolatedKeeperClient {
  constructor(private readonly transport: KeeperTransport) {}

  /**
   * Ask the in-VM keeper to materialize the commit and push its branch. Returns
   * the daemon's verdict (`ok` with the pushed identity, or a typed `error`) —
   * a non-`ok` daemon result is data, NOT an exception; only a contract
   * violation (unparseable request/response) throws.
   */
  async commitAndPush(request: KeeperRemoteRequest): Promise<KeeperRemoteResponse> {
    const validRequest = parseOrThrow(
      KeeperRemoteRequestSchema,
      request,
      "request failed the keeperd wire contract before send",
    );
    const raw = await this.transport(validRequest);
    return parseOrThrow(
      KeeperRemoteResponseSchema,
      raw,
      "keeperd reply failed the wire contract",
    );
  }
}

function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown } },
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new KeeperProtocolError(`${context}: ${stringifyIssue(result.error)}`, result.error);
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
