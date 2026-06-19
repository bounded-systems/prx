/**
 * Slack read → anchored-chain derivation.
 *
 * execSlackRead content-addresses a read but records no lineage. This bridge
 * turns the envelope into a verifiable node in the provenance graph — a
 * `Derivation` whose `inputs` carry the digest of the QUERY the read issued
 * (op + params) and whose `outputs` carry the digest of the emitted envelope.
 * Provenance here is query→result: with the query digest as an input,
 * `store.invalidate.descendants(queryDigest)` answers "which reads issued this
 * query?".
 *
 * AUTHORITY AS PROVENANCE: the manifest params anchor the minted key's
 * {keyId, scope, expiresAt} (never the secret) — the chain attests not just
 * "this data was read" but "…under key K, scoped to these ops/channels, minted
 * to expire at T". This is the Fulcio/Rekor pattern (ephemeral identity-bound
 * key recorded in an append-only log) realized on prx's own anchored-chain
 * rather than Sigstore's runtime. See the keymaker prior-art memory.
 *
 * The derivationId is the manifest digest, so the same envelope at the same
 * instant yields the same id — reproducible.
 */

import { digestManifest } from "@bounded-systems/anchored-chain";
import type {
  Derivation,
  DerivationStore,
  Digest,
  InTotoSubject,
} from "@bounded-systems/anchored-chain";
import { sha256Hex } from "@bounded-systems/cas";

import { canonicalJson } from "./canonical.ts";
import { formatSlackReadEnvelope, type SlackReadEnvelope } from "./read.ts";
import type { SlackReadOp } from "./types.ts";

/** The artifact contract a recorded slack-read envelope claims to satisfy. */
export const SLACK_READ_CONTRACT = "slack.read/v1";

/** Producer id for a read of `op` (e.g. "slack.history"). */
export function slackReadProducer(op: SlackReadOp): string {
  return `slack.${op}`;
}

export interface SlackReadDerivationOptions {
  /** Derivation timestamp; injected so records are deterministic in tests. */
  now?: number;
}

/**
 * Build (without recording) the derivation for a completed slack read. Pure:
 * the same envelope + timestamp always produces the same `derivationId`.
 */
export function slackReadDerivation(
  envelope: SlackReadEnvelope,
  opts: SlackReadDerivationOptions = {},
): Derivation {
  // Input: the query that was issued (op + params), content-addressed.
  const queryDigest = sha256Hex(canonicalJson({ op: envelope.op, params: envelope.params }));
  // Output: the exact envelope the dispatch layer writes to CAS, so the
  // derivation's output digest equals the `slack://sha256:…` handle's sha.
  const envelopeDigest = sha256Hex(formatSlackReadEnvelope(envelope));

  const manifest: Derivation["manifest"] = {
    producer: slackReadProducer(envelope.op),
    inputs: { query: queryDigest },
    outputs: { envelope: envelopeDigest },
    contracts: [SLACK_READ_CONTRACT],
    params: {
      op: envelope.op,
      // the data content address (the {op,params,result} envelope's sha)
      sha256: envelope.sha256,
      // authority-as-provenance — non-secret key attribution
      keyId: envelope.keyId,
      scope: envelope.scope,
      expiresAt: envelope.expiresAt,
    },
  };

  return {
    derivationId: digestManifest(manifest),
    manifest,
    ts: opts.now ?? Date.now(),
  };
}

/**
 * Record a slack read in the ledger. Idempotent: the derivationId is content-
 * addressed, so re-recording an identical read returns the stored derivation
 * without a duplicate append.
 */
export async function recordSlackReadDerivation(
  derivations: DerivationStore,
  envelope: SlackReadEnvelope,
  opts: SlackReadDerivationOptions = {},
): Promise<Derivation> {
  const derivation = slackReadDerivation(envelope, opts);
  const existing = await derivations.get(derivation.derivationId);
  if (existing) return existing;
  await derivations.append(derivation);
  return derivation;
}

// SLSA / in-toto provenance export — projects the bespoke derivation onto the
// published SLSA Provenance v1 predicate so the record is portable to any
// in-toto/SLSA verifier (Rekor, slsa-verifier, …) without adopting their
// runtime.

export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const SLACK_READ_BUILD_TYPE = "https://anchored-chain.dev/slack/read/v1";
export const SLACK_READ_BUILDER_ID = "https://anchored-chain.dev/slack.read";

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
      readonly buildType: typeof SLACK_READ_BUILD_TYPE;
      readonly externalParameters: Readonly<Record<string, unknown>>;
      readonly internalParameters: Readonly<Record<string, unknown>>;
      readonly resolvedDependencies: readonly SlsaResourceDescriptor[];
    };
    readonly runDetails: {
      readonly builder: { readonly id: typeof SLACK_READ_BUILDER_ID };
      readonly metadata: { readonly invocationId: string; readonly startedOn: string };
    };
  };
}

function bareHex(digest: Digest): string {
  const s = digest as string;
  return s.startsWith("sha256:") ? s.slice("sha256:".length) : s;
}

/**
 * Project a slack read onto a SLSA Provenance v1 in-toto Statement: the emitted
 * envelope is the subject (the artifact produced), the query is a resolved
 * dependency (the material consumed), and the read params + key attribution are
 * the external parameters of the build. Derived from {@link slackReadDerivation}
 * so the digests are identical to the ledger record.
 */
export function slackReadProvenance(
  envelope: SlackReadEnvelope,
  opts: SlackReadDerivationOptions = {},
): SlsaProvenanceStatement {
  const derivation = slackReadDerivation(envelope, opts);
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
        buildType: SLACK_READ_BUILD_TYPE,
        externalParameters: params,
        internalParameters: {},
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: SLACK_READ_BUILDER_ID },
        metadata: {
          invocationId: derivation.derivationId as string,
          startedOn: new Date(derivation.ts).toISOString(),
        },
      },
    },
  };
}

/** Render the SLSA provenance statement as a single JSON object + newline. */
export function formatSlackReadProvenanceJson(
  envelope: SlackReadEnvelope,
  opts: SlackReadDerivationOptions = {},
): string {
  return JSON.stringify(slackReadProvenance(envelope, opts)) + "\n";
}
