/**
 * `src/provenance/` — Phase A of the anchored-chain in-toto/SLSA alignment.
 *
 * Emission at the capability boundary: a successful agent write (`@bounded-systems/git`
 * commit/push, opt-in `@bounded-systems/proc` artifact runs) produces a signed SLSA
 * Provenance v1 `Derivation` in the anchored-chain ledger. Lives on the machine
 * side, outside the extractable `@bounded-systems/anchored-chain` core, and reuses that
 * core's DSSE/`Signer`/`Verifier` seam unchanged.
 *
 * See docs/anchored-chain/in-toto-alignment-plan.md (Phase A) and
 * docs/spikes/slsa-provenance-emission.md.
 */

export {
  IN_TOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  assembleSlsaEnvelope,
  builderId,
  signSlsaStatement,
  slsaProvenanceStatement,
  verifySlsaEnvelope,
} from "./slsa.ts";
export type {
  SlsaDigestSet,
  SlsaProvenanceInput,
  SlsaProvenanceStatement,
  SlsaResourceDescriptor,
} from "./slsa.ts";

export {
  GIT_COMMIT_BUILD_TYPE,
  GIT_PUSH_BUILD_TYPE,
  attestingGit,
  attestingProc,
  gitAttestable,
} from "./attest.ts";
export type {
  AttestDeps,
  AttestingGit,
  ProcAttestSubject,
} from "./attest.ts";

export {
  DEV_SIGNER_MODE,
  PROVENANCE_KEY_ENV,
  PROVENANCE_PUBKEY_ENV,
  REQUIRE_SIGNED_ENV,
  STABLE_KEY_PREFIX,
  requireSignedDerivations,
  resolveProvenanceSigner,
  resolveProvenanceVerifier,
} from "./signer.ts";

export {
  decodeSlsaStatement,
  verifySlsaDerivation,
  verifySlsaDerivationEnvelope,
} from "./verify.ts";

export {
  DEV_KEY_DIR,
  DEV_KEY_FILE,
  DevKeyError,
  loadOrCreateDevKeypair,
  resolveDevKeyPath,
  resolveDevKeyPathForDisplay,
} from "./dev-key.ts";
export type {
  DevKeyFile,
  DevKeyPathResolution,
  DevKeypair,
} from "./dev-key.ts";

export {
  projectProvenanceAxis,
  provenanceEventFor,
} from "./merge-guard.ts";
export type {
  ProvenanceEvent,
  ProvenanceProjectionDeps,
} from "./merge-guard.ts";
