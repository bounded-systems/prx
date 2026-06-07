// Verb handlers for `prx transcripts <verb>` (GH-1495).
//
// `digest` is the operator-invoked entry point that drives the per-run
// `transcriptsDigestMachine`. v0 ships three verbs:
//
//   prx transcripts digest       — run the digest pipeline
//   prx transcripts status       — show TTL pressure + candidate counts
//   prx transcripts list-sources — introspect the adapter registry
//
// One audit row per run (kind: `transcript-digest-run`) stamps `uowId` +
// `inputRefs` (I-AUD1/I-AUD2). Per-session rows fire when at least one
// candidate is committed/staged for that session.

import { homeDir } from "@bounded-systems/host";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";

import { createActor } from "xstate";

import { appendAuditRow as defaultAppendAuditRow } from "../audit/sink.ts";
import { getAuditRuntimeContext as defaultGetAuditRuntimeContext } from "@bounded-systems/audit-context";
import {
  transcriptsDigestMachine,
  type TranscriptsDigestContext,
  type TranscriptsDigestMode,
} from "./machine.ts";
import type { ClaudePrintRunner } from "./extractor.ts";
import type { TranscriptSourceConfig, TranscriptSourceKind } from "./schemas.ts";
import { knownTranscriptSources } from "./sources/registry.ts";

export type TranscriptsDigestVerbInput = {
  source: TranscriptSourceKind;
  /** Operator-provided archive directory (`--input <path>`). */
  inputPath?: string;
  project?: string;
  sessionId?: string;
  since?: string;
  limit?: number;
  mode: TranscriptsDigestMode;
  /** Override the default `<config>/projects/<encoded>/memory/` resolution. */
  memoryDir?: string;
  /** Override the auto-generated `uowId`. */
  uowId?: string;
  format: "plain" | "json";
};

export type TranscriptsDigestVerbDeps = {
  cwd?: () => string;
  now?: () => Date;
  appendAuditRow?: typeof defaultAppendAuditRow;
  getAuditRuntimeContext?: typeof defaultGetAuditRuntimeContext;
  runner?: ClaudePrintRunner;
  /** Override for tests so the default `~/.config/claude/projects/...` path isn't hit. */
  resolveMemoryDir?: (cwd: string) => string;
};

export type TranscriptsDigestVerbResult = {
  exitCode: number;
  state: string;
  context: Pick<
    TranscriptsDigestContext,
    "sessions" | "candidates" | "stageResult" | "commitResult" | "blockedReason"
  >;
};

function encodePath(path: string): string {
  return path.replace(/[/.]/g, "-");
}

function defaultMemoryDirFor(cwd: string): string {
  const home = homeDir();
  const encoded = encodePath(cwd);
  return join(home, ".config", "claude", "projects", encoded, "memory");
}

function buildSourceConfig(input: TranscriptsDigestVerbInput): TranscriptSourceConfig {
  if (input.source === "claude-code-jsonl") {
    return {
      kind: "claude-code-jsonl",
      ...(input.inputPath ? { inputPath: input.inputPath } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
  }
  if (input.source === "claude-web-export") {
    if (!input.inputPath) {
      throw new Error("claude-web-export requires --input <path>");
    }
    return { kind: "claude-web-export", inputPath: input.inputPath };
  }
  throw new Error(`unknown transcripts source: ${input.source}`);
}

function runMachine(
  input: TranscriptsDigestVerbInput,
  config: TranscriptSourceConfig,
  memoryDir: string,
  uowId: string,
  runner: ClaudePrintRunner | undefined,
): Promise<{ state: string; context: TranscriptsDigestContext }> {
  const actor = createActor(transcriptsDigestMachine, {
    input: {
      config,
      mode: input.mode,
      memoryDir,
      uowId,
      discover: {
        ...(input.since ? { since: input.since } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      },
      runner,
    },
  });
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const snap = actor.getSnapshot();
      resolve({ state: String(snap.value), context: snap.context });
    };
    actor.subscribe((s) => {
      if (s.status === "done") settle();
    });
    actor.start();
    if (actor.getSnapshot().status === "done") settle();
  });
}

