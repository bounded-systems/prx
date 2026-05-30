import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverClaudeCodeJsonl } from "../../src/transcripts-digest/sources/claude-code-jsonl.ts";
import { discoverClaudeWebExport } from "../../src/transcripts-digest/sources/claude-web-export.ts";

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

describe("claude-code-jsonl adapter", () => {
  test("discovers sessions from an archive directory (direct *.jsonl)", async () => {
    const archive = tmp("td-archive");
    writeFileSync(
      join(archive, "sess-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hello" },
          timestamp: "2026-05-01T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "world" },
          timestamp: "2026-05-01T00:00:01.000Z",
        }),
      ].join("\n"),
    );

    const sessions = [];
    for await (const s of discoverClaudeCodeJsonl(
      { kind: "claude-code-jsonl", inputPath: archive },
      {},
    )) {
      sessions.push(s);
    }
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionId).toBe("sess-1");
    expect(sessions[0]!.source).toBe("claude-code-jsonl");
    expect(sessions[0]!.messages.length).toBe(2);
    expect(sessions[0]!.sourceRef.endsWith("sess-1.jsonl")).toBe(true);
  });

  test("discovers sessions from a projects-style tree", async () => {
    const root = tmp("td-root");
    const projectDir = join(root, "-encoded-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-2.jsonl"),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "x" },
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
    );

    const sessions = [];
    for await (const s of discoverClaudeCodeJsonl(
      { kind: "claude-code-jsonl", inputPath: root },
      {},
    )) {
      sessions.push(s);
    }
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.project).toBe("-encoded-project");
  });

  test("honors --limit", async () => {
    const archive = tmp("td-limit");
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(archive, `sess-${i}.jsonl`),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
          timestamp: "2026-05-01T00:00:00.000Z",
        }),
      );
    }
    const sessions = [];
    for await (const s of discoverClaudeCodeJsonl(
      { kind: "claude-code-jsonl", inputPath: archive },
      { limit: 2 },
    )) {
      sessions.push(s);
    }
    expect(sessions.length).toBe(2);
  });
});

describe("claude-web-export adapter", () => {
  test("cross-joins conversations.json × memories.json by conversation id", async () => {
    const archive = tmp("td-web");
    writeFileSync(
      join(archive, "conversations.json"),
      JSON.stringify([
        {
          uuid: "conv-1",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:01:00.000Z",
          chat_messages: [
            { sender: "human", text: "what's the plan?" },
            { sender: "assistant", text: "ship it" },
          ],
        },
      ]),
    );
    writeFileSync(
      join(archive, "memories.json"),
      JSON.stringify([
        { conversation_id: "conv-1", text: "user prefers terse responses" },
      ]),
    );

    const sessions = [];
    for await (const s of discoverClaudeWebExport(
      { kind: "claude-web-export", inputPath: archive },
      {},
    )) {
      sessions.push(s);
    }
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionId).toBe("conv-1");
    expect(sessions[0]!.source).toBe("claude-web-export");
    // Memory inlined as a system pseudo-message + 2 chat messages.
    expect(sessions[0]!.messages.length).toBe(3);
    expect(sessions[0]!.messages[0]!.role).toBe("system");
    expect(sessions[0]!.messages[0]!.content).toContain("user prefers terse");
  });

  test("works without memories.json", async () => {
    const archive = tmp("td-web-mem");
    writeFileSync(
      join(archive, "conversations.json"),
      JSON.stringify([
        {
          uuid: "conv-2",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
          chat_messages: [{ sender: "human", text: "hi" }],
        },
      ]),
    );
    const sessions = [];
    for await (const s of discoverClaudeWebExport(
      { kind: "claude-web-export", inputPath: archive },
      {},
    )) {
      sessions.push(s);
    }
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.messages.length).toBe(1);
  });
});
