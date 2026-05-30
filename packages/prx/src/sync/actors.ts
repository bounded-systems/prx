// `fromPromise` actors for the per-pair beads↔external-domain sync machine
// (GH-1537). Mirrors src/dep-research/actors.ts: each actor Zod-validates its
// scalar input and delegates to the GH-1536 `DomainAdapter` seam
// (src/adapters/domain-adapter.ts); tests swap actors via
// `domainSyncMachine.provide({ actors })` rather than mocking modules, and the
// `adapter` is injectable so the GitHub adapter is exercised directly without
// module mocks.

import { fromPromise } from "xstate";

import {
  adapterForDomain,
  type DomainAdapter,
} from "../adapters/domain-adapter.ts";
import { issueLabelsFor } from "../triage/bd-axis-labels.ts";
import type { BeadsRecord } from "../triage/triage.ts";
import {
  domainSyncPullInputSchema,
  domainSyncPullResultSchema,
  domainSyncPushInputSchema,
  domainSyncPushResultSchema,
  type DomainSyncPullResult,
  type DomainSyncPushResult,
} from "./schemas.ts";

function requireAdapter(domain: string, injected?: DomainAdapter): DomainAdapter {
  if (injected) return injected;
  const adapter = adapterForDomain(domain);
  if (!adapter) {
    throw new Error(
      `domain-sync: no registered adapter for domain '${domain}' (registered: import src/adapters/* first)`,
    );
  }
  return adapter;
}

// ── pull actor ─────────────────────────────────────────────────────────────

export type PullActorInput = {
  beadId: string;
  domain: string;
  externalId: string;
  beadStatus: string;
  /** DI seam — defaults to `adapterForDomain(domain)`. */
  adapter?: DomainAdapter | undefined;
};

/**
 * Read the external record (`adapter.pull(externalId)`) and decide whether the
 * bead needs closing: external CLOSED + bead not closed ⇒ `needsClose: true`.
 * Does *not* write — the run loop batches closes through `adapter.bulkPull()`
 * (`execBd` blocks `bd close`). Budget-exhaustion errors from the gated `gh`
 * runner propagate typed (the run loop catches them to mark `deferred`).
 */
export const pullActor = fromPromise<DomainSyncPullResult, PullActorInput>(
  async ({ input }) => {
    const data = domainSyncPullInputSchema.parse({
      beadId: input.beadId,
      domain: input.domain,
      externalId: input.externalId,
      beadStatus: input.beadStatus,
    });
    const adapter = requireAdapter(data.domain, input.adapter);
    const patch = await adapter.pull(data.externalId);
    const externalStatus =
      typeof patch.status === "string" && patch.status.length > 0
        ? patch.status
        : "unknown";
    const needsClose = externalStatus === "closed" && data.beadStatus !== "closed";
    return domainSyncPullResultSchema.parse({
      beadId: data.beadId,
      externalId: data.externalId,
      externalStatus,
      beadStatusBefore: data.beadStatus,
      needsClose,
    });
  },
);

// ── push actor ─────────────────────────────────────────────────────────────

export type PushActorInput = {
  bead: BeadsRecord;
  domain: string;
  /**
   * External id the adapter exchanges (e.g. GH issue URL for `gh`, page UUID
   * for `notion`). Threaded from the per-pair machine context, which the run
   * loop computed via `bead.externalRefs[domain] ?? bead.externalRef ?? ""`.
   * Adapters consult `bead.externalRefs[this.config.domain]` internally for
   * the linked-vs-create branch, so this id is the authoritative pin
   * regardless of which domain-specific slot it lives in on the bd record.
   */
  externalId: string;
  dryRun: boolean;
  /** DI seam — defaults to `adapterForDomain(domain)`. */
  adapter?: DomainAdapter | undefined;
};

/**
 * Project the bd-authoritative `title` / `body` / axis labels / assignees onto
 * the external record via `adapter.push` (the linked edit path — every pinned
 * pair has an `externalId` set, so `push` never creates). Idempotent. On
 * `--dry-run` the edit is skipped and the planned external id is returned with
 * `edited: false`.
 *
 * GH-2382: the push leg now mirrors the bd-axis labels (`type::*` /
 * `priority::*`, via `issueLabelsFor`) so a bd priority/type change strips the
 * stale GH rung — the adapter computes the lossless add/remove swap. The
 * returned `edited` is the adapter's *real* touched flag (false when the issue
 * already matched), not a hardcoded `true`. Status is threaded for parity
 * (`beadStatus`) but deliberately NOT projected here: status stays owned by the
 * merge-close / `bulkClose` paths to avoid a pull-vs-push close/reopen conflict
 * with the pull leg's `needsClose` detection (I-DS2). Direction-lock
 * (I-DS-PRIO / I-PROJ1): bd→external only — the adapter's live label read is
 * reconciliation-only and never written back to bd.
 */
export const pushActor = fromPromise<DomainSyncPushResult, PushActorInput>(
  async ({ input }) => {
    const data = domainSyncPushInputSchema.parse({
      beadId: input.bead.id,
      domain: input.domain,
      externalId: input.externalId,
      beadTitle: input.bead.title,
      beadBody: input.bead.description,
      // GH-1874: project bd's `assignee` column onto the external record.
      // bd is singular; the adapter wraps the value into `[assignee]` or `[]`
      // for the push() diff. `null` clears.
      beadAssignee: input.bead.assignee ?? null,
      // GH-2382: the bd-axis label set the adapter swaps onto the issue.
      beadLabels: issueLabelsFor(input.bead),
      beadStatus: input.bead.status,
      dryRun: input.dryRun,
    });
    if (data.dryRun) {
      return domainSyncPushResultSchema.parse({
        beadId: data.beadId,
        externalId: data.externalId,
        edited: false,
      });
    }
    const adapter = requireAdapter(data.domain, input.adapter);
    const result = await adapter.push(input.bead, {
      title: data.beadTitle,
      body: data.beadBody,
      labels: data.beadLabels,
      assignees: data.beadAssignee !== null ? [data.beadAssignee] : [],
    });
    return domainSyncPushResultSchema.parse({
      beadId: data.beadId,
      externalId: result.externalId,
      edited: result.edited,
    });
  },
);
