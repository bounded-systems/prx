/**
 * Work-unit source pin (prx-adj, epic prx-997) — now a SIGNED chain root (GH-292).
 *
 * The provenance chain (`plan@ → implement@latest → commit/v1 → checks/v1 →
 * push/v1`) referenced a unit by id but never content-anchored its *source* —
 * the GH issue / beads row / Notion ticket that is the unit's authority. This
 * pins that source as the chain ROOT: `<unit>:source@pinned`.
 *
 * GH-292: the root is not bare content — *the actor that submitted the unit signs
 * the input text, and that signature IS the artifact*. `signWorkUnitSource` mints
 * an in-toto attestation (DSSE/ed25519 via the existing provenance stack) over the
 * canonical input text; the pinned value carries `{submittedBy, sig, inputDigest}`.
 * Downstream consumers `verifyWorkUnitSource` before trusting it, so the chain has
 * no unsigned node — intake is just the root *spawn*.
 *
 * It is the Nix fixed-output-derivation bridge ({@link pinSource}) applied to the
 * issue: the impure read (the resolver fetch) is hashed and pinned by content, so
 * the chain is anchored to the *exact issue text* at the moment it entered.
 * {@link workUnitSourceFresh} makes drift observable — `fresh: false` means the
 * upstream issue was edited since the pin.
 *
 * Persistence is `"git"` because the source lives in an external system (a
 * git-hosted issue / a dolt-backed bead), not the CAS — exactly the FOD case the
 * edge primitive was built for.
 */
import { z } from "zod";

import type { ResolvedWorkUnit } from "../pr-state/resolvers/types.ts";
import {
  IN_TOTO_STATEMENT_TYPE,
  sha256Hex,
  type StatementSigner,
  type Subject,
} from "../machine/machines/provenance.ts";
import {
  provenanceSigner,
  realStatementSigner,
  verifyStatement,
  type Verifier,
} from "../machine/machines/pilot-signing.ts";

import {
  type ArtifactEdge,
  type EmitResult,
  type FreshnessResult,
  consumeArtifact,
  defineEdge,
  pinSource,
} from "./edge.ts";

/** The predicate type for an intake submission attestation. */
export const INTAKE_PREDICATE_TYPE = "https://prx.bounded.systems/intake/v1";

/**
 * The submitter's signature over the input text. GH-292: the signature IS the
 * root artifact's authority. `inputDigest` is sha256 of {@link canonicalSourceInput}
 * so a consumer can re-derive it and confirm the sig is over THIS text.
 */
export const sourceAttestationSchema = z.object({
  predicateType: z.string(),
  /** The submitting actor's signing-key id (`signedBy`). */
  submittedBy: z.string(),
  /** ed25519 signature over the DSSE PAE of the intake statement. */
  sig: z.string(),
  /** sha256 of the canonical input text the signature commits to. */
  inputDigest: z.string(),
});
export type SourceAttestation = z.infer<typeof sourceAttestationSchema>;

/**
 * The schema for a pinned source — the resolver's {@link ResolvedWorkUnit} plus
 * the submitter attestation. `attestation` is optional on the wire (transition);
 * the *requirement* that a consumed source be signed+verified is enforced at the
 * consume/spawn seam (GH-288/GH-293), not here.
 */
export const resolvedSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed", "unknown"]),
  url: z.string().nullable(),
  source: z.enum(["github", "notion", "beads"]),
  attestation: sourceAttestationSchema.optional(),
});
export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;

/** The source edge: the issue/bead authority pinned at the head of the chain. */
export const workUnitSourceEdge: ArtifactEdge<ResolvedSource> = defineEdge({
  kind: "source",
  slot: "pinned",
  source: "issue",
  target: "intake",
  persistence: "git",
  schema: resolvedSourceSchema,
});

/**
 * The canonical input text the submitting actor signs over — exactly the resolver
 * content, with the attestation excluded (the signature can't commit to itself).
 * Fixed key order so sign and verify hash identical bytes.
 */
export function canonicalSourceInput(resolved: {
  id: string;
  title: string;
  body: string | null;
  state: "open" | "closed" | "unknown";
  url: string | null;
  source: "github" | "notion" | "beads";
}): string {
  return JSON.stringify({
    id: resolved.id,
    title: resolved.title,
    body: resolved.body ?? null,
    state: resolved.state,
    url: resolved.url ?? null,
    source: resolved.source,
  });
}

/** Normalize a resolver result onto the pinned-source content shape (no attestation). */
function toContent(resolved: ResolvedWorkUnit): Omit<ResolvedSource, "attestation"> {
  return {
    id: resolved.id,
    title: resolved.title,
    body: resolved.body ?? null,
    state: resolved.state,
    url: resolved.url ?? null,
    source: resolved.source,
  };
}

