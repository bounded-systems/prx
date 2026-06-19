// `prx triage classify` (GH-919) — pure-function classifier that maps GH
// issue titles to optional (type, priority, area, effort) labels using
// per-axis rule tables. No I/O. Output is validated against label-vocab.ts
// so a classifier rule change cannot emit a label outside the vocabulary.
//
// Per-axis independence (GH-952): each axis emits a value only when a rule
// fires for that axis. There are no cross-axis defaults — a matched type
// rule does not derive priority or effort. An unmatched axis is left
// undefined so that `apply` preserves operator-curated labels there.

import { z } from "zod";

import {
  bdLabelPlanSchema,
  labelPlanSchema,
  proposedLabelsFor,
  type AreaLabel,
  type BdLabelPlan,
  type BdLabelPlanRow,
  type EffortLabel,
  type LabelPlan,
  type LabelPlanRow,
  type PriorityLabel,
  type TypeConfidence,
  type TypeLabel,
} from "./label-vocab.ts";
import {
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
// GH-1602: substitute the gh-side `listOpenIssues` with the bd-resident
// projection. `pruneMergedActor` syncs bd from GH at the head of every triage
// pass, so the classifier's queue enumeration is substrate-resident now.
import { listOpenIssuesFromBeads as defaultListOpenIssues } from "./issues-from-beads.ts";
import {
  formatBudgetResetTime,
  refreshBudget as defaultRefreshBudget,
  type BudgetSnapshot,
} from "@bounded-systems/github-budget";
// GH-1710: bd-canonical branch reads beads directly and resolves canonical
// from the per-repo inventory entry.
import { join } from "node:path";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { bdPriorityToLabel, loadTriageScopedBeads } from "./triage.ts";
import { localRepoForCwd as defaultLocalRepoForCwd, repoCanonical } from "../pr-state/repos.ts";

export const triageClassifyOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  format: z.enum(["json", "tsv"]).default("json"),
  limit: z.number().int().min(0).default(0),
  from: z.string().trim().min(1).optional(),
  requireBudget: z.number().int().min(0).optional(),
});

export type TriageClassifyOptions = z.infer<typeof triageClassifyOptionsSchema>;

export type ReadTextFile = (path: string, encoding: "utf8") => string;

