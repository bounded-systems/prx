// `prx triage prioritize-bulk` (GH-1047) — Haiku-backed bulk priority verb.
//
// Sibling of `prx triage prioritize` (GH-980, interactive) on the priority
// axis. Walks the same `priority::none || no-priority-axis` queue produced by
// `selectCandidates`, but instead of one operator prompt per row, slices the
// queue into batches of `--batch-size` and asks Haiku 4.5 for a JSON array of
// `{number, decision, confidence}` per batch. Decisions land via the wrapped
// `execGh` surface, one atomic `gh issue edit` per row, with
// `--add-label priority::<choice>` and (when `priority::none` is present)
// `--remove-label priority::none`.
//
// Memory trail:
//   - `feedback_bulk_ops_via_prx` — bulk ops belong in prx verbs, not raw gh
//     loops; this file is the verb that captures the validated 2026-04-29
//     hand-rolled flow.
//   - `feedback_beads_github_authority` — chains `bd github sync --pull-only
//     --prefer-github` after writes (parity with prioritize/apply).
//   - `reference_zod_boundary_layer` — Zod parses Haiku's JSON output and each
//     emitted audit row; in-memory types stay TS structs.
//
// Schema boundary contracts:
//   - Input: `triagePrioritizeBulkOptionsSchema` (schemas/input.ts).
//   - Audit row: `prioritizeBulkAuditRowSchema` (schemas/audit.ts) — every
//     emitted row is parsed before append.

import { processEnv } from "@bounded-systems/env";
import { buildTriageHaikuClassifierRuntimeProfile } from "../machine/runtime_profiles.ts";
import { agentProfileExecutionAsRuntimeResult, executeAgentProfile } from "../pr-state/executor.ts";

import { z } from "zod";

