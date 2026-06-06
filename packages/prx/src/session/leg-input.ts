/**
 * The signed input artifact a session leg must CONSUME before it can spawn
 * (GH-288). The proven bug: the pilot builds leg profiles via `openSession` and
 * never consumed `<unit>:source@pinned`, so the planner ran blind and the
 * no-fabricate guard made it refuse — by construction. This is the single seam
 * that maps a session actor to its required upstream artifact, reads it, and
 * returns the embeddable body the profile builder needs.
 *
 * "No artifact → no spawn" at the embed layer: a `missing` result is the caller's
 * hard-fail signal (openSession refuses to build a profile). The CRYPTOGRAPHIC
 * gate — verifying the upstream signature and minting a signed SLSA spawn
 * attestation — is layered on at the launch boundary (GH-293); this module
 * already requires the artifact to be SIGNED (attestation present) so an unsigned
 * pin is treated as missing.
 */

import type { SessionActor } from "./schema.ts";
import { type ArtifactEdge, consumeArtifact } from "../pipeline/edge.ts";
import { type ResolvedSource, workUnitSourceEdge } from "../pipeline/source-pin.ts";

/** The resolved leg input: the embeddable body + provenance, or a miss. */
export type LegInput =
  | { missing: false; ref: string; body: string; signedBy: string }
  | { missing: true; ref: string };

/**
 * The upstream artifact edge a session actor must consume, or `null` when the
 * actor is a chain ROOT with no CAS input (intake — its material is the
 * externally-submitted text it signs, GH-292). Executor/tester/author edges are
 * wired through the unified spawn gate in GH-293.
 */
export function legInputEdge(actor: SessionActor): ArtifactEdge<ResolvedSource> | null {
  switch (actor) {
    case "plan":
      return workUnitSourceEdge;
    default:
      return null;
  }
}

/** The embeddable issue text for a pinned source — title + body, or just title. */
function sourceBody(value: ResolvedSource): string {
  return value.body && value.body.trim().length > 0
    ? `${value.title}\n\n${value.body}`
    : value.title;
}

/**
 * Resolve and embed the actor's required input artifact for `unit`. Returns:
 *   - `null`             — the actor is exempt (chain root); no input to require.
 *   - `{ missing: true }`— required but absent / unsigned / unreadable ⇒ the
 *                          caller MUST fail closed (no spawn).
 *   - `{ missing:false }`— the embeddable `body` + the signer identity.
 */
export async function resolveLegInput(
  actor: SessionActor,
  unit: string,
): Promise<LegInput | null> {
  const edge = legInputEdge(actor);
  if (!edge) return null;

  const ref = `${unit}:${edge.kind}@${edge.slot}`;
  let got;
  try {
    got = await consumeArtifact(edge, unit);
  } catch {
    // Unreadable / schema-invalid (e.g. a stale pre-signing pin) ⇒ missing.
    return { missing: true, ref };
  }
  if (got.missing || !got.value) return { missing: true, ref };

  // GH-292: the source must be SIGNED — an unsigned pin is not a valid input.
  // (Cryptographic verification of the signature lands at the spawn gate, GH-293.)
  const attestation = got.value.attestation;
  if (!attestation) return { missing: true, ref };

  return {
    missing: false,
    ref: got.ref,
    body: sourceBody(got.value),
    signedBy: attestation.submittedBy,
  };
}
