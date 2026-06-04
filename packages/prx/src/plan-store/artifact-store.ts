// GH-2349 (spike GH-2348 .1): the genuinely-shared kernel for CAS artifacts.
//
// `plan@`, `submit@` (and the future `implement@`, GH-2346) are all
// `<unit>:<kind>@<slot>` refs whose target is a serialized metadata blob in a
// CAS domain. Two things are common to every artifact producer:
//
//   1. the ref addressing convention `<unit>:<kind>@<slot>`, and
//   2. the final `writeBlob(metadata) → setRef(ref, sha)` pairing.
//
// Those live here. The per-kind metadata *schemas* (PlanEnvelope vs
// SubmitArtifact) and *read paths* (plan's lazy legacy-ref migration vs
// submit's straight read) deliberately stay with each producer — sharing them
// would be a leaky abstraction. `prx plan save` and `prx submit stage` are the
// two consumers today; `implement@` is the third the spike adds.

import { type CasSha, type DomainOptions, setRef, writeBlob } from "./cas.ts";

/** Artifact families addressable in the CAS as `<unit>:<kind>@<slot>`. */
export type ArtifactKind = "plan" | "submit" | "agent_result" | "implement";

/** Canonical ref for an artifact slot: `<unit>:<kind>@<slot>`. */
export function artifactRef(
  unit: string,
  kind: ArtifactKind,
  slot: string,
): string {
  return `${unit}:${kind}@${slot}`;
}

export interface PutArtifactResult {
  ref: string;
  sha: CasSha;
}

/**
 * Write a serialized metadata blob into the artifact's domain and advance its
 * slot ref to that blob — the shared final step of every artifact producer.
 * Content blobs (plan body, submit patch) are written separately by the
 * producer beforehand; this writes the metadata that references them and
 * publishes the slot. Domain defaults to the plans domain (see DomainOptions).
 */
export async function putArtifact(
  ref: string,
  body: string | Buffer,
  opts?: DomainOptions,
): Promise<PutArtifactResult> {
  const { sha } = await writeBlob(body, opts);
  await setRef(ref, sha, opts);
  return { ref, sha };
}