import {
  listOpenIssues as defaultListOpenIssues,
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
// GH-1012: bd removed. GitHub is the write plane and the queue is enumerated
// directly off `gh issue list` via the gh-side `listOpenIssues` (same
// `FallbackIssue[]` shape and `(repo, limit)` call signature the retired
// bd-resident projection provided).
import { parseLabelName } from "./labels.ts";
import { PRIORITY_LABELS, priorityLabelString } from "./label-vocab.ts";
import { execGh as defaultExecGh, type GhExecResult } from "@bounded-systems/gh";
import { runBeadsSync as defaultRunBeadsSync, type BeadsSyncResult } from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import { parseClaudeJsonEnvelope } from "../claude/envelope.ts";
import { stripCodeFence } from "../claude/strip-code-fence.ts";
import { readBlob as defaultReadBlob, writeBlob as defaultWriteBlob } from "../plan-store/cas.ts";
import { casUriFor } from "../plan-store/uri.ts";
import {
  triagePrioritizeBulkOptionsSchema,
  type TriagePrioritizeBulkOptions,
  prioritizeBulkAuditRowSchema,
  type PrioritizeBulkAuditRow,
} from "./schemas/index.ts";
import { appendAuditRow, auditSinkPath, type AuditSinkDeps } from "../audit/sink.ts";

export { triagePrioritizeBulkOptionsSchema };
export type { TriagePrioritizeBulkOptions };

export type PriorityChoice = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";

export type Candidate = {
  number: number;
  title: string;
  url: string;
  currentLabels: string[];
  hasPriorityNone: boolean;
};

/**
 * Validated heuristic system prompt from the GH-1047 ticket body (2026-04-29
 * end-to-end run: 214 rows, 8 batches, ~$0.36, 100% schema-valid). Exported so
 * tests can golden-check it; not wired through `--system-prompt` overrides
 * because the validated prompt is what justifies the verb existing as
 * separate from the interactive sibling.
 */
export const BULK_PRIORITY_SYSTEM_PROMPT = `You are classifying GitHub issues by priority for a software project. \
Reply with ONLY a JSON array. No prose, no markdown, no commentary.

Each input issue has {number, title, currentLabels}. For each, output \
{number, decision, confidence} where:
- decision ∈ {"critical", "high", "medium", "low"}
- confidence ∈ {"high", "medium", "low"}

Priority vocabulary:
- critical: active production blocker, security/data-integrity risk, foundational tooling
- high: operator-surface UX bugs, missing flags / wrappers, integration gaps, high-leverage refactors
- medium: legitimate bugs/tasks with no active blockage (default-when-uncertain)
- low: polish, edge-case bugs, nice-to-haves, deprecated cleanups, speculative items

Rules:
1. Epics ([epic], M<N>:) → critical or high (foundational vs cleanup)
2. Spikes (research/explore) → medium (unless on foundational critical path)
3. TUI/UI polish bugs → low (TUI not daily surface yet)
4. "remove deprecated" / "normalize legacy" / "upstream PR" → low or medium
5. Active-blocker phrasing → high or critical
6. Tooling foundations → critical or high
7. Uncertain medium-vs-high → prefer medium (don't inflate)
8. Uncertain low-vs-medium → prefer medium for genuine work; low only for polish/speculative

Output: a JSON array of {number, decision, confidence} objects, one per input issue, same length, same numbers.`;

// ── Haiku wire format ──────────────────────────────────────────────────────
//
// `claude -p --output-format json` returns either:
//   - a wrapper object { type: "result", result: "<model text>", ... }, or
//   - a stream-JSON array whose terminal element is the same result event.
// Envelope decoding routes through `parseClaudeJsonEnvelope` (GH-1095). Inner
// `result` is the model's stdout — for this verb, a JSON array of decisions.

const haikuDecisionSchema = z.object({
  number: z.number().int().positive(),
  decision: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const haikuResponseSchema = z.array(haikuDecisionSchema);

export type HaikuDecision = z.infer<typeof haikuDecisionSchema>;

// ── deps + result types ────────────────────────────────────────────────────

export type ClaudeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ClaudeRunner = (args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) => ClaudeRunResult | Promise<ClaudeRunResult>;

// GH-1384 — the candidate batch is the classifier's input *material*, so it is
// content-addressed: written to the `scout://` CAS domain (yielding a
// `scout://sha256:<hex>` handle) and re-read on demand before dispatch. The
// orchestrator owns both ends — it writes the batch and re-reads its own blob —
// so the handle becomes an attestable provenance record without granting the
// sealed Haiku classifier any CAS-read tool surface (it stays prompt-in /
// JSON-out). The bytes round-tripped out of CAS are what reach the model, so
// the validated GH-1047 input shape (a raw `{number,title,currentLabels}[]`
// JSON array) is preserved exactly.
const SCOUT_DOMAIN = "scout";

export type CasPort = {
  writeBlob: typeof defaultWriteBlob;
  readBlob: typeof defaultReadBlob;
};

const defaultCasPort: CasPort = {
  writeBlob: defaultWriteBlob,
  readBlob: defaultReadBlob,
};

// GH-1828 pattern (mirrors type-pass.ts): the batch classifier routes through
// the Anthropic Agent SDK via `executeAgentProfile` instead of a direct
// `claude -p` subprocess piped on stdin. The batch (the former stdin payload)
// is carried as the profile's userPrompt, so the prompt lives in the SDK's
// run envelope rather than a raw pipe — no stdin, no raw spawn. The
// `--output-format json` envelope shape is preserved, so `parseClaudeJson-
// Envelope` downstream is unchanged.
export const defaultClaudeRunner: ClaudeRunner = async ({ model, systemPrompt, userPrompt }) => {
  const profile = buildTriageHaikuClassifierRuntimeProfile({
    model,
    systemPrompt,
    userPrompt,
  });
  const dispatched = await executeAgentProfile(profile, {
    cwd: process.cwd(),
    format: "json",
  });
  const collapsed = agentProfileExecutionAsRuntimeResult(dispatched);
  return {
    exitCode: collapsed.status ?? 1,
    stdout: collapsed.stdout,
    stderr: collapsed.stderr,
  };
};

export type TriagePrioritizeBulkDeps = {
  execGh?: typeof defaultExecGh;
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  runClaude?: ClaudeRunner;
  /** GH-1384 — CAS port for materializing/re-reading the scout-domain batch. */
  cas?: CasPort;
  now?: () => Date;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1697: routed cwd from `prx triage prioritize-bulk --repo <slug>`.
   * Defaults to `process.cwd()`. Mirrors the convention in `triage.ts` /
   * `promote.ts`.
   */
  cwd?: () => string;
  /**
   * Canonical reconcile chained after label writes (GH-2316: replaces the
   * retired destructive bd-side reconcile shell-out; the sanctioned surface
   * is `prx sync issues --from gh --to bd`). Default delegates to
   * `defaultRunBeadsSync`.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
  /** Override the random batchId generator for deterministic tests. */
  generateBatchId?: (batchIndex: number) => string;
};

export type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type TriagePrioritizeBulkActorResult = {
  exitCode: number;
  audit: PrioritizeBulkAuditRow[];
  stdout: string[];
  stderr: string[];
  touchedIssues: number[];
  batchCount: number;
  totalCostUsd: number;
};

// ── pure helpers ───────────────────────────────────────────────────────────

/**
 * Lifts the priority-axis filter from `prioritize.ts:selectCandidates`. Same
 * idempotency contract — operator-set non-`none` priority labels are skipped
 * (GH-957 hasPriority gate). Stable ascending sort by issue number.
 */
export function selectCandidates(issues: FallbackIssue[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map((l) => l.name);
    let hasPriorityAny = false;
    let hasPriorityNone = false;
    for (const name of labels) {
      const parsed = parseLabelName(name);
      if (parsed.known && parsed.axis === "priority") {
        hasPriorityAny = true;
        if (parsed.value === "none") hasPriorityNone = true;
      }
    }
    const eligible = hasPriorityNone || !hasPriorityAny;
    if (!eligible) continue;
    candidates.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      currentLabels: labels,
      hasPriorityNone,
    });
  }
  candidates.sort((a, b) => a.number - b.number);
  return candidates;
}

export function chunkIntoBatches<T>(items: T[], batchSize: number): T[][] {
  if (batchSize <= 0) throw new Error(`batchSize must be positive, got ${batchSize}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

function defaultBatchId(index: number, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-b${index}`;
}

// ── Haiku call ─────────────────────────────────────────────────────────────

export type BatchInferenceResult = {
  decisions: HaikuDecision[];
  costUsd: number;
  batchId: string;
  /** `scout://sha256:<hex>` handle of the content-addressed input batch. */
  casHandle: string;
};

/**
 * Run a single Haiku batch. Throws on:
 *   - non-zero exit from the claude binary
 *   - non-JSON stdout
 *   - envelope that does not match `parseClaudeJsonEnvelope` (object or
 *     stream-array shape)
 *   - inner `result` that does not match `haikuResponseSchema`
 *
 * The orchestrator catches these and emits an `action: "error"` audit row.
 */
export async function runHaikuBatch(opts: {
  model: string;
  systemPrompt: string;
  batch: Candidate[];
  batchId: string;
  runClaude: ClaudeRunner;
  cas: CasPort;
}): Promise<BatchInferenceResult> {
  const batchJson = JSON.stringify(
    opts.batch.map((c) => ({
      number: c.number,
      title: c.title,
      currentLabels: c.currentLabels,
    })),
  );
  // Materialize the batch into the scout CAS domain, then re-read our own blob
  // so the bytes that reach the classifier are the ones the handle attests
  // (round-trip also verifies the stored sha via readBlob's integrity check).
  const { sha } = await opts.cas.writeBlob(batchJson, { domain: SCOUT_DOMAIN });
  const casHandle = casUriFor(SCOUT_DOMAIN, sha);
  const userPrompt = (await opts.cas.readBlob(sha, { domain: SCOUT_DOMAIN })).toString("utf8");
  const result = await opts.runClaude({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    userPrompt,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `claude exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const envelope = parseClaudeJsonEnvelope(result.stdout, "claude");
  const stripped = stripCodeFence(envelope.result.trim());
  let inner: unknown;
  try {
    inner = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`claude result field was not JSON: ${(err as Error).message}`);
  }
  const decisions = haikuResponseSchema.parse(inner);
  return {
    decisions,
    costUsd: envelope.costUsd ?? 0,
    batchId: opts.batchId,
    casHandle,
  };
}

// ── orchestrator ───────────────────────────────────────────────────────────

export async function runTriagePrioritizeBulk(
  opts: TriagePrioritizeBulkOptions,
  outputSink: Output,
  deps: TriagePrioritizeBulkDeps = {},
): Promise<number> {
  const exec = deps.execGh ?? defaultExecGh;
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const runClaude = deps.runClaude ?? defaultClaudeRunner;
  const cas = deps.cas ?? defaultCasPort;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: PrioritizeBulkAuditRow): void => appendAuditRow(entry, auditSink);
  const batchIdGen = deps.generateBatchId ?? ((i: number) => defaultBatchId(i, now));

  let repo = opts.repo;
  if (!repo) {
    try {
      repo = resolveRepo(cwd);
    } catch (err) {
      outputSink.error(`triage prioritize-bulk: failed to resolve repo: ${(err as Error).message}`);
      return 1;
    }
  }
  if (!repo) {
    outputSink.error("triage prioritize-bulk: --repo is required (could not resolve from cwd)");
    return 1;
  }

  const fetchLimit = opts.limit > 0 ? Math.max(opts.limit * 5, 50) : 200;
  const issues = listIssues(repo, fetchLimit);
  const allCandidates = selectCandidates(issues);
  const candidates = opts.limit > 0 ? allCandidates.slice(0, opts.limit) : allCandidates;

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  if (candidates.length === 0) {
    outputSink.log(
      `triage prioritize-bulk: no candidates (priority::none queue empty) log=${logPath}`,
    );
    return 0;
  }

  outputSink.log(
    `triage prioritize-bulk: ${candidates.length} candidate(s) in ${repo}, batchSize=${opts.batchSize}, model=${opts.model}${opts.dryRun ? " (dry-run)" : ""}`,
  );

  const batches = chunkIntoBatches(candidates, opts.batchSize);
  const candidateByNumber = new Map<number, Candidate>(candidates.map((c) => [c.number, c]));

  let writeErrors = 0;
  let inferenceErrors = 0;
  let decided = 0;
  let totalCostUsd = 0;
  const touchedIssues: number[] = [];
  const auditEntries: PrioritizeBulkAuditRow[] = [];

  function emit(row: PrioritizeBulkAuditRow): void {
    const validated = prioritizeBulkAuditRowSchema.parse(row);
    auditEntries.push(validated);
    append(validated);
  }

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const batchId = batchIdGen(i);
    let batchResult: BatchInferenceResult;
    try {
      batchResult = await runHaikuBatch({
        model: opts.model,
        systemPrompt: BULK_PRIORITY_SYSTEM_PROMPT,
        batch,
        batchId,
        runClaude,
        cas,
      });
    } catch (err) {
      inferenceErrors += 1;
      const message = (err as Error).message;
      outputSink.error(
        `triage prioritize-bulk: batch ${batchId} (${batch.length} rows) failed: ${message}`,
      );
      // Emit one error row per candidate in the batch so the audit log
      // captures which rows did not get a decision.
      for (const candidate of batch) {
        emit({
          ts: now.toISOString(),
          issue: candidate.number,
          url: candidate.url,
          title: candidate.title,
          currentLabels: candidate.currentLabels,
          model: opts.model,
          batchId,
          actor: "claude-code",
          dryRun: opts.dryRun,
          exitCode: 1,
          stderr: message,
        });
      }
      continue;
    }
    totalCostUsd += batchResult.costUsd;

    for (const decision of batchResult.decisions) {
      const candidate = candidateByNumber.get(decision.number);
      if (!candidate) {
        // Haiku returned a number not in the batch — record but skip.
        outputSink.error(
          `triage prioritize-bulk: batch ${batchId} returned unknown issue ${decision.number}`,
        );
        continue;
      }

      const addLabel = `priority::${decision.decision}`;
      // GH-1396: full-axis strip from canonical vocab. The narrow
      // `candidate.hasPriorityNone ? ["priority::none"] : []` form races with
      // `prx triage classify --apply` (GH-1487) when both run in the same
      // drain — `apply` upgrades `priority::none → priority::high` between
      // `listOpenIssues` and the bulk write, the snapshot still reads
      // `priority::none`, and the bulk write lands on top of the surviving
      // `priority::high`. Stripping every non-target priority label sourced
      // from `PRIORITY_LABELS` is race-free regardless of snapshot freshness;
      // `gh issue edit --remove-label` no-ops on absent labels.
      const removeLabels = PRIORITY_LABELS.map(priorityLabelString).filter((l) => l !== addLabel);

      if (opts.dryRun) {
        emit({
          ts: now.toISOString(),
          issue: candidate.number,
          url: candidate.url,
          title: candidate.title,
          currentLabels: candidate.currentLabels,
          decision: decision.decision,
          confidence: decision.confidence,
          model: opts.model,
          batchId,
          cost: batchResult.costUsd,
          casHandle: batchResult.casHandle,
          actor: "claude-code",
          dryRun: true,
          exitCode: 0,
        });
        decided += 1;
        const rems = removeLabels.length ? `-${removeLabels.join(",")} ` : "";
        outputSink.log(
          `dry-run GH-${candidate.number} ${rems}+${addLabel} (conf=${decision.confidence ?? "?"})`.trim(),
        );
        continue;
      }

      const args: string[] = [String(candidate.number), "--add-label", addLabel];
      if (removeLabels.length > 0) {
        args.push("--remove-label", removeLabels.join(","));
      }
      args.push("--repo", repo);

      const result: GhExecResult = exec(
        {
          group: "issue",
          subcommand: "edit",
          args,
          state: "planning",
          role: "executor",
        },
        processEnv(),
      );

      const ok = result.exitCode === 0;
      if (ok) {
        decided += 1;
        touchedIssues.push(candidate.number);
      } else {
        writeErrors += 1;
      }

      emit({
        ts: now.toISOString(),
        issue: candidate.number,
        url: candidate.url,
        title: candidate.title,
        currentLabels: candidate.currentLabels,
        decision: decision.decision,
        confidence: decision.confidence,
        model: opts.model,
        batchId,
        cost: batchResult.costUsd,
        casHandle: batchResult.casHandle,
        actor: "claude-code",
        dryRun: false,
        exitCode: result.exitCode,
        ...(ok ? {} : { stderr: result.stderr.trim() }),
      });

      if (ok) {
        const rems = removeLabels.length ? `-${removeLabels.join(",")} ` : "";
        outputSink.log(
          `apply GH-${candidate.number} ${rems}+${addLabel} (conf=${decision.confidence ?? "?"})`.trim(),
        );
      } else {
        outputSink.error(
          `error GH-${candidate.number} exit=${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
    }
  }

  // Canonical reconcile chain — same shape as prioritize.ts (GH-2316: the
  // destructive `--pull-only --prefer-github` shell-out was retired so a
  // `priority::*` label can no longer round-trip into bd; I-DS-PRIO).
  let syncOutcome: "ok" | "failed" | "skipped" = "skipped";
  if (!opts.dryRun && touchedIssues.length > 0) {
    const beadsSync = deps.runBeadsSync ?? defaultRunBeadsSync;
    const syncCapture: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const syncOutput = {
      log: (line: string) => syncCapture.stdout.push(line),
      error: (line: string) => syncCapture.stderr.push(line),
    };
    const syncResult: BeadsSyncResult = await beadsSync(
      {
        repo,
        domain: "gh",
        dryRun: false,
        limit: DEFAULT_SYNC_LIMIT,
        format: "plain",
      },
      syncOutput,
    );
    if (syncResult.exitCode === 0) {
      syncOutcome = "ok";
      outputSink.log(`OK bd github sync: ${touchedIssues.length} issue(s) reconciled`);
    } else {
      syncOutcome = "failed";
      const detail = syncCapture.stderr.join("\n").trim() || syncCapture.stdout.join("\n").trim();
      outputSink.error(detail ? `FAIL bd github sync: ${detail}` : "FAIL bd github sync");
    }
  }

  outputSink.log(
    `triage prioritize-bulk: batches=${batches.length} decisions=${decided} writeErrors=${writeErrors} inferenceErrors=${inferenceErrors} cost=$${totalCostUsd.toFixed(4)} sync=${syncOutcome} log=${logPath}`,
  );

  if (syncOutcome === "failed") return 1;
  return writeErrors > 0 || inferenceErrors > 0 ? 1 : 0;

  // The auditEntries / touchedIssues / batches.length / totalCostUsd values
  // are surfaced via runPrioritizeBulkActor below by re-running through a
  // capture wrapper; this orchestrator returns just the exit code so the CLI
  // shape matches sibling verbs.
}

// ── machine actor wrapper ──────────────────────────────────────────────────

export async function runPrioritizeBulkActor(
  opts: TriagePrioritizeBulkOptions,
  deps: TriagePrioritizeBulkDeps = {},
): Promise<TriagePrioritizeBulkActorResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: PrioritizeBulkAuditRow[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriagePrioritizeBulkDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          const parsed = JSON.parse(line.trim()) as PrioritizeBulkAuditRow;
          audit.push(parsed);
        } catch {
          // ignore non-JSON lines (none expected; emit() always writes JSON)
        }
        upstreamAppend?.(path, line);
      },
    },
  };
  const captureOutput: Output = {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };

  const exitCode = await runTriagePrioritizeBulk(opts, captureOutput, captureDeps);
  const touchedIssues = audit
    .filter((row) => row.exitCode === 0 && !row.dryRun && row.decision !== undefined)
    .map((row) => row.issue);
  const batchIds = new Set<string>();
  let totalCostUsd = 0;
  for (const row of audit) {
    batchIds.add(row.batchId);
    if (typeof row.cost === "number") {
      // cost is per-batch; add once per batchId encounter — but dedupe by tracking
      // a separate sum keyed by batchId.
    }
  }
  const seenBatch = new Set<string>();
  for (const row of audit) {
    if (typeof row.cost === "number" && !seenBatch.has(row.batchId)) {
      totalCostUsd += row.cost;
      seenBatch.add(row.batchId);
    }
  }
  return {
    exitCode,
    audit,
    stdout,
    stderr,
    touchedIssues,
    batchCount: batchIds.size,
    totalCostUsd,
  };
}
