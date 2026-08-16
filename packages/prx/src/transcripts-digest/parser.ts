// JSONL parser for the `claude-code-jsonl` adapter (GH-1495).
//
// Each line in a Claude Code session log is one of:
//   - { type: "user",      message: { role: "user",      content: <str | parts[]> }, ... }
//   - { type: "assistant", message: { role: "assistant", content: <str | parts[]> }, ... }
//   - { type: "tool_use" | "tool_result" | "file-history-snapshot" | "system" | ... }
//
// I-TD6 — parse-time tolerance: a malformed line is skipped (counted) and
// processing continues. Only when the *entire* JSONL produces zero valid
// messages do we treat the session as failed. The caller decides what to do
// with the skip count (machine emits TRANSCRIPT_PARSE_LINE_SKIPPED per skip).

import type { TranscriptMessage, TranscriptMessageRole } from "./schemas.ts";

export type ParseJsonlResult = {
  messages: TranscriptMessage[];
  startTs: string | null;
  endTs: string | null;
  skipped: number;
};

const KNOWN_ROLES: ReadonlySet<TranscriptMessageRole> = new Set([
  "user",
  "assistant",
  "tool",
  "system",
]);

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === "string") {
      parts.push(obj.text);
      continue;
    }
    if (obj.type === "tool_use" && typeof obj.name === "string") {
      const inputJson = obj.input ? JSON.stringify(obj.input) : "";
      parts.push(`[tool_use ${obj.name}${inputJson ? `: ${inputJson}` : ""}]`);
      continue;
    }
    if (obj.type === "tool_result") {
      const c = obj.content;
      if (typeof c === "string") {
        parts.push(`[tool_result: ${c}]`);
      } else if (Array.isArray(c)) {
        parts.push(`[tool_result: ${flattenContent(c)}]`);
      }
      continue;
    }
  }
  return parts.join("\n");
}

function normalizeRole(raw: unknown): TranscriptMessageRole | null {
  if (typeof raw !== "string") return null;
  if (KNOWN_ROLES.has(raw as TranscriptMessageRole)) {
    return raw as TranscriptMessageRole;
  }
  return null;
}

/**
 * Parse a Claude Code JSONL transcript body. Skips: blank lines, snapshot
 * rows, malformed JSON, and rows missing a string-or-parts message content.
 */
export function parseClaudeJsonl(body: string): ParseJsonlResult {
  const messages: TranscriptMessage[] = [];
  let startTs: string | null = null;
  let endTs: string | null = null;
  let skipped = 0;

  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!row || typeof row !== "object") {
      skipped += 1;
      continue;
    }
    const obj = row as Record<string, unknown>;

    // Snapshot / hook rows etc — skip silently (not a parse error).
    if (obj.type === "file-history-snapshot") continue;

    const role = normalizeRole(
      typeof obj.type === "string" &&
        (obj.type === "user" || obj.type === "assistant" || obj.type === "system")
        ? obj.type
        : (obj.message as Record<string, unknown> | undefined)?.role,
    );
    if (!role) continue;

    const message = (obj.message ?? {}) as Record<string, unknown>;
    const content = flattenContent(message.content);
    if (!content) continue;

    const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (ts) {
      if (!startTs || ts < startTs) startTs = ts;
      if (!endTs || ts > endTs) endTs = ts;
    }

    messages.push({
      role,
      ts: ts ?? "",
      content,
      ...(typeof obj.parentUuid === "string" ? { parentUuid: obj.parentUuid } : {}),
      ...(typeof obj.uuid === "string" ? { uuid: obj.uuid } : {}),
    });
  }

  return { messages, startTs, endTs, skipped };
}
