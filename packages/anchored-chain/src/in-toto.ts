// Phase 0 of the in-toto alignment plan (docs/anchored-chain/in-toto-alignment-plan.md).
//
// Pure, dependency-light (node:crypto only, to satisfy extractability) mapping
// between the bespoke `Derivation['manifest']` and an in-toto Statement v1,
// plus the DSSE pre-authentication encoding and an unsigned-envelope
// assembler. No signer lives here: signing plugs in via the `Signer`/`Verifier`
// interfaces, implemented OUTSIDE this module (mirroring the bridge rule) so
// the core stays liftable into its own repo. Not re-exported from index.ts in
// Phase 0 — the public surface is pinned by import-surface.test.ts.

import type { Derivation, Digest } from './types.ts';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const DERIVATION_PREDICATE_TYPE =
  'https://anchored-chain.dev/Derivation/v0.1';
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

export interface InTotoDigestSet {
  readonly sha256: string;
}

export interface InTotoSubject {
  readonly name: string;
  readonly digest: InTotoDigestSet;
}

export interface DerivationPredicate {
  readonly producer: string;
  readonly materials: Readonly<Record<string, InTotoDigestSet>>;
  readonly contracts: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
}

export interface InTotoStatement {
  readonly _type: typeof STATEMENT_TYPE;
  readonly subject: readonly InTotoSubject[];
  readonly predicateType: typeof DERIVATION_PREDICATE_TYPE;
  readonly predicate: DerivationPredicate;
}

export interface DsseSignature {
  readonly sig: string;
  readonly keyid?: string;
}

export interface DsseEnvelope {
  readonly payloadType: typeof DSSE_PAYLOAD_TYPE;
  readonly payload: string; // base64 of the canonical Statement JSON
  readonly signatures: readonly DsseSignature[];
}

// Phase 1 seam: the Sigstore (or dev ed25519) implementation lives outside the
// extractable core and is injected. Declared here so the core owns the shape.
export interface Signer {
  sign(pae: Uint8Array): Promise<DsseSignature>;
}
export interface Verifier {
  verify(pae: Uint8Array, sig: DsseSignature): Promise<boolean>;
}

const DIGEST_PREFIX = 'sha256:';

function toHex(digest: Digest): string {
  return (digest as string).startsWith(DIGEST_PREFIX)
    ? (digest as string).slice(DIGEST_PREFIX.length)
    : (digest as string);
}

function toDigest(hex: string): Digest {
  return `${DIGEST_PREFIX}${hex}` as Digest;
}

function digestSetMap(
  source: Readonly<Record<string, Digest>>,
): Record<string, InTotoDigestSet> {
  const out: Record<string, InTotoDigestSet> = {};
  for (const [name, digest] of Object.entries(source)) {
    out[name] = { sha256: toHex(digest) };
  }
  return out;
}

/** Bespoke manifest → in-toto Statement v1. Outputs become subjects, inputs
 *  become predicate materials. Faithful and reversible. */
export function manifestToStatement(
  manifest: Derivation['manifest'],
): InTotoStatement {
  const subject: InTotoSubject[] = Object.entries(manifest.outputs).map(
    ([name, digest]) => ({ name, digest: { sha256: toHex(digest) } }),
  );
  return {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: DERIVATION_PREDICATE_TYPE,
    predicate: {
      producer: manifest.producer,
      materials: digestSetMap(manifest.inputs),
      contracts: manifest.contracts,
      params: manifest.params,
    },
  };
}

/** in-toto Statement v1 → bespoke manifest. Inverse of manifestToStatement. */
export function statementToManifest(
  statement: InTotoStatement,
): Derivation['manifest'] {
  const inputs: Record<string, Digest> = {};
  for (const [name, set] of Object.entries(statement.predicate.materials)) {
    inputs[name] = toDigest(set.sha256);
  }
  const outputs: Record<string, Digest> = {};
  for (const s of statement.subject) {
    outputs[s.name] = toDigest(s.digest.sha256);
  }
  return {
    producer: statement.predicate.producer,
    inputs,
    outputs,
    contracts: statement.predicate.contracts,
    params: statement.predicate.params,
  };
}

/** DSSE pre-authentication encoding — the bytes a Signer actually signs.
 *  PAE(type, body) = "DSSEv1 " + len(type) + " " + type + " " + len(body) + " " + body
 *  with lengths over UTF-8 byte counts. */
export function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(payloadType);
  const prefix = enc.encode(
    `DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `,
  );
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

/** Assemble an unsigned DSSE envelope around a Statement (signatures added in
 *  Phase 1 by a Signer over `dssePae(DSSE_PAYLOAD_TYPE, statementBytes)`). */
export function assembleEnvelope(statement: InTotoStatement): {
  envelope: DsseEnvelope;
  pae: Uint8Array;
} {
  const json = JSON.stringify(statement);
  const bytes = new TextEncoder().encode(json);
  return {
    envelope: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: Buffer.from(bytes).toString('base64'),
      signatures: [],
    },
    pae: dssePae(DSSE_PAYLOAD_TYPE, bytes),
  };
}
