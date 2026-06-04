import { z } from "zod";

import { branchNameSchema, shaSchema, workUnitIdSchema } from "./brands.ts";

export const workflowPhases = [
  "cleaned",
  "merged",
  "closed",
  "no_worktree",
  "worktree_created",
  "branch_created",
  "committing",
  "pushed",
  "draft",
  "changes_requested",
  "waiting_on_ci",
  "blocked",
  "ready_to_merge",
  "automerge_enabled",
  "ready_for_review",
  "in_review",
] as const;

export type WorkflowPhase = (typeof workflowPhases)[number];

export const phasePrecedence: readonly WorkflowPhase[] = [
  "cleaned",
  "merged",
  "closed",
  "no_worktree",
  "worktree_created",
  "branch_created",
  "committing",
  "pushed",
  "draft",
  "changes_requested",
  "waiting_on_ci",
  "blocked",
  "ready_to_merge",
  "automerge_enabled",
  "ready_for_review",
  "in_review",
] as const;

export const invariantSpecs = [
  "I01: pr.exists => (branch.existsLocal || branch.existsRemote)",
  "I02: pr.exists => pr.headRef == branch.name",
  "I03: worktree.exists => (branch.existsLocal && worktree.checkedOutBranch == branch.name)",
  "I04: phase=ready_to_merge => approved && ci passed && mergeable && remoteFresh && unresolvedThreads==0 && !draft",
  "I05: phase=cleaned => !worktree.exists && !branch.existsLocal",
  "I06: ci.requiredPassed <= ci.requiredTotal",
  "I07: ci.state=passed => ci.requiredPassed == ci.requiredTotal",
  "I08: sync.remoteFresh => branch.headShaLocal == branch.headShaRemote",
  "I09: phase=automerge_enabled => I04 conditions hold && pr.autoMergeRequest != null",
  "I-DR1: phase=classifying && delta.classification == 'none' => next state is no_delta (filing path unreachable)",
  "I-DR2: delta.prev_run_id ∈ { real run_id of a prior DepSnapshot for this dep, null } (no synthetic prev)",
  "I-DR3: dep-research snapshot writes are atomic (tmp-dir + rename); no partial <runId>/ ever appears on disk",
  "I-DR4: dep-research --dry-run leaves no on-disk artifacts outside tmp",
  "I-DS1: beads-sync --dry-run leaves no bd/gh writes (no `gh issue edit`, no `bd github sync`)",
  "I-DS2: a pinned pair whose external record resolves CLOSED => the bd record's status is closed after the tick (closes the pull leg's stale-bead class)",
  "I-DS-PRIO: no GH→bd reconcile path writes bd.priority — priority is bd-authoritative, projected bd→external only (authority ADR §2). The only bd write on any pull leg is status-close via execBdIssueClose; every triage write verb chains the status-only runBeadsSync, never the destructive `bd github sync --pull-only --prefer-github` (GH-2011 + GH-2316)",
  // GH-1469: `prx sync backfill` — range-backfill of cursor-skipped external
  // records (GH-1500 authority ADR §5). I-BF1 locks resolution to the
  // (domain, external_id) map (never short-id prefix). I-BF2 is idempotency.
  // I-BF3 protects the forward-sync watermark/cursor. I-BF4 mirrors I-DS1 /
  // I-F6 (dry-run no-writes). I-BF5 is the budget gate. I-BF6 grounds I-AUD1.
  "I-BF1: prx sync backfill resolves every enumerated external record via adapter.resolveFromBeads over the (domain, external_id) map — never short-id prefix matching",
  "I-BF2: prx sync backfill is idempotent — matched records skip, unmatched records mirror; re-running over the same [from,to] produces zero net new bd records",
  "I-BF3: prx sync backfill never advances prx.fetch.gh-issues.watermark nor the `bd github sync` cursor (it heals records the cursor already passed; ADR §5 no-cursor-advance)",
  "I-BF4: prx sync backfill --dry-run performs zero bd/gh writes (mirrors I-DS1 / I-F6)",
  "I-BF5: prx sync backfill checks the GraphQL budget before each batch and pauses/defers the remaining records when the pool drops below threshold; --budget=N overrides",
  "I-BF6: every DOMAIN_SYNC_BACKFILL_* event carries uow_id (audit substrate, grounds I-AUD1)",
  "I-BD1: a unit surfaces in the ready_to_start thread only when bd.status='open' && bd.blocked_by ∩ {open units} == ∅",
  "I-BD2: bd-ready cache writes are atomic (tmp + rename); no partial cache file ever appears on disk",
  "I-BD3: cache reads served past TTL emit BD_READY_CACHE_STALE_SERVED so the operator can see staleness",
  // GH-2254: bd recycles short-ids after a record closes, so a short-id read
  // from a stored artifact can silently point at a different live record. The
  // stable long-id (`<prefix>-<13-digit-ms>-<seq>-<8-hex>`) is the only safe
  // persisted reference. See docs/bd-id-stability.md. Upstream prevention of
  // the recycling is GH-1479; in-repo we quarantine collisions (doctor
  // dedupe-bd) and pair drift to the open canonical (findDrift / I-NW1).
  "I-BD4: persisted bd references in artifacts (plan blobs, docs/audit/*.md, bead notes/cross-refs) are canonical long-id only; a short-id read from a stored artifact is re-verified against the current title/content before any mutating op (short-ids recycle upstream after close — GH-1479)",
  "I-PROJ1: GH-Project state is a projection of bd — the projection writer never reads GH-Project fields back into the bd-canonical state",
  "I-NW1: a unit surfaces in the triage_backlog thread iff it appears in runStatusActor().snapshot under issues ∪ drift ∪ stale — direction-locked read-only projection of `prx triage status`. reverseOrphans is EXCLUDED (prx-3f1): a bd record with no external_ref is the normal beads-first state, not a remediation orphan, so it is informational only — never projected into triage_backlog and never counted in the rate-limit sweep budget (supersedes GH-2011)",
  "I-NW2: a unit surfaces in the plan_paused thread iff its most-recent transition-log entry is a planning-role entry (actor ∈ planner_agent variants) older than plan_paused_ttl_seconds with no later ROLE_EXECUTOR_STARTED or ROLE_PLANNER_COMPLETED for the same issue",
  "I-NW3: a unit landing in executor_in_flight, pr_awaiting_ci, orphan_cleanup, or ready_to_start is suppressed from plan_paused and triage_backlog — the board-column signal wins over paused-planning/triage signals",
  "I-F4: prx fetch gh-issues — page atomicity. A page either fully writes (all N rows upserted + watermark advanced) or commits nothing of itself. No partial-page state visible to bd readers or to the watermark",
  "I-F5: prx fetch gh-issues — watermark monotonicity. The watermark never regresses; a failed page leaves it at the prior page's max(updatedAt), and the next run resumes from there",
  "I-F6: prx fetch gh-issues — dry-run no-writes. dryRun=true ⇒ exactly one `gh api graphql` count probe and zero `bd create|update|config set` calls",
  // GH-1649 — sibling to I-BF1. The fetch writer resolves each row's URL→bdId
  // over the (domain, external_id) map and writes by canonical-long-id
  // positional; it never leans on bd's `--external-ref`/last-touched fallback
  // for resolution (the GH-1473 silent-miswire class).
  "I-F7: prx fetch gh-issues — the writer resolves each row's URL→bdId via `resolveFromBeads` (the (domain, external_id) map) and writes by canonical-long-id positional; it never relies on bd's `--external-ref`/last-touched fallback for resolution",
  // GH-1823 — five UoW-rooted invariants the `prx audit` verb measures.
  // Cross-refs: I-AUD1 grounds the uow_id requirement (sibling: GH-1822
  // UoW-rooted lifecycle). I-AUD2 grounds artifact lineage. I-AUD3 grounds
  // the TransitionContract guard from GH-1821. I-AUD4 grounds GH-1824's
  // "no ambient git" promise. I-AUD5 grounds the GH-1824 "status is a
  // projection, not a stored field" claim.
  "I-AUD1: every audit event has a uow_id (or aggregate-uow ref)",
  "I-AUD2: every artifact carries uow_id and input_refs[] (lineage)",
  "I-AUD3: every phase transition is guarded by the required artifacts per TransitionContract (GH-1821)",
  "I-AUD4: every Git mutation goes through PRX — agent sessions emit zero ambient-git violations",
  "I-AUD5: every UoW status is derived from the artifact graph, not stored as a free field",
  // GH-1978: workspace actor (sync/ignore-sync/up/down retired from wtctl).
  // I-WS1 gates the lifecycle — `reserve` is the only entry, everything
  // else fails closed without a prior RESERVED. I-WS2 mirrors the dep-research
  // I-DR3 atomic-write invariant for tooling files. I-WS3 captures the
  // long-standing `wtctl up --auto || true` semantics now turned contract.
  // I-WS4 grounds the audit-substrate's uow_id requirement (I-AUD1/I-AUD2)
  // for every workspace event. I-WS5 (GH-2281) is the fail-closed backstop
  // that makes the merged by-id ledger lookup (#2273, 387ea75) safe to keep:
  // even if a materialize path regresses, no mutation/spawn ever lands on the
  // read-only mainx replica.
  "I-WS1: workspace.reserve is the only lifecycle entry — prepare/sync/service/teardown against a workspace with no prior WORKSPACE_RESERVED fail closed",
  "I-WS2: workspace tooling-file writes (sync/prepare) are atomic (tmp + rename); no partial file ever appears on disk",
  "I-WS3: workspace service --auto with no auto-up profile is a no-op (status=skipped|no-profile, exit 0)",
  "I-WS4: every WORKSPACE_* event carries workspace_id + uow_id (audit substrate, grounds I-AUD1/I-AUD2)",
  "I-WS5: a workspace/session mutation (prepare/sync/service/teardown, openSession) resolving worktree_path to the read-only mainx replica fails closed (status=error), even under teardown --force; read verbs (status/show/search/view) are unaffected",
  // GH-2009: dolt actor — per-repo lifecycle invariants. I-DOLT1 gates
  // entry (provision-only, with `adopt` as the explicit legacy-import
  // escape valve per GH-555 §adopt). I-DOLT2 closes the GH-557
  // "database is locked" race by making concurrent starts a no-op.
  // I-DOLT3 mirrors I-WS2 / I-DR3 for ledger writes. I-DOLT4 makes
  // port assignment deterministic (with documented fallback). I-DOLT5
  // grounds the GH-826 mirror shape (bare buffer). I-DOLT6 grounds
  // the GH-1381 / 2026-05-16 silent-contamination class. I-DOLT7
  // grounds I-AUD1/I-AUD2 for every DOLT_* event. I-DOLT8 mirrors
  // I-DS1 for the beads-sync analog (sync-all dry-run).
  "I-DOLT1: dolt.provision is the only lifecycle entry — start/stop/status/reconcile against a (repo, dolt_database) with no prior DOLT_PROVISIONED fail closed; `adopt` is the explicit legacy-import escape valve (GH-555 §adopt)",
  "I-DOLT2: one prx-owned dolt server per (repo, dolt_database) — a second `start` is a no-op with status='exists', never a spawn (closes the GH-557 'database is locked' race)",
  "I-DOLT3: dolt ledger writes (<repoCommonDir>/info/dolt/<dolt_server_id>.json — pid/port/dsn/owner) are atomic (tmp + rename); no partial ledger ever appears on disk",
  "I-DOLT4: dolt port assignment is deterministic from dolt_server_id over the prx-owned range (default 3306 + hash-mod offset); collisions fall through to the next free port and the choice is recorded in the ledger",
  "I-DOLT5: per-host mirror at ~/.local/state/dolt/buffer/<owner>/<repo>/<db>/ is a bare repo (no chunk journal); hop-2 `dolt clone file://<mirror>` works on every cold-host hydrate (grounds GH-826's architectural cause)",
  "I-DOLT6: dolt.auto-push defaults to false for every prx-bootstrapped beads workspace — pushes go through `prx dolt reconcile` / `prx beads publish` (grounds the GH-1381 / 2026-05-16 silent-contamination class)",
  "I-DOLT7: every DOLT_* event carries dolt_server_id + uow_id (audit substrate, grounds I-AUD1/I-AUD2)",
  "I-DOLT8: prx dolt sync-all --dry-run performs zero dolt writes (mirrors I-DS1 for the beads-sync analog)",
  // GH-1495: temporal→durable memory digest. I-TD1 mirrors I-DR4 / I-DS1
  // / I-DOLT8 (dry-run no-writes). I-TD2 mirrors I-DR3 / I-WS2 / I-BD2 /
  // I-DOLT3 (atomic tmp+rename for outputs). I-TD3 grounds I-AUD1/I-AUD2
  // for every digest event. I-TD4 closes the "empty extraction shouldn't
  // touch disk" class. I-TD5 closes the re-run-explodes-shards class
  // (idempotency on originSessionId). I-TD6 captures the partial-tolerant
  // parse contract — malformed lines never abort a session. I-TD7
  // protects the 24.4KB MEMORY.md harness cap (GH-1460/1461) the existing
  // SessionStart hook honors.
  "I-TD1: prx transcripts digest --dry-run leaves no on-disk artifacts (no .candidates writes, no shard appends, no candidate body writes)",
  "I-TD2: transcripts-digest stage and commit writes are atomic (tmp + rename); no partial candidate file ever appears on disk",
  "I-TD3: every transcripts-digest output carries uow_id + input_refs: [<sourceTranscriptRef>] in its frontmatter (audit substrate; grounds I-AUD1/I-AUD2)",
  "I-TD4: extraction yielding zero candidates ⇒ no output write; TRANSCRIPT_DIGEST_NO_NEW_MEMORIES fires",
  "I-TD5: transcripts-digest is idempotent on (source, sessionId) — re-running over the same transcript produces zero net writes (dedup via originSessionId frontmatter)",
  "I-TD6: transcripts-digest parse failures are partial-tolerant per session — a malformed line emits TRANSCRIPT_PARSE_LINE_SKIPPED and continues; an unrecoverable session emits TRANSCRIPT_DIGEST_FAILED without aborting the batch",
  "I-TD7: transcripts-digest commit writer respects the 24.4KB MEMORY.md harness cap (GH-1460/1461) — refuses to commit if append would push the auto-loaded shard total past cap; staging always allowed",
  // GH-2027: session-open actor. I-SO1 gates the lifecycle entry —
  // CLI handlers may not bypass the actor and dispatch
  // `OPEN_*_SESSION` events directly into `sessionEntryMachine`.
  // I-SO2 closes the parallel-intake collision class
  // (ai-home-ai4ww, 2026-05-18) by requiring a fresh per-call
  // short id for intake/triage; work-unit-bound verbs reuse the
  // canonical work-unit branch and rely on `workspace.reserve`
  // idempotence (`exists-local`) for re-entry. I-SO3 grounds the
  // audit substrate alongside I-WS4/I-DOLT7.
  "I-SO1: every `prx <actor> session` verb routes through the `session_open` actor — CLI handlers must not dispatch `OPEN_*_SESSION` events directly into `sessionEntryMachine`",
  "I-SO2: intake/triage session-open derives a fresh `(yyyymmdd, shortId)` per call (CSPRNG-sourced short id) — no reuse of an existing workspace_id across invocations",
  "I-SO3: every SESSION_OPEN_* event carries workspace_id (when known) + uow_id (audit substrate, grounds I-AUD1/I-AUD2/I-AUD4)",
  // GH-1397: handoff-queue invariants. I-HQ1 grounds I-AUD1 for every
  // HANDOFF_* event (uow_id + handoff_id always present). I-HQ2 closes
  // the privilege-escalation channel — the recipient role is the trust
  // boundary at drain time, not the source role. I-HQ3 makes a second
  // enqueue with the same `dedupKey` a no-op (idempotency for the
  // crash-and-retry path). I-HQ4 mirrors the bd-side atomic-write
  // invariants (I-BD2 / I-DR3 / I-WS2 / I-DOLT3) for handoff rows.
  // I-HQ5 forces fail-closed when bd is unprovisioned so the legacy
  // banner-string fallback (`src/machine/runtime_profiles.ts:77,1208`)
  // survives as the operator-visible safety net.
  "I-HQ1: every HANDOFF_* event carries handoff_id + uow_id (audit substrate, grounds I-AUD1)",
  "I-HQ2: HANDOFF_DRAINED requires the recipient's checkPolicy(...) to have returned allowed=true at drain time — recipient role is the trust boundary, not source role (closes the privilege-escalation channel)",
  "I-HQ3: enqueue is idempotent on dedupKey — a second enqueue with the same key is a no-op that returns the existing handoff_id",
  "I-HQ4: bd-memory writes for handoff rows are atomic (Dolt SQL transactions); no partial envelope ever appears on disk",
  "I-HQ5: drain failure on bd unprovisioned ⇒ fail closed (exit non-zero, surface the runtime_profiles.ts banner-string fallback). Never silently drop an intent",
] as const;

