// `prx triage prioritize` (GH-980) — interactive operator verb that walks the
// `priority::none` queue and writes priority decisions back to GitHub. Each
// decision is one atomic `gh issue edit` (one --remove-label + one
// --add-label). Appends one NDJSON row per outcome to the unified daily sink
// (`$XDG_STATE_HOME/prx/audit/<YYYY-MM-DD>.ndjson`, GH-1403).
//
// GH-971 / GH-2011 / GH-2316 — when writes occur, chains the canonical
// status-only reconcile (`runBeadsSync({ domain: "gh" })`, the sanctioned
// `prx sync issues --from gh --to bd` surface) to keep beads aligned with the
// GH state we just edited. The destructive bd-side reconcile shell-out was
// retired here (GH-2316) so a GH priority label can never round-trip into
// bd-canonical priority — priority is bd-authoritative, projected bd→external
// only (authority ADR §2, invariant I-DS-PRIO).
//
// Schema note: rows tagged with `priorityConfidence: "operator"`, the
// reserved value GH-970 carved out for this verb. The schema field is
// informational at the apply boundary; preservation of operator-set priority
// across a subsequent classify→apply cycle is governed by the GH-957
// hasPriority gate, not this field.

import { processEnv } from "@bounded-systems/env";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { z } from "zod";

import {
  repoNameWithOwner as defaultRepoNameWithOwner,
  type FallbackIssue,
} from "../pr-state/github.ts";
// GH-1602: substitute the gh-side `listOpenIssues` with the bd-resident
// projection. `pruneMergedActor` syncs bd from GH at the head of every triage
// pass, so prioritize's queue enumeration is substrate-resident now.
import { listOpenIssuesFromBeads as defaultListOpenIssues } from "./issues-from-beads.ts";
import { parseLabelName } from "./labels.ts";
import { execGh as defaultExecGh, type GhExecResult } from "@bounded-systems/gh";
import {
  runBeadsSync as defaultRunBeadsSync,
  type BeadsSyncResult,
} from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import {
  appendAuditRow,
  auditSinkPath,
  type AuditSinkDeps,
} from "../audit/sink.ts";

export const triagePrioritizeOptionsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  limit: z.number().int().min(0).default(0),
  dryRun: z.boolean().default(false),
  sync: z.boolean().default(true),
});

export type TriagePrioritizeOptions = z.infer<typeof triagePrioritizeOptionsSchema>;

export type PriorityChoice = "critical" | "high" | "medium" | "low";
export type PromptKey = "c" | "h" | "m" | "l" | "s" | "q";

export type Candidate = {
  number: number;
  title: string;
  url: string;
  currentLabels: string[];
  hasPriorityNone: boolean;
};

