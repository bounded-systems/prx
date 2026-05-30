// `prx doctor dedupe-bd` (GH-1508) — substrate-tier dedupe for bd records
// pinned to the same external_id. Implements the ADR §6 verb sketch at
// `docs/spikes/GH-1500-authority.md` lines 334-372. Operator-initiated,
// dry-run-by-default, opt-in --apply. Routes the close transition through
// `bd update -s closed --notes "<§6 marker>"` because `bd close` is
// hard-blocked in `src/tools/bd.ts:BLOCKED_SUBCOMMANDS` and the in-tree
// canonical close path is the one already established by GH-1719's
// `prx triage close` (see `src/triage/close.ts:162-170`).
//
// Selection rule (per ADR §6):
//   - auto-synced shape (`<repo>-<13-digit-ms>-<n>-<8-hex>`) > manual id
//   - tie-break: earlier `created_at` wins
// Conflict-abort: if BOTH records in a cluster carry execution state
// (`started_at !== null` || `assignee !== null`), surface as conflict and
// skip the cluster.
//
// Edge re-anchor: every dep edge that pointed at the duplicate (outgoing
// AND incoming) is re-anchored to the canonical BEFORE the duplicate is
// closed, so an interrupted apply leaves edges on a still-open record.
// Both directions are necessary because bd's `dependencies` array only
// surfaces *outgoing* edges on the record carrying the field
// (`FromID === record.id`); incoming edges are discovered by O(N) scan.
//
// Invariants:
//   - I-AUD1 / I-AUD2 — every emitted row carries `uow_id`-equivalent
//     (`beadsId` + `domain` + `externalId`) and routes through the
//     unified audit sink.
//   - I-DEDUPE-1 — after --apply, every mutated cluster shows exactly one
//     open record on the pin and the closed sibling's notes matches the
//     §6 marker (`isCanonicalDupClose` in `src/triage/triage.ts`).
//   - I-DEDUPE-2 — after --apply, every dep edge that previously pointed
//     at the duplicate (either direction) now points at the canonical.
//   - I-DEDUPE-3 (GH-1863) — a cluster is surfaced in `planned` only when
//     at least 2 live members remain after filtering out records closed-
//     as-dup per ADR §6 (`isCanonicalDupClose`). Mirrors the suppression
//     GH-1829 applied to `findDrift` for the same class. Planner output
//     drains monotonically under repeated `--apply` runs.

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import {
  appendAuditRow,
  type AuditSinkDeps,
} from "../audit/sink.ts";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { buildClosedNotePrefixed } from "../triage/close.ts";
import {
  isCanonicalDupClose,
  loadAllBeads as defaultLoadAllBeads,
  type BeadsDependency,
  type BeadsRecord,
} from "../triage/triage.ts";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const dedupeBdOptionsSchema = z.object({
  apply: z.boolean().default(false),
  format: z.enum(["plain", "json"]).default("plain"),
  // GH-2379: scope `--apply` to the named cluster(s). Each value matches a
  // cluster by its pin (`externalId`), canonical bd id, or any duplicate bd
  // id (see the resolution rule in `runDedupeBd`). Empty = apply all clusters
  // (byte-for-byte unchanged behavior). Only meaningful with `--apply`.
  only: z.array(z.string()).default([]),
});
export type DedupeBdOptions = z.infer<typeof dedupeBdOptionsSchema>;

const dedupeBdEdgeSchema = z.object({
  /** Edge direction relative to the duplicate. */
  direction: z.enum(["outgoing", "incoming"]),
  /** bd `dep` type (`blocks`, `parent-child`, …). */
  type: z.string(),
  /** The dep edge as bd stores it: `from` is FromID, `to` is ToID. */
  from: z.string(),
  to: z.string(),
  /** `bd dep remove` argv tail (after subcommand). */
  removeArgv: z.array(z.string()),
  /** `bd dep add` argv tail (after subcommand). */
  addArgv: z.array(z.string()),
});
export type DedupeBdEdge = z.infer<typeof dedupeBdEdgeSchema>;

