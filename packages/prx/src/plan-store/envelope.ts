// GH-2028 — persist-on-failure envelope for plan-store writes.
//
// The producer (`prx plan save`) must persist a plan body *unconditionally* and
// refuse at the consumer (`prx implement agent`), not at the write. To carry the
// content-validation verdict alongside the body without polluting the body
// addressing, we wrap the verdict in a content-addressed envelope object.
//
// Storage shape (in-toto / DSSE framing): the body is written to CAS unchanged
// → `body_sha`. The envelope `{ schema_version, body_sha, validated_ok,
// diagnostics }` is JSON-serialized and written to CAS → `envelope_sha`. The ref
// (`<unit>:plan@<slot>`) points at `envelope_sha`. The read path curries
// `getRef → envelope blob → body blob`. Body blobs stay pure (clean addressing),
// and the envelope is itself immutable/verifiable (subject-by-digest).
//
// Legacy refs (pre-envelope) point straight at a raw body blob. `parseEnvelope`
// returns null for those, signalling the caller to treat the blob as a body and
// synthesize `validated_ok: true` (legacy bodies were only ever written when
// validation passed). See verbs.ts for the lazy-migration read path.
//
// Two distinct failure modes, do not conflate them (GH-2288):
//   (a) the ref blob is NOT valid envelope JSON (malformed, or merely overlaps
//       the field names) → `parseEnvelope` returns null → treat as a legacy
//       body. This is the "fail closed to body" guard.
//   (b) the ref blob IS a valid envelope, but its `body_sha` does not resolve
//       to a blob (a GC'd or hand-deleted body) → the read path fails LOUD with
//       BLOB_NOT_FOUND. It is NOT re-rendered as a body. `parseEnvelope` is pure
//       (no IO), so this surfaces downstream in verbs.ts `resolveBody`, by
//       design — a real envelope with a missing body is an error, not a body.

import { z } from "zod";

import type { CasSha } from "./cas.ts";

export const PLAN_ENVELOPE_SCHEMA_VERSION = 1 as const;

// Reuse the `{ code, path, message }` diagnostic shape so GH-1252 (Zod at the
// bd boundary) can later adopt it wholesale.
export interface PlanDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface PlanEnvelope {
  schema_version: typeof PLAN_ENVELOPE_SCHEMA_VERSION;
  body_sha: CasSha;
  validated_ok: boolean;
  diagnostics: PlanDiagnostic[];
}

const SHA_RE = /^sha256:[0-9a-f]{64}$/;

const planDiagnosticSchema = z
  .object({
    code: z.string(),
    path: z.string(),
    message: z.string(),
  })
  .strict();

// The discriminator the reader trusts: a `schema_version` of exactly 1 plus a
// well-formed `body_sha`. `.strict()` rejects extra keys so a stray JSON blob
// that merely overlaps these field names still fails closed to "treat as body".
// Note this guards only the parse step (is-this-an-envelope). It says nothing
// about whether `body_sha` resolves — a valid envelope with a missing body
// fails loud (BLOB_NOT_FOUND) rather than falling back to body; see header (b).
const planEnvelopeSchema = z
  .object({
    schema_version: z.literal(PLAN_ENVELOPE_SCHEMA_VERSION),
    body_sha: z.string().regex(SHA_RE),
    validated_ok: z.boolean(),
    diagnostics: z.array(planDiagnosticSchema),
  })
  .strict();

export function serializeEnvelope(env: PlanEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Parse a CAS blob as a plan envelope. Returns the envelope when the bytes are
 * valid envelope JSON, or `null` when they are not — the caller then treats the
 * blob as a legacy raw body. Never throws: malformed input is a "this is a body,
 * not an envelope" signal, not an error.
 */
export function parseEnvelope(buf: Buffer | string): PlanEnvelope | null {
  const text = typeof buf === "string" ? buf : buf.toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = planEnvelopeSchema.safeParse(json);
  if (!result.success) {
    return null;
  }
  return result.data;
}
