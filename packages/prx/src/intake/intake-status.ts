// `prx intake status` (GH-1218 PR-B) — read-only listing of GH↔beads
// contract gaps from the **intake** angle, complementing `prx triage status`.
//
// Where triage's untriaged report flags issues missing scored
// priority/type/beads-link labels, intake's untriaged report is purely the
// "no beads row at all" set-difference: open GH issues that intake hasn't yet
// promoted into the bd queue. Reverse-orphan and drift sections mirror
// triage-status verbatim — both intake and triage view the same parity gap,
// just starting from opposite endpoints.
//
// Like triage-status, intake-status sits upstream of the parity chain and
// emits no XState events. This module only reads.

import { z } from "zod";

import { execBd } from "@bounded-systems/bd";
import {
  listOpenIssues as defaultListOpenIssues,
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
import {
  estimateSweepCost as defaultEstimateSweepCost,
  formatBudgetBlock,
  refreshBudget as defaultRefreshBudget,
  type BudgetSnapshot,
  type SweepCostEstimate,
} from "@bounded-systems/github-budget";
import {
  findDrift,
  findReverseOrphans,
  indexBeadsByIssueNumber,
  loadAllBeads as defaultLoadAllBeads,
  type DriftRow,
  type ReverseOrphanRow,
} from "../triage/triage.ts";

export const intakeStatusOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  format: z.enum(["plain", "json"]).default("plain"),
  limit: z.number().int().min(0).default(0),
  includeIntentional: z.boolean().default(false),
  rateLimit: z.boolean().default(false),
});

export type IntakeStatusOptions = z.infer<typeof intakeStatusOptionsSchema>;

export type IntakeUntriagedRow = {
  number: number;
  title: string;
  url: string;
  labels: string[];
};

export type IntakeStatusResult = {
  repo: string;
  totalOpen: number;
  totalUntriaged: number;
  totalReverseOrphans: number;
  totalDrift: number;
  untriaged: IntakeUntriagedRow[];
  reverseOrphans: ReverseOrphanRow[];
  drift: DriftRow[];
  rateLimit?: {
    snapshots: BudgetSnapshot[];
    estimate: SweepCostEstimate;
  };
};

export type IntakeStatusDeps = {
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  execBd?: typeof execBd;
  cwd?: () => string;
  refreshBudget?: typeof defaultRefreshBudget;
  estimateSweepCost?: typeof defaultEstimateSweepCost;
  /**
   * GH-1595 — read-only consumer of the per-invocation `BeadsCache`. When
   * wired (production), shares the canonical `bd list` read with every other
   * `loadAllBeads`-shaped caller in this process. Missing on test paths uses
   * the uncached default.
   */
  loadAllBeads?: typeof defaultLoadAllBeads;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function classifyIntakeUntriaged(
  issue: FallbackIssue,
  beadsByNumber: Map<number, unknown>,
): IntakeUntriagedRow | null {
  if (beadsByNumber.has(issue.number)) return null;
  const labelNames = (issue.labels ?? [])
    .map((label) => label?.name)
    .filter((name): name is string => typeof name === "string");
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: labelNames,
  };
}

function attachRateLimit(
  base: IntakeStatusResult,
  opts: IntakeStatusOptions,
  deps: IntakeStatusDeps,
): IntakeStatusResult {
  if (!opts.rateLimit) return base;
  const refresh = deps.refreshBudget ?? defaultRefreshBudget;
  const estimate = deps.estimateSweepCost ?? defaultEstimateSweepCost;
  const queueSize =
    base.totalUntriaged + base.totalReverseOrphans + base.totalDrift;
  const snapshots = refresh() ?? [];
  return {
    ...base,
    rateLimit: {
      snapshots,
      estimate: estimate(queueSize),
    },
  };
}

