/**
 * Scout read → anchored-chain derivation.
 *
 * A `scout read` is content addressing without provenance: it hashes a file
 * and emits an envelope. This bridge turns that hashed blob into a verifiable
 * artifact — a `Derivation` recorded in the anchored-chain ledger — so the
 * read becomes a queryable node in the provenance graph rather than a loose
 * sha.
 *
 * Shape follows the canonical fetcher example
 * (anchored-chain/__examples__/pr-end-to-end.ts): a root derivation whose
 * `inputs` carry the external content digest (the file the read consumed) and
 * whose `outputs` carry the digest of the emitted envelope. With the source
 * file's content digest as an input, `store.invalidate.descendants(fileDigest)`
 * answers "which scout reads consumed this file?" — provenance lineage, not
 * just a checksum.
 *
 * scout depends on anchored-chain here by design (both are CAS-shaped; the
 * read produces a provenance record). The derivationId is the manifest digest,
 * so the same file read at the same instant yields the same id — reproducible.
 */

import { digestManifest } from "@bounded-systems/anchored-chain";
import type {
  Derivation,
  DerivationStore,
  Digest,
  InTotoSubject,
} from "@bounded-systems/anchored-chain";
import { sha256Hex } from "@bounded-systems/cas";

import { formatScoutReadJson, type ScoutReadResult } from "./read.ts";

export const SCOUT_READ_PRODUCER = "scout.read";

/** The artifact contract a recorded scout-read envelope claims to satisfy. */
export const SCOUT_READ_CONTRACT = "scout.read/v1";

export interface ScoutReadDerivationOptions {
  /** Derivation timestamp; injected so records are deterministic in tests. */
  now?: number;
}

/**
 * Build (without recording) the derivation for a completed scout read. Pure:
 * the same result + timestamp always produces the same `derivationId`.
 */
export function scoutReadDerivation(
  result: ScoutReadResult,
  opts: ScoutReadDerivationOptions = {},
): Derivation {
  // The read already holds the file's content digest as bare hex; the source
  // input is that content, prefixed into a CAS Digest.
  const sourceDigest = `sha256:${result.sha256}` as Digest;
  // The output is the exact envelope the dispatch layer writes to CAS, so the
  // derivation's output digest equals the `scout://sha256:…` handle's sha.
  const envelopeDigest = sha256Hex(formatScoutReadJson(result));

  const manifest: Derivation["manifest"] = {
    producer: SCOUT_READ_PRODUCER,
    inputs: { source: sourceDigest },
    outputs: { envelope: envelopeDigest },
    contracts: [SCOUT_READ_CONTRACT],
    params: {
      path: result.path,
      bytes: result.bytes,
      lines: result.lines,
      truncated: result.truncated,
    },
  };

  return {
    derivationId: digestManifest(manifest),
    manifest,
    ts: opts.now ?? Date.now(),
  };
}

/**
 * Record a scout read in the ledger. Idempotent: the derivationId is content-
 * addressed, so re-recording an identical read returns the stored derivation
 * without a duplicate append.
 */
export async function recordScoutReadDerivation(
  derivations: DerivationStore,
  result: ScoutReadResult,
  opts: ScoutReadDerivationOptions = {},
): Promise<Derivation> {
  const derivation = scoutReadDerivation(result, opts);
  const existing = await derivations.get(derivation.derivationId);
  if (existing) return existing;
  await derivations.append(derivation);
  return derivation;
}

// SLSA / in-toto provenance export. Our derivation manifest is bespoke; this
// projects it onto the published SLSA Provenance v1 predicate so the record is
// portable to any in-toto/SLSA verifier (Rekor, slsa-verifier, …) without
// adopting their runtime. A counterpart to scout's JSON-Schema export: scout
// owns the shape it hands downstream.

export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const SCOUT_READ_BUILD_TYPE = "https://anchored-chain.dev/scout/read/v1";
export const SCOUT_READ_BUILDER_ID = "https://anchored-chain.dev/scout.read";

interface SlsaResourceDescriptor {
  readonly name: string;
  readonly digest: { readonly sha256: string };
}

export interface SlsaProvenanceStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly InTotoSubject[];
  readonly predicateType: typeof SLSA_PROVENANCE_PREDICATE_TYPE;
  readonly predicate: {
    readonly buildDefinition: {
      readonly buildType: typeof SCOUT_READ_BUILD_TYPE;
      readonly externalParameters: Readonly<Record<string, unknown>>;
      readonly internalParameters: Readonly<Record<string, unknown>>;
      readonly resolvedDependencies: readonly SlsaResourceDescriptor[];
    };
    readonly runDetails: {
      readonly builder: { readonly id: typeof SCOUT_READ_BUILDER_ID };
      readonly metadata: { readonly invocationId: string; readonly startedOn: string };
    };
  };
}

function bareHex(digest: Digest): string {
  const s = digest as string;
  return s.startsWith("sha256:") ? s.slice("sha256:".length) : s;
}

/**
 * Project a scout read onto a SLSA Provenance v1 in-toto Statement: the emitted
 * envelope is the subject (the artifact produced), the source file is a
 * resolved dependency (the material consumed), and the read parameters are the
 * external parameters of the build. Derived from {@link scoutReadDerivation} so
 * the digests are identical to the ledger record.
 */
export function scoutReadProvenance(
  result: ScoutReadResult,
  opts: ScoutReadDerivationOptions = {},
): SlsaProvenanceStatement {
  const derivation = scoutReadDerivation(result, opts);
  const { inputs, outputs, params } = derivation.manifest;

  const subject: InTotoSubject[] = Object.entries(outputs).map(([name, digest]) => ({
    name,
    digest: { sha256: bareHex(digest) },
  }));
  const resolvedDependencies: SlsaResourceDescriptor[] = Object.entries(inputs).map(
    ([name, digest]) => ({ name, digest: { sha256: bareHex(digest) } }),
  );

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject,
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: SCOUT_READ_BUILD_TYPE,
        externalParameters: params,
        internalParameters: {},
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: SCOUT_READ_BUILDER_ID },
        metadata: {
          invocationId: derivation.derivationId as string,
          startedOn: new Date(derivation.ts).toISOString(),
        },
      },
    },
  };
}

/** Render the SLSA provenance statement as a single JSON object + newline. */
export function formatScoutReadProvenanceJson(
  result: ScoutReadResult,
  opts: ScoutReadDerivationOptions = {},
): string {
  return JSON.stringify(scoutReadProvenance(result, opts)) + "\n";
}