const rfc3339UtcString = z
  .string()
  .datetime({ offset: true });

export const rawStateV1Schema = z
  .object({
    unitId: workUnitIdSchema,
    artifacts: z
      .object({
        ticket: z
          .object({
            exists: z.boolean(),
            id: z.string().nullable(),
            system: z.enum(["bd", "notion", "jira", "other"]),
            url: z.string().nullable(),
          })
          .strict(),
        worktree: z
          .object({
            exists: z.boolean(),
            path: z.string().nullable(),
            checkedOutBranch: branchNameSchema.nullable(),
            headSha: shaSchema.nullable(),
          })
          .strict(),
        branch: z
          .object({
            name: branchNameSchema.nullable(),
            existsLocal: z.boolean(),
            existsRemote: z.boolean(),
            ahead: z.number().int().min(0),
            behind: z.number().int().min(0),
            headShaLocal: shaSchema.nullable(),
            headShaRemote: shaSchema.nullable(),
          })
          .strict(),
        pr: z
          .object({
            exists: z.boolean(),
            number: z.number().int().nullable(),
            state: z.enum(["none", "open", "closed", "merged"]),
            isDraft: z.boolean().nullable(),
            headRef: branchNameSchema.nullable(),
            baseRef: branchNameSchema.nullable(),
            url: z.string().nullable(),
            // GH-885: autoMergeRequest from `gh pr view --json autoMergeRequest`.
            // Null/undefined when no automerge request is registered with
            // GitHub. Optional so callers that built RawStateV1 before this
            // field existed don't need to be updated in lockstep — derivePhase
            // and assertInvariants both treat undefined as "no automerge".
            autoMergeRequest: z
              .object({
                enabledBy: z.string().nullable(),
                mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]),
              })
              .strict()
              .nullable()
              .optional(),
          })
          .strict(),
      })
      .strict(),
    signals: z
      .object({
        review: z
          .object({
            decision: z.enum(["none", "changes_requested", "approved"]),
            reviewersRequested: z.boolean(),
            unresolvedThreads: z.number().int().min(0),
          })
          .strict(),
        ci: z
          .object({
            state: z.enum(["none", "queued", "in_progress", "passed", "failed", "cancelled"]),
            requiredTotal: z.number().int().min(0),
            requiredPassed: z.number().int().min(0),
            failing: z.array(z.string()),
          })
          .strict(),
        mergeability: z
          .object({
            state: z.enum(["unknown", "mergeable", "blocked", "conflicting", "behind", "draft"]),
            blockedReasons: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
    sync: z
      .object({
        remoteFresh: z.boolean(),
        ticketLinkedToPR: z.boolean().nullable(),
      })
      .strict(),
    meta: z
      .object({
        observedAt: rfc3339UtcString,
        sources: z
          .object({
            git: rfc3339UtcString,
            gh: rfc3339UtcString,
            ticketSystem: rfc3339UtcString.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type RawStateV1 = z.infer<typeof rawStateV1Schema>;

export type InvariantFinding = {
  id: string;
  severity: "hard";
  message: string;
};

export type InvariantReport = {
  valid: boolean;
  findings: InvariantFinding[];
};

export function derivePhase(rawInput: RawStateV1): WorkflowPhase {
  const raw = rawStateV1Schema.parse(rawInput);
  const { artifacts, signals, sync } = raw;
  const { pr, worktree, branch } = artifacts;

  if (pr.state === "merged" && !worktree.exists && !branch.existsLocal) return "cleaned";
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (!worktree.exists) return "no_worktree";
  if (worktree.exists && !branch.existsLocal) return "worktree_created";
  if (branch.existsLocal && !branch.existsRemote && branch.ahead === 0 && !pr.exists) return "branch_created";
  if (branch.existsLocal && !pr.exists && (branch.ahead > 0 || !branch.existsRemote)) return "committing";
  if (branch.existsRemote && !pr.exists) return "pushed";
  if (pr.state === "open" && pr.isDraft) return "draft";
  if (pr.state === "open" && signals.review.decision === "changes_requested") return "changes_requested";
  if (pr.state === "open" && (signals.ci.state === "queued" || signals.ci.state === "in_progress")) return "waiting_on_ci";
  if (
    pr.state === "open" &&
    (
      signals.ci.state === "failed" ||
      signals.mergeability.state === "blocked" ||
      signals.mergeability.state === "conflicting" ||
      signals.mergeability.state === "behind" ||
      signals.mergeability.state === "draft" ||
      signals.review.unresolvedThreads > 0
    )
  ) {
    return "blocked";
  }
  if (
    pr.state === "open" &&
    !pr.isDraft &&
    signals.review.decision === "approved" &&
    signals.ci.state === "passed" &&
    signals.mergeability.state === "mergeable" &&
    sync.remoteFresh &&
    signals.review.unresolvedThreads === 0
  ) {
    // GH-885: when GitHub holds a registered automerge request the unit has
    // already passed the ready_to_merge gate; promote it to a separate phase
    // so callers can distinguish "merge-ready, awaiting human confirm" from
    // "armed automerge, waiting on GitHub".
    if (pr.autoMergeRequest != null) {
      return "automerge_enabled";
    }
    return "ready_to_merge";
  }
  if (pr.state === "open" && !pr.isDraft && !signals.review.reviewersRequested) return "ready_for_review";
  if (pr.state === "open") return "in_review";
  return "blocked";
}

export function assertInvariants(rawInput: RawStateV1, phase: WorkflowPhase): InvariantReport {
  const raw = rawStateV1Schema.parse(rawInput);
  const findings: InvariantFinding[] = [];
  const hard = (id: string, condition: boolean, message: string) => {
    if (!condition) findings.push({ id, severity: "hard", message });
  };

  hard(
    "I01",
    !raw.artifacts.pr.exists || raw.artifacts.branch.existsLocal || raw.artifacts.branch.existsRemote,
    "pr.exists => (branch.existsLocal || branch.existsRemote)",
  );
  hard(
    "I02",
    !raw.artifacts.pr.exists || raw.artifacts.pr.headRef === raw.artifacts.branch.name,
    "pr.exists => pr.headRef == branch.name",
  );
  hard(
    "I03",
    !raw.artifacts.worktree.exists ||
      (raw.artifacts.branch.existsLocal && raw.artifacts.worktree.checkedOutBranch === raw.artifacts.branch.name),
    "worktree.exists => (branch.existsLocal && worktree.checkedOutBranch == branch.name)",
  );
  hard(
    "I04",
    phase !== "ready_to_merge" ||
      (
        raw.signals.review.decision === "approved" &&
        raw.signals.ci.state === "passed" &&
        raw.signals.mergeability.state === "mergeable" &&
        raw.sync.remoteFresh &&
        raw.signals.review.unresolvedThreads === 0 &&
        raw.artifacts.pr.isDraft === false
      ),
    "phase=ready_to_merge requires approved + ci passed + mergeable + remoteFresh + no unresolved + !draft",
  );
  hard(
    "I09",
    phase !== "automerge_enabled" ||
      (
        raw.signals.review.decision === "approved" &&
        raw.signals.ci.state === "passed" &&
        raw.signals.mergeability.state === "mergeable" &&
        raw.sync.remoteFresh &&
        raw.signals.review.unresolvedThreads === 0 &&
        raw.artifacts.pr.isDraft === false &&
        raw.artifacts.pr.autoMergeRequest != null
      ),
    "phase=automerge_enabled requires I04 conditions + pr.autoMergeRequest != null",
  );
  hard(
    "I05",
    phase !== "cleaned" || (!raw.artifacts.worktree.exists && !raw.artifacts.branch.existsLocal),
    "phase=cleaned => !worktree.exists && !branch.existsLocal",
  );
  hard(
    "I06",
    raw.signals.ci.requiredPassed <= raw.signals.ci.requiredTotal,
    "ci.requiredPassed <= ci.requiredTotal",
  );
  hard(
    "I07",
    raw.signals.ci.state !== "passed" || raw.signals.ci.requiredPassed === raw.signals.ci.requiredTotal,
    "ci.state=passed => ci.requiredPassed == ci.requiredTotal",
  );
  hard(
    "I08",
    !raw.sync.remoteFresh || raw.artifacts.branch.headShaLocal === raw.artifacts.branch.headShaRemote,
    "sync.remoteFresh => branch.headShaLocal == branch.headShaRemote",
  );

  return {
    valid: findings.length === 0,
    findings,
  };
}
