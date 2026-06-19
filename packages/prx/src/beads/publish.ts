/**
 * `prx beads publish <bd-id>` (GH-1507) — publish one bd-authoritative record
 * to GitHub: the GitHub mirror's `push`.
 *
 * Under the GH-1500 ADR (`docs/spikes/GH-1500-authority.md`) bd is the
 * canonical work-graph and GitHub is a pluggable, opt-in mirror. The canonical
 * write direction for bd-authoritative fields (title, body, type, priority…)
 * is bd → external. This verb implements that for the GitHub mirror, subject to
 * the ADR §4 safety contract (originally drafted under GH-1189; the prior
 * `triage push-orphans` sweep that paraphrased these rules was retired in
 * GH-1718, leaving this verb the sole bd → GH publish surface):
 *
 *   1. Idempotent — re-running is a no-op once `external_ref` points at the GH issue.
 *   2. One direction only — bd → GH for bd-authoritative fields; never GH → bd here.
 *   3. Dedupe by the bd-side title fingerprint (and, default-on, a GH-side
 *      title scan) before any `gh issue create`.
 *   4. Input is a bd short-id, never a `GH-N` handle — so it cannot race the
 *      `bd github sync` GH → bd auto-create path.
 *   5. Single record only — bulk publish is the periodic job (GH-1537).
 *
 * Position in the model: `beads` is a `planning/cli` actor. This verb is
 * *upstream of the parity chain* — like `prx intake mirror`, it emits no
 * XState events and touches no PR/workflow-machine state. The only governing
 * contract is ADR §4.
 *
 * Label / field scope: this projects **title, body, `type::*`, `priority::*`**
 * — exactly what `BeadsRecord` exposes. `area::*` / `effort::*` are owned by
 * `prx triage apply` (ADR §2),
 * and non-axis labels (`agent::*`, …) need `BeadsRecord` to carry bd's `labels`
 * field; full label parity is downstream — the domain adapter (GH-1536) or a
 * `BeadsRecord` extension. The genuinely-deferrable hardening (audit NDJSON
 * row, opt-in `--sync` post-create chain, pointer-back comment) is a post-merge
 * follow-up, not part of this verb.
 *
 * Reuse, don't reinvent: `loadAllBeads` / `normalizeTitle` / `bdPriorityToLabel`
 * / `extractIssueNumber` (`../triage/triage.ts`), `BD_TYPE_ENUM`
 * (`../triage/labels.ts`), `execGhIssueCreate` / `buildGhIssueCreateArgs`
 * (`../tools/gh_issue_create.ts` — the rate-limit-gated `gh issue create`
 * surface), `loadAllBeadsViaCli` (`../triage/beads-daemon-loader.ts`), `repoNameWithOwner` /
 * `listIssuesByState` (`../pr-state/github.ts`), `resolveIssueId`
 * (`../issues/resolver.ts`). DI shape mirrors `src/intake/intake-mirror.ts`.
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { appendAuditRow, type AuditSinkDeps } from "../audit/sink.ts";
import {
  buildGhIssueCreateArgs,
  execGhIssueCreate as defaultExecGhIssueCreate,
  type GhIssueCreateResult,
} from "../tools/gh_issue_create.ts";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import { execGh as defaultExecGh, type GhExecResult } from "@bounded-systems/gh";
import { extractIssueNumber, normalizeTitle, type BeadsRecord } from "../triage/triage.ts";
import { loadAllBeadsViaCli } from "../triage/beads-daemon-loader.ts";
import { issueLabelsFor } from "../triage/bd-axis-labels.ts";
import {
  listIssuesByState as defaultListIssuesByState,
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
import {
  GhDomainAdapter,
  GhDomainAdapterError,
  type LinkedReconcileResult,
} from "../adapters/github.ts";
import type { DomainPushFields } from "../adapters/domain-adapter.ts";
import { recordEvent } from "../machine/record_event.ts";
import { IssueResolveError, resolveIssueId } from "../issues/resolver.ts";

export const beadsPublishOptionsSchema = z.object({
  bdId: z.string().trim().min(1, "bd-id must not be empty"),
  repo: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
  /** Skip the default-on GH-side title-adopt scan; ADR §4-minimum (bd-side fingerprint only). */
  noAdopt: z.boolean().default(false),
  /**
   * Caller-supplied labels to fold into `gh issue create` alongside the
   * bd-axis stamps from `issueLabelsFor` (type::*, priority::*). GH-1607 uses
   * this so intake can project `area::<scope>` and the GH-only `type::spike`
   * marker through `publishOne` instead of stamping them on bd first. Until
   * BeadsRecord carries a labels field (GH-1500 follow-up), this is the
   * narrow seam by which a caller-known label set reaches the adapter.
   */
  extraLabels: z.array(z.string()).default([]),
  format: z.enum(["plain", "json"]).default("plain"),
});
export type BeadsPublishOptions = z.infer<typeof beadsPublishOptionsSchema>;

