/**
 * The input a session leg must CONSUME before it can spawn (GH-288/GH-325). The
 * proven bug: the pilot builds leg profiles via `openSession` and never handed a
 * leg its input — the planner ran blind on the source (GH-288), and the executor
 * ran blind on the plan (GH-325). This is the single seam that maps a session
 * actor to its required upstream input, reads it, and returns the embeddable body
 * the profile builder needs.
 *
 * Inputs are heterogeneous: the planner consumes the signed `<unit>:source@pinned`
 * artifact (an `ArtifactEdge`); the executor consumes `<unit>:plan@draft` (a
 * plan-store slot). Each actor gets its own resolver.
 *
 * "No input → no spawn": a `missing` result is the caller's hard-fail signal
 * (`openSession` refuses to build a profile). The CRYPTOGRAPHIC gate — minting a
 * signed SLSA spawn over the input material — is layered on at the launch
 * boundary (GH-293); the `sha` returned here is that material.
 */

import type { SessionActor } from "./schema.ts";
import { type ArtifactEdge, consumeArtifact } from "../pipeline/edge.ts";
import { type ResolvedSource, workUnitSourceEdge } from "../pipeline/source-pin.ts";
import { artifactRef } from "../plan-store/artifact-store.ts";
import { getRef } from "../plan-store/cas.ts";
import { runPlanLoad } from "../plan-store/verbs.ts";

/**
 * The resolved leg input: the embeddable body + the content digest (`sha`, the
 * spawn attestation's material — GH-293) + provenance, or a miss.
 */
export type LegInput =
  | { missing: false; ref: string; sha: string; body: string; signedBy: string }
  | { missing: true; ref: string };

/** A per-actor input resolver: read the actor's upstream input for `unit`. */
export type LegInputResolver = (unit: string) => Promise<LegInput>;

/** The embeddable issue text for a pinned source — title + body, or just title. */
function sourceBody(value: ResolvedSource): string {
  return value.body && value.body.trim().length > 0
    ? `${value.title}\n\n${value.body}`
    : value.title;
}

/**
 * The signed `<unit>:source@pinned` artifact — the planner's input (GH-288/292).
 * Requires the pin to be SIGNED (attestation present); an unsigned/absent pin is
 * `missing`. (Cryptographic signature verification lands at the spawn gate.)
 */
async function resolveSourceInput(unit: string): Promise<LegInput> {
  const ref = artifactRef(unit, workUnitSourceEdge.kind, workUnitSourceEdge.slot);
  let got;
  try {
    got = await consumeArtifact(workUnitSourceEdge, unit);
  } catch {
    return { missing: true, ref };
  }
  if (got.missing || !got.value || !got.value.attestation) return { missing: true, ref };
  const sha = await getRef(ref);
  if (!sha) return { missing: true, ref };
  return {
    missing: false,
    ref: got.ref,
    sha,
    body: sourceBody(got.value),
    signedBy: got.value.attestation.submittedBy,
  };
}

/**
 * The `<unit>:plan@draft` plan-store slot — the executor's (and tester's) input
 * (GH-325). The planner persists it after a successful leg; an absent/empty slot
 * is `missing`, so a headless executor fails closed rather than running blind.
 */
async function resolvePlanInput(unit: string): Promise<LegInput> {
  const ref = `${unit}:plan@draft`;
  let loaded;
  try {
    loaded = await runPlanLoad({ unit, slot: "draft" });
  } catch {
    return { missing: true, ref };
  }
  const body =
    typeof loaded.content === "string" ? loaded.content : loaded.content.toString("utf8");
  if (!body || body.trim().length === 0) return { missing: true, ref };
  return { missing: false, ref, sha: loaded.sha, body, signedBy: "planner" };
}

/**
 * The resolver for an actor's input, or `null` when the actor has no upstream CAS
 * input: `intake`/`triage` are chain roots, and `submit`/`author` consume the
 * executor's output (wired once the executor path lands — see GH-325 follow-ups).
 */
export function legInputResolver(actor: SessionActor): LegInputResolver | null {
  switch (actor) {
    case "plan":
      return resolveSourceInput;
    // executor AND tester both open the `implement` session; both get the plan.
    case "implement":
      return resolvePlanInput;
    default:
      return null;
  }
}

/**
 * The source `ArtifactEdge` for the planner, or `null` for actors whose input is
 * not an edge (plan-store slots, or chain roots). Kept for callers that need the
 * edge specifically; input RESOLUTION goes through {@link legInputResolver}.
 */
export function legInputEdge(actor: SessionActor): ArtifactEdge<ResolvedSource> | null {
  return actor === "plan" ? workUnitSourceEdge : null;
}

/**
 * Resolve and embed the actor's required input for `unit`. Returns:
 *   - `null`              — the actor has no upstream input (root / not-yet-wired).
 *   - `{ missing: true }` — required but absent/unreadable ⇒ caller fails closed.
 *   - `{ missing: false }`— the embeddable `body`, content `sha`, and producer id.
 */
export async function resolveLegInput(actor: SessionActor, unit: string): Promise<LegInput | null> {
  const resolver = legInputResolver(actor);
  if (!resolver) return null;
  return resolver(unit);
}