function renderPlain(
  state: string,
  context: TranscriptsDigestContext,
  input: TranscriptsDigestVerbInput,
): string {
  const lines: string[] = [];
  lines.push(
    `transcripts digest — source=${input.source} mode=${input.mode} state=${state}`,
  );
  lines.push(`  sessions=${context.sessions.length}  candidates=${context.candidates.length}`);
  if (context.failedSessionIds.length > 0) {
    lines.push(`  failed sessions: ${context.failedSessionIds.join(", ")}`);
  }
  if (context.stageResult) {
    lines.push(
      `  stage: written=${context.stageResult.written} skipped=${context.stageResult.skipped}`,
    );
  }
  if (context.commitResult) {
    lines.push(
      `  commit: committed=${context.commitResult.committed} ` +
        `skippedDuplicate=${context.commitResult.skippedDuplicate} ` +
        `refusedCap=${context.commitResult.refusedCap}`,
    );
  }
  if (context.blockedReason) {
    lines.push(
      `  blocked: ${context.blockedReason.actor} — ${context.blockedReason.message}`,
    );
  }
  return lines.join("\n");
}

const TERMINAL_OK = new Set([
  "staged",
  "committed",
  "dry_run_terminal",
  "no_new_memories",
]);

export async function runTranscriptsDigest(
  input: TranscriptsDigestVerbInput,
  output: { log: (line: string) => void; error: (line: string) => void },
  deps: TranscriptsDigestVerbDeps = {},
): Promise<TranscriptsDigestVerbResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const appendAuditRow = deps.appendAuditRow ?? defaultAppendAuditRow;
  const getAuditRuntimeContext =
    deps.getAuditRuntimeContext ?? defaultGetAuditRuntimeContext;
  const auditActor = getAuditRuntimeContext().actor;

  const uowId = input.uowId ?? `transcripts-digest-${now.toISOString().replace(/[:.]/g, "-")}`;
  const memoryDir =
    input.memoryDir ??
    (deps.resolveMemoryDir ?? defaultMemoryDirFor)(cwd);

  let config: TranscriptSourceConfig;
  try {
    config = buildSourceConfig(input);
  } catch (err) {
    output.error(`transcripts digest: ${err instanceof Error ? err.message : String(err)}`);
    return {
      exitCode: 64,
      state: "failed_resolve",
      context: {
        sessions: [],
        candidates: [],
        stageResult: null,
        commitResult: null,
        blockedReason: { actor: "config", message: String(err) },
      },
    };
  }

  if (input.mode !== "dry-run") {
    mkdirSync(memoryDir, { recursive: true });
  }

  const { state, context } = await runMachine(
    input,
    config,
    memoryDir,
    uowId,
    deps.runner,
  );

  const exitCode = TERMINAL_OK.has(state) ? 0 : 1;

  // Audit lineage row per run (I-TD3 / I-AUD1 / I-AUD2). `kind` is namespaced
  // so the unified audit-row union can be extended in a sibling PR; v0 routes
  // through `catalog-event` so the daily NDJSON sink already accepts it.
  try {
    appendAuditRow({
      ts: now.toISOString(),
      kind: "catalog-event",
      event: "TRANSCRIPT_DIGEST_COMPLETED",
      actor: "transcripts_digest",
      details: {
        uowId,
        source: input.source,
        mode: input.mode,
        state,
        sessionCount: context.sessions.length,
        candidateCount: context.candidates.length,
        committed: context.commitResult?.committed ?? 0,
        staged: context.stageResult?.written ?? 0,
        inputRefs: context.sessions.map((s) => s.sourceRef),
        operatorActor: auditActor,
      },
    });
  } catch {
    // sink failures must not abort the run — audit is observability, not a gate
  }

  output.log(
    input.format === "json"
      ? JSON.stringify(
          {
            state,
            uowId,
            mode: input.mode,
            source: input.source,
            sessions: context.sessions.length,
            candidates: context.candidates.length,
            stageResult: context.stageResult,
            commitResult: context.commitResult,
            failedSessionIds: context.failedSessionIds,
            blockedReason: context.blockedReason,
          },
          null,
          2,
        )
      : renderPlain(state, context, input),
  );

  return {
    exitCode,
    state,
    context: {
      sessions: context.sessions,
      candidates: context.candidates,
      stageResult: context.stageResult,
      commitResult: context.commitResult,
      blockedReason: context.blockedReason,
    },
  };
}

