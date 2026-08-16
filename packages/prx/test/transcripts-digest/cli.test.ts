// `prx transcripts <verb>` (GH-1495) — the digest / status / list-sources verb
// handlers. The digest path drives the real transcriptsDigestMachine with a
// stubbed claude runner; status reads a HOME-isolated `.claude/projects` tree so
// TTL pressure is deterministic. No real claude, no real home.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runTranscriptsDigest,
  runTranscriptsListSources,
  runTranscriptsStatus,
  type TranscriptsDigestVerbInput,
} from "../../src/transcripts-digest/cli.ts";
import type { ClaudePrintRunner } from "../../src/transcripts-digest/extractor.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function rec() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    output: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
  };
}

const NOW = new Date("2026-06-07T00:00:00.000Z");
// A runner that must never be reached on the no-candidates path.
const unusedRunner: ClaudePrintRunner = async () => {
  throw new Error("runner should not be called");
};

function digestInput(over: Partial<TranscriptsDigestVerbInput> = {}): TranscriptsDigestVerbInput {
  return {
    source: "claude-code-jsonl",
    mode: "dry-run",
    format: "plain",
    ...over,
  };
}

// ── list-sources ────────────────────────────────────────────────────────────

describe("runTranscriptsListSources", () => {
  test("plain lists each registered source", () => {
    const r = rec();
    expect(runTranscriptsListSources({ format: "plain" }, r.output).exitCode).toBe(0);
    expect(r.lines[0]).toContain("list-sources");
    expect(r.lines.some((l) => l.includes("claude-code-jsonl"))).toBe(true);
  });

  test("json emits a sources array", () => {
    const r = rec();
    runTranscriptsListSources({ format: "json" }, r.output);
    expect(JSON.parse(r.lines[0]!).sources).toContain("claude-code-jsonl");
  });
});

// ── status (HOME-isolated) ──────────────────────────────────────────────────

