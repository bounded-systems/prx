import { describe, expect, test } from 'bun:test';
import {
  assembleEnvelope,
  dssePae,
  ed25519Keyid,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  manifestToStatement,
  projectMany,
  projectRef,
  statementToManifest,
  validateDerivation,
  validateRef,
  DERIVATION_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE,
  STATEMENT_TYPE,
} from '@bounded-systems/anchored-chain';
import type {
  ActionPlan,
  Applier,
  ApplyResult,
  BlobStore,
  ContractId,
  ContractRegistry,
  Derivation,
  DerivationPredicate,
  Digest,
  DsseEnvelope,
  DsseSignature,
  Ed25519Keypair,
  Fetcher,
  InTotoDigestSet,
  InTotoStatement,
  InTotoSubject,
  Projection,
  ProjectionCapable,
  Ref,
  RefLogEntry,
  RefProjectionView,
  Signer,
  SurfaceRef,
  ValidationCapable,
  Verdict,
  VerdictResult,
  Verifier,
  VerifyOptions,
} from '@bounded-systems/anchored-chain';

describe('anchored-chain public surface', () => {
  test('all public types are importable via @bounded-systems/anchored-chain', () => {
    const _typeWitness: Record<string, true> = {
      Digest: true,
      Ref: true,
      RefLogEntry: true,
      Derivation: true,
      ContractId: true,
      SurfaceRef: true,
      ActionPlan: true,
      ApplyResult: true,
      VerdictResult: true,
      Fetcher: true,
      BlobStore: true,
      Applier: true,
      ContractRegistry: true,
      Verdict: true,
      ValidationCapable: true,
      validateRef: true,
      validateDerivation: true,
      Projection: true,
      ProjectionCapable: true,
      RefProjectionView: true,
      projectRef: true,
      projectMany: true,
      // Phase 1 — in-toto + DSSE signing surface.
      VerifyOptions: true,
      InTotoStatement: true,
      InTotoSubject: true,
      InTotoDigestSet: true,
      DerivationPredicate: true,
      DsseEnvelope: true,
      DsseSignature: true,
      Signer: true,
      Verifier: true,
      Ed25519Keypair: true,
      manifestToStatement: true,
      statementToManifest: true,
      dssePae: true,
      assembleEnvelope: true,
      STATEMENT_TYPE: true,
      DERIVATION_PREDICATE_TYPE: true,
      DSSE_PAYLOAD_TYPE: true,
      generateEd25519Keypair: true,
      ed25519Signer: true,
      ed25519Verifier: true,
      ed25519Keyid: true,
    };
    expect(Object.keys(_typeWitness)).toHaveLength(43);
    expect(typeof validateRef).toBe('function');
    expect(typeof validateDerivation).toBe('function');
    expect(typeof projectRef).toBe('function');
    expect(typeof projectMany).toBe('function');
    // Phase 1 runtime exports are callable / present.
    for (const fn of [
      manifestToStatement,
      statementToManifest,
      dssePae,
      assembleEnvelope,
      generateEd25519Keypair,
      ed25519Signer,
      ed25519Verifier,
      ed25519Keyid,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(STATEMENT_TYPE).toContain('in-toto.io');
    expect(DSSE_PAYLOAD_TYPE).toContain('in-toto');
    expect(DERIVATION_PREDICATE_TYPE).toContain('anchored-chain');
    const _verifyOptsWitness: VerifyOptions | null = null;
    const _stmtWitness: InTotoStatement | null = null;
    const _subjWitness: InTotoSubject | null = null;
    const _digestSetWitness: InTotoDigestSet | null = null;
    const _predWitness: DerivationPredicate | null = null;
    const _envWitness: DsseEnvelope | null = null;
    const _sigWitness: DsseSignature | null = null;
    const _signerWitness: Signer | null = null;
    const _verifierWitness: Verifier | null = null;
    const _keypairWitness: Ed25519Keypair | null = null;
    expect(_verifyOptsWitness).toBeNull();
    expect(_stmtWitness).toBeNull();
    expect(_subjWitness).toBeNull();
    expect(_digestSetWitness).toBeNull();
    expect(_predWitness).toBeNull();
    expect(_envWitness).toBeNull();
    expect(_sigWitness).toBeNull();
    expect(_signerWitness).toBeNull();
    expect(_verifierWitness).toBeNull();
    expect(_keypairWitness).toBeNull();
    const _verdictWitness: Verdict = { ok: true };
    const _capableWitness: ValidationCapable | null = null;
    const _projectionCapableWitness: ProjectionCapable | null = null;
    const _projectionWitness: Projection<RefProjectionView> | null = null;
    const _viewWitness: RefProjectionView | null = null;
    expect(_verdictWitness.ok).toBe(true);
    expect(_capableWitness).toBeNull();
    expect(_projectionCapableWitness).toBeNull();
    expect(_projectionWitness).toBeNull();
    expect(_viewWitness).toBeNull();
  });

  test('branded types compose with interfaces at the type level', () => {
    const digest = 'abc123' as Digest;
    const contractId = 'contract/v1' as ContractId;

    const ref: Ref = { name: 'main', digest, ts: 0 };
    const logEntry: RefLogEntry = {
      name: 'main',
      prevDigest: null,
      newDigest: digest,
      reason: 'init',
      ts: 0,
    };
    const derivation: Derivation = {
      derivationId: digest,
      manifest: {
        producer: 'noop',
        inputs: {},
        outputs: {},
        contracts: [],
        params: {},
      },
      ts: 0,
    };
    const surface: SurfaceRef = { name: 'main' };
    const plan: ActionPlan = { producer: 'noop' };
    const applyResult: ApplyResult = { ok: true };
    const verdict: VerdictResult = { ok: true };

    const fetcher: Fetcher = {
      fetch: async () => ({ digest, bytes: new Uint8Array(), freshnessSignal: '' }),
      isFresh: async () => true,
    };
    const blobStore: BlobStore = {
      put: async () => digest,
      get: async () => new Uint8Array(),
      has: async () => false,
    };
    const applier: Applier = { apply: async () => applyResult };
    const registry: ContractRegistry = {
      getValidator: () => () => verdict,
    };

    expect(ref.digest).toBe(digest);
    expect(logEntry.newDigest).toBe(digest);
    expect(derivation.derivationId).toBe(digest);
    expect(surface.name).toBe('main');
    expect(plan.producer).toBe('noop');
    expect(applyResult.ok).toBe(true);
    expect(verdict.ok).toBe(true);
    expect(typeof fetcher.fetch).toBe('function');
    expect(typeof blobStore.put).toBe('function');
    expect(typeof applier.apply).toBe('function');
    expect(typeof registry.getValidator).toBe('function');
    expect(contractId as string).toBe('contract/v1');
  });
});