const dedupeBdClusterSchema = z.object({
  /** External-id pin domain (`gh`, `notion`, …). */
  domain: z.string(),
  /** External id on the pin (URL or id depending on domain). */
  externalId: z.string(),
  /** Selected canonical bd id (null when the cluster aborted as a conflict). */
  canonicalId: z.string().nullable(),
  /** Sibling bd ids that will be closed. Empty when conflicted. */
  duplicateIds: z.array(z.string()),
  /** Status — `plan` = will write under --apply, `conflict` = §6 abort. */
  status: z.enum(["plan", "conflict"]),
  /** Reason when status === `conflict`. */
  conflictReason: z.string().nullable(),
  /** Per-duplicate close note (verbatim — fed to bd update --notes). */
  closeNote: z.string(),
  /** `bd update` argv tail per duplicate (after subcommand). */
  closeArgv: z.array(z.array(z.string())),
  /** Edges to re-anchor (both directions). */
  edges: z.array(dedupeBdEdgeSchema),
});
export type DedupeBdCluster = z.infer<typeof dedupeBdClusterSchema>;

// GH-2254 report-only standing collision detector (mirrors `PinCollision`).
const pinCollisionSchema = z.object({
  /** External-id pin domain (`gh`, `notion`, …). */
  domain: z.string(),
  /** External id on the pin (URL or id depending on domain). */
  externalId: z.string(),
  /** ids of the >1 unresolved beads colliding on this pin (stable order). */
  beadIds: z.array(z.string()),
});

export const dedupeBdRenderSchema = z.object({
  apply: z.boolean(),
  dryRun: z.boolean(),
  clusters: z.array(dedupeBdClusterSchema),
  // GH-2254: pins carrying >1 unresolved bead, reported in dry-run AND --apply.
  // Report-only — surfaced independently of the cluster/apply path and never
  // contributes to `exitCode`.
  collisions: z.array(pinCollisionSchema),
  summary: z.object({
    scanned: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    collisions: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    // GH-2379: plan clusters held back because `--only` did not select them.
    // 0 when `--only` is absent.
    skipped: z.number().int().nonnegative(),
  }),
  exitCode: z.number().int(),
});
export type DedupeBdRender = z.infer<typeof dedupeBdRenderSchema>;

// ─── Types & deps ────────────────────────────────────────────────────────────

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type DedupeBdDeps = {
  execBd?: typeof defaultExecBd;
  loadAllBeads?: (exec: typeof defaultExecBd) => BeadsRecord[];
  now?: () => Date;
  auditSink?: AuditSinkDeps;
};

// ─── Selection helpers ───────────────────────────────────────────────────────

// `<repo-slug>-<13-digit-ms>-<n>-<8-hex>` — the shape `bd github sync` writes
// when the bd record is auto-created from a GH issue. Manual `bd create` emits
// `<repo-slug>-<short-hash>` instead. ADR §6: auto-synced > manual.
const AUTO_SYNCED_ID_RE = /^[a-z][a-z0-9-]+-\d{13}-\d+-[0-9a-f]+$/;

export function isAutoSyncedBdId(id: string): boolean {
  return AUTO_SYNCED_ID_RE.test(id);
}

function hasExecutionState(record: BeadsRecord): boolean {
  if (record.startedAt && record.startedAt.length > 0) return true;
  if (record.assignee && record.assignee.length > 0) return true;
  return false;
}