export type TriageClassifyDeps = {
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  cwd?: () => string;
  now?: () => Date;
  readFileSync?: ReadTextFile;
  refreshBudget?: typeof defaultRefreshBudget;
  /**
   * GH-1710 — canonical-axis branch and bd-side substrate read. Injectable
   * so tests can synthesize a canonical=bd repo without writing a real
   * inventory index.
   */
  localRepoForCwd?: typeof defaultLocalRepoForCwd;
  execBd?: typeof defaultExecBd;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

// Type rules — first match wins. Rule fire ⇒ `typeConfidence: "scored"`;
// no rule ⇒ unscored fallback `type::task` + `typeConfidence: "unscored"`
// (GH-988). The fallback closes the GH-988 demand: ~27% of titled issues
// (task/spike-shaped or generic) left `type` undefined under the old policy,
// which made `prx triage promote` skip them as `skip:missing-labels`. The
// fallback is the type-axis mirror of the GH-970 `priority::none` sentinel —
// it tags "no scored decision yet", not "operator decided task".
//
// At the specificity layer, ambiguous verbs like "Document …", "Define …",
// "Audit …" and decision/adr titles still fall through to the fallback
// rather than firing a guessed `feature`/`bug` — under-fire stays safer
// than mis-stamping the long tail.
//
// `spike[(:]` matches in the table to the bd-axis type `task` (per beads's
// `typeMapping`), and `classifyTitle` additionally sets the GH-only
// `spike: true` side-output so `proposedLabelsFor` projects `type::spike`
// alongside `type::task`. See GH-1489 for the dual-label convention.
const TYPE_RULES: Array<[RegExp, TypeLabel]> = [
  [/^\[epic\]/i, "epic"],
  [/^M\d+:/, "epic"],
  [/^(bug|fix)[(:]/i, "bug"],
  [/^(refactor|migrate|move)[(: ]/i, "chore"],
  [/^chore[(:]/i, "chore"],
  [/^(bump|upgrade) /i, "chore"],
  [/^(feat|feature)[(:]/i, "feature"],
  [/^(add|enable|adopt|implement) /i, "feature"],
  [/^task[(:]/i, "task"],
  [/^spike[(:]/i, "task"],
];

// Area rules — first match wins; matched against the full title (case-insensitive).
// More-specific patterns appear before broader fallbacks. When no rule fires
// the classifier leaves `area` unset rather than guessing.
const AREA_RULES: Array<[RegExp, AreaLabel]> = [
  [/\bclaude[- ]code\b/i, "claude-code"],
  [/\bhome[- ]manager\b|\bnix\b/i, "home-manager"],
  [/\bnotion\b/i, "notion"],
  [/\bwarp(ify)?\b|block[- ]friendly/i, "warp"],
  [/\btmux\b/i, "tmux"],
  [/\b(tui|ink)\b/i, "tui"],
  [/\bbeads?\b|`bd[ `:]|^bd[ :(]/i, "beads"],
  [/\b(ci|github actions)\b|workflow run/i, "ci"],
  [/\bprx\b|triage|parity|worktree|chain|session|intake/i, "prx"],
];

export type PriorityConfidence = "unscored" | "scored" | "operator";
export { type TypeConfidence } from "./label-vocab.ts";

export function classifyTitle(title: string): {
  type: TypeLabel;
  typeConfidence: TypeConfidence;
  priority?: PriorityLabel;
  priorityConfidence?: PriorityConfidence;
  area?: AreaLabel;
  effort?: EffortLabel;
  spike?: boolean;
} {
  const trimmed = title.trim();
  // GH-988: type axis is the symmetric mirror of the GH-970 priority sentinel.
  // A matching TYPE_RULES arm sets scored; no match falls back to the
  // unscored sentinel `type::task`. Apply's `hasType` gate excludes
  // `type::task` (the sentinel) so a future scored emission strip-replaces it.
  let type: TypeLabel = "task";
  let typeConfidence: TypeConfidence = "unscored";
  let spike = false;
  for (const [pattern, candidate] of TYPE_RULES) {
    if (pattern.test(trimmed)) {
      type = candidate;
      typeConfidence = "scored";
      // GH-988 + GH-1489: spike-prefixed titles set the GH-only marker bit
      // alongside the bd-axis `task` rule fire. `proposedLabelsFor`
      // projects `type::spike` next to `type::task`.
      if (/^spike[(:]/i.test(trimmed)) spike = true;
      break;
    }
  }
  let area: AreaLabel | undefined;
  for (const [pattern, candidate] of AREA_RULES) {
    if (pattern.test(trimmed)) {
      area = candidate;
      break;
    }
  }
  // GH-970: priority axis has no scored rules yet, so every issue gets the
  // explicit unscored marker `priority::none` with `priorityConfidence:
  // "unscored"`. Apply preserves operator-set priority via the existing
  // GH-957 hasPriority gate (label-vocab.ts:108-116) — a defaulted none
  // does not strip an operator's priority::high. When future tickets add
  // scored priority rules, set `priority` + `priorityConfidence: "scored"`
  // before this fallback fires. Effort axis stays undefined per GH-952.
  const result: {
    type: TypeLabel;
    typeConfidence: TypeConfidence;
    priority?: PriorityLabel;
    priorityConfidence?: PriorityConfidence;
    area?: AreaLabel;
    effort?: EffortLabel;
    spike?: boolean;
  } = {
    type,
    typeConfidence,
    priority: "none",
    priorityConfidence: "unscored",
  };
  if (area !== undefined) result.area = area;
  if (spike) result.spike = true;
  return result;
}

export function classifyIssueRow(issue: FallbackIssue): LabelPlanRow {
  const { type, typeConfidence, priority, priorityConfidence, area, effort, spike } = classifyTitle(
    issue.title,
  );
  const currentLabels = (issue.labels ?? [])
    .map((label) => label?.name)
    .filter((name): name is string => typeof name === "string");
  // GH-988 + GH-1489: legacy spike-only issues (those carrying `type::spike`
  // without a paired BD_TYPE_ENUM `type::*` label) need the marker preserved
  // when the classifier brings them up to the modern dual-label shape.
  // `proposedLabelsFor` projects `type::spike` whenever `row.spike` is true.
  const labelDrivenSpike = currentLabels.includes("type::spike");
  const row: LabelPlanRow = {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    currentLabels,
    type,
    typeConfidence,
  };
  if (priority !== undefined) row.priority = priority;
  if (priorityConfidence !== undefined) row.priorityConfidence = priorityConfidence;
  if (area !== undefined) row.area = area;
  if (effort !== undefined) row.effort = effort;
  if (spike === true || labelDrivenSpike) row.spike = true;
  return row;
}

export function classifyQueue(
  issues: FallbackIssue[],
  repo: string,
  generatedAt: string,
): LabelPlan {
  const rows = issues.map(classifyIssueRow);
  return labelPlanSchema.parse({ repo, generatedAt, rows });
}

// GH-1710: bd-canonical classifier row. The bd substrate stores priority as
// a numeric field (0..3 or null) and type as a string column — there are no
// `priority::*` / `type::*` labels on a bd record. We classify by title (same
// rule table as GH) and emit a proposed-axes row only at axes the bead is
// missing on, so apply (a future PR) can build a single `bd update <id>`
// mutation per row without overwriting operator-curated state.
export type BdRecordForClassify = {
  id: string;
  title: string;
  priority: number | null;
  issueType: string;
};

export function classifyBdRecord(record: BdRecordForClassify): BdLabelPlanRow {
  const { type, typeConfidence, priority, priorityConfidence, area, effort } = classifyTitle(
    record.title,
  );
  const hasPriority = record.priority !== null;
  const hasType = record.issueType.length > 0;
  const row: BdLabelPlanRow = {
    bdId: record.id,
    title: record.title,
    currentPriority: record.priority,
    currentType: record.issueType,
  };
  // GH-957 mirror: classifier output is suppressed at any axis the bead has
  // already taken a value on. Apply path stays additive. GH-988: when the
  // bead has no type yet, plumb both the fallback `task` value and the
  // `typeConfidence` provenance bit so the bd-apply path can distinguish
  // scored matches from the unscored sentinel.
  if (!hasType) {
    row.type = type;
    row.typeConfidence = typeConfidence;
  }
  if (priority !== undefined && !hasPriority) row.priority = priority;
  if (priorityConfidence !== undefined && !hasPriority) row.priorityConfidence = priorityConfidence;
  if (area !== undefined) row.area = area;
  if (effort !== undefined) row.effort = effort;
  return row;
}

export function classifyBdQueue(
  records: BdRecordForClassify[],
  repo: string,
  generatedAt: string,
): BdLabelPlan {
  const rows = records.map(classifyBdRecord);
  return bdLabelPlanSchema.parse({ repo, canonical: "bd", generatedAt, rows });
}

export function formatBdLabelPlan(plan: BdLabelPlan, format: "json" | "tsv"): string {
  if (format === "json") {
    return JSON.stringify(plan, null, 2);
  }
  const lines: string[] = [];
  lines.push(["#repo", plan.repo].join("\t"));
  lines.push(["#canonical", plan.canonical].join("\t"));
  lines.push(["#generatedAt", plan.generatedAt].join("\t"));
  lines.push(
    [
      "bdId",
      "type",
      "priority",
      "area",
      "effort",
      "current_priority",
      "current_type",
      "title",
    ].join("\t"),
  );
  for (const row of plan.rows) {
    lines.push(
      [
        row.bdId,
        row.type ?? "",
        row.priority ?? "",
        row.area ?? "",
        row.effort ?? "",
        bdPriorityToLabel(row.currentPriority),
        row.currentType,
        row.title,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

export function formatLabelPlan(plan: LabelPlan, format: "json" | "tsv"): string {
  if (format === "json") {
    return JSON.stringify(plan, null, 2);
  }
  // TSV: number<TAB>type<TAB>priority<TAB>area<TAB>effort<TAB>proposed_labels<TAB>title
  const lines: string[] = [];
  lines.push(["#repo", plan.repo].join("\t"));
  lines.push(["#generatedAt", plan.generatedAt].join("\t"));
  lines.push(["number", "type", "priority", "area", "effort", "proposed", "title"].join("\t"));
  for (const row of plan.rows) {
    const proposed = proposedLabelsFor(row).join(",");
    lines.push(
      [
        row.number,
        row.type ?? "",
        row.priority ?? "",
        row.area ?? "",
        row.effort ?? "",
        proposed,
        row.title,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

/**
 * Actor-shaped entry for `prx triage classify`. Returns the typed
 * LabelPlan plus captured stdout/stderr. Mirrors `runStatusActor` shape so
 * the machine can treat all read-only verbs uniformly.
 */
export type TriageClassifyActorResult = {
  exitCode: number;
  plan: LabelPlan | null;
  stdout: string[];
  stderr: string[];
};

export function runClassifyActor(
  opts: TriageClassifyOptions,
  deps: TriageClassifyDeps = {},
): TriageClassifyActorResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captureOutput: Output = {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };

  // Force JSON format inside the actor so we can parse the plan back out.
  // The CLI's --format=tsv is irrelevant to the machine — the machine wants
  // a typed object, not a TSV string.
  const exitCode = runTriageClassify({ ...opts, format: "json" }, captureOutput, deps);
  let plan: LabelPlan | null = null;
  if (exitCode === 0 && stdout.length > 0) {
    try {
      const parsed = JSON.parse(stdout.join("\n"));
      plan = labelPlanSchema.parse(parsed);
    } catch {
      plan = null;
    }
  }
  return { exitCode, plan, stdout, stderr };
}

export function runTriageClassify(
  opts: TriageClassifyOptions,
  output: Output,
  deps: TriageClassifyDeps = {},
): number {
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();

  // GH-1710: canonical=bd branches before the budget gate. There is no GH
  // queue to read and no GH bucket to spend, so `--require-budget` is
  // categorically inapplicable. `--from` is also bypassed for bd — the
  // file-mode shape is GH-side LabelPlan-shaped and would not deserialize a
  // bd-flavored payload sensibly.
  const localRepo = (deps.localRepoForCwd ?? defaultLocalRepoForCwd)(cwd);
  if (localRepo && repoCanonical(localRepo) === "bd") {
    const bdExec = deps.execBd ?? defaultExecBd;
    const allBeads = loadTriageScopedBeads(join(cwd, ".beads"), bdExec, output.error);
    let bdRecords = allBeads
      .filter((b) => b.status !== "closed")
      .filter((b) => b.priority === null || b.priority === undefined || !b.issueType);
    if (opts.limit > 0 && bdRecords.length > opts.limit) {
      bdRecords = bdRecords.slice(0, opts.limit);
    }
    const repo =
      opts.repo ?? localRepo.primaryRemote?.githubRepo ?? localRepo.name ?? "<bd-canonical>";
    const plan = classifyBdQueue(
      bdRecords.map((b) => ({
        id: b.id,
        title: b.title,
        priority: b.priority,
        issueType: b.issueType,
      })),
      repo,
      generatedAt,
    );
    output.log(formatBdLabelPlan(plan, opts.format));
    return 0;
  }

  // GH-1218 PR-C: pre-flight GraphQL budget gate. When --require-budget is
  // set, refresh the rate-limit snapshot once and bail before any sweep
  // touches the GraphQL bucket. Skipped when --from is set (file-mode reads
  // no GH). Fails closed when the snapshot can't be fetched or parsed (a
  // safety gate that silently passes is worse than a noisy false negative —
  // Copilot review on PR #1278).
  if (opts.requireBudget !== undefined && !opts.from) {
    const refresh = deps.refreshBudget ?? defaultRefreshBudget;
    const snapshots = refresh();
    if (snapshots === null) {
      output.error(
        "triage classify: --require-budget set but `gh api rate_limit` failed; refusing to start.\n  Re-run after `gh auth status` is healthy, or drop --require-budget to bypass.",
      );
      return 1;
    }
    const graphql = snapshots.find((s) => s.bucket === "graphql");
    if (!graphql) {
      output.error(
        "triage classify: --require-budget set but rate-limit response had no graphql bucket; refusing to start.",
      );
      return 1;
    }
    if (graphql.remaining < opts.requireBudget) {
      output.error(formatBudgetGateError(graphql, opts.requireBudget, now));
      return 1;
    }
  }

  let issues: FallbackIssue[];
  let repo: string;

  if (opts.from) {
    const reader =
      deps.readFileSync ??
      ((path: string, encoding: "utf8") => {
        // Lazy-require to keep the module importable in test environments
        // that pass `readFileSync` as a dep.
        const fs = require("node:fs") as typeof import("node:fs");
        return fs.readFileSync(path, encoding);
      });
    const raw = reader(opts.from, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      output.error(`triage classify: --from file is not valid JSON: ${opts.from}`);
      return 1;
    }
    // Accept either a TriageStatusResult-shaped JSON (issues field) or a bare
    // array of FallbackIssue.
    if (Array.isArray(parsed)) {
      issues = parsed as FallbackIssue[];
      repo = opts.repo ?? resolveRepo(cwd);
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.issues)) {
        issues = (obj.issues as FallbackIssue[]).map((row) => ({
          number: row.number,
          title: row.title,
          url: row.url,
          labels: row.labels ?? [],
        }));
        repo =
          opts.repo ??
          (typeof obj.repo === "string" && obj.repo.length > 0 ? obj.repo : resolveRepo(cwd));
      } else {
        output.error(`triage classify: --from file has no 'issues' array`);
        return 1;
      }
    } else {
      output.error(`triage classify: --from file must be JSON array or object`);
      return 1;
    }
  } else {
    repo = opts.repo ?? resolveRepo(cwd);
    const ghLimit = opts.limit > 0 ? opts.limit : 1000;
    issues = listIssues(repo, ghLimit);
  }

  if (opts.limit > 0 && issues.length > opts.limit) {
    issues = issues.slice(0, opts.limit);
  }

  const plan = classifyQueue(issues, repo, generatedAt);
  output.log(formatLabelPlan(plan, opts.format));
  return 0;
}

function formatBudgetGateError(snapshot: BudgetSnapshot, required: number, now: Date): string {
  const reset = formatBudgetResetTime(snapshot.resetAt);
  const deltaMs = Math.max(0, snapshot.resetAt - now.getTime());
  const totalSeconds = Math.ceil(deltaMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const inWindow = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const lines = [
    "triage classify: GraphQL budget below threshold",
    `  remaining: ${snapshot.remaining} / required: ${required}`,
    `  resets:    ${reset} (in ${inWindow})`,
    "Wait for reset, mint a second token (PRX_GITHUB_TOKEN, see GH-1138),",
    "or set PRX_REST_LITE=1 to skip GraphQL enrichment.",
  ];
  return lines.join("\n");
}
