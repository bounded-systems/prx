import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTranscriptsDigest } from "../../src/transcripts-digest/cli.ts";
import { commitCandidate } from "../../src/transcripts-digest/commit-writer.ts";

let scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const captureOutput = () => {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    output: {
      log: (l: string) => lines.push(l),
      error: (l: string) => errors.push(l),
    },
    lines,
    errors,
  };
};

function buildArchive(): { archive: string } {
  const archive = tmp("td-machine");
  writeFileSync(
    join(archive, "sess-1.jsonl"),
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "remember: terse replies preferred" },
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "ack" },
        timestamp: "2026-05-01T00:00:01.000Z",
      }),
    ].join("\n"),
  );
  return { archive };
}

function envelopeRunner(candidates: unknown[]) {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify([
      { type: "system" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(candidates),
      },
    ]),
    stderr: "",
  });
}

describe("runTranscriptsDigest", () => {
  test("I-TD1: --dry-run makes zero on-disk writes under the memory dir", async () => {
    const { archive } = buildArchive();
    const memoryDir = tmp("td-mem");
    // Sanity: memory dir starts empty.
    expect(readdirSync(memoryDir)).toEqual([]);
    const { output } = captureOutput();

    const result = await runTranscriptsDigest(
      {
        source: "claude-code-jsonl",
        inputPath: archive,
        mode: "dry-run",
        format: "plain",
      },
      output,
      {
        runner: envelopeRunner([
          {
            type: "feedback",
            name: "terse-replies",
            description: "x",
            body: "y",
          },
        ]),
        resolveMemoryDir: () => memoryDir,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.state).toBe("dry_run_terminal");
    expect(result.context.candidates.length).toBe(1);
    // Dry-run: nothing under the memory dir.
    expect(readdirSync(memoryDir)).toEqual([]);
  });

  test("I-TD4: no candidates ⇒ terminal no-write state", async () => {
    const { archive } = buildArchive();
    const memoryDir = tmp("td-mem-empty");
    const { output } = captureOutput();

    const result = await runTranscriptsDigest(
      {
        source: "claude-code-jsonl",
        inputPath: archive,
        mode: "stage",
        format: "plain",
      },
      output,
      {
        runner: envelopeRunner([]),
        resolveMemoryDir: () => memoryDir,
      },
    );
    expect(result.state).toBe("no_new_memories");
    // No staged candidate files.
    const stageDir = join(memoryDir, ".candidates");
    expect(existsSync(stageDir) ? readdirSync(stageDir) : []).toEqual([]);
  });

  test("--stage writes candidate files under .candidates/", async () => {
    const { archive } = buildArchive();
    const memoryDir = tmp("td-mem-stage");
    const { output } = captureOutput();

    const result = await runTranscriptsDigest(
      {
        source: "claude-code-jsonl",
        inputPath: archive,
        mode: "stage",
        format: "plain",
      },
      output,
      {
        runner: envelopeRunner([
          {
            type: "feedback",
            name: "terse-replies",
            description: "user wants terse replies",
            body: "Keep it tight.",
          },
        ]),
        resolveMemoryDir: () => memoryDir,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.state).toBe("staged");
    const stageDir = join(memoryDir, ".candidates");
    const entries = readdirSync(stageDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain("sess-1__terse-replies");
  });

  test("--commit appends to MEMORY-feedback.md shard", async () => {
    const { archive } = buildArchive();
    const memoryDir = tmp("td-mem-commit");
    const { output } = captureOutput();

    const result = await runTranscriptsDigest(
      {
        source: "claude-code-jsonl",
        inputPath: archive,
        mode: "commit",
        format: "plain",
      },
      output,
      {
        runner: envelopeRunner([
          {
            type: "feedback",
            name: "terse-replies",
            description: "user wants terse replies",
            body: "Keep it tight.",
          },
        ]),
        resolveMemoryDir: () => memoryDir,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.state).toBe("committed");
    const entries = readdirSync(memoryDir);
    expect(entries).toContain("MEMORY-feedback.md");
    expect(entries).toContain("feedback_terse_replies.md");
  });

  test("I-TD5: re-running commit over the same session is a no-op", async () => {
    const { archive } = buildArchive();
    const memoryDir = tmp("td-mem-idem");
    const { output } = captureOutput();
    const runner = envelopeRunner([
      {
        type: "feedback",
        name: "terse-replies",
        description: "x",
        body: "y",
      },
    ]);

    await runTranscriptsDigest(
      {
        source: "claude-code-jsonl",
        inputPath: archive,
        mode: "commit",
        format: "plain",
      },
      output,
      { runner, resolveMemoryDir: () => memoryDir },
    );
    const beforeShard = readdirSync(memoryDir);

    const second = await runTranscriptsDigest(
      {
        source: "claude-code-jsonl",
        inputPath: archive,
        mode: "commit",
        format: "plain",
      },
      output,
      { runner, resolveMemoryDir: () => memoryDir },
    );
    expect(second.state).toBe("committed");
    expect(second.context.commitResult?.skippedDuplicate).toBe(1);
    // No new files appeared on the second run.
    const afterShard = readdirSync(memoryDir);
    expect(afterShard.sort()).toEqual(beforeShard.sort());
  });
});
