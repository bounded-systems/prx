import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitCandidate,
  MEMORY_INDEX_CAP_BYTES,
} from "../../src/transcripts-digest/commit-writer.ts";
import { writeStagedCandidate } from "../../src/transcripts-digest/stage-writer.ts";
import type { MemoryCandidate } from "../../src/transcripts-digest/schemas.ts";

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

const baseCandidate: MemoryCandidate = {
  type: "feedback",
  name: "terse-replies",
  description: "user prefers terse replies",
  body: "Keep it tight.",
  originSessionId: "sess-aaa",
  inputRefs: ["/tmp/sess-aaa.jsonl"],
  uowId: "uow-xyz",
};

describe("stage-writer", () => {
  test("writes a candidate file under .candidates/", () => {
    const memoryDir = tmp("td-stage");
    const result = writeStagedCandidate(baseCandidate, memoryDir);
    expect(result.skipped).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain("/.candidates/");
    const body = readFileSync(result.path, "utf8");
    expect(body).toContain("name: terse-replies");
    expect(body).toContain("originSessionId: sess-aaa");
    expect(body).toContain("uowId: uow-xyz");
    expect(body).toContain("Keep it tight.");
  });

  test("I-TD5: re-writing an existing candidate is a no-op skip", () => {
    const memoryDir = tmp("td-stage-idem");
    const first = writeStagedCandidate(baseCandidate, memoryDir);
    const second = writeStagedCandidate(baseCandidate, memoryDir);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.path).toBe(first.path);
  });

  test("I-TD2: leaves no .tmp.* orphan under the stage dir on success", () => {
    const memoryDir = tmp("td-stage-tmp");
    writeStagedCandidate(baseCandidate, memoryDir);
    const stageDir = join(memoryDir, ".candidates");
    const entries = readdirSync(stageDir);
    expect(entries.some((e) => e.startsWith(".tmp."))).toBe(false);
  });
});

describe("commit-writer", () => {
  test("writes candidate body + appends pointer line to MEMORY-<type>.md", () => {
    const memoryDir = tmp("td-commit");
    const result = commitCandidate(baseCandidate, memoryDir);
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(existsSync(result.candidatePath)).toBe(true);
    expect(existsSync(result.shardPath)).toBe(true);
    const shard = readFileSync(result.shardPath, "utf8");
    expect(shard).toContain("originSessionId=sess-aaa");
    expect(shard).toContain("feedback_terse_replies.md");
    const candidate = readFileSync(result.candidatePath, "utf8");
    expect(candidate).toContain("name: terse-replies");
  });

  test("I-TD5: re-committing the same originSessionId is skipped", () => {
    const memoryDir = tmp("td-commit-idem");
    commitCandidate(baseCandidate, memoryDir);
    const second = commitCandidate(baseCandidate, memoryDir);
    expect(second.status).toBe("skipped-duplicate");
  });

  test("I-TD7: refuses to commit when the cap would be breached", () => {
    const memoryDir = tmp("td-commit-cap");
    // Pre-fill the index with a giant MEMORY-feedback.md so the next append
    // would exceed cap.
    const filler = "x".repeat(MEMORY_INDEX_CAP_BYTES + 100);
    writeFileSync(join(memoryDir, "MEMORY-feedback.md"), filler);

    const result = commitCandidate(baseCandidate, memoryDir);
    expect(result.status).toBe("refused-cap");
    if (result.status !== "refused-cap") return;
    expect(result.capBytes).toBe(MEMORY_INDEX_CAP_BYTES);
    expect(result.projectedBytes).toBeGreaterThan(result.capBytes);
    // Verify no candidate file was written despite the refusal.
    const entries = readdirSync(memoryDir);
    const candidateFiles = entries.filter((e) =>
      e.startsWith("feedback_terse_replies"),
    );
    expect(candidateFiles).toEqual([]);
  });
});
