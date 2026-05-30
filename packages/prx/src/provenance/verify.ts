/**
 * The SLSA-aware live verifier — the read side of Phase A and the seam
 * GH-2249 (`requireSigned`, fail-closed enforcement) attaches to.
 *
 * Why this exists separately from the core `validateDerivation`:
 * `validateDerivation` binds an envelope by rebuilding `manifestToStatement`
 * (the bespoke in-toto predicate) and comparing payloads — but `attest.ts`
 * signs the *SLSA* Statement (`https://slsa.dev/provenance/v1`). So the core
 * verifier would reject EVERY SLSA envelope with `anchored-chain/envelope-mismatch`.
 * Extending the core to dispatch on predicate type would leak SLSA into the
 * extractable core (and its extractability tripwire); instead the SLSA-aware
 * verification lives here, reusing the core `Verifier` seam unchanged via
 * {@link verifySlsaEnvelope}.
 *
 * The signed payload IS the SLSA Statement, so verification decodes it from the
 * envelope and re-binds through `verifySlsaEnvelope` (which re-serializes and
 * compares before checking any signature — the same fail-closed discipline as
 * the core). A caller (e.g. the GH-2249 merge guard) supplies the `Verifier`.
 */

import type { Derivation, DsseEnvelope, Verifier } from "@bounded-systems/anchored-chain";

import { verifySlsaEnvelope, type SlsaProvenanceStatement } from "./slsa.ts";

/**
 * Decode the SLSA Statement carried in a DSSE envelope's base64 payload. The
 * payload was produced by `JSON.stringify` over a {@link SlsaProvenanceStatement}
 * (see `assembleSlsaEnvelope`), so a parse round-trips the same shape.
 */
export function decodeSlsaStatement(
  envelope: DsseEnvelope,
): SlsaProvenanceStatement {
  const json = Buffer.from(envelope.payload, "base64").toString("utf8");
  return JSON.parse(json) as SlsaProvenanceStatement;
}

/**
 * Verify a DSSE envelope that wraps a SLSA Provenance Statement: decode the
 * signed Statement from the payload, then re-bind + check the signature through
 * the core `verifySlsaEnvelope`. Fail-closed — a malformed payload, a payload
 * that does not re-serialize to itself, an empty signature set, or a signature
 * the `Verifier` rejects all yield `false`.
 */
export async function verifySlsaDerivationEnvelope(
  envelope: DsseEnvelope,
  verifier: Verifier,
): Promise<boolean> {
  let statement: SlsaProvenanceStatement;
  try {
    statement = decodeSlsaStatement(envelope);
  } catch {
    return false;
  }
  return verifySlsaEnvelope(statement, envelope, verifier);
}

/**
 * Verify the SLSA envelope on a ledger `Derivation`. An unsigned derivation
 * (no envelope) is `false` — this is the SLSA analogue of the core
 * `requireSigned` fail-closed check, and the entry point GH-2249 enforcement
 * calls per derivation.
 */
export async function verifySlsaDerivation(
  derivation: Pick<Derivation, "envelope">,
  verifier: Verifier,
): Promise<boolean> {
  if (derivation.envelope === undefined) return false;
  return verifySlsaDerivationEnvelope(derivation.envelope, verifier);
}