export type BeadsPublishOutcome =
  | "noop"
  | "reconciled"
  | "linked"
  | "adopted"
  | "created"
  | "partial-error"
  | "error";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type BeadsPublishDeps = {
  execGhIssueCreate?: typeof defaultExecGhIssueCreate;
  /**
   * GH-296 / prx-82b — sync runner for the daemon-routed external-ref write-back
   * (`prx beads update <id> --external-ref <url>`). Default: procRunner.
   */
  run?: CommandRunner;
  execGh?: typeof defaultExecGh;
  /**
   * prx-022t — bead record reader; defaults to `loadAllBeadsViaCli` (daemon-backed)
   * so reads and the daemon write-back see the same canonical beads database.
   * Tests inject `() => records` directly.
   */
  loadAllBeads?: () => BeadsRecord[];
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  listIssuesByState?: typeof defaultListIssuesByState;
  cwd?: () => string;
  /** GH-1598 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  now?: () => Date;
  /**
   * GH-1595 — drop the per-invocation `BeadsCache` after writing the bd
   * record (Step 10 `bd update --external-ref` / link-existing write-back).
   * Optional: missing/no-op when called without a cache (test default).
   */
  invalidateBeadsCache?: () => void;
  /**
   * GH-2382 — GitHub adapter whose synchronous `reconcileLinked` core drives
   * the linked-record lossless reconcile (Step 6). Defaults to a
   * `GhDomainAdapter` with production gated I/O seams. Tests inject one wired
   * to mock runner / `execGhIssueEdit` to assert the projected diff.
   */
  pushAdapter?: GhDomainAdapter;
};

