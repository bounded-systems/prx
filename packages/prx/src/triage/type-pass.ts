// `prx triage type-pass` (GH-1021) — bulk Haiku-backed type classifier.
// Walks the type-less queue (open issues with no `type::*` label), batches
// them through `claude --print --model claude-haiku-4-5-20251001`, and
// writes the proposed `type::<t>` label per row via the internal `execGh`
// wrapper. Appends one NDJSON row per outcome to the unified daily sink at
// `$XDG_STATE_HOME/prx/audit/<YYYY-MM-DD>.ndjson` (GH-1403).
//
// GH-971 parity (mirroring apply/prioritize): when writes occur, chains
// the canonical reconcile (`runBeadsSync({ domain: "gh" })`, GH-2011) so
// the bd-canonical authority boundary is preserved.
//
// Type vocabulary is the round-trippable subset (TYPE enum at labels.ts) —
// `bug, feature, task, chore, epic`. GH-1058 narrowed this to bd's
// `typeMapping`; emitting outside-vocab values would be silently coerced to
// `task` by the legacy reconcile. The Haiku prompt is constrained to the
// same five values.

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import {
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
import { buildTriageHaikuClassifierRuntimeProfile } from "../machine/runtime_profiles.ts";
import { agentProfileExecutionAsRuntimeResult, executeAgentProfile } from "../pr-state/executor.ts";
// GH-1602: substitute the gh-side `listOpenIssues` with the bd-resident
// projection. `pruneMergedActor` syncs bd from GH at the head of every triage
// pass, so type-pass's queue enumeration is substrate-resident now.
import { listOpenIssuesFromBeads as defaultListOpenIssues } from "./issues-from-beads.ts";
import { BD_TYPE_ENUM, parseLabelName } from "./labels.ts";
import { type TypeLabel } from "./label-vocab.ts";
import { execGh as defaultExecGh, type GhExecResult } from "@bounded-systems/gh";
import { runBeadsSync as defaultRunBeadsSync, type BeadsSyncResult } from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import { parseClaudeJsonEnvelope } from "../claude/envelope.ts";
import { stripCodeFence } from "../claude/strip-code-fence.ts";
import { triageTypePassOptionsSchema, type TriageTypePassOptions } from "./schemas/input.ts";
import { appendAuditRow, auditSinkPath, type AuditSinkDeps } from "../audit/sink.ts";

export { triageTypePassOptionsSchema, type TriageTypePassOptions };

// ── candidate selection ────────────────────────────────────────────────────

export type TypelessCandidate = {
  number: number;
  title: string;
  url: string;
  currentLabels: string[];
};

/**
 * Filter open issues to those with no `type::*` axis label. Mirrors
 * `prioritize.selectCandidates` with axis swap. Sorted by issue number for
 * stable batch ordering across runs (same issue lands in the same batch
 * given the same input window, which keeps idempotent re-runs cheap).
 */
export function selectCandidates(issues: FallbackIssue[]): TypelessCandidate[] {
  const candidates: TypelessCandidate[] = [];
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map((l) => l.name);
    let hasTypeAxis = false;
    for (const name of labels) {
      const parsed = parseLabelName(name);
      if (parsed.known && parsed.axis === "type") {
        hasTypeAxis = true;
        break;
      }
    }
    if (hasTypeAxis) continue;
    candidates.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      currentLabels: labels,
    });
  }
  candidates.sort((a, b) => a.number - b.number);
  return candidates;
}

// ── heuristic prompt ───────────────────────────────────────────────────────

/**
 * System prompt for the Haiku batch classifier. Constrained to the
 * round-trippable five-value `TYPE` enum (labels.ts:12). Heuristics lifted
 * from the validated 2026-04-29 hand-rolled batch (see GH-1021 ticket body).
 *
 * GH-988: extended to also emit a `spike: boolean` bit. The bd-axis `type`
 * stays in `BD_TYPE_ENUM` (no 6th value); `spike` is the GH-only marker
 * (GH-1489) that rides alongside `type::task` for spike-shaped artifacts
 * filed outside `prx intake spike`.
 */
