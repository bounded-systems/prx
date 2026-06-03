/**
 * Pipeline artifact edge (prx-d2d, epic prx-997).
 *
 * Each actor in the lifecycle (intake→triage→plan→implement→submit→author) is a
 * transform: it EMITS an artifact that the next actor CONSUMES. The proven
 * cross-actor pass is the CAS ref convention `<unit>:<kind>@<slot>` — the same
 * mechanism `prx plan save` / `prx implement` already use (plan-store/verbs.ts).
 * This generalizes that into one typed emit/consume pair every edge reuses, so
 * the artifact SCHEMA is the contract (prx-9kd) and the boundary (prx-p1i): emit
 * validates on the way out, consume re-validates on the way in.
 *
 * NOTE — this is NOT the `prx handoff` queue (handoff/store.ts). That queue
 * escalates harness-DENIED verbs to a privileged drainer; its envelope requires
 * a `denialReason`, because it is the deny path, not the artifact bus. The
 * artifact bus is the CAS ref below. Whether an edge ALSO pushes an active
 * trigger to wake the next actor is a separate decision tracked on epic prx-997.
 */
import type { z } from "zod";

import {
  type ArtifactKind,
  artifactRef,
  putArtifact,
} from "../plan-store/artifact-store.ts";
import { type DomainOptions, getRef, readBlob } from "../plan-store/cas.ts";

/** A typed pipeline edge: `source` emits `kind@slot`; `target` consumes it. */
export interface ArtifactEdge<T> {
  /** CAS artifact family — the `<kind>` in `<unit>:<kind>@<slot>`. */
  kind: ArtifactKind;
  /** Slot within the kind (e.g. "filed", "ready", "draft"). */
  slot: string;
  /** Sole producing actor (documents ownership; the edge has one writer). */
  source: string;
  /** Sole consuming actor (the edge has one reader). */
  target: string;
  /** The artifact contract — validated on emit AND on consume. */
  schema: z.ZodType<T>;
  /** Optional CAS domain override (defaults to the plans domain). */
  domain?: string;
}

/** Identity helper for declaring an edge — keeps call sites tidy and inferred. */
export function defineEdge<T>(spec: ArtifactEdge<T>): ArtifactEdge<T> {
  return spec;
}

export interface EmitResult {
  /** The `<unit>:<kind>@<slot>` ref the artifact now lives at. */
  ref: string;
  /** Content address of the written artifact blob. */
  sha: string;
}

function domainOpts<T>(edge: ArtifactEdge<T>): DomainOptions | undefined {
  return edge.domain !== undefined ? { domain: edge.domain } : undefined;
}

/**
 * Emit `value` as the edge's artifact: validate it against the edge schema,
 * write it to the CAS, and advance the `<unit>:<kind>@<slot>` ref to it. The
 * returned `ref` is what the consuming actor reads.
 */
export async function emitArtifact<T>(
  edge: ArtifactEdge<T>,
  unit: string,
  value: T,
): Promise<EmitResult> {
  const validated = edge.schema.parse(value);
  const ref = artifactRef(unit, edge.kind, edge.slot);
  const { sha } = await putArtifact(
    ref,
    JSON.stringify(validated),
    domainOpts(edge),
  );
  return { ref, sha };
}

export type ConsumeResult<T> =
  | { ref: string; value: T; missing?: undefined }
  | { ref: string; value: null; missing: true };

/**
 * Consume the edge's artifact for `unit`: resolve the ref, read the blob, and
 * re-validate against the edge schema. Returns `{ missing: true }` when the
 * producer has not emitted yet — the consuming actor decides whether to wait or
 * no-op, rather than crashing on an absent upstream.
 */
export async function consumeArtifact<T>(
  edge: ArtifactEdge<T>,
  unit: string,
): Promise<ConsumeResult<T>> {
  const ref = artifactRef(unit, edge.kind, edge.slot);
  const opts = domainOpts(edge);
  const sha = await getRef(ref, opts);
  if (!sha) return { ref, value: null, missing: true };
  const buf = await readBlob(sha, opts);
  const value = edge.schema.parse(JSON.parse(buf.toString("utf8")));
  return { ref, value };
}
