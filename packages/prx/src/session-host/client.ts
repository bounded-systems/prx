/**
 * Host-side session-host client (session-substrate slice 2).
 *
 * The host's handle on the in-VM session host: build a typed request, hand it to
 * an injected transport, validate the reply against the wire contract — a
 * malformed frame in either direction is a {@link SessionProtocolError} at the
 * seam, never a silently mis-parsed result. Mirrors
 * {@link ../keeperd/client.IsolatedKeeperClient}.
 *
 * The transport is the generic framed channel
 * ({@link ../keeperd/transport.FramedTransport}) — a fake in tests, the
 * `ssh -L`-forwarded VM socket in slice 3. The host only *asks* the in-VM host to
 * start/observe/stop processes; it never spawns or holds them itself.
 */

import { type FramedTransport } from "../keeperd/transport.ts";
import {
  SessionRequestSchema,
  SessionResponseSchema,
  type SessionRequest,
  type SessionResponse,
} from "./contract.ts";

/** Thrown when the host replies but the reply doesn't satisfy the wire contract. */
export class SessionProtocolError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SessionProtocolError";
  }
}

/** What {@link SessionHostClient.start} sends. */
export interface StartInput {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Typed facade over a {@link FramedTransport}. Validates the request before it
 * leaves the host and the response when it returns. A non-`ok` daemon result is
 * data, NOT an exception; only a contract violation throws.
 */
export class SessionHostClient {
  constructor(private readonly transport: FramedTransport) {}

  /** Hold a new session: start a detached process inside the host. */
  start(input: StartInput): Promise<SessionResponse> {
    return this.send({
      kind: "start",
      id: input.id,
      command: input.command,
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    });
  }

  /** Observe one session (state reconciled against liveness). */
  status(id: string): Promise<SessionResponse> {
    return this.send({ kind: "status", id });
  }

  /** Signal a held session (default `SIGTERM`). */
  stop(id: string, signal?: string): Promise<SessionResponse> {
    return this.send(signal === undefined ? { kind: "stop", id } : { kind: "stop", id, signal });
  }

  /** Enumerate all held sessions. */
  list(): Promise<SessionResponse> {
    return this.send({ kind: "list" });
  }

  private async send(request: SessionRequest): Promise<SessionResponse> {
    const valid = parseOrThrow(
      SessionRequestSchema,
      request,
      "request failed the session-host wire contract before send",
    );
    const raw = await this.transport(valid);
    return parseOrThrow(
      SessionResponseSchema,
      raw,
      "session-host reply failed the wire contract",
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
    throw new SessionProtocolError(`${context}: ${stringifyIssue(result.error)}`, result.error);
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
