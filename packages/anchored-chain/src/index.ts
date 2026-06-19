export type {
  ActionPlan,
  ApplyResult,
  ContractId,
  Derivation,
  Digest,
  Ref,
  RefLogEntry,
  SurfaceRef,
  VerdictResult,
} from "./types.ts";

export type {
  Applier,
  ContractRegistry,
  Fetcher,
} from "./interfaces.ts";

// The CAS substrate anchored-chain builds on; re-exposed so consumers that
// hold an anchored-chain Ref can also reach the storage port and digest util.
export type { BlobStore } from "@bounded-systems/cas";

export type { RefStore } from "./ref-store.ts";
export { RefMismatchError } from "./ref-store.ts";

export type {
  DerivationInputRow,
  DerivationOutputRow,
  DerivationStore,
} from "./derivation-store.ts";

export { canonicalJson, digestManifest } from "./digest.ts";
export { sha256BareHex, sha256Hex } from "@bounded-systems/cas";

export {
  descendants as invalidateDescendants,
  type InvalidationCapable,
} from "./invalidate.ts";

export {
  ancestors,
  descendants as lineageDescendants,
  isStale,
  type LineageCapable,
} from "./lineage.ts";

export type { AnchoredChainStore } from "./store.ts";

export type { Verdict, ValidationCapable, VerifyOptions } from "./validate.ts";
export { validateRef, validateDerivation } from "./validate.ts";

export type {
  DerivationPredicate,
  DsseEnvelope,
  DsseSignature,
  InTotoDigestSet,
  InTotoStatement,
  InTotoSubject,
  Signer,
  Verifier,
} from "./in-toto.ts";
export {
  assembleEnvelope,
  dssePae,
  manifestToStatement,
  statementToManifest,
  DERIVATION_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE,
  STATEMENT_TYPE,
} from "./in-toto.ts";

export type { Ed25519Keypair } from "./signing.ts";
export {
  ed25519Keyid,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  importEd25519PrivateKey,
  importEd25519PublicKey,
} from "./signing.ts";

export {
  contractHolds,
  refAtDigest,
  refIsFresh,
  type GuardCtx,
  type GuardFn,
  type GuardResult,
} from "./guards.ts";

export type {
  Projection,
  ProjectionCapable,
  RefProjectionView,
} from "./projections.ts";
export { projectRef, projectMany } from "./projections.ts";