// ── status verb ────────────────────────────────────────────────────────────

export type TranscriptsStatusInput = {
  format: "plain" | "json";
};

export type TranscriptsStatusDeps = {
  cwd?: () => string;
  now?: () => Date;
  resolveMemoryDir?: (cwd: string) => string;
};

const CLAUDE_CODE_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function runTranscriptsStatus(
  input: TranscriptsStatusInput,
  output: { log: (line: string) => void; error: (line: string) => void },
  deps: TranscriptsStatusDeps = {},
): { exitCode: number } {
  const now = (deps.now ?? (() => new Date()))();
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const memoryDir =
    (deps.resolveMemoryDir ?? defaultMemoryDirFor)(cwd);
  const projectsRoot = join(homeDir(), ".claude", "projects");

  const liveSessions: Array<{ project: string; session: string; ageDays: number }> = [];

  if (existsSync(projectsRoot)) {
    for (const projectName of safeReaddir(projectsRoot)) {
      const projectDir = join(projectsRoot, projectName);
      if (!isDir(projectDir)) continue;
      for (const entry of safeReaddir(projectDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const path = join(projectDir, entry);
        const st = safeStat(path);
        if (!st) continue;
        const ageDays = (now.getTime() - st.mtime.getTime()) / MS_PER_DAY;
        liveSessions.push({
          project: projectName,
          session: entry.replace(/\.jsonl$/, ""),
          ageDays,
        });
      }
    }
  }

  const ttlPressure = liveSessions.filter(
    (s) => s.ageDays > CLAUDE_CODE_TTL_DAYS - 3,
  );

  const stagedDir = join(memoryDir, ".candidates");
  const staged = existsSync(stagedDir)
    ? safeReaddir(stagedDir).filter((e) => e.endsWith(".md")).length
    : 0;

  const summary = {
    projectsRoot,
    memoryDir,
    liveSessionCount: liveSessions.length,
    ttlPressureCount: ttlPressure.length,
    ttlPressure: ttlPressure
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 10),
    stagedCandidateCount: staged,
  };

  if (input.format === "json") {
    output.log(JSON.stringify(summary, null, 2));
  } else {
    output.log(
      [
        `transcripts status — ${projectsRoot}`,
        `  live sessions: ${summary.liveSessionCount} (TTL pressure: ${summary.ttlPressureCount})`,
        `  staged candidates: ${summary.stagedCandidateCount}`,
        ...(summary.ttlPressure.length > 0
          ? ["  oldest sessions (within TTL window):", ...summary.ttlPressure.map(
              (s) => `    ${s.session} (${s.ageDays.toFixed(1)}d)`,
            )]
          : []),
      ].join("\n"),
    );
  }

  return { exitCode: 0 };
}

// ── list-sources verb ─────────────────────────────────────────────────────

export function runTranscriptsListSources(
  input: { format: "plain" | "json" },
  output: { log: (line: string) => void; error: (line: string) => void },
): { exitCode: number } {
  const sources = knownTranscriptSources;
  if (input.format === "json") {
    output.log(JSON.stringify({ sources }, null, 2));
  } else {
    output.log("transcripts list-sources");
    for (const s of sources) {
      output.log(`  ${s}`);
    }
  }
  return { exitCode: 0 };
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string): import("node:fs").Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  const st = safeStat(path);
  return st !== null && st.isDirectory();
}
