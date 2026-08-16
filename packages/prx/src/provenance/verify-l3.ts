/**
 * Verify door-keeper's **L3 attestation** (the prx→door-keeper convergence,
 * Phase B.2). door-keeper's `import-and-push` returns an `L3Attestation` —
 * an SLSA in-toto statement plus a detached ed25519 signature over the
 * statement's canonical JSON (NOT a DSSE envelope, so `verifySlsaDerivation`
 * doesn't apply). This is prx's verify side: it lets a thin prx accept
 * door-keeper as the canonical keeper daemon without re-implementing its signing.
 *
 * Mirrors door-keeper's own `verifySignature` (ed25519 over `JSON.stringify(stmt)`)
 * and adds the subject-equality defence (the statement must attest exactly the
 * commit prx materialized). Fail closed on any malformed input.
 */

import { createPublicKey, verify as ed25519Verify } from "node:crypto";

/** A door-keeper L3 attestation, as it crosses the keeper door's wire. */
export type L3Attestation = {
  /** The SLSA in-toto statement; `subject[0].digest.gitCommit` is the pushed commit. */
  readonly statement: {
    readonly subject?: ReadonlyArray<{ readonly digest?: { readonly gitCommit?: string } }>;
  } & Record<string, unknown>;
  /** base64 ed25519 signature over `JSON.stringify(statement)`. */
  readonly signature: string;
  /** door-keeper's signing key id (informational). */
  readonly keyId?: string;
};

/**
 * Canonical JSON for verifying L3 signatures: recursively sort object keys, then
 * `JSON.stringify` — independent of key insertion order AND stable across a JSON
 * round-trip (the L3 always crosses the wire / a git note before it is verified,
 * and JSON drops `undefined`-valued keys; sort-then-stringify matches that
 * exactly). MUST be byte-identical to door-keeper's `canonicalJson` (the signer).
 */
function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortDeep(obj[k]);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** True iff `value` is shaped like an {@link L3Attestation}. */
export function isL3Attestation(value: unknown): value is L3Attestation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { signature?: unknown }).signature === "string" &&
    typeof (value as { statement?: unknown }).statement === "object" &&
    (value as { statement?: unknown }).statement !== null
  );
}

/**
 * Verify an L3 attestation against `publicKeyPem` (door-keeper's keeper public
 * key) and, when given, that its subject is exactly `expectedCommitSha`. Returns
 * false on any malformed input, signature mismatch, or subject mismatch.
 */
export function verifyL3Attestation(
  att: unknown,
  publicKeyPem: string,
  expectedCommitSha?: string,
): boolean {
  if (!isL3Attestation(att)) return false;
  if (expectedCommitSha !== undefined) {
    const subject = att.statement.subject?.[0]?.digest?.gitCommit;
    if (subject !== expectedCommitSha) return false;
  }
  try {
    const key = createPublicKey(publicKeyPem);
    return ed25519Verify(
      null,
      Buffer.from(canonicalJson(att.statement)),
      key,
      Buffer.from(att.signature, "base64"),
    );
  } catch {
    return false;
  }
}
