/**
 * Daemon-routed beads writes (GH-296 wave 2).
 *
 * The single-source replacements for local `execBd` write primitives: create /
 * update / close go through {@link withBeadsClient} to the daemon — the trusted
 * single writer — so host code mutates the one beads the daemon owns, never a
 * per-clone bd. Twin of {@link ./reads.ts}.
 *
 * A non-`ok` daemon verdict throws (callers wrap in try/catch, matching the
 * `execBd` exit-code checks they replace). On success the daemon echoes the
 * affected bd record as RAW `bd --json`, so these parse it with the same
 * {@link parseBeadsRecord} transform the readers use; `null` just means the
 * verdict carried no record (e.g. an empty `{}` update echo), not a failure.
 */

import { withBeadsClient, type WithBeadsClientDeps } from "./client-factory.ts";
import type { BeadsRequest } from "./contract.ts";
import { parseBeadsRecord, type BeadsRecord } from "../triage/triage.ts";

async function writeViaDaemon(
  request: BeadsRequest,
  deps: WithBeadsClientDeps,
): Promise<BeadsRecord | null> {
  return withBeadsClient(async (client) => {
    const reply = await client.query(request);
    if (reply.status === "error") {
      throw new Error(`beadsd ${request.kind}: ${reply.code}: ${reply.message}`);
    }
    const raw = Array.isArray(reply.result) ? reply.result[0] : reply.result;
    return parseBeadsRecord(raw);
  }, deps);
}

/** Daemon-routed `bd create` → the created record (or null if none echoed). */
export function createBeadViaDaemon(
  input: {
    issueType: string;
    title: string;
    priority?: number;
    description?: string;
    externalRef?: string;
    silent?: boolean;
  },
  deps: WithBeadsClientDeps = {},
): Promise<BeadsRecord | null> {
  const request: BeadsRequest = {
    kind: "create",
    issueType: input.issueType,
    title: input.title,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
    ...(input.silent !== undefined ? { silent: input.silent } : {}),
  };
  return writeViaDaemon(request, deps);
}

/** Daemon-routed `bd update <id>` → the updated record (or null if none echoed). */
export function updateBeadViaDaemon(
  id: string,
  fields: { status?: string; priority?: number; assignee?: string; issueType?: string },
  deps: WithBeadsClientDeps = {},
): Promise<BeadsRecord | null> {
  const request: BeadsRequest = {
    kind: "update",
    id,
    ...(fields.status !== undefined ? { status: fields.status } : {}),
    ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
    ...(fields.assignee !== undefined ? { assignee: fields.assignee } : {}),
    ...(fields.issueType !== undefined ? { issueType: fields.issueType } : {}),
  };
  return writeViaDaemon(request, deps);
}

/**
 * Daemon-routed close. `bd close` is policy-blocked, so the daemon maps this to
 * `bd update <id> --status closed [--notes reason]` — callers just ask to close.
 */
export function closeBeadViaDaemon(
  id: string,
  reason?: string,
  deps: WithBeadsClientDeps = {},
): Promise<BeadsRecord | null> {
  const request: BeadsRequest = {
    kind: "close",
    id,
    ...(reason !== undefined ? { reason } : {}),
  };
  return writeViaDaemon(request, deps);
}