// NB: runTranscriptsStatus reads `os.homedir()/.claude/projects`, which is NOT
// injectable (homedir ignores $HOME on macOS), so the live-session counts come
// from the real home and aren't asserted. The deterministic surface is the
// staged-candidate count (memoryDir is injectable) and the output structure.
describe("runTranscriptsStatus", () => {
  test("plain reports the structured status with the injected staged count", () => {
    const memoryDir = tmp("td-mem-");
    mkdirSync(join(memoryDir, ".candidates"), { recursive: true });
    writeFileSync(join(memoryDir, ".candidates", "c1.md"), "# c");
    writeFileSync(join(memoryDir, ".candidates", "c2.md"), "# c");
    writeFileSync(join(memoryDir, ".candidates", "ignore.txt"), "x"); // non-md skipped
    const r = rec();
    const out = runTranscriptsStatus({ format: "plain" }, r.output, {
      now: () => NOW,
      resolveMemoryDir: () => memoryDir,
    });
    expect(out.exitCode).toBe(0);
    const text = r.lines.join("\n");
    expect(text).toContain("transcripts status");
    expect(text).toContain("staged candidates: 2");
  });

  test("json emits the structured summary; default memory dir resolves via encodePath", () => {
    const r = rec();
    // No resolveMemoryDir → exercises defaultMemoryDirFor (encodePath).
    const out = runTranscriptsStatus({ format: "json" }, r.output, {
      now: () => NOW,
      cwd: () => "/some/work/dir",
    });
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(r.lines[0]!);
    expect(typeof summary.liveSessionCount).toBe("number");
    expect(summary.memoryDir).toContain("-some-work-dir");
    expect(summary.stagedCandidateCount).toBe(0); // tmp default dir has no .candidates
  });

  test("a missing memory dir yields zero staged candidates", () => {
    const r = rec();
    const out = runTranscriptsStatus({ format: "json" }, r.output, {
      now: () => NOW,
      resolveMemoryDir: () => "/no/such/memory/dir",
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(r.lines[0]!).stagedCandidateCount).toBe(0);
  });
});

// ── digest ──────────────────────────────────────────────────────────────────

describe("runTranscriptsDigest", () => {
  test("web-export without --input is a config error (failed_resolve, exit 64)", async () => {
    const r = rec();
    const out = await runTranscriptsDigest(digestInput({ source: "claude-web-export" }), r.output, {
      now: () => NOW,
      runner: unusedRunner,
    });
    expect(out.exitCode).toBe(64);
    expect(out.state).toBe("failed_resolve");
    expect(r.errors.join("\n")).toContain("requires --input");
    expect(out.context.blockedReason?.actor).toBe("config");
  });

  test("an empty jsonl source digests to no_new_memories (dry-run, exit 0)", async () => {
    const input = tmp("td-input-");
    const r = rec();
    const audit: Array<Record<string, unknown>> = [];
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "dry-run",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: unusedRunner,
        appendAuditRow: (row) => {
          audit.push(row as Record<string, unknown>);
        },
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem3-"),
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.state).toBe("no_new_memories");
    expect(r.lines.join("\n")).toContain("transcripts digest");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe("TRANSCRIPT_DIGEST_COMPLETED");
  });

  test("json format emits the structured run summary", async () => {
    const input = tmp("td-input2-");
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "dry-run",
        format: "json",
      }),
      r.output,
      {
        now: () => NOW,
        runner: unusedRunner,
        appendAuditRow: () => {},
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem4-"),
      },
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(r.lines[0]!);
    expect(summary.state).toBe("no_new_memories");
    expect(summary.mode).toBe("dry-run");
    expect(summary.source).toBe("claude-code-jsonl");
  });

  test("an audit-sink failure does not abort the run", async () => {
    const input = tmp("td-input3-");
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "dry-run",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: unusedRunner,
        appendAuditRow: () => {
          throw new Error("sink down");
        },
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem5-"),
      },
    );
    expect(out.exitCode).toBe(0); // sink failure swallowed
  });

  test("an unrecognized source is a config error", async () => {
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({ source: "bogus-source" as never }),
      r.output,
      {
        now: () => NOW,
        runner: unusedRunner,
        getAuditRuntimeContext: () => ({ actor: "t" }) as never,
      },
    );
    expect(out.exitCode).toBe(64);
    expect(r.errors.join("\n")).toContain("unknown transcripts source");
  });

  test("stage mode creates the memory dir before running", async () => {
    const input = tmp("td-input-stage-");
    const memoryDir = join(tmp("td-mem-stage-"), "nested", "memory");
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "stage",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: unusedRunner,
        appendAuditRow: () => {},
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => memoryDir,
      },
    );
    // Empty input → no candidates → no_new_memories, but the mkdir ran (mode != dry-run).
    expect(out.exitCode).toBe(0);
    expect(existsSync(memoryDir)).toBe(true);
  });

  // A discoverable jsonl session with one user message.
  function jsonlSessionDir(): string {
    const dir = tmp("td-session-");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "remember: I prefer terse responses" },
      timestamp: "2026-05-01T00:00:00.000Z",
      uuid: "u-1",
    });
    writeFileSync(join(dir, "sess-1.jsonl"), `${line}\n`);
    return dir;
  }

  // A runner returning the claude envelope wrapping a candidate array.
  const candidateRunner =
    (candidates: object[], exitCode = 0): ClaudePrintRunner =>
    async () => ({
      exitCode,
      stdout: JSON.stringify([
        { type: "system" },
        { type: "result", subtype: "success", is_error: false, result: JSON.stringify(candidates) },
      ]),
      stderr: exitCode === 0 ? "" : "extract boom",
    });

  const oneCandidate = [
    {
      type: "feedback",
      name: "prefer-terse",
      description: "user wants terse replies",
      body: "Keep it tight. **Why:** stated preference. **How to apply:** no preamble.",
    },
  ];

  test("stage mode stages candidates and renders the stage summary (plain)", async () => {
    const input = jsonlSessionDir();
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "stage",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: candidateRunner(oneCandidate),
        appendAuditRow: () => {},
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem-stage2-"),
      },
    );
    expect(out.state).toBe("staged");
    expect(out.context.stageResult).not.toBeNull();
    expect(r.lines.join("\n")).toContain("stage: written=");
  });

  test("commit mode commits candidates and renders the commit summary (plain)", async () => {
    const input = jsonlSessionDir();
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "commit",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: candidateRunner(oneCandidate),
        appendAuditRow: () => {},
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem-commit-"),
      },
    );
    expect(out.state).toBe("committed");
    expect(out.context.commitResult).not.toBeNull();
    expect(r.lines.join("\n")).toContain("commit: committed=");
  });

  test("a per-session extraction failure is surfaced as a failed session", async () => {
    const input = jsonlSessionDir();
    const r = rec();
    await runTranscriptsDigest(
      digestInput({
        source: "claude-code-jsonl",
        inputPath: input,
        mode: "dry-run",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: candidateRunner([], 1), // exitCode 1 → extraction fails for the session
        appendAuditRow: () => {},
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem-fail-"),
      },
    );
    // Whichever terminal the machine lands in, the failed session is recorded
    // and the plain renderer surfaces it.
    expect(r.lines.join("\n")).toMatch(/failed sessions:|blocked:/);
  });

  test("a non-existent web-export file fails in the machine with a blockedReason", async () => {
    const r = rec();
    const out = await runTranscriptsDigest(
      digestInput({
        source: "claude-web-export",
        inputPath: "/no/such/export.json",
        mode: "dry-run",
        format: "plain",
      }),
      r.output,
      {
        now: () => NOW,
        runner: unusedRunner,
        appendAuditRow: () => {},
        getAuditRuntimeContext: () => ({ actor: "tester" }) as never,
        resolveMemoryDir: () => tmp("td-mem6-"),
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.state).toMatch(/^failed_/);
    expect(r.lines.join("\n")).toContain("blocked:");
  });
});