export type TriagePrioritizeDeps = {
  execGh?: typeof defaultExecGh;
  listOpenIssues?: typeof defaultListOpenIssues;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  promptDecision?: (candidate: Candidate) => Promise<PromptKey>;
  now?: () => Date;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  /**
   * GH-1697: routed cwd from `prx triage prioritize --repo <slug>`. Defaults
   * to `process.cwd()`. Mirrors the convention in `triage.ts` / `promote.ts`.
   */
  cwd?: () => string;
  /**
   * Canonical reconcile chained after label writes (GH-2316: replaces the
   * retired destructive bd-side reconcile shell-out, which could clobber
   * bd-canonical priority on its pull leg). The sanctioned surface is
   * `prx sync issues --from gh --to bd`, which delegates to `runBeadsSync`.
   * Default delegates to `defaultRunBeadsSync` so the sync runs against the
   * current repo's beads DB. Tests override this seam to assert chaining
   * without spawning real `gh` traffic.
   */
  runBeadsSync?: typeof defaultRunBeadsSync;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type PrioritizeAuditRowEntry = {
  ts: string;
  issue: number;
  url: string;
  action: "decide" | "skip" | "quit" | "error";
  decision?: PriorityChoice;
  add: string[];
  remove: string[];
  prev: string[];
  priorityConfidence: "operator";
  actor: "claude-code";
  dryRun: boolean;
  exitCode: number;
  stderr?: string;
};

export type PrioritizeAuditSyncEntry = {
  ts: string;
  action: "sync";
  touchedIssues: number[];
  actor: "claude-code";
  dryRun: false;
  bdExitCode: number;
  bdStdout: string;
  bdStderr?: string;
};

export type PrioritizeAuditEntry = PrioritizeAuditRowEntry | PrioritizeAuditSyncEntry;

export type PrioritizeSyncOutcome = "ok" | "failed" | "skipped";

const KEY_TO_CHOICE: Record<"c" | "h" | "m" | "l", PriorityChoice> = {
  c: "critical",
  h: "high",
  m: "medium",
  l: "low",
};


/**
 * Filter open issues to those operators need to prioritize: rows tagged
 * `priority::none` (the GH-970 unscored marker) plus rows with no priority
 * axis label at all. Returns candidates sorted by issue number ascending so
 * the queue order is stable across runs.
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

function formatCandidate(candidate: Candidate): string {
  const labelStr =
    candidate.currentLabels.length > 0
      ? candidate.currentLabels.join(", ")
      : "(none)";
  return [
    `GH-${candidate.number} ${candidate.title}`,
    `  ${candidate.url}`,
    `  current: ${labelStr}`,
  ].join("\n");
}

const PROMPT_LINE = "[c]ritical | [h]igh | [m]edium | [l]ow | [s]kip | [q]uit > ";

async function defaultPromptDecision(_candidate: Candidate): Promise<PromptKey> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const raw = (await rl.question(PROMPT_LINE)).trim().toLowerCase();
      if (raw === "c" || raw === "h" || raw === "m" || raw === "l" || raw === "s" || raw === "q") {
        return raw;
      }
      output.write(`unrecognized: '${raw}' (expected c|h|m|l|s|q)\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Actor-shaped entry for `prx triage prioritize`. Async because the verb
 * uses readline prompts; the machine wraps this in a `fromPromise` actor.
 * Captures stdout/stderr and the audit JSONL rows the verb appends.
 */
export type TriagePrioritizeActorResult = {
  exitCode: number;
  audit: PrioritizeAuditEntry[];
  stdout: string[];
  stderr: string[];
  touchedIssues: number[];
};

export async function runPrioritizeActor(
  opts: TriagePrioritizeOptions,
  deps: TriagePrioritizeDeps = {},
): Promise<TriagePrioritizeActorResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: PrioritizeAuditEntry[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriagePrioritizeDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          audit.push(JSON.parse(line.trim()) as PrioritizeAuditEntry);
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

  const exitCode = await runTriagePrioritize(opts, captureOutput, captureDeps);
  const touchedIssues = audit
    .filter((e): e is PrioritizeAuditRowEntry => e.action === "decide")
    .filter((e) => !e.dryRun)
    .map((e) => e.issue);
  return { exitCode, audit, stdout, stderr, touchedIssues };
}

export async function runTriagePrioritize(
  opts: TriagePrioritizeOptions,
  outputSink: Output,
  deps: TriagePrioritizeDeps = {},
): Promise<number> {
  const exec = deps.execGh ?? defaultExecGh;
  const listIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const prompt = deps.promptDecision ?? defaultPromptDecision;
  const cwd = (deps.cwd ?? process.cwd)();
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };
  const append = (entry: PrioritizeAuditEntry): void => appendAuditRow(entry, auditSink);

  let repo = opts.repo;
  if (!repo) {
    try {
      repo = resolveRepo(cwd);
    } catch (err) {
      outputSink.error(`triage prioritize: failed to resolve repo: ${(err as Error).message}`);
      return 1;
    }
  }
  if (!repo) {
    outputSink.error("triage prioritize: --repo is required (could not resolve from cwd)");
    return 1;
  }

  // Pull a generous window when the operator did not cap with --limit so the
  // candidate filter has enough rows to surface a useful queue. The slice is
  // applied after the priority filter, mirroring `prx triage classify`.
  const fetchLimit = opts.limit > 0 ? Math.max(opts.limit * 5, 50) : 200;
  const issues = listIssues(repo, fetchLimit);
  const allCandidates = selectCandidates(issues);
  const candidates = opts.limit > 0 ? allCandidates.slice(0, opts.limit) : allCandidates;

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  if (candidates.length === 0) {
    outputSink.log(`triage prioritize: no candidates (priority::none queue empty) log=${logPath}`);
    return 0;
  }

  outputSink.log(
    `triage prioritize: ${candidates.length} candidate(s) in ${repo}${opts.dryRun ? " (dry-run)" : ""}`,
  );

  let decisions = 0;
  let skips = 0;
  let errors = 0;
  let quit = false;
  const touchedIssues: number[] = [];

  for (const candidate of candidates) {
    outputSink.log(formatCandidate(candidate));
    const key = await prompt(candidate);

    if (key === "q") {
      const entry: PrioritizeAuditRowEntry = {
        ts: now.toISOString(),
        issue: candidate.number,
        url: candidate.url,
        action: "quit",
        add: [],
        remove: [],
        prev: candidate.currentLabels,
        priorityConfidence: "operator",
        actor: "claude-code",
        dryRun: opts.dryRun,
        exitCode: 0,
      };
      append(entry);
      outputSink.log(`quit GH-${candidate.number}`);
      quit = true;
      break;
    }

    if (key === "s") {
      skips += 1;
      const entry: PrioritizeAuditRowEntry = {
        ts: now.toISOString(),
        issue: candidate.number,
        url: candidate.url,
        action: "skip",
        add: [],
        remove: [],
        prev: candidate.currentLabels,
        priorityConfidence: "operator",
        actor: "claude-code",
        dryRun: opts.dryRun,
        exitCode: 0,
      };
      append(entry);
      outputSink.log(`skip GH-${candidate.number}`);
      continue;
    }

    const choice = KEY_TO_CHOICE[key];
    const addLabel = `priority::${choice}`;
    const removeLabels = candidate.hasPriorityNone ? ["priority::none"] : [];

    if (opts.dryRun) {
      const entry: PrioritizeAuditRowEntry = {
        ts: now.toISOString(),
        issue: candidate.number,
        url: candidate.url,
        action: "decide",
        decision: choice,
        add: [addLabel],
        remove: removeLabels,
        prev: candidate.currentLabels,
        priorityConfidence: "operator",
        actor: "claude-code",
        dryRun: true,
        exitCode: 0,
      };
      append(entry);
      const rems = removeLabels.length ? `-${removeLabels.join(",")} ` : "";
      outputSink.log(`dry-run GH-${candidate.number} ${rems}+${addLabel}`.trim());
      decisions += 1;
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
      decisions += 1;
      touchedIssues.push(candidate.number);
    } else {
      errors += 1;
    }

    const entry: PrioritizeAuditRowEntry = {
      ts: now.toISOString(),
      issue: candidate.number,
      url: candidate.url,
      action: ok ? "decide" : "error",
      decision: choice,
      add: [addLabel],
      remove: removeLabels,
      prev: candidate.currentLabels,
      priorityConfidence: "operator",
      actor: "claude-code",
      dryRun: false,
      exitCode: result.exitCode,
      ...(ok ? {} : { stderr: result.stderr.trim() }),
    };
    append(entry);

    if (ok) {
      const rems = removeLabels.length ? `-${removeLabels.join(",")} ` : "";
      outputSink.log(`apply GH-${candidate.number} ${rems}+${addLabel}`.trim());
    } else {
      outputSink.error(
        `error GH-${candidate.number} exit=${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
  }

  // GH-971 / GH-2011 / GH-2316 — chain the canonical status-only reconcile so
  // beads reflects the labels we just wrote at the GH layer. Skipped under
  // dry-run, when the operator opted out via `--no-sync`, or when no writes
  // occurred. The pull leg writes bd only via status-close, never priority
  // (I-DS-PRIO), so a `priority::*` label can no longer round-trip into bd.
  let syncOutcome: PrioritizeSyncOutcome = "skipped";
  if (!opts.dryRun && opts.sync && touchedIssues.length > 0) {
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
    const stderrTrimmed = syncCapture.stderr.join("\n").trim();
    const syncEntry: PrioritizeAuditSyncEntry = {
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
      outputSink.log(`OK bd github sync: ${touchedIssues.length} issue(s) reconciled`);
    } else {
      syncOutcome = "failed";
      const detail = stderrTrimmed || syncCapture.stdout.join("\n").trim();
      outputSink.error(detail ? `FAIL bd github sync: ${detail}` : "FAIL bd github sync");
    }
  }

  outputSink.log(
    `triage prioritize: decisions=${decisions} skips=${skips} errors=${errors} quit=${quit} sync=${syncOutcome} log=${logPath}`,
  );

  if (syncOutcome === "failed") return 1;
  return errors > 0 ? 1 : 0;
}
