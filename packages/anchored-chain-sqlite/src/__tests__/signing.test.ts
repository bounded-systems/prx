import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  assembleEnvelope,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  manifestToStatement,
  openAnchoredChain,
  validateDerivation,
  type ContractRegistry,
  type Derivation,
  type Digest,
  type DsseEnvelope,
  type AnchoredChainStore,
} from '@bounded-systems/anchored-chain-sqlite';

// Phase 1 — proves DSSE signing delivers authenticated provenance:
// a tampered or unsigned-but-required derivation fails closed, a correctly
// signed one verifies, and a wrong key is rejected. Registry is empty (no
// contracts) so the only thing under test is the signature gate.

let store: AnchoredChainStore;

beforeEach(() => {
  store = openAnchoredChain(':memory:');
});

afterEach(() => {
  store.close();
});

const emptyRegistry: ContractRegistry = {
  getValidator: () => () => ({ ok: true }),
};

const D = (s: string) => `sha256:${s.padEnd(64, '0')}` as Digest;

// No inputs: the signature gate is the only thing under test, so the DAG
// walk should not recurse into (absent) input derivations.
const manifest: Derivation['manifest'] = {
  producer: 'agent:reviewer',
  inputs: {},
  outputs: { review: D('review') },
  contracts: [],
  params: { status: 'approved' },
};

async function signedDerivation(signer: {
  sign: (pae: Uint8Array) => Promise<{ sig: string; keyid?: string }>;
}): Promise<Derivation> {
  const { envelope, pae } = assembleEnvelope(manifestToStatement(manifest));
  const sig = await signer.sign(pae);
  const signed: DsseEnvelope = { ...envelope, signatures: [sig] };
  return { derivationId: D('deriv'), manifest, envelope: signed, ts: 0 };
}

describe('DSSE signing (anchored-chain provenance)', () => {
  test('signed derivation verifies under the matching verifier', async () => {
    const kp = generateEd25519Keypair();
    const der = await signedDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    await store.derivations.append(der);

    const verdict = await validateDerivation(
      der.derivationId,
      store.derivations,
      emptyRegistry,
      { verifier: ed25519Verifier(kp.publicKey), requireSigned: true },
    );
    expect(verdict).toEqual({ ok: true });
  });

  test('requireSigned + unsigned derivation → fails closed', async () => {
    const der: Derivation = { derivationId: D('deriv'), manifest, ts: 0 };
    await store.derivations.append(der);

    const kp = generateEd25519Keypair();
    const verdict = await validateDerivation(
      der.derivationId,
      store.derivations,
      emptyRegistry,
      { verifier: ed25519Verifier(kp.publicKey), requireSigned: true },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.contract as string).toBe('anchored-chain/unsigned');
  });

  test('unsigned derivation passes when signing is not required (backward compatible)', async () => {
    const der: Derivation = { derivationId: D('deriv'), manifest, ts: 0 };
    await store.derivations.append(der);

    const verdict = await validateDerivation(
      der.derivationId,
      store.derivations,
      emptyRegistry,
    );
    expect(verdict).toEqual({ ok: true });
  });

  test('wrong key → signature rejected', async () => {
    const signingKp = generateEd25519Keypair();
    const der = await signedDerivation(
      ed25519Signer(signingKp.privateKey, signingKp.keyid),
    );
    await store.derivations.append(der);

    const attacker = generateEd25519Keypair();
    const verdict = await validateDerivation(
      der.derivationId,
      store.derivations,
      emptyRegistry,
      { verifier: ed25519Verifier(attacker.publicKey), requireSigned: true },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.contract as string).toBe('anchored-chain/signature');
  });

  test('tampered manifest → envelope no longer binds → mismatch', async () => {
    const kp = generateEd25519Keypair();
    const der = await signedDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    // Swap in a different manifest while keeping the original signed envelope.
    const tampered: Derivation = {
      ...der,
      manifest: { ...manifest, params: { status: 'changes_requested' } },
    };
    await store.derivations.append(tampered);

    const verdict = await validateDerivation(
      tampered.derivationId,
      store.derivations,
      emptyRegistry,
      { verifier: ed25519Verifier(kp.publicKey), requireSigned: true },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.contract as string).toBe('anchored-chain/envelope-mismatch');
  });

  test('envelope survives the sqlite round-trip', async () => {
    const kp = generateEd25519Keypair();
    const der = await signedDerivation(ed25519Signer(kp.privateKey, kp.keyid));
    await store.derivations.append(der);

    const loaded = await store.derivations.get(der.derivationId);
    expect(loaded?.envelope).toEqual(der.envelope);
  });
});