function pickCanonical(cluster: BeadsRecord[]): BeadsRecord {
  // ADR §6 rule + the tie-break: auto > manual, then earlier `created_at`.
  const ranked = [...cluster].sort((a, b) => {
    const aAuto = isAutoSyncedBdId(a.id);
    const bAuto = isAutoSyncedBdId(b.id);
    if (aAuto !== bAuto) return aAuto ? -1 : 1;
    const aCreated = a.createdAt ?? "";
    const bCreated = b.createdAt ?? "";
    if (aCreated && bCreated && aCreated !== bCreated) {
      return aCreated < bCreated ? -1 : 1;
    }
    // Final deterministic tie-break on id — keeps planner output stable
    // across runs when both records were created in the same second.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked[0]!;
}

// Project every domain pin a record participates in. Includes the legacy
// `external_ref` slot AND every entry in the `externalRefs` map. A record
// can participate in multiple clusters (one per domain) — that's the
// post-GH-1500-amendment multi-domain shape.
function projectPins(record: BeadsRecord): Array<{ domain: string; id: string }> {
  const seen = new Map<string, string>();
  for (const [domain, id] of Object.entries(record.externalRefs)) {
    if (!id || id.trim().length === 0) continue;
    const key = `${domain}::${id}`;
    if (!seen.has(key)) seen.set(key, id);
  }
  // Back-compat: a record with a legacy `external_ref` set but no
  // `externalRefs.gh` (e.g. an older record where the GH adapter rejected
  // the URL) still anchors a pin. Keyed as `gh` because the legacy slot
  // semantically meant "the GH URL" — non-GH external refs flow through
  // metadata.external_refs and are already covered above.
  if (record.externalRef && !seen.has(`gh::${record.externalRef}`)) {
    seen.set(`gh::${record.externalRef}`, record.externalRef);
  }
  return [...seen.entries()].map(([key, id]) => {
    const sep = key.indexOf("::");
    return { domain: key.slice(0, sep), id };
  });
}

// ─── Planner ─────────────────────────────────────────────────────────────────

export function planDedupe(
  beads: readonly BeadsRecord[],
): { clusters: DedupeBdCluster[]; scanned: number } {
  const byPin = new Map<string, BeadsRecord[]>();
  for (const record of beads) {
    // ADR §6 explicitly excludes pin-zero records — bd-only dupes are
    // triage's problem, not doctor's.
    for (const pin of projectPins(record)) {
      const key = `${pin.domain}::${pin.id}`;
      const list = byPin.get(key) ?? [];
      list.push(record);
      byPin.set(key, list);
    }
  }

  const clusters: DedupeBdCluster[] = [];
  for (const [key, members] of byPin) {
    // Multi-membership: a record can appear in multiple pin clusters if it
    // has refs in several domains. Drop duplicates within the cluster.
    const distinct = dedupeById(members);
    // I-DEDUPE-3 (GH-1863): records already closed-as-dup per ADR §6 are
    // resolved — they shouldn't keep the cluster alive in `planned`. Mirrors
    // the same suppression GH-1829 applied to `findDrift`.
    const live = distinct.filter(
      (r) => !(r.status === "closed" && isCanonicalDupClose(r.notes)),
    );
    if (live.length < 2) continue;

    const sep = key.indexOf("::");
    const domain = key.slice(0, sep);
    const externalId = key.slice(sep + 2);

    const cluster = buildCluster(domain, externalId, live);
    clusters.push(cluster);
  }

  // Stable cluster order: alphabetical on (domain, externalId).
  clusters.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
  });

  return { clusters, scanned: byPin.size };
}

// ─── Standing collision detector (GH-2254) ────────────────────────────────────

export type PinCollision = {
  domain: string;
  externalId: string;
  /** ids of the >1 unresolved beads colliding on this pin (stable order). */
  beadIds: string[];
};

/**
 * GH-2254: report-only standing detector. A pin `(domain, externalId)` carrying
 * more than one *unresolved* bead is a collision — the shape that bd's
 * short-id recycling produces (a stale closed record colliding on a live one's
 * pin) and that previously surfaced only as false `prx triage status` drift
 * (which on 2026-05-28 misled triage into closing 5 live issues).
 *
 * "Unresolved" mirrors `planDedupe`'s `live` filter and I-DEDUPE-3: a record
 * already closed-as-dup per ADR §6 (`isCanonicalDupClose`) is resolved and
 * excluded, so once `prx doctor dedupe-bd --apply` quarantines a phantom the
 * collision drains. The detector is pure and never mutates — true upstream
 * prevention of the recycling is GH-1479; this is detection + remediation.
 */
