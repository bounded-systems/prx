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
 * Artifacts are persistence-heterogeneous (the registry's `persistence` field:
 * `uow`=git, `plan`/`patch_proposal`=cas, `derive_transition`=dolt). Rather than
 * a store per backend, we follow Nix: there is ONE content-addressed store (CAS),
 * and an IMPURE source (a git-persisted uow, a dolt row) is brought into it by
 * FETCHING and pinning the result by content hash — a fixed-output derivation.
 * See {@link pinSource} / {@link isFresh}. After a pin, an impure artifact is
 * uniform with a cas-native one: same {@link consumeArtifact}, same gc, and the
 * pinned sha is its freshness key.
 *
 * NOTE — this is NOT the `prx handoff` queue (handoff/store.ts). That queue
 * escalates harness-DENIED verbs to a privileged drainer; its envelope requires
 * a `denialReason`, because it is the deny path, not the artifact bus. The
 * artifact bus is the CAS ref below. Whether an edge ALSO pushes an active
 * trigger to wake the next actor is a separate decision tracked on epic prx-997.
 */
import { sha256BareHex } from "@bounded-systems/cas";
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
  /**
   * Documentary: the artifact's natural home (matches the registry's
   * `persistence`). `"cas"` artifacts (plan, …) are emitted directly; `"git"`
   * (uow) / `"dolt"` artifacts are impure sources brought into the CAS via
   * {@link pinSource} (the Nix fixed-output-derivation pattern). Either way the
   * pinned artifact lives in the one store — uniform consume / gc / freshness.
   */
  persistence?: "cas" | "git" | "dolt";
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
 * The canonical on-the-wire form: validated, then JSON. Emit PINS this; the
 * freshness check HASHES this. Sharing one serializer is what makes a pinned
 * sha and a recomputed source sha comparable.
 */
function serialize<T>(edge: ArtifactEdge<T>, value: T): string {
  return JSON.stringify(edge.schema.parse(value));
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
  const ref = artifactRef(unit, edge.kind, edge.slot);
  const { sha } = await putArtifact(ref, serialize(edge, value), domainOpts(edge));
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

// ── fixed-output pin (the Nix FOD bridge for impure sources) ────────────────

/** An impure read of the artifact's home — a git issue/bead, a dolt row, … */
export type Fetcher<T> = (unit: string) => Promise<T> | T;

/**
 * Pin an IMPURE source into the pure CAS store (the Nix fixed-output-derivation
 * pattern). For a `git`/`dolt` artifact (e.g. a uow that lives as a GH issue /
 * bead), `fetch` performs the impure read; the result is validated and pinned by
 * content hash. Afterwards the artifact is indistinguishable from a cas-native
 * one: `consumeArtifact` reads it, gc reclaims it, and the pinned sha is its
 * identity. `fetch` is injected, so an edge over git/dolt is fully testable
 * without touching either.
 */
export async function pinSource<T>(
  edge: ArtifactEdge<T>,
  unit: string,
  fetch: Fetcher<T>,
): Promise<EmitResult> {
  return emitArtifact(edge, unit, await fetch(unit));
}

export interface FreshnessResult {
  /** True iff the live source hashes to exactly what is pinned. */
  fresh: boolean;
  /** The sha pinned at the edge's ref now (`null` if never pinned). */
  pinnedSha: string | null;
  /** The sha the live impure source WOULD pin to. */
  sourceSha: string;
}

/**
 * Freshness check — pure, no write. Hash the live source exactly as
 * {@link pinSource} would and compare to what's pinned. `fresh: false` means the
 * impure source drifted from the pin (the GH issue was edited, the row changed);
 * re-`pinSource` to refresh. This is the freshness axis the user asked for: a
 * content hash makes staleness observable, the same way a Nix FOD hash does.
 */
export async function isFresh<T>(
  edge: ArtifactEdge<T>,
  unit: string,
  fetch: Fetcher<T>,
): Promise<FreshnessResult> {
  const body = serialize(edge, await fetch(unit));
  const sourceSha = `sha256:${sha256BareHex(Buffer.from(body, "utf8"))}`;
  const pinnedSha = await getRef(artifactRef(unit, edge.kind, edge.slot), domainOpts(edge));
  return { fresh: pinnedSha === sourceSha, pinnedSha, sourceSha };
}
