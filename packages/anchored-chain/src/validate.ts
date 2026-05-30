import type { DerivationStore } from './derivation-store.ts';
import { assembleEnvelope, manifestToStatement } from './in-toto.ts';
import type { Verifier } from './in-toto.ts';
import type { ContractRegistry } from './interfaces.ts';
import type { RefStore } from './ref-store.ts';
import type { ContractId, Derivation, Digest } from './types.ts';

export type Verdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failedAt: Digest;
      readonly contract: ContractId;
      readonly reason: string;
    };

export interface ValidationCapable {
  readonly refs: Pick<RefStore, 'get'>;
  readonly derivations: Pick<DerivationStore, 'get'>;
}

export interface VerifyOptions {
  /** When set, signatures present on a derivation are checked against it. */
  readonly verifier?: Verifier;
  /** When true, an unsigned (envelope-absent) derivation fails closed. */
  readonly requireSigned?: boolean;
}

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as Digest;

export async function validateRef(
  refName: string,
  store: ValidationCapable,
  registry: ContractRegistry,
  options: VerifyOptions = {},
): Promise<Verdict> {
  const ref = await store.refs.get(refName);
  if (ref === null) {
    return {
      ok: false,
      failedAt: ZERO_DIGEST,
      contract: 'anchored-chain/ref-resolution' as ContractId,
      reason: `ref not found: ${refName}`,
    };
  }
  return validateDerivation(ref.digest, store.derivations, registry, options);
}

export async function validateDerivation(
  derivationId: Digest,
  store: Pick<DerivationStore, 'get'>,
  registry: ContractRegistry,
  options: VerifyOptions = {},
): Promise<Verdict> {
  const visited = new Set<string>();

  async function walk(id: Digest): Promise<Verdict> {
    if (visited.has(id)) return { ok: true };
    visited.add(id);

    const der = await store.get(id);
    if (der === null) {
      return {
        ok: false,
        failedAt: id,
        contract: 'anchored-chain/missing-derivation' as ContractId,
        reason: 'derivation not found',
      };
    }

    const signatureVerdict = await verifySignature(id, der, options);
    if (!signatureVerdict.ok) return signatureVerdict;

    for (const contractId of der.manifest.contracts) {
      const validator = registry.getValidator(contractId as ContractId);
      const result = validator(id, undefined);
      if (!result.ok) {
        return {
          ok: false,
          failedAt: id,
          contract: contractId as ContractId,
          reason: result.reason ?? 'validator returned ok=false',
        };
      }
    }

    const inputKeys = Object.keys(der.manifest.inputs).sort();
    for (const key of inputKeys) {
      const childId = der.manifest.inputs[key]!;
      const childVerdict = await walk(childId);
      if (!childVerdict.ok) return childVerdict;
    }

    return { ok: true };
  }

  return walk(derivationId);
}

async function verifySignature(
  id: Digest,
  der: Derivation,
  options: VerifyOptions,
): Promise<Verdict> {
  const fail = (contract: string, reason: string): Verdict => ({
    ok: false,
    failedAt: id,
    contract: contract as ContractId,
    reason,
  });

  if (der.envelope === undefined) {
    return options.requireSigned
      ? fail('anchored-chain/unsigned', 'signature required but derivation is unsigned')
      : { ok: true };
  }

  // An envelope is present. If we cannot check it, do not silently trust it.
  if (options.verifier === undefined) {
    return options.requireSigned
      ? fail(
          'anchored-chain/no-verifier',
          'signature required but no verifier supplied',
        )
      : { ok: true };
  }

  // Bind the envelope to this derivation's manifest: the signed payload must
  // be the in-toto Statement of exactly this manifest.
  const { envelope: expected, pae } = assembleEnvelope(
    manifestToStatement(der.manifest),
  );
  if (der.envelope.payload !== expected.payload) {
    return fail(
      'anchored-chain/envelope-mismatch',
      'envelope payload does not match the derivation manifest',
    );
  }
  if (der.envelope.signatures.length === 0) {
    return fail('anchored-chain/unsigned', 'envelope carries no signatures');
  }

  for (const sig of der.envelope.signatures) {
    if (await options.verifier.verify(pae, sig)) return { ok: true };
  }
  return fail('anchored-chain/signature', 'no signature verified');
}