export function findPinCollisions(
  beads: readonly BeadsRecord[],
): PinCollision[] {
  const byPin = new Map<string, BeadsRecord[]>();
  for (const record of beads) {
    if (record.status === "closed" && isCanonicalDupClose(record.notes)) continue;
    for (const pin of projectPins(record)) {
      const key = `${pin.domain}::${pin.id}`;
      const list = byPin.get(key) ?? [];
      list.push(record);
      byPin.set(key, list);
    }
  }

  const out: PinCollision[] = [];
  for (const [key, members] of byPin) {
    const distinct = dedupeById(members);
    if (distinct.length < 2) continue;
    const sep = key.indexOf("::");
    out.push({
      domain: key.slice(0, sep),
      externalId: key.slice(sep + 2),
      beadIds: distinct.map((r) => r.id).sort(),
    });
  }
  // Stable order on (domain, externalId) — matches `planDedupe`'s cluster sort.
  out.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
  });
  return out;
}

function dedupeById(records: BeadsRecord[]): BeadsRecord[] {
  const seen = new Set<string>();
  const out: BeadsRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function buildCluster(
  domain: string,
  externalId: string,
  members: BeadsRecord[],
): DedupeBdCluster {
  const withExecution = members.filter(hasExecutionState);
  if (withExecution.length >= 2) {
    const ids = withExecution.map((m) => m.id).join(", ");
    return {
      domain,
      externalId,
      canonicalId: null,
      duplicateIds: [],
      status: "conflict",
      conflictReason:
        `${withExecution.length} sibling records on (${domain}, ${externalId}) carry execution state (${ids}); reconcile manually per ADR §6`,
      closeNote: "",
      closeArgv: [],
      edges: [],
    };
  }

  const canonical = pickCanonical(members);
  const duplicates = members.filter((m) => m.id !== canonical.id);

  // Build edges per duplicate. Outgoing edges live on the duplicate's own
  // `dependencies[]`; incoming edges are discovered via the full member
  // set we already have in hand (the broader scan is done by the caller —
  // we get all bd records there).
  const edges: DedupeBdEdge[] = [];
  for (const dup of duplicates) {
    for (const edge of dup.dependencies ?? []) {
      edges.push(buildEdge("outgoing", edge, dup.id, canonical.id));
    }
  }

  // Per-duplicate close shape. Closes the loser via `bd update -s closed
  // --notes <§6 marker>` — the only close path admitted by the wrapper
  // (cf. src/triage/close.ts:162-170 and the GH-1719 exception under
  // `feedback_actor_tied_tool_invocations`).
  //
  // GH-2254: a duplicate that is *already closed* before this run is a
  // recycled-short-id phantom (bd reuses short-ids after a record closes, so a
  // stale closed record collides on the live canonical's pin), not a deliberate
  // live dup we are closing now. Both route through the §6 close path — keeping
  // the `duplicate of <canonical> … ADR §6` anchors so `isCanonicalDupClose`
  // matches and the findDrift / I-DEDUPE-3 suppression fires — but the phantom's
  // note names the collision so the quarantine is legible to an operator (and
  // to audit) reading the bd notes later. True upstream prevention of the
  // recycling is GH-1479; this is collision quarantine, not id-stability.
  const standardReason = `duplicate of ${canonical.id} per ADR §6`;
  const recycledReason = `${standardReason} (recycled short-id phantom — GH-2254)`;
  const closeArgv: string[][] = [];
  const closeNotes: string[] = [];
  for (const dup of duplicates) {
    const note = buildClosedNotePrefixed(
      "prx doctor dedupe-bd",
      "duplicate",
      dup.status === "closed" ? recycledReason : standardReason,
    );
    closeNotes.push(note);
    closeArgv.push([dup.id, "-s", "closed", "--notes", note]);
  }
  // Cluster-level representative note (render + back-compat). The exact note
  // written per duplicate lives in `closeArgv`; `applyCluster` audits the note
  // it actually sends.
  const closeNote =
    closeNotes[0]
    ?? buildClosedNotePrefixed("prx doctor dedupe-bd", "duplicate", standardReason);

  return {
    domain,
    externalId,
    canonicalId: canonical.id,
    duplicateIds: duplicates.map((d) => d.id),
    status: "plan",
    conflictReason: null,
    closeNote,
    closeArgv,
    edges,
  };
}

function buildEdge(
  direction: "outgoing" | "incoming",
  edge: BeadsDependency,
  dupId: string,
  canonicalId: string,
): DedupeBdEdge {
  // Outgoing (`dup → X`):
  //   bd dep remove <dup>     <X>
  //   bd dep add    --type T <canonical> <X>
  // Incoming (`Y → dup`):
  //   bd dep remove <Y> <dup>
  //   bd dep add    --type T <Y> <canonical>
  if (direction === "outgoing") {
    return {
      direction,
      type: edge.type,
      from: dupId,
      to: edge.dependsOnId,
      removeArgv: ["remove", dupId, edge.dependsOnId],
      addArgv: ["add", "--type", edge.type, canonicalId, edge.dependsOnId],
    };
  }
  return {
    direction,
    type: edge.type,
    from: edge.issueId,
    to: dupId,
    removeArgv: ["remove", edge.issueId, dupId],
    addArgv: ["add", "--type", edge.type, edge.issueId, canonicalId],
  };
}

// Folds incoming edges into clusters by scanning every record's
// `dependencies[]` once. Runs after `planDedupe` so the duplicate-id set
// is known. `dup → canonical` self-edges produced by an earlier partial
// run are dropped (re-anchoring such an edge would create a self-loop on
// the canonical).
export function annotateIncomingEdges(
  clusters: DedupeBdCluster[],
  beads: readonly BeadsRecord[],
): DedupeBdCluster[] {
  // Map dup-id -> { cluster, canonicalId }
  const dupIndex = new Map<string, { cluster: DedupeBdCluster; canonicalId: string }>();
  for (const cluster of clusters) {
    if (cluster.status !== "plan" || cluster.canonicalId === null) continue;
    for (const dupId of cluster.duplicateIds) {
      dupIndex.set(dupId, { cluster, canonicalId: cluster.canonicalId });
    }
  }
  if (dupIndex.size === 0) return clusters;

  for (const record of beads) {
    for (const edge of record.dependencies ?? []) {
      // Edge is `record.id → edge.dependsOnId`. Incoming-to-dup means
      // `edge.dependsOnId` is a duplicate.
      const entry = dupIndex.get(edge.dependsOnId);
      if (!entry) continue;
      // Skip if the source is itself a duplicate inside this cluster —
      // that edge would re-anchor to a canonical-to-canonical self-loop.
      if (record.id === entry.canonicalId) continue;
      if (entry.cluster.duplicateIds.includes(record.id)) continue;
      // Skip outgoing edges we already captured (where `record.id` was
      // the duplicate). Those are the same physical edge surfaced from
      // both ends — bd's dep table emits them only once on the FromID
      // record, but defensive-skip here keeps us idempotent if a future
      // bd surfaces both projections.
      const alreadyOutgoing = entry.cluster.edges.some(
        (e) =>
          e.direction === "outgoing"
          && e.from === record.id
          && e.to === edge.dependsOnId,
      );
      if (alreadyOutgoing) continue;
      entry.cluster.edges.push(buildEdge("incoming", edge, edge.dependsOnId, entry.canonicalId));
    }
  }
  return clusters;
}

// ─── Apply ───────────────────────────────────────────────────────────────────

type ApplyResult = {
  applied: number;
  errors: number;
};

function applyCluster(
  cluster: DedupeBdCluster,
  opts: DedupeBdOptions,
  output: Output,
  deps: DedupeBdDeps,
  audit: (entry: unknown) => void,
  now: Date,
): ApplyResult {
  const exec = deps.execBd ?? defaultExecBd;
  let applied = 0;
  let errors = 0;

  // Edges first — interrupted apply leaves edges anchored to a still-open
  // dup, not orphaned on a closed record.
  for (const edge of cluster.edges) {
    if (!opts.apply) {
      audit({
        ts: now.toISOString(),
        domain: cluster.domain,
        externalId: cluster.externalId,
        canonicalId: cluster.canonicalId,
        beadsId: edge.direction === "outgoing" ? edge.from : edge.to,
        action: "dep-rm",
        edgeType: edge.type,
        edgeFrom: edge.from,
        edgeTo: edge.to,
        actor: "claude-code",
        dryRun: true,
        exitCode: 0,
      });
      audit({
        ts: now.toISOString(),
        domain: cluster.domain,
        externalId: cluster.externalId,
        canonicalId: cluster.canonicalId,
        beadsId: cluster.canonicalId ?? edge.to,
        action: "dep-add",
        edgeType: edge.type,
        edgeFrom: edge.direction === "outgoing" ? cluster.canonicalId ?? "" : edge.from,
        edgeTo: edge.direction === "outgoing" ? edge.to : cluster.canonicalId ?? "",
        actor: "claude-code",
        dryRun: true,
        exitCode: 0,
      });
      continue;
    }

    const rmResult = exec(
      {
        subcommand: "dep",
        args: edge.removeArgv,
        state: "planning",
        role: "planner",
      },
      processEnv(),
    );
    audit({
      ts: now.toISOString(),
      domain: cluster.domain,
      externalId: cluster.externalId,
      canonicalId: cluster.canonicalId,
      beadsId: edge.direction === "outgoing" ? edge.from : edge.to,
      action: "dep-rm",
      edgeType: edge.type,
      edgeFrom: edge.from,
      edgeTo: edge.to,
      actor: "claude-code",
      dryRun: false,
      exitCode: rmResult.exitCode,
      ...(rmResult.stderr.trim().length > 0 ? { stderr: rmResult.stderr.trim() } : {}),
    });
    if (rmResult.exitCode !== 0) {
      output.error(
        `prx doctor dedupe-bd: bd dep remove failed on (${edge.from} → ${edge.to}): ${rmResult.stderr.trim() || rmResult.stdout.trim()}`,
      );
      errors += 1;
      continue;
    }

    const addResult = exec(
      {
        subcommand: "dep",
        args: edge.addArgv,
        state: "planning",
        role: "planner",
      },
      processEnv(),
    );
    audit({
      ts: now.toISOString(),
      domain: cluster.domain,
      externalId: cluster.externalId,
      canonicalId: cluster.canonicalId,
      beadsId: cluster.canonicalId ?? "",
      action: "dep-add",
      edgeType: edge.type,
      edgeFrom: edge.direction === "outgoing" ? cluster.canonicalId ?? "" : edge.from,
      edgeTo: edge.direction === "outgoing" ? edge.to : cluster.canonicalId ?? "",
      actor: "claude-code",
      dryRun: false,
      exitCode: addResult.exitCode,
      ...(addResult.stderr.trim().length > 0 ? { stderr: addResult.stderr.trim() } : {}),
    });
    if (addResult.exitCode !== 0) {
      output.error(
        `prx doctor dedupe-bd: bd dep add failed on (${edge.from} → ${edge.to}): ${addResult.stderr.trim() || addResult.stdout.trim()}`,
      );
      errors += 1;
      continue;
    }
    applied += 1;
  }

  // Close duplicates after edges are re-anchored.
  for (let i = 0; i < cluster.duplicateIds.length; i += 1) {
    const dupId = cluster.duplicateIds[i]!;
    const argv = cluster.closeArgv[i];
    if (!argv) continue;
    // Audit the exact note we send — per-duplicate it may name the recycled-
    // short-id phantom case (GH-2254), which differs from `cluster.closeNote`.
    const notesIdx = argv.indexOf("--notes");
    const note =
      notesIdx >= 0 && argv[notesIdx + 1] !== undefined
        ? argv[notesIdx + 1]!
        : cluster.closeNote;
    if (!opts.apply) {
      audit({
        ts: now.toISOString(),
        domain: cluster.domain,
        externalId: cluster.externalId,
        canonicalId: cluster.canonicalId,
        beadsId: dupId,
        action: "close",
        note,
        actor: "claude-code",
        dryRun: true,
        exitCode: 0,
      });
      continue;
    }
    const result = exec(
      {
        subcommand: "update",
        args: argv,
        state: "planning",
        role: "planner",
      },
      processEnv(),
    );
    audit({
      ts: now.toISOString(),
      domain: cluster.domain,
      externalId: cluster.externalId,
      canonicalId: cluster.canonicalId,
      beadsId: dupId,
      action: "close",
      note,
      actor: "claude-code",
      dryRun: false,
      exitCode: result.exitCode,
      ...(result.stderr.trim().length > 0 ? { stderr: result.stderr.trim() } : {}),
    });
    if (result.exitCode !== 0) {
      output.error(
        `prx doctor dedupe-bd: bd update -s closed failed on ${dupId}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
      errors += 1;
      continue;
    }
    applied += 1;
  }

  return { applied, errors };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function runDedupeBd(
  opts: DedupeBdOptions,
  output: Output,
  deps: DedupeBdDeps = {},
): number {
  const exec = deps.execBd ?? defaultExecBd;
  const loadBeads = deps.loadAllBeads ?? defaultLoadAllBeads;
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const audit = (entry: unknown): void => {
    try {
      appendAuditRow(entry, auditSink);
    } catch (err) {
      // Sink-side errors are not fatal — we still emit the operator-
      // visible render. A schema mismatch on the audit row is a bug,
      // surface it on stderr.
      output.error(`prx doctor dedupe-bd: audit-sink write failed: ${(err as Error).message}`);
    }
  };

  let beads: BeadsRecord[];
  try {
    beads = loadBeads(exec);
  } catch (err) {
    output.error(`prx doctor dedupe-bd: ${(err as Error).message}`);
    return 1;
  }

  // GH-2379: `--only` is only meaningful at apply time — dry-run always shows
  // ALL clusters. Reject the combination fail-fast (belt-and-suspenders; the
  // CLI rejects this first, but the verb is also called directly in tests).
  if (opts.only.length > 0 && !opts.apply) {
    output.error("prx doctor dedupe-bd: --only requires --apply");
    return 1;
  }

  const { clusters: rawClusters } = planDedupe(beads);
  const clusters = annotateIncomingEdges(rawClusters, beads);

  // GH-2254 report-only: surface every pin carrying >1 unresolved bead. Pure,
  // independent of the cluster/apply path — reported in dry-run AND --apply,
  // and never contributes to `exitCode` (it is detection, not a verb).
  const collisions = findPinCollisions(beads);

  // GH-2379: resolve the `--only` selector(s) against ALL clusters (plan +
  // conflict). A value matches a cluster when it equals the pin
  // (`externalId`), the canonical bd id, or any duplicate bd id. Multiple
  // `--only` flags apply the union. A selector that resolves to no cluster is
  // surfaced and forces exit≠0 so a typo never silently applies nothing.
  const scoped = opts.only.length > 0;
  const selected = new Set<string>();
  let selectorErrors = 0;
  if (scoped) {
    for (const value of opts.only) {
      const matches = clusters.filter(
        (c) =>
          c.externalId === value
          || c.canonicalId === value
          || c.duplicateIds.includes(value),
      );
      if (matches.length === 0) {
        output.error(`prx doctor dedupe-bd: --only ${value} matched no cluster`);
        selectorErrors += 1;
        continue;
      }
      for (const c of matches) selected.add(c.externalId);
    }
  }
  const isSelected = (cluster: DedupeBdCluster): boolean =>
    !scoped || selected.has(cluster.externalId);

  // Emit conflict rows up front so dry-run already shows them. Under `--only`,
  // only the selected conflicts are accounted for (an unselected hazard must
  // not block a scoped apply).
  for (const cluster of clusters) {
    if (cluster.status !== "conflict") continue;
    if (!isSelected(cluster)) continue;
    audit({
      ts: now.toISOString(),
      domain: cluster.domain,
      externalId: cluster.externalId,
      canonicalId: null,
      beadsId: "(conflict)",
      action: "conflict",
      conflictReason: cluster.conflictReason ?? undefined,
      actor: "claude-code",
      dryRun: !opts.apply,
      exitCode: 0,
    });
  }

  let applied = 0;
  let errors = selectorErrors;
  let skipped = 0;
  for (const cluster of clusters) {
    if (cluster.status !== "plan") continue;
    if (!isSelected(cluster)) {
      skipped += 1;
      continue;
    }
    const result = applyCluster(cluster, opts, output, deps, audit, now);
    applied += result.applied;
    errors += result.errors;
  }

  // `planned` always reflects ALL plan clusters (the plan set is never
  // narrowed). `conflicts` is scoped to the selected set when `--only` is
  // active so an unselected conflict does not drive exit≠0.
  const planned = clusters.filter((c) => c.status === "plan").length;
  const conflicts = clusters.filter(
    (c) => c.status === "conflict" && isSelected(c),
  ).length;
  // Collisions are report-only and deliberately excluded from this rule —
  // a stale recycled-short-id phantom is detection signal, not an error.
  const exitCode = errors > 0 || conflicts > 0 ? 1 : 0;

  const render: DedupeBdRender = {
    apply: opts.apply,
    dryRun: !opts.apply,
    clusters,
    collisions,
    summary: {
      scanned: clusters.length,
      planned,
      applied,
      conflicts,
      collisions: collisions.length,
      errors,
      skipped,
    },
    exitCode,
  };

  output.log(formatRender(render, opts.format));
  return exitCode;
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function formatRender(
  render: DedupeBdRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const lines: string[] = [];
  const mode = render.apply ? "apply" : "dry-run";
  const skippedSuffix =
    render.summary.skipped > 0 ? `, ${render.summary.skipped} cluster(s) skipped` : "";
  lines.push(
    `prx doctor dedupe-bd — ${mode}: ${render.summary.planned} cluster(s) planned, ${render.summary.conflicts} conflict(s), ${render.summary.applied} action(s) applied, ${render.summary.collisions} pin collision(s), ${render.summary.errors} error(s)${skippedSuffix}`,
  );
  if (render.clusters.length === 0) {
    lines.push("  (no duplicate clusters detected)");
  } else {
    for (const cluster of render.clusters) {
      if (cluster.status === "conflict") {
        lines.push(`  CONFLICT (${cluster.domain}, ${cluster.externalId}): ${cluster.conflictReason ?? ""}`);
        continue;
      }
      lines.push(
        `  ${cluster.domain}=${cluster.externalId}: canonical=${cluster.canonicalId}, dup=[${cluster.duplicateIds.join(", ")}], edges=${cluster.edges.length}`,
      );
    }
  }
  // GH-2254: report-only collision section. Standing detector for any pin with
  // >1 unresolved bead (recycled-short-id phantoms). Does not affect exitCode.
  if (render.collisions.length > 0) {
    lines.push(`  pin collisions (report-only — GH-2254): ${render.collisions.length}`);
    for (const collision of render.collisions) {
      lines.push(
        `    COLLISION (${collision.domain}, ${collision.externalId}): ${collision.beadIds.length} unresolved [${collision.beadIds.join(", ")}]`,
      );
    }
  }
  return lines.join("\n");
}