export const TYPE_PASS_SYSTEM_PROMPT = `You are a triage-axis classifier for GitHub issues. For each input issue, pick exactly one type from the vocabulary below and decide whether the issue is spike-shaped.

Type vocabulary (round-trippable subset — pick exactly one per issue):
- bug: defect / regression / unexpected behavior in shipped code
- feature: new user-facing capability or new operator surface
- task: bounded implementation work that isn't a bug or wholly new feature
- epic: parent ticket containing multiple child tasks
- chore: low-risk housekeeping

Rules (apply in order; first match wins):
1. Title prefix wins:
   - bug: / fix( / fix: → bug
   - feat( / feature( / feat: → feature
   - chore( / chore: → chore
   - task( / test( / refactor( / spike( / docs( → task
   - [epic] / M<N>: → epic
2. Defect verbs in the title (fails, leaks, ignores, doesn't, blocked, broken, regression) → bug
3. Capability verbs in the title (add, support, expose, introduce, implement) when the change is user-visible → feature
4. Otherwise: task

Spike bit (independent of type):
- spike(...) / spike: prefixes → spike: true (and type: "task")
- "spike <something>" or investigation verbs ("investigate", "explore",
  "evaluate" toward a decision, "prove out") in the title → spike: true
- everything else → spike: false

Output: a JSON array. One element per input issue, in the same order. Each element:
{"number": <int>, "type": "bug"|"feature"|"task"|"epic"|"chore", "spike": true|false, "confidence": "high"|"medium"|"low"}

confidence reflects how cleanly the rules fired:
- high: title prefix matched (rule 1)
- medium: a verb match fired (rule 2 or 3)
- low: fell through to rule 4 (default task)

Emit ONLY the JSON array. No prose, no markdown fence.`;

// ── batch response schema ──────────────────────────────────────────────────

// Bound to `BD_TYPE_ENUM` (the bd-round-trippable subset), not the broader
// `TYPE` enum from labels.ts. The Haiku prompt is restricted to these five
// values; emitting outside-vocab values would be silently coerced to `task`
// by the legacy reconcile. GH-1489 widened `TYPE` to include the GH-only
// `spike` marker for the intake stamping path — but that label is NOT meant
// to be emitted by the type-pass classifier.
const haikuTypeSchema = z.enum(BD_TYPE_ENUM);