// GH-1598 — verb-side TS authority for the audit row (mirrors `PromoteAuditEntry`
// in src/triage/promote.ts). Re-validated at the sink via `appendAuditRow`
// against `beadsPublishAuditRowSchema`.
export type BeadsPublishAuditEntry = {
  ts: string;
  bdId: string;
  outcome: BeadsPublishOutcome;
  ghNumber?: number;
  ghUrl?: string;
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type BeadsPublishRender = {
  bdId: string;
  repo: string;
  title: string;
  outcome: BeadsPublishOutcome;
  /** GitHub issue URL once published / linked / adopted (absent on dry-run create + errors). */
  externalRef?: string;
  /** Planned `gh issue create` argv — present only on the dry-run create path. */
  ghCreate?: { argv: string[] };
  dryRun: boolean;
  exitCode: number;
  /** Human-readable note: refusal/error text, or why a link/adopt happened instead of a create. */
  message?: string;
};

/**
 * Structured result for `prx beads publish` — what GH-1537's budgeted bulk
 * loop reads off each per-record call (it injects a cached `loadAllBeads` so it
 * doesn't re-read disk every iteration). Mirrors `runPushOrphansActor`.
 */
export type BeadsPublishUnitResult = {
  exitCode: number;
  outcome: BeadsPublishOutcome;
  bdId: string;
  externalRef?: string;
};

// `<owner>/<repo>/issues/<n>` under github.com. `external_ref` is the full GH
// issue URL — repo tooling resolves bd ↔ GH via that field with a `/issues/<n>`
// regex (`feedback_gh_to_bd_resolve_via_external_ref`). A non-GH pin (Notion,
// GitLab, …) can't share the legacy single `external_ref` slot, so publishing
// onto it is refused until the {domain → external_id} map lands (GH-1538).
const GITHUB_ISSUE_URL_RE = /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+(?:[/?#].*)?$/;

function isGithubIssueUrl(ref: string): boolean {
  return GITHUB_ISSUE_URL_RE.test(ref);
}

function describeGhIssue(url: string): string {
  const n = extractIssueNumber(url);
  return n === null ? url : `GH-${n}`;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/.:@=+\-#]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderGhArgv(argv: string[]): string {
  return `gh ${argv.map(shellQuote).join(" ")}`;
}

export type PublishCoreResult = {
  exitCode: number;
  outcome: BeadsPublishOutcome;
  bdId: string;
  externalRef?: string;
  render: BeadsPublishRender;
};

function errorResult(bdId: string, repo: string, message: string, exitCode = 1): PublishCoreResult {
  return {
    exitCode,
    outcome: "error",
    bdId,
    render: { bdId, repo, title: "", outcome: "error", dryRun: false, exitCode, message },
  };
}

function linkExistingResult(
  bdId: string,
  repo: string,
  title: string,
  url: string,
  outcome: "linked" | "adopted",
  reason: string,
  opts: BeadsPublishOptions,
  run: CommandRunner,
  invalidateBeadsCache?: () => void,
): PublishCoreResult {
  if (opts.dryRun) {
    return {
      exitCode: 0,
      outcome,
      bdId,
      externalRef: url,
      render: {
        bdId,
        repo,
        title,
        outcome,
        externalRef: url,
        dryRun: true,
        exitCode: 0,
        message: `dry-run: would link to ${describeGhIssue(url)} — ${reason}`,
      },
    };
  }
  // GH-296 / prx-82b: link via the daemon (single writer).
  const updateResult = run(["prx", "beads", "update", bdId, "--external-ref", url], {
    check: false,
  });
  if (updateResult.status !== 0) {
    const detail =
      updateResult.stderr.trim() || updateResult.stdout.trim() || "prx beads update failed";
    return errorResult(bdId, repo, `prx beads publish: ${detail}`, updateResult.status || 1);
  }
  invalidateBeadsCache?.();
  return {
    exitCode: 0,
    outcome,
    bdId,
    externalRef: url,
    render: {
      bdId,
      repo,
      title,
      outcome,
      externalRef: url,
      dryRun: false,
      exitCode: 0,
      message: `${outcome} to ${describeGhIssue(url)} — ${reason}`,
    },
  };
}

export function publishOne(opts: BeadsPublishOptions, deps: BeadsPublishDeps): PublishCoreResult {
  const ghCreate = deps.execGhIssueCreate ?? defaultExecGhIssueCreate;
  const run = deps.run ?? procRunner;
  const ghExec = deps.execGh ?? defaultExecGh;
  // prx-022t: use daemon-backed read so reads and the step-10 write-back see
  // the same canonical beads (avoids bd-update failures when the daemon serves
  // ~/.local/state/prx/beads but direct execBd would hit the worktree's .beads).
  const loadBeads = deps.loadAllBeads ?? (() => loadAllBeadsViaCli());
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const listIssues = deps.listIssuesByState ?? defaultListIssuesByState;
  const getCwd = deps.cwd ?? process.cwd;
  const now = deps.now ?? (() => new Date());
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? now,
  };

  const pushAdapter = deps.pushAdapter ?? new GhDomainAdapter();

  const result = publishOneInner(opts, {
    ghCreate,
    run,
    ghExec,
    loadBeads,
    resolveRepo,
    listIssues,
    getCwd,
    invalidateBeadsCache: deps.invalidateBeadsCache,
    pushAdapter,
  });
  // GH-1598 — emit one audit row at the terminal outcome. dryRun reflects the
  // operator's intent (`opts.dryRun`), not the per-branch render flag.
  const ghNumber = result.externalRef ? extractIssueNumber(result.externalRef) : null;
  const entry: BeadsPublishAuditEntry = {
    ts: now().toISOString(),
    bdId: result.bdId,
    outcome: result.outcome,
    ...(ghNumber !== null ? { ghNumber } : {}),
    ...(result.externalRef ? { ghUrl: result.externalRef } : {}),
    actor: "claude-code",
    dryRun: opts.dryRun,
    exitCode: result.exitCode,
    ...((result.outcome === "error" || result.outcome === "partial-error") && result.render.message
      ? { stderr: result.render.message }
      : {}),
  };
  appendAuditRow(entry, auditSink);

  // GH-2382 — a real (non-dry-run) reconcile that touched the GH issue emits
  // the `publisher`-owned `ISSUE_UPDATE_REQUESTED` intent so every bd→GH issue
  // edit carries a `workUnitId`-stamped audit row (I-AUD1). The event owner is
  // derived from `eventOwnerMap` (publisher).
  if (result.outcome === "reconciled" && !opts.dryRun) {
    recordEvent("ISSUE_UPDATE_REQUESTED", {
      workUnitId: result.bdId,
      ...(result.render.repo ? { repo: result.render.repo } : {}),
      deps: auditSink,
    });
  }
  return result;
}

type PublishInnerDeps = {
  ghCreate: typeof defaultExecGhIssueCreate;
  run: CommandRunner;
  ghExec: typeof defaultExecGh;
  loadBeads: () => BeadsRecord[];
  resolveRepo: typeof defaultRepoNameWithOwner;
  listIssues: typeof defaultListIssuesByState;
  getCwd: () => string;
  invalidateBeadsCache?: (() => void) | undefined;
  pushAdapter: GhDomainAdapter;
};

function publishOneInner(opts: BeadsPublishOptions, deps: PublishInnerDeps): PublishCoreResult {
  const { ghCreate, run, ghExec, loadBeads, resolveRepo, listIssues, getCwd, pushAdapter } = deps;

  // Step 1: resolve <bd-id>. Refuse GH-form input — the publish direction is
  // bd → GH; GH → bd is `prx intake mirror`.
  let bdId: string;
  try {
    const resolved = resolveIssueId(opts.bdId, "prx beads publish");
    if (resolved.kind === "notion") {
      return errorResult(
        opts.bdId,
        "",
        `prx beads publish: '${opts.bdId}' is a Notion id; reverse-mirroring from Notion into beads is not wired. Use \`prx scout notion ${opts.bdId}\` to read the Notion record.`,
      );
    }
    if (resolved.kind !== "bd") {
      return errorResult(
        opts.bdId,
        "",
        `prx beads publish: '${opts.bdId}' looks like a GitHub issue; the publish direction is bd→GH. To mirror a GitHub issue into beads (GH→bd) use \`prx intake mirror ${opts.bdId}\`.`,
      );
    }
    bdId = resolved.id;
  } catch (err) {
    if (err instanceof IssueResolveError) {
      return errorResult(opts.bdId, "", err.message, err.exitCode);
    }
    throw err;
  }

  // Step 2: resolve the repo (needed for the GH-side title scan and to compose
  // the issue URL display). Explicit --repo wins; else fall back to the cwd's
  // git remote.
  let repo: string;
  try {
    repo = opts.repo ?? resolveRepo(getCwd()).trim();
  } catch (err) {
    return errorResult(bdId, "", `prx beads publish: ${(err as Error).message}`);
  }
  if (!repo) {
    return errorResult(
      bdId,
      "",
      "prx beads publish: could not resolve cwd repo (gh repo view returned empty); pass --repo explicitly",
    );
  }

  // Step 3: load all beads — the full dedup-required read (`feedback_promote_check_dedup`).
  let records: BeadsRecord[];
  try {
    records = loadBeads();
  } catch (err) {
    return errorResult(
      bdId,
      repo,
      `prx beads publish: ${(err as Error).message.replace(/^triage status: /, "")}`,
    );
  }

  const target = records.find((r) => r.id === bdId);
  if (!target) {
    return errorResult(bdId, repo, `prx beads publish: no beads record with id '${bdId}'`);
  }

  // Step 4: closed records are mirror-once-then-frozen (ADR §3).
  if (target.status === "closed") {
    return errorResult(
      bdId,
      repo,
      `prx beads publish: bd record ${bdId} is closed; closed records are frozen mirrors (ADR §3) — reopen it first if it must be published`,
    );
  }

  const existingRef = target.externalRef?.trim() || null;
  if (existingRef) {
    // Step 5: a non-GH pin can't share the legacy single external_ref slot.
    if (!isGithubIssueUrl(existingRef)) {
      return errorResult(
        bdId,
        repo,
        `prx beads publish: bd record ${bdId} already has a non-GitHub external_ref (${existingRef}); multi-domain pins land in GH-1538`,
      );
    }
    // Step 6: a linked record is *reconciled*, not silently no-op'd (GH-2382 —
    // the original bug: bumping a bead P3→P2 then re-publishing reported
    // success but left the stale `priority::low` label on GH). Project the
    // bd-authoritative title / body / axis labels onto the live GH issue via
    // the shared lossless reconcile core (`reconcileLinked`, identical to the
    // `prx beads sync` push leg's projection). bd→external only (I-DS-PRIO /
    // I-PROJ1): the live read never writes back to bd. Status and assignees
    // stay owned by the periodic sync / merge-close paths, so publish projects
    // only the fields it has always owned (title / body / type / priority).
    const desiredLabels = Array.from(new Set([...issueLabelsFor(target), ...opts.extraLabels]));
    const reconcileFields: DomainPushFields = {
      title: target.title,
      body: target.description,
      labels: desiredLabels,
    };
    let reconciled: LinkedReconcileResult;
    try {
      reconciled = pushAdapter.reconcileLinked(existingRef, reconcileFields, {
        cwd: getCwd(),
        dryRun: opts.dryRun,
      });
    } catch (err) {
      const exitCode = err instanceof GhDomainAdapterError ? err.exitCode : 1;
      return errorResult(bdId, repo, `prx beads publish: ${(err as Error).message}`, exitCode);
    }
    const outcome: BeadsPublishOutcome = reconciled.edited ? "reconciled" : "noop";
    const swap = [
      reconciled.addLabels.length ? `+${reconciled.addLabels.join(",")}` : "",
      reconciled.removeLabels.length ? `-${reconciled.removeLabels.join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const where = describeGhIssue(existingRef);
    const message =
      outcome === "noop"
        ? `already in sync with ${where}`
        : opts.dryRun
          ? `dry-run: would reconcile ${where}${swap ? ` (${swap})` : ""}`
          : `reconciled ${where}${swap ? ` (${swap})` : ""}`;
    return {
      exitCode: 0,
      outcome,
      bdId,
      externalRef: existingRef,
      render: {
        bdId,
        repo,
        title: target.title,
        outcome,
        externalRef: existingRef,
        dryRun: opts.dryRun,
        exitCode: 0,
        message,
      },
    };
  }

  const targetKey = normalizeTitle(target.title);

  // Step 7: bd-side fingerprint dedupe (ADR §4). A different bd record with the
  // same normalized title that is already linked to a GH issue means this title
  // was already published (a `bd github sync` auto-created sibling, or a racing
  // manual publish) — link this record to that URL instead of creating a dup.
  for (const r of records) {
    if (r.id === bdId) continue;
    const ref = r.externalRef?.trim() || null;
    if (!ref || !isGithubIssueUrl(ref)) continue;
    if (normalizeTitle(r.title) !== targetKey) continue;
    return linkExistingResult(
      bdId,
      repo,
      target.title,
      ref,
      "linked",
      `bd record ${r.id} already published this title`,
      opts,
      run,
      deps.invalidateBeadsCache,
    );
  }

  // Step 8: GH-side title-adopt scan (default-on; --no-adopt drops to the
  // ADR §4 minimum). Implements the `link-existing` outcome — the
  // "no `gh issue create` without a dup check" pattern (`feedback_triage_dedupe_pattern`).
  if (!opts.noAdopt) {
    let issues: FallbackIssue[];
    try {
      issues = listIssues(repo, "all", 1000);
    } catch (err) {
      return errorResult(bdId, repo, `prx beads publish: ${(err as Error).message}`);
    }
    const match = issues.find((i) => normalizeTitle(i.title) === targetKey);
    if (match) {
      return linkExistingResult(
        bdId,
        repo,
        target.title,
        match.url,
        "adopted",
        `existing GitHub issue GH-${match.number} matched by title`,
        opts,
        run,
        deps.invalidateBeadsCache,
      );
    }
  }

  // Step 9: create. On --dry-run, render the planned argv and stop.
  // `extraLabels` (GH-1607) lets a caller fold operator-known labels (e.g. area::*,
  // type::spike marker) into the create argv without first stamping them on bd —
  // until BeadsRecord carries bd's `labels` field, this is the only seam for
  // labels that aren't on the bd-axis stamps.
  const labels = Array.from(new Set([...issueLabelsFor(target), ...opts.extraLabels]));
  const createOpts = { title: target.title, body: target.description, repo, labels };
  if (opts.dryRun) {
    return {
      exitCode: 0,
      outcome: "created",
      bdId,
      render: {
        bdId,
        repo,
        title: target.title,
        outcome: "created",
        ghCreate: { argv: buildGhIssueCreateArgs(createOpts) },
        dryRun: true,
        exitCode: 0,
      },
    };
  }

  const createResult: GhIssueCreateResult = ghCreate(createOpts);
  if (createResult.exitCode !== 0 || !createResult.issueUrl) {
    const detail =
      createResult.stderr.trim() || createResult.stdout.trim() || "gh issue create failed";
    return errorResult(bdId, repo, `prx beads publish: ${detail}`, createResult.exitCode || 1);
  }
  const ghUrl = createResult.issueUrl;

  // Step 10: write the URL back to external_ref. If this fails the GH issue is
  // stranded — but a re-run picks it up via the bd-side / GH-side title dedupe
  // (steps 7–8), so report partial-error and exit 1 rather than losing it.
  // GH-296 / prx-82b: write-back via the daemon (single writer).
  const updateResult = run(["prx", "beads", "update", bdId, "--external-ref", ghUrl], {
    check: false,
  });
  if (updateResult.status !== 0) {
    const detail =
      updateResult.stderr.trim() || updateResult.stdout.trim() || "prx beads update failed";
    return {
      exitCode: 1,
      outcome: "partial-error",
      bdId,
      externalRef: ghUrl,
      render: {
        bdId,
        repo,
        title: target.title,
        outcome: "partial-error",
        externalRef: ghUrl,
        dryRun: false,
        exitCode: 1,
        message: `GitHub issue created at ${ghUrl} but bd update failed (${detail}); re-run \`prx beads publish ${bdId}\` to relink`,
      },
    };
  }
  deps.invalidateBeadsCache?.();

  // GH-1598 — pointer-back GH comment, symmetric with `triage promote`'s
  // "Promoted to beads as <bd-id>." The bd↔GH link is already durable via
  // Step 10's `bd update`, so a comment failure is partial (exit 1) — a
  // re-run is a no-op (Step 6) and the operator can post the comment by
  // hand. `gh issue comment` is an external API write, hence `executor`
  // role even from this planning-tier verb (same as `triage promote`).
  const ghIssueNumber = extractIssueNumber(ghUrl);
  if (ghIssueNumber === null) {
    return {
      exitCode: 1,
      outcome: "partial-error",
      bdId,
      externalRef: ghUrl,
      render: {
        bdId,
        repo,
        title: target.title,
        outcome: "partial-error",
        externalRef: ghUrl,
        dryRun: false,
        exitCode: 1,
        message: `GitHub issue at ${ghUrl} linked to ${bdId} but the issue number could not be extracted; the bd↔GH link is durable, the pointer comment is informational`,
      },
    };
  }
  const commentResult: GhExecResult = ghExec(
    {
      group: "issue",
      subcommand: "comment",
      args: [
        String(ghIssueNumber),
        "--body",
        `Published from beads record ${bdId}.`,
        "--repo",
        repo,
      ],
      state: "planning",
      role: "executor",
    },
    processEnv(),
  );
  if (commentResult.exitCode !== 0) {
    const detail =
      commentResult.stderr.trim() || commentResult.stdout.trim() || "gh issue comment failed";
    return {
      exitCode: 1,
      outcome: "partial-error",
      bdId,
      externalRef: ghUrl,
      render: {
        bdId,
        repo,
        title: target.title,
        outcome: "partial-error",
        externalRef: ghUrl,
        dryRun: false,
        exitCode: 1,
        message: `GitHub issue at ${ghUrl} linked to ${bdId} but gh issue comment failed (${detail}); the bd↔GH link is durable, the pointer comment is informational`,
      },
    };
  }

  return {
    exitCode: 0,
    outcome: "created",
    bdId,
    externalRef: ghUrl,
    render: {
      bdId,
      repo,
      title: target.title,
      outcome: "created",
      externalRef: ghUrl,
      dryRun: false,
      exitCode: 0,
    },
  };
}

export function formatBeadsPublishRender(
  render: BeadsPublishRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        bdId: render.bdId,
        ...(render.repo ? { repo: render.repo } : {}),
        ...(render.title ? { title: render.title } : {}),
        outcome: render.outcome,
        ...(render.externalRef ? { externalRef: render.externalRef } : {}),
        ...(render.ghCreate ? { ghCreate: render.ghCreate } : {}),
        dryRun: render.dryRun,
        exitCode: render.exitCode,
        ...(render.message ? { message: render.message } : {}),
      },
      null,
      2,
    );
  }
  if (render.outcome === "error" || render.outcome === "partial-error") {
    return render.message ?? `prx beads publish: ${render.outcome}`;
  }
  if (render.dryRun && render.ghCreate) {
    return [
      "prx beads publish (dry-run)",
      `  bd:        ${render.bdId}`,
      `  repo:      ${render.repo}`,
      `  title:     ${render.title}`,
      `  would run:`,
      `    ${renderGhArgv(render.ghCreate.argv)}`,
    ].join("\n");
  }
  const link = render.externalRef ? `${render.bdId} → ${render.externalRef}` : render.bdId;
  return render.message ? `${link}  (${render.message})` : link;
}

export function runBeadsPublish(
  opts: BeadsPublishOptions,
  output: Output,
  deps: BeadsPublishDeps = {},
): number {
  const result = publishOne(opts, deps);
  const formatted = formatBeadsPublishRender(result.render, opts.format);
  if (result.exitCode === 0) {
    output.log(formatted);
  } else {
    output.error(formatted);
  }
  return result.exitCode;
}

export function runBeadsPublishUnit(
  opts: BeadsPublishOptions,
  deps: BeadsPublishDeps = {},
): BeadsPublishUnitResult {
  const result = publishOne(opts, deps);
  return {
    exitCode: result.exitCode,
    outcome: result.outcome,
    bdId: result.bdId,
    ...(result.externalRef ? { externalRef: result.externalRef } : {}),
  };
}
