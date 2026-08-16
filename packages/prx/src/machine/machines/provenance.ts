/**
 * SPIKE — minimal in-toto attestation shapes for the pilot/fleet provenance
 * tree. Three tiers, each signed by a different actor's authority:
 *
 *   leg link     (step)     — a role subagent did one thing      → LegAttestation
 *   pilot summary (unit)    — the pilot ran these legs in order   → Statement (prx.pilot/v1)
 *   fleet batch   (board)   — the fleet ran these pilots          → Statement (prx.fleet/v1)
 *
 * A higher tier names its children by digest, so the whole thing is a
 * verifiable Merkle-ish chain: verify the fleet statement → its pilot digests →
 * each pilot's leg digests. Shapes mirror in-toto v1 Statements; the signature
 * envelope is flattened (`signedBy`/`sig`) for the spike — prod swaps in DSSE +
 * the anchored-chain Signer.
 */

import { createHash } from "node:crypto";

export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/** in-toto subject: a named artifact bound to its content digest. */
export type Subject = { name: string; digest: { sha256: string } };

/** A signed in-toto v1 statement. */
export type Statement = {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: Subject[];
  predicateType: string;
  predicate: Record<string, unknown>;
  /** Flattened signature envelope (prod: DSSE). */
  signedBy: string;
  sig: string;
};

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Digest of any JSON value — how a parent names a child attestation. */
export const digestOf = (value: unknown): string => sha256Hex(JSON.stringify(value));

/**
 * Sign a statement's (predicateType, subject, predicate) with an actor's
 * authority. Prod = the role/pilot/fleet actor's anchored-chain Signer; tests
 * pass a deterministic fake.
 */
export type StatementSigner = (input: {
  predicateType: string;
  subject: Subject[];
  predicate: Record<string, unknown>;
}) => Promise<{ signedBy: string; sig: string }>;

/** Build + sign a Statement. */
export async function buildStatement(
  signer: StatementSigner,
  args: { predicateType: string; subject: Subject[]; predicate: Record<string, unknown> },
): Promise<Statement> {
  const { signedBy, sig } = await signer(args);
  return { _type: IN_TOTO_STATEMENT_TYPE, ...args, signedBy, sig };
}

/** Deterministic stub signer for tests/defaults. NOT for production. */
export const stubStatementSigner =
  (actor: string): StatementSigner =>
  async ({ predicateType, subject, predicate }) => ({
    signedBy: `${actor}@stub`,
    sig: `stub-sig(${digestOf({ predicateType, subject, predicate }).slice(0, 12)})`,
  });