export function runIntakeStatus(
  opts: IntakeStatusOptions,
  output: Output,
  deps: IntakeStatusDeps = {},
): number {
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const bdExec = deps.execBd ?? execBd;
  const loadBeads = deps.loadAllBeads ?? defaultLoadAllBeads;
  const cwd = (deps.cwd ?? process.cwd)();

  const repo = opts.repo ?? resolveRepo(cwd);
  const ghLimit = opts.limit > 0 ? opts.limit : 1000;
  const openIssues = listIssues(repo, ghLimit);
  const allBeads = loadBeads(bdExec);
  const beadsByNumber = indexBeadsByIssueNumber(allBeads);

  const untriaged: IntakeUntriagedRow[] = [];
  for (const issue of openIssues) {
    const row = classifyIntakeUntriaged(issue, beadsByNumber);
    if (row) untriaged.push(row);
  }

  const reverseOrphans = findReverseOrphans(allBeads, opts.includeIntentional);
  const drift = findDrift(allBeads, openIssues);

  const base: IntakeStatusResult = {
    repo,
    totalOpen: openIssues.length,
    totalUntriaged: untriaged.length,
    totalReverseOrphans: reverseOrphans.length,
    totalDrift: drift.length,
    untriaged,
    reverseOrphans,
    drift,
  };
  const result = attachRateLimit(base, opts, deps);

  output.log(formatIntakeStatus(result, opts.format));
  return 0;
}

function padEnd(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

export function formatIntakeStatus(
  result: IntakeStatusResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (
    result.totalUntriaged === 0
    && result.totalReverseOrphans === 0
    && result.totalDrift === 0
  ) {
    const head = `All ${result.totalOpen} open issues in ${result.repo} have a beads row with no reverse orphans or pair drift.`;
    return appendRateLimitBlock(head, result.rateLimit);
  }

  const lines: string[] = [];
  lines.push(
    `${result.totalUntriaged} unfiled · ${result.totalReverseOrphans} reverse-orphan · ${result.totalDrift} drift in ${result.repo} (${result.totalOpen} open).`,
  );

  if (result.untriaged.length > 0) {
    lines.push("");
    lines.push(`Unfiled (${result.untriaged.length}):`);
    const idCol = Math.max(...result.untriaged.map((row) => `GH-${row.number}`.length), 5);
    const titleCol = 60;
    for (const row of result.untriaged) {
      const id = padEnd(`GH-${row.number}`, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      lines.push(`  ${id}  ${title}`);
    }
  }

  if (result.reverseOrphans.length > 0) {
    lines.push("");
    lines.push(`Reverse Orphans (${result.reverseOrphans.length}):`);
    const idCol = Math.max(...result.reverseOrphans.map((row) => row.beadsId.length), 8);
    const titleCol = 60;
    for (const row of result.reverseOrphans) {
      const id = padEnd(row.beadsId, idCol);
      const title = padEnd(truncate(row.title, titleCol), titleCol);
      const tag = `${row.issueType || "?"}/${row.priority}`;
      lines.push(`  ${id}  ${title}  [${tag}]`);
    }
  }

  if (result.drift.length > 0) {
    lines.push("");
    lines.push(`Drift (${result.drift.length}):`);
    for (const row of result.drift) {
      const fieldNames = Object.keys(row.fields).join(", ");
      lines.push(`  GH-${row.issueNumber} ↔ ${row.beadsId}  [${fieldNames}]`);
      for (const [name, pair] of Object.entries(row.fields)) {
        if (!pair) continue;
        const gh = pair.gh === null ? "—" : String(pair.gh);
        const bd = pair.bd === null ? "—" : String(pair.bd);
        lines.push(`      ${name}: gh=${JSON.stringify(gh)}  bd=${JSON.stringify(bd)}`);
      }
    }
  }

  return appendRateLimitBlock(lines.join("\n"), result.rateLimit);
}

function appendRateLimitBlock(
  body: string,
  rateLimit: IntakeStatusResult["rateLimit"],
): string {
  if (!rateLimit) return body;
  const block = formatBudgetBlock(rateLimit.snapshots, rateLimit.estimate);
  return body.length > 0 ? `${body}\n\n${block}` : block;
}