/** The (predicateType, subject, predicate) the submitter signs / a verifier checks. */
function sourceStatementArgs(
  content: Omit<ResolvedSource, "attestation">,
  inputDigest: string,
): { predicateType: string; subject: Subject[]; predicate: Record<string, unknown> } {
  return {
    predicateType: INTAKE_PREDICATE_TYPE,
    subject: [{ name: `${content.id}:source@pinned`, digest: { sha256: inputDigest } }],
    predicate: { source: content.source, state: content.state, url: content.url },
  };
}

/**
 * Sign the input text with the submitting actor's authority. The returned value
 * — content + attestation — is the signed root artifact (`<unit>:source@pinned`).
 */
export async function signWorkUnitSource(
  resolved: ResolvedWorkUnit,
  signer: StatementSigner,
): Promise<ResolvedSource> {
  const content = toContent(resolved);
  const inputDigest = sha256Hex(canonicalSourceInput(content));
  const { signedBy, sig } = await signer(sourceStatementArgs(content, inputDigest));
  return {
    ...content,
    attestation: { predicateType: INTAKE_PREDICATE_TYPE, submittedBy: signedBy, sig, inputDigest },
  };
}

/**
 * Verify that `value` carries a valid submitter signature over its own input
 * text. Re-derives `inputDigest` from the content (so a tampered body fails) and
 * checks the ed25519 signature. A value with no attestation is unverifiable ⇒ false.
 */
export async function verifyWorkUnitSource(
  value: ResolvedSource,
  verifier: Verifier,
): Promise<boolean> {
  if (!value.attestation) return false;
  const inputDigest = sha256Hex(canonicalSourceInput(value));
  if (inputDigest !== value.attestation.inputDigest) return false;
  const args = sourceStatementArgs(value, inputDigest);
  return verifyStatement(verifier, {
    _type: IN_TOTO_STATEMENT_TYPE,
    predicateType: args.predicateType,
    subject: args.subject,
    predicate: args.predicate,
    signedBy: value.attestation.submittedBy,
    sig: value.attestation.sig,
  });
}

/**
 * Pin a unit's resolved source authority to `<unit>:source@pinned`, signed by the
 * submitting actor. The `signer` is the chokepoint — there is no unsigned pin.
 */
export async function pinWorkUnitSource(
  unit: string,
  resolved: ResolvedWorkUnit,
  signer: StatementSigner,
): Promise<EmitResult> {
  const signed = await signWorkUnitSource(resolved, signer);
  return pinSource(workUnitSourceEdge, unit, () => signed);
}

/**
 * Whether the live source still matches what was pinned for `unit`, by comparing
 * the canonical input digests. `fresh: false` ⇒ the upstream issue/bead drifted
 * since the pin (or nothing is pinned).
 */
export async function workUnitSourceFresh(
  unit: string,
  resolved: ResolvedWorkUnit,
): Promise<FreshnessResult> {
  const liveDigest = sha256Hex(canonicalSourceInput(toContent(resolved)));
  const sourceSha = `sha256:${liveDigest}`;
  let pinned;
  try {
    pinned = await consumeArtifact(workUnitSourceEdge, unit);
  } catch {
    return { fresh: false, pinnedSha: null, sourceSha };
  }
  if (pinned.missing || !pinned.value.attestation) {
    return { fresh: false, pinnedSha: null, sourceSha };
  }
  const pinnedDigest = pinned.value.attestation.inputDigest;
  return {
    fresh: pinnedDigest === liveDigest,
    pinnedSha: `sha256:${pinnedDigest}`,
    sourceSha,
  };
}

/**
 * Best-effort signed pin used at authority resolution: a CAS write failure (or a
 * missing signer) must never break session entry, so a throw is swallowed and
 * reported as `pinned: false`. GH-292: NEVER writes an unsigned pin — without a
 * resolvable signer it degrades to `pinned: false` and the explicit
 * `prx intake source` (key-gated) becomes the required path.
 */
export async function pinWorkUnitSourceBestEffort(
  unit: string,
  resolved: ResolvedWorkUnit,
  signer?: StatementSigner,
): Promise<{ pinned: boolean; ref: string }> {
  try {
    const effectiveSigner = signer ?? ambientStatementSigner();
    if (!effectiveSigner) return { pinned: false, ref: "" };
    const { ref } = await pinWorkUnitSource(unit, resolved, effectiveSigner);
    return { pinned: true, ref };
  } catch {
    return { pinned: false, ref: "" };
  }
}

/** The ambient submitter signer (`PRX_PROVENANCE_KEY`), or null when none is set. */
function ambientStatementSigner(): StatementSigner | null {
  const amb = provenanceSigner();
  return amb ? realStatementSigner(amb) : null;
}
