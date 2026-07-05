/**
 * beadsd's method surface as a verbspec Registry — the **interface** layer (IDL).
 *
 * beadsd already has a typed wire contract ({@link ./contract.BeadsRequestSchema},
 * a `kind`-discriminated union). This projects that ONE source into verbspec
 * verbs: each request `kind` becomes a verb whose `input` is that kind's fields
 * (minus the `kind` discriminant — which becomes the verb id / JSON-RPC method
 * name) and whose `output` is the shared {@link ./contract.BeadsResponseSchema}.
 * From there `@bounded-systems/verbspec` projects the same spec to OpenRPC (the
 * published interface doc, {@link beadsdOpenRpc}), MCP/Anthropic tools, and — the
 * eventual door transport — `dispatchNdjson` (JSON-RPC 2.0). Same "author once,
 * project everywhere, cannot drift" thesis the capability contract applies to
 * door *topology* (which doors exist); here applied to door *methods* (what you
 * may say to one). See CONCIERGE.md §10 and contract/INVARIANTS.md I6.
 *
 * PROJECTION-ONLY (this slice). The `run` handlers throw: beadsd still SERVES
 * over its existing `{kind}` envelope ({@link ./daemon}). This module exists to
 * (1) publish the interface doc and (2) be the drift-guarded IDL. Swapping
 * beadsd's transport onto `dispatchNdjson` is a follow-up (a breaking, wire-level
 * change coordinated with the host client), tracked separately.
 */
import { z } from "zod";
import { defineVerb, toOpenRpcDocument, type Registry } from "@bounded-systems/verbspec";

import {
  BeadsRequestSchema,
  BeadsResponseSchema,
  BEADS_REQUEST_KINDS,
  isBeadsWriteKind,
  type BeadsRequestKind,
} from "./contract.ts";

/** One-line summary per method (the one bit of prose not carried by the schema). */
const SUMMARIES: Record<BeadsRequestKind, string> = {
  ready: "Issues with no open blockers — the agent's available work.",
  list: "List issues, optionally filtered by status.",
  show: "One issue's full detail.",
  children: "The parent-child children of an epic.",
  recall: "Recall a stored memory by key.",
  memories: "List memory keys, optionally by prefix.",
  "config-get": "Read a beads config value.",
  create: "Create an issue.",
  update: "Update an issue's fields.",
  close: "Close an issue.",
  reopen: "Reopen a closed issue.",
  dep: "Add or query a dependency edge.",
  remember: "Store a memory under a key.",
  "config-set": "Set a beads config value.",
};

// The union's members, typed just enough to read the discriminant + `.omit`.
type KindObject = z.ZodObject<{ kind: z.ZodLiteral<string> }> & {
  omit(mask: { kind: true }): z.ZodTypeAny;
};
const OPTIONS = BeadsRequestSchema.options as unknown as readonly KindObject[];

/** A kind's input schema = its union member minus the `kind` discriminant. */
function inputFor(kind: BeadsRequestKind): z.ZodTypeAny {
  const opt = OPTIONS.find((o) => o.shape.kind.value === kind);
  if (!opt) throw new Error(`beadsd verbs: no BeadsRequestSchema option for kind '${kind}'`);
  return opt.omit({ kind: true });
}

/** beadsd's method surface as verbspec verbs — the IDL, derived from the wire contract. */
export const beadsdVerbs: Registry = Object.fromEntries(
  BEADS_REQUEST_KINDS.map((kind) => [
    kind,
    defineVerb({
      id: kind,
      summary: SUMMARIES[kind],
      // The read/write split the daemon already gates on (isBeadsWriteKind).
      actor: isBeadsWriteKind(kind) ? "beads-write" : "beads-read",
      input: inputFor(kind),
      output: BeadsResponseSchema,
      run: () => {
        throw new Error(
          `beadsd verb '${kind}' is interface-only in this slice — beadsd still serves ` +
            `over its {kind} envelope (daemon.ts). The dispatchNdjson transport swap is a follow-up.`,
        );
      },
    }),
  ]),
);

/** beadsd's published interface document (OpenRPC 1.3.2), projected from {@link beadsdVerbs}. */
export const beadsdOpenRpc = toOpenRpcDocument(beadsdVerbs, {
  title: "beadsd",
  version: "0.1.0",
});