export const haikuBatchRowSchema = z.object({
  number: z.number().int().positive(),
  type: haikuTypeSchema,
  // GH-988: `spike` is the GH-only side-channel marker (GH-1489). Optional in
  // the schema so legacy haiku outputs without the bit still parse, but the
  // updated system prompt instructs the model to always emit it.
  spike: z.boolean().optional(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type HaikuBatchRow = z.infer<typeof haikuBatchRowSchema>;

export const haikuBatchResponseSchema = z.array(haikuBatchRowSchema);

/**
 * Parse the `claude --print --output-format json` envelope and extract the
 * model's reply text, then parse that as a JSON array of decision rows and
 * validate against the batch schema.
 *
 * Envelope decoding routes through `parseClaudeJsonEnvelope` (the canonical
 * boundary parser at `src/claude/envelope.ts`) so the legacy single-object
 * shape and the CLI ≥ 2.1 stream-array shape are both handled. We tolerate
 * code-fence wrapping (` ```json ... ``` `) defensively on the inner payload
 * even though the prompt forbids it.
 */
export function parseHaikuEnvelope(stdout: string): {
  rows: HaikuBatchRow[];
  cost?: number;
} {
  const envelope = parseClaudeJsonEnvelope(stdout, "haiku envelope");
  const stripped = stripCodeFence(envelope.result.trim());
  const parsed = JSON.parse(stripped);
  const rows = haikuBatchResponseSchema.parse(parsed);
  return {
    rows,
    ...(envelope.costUsd !== undefined ? { cost: envelope.costUsd } : {}),
  };
}

// ── audit row types ────────────────────────────────────────────────────────

export type TypePassAuditRowEntry = {
  ts: string;
  issue: number;
  url: string;
  title: string;
  currentLabels: string[];
  decisionType?: TypeLabel;
  /** GH-988: GH-only spike marker (GH-1489) recorded alongside the type decision. */
  decisionSpike?: boolean;
  confidence?: "high" | "medium" | "low";
  model: string;
  batchId: string;
  cost?: number;
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type TypePassAuditSyncEntry = {
  ts: string;
  action: "sync";
  touchedIssues: number[];
  actor: "claude-code";
  dryRun: false;
  bdExitCode: number;
  bdStdout: string;
  bdStderr?: string;
};

export type TypePassAuditEntry = TypePassAuditRowEntry | TypePassAuditSyncEntry;

export type TypePassSyncOutcome = "ok" | "failed" | "skipped";

// ── deps + output ──────────────────────────────────────────────────────────

export type SpawnHaikuResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type SpawnHaiku = (args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) => SpawnHaikuResult | Promise<SpawnHaikuResult>;

export type TriageTypePassDeps = {
  execGh?: typeof defaultExecGh;
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  spawnHaiku?: SpawnHaiku;
  now?: () => Date;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1697: routed cwd from `prx triage type-pass --repo <slug>`. Defaults
   * to `process.cwd()`. Mirrors the convention in `triage.ts` / `promote.ts`.
   */
  cwd?: () => string;
  /**
   * Run the canonical reconcile (`runBeadsSync({ domain: "gh" })`, GH-2011)
   * and return the result. Default delegates to `defaultRunBeadsSync` so the
   * sync runs against the current repo's beads DB. Tests override this seam
   * to assert the chain is invoked without spawning real `gh` traffic.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

// GH-1828: default Haiku spawn now routes through the Anthropic Agent SDK
// via `executeAgentProfile` instead of a direct `claude` subprocess. The
// `claude --print --output-format json` envelope is preserved (success path
// emits the same shape `parseHaikuEnvelope` consumes), so the parser does
// not need to change. Tests still inject sync `SpawnHaiku` impls — the
// awaited call site below tolerates both shapes.
const defaultSpawnHaiku: SpawnHaiku = async ({ model, systemPrompt, userPrompt }) => {
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
    status: collapsed.status,
    stdout: collapsed.stdout,
    stderr: collapsed.stderr,
  };
};

// ── actor result ───────────────────────────────────────────────────────────

/**
 * Actor-shaped entry for `prx triage type-pass`. Mirrors
 * TriagePrioritizeActorResult so the machine treats both bulk verbs the
 * same. The XState `onDone` for typePassing only consumes the resolution
 * signal (machine.ts:255) — context does not currently surface this output.
 */
export type TriageTypePassActorResult = {
  exitCode: number;
  audit: TypePassAuditEntry[];
  stdout: string[];
  stderr: string[];
  touchedIssues: number[];
};

export async function runTypePassActor(
  opts: TriageTypePassOptions,
  deps: TriageTypePassDeps = {},
): Promise<TriageTypePassActorResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: TypePassAuditEntry[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriageTypePassDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          audit.push(JSON.parse(line.trim()) as TypePassAuditEntry);
        } catch {
          // ignore non-JSON lines
        }
        upstreamAppend?.(path, line);
      },
    },
  };
  const captureOutput: Output = {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };

  const exitCode = await runTriageTypePass(opts, captureOutput, captureDeps);
  const touchedIssues = audit
    .filter((e): e is TypePassAuditRowEntry => !("action" in e))
    .filter((e) => !e.dryRun && e.exitCode === 0 && e.decisionType !== undefined)
    .map((e) => e.issue);
  return { exitCode, audit, stdout, stderr, touchedIssues };
}

// ── CLI handler ────────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function runTriageTypePass(
  opts: TriageTypePassOptions,
  outputSink: Output,
  deps: TriageTypePassDeps = {},
): Promise<number> {
  const exec = deps.execGh ?? defaultExecGh;
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const spawnHaiku = deps.spawnHaiku ?? defaultSpawnHaiku;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: TypePassAuditEntry): void => appendAuditRow(entry, auditSink);

  let repo = opts.repo;
  if (!repo) {
    try {
      repo = resolveRepo(cwd);
    } catch (err) {
      outputSink.error(`triage type-pass: failed to resolve repo: ${(err as Error).message}`);
      return 1;
    }
  }
  if (!repo) {
    outputSink.error("triage type-pass: --repo is required (could not resolve from cwd)");
    return 1;
  }

  // Pull a generous window when the operator did not cap with --limit so the
  // candidate filter has enough rows to surface a useful queue. Mirrors
  // `triage prioritize` (prioritize.ts:274).
  const fetchLimit = opts.limit > 0 ? Math.max(opts.limit * 5, 50) : 200;
  const issues = listIssues(repo, fetchLimit);
  const allCandidates = selectCandidates(issues);
  const candidates = opts.limit > 0 ? allCandidates.slice(0, opts.limit) : allCandidates;

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  if (candidates.length === 0) {
    outputSink.log(`triage type-pass: no candidates (type-less queue empty) log=${logPath}`);
    return 0;
  }

  outputSink.log(
    `triage type-pass: ${candidates.length} candidate(s) in ${repo}${opts.dryRun ? " (dry-run)" : ""}`,
  );

  const batches = chunk(candidates, opts.batchSize);
  let classified = 0;
  let errors = 0;
  const touchedIssues: number[] = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const batchId = `batch-${i + 1}`;

    const userPrompt = JSON.stringify(
      batch.map((c) => ({
        number: c.number,
        title: c.title,
        currentLabels: c.currentLabels,
      })),
    );

    let rows: HaikuBatchRow[];
    let cost: number | undefined;
    try {
      const haikuResult = await spawnHaiku({
        model: opts.model,
        systemPrompt: TYPE_PASS_SYSTEM_PROMPT,
        userPrompt,
      });
      if (haikuResult.status !== 0) {
        outputSink.error(
          `triage type-pass: haiku ${batchId} exited status=${haikuResult.status} stderr=${haikuResult.stderr.trim().slice(0, 200)}`,
        );
        // Record one error row per batch entry so the audit log captures
        // which candidates were affected by the batch-level failure.
        for (const c of batch) {
          const entry: TypePassAuditRowEntry = {
            ts: now.toISOString(),
            issue: c.number,
            url: c.url,
            title: c.title,
            currentLabels: c.currentLabels,
            model: opts.model,
            batchId,
            actor: "claude-code",
            dryRun: opts.dryRun,
            exitCode: 1,
            stderr: `haiku batch failed: status=${haikuResult.status}${haikuResult.stderr.trim() ? ` stderr=${haikuResult.stderr.trim().slice(0, 300)}` : ""}`,
          };
          append(entry);
          errors += 1;
        }
        continue;
      }
      const parsed = parseHaikuEnvelope(haikuResult.stdout);
      rows = parsed.rows;
      cost = parsed.cost;
    } catch (err) {
      outputSink.error(`triage type-pass: haiku ${batchId} parse error: ${(err as Error).message}`);
      for (const c of batch) {
        const entry: TypePassAuditRowEntry = {
          ts: now.toISOString(),
          issue: c.number,
          url: c.url,
          title: c.title,
          currentLabels: c.currentLabels,
          model: opts.model,
          batchId,
          actor: "claude-code",
          dryRun: opts.dryRun,
          exitCode: 1,
          stderr: `haiku envelope parse failed: ${(err as Error).message}`,
        };
        append(entry);
        errors += 1;
      }
      continue;
    }

    // Index rows by issue number for cheap lookup; tolerate missing rows
    // (the batch order rule lets the model drop a row in pathological cases).
    const byNumber = new Map<number, HaikuBatchRow>();
    for (const r of rows) byNumber.set(r.number, r);

    for (const c of batch) {
      const decision = byNumber.get(c.number);
      if (!decision) {
        const entry: TypePassAuditRowEntry = {
          ts: now.toISOString(),
          issue: c.number,
          url: c.url,
          title: c.title,
          currentLabels: c.currentLabels,
          model: opts.model,
          batchId,
          ...(cost !== undefined ? { cost } : {}),
          actor: "claude-code",
          dryRun: opts.dryRun,
          exitCode: 1,
          stderr: "haiku omitted issue from batch response",
        };
        append(entry);
        errors += 1;
        continue;
      }

      // GH-988 + GH-1489: when the model marks the row as spike-shaped,
      // stamp the GH-only `type::spike` marker alongside the bd-axis
      // `type::task` (or whatever bd-typed value the model picked). The
      // marker is suppressed if it would duplicate an existing label.
      const wantsSpikeLabel = decision.spike === true && !c.currentLabels.includes("type::spike");
      const baseLabel = `type::${decision.type}`;
      const addLabels = wantsSpikeLabel ? [baseLabel, "type::spike"] : [baseLabel];
      const addLabelArg = addLabels.join(",");

      if (opts.dryRun) {
        const entry: TypePassAuditRowEntry = {
          ts: now.toISOString(),
          issue: c.number,
          url: c.url,
          title: c.title,
          currentLabels: c.currentLabels,
          decisionType: decision.type,
          ...(decision.spike !== undefined ? { decisionSpike: decision.spike } : {}),
          confidence: decision.confidence,
          model: opts.model,
          batchId,
          ...(cost !== undefined ? { cost } : {}),
          actor: "claude-code",
          dryRun: true,
          exitCode: 0,
        };
        append(entry);
        outputSink.log(`dry-run GH-${c.number} +${addLabelArg} (${decision.confidence})`);
        classified += 1;
        continue;
      }

      const result: GhExecResult = exec(
        {
          group: "issue",
          subcommand: "edit",
          args: [String(c.number), "--add-label", addLabelArg, "--repo", repo],
          state: "planning",
          role: "executor",
        },
        processEnv(),
      );

      const ok = result.exitCode === 0;
      if (ok) {
        classified += 1;
        touchedIssues.push(c.number);
      } else {
        errors += 1;
      }

      const entry: TypePassAuditRowEntry = {
        ts: now.toISOString(),
        issue: c.number,
        url: c.url,
        title: c.title,
        currentLabels: c.currentLabels,
        decisionType: decision.type,
        ...(decision.spike !== undefined ? { decisionSpike: decision.spike } : {}),
        confidence: decision.confidence,
        model: opts.model,
        batchId,
        ...(cost !== undefined ? { cost } : {}),
        actor: "claude-code",
        dryRun: false,
        exitCode: result.exitCode,
        ...(ok ? {} : { stderr: result.stderr.trim() }),
      };
      append(entry);

      if (ok) {
        outputSink.log(`apply GH-${c.number} +${addLabelArg} (${decision.confidence})`);
      } else {
        outputSink.error(`error GH-${c.number} exit=${result.exitCode}: ${result.stderr.trim()}`);
      }
    }
  }

  // GH-971 parity — chain the canonical reconcile (GH-2011: replaces the
  // retired bd-side reconcile shell-out with `runBeadsSync`) so beads
  // reflects the GH-side status flips from the labels we just wrote.
  // Skipped under dry-run or when no writes occurred.
  let syncOutcome: TypePassSyncOutcome = "skipped";
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
    const reconciledCount = syncResult.summary.pulled + syncResult.summary.pushed;
    const stderrTrimmed = syncCapture.stderr.join("\n").trim();
    const syncEntry: TypePassAuditSyncEntry = {
      ts: now.toISOString(),
      action: "sync",
      touchedIssues,
      actor: "claude-code",
      dryRun: false,
      bdExitCode: syncResult.exitCode,
      bdStdout: syncCapture.stdout.join("\n").trim(),
      ...(stderrTrimmed.length > 0 ? { bdStderr: stderrTrimmed } : {}),
    };
    append(syncEntry);

    if (syncResult.exitCode === 0) {
      syncOutcome = "ok";
      outputSink.log(`OK bd github sync: ${reconciledCount} issue(s) reconciled`);
    } else {
      syncOutcome = "failed";
      const detail = stderrTrimmed || syncCapture.stdout.join("\n").trim();
      outputSink.error(detail ? `FAIL bd github sync: ${detail}` : "FAIL bd github sync");
    }
  }

  outputSink.log(
    `triage type-pass: classified=${classified} errors=${errors} batches=${batches.length} sync=${syncOutcome} log=${logPath}`,
  );

  if (syncOutcome === "failed") return 1;
  return errors > 0 ? 1 : 0;
}
