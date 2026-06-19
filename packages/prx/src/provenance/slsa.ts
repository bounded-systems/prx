/**
 * SLSA Provenance v1 adapter — Phase A of the anchored-chain in-toto alignment
 * plan (docs/anchored-chain/in-toto-alignment-plan.md, the 2026-05-25 SLSA
 * amendment; design in docs/spikes/slsa-provenance-emission.md).
 *
 * This is the pure projection layer: it maps a completed capability call onto a
 * published `https://slsa.dev/provenance/v1` in-toto Statement and wraps it in a
 * DSSE envelope signed by the injected `Signer`. It deliberately lives in
 * `src/provenance/` (the machine side), NEVER inside `@bounded-systems/anchored-chain` whose
 * import allowlist is `node:crypto` + `@bounded-systems/cas` and whose extractability test
 * fails on any leak. The DSSE pre-authentication encoding (`dssePae`) and the
 * `Signer`/`Verifier` seam are reused from the core UNCHANGED — only the
 * predicate body is SLSA-shaped, mirroring how `manifestToStatement` is reused
 * for the bespoke predicate.
 *
 * No `zod` here on purpose: the published Statement is a plain serializable
 * value (same discipline as the core), so the shape stays liftable.
 */

import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  type DsseEnvelope,
  type Signer,
  type Verifier,
} from "@bounded-systems/anchored-chain";
import type { AuditRuntimeContext } from "@bounded-systems/audit-context";

export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

/**
 * An in-toto/SLSA digest set: algorithm → bare hex. `sha256` for CAS content,
 * `gitCommit` for a git object id (both are recognized in-toto algorithms, so
 * the subject is portable to `slsa-verifier` / cosign / Rekor without
 * translation). The `sha256:` brand prefix the `@bounded-systems/cas` `Digest` carries is
 * stripped at this boundary — in-toto digests are bare hex keyed by algorithm.
 */
export type SlsaDigestSet = Readonly<Record<string, string>>;

export interface SlsaResourceDescriptor {
  readonly name: string;
  readonly digest: SlsaDigestSet;
}

export interface SlsaProvenanceStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly SlsaResourceDescriptor[];
  readonly predicateType: typeof SLSA_PROVENANCE_PREDICATE_TYPE;
  readonly predicate: {
    readonly buildDefinition: {
      readonly buildType: string;
      readonly externalParameters: Readonly<Record<string, unknown>>;
      readonly internalParameters: Readonly<Record<string, unknown>>;
      readonly resolvedDependencies: readonly SlsaResourceDescriptor[];
    };
    readonly runDetails: {
      readonly builder: { readonly id: string };
      readonly metadata: {
        readonly invocationId: string;
        readonly startedOn: string;
        readonly finishedOn?: string;
      };
    };
  };
}

export interface SlsaProvenanceInput {
  /** `buildType` URI naming the capability that produced the subject. */
  readonly buildType: string;
  /** `runDetails.builder.id` — the agent identity (see {@link builderId}). */
  readonly builderId: string;
  /** The artifact(s) produced — `subject[]`. */
  readonly subject: readonly SlsaResourceDescriptor[];
  /** Materials consumed — `buildDefinition.resolvedDependencies[]`. */
  readonly resolvedDependencies?: readonly SlsaResourceDescriptor[];
  /** Sanitized call parameters — `buildDefinition.externalParameters`. */
  readonly externalParameters?: Readonly<Record<string, unknown>>;
  readonly internalParameters?: Readonly<Record<string, unknown>>;
  readonly invocationId: string;
  readonly startedOn: string;
  readonly finishedOn?: string;
}

/**
 * The agent identity stamped into `runDetails.builder.id`: `prx://<actor>/<verb>`
 * from `@bounded-systems/audit-context`. This is exactly the invoker an MCP tool call lacks
 * — the architectural reason emission lives at the capability boundary and MCP
 * is declined (spike §3).
 *
 * Session id is intentionally absent: `@bounded-systems/audit-context` exposes no session
 * field and no clean session-id source is surfaced today (spike §6 open
 * question). Phase A ships actor/verb only; the id can extend to carry a
 * session segment once a source exists, without changing this shape.
 */
export function builderId(
  ctx: Pick<AuditRuntimeContext, "actor" | "verb"> & Partial<Pick<AuditRuntimeContext, "source">>,
): string {
  // GH-352: prefer the dispatch *source* — the authority that initiated the run
  // (a leg, when this is a dispatched subprocess). A direct call has no source
  // and falls back to `actor` (the `claude-code` default). This is what makes a
  // leg-dispatched verb's provenance attribute to the leg's authority.
  const authority = ctx.source ?? ctx.actor;
  return `prx://${authority}/${ctx.verb ?? "unknown"}`;
}

/** Build the SLSA Provenance v1 Statement. Pure: same input → same Statement. */
export function slsaProvenanceStatement(input: SlsaProvenanceInput): SlsaProvenanceStatement {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: input.subject,
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: input.buildType,
        externalParameters: input.externalParameters ?? {},
        internalParameters: input.internalParameters ?? {},
        resolvedDependencies: input.resolvedDependencies ?? [],
      },
      runDetails: {
        builder: { id: input.builderId },
        metadata: {
          invocationId: input.invocationId,
          startedOn: input.startedOn,
          ...(input.finishedOn === undefined ? {} : { finishedOn: input.finishedOn }),
        },
      },
    },
  };
}

/**
 * Assemble an unsigned DSSE envelope around a SLSA Statement and return the PAE
 * the `Signer` actually signs. Mirrors `assembleEnvelope` from the core, but
 * over the SLSA-shaped Statement (the core function is typed to the bespoke
 * Statement only); the PAE construction itself reuses the core `dssePae`
 * unchanged, so the bytes signed are identical in form.
 */
export function assembleSlsaEnvelope(statement: SlsaProvenanceStatement): {
  envelope: DsseEnvelope;
  pae: Uint8Array;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(statement));
  return {
    envelope: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: Buffer.from(bytes).toString("base64"),
      signatures: [],
    },
    pae: dssePae(DSSE_PAYLOAD_TYPE, bytes),
  };
}

/** Sign a SLSA Statement, returning a DSSE envelope carrying the signature. */
export async function signSlsaStatement(
  statement: SlsaProvenanceStatement,
  signer: Signer,
): Promise<DsseEnvelope> {
  const { envelope, pae } = assembleSlsaEnvelope(statement);
  const signature = await signer.sign(pae);
  return { ...envelope, signatures: [signature] };
}

/**
 * Verify a DSSE envelope against the SLSA Statement it claims to wrap, using the
 * existing `Verifier` over the DSSE PAE. Binds the envelope to the Statement
 * (the signed payload must be exactly this Statement) before checking any
 * signature — the same fail-closed discipline as the core `validateDerivation`.
 */
export async function verifySlsaEnvelope(
  statement: SlsaProvenanceStatement,
  envelope: DsseEnvelope,
  verifier: Verifier,
): Promise<boolean> {
  const { envelope: expected, pae } = assembleSlsaEnvelope(statement);
  if (envelope.payload !== expected.payload) return false;
  if (envelope.signatures.length === 0) return false;
  for (const sig of envelope.signatures) {
    if (await verifier.verify(pae, sig)) return true;
  }
  return false;
}
