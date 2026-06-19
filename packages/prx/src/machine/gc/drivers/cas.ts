/**
 * gc `cas` driver (GH-2312 plans / GH-2317 submit) — reclaims unreferenced
 * plan-store CAS blobs across every content domain. The gc driver that DELETES
 * content, so reachability rooting is the load-bearing invariant.
 *
 * Per domain, every live ref's blob is rooted, plus the CHILD blobs it
 * references (a one-level reachability — plan/submit bodies reference no further
 * blobs):
 *   - plans (GH-2028 two-hop): a ref points at an envelope; the envelope points
 *     at a body. Root the envelope AND `parseEnvelope(env).body_sha`. A legacy
 *     bare-sha ref (`parseEnvelope` → null) is its own body (no child).
 *   - submit (GH-2317): a ref points at a `SubmitArtifact` metadata blob that
 *     references `patch.sha`. Root the metadata AND `patch.sha`.
 * Only the ref blob is read (never the child) so a missing child never crashes
 * mark; a parse miss / read error roots just the ref blob (fail-safe — never
 * widen the orphan set). An mtime grace window guards in-flight writes (a save
 * writes blobs before the ref lands). Findings are domain-qualified CAS URIs
 * (`<domain>://<sha>`) so sweep deletes from the right domain and shas can't
 * collide across domains.
 *
 * Deps (CasGcOps) are injected; without them the driver no-ops (keeps the actor
 * `run --all`/capability tests hermetic). Reuses `parseEnvelope` + the
 * `SubmitArtifactSchema` (pure leaves; must NOT import verbs.ts → pr-state ESM
 * cycle).
 */

import type { CasSha } from "../../../plan-store/cas.ts";
import { parseEnvelope } from "../../../plan-store/envelope.ts";
import { casUriFor, parseCasUri } from "../../../plan-store/uri.ts";
import { SUBMIT_DOMAIN, SubmitArtifactSchema } from "../../../submit/artifact.schema.ts";
import { sweepableFromMark, type GcDriver, type GcMark } from "../capability.ts";
import type { GcFinding } from "../schema.ts";
import type { CasGcOps, GcDriverDeps } from "./registry.ts";

const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1h in-flight-write guard

/** Child blob shas a ref's blob references (beyond the ref blob, always rooted).
 * `[]` on a parse miss — fail-safe (never widen the orphan set). */
type ChildRooter = (blob: Buffer) => CasSha[];

const plansRooter: ChildRooter = (blob) => {
  const env = parseEnvelope(blob);
  return env !== null ? [env.body_sha] : []; // envelope→body; legacy bare-sha → no child
};

const submitRooter: ChildRooter = (blob) => {
  let json: unknown;
  try {
    json = JSON.parse(blob.toString("utf8"));
  } catch {
    return [];
  }
  const parsed = SubmitArtifactSchema.safeParse(json);
  return parsed.success ? [parsed.data.patch.sha] : []; // metadata→patch blob
};

/** The plan-store CAS domains the cas driver collects, each with its rooter. */
const DOMAINS: ReadonlyArray<{ domain: string; root: ChildRooter }> = [
  { domain: "plans", root: plansRooter },
  { domain: SUBMIT_DOMAIN, root: submitRooter },
];

async function deriveOrphans(cas: CasGcOps): Promise<GcFinding[]> {
  const graceMs = cas.graceMs ?? DEFAULT_GRACE_MS;
  const findings: GcFinding[] = [];
  for (const { domain, root } of DOMAINS) {
    const opts = { domain };
    const reachable = new Set<CasSha>();
    for (const ref of await cas.listRefs(undefined, opts)) {
      reachable.add(ref.sha);
      try {
        for (const child of root(await cas.readBlob(ref.sha, opts))) reachable.add(child);
      } catch {
        // ref blob unreadable/corrupt — keep ref.sha rooted, skip children.
      }
    }
    const cutoff = Date.now() - graceMs;
    for (const b of await cas.listBlobs(opts)) {
      if (!reachable.has(b.sha) && b.mtimeMs < cutoff) {
        findings.push({
          component: "cas",
          class: "orphan",
          ref: casUriFor(domain, b.sha), // domain-qualified — sweep parses it back
          reclaim_bytes: b.bytes,
        });
      }
    }
  }
  return findings;
}

export function createCasDriver(deps: GcDriverDeps): GcDriver {
  return {
    component: "cas",

    async mark(): Promise<GcFinding[]> {
      if (!deps.cas) return []; // no-op without injected CAS ops
      return deriveOrphans(deps.cas);
    },

    async sweep(mark: GcMark, _ctx): Promise<{ reclaimed: GcFinding[]; failed?: string }> {
      if (!deps.cas) return { reclaimed: [] };
      // Phase-2 freshness: re-derive orphans now, then keep only what was marked
      // — a blob that became reachable (newly ref'd) since mark is dropped.
      const live = await deriveOrphans(deps.cas);
      const sweepable = sweepableFromMark(mark, live);
      if (sweepable.length === 0) return { reclaimed: [] };
      const reclaimed: GcFinding[] = [];
      const failures: string[] = [];
      for (const f of sweepable) {
        try {
          const { domain, sha } = parseCasUri(f.ref);
          await deps.cas.deleteBlob(sha, { domain });
          reclaimed.push(f);
        } catch (err) {
          failures.push(`${f.ref}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return failures.length > 0 ? { reclaimed, failed: failures.join("; ") } : { reclaimed };
    },
  };
}
