// `scout read` → a signed, content-addressed `scout/read/v1` derivation (GH-352).
//
// A bare `scout read` records *integrity only* (the unsigned bespoke
// `recordScoutReadDerivation`) because it runs under no actor authority. When a
// signer is configured this emits the SIGNED counterpart, mirroring the CI
// attestation (`ci-attest.ts`): the same SLSA/DSSE path (`persistAttestation`),
// content-addressed and merge-guard-verifiable. The read is already bucket A —
// `sha256:source → sha256:envelope` — so a signed scout read composes with CI
// derivations in one chain.
//
// Attribution flows from the ambient audit context (`builder.id`): a scout read
// dispatched inside a leg signs with that leg's authority via the propagated
// dispatch `source` (a direct read falls back to the `claude-code` default).
import type { Derivation } from "@bounded-systems/anchored-chain";
import { sha256BareHex } from "@bounded-systems/cas";
import { formatScoutReadJson, type ScoutReadResult } from "@bounded-systems/scout";

import { type AttestDeps, persistAttestation } from "../provenance/attest.ts";

/** The build type for a signed scout read — the SLSA counterpart of scout's
 *  bespoke `scout.read/v1` ledger record, keyed the same way (source→envelope). */
export const SCOUT_READ_BUILD_TYPE = "https://prx.dev/scout/read/v1";

/**
 * Record a signed `scout/read/v1` derivation for a completed read: the file's
 * content digest is the input (`source`), the emitted envelope's digest is the
 * output (`envelope`), so `invalidate.descendants(sourceDigest)` answers "which
 * reads consumed this file?" and the record verifies via `verifySlsaDerivation`.
 *
 * Idempotent: `persistAttestation` content-addresses the manifest, so the same
 * read returns the stored derivation without a duplicate append. Pure over its
 * `deps` (signer + store); the CLI resolves the live signer and opens the ledger.
 */
export async function attestScoutRead(
  deps: AttestDeps,
  result: ScoutReadResult,
): Promise<Derivation> {
  // The envelope digest equals the `scout://sha256:…` handle's content — the
  // exact bytes the dispatch layer writes to CAS (see scout's provenance.ts).
  const envelope = sha256BareHex(formatScoutReadJson(result));
  return persistAttestation(deps, {
    buildType: SCOUT_READ_BUILD_TYPE,
    subject: [{ name: "envelope", digest: { sha256: envelope } }],
    resolvedDependencies: [{ name: "source", digest: { sha256: result.sha256 } }],
    externalParameters: {
      path: result.path,
      bytes: result.bytes,
      lines: result.lines,
      truncated: result.truncated,
    },
  });
}
