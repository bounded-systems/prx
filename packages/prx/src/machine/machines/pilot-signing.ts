/**
 * SPIKE — real (ed25519/DSSE) signers for the pilot/fleet in-toto artifacts.
 *
 * Replaces the stub signers in `provenance.ts` / `pilot-runner.ts` with the
 * repo's real provenance stack: `resolveProvenanceSigner` hands back an ed25519
 * `Signer` (dev / per-actor / stable `ed25519:<b64>`), and we sign the standard
 * DSSE pre-authentication encoding of the statement. The result is a genuine
 * signature verifiable by `resolveProvenanceVerifier` / `ed25519Verifier` —
 * `verifyStatement` round-trips it.
 *
 * Drop-in:
 *   const signer = resolveProvenanceSigner();           // PRX_PROVENANCE_KEY=dev|ed25519:…
 *   createPilotMachine({ runLeg, signSummary: realStatementSigner(signer) });
 *   createFleetMachine(makePilot, { signBatch: realStatementSigner(signer) });
 *
 * `dssePae` is replicated locally — the canonical encoder lives in
 * anchored-chain's Phase-0-internal `in-toto.ts` (not on the package surface);
 * the encoding is a stable spec and sign/verify here use identical bytes.
 */

import { ed25519Signer, ed25519Verifier } from "@bounded-systems/anchored-chain";

import { resolveProvenanceSigner, resolveProvenanceVerifier } from "../../provenance/signer.ts";
import type { LegAttestation } from "./pilot.ts";
import type { RoleSigner } from "./pilot-runner.ts";
import type { Statement, StatementSigner } from "./provenance.ts";

/** Derive the Signer/Verifier shapes without depending on a named type export. */
export type Signer = ReturnType<typeof ed25519Signer>;
export type Verifier = ReturnType<typeof ed25519Verifier>;

const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const encoder = new TextEncoder();

/**
 * DSSE pre-authentication encoding — the exact bytes a Signer signs.
 * `PAE(type, body) = "DSSEv1 " len(type) " " type " " len(body) " " body`.
 */
function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const prefix = encoder.encode(
    `DSSEv1 ${encoder.encode(payloadType).length} ${payloadType} ${payload.length} `,
  );
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

/** Canonical signable bytes for a statement's content (fixed key order). */
function statementPae(content: {
  predicateType: string;
  subject: Statement["subject"];
  predicate: Statement["predicate"];
}): Uint8Array {
  const canonical = {
    _type: STATEMENT_TYPE,
    predicateType: content.predicateType,
    subject: content.subject,
    predicate: content.predicate,
  };
  return dssePae(DSSE_PAYLOAD_TYPE, encoder.encode(JSON.stringify(canonical)));
}

/** Canonical signable bytes for a leg/step link (fixed key order). */
function legPae(content: {
  stage: string;
  subject: string;
  predicate: string;
  outputHash: string;
}): Uint8Array {
  return dssePae(DSSE_PAYLOAD_TYPE, encoder.encode(JSON.stringify(content)));
}

// ── statement (pilot summary / fleet batch) ─────────────────────────────────

/** Real `StatementSigner` over the DSSE PAE of the statement. */
export function realStatementSigner(signer: Signer): StatementSigner {
  return async ({ predicateType, subject, predicate }) => {
    const dsig = await signer.sign(statementPae({ predicateType, subject, predicate }));
    return { signedBy: dsig.keyid ?? "unknown", sig: dsig.sig };
  };
}

/** Verify a signed pilot/fleet `Statement` against a Verifier. */
export function verifyStatement(verifier: Verifier, statement: Statement): Promise<boolean> {
  const pae = statementPae({
    predicateType: statement.predicateType,
    subject: statement.subject,
    predicate: statement.predicate,
  });
  return verifier.verify(pae, { sig: statement.sig });
}

// ── leg (step) links ────────────────────────────────────────────────────────

/** Real `RoleSigner` over the DSSE PAE of the step content. */
export function realRoleSigner(signer: Signer): RoleSigner {
  return async ({ role, subject, predicate, outputHash }) => {
    const dsig = await signer.sign(legPae({ stage: role, subject, predicate, outputHash }));
    return { signedBy: dsig.keyid ?? "unknown", sig: dsig.sig };
  };
}

/**
 * Verify a leg link. Requires the `outputHash` it committed to — the spike's
 * `LegAttestation` does not yet carry it, so end-to-end leg verification means
 * either re-deriving the agent output's hash or storing it on the link (v2).
 */
export function verifyLeg(
  verifier: Verifier,
  link: Pick<LegAttestation, "stage" | "subject" | "predicate" | "sig">,
  outputHash: string,
): Promise<boolean> {
  const pae = legPae({
    stage: link.stage,
    subject: link.subject,
    predicate: link.predicate,
    outputHash,
  });
  return verifier.verify(pae, { sig: link.sig });
}

// ── ambient resolution (prod convenience) ───────────────────────────────────

/** The ambient Signer (`PRX_PROVENANCE_KEY`), or null when none is configured. */
export const provenanceSigner = (): Signer | null => resolveProvenanceSigner() as Signer | null;

/** The ambient Verifier (`PRX_PROVENANCE_PUBKEY` / dev fallback), or null. */
export const provenanceVerifier = (): Verifier | null =>
  resolveProvenanceVerifier() as Verifier | null;
