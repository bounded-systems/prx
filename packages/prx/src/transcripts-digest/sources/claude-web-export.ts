// `claude-web-export` source adapter for `prx transcripts digest` (GH-1495).
//
// Reads the native claude.ai web-export pair (`conversations.json` +
// `memories.json`) and cross-joins the two by conversation id, per the
// GH-1491 2026-05-18 ADR comment that documented the shape after the
// hand-rescue. Each conversation becomes one normalized TranscriptSession;
// any memories that name the conversation id appear inline as a `system`-
// role pseudo-message so the extractor sees the human-validated picks
// alongside the raw chat.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  TranscriptMessage,
  TranscriptSession,
  TranscriptSourceConfig,
} from "../schemas.ts";
import type { DiscoverOptions } from "./registry.ts";

type ClaudeWebExportConfig = Extract<
  TranscriptSourceConfig,
  { kind: "claude-web-export" }
>;

type WebMessage = {
  role: string;
  text: string;
  ts: string;
};

type WebConversation = {
  id: string;
  startTs: string;
  endTs: string;
  messages: WebMessage[];
};

type WebMemory = {
  conversationId: string | null;
  text: string;
  ts: string;
};

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join("\n");
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function parseConversations(raw: unknown): WebConversation[] {
  if (!Array.isArray(raw)) return [];
  const conversations: WebConversation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = asString(obj.uuid ?? obj.id);
    if (!id) continue;
    const startTs = asString(obj.created_at ?? obj.startTs);
    const endTs = asString(obj.updated_at ?? obj.endTs ?? startTs);

    const chatRaw = obj.chat_messages ?? obj.messages;
    if (!Array.isArray(chatRaw)) {
      conversations.push({ id, startTs, endTs, messages: [] });
      continue;
    }
    const messages: WebMessage[] = [];
    for (const m of chatRaw) {
      if (!m || typeof m !== "object") continue;
      const mobj = m as Record<string, unknown>;
      const role = asString(mobj.sender ?? mobj.role);
      if (role !== "human" && role !== "assistant" && role !== "user") {
        continue;
      }
      const normalizedRole = role === "human" ? "user" : role;
      const text = asString(mobj.text) || extractText(mobj.content);
      if (!text) continue;
      const ts = asString(mobj.created_at ?? mobj.timestamp, startTs);
      messages.push({ role: normalizedRole, text, ts });
    }
    conversations.push({ id, startTs, endTs, messages });
  }
  return conversations;
}

function parseMemories(raw: unknown): WebMemory[] {
  if (!Array.isArray(raw)) return [];
  const memories: WebMemory[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const text = asString(obj.text ?? obj.content);
    if (!text) continue;
    const conversationId =
      asString(obj.conversation_id ?? obj.conversationId) || null;
    const ts = asString(obj.created_at ?? obj.timestamp);
    memories.push({ conversationId, text, ts });
  }
  return memories;
}

function buildSession(
  conversation: WebConversation,
  memories: WebMemory[],
  sourceRef: string,
): TranscriptSession {
  const messages: TranscriptMessage[] = [];
  for (const m of memories) {
    messages.push({
      role: "system",
      ts: m.ts || conversation.startTs,
      content: `[claude.ai memory] ${m.text}`,
    });
  }
  for (const m of conversation.messages) {
    const role =
      m.role === "user" || m.role === "assistant" ? m.role : "user";
    messages.push({
      role,
      ts: m.ts,
      content: m.text,
    });
  }
  return {
    source: "claude-web-export",
    sessionId: conversation.id,
    project: "web",
    startTs: conversation.startTs || "1970-01-01T00:00:00.000Z",
    endTs: conversation.endTs || conversation.startTs || "1970-01-01T00:00:00.000Z",
    messageCount: messages.length,
    messages,
    sourceRef,
  };
}

export async function* discoverClaudeWebExport(
  config: ClaudeWebExportConfig,
  opts: DiscoverOptions,
): AsyncIterable<TranscriptSession> {
  const conversationsPath = join(config.inputPath, "conversations.json");
  const memoriesPath = join(config.inputPath, "memories.json");

  let conversations: WebConversation[];
  try {
    conversations = parseConversations(readJson(conversationsPath));
  } catch (err) {
    throw new Error(
      `claude-web-export: failed to read ${conversationsPath}: ${(err as Error).message}`,
    );
  }

  let memories: WebMemory[] = [];
  try {
    memories = parseMemories(readJson(memoriesPath));
  } catch {
    // memories.json is optional — operators may export conversations only.
    memories = [];
  }

  const memoriesByConversation = new Map<string, WebMemory[]>();
  for (const m of memories) {
    if (!m.conversationId) continue;
    const bucket = memoriesByConversation.get(m.conversationId) ?? [];
    bucket.push(m);
    memoriesByConversation.set(m.conversationId, bucket);
  }

  let yielded = 0;
  for (const conversation of conversations) {
    if (typeof opts.limit === "number" && yielded >= opts.limit) return;
    if (conversation.messages.length === 0) continue;
    const startTs = conversation.startTs;
    if (opts.since && startTs && startTs < opts.since) continue;

    const session = buildSession(
      conversation,
      memoriesByConversation.get(conversation.id) ?? [],
      `${conversationsPath}#${conversation.id}`,
    );
    yielded += 1;
    yield session;
  }
}
