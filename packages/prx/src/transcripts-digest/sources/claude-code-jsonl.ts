// `claude-code-jsonl` source adapter for `prx transcripts digest` (GH-1495).
//
// Discovers `<sessionId>.jsonl` files under either:
//   - the live `~/.claude/projects/<encoded>/` tree (default), or
//   - an operator-provided archive directory (`--input <path>`) with the
//     same on-disk shape (e.g. the GH-1493 rescue at
//     `~/Desktop/claude-transcript-archive-2026-05-07`).
//
// The 30-day Claude Code TTL (per `code.claude.com/docs/en/.claude-directory.md`)
// is the reason this adapter exists: live files vanish on day 30, so the
// digest is the chokepoint that compresses temporal transcripts into
// durable memories before they age out.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homeDir } from "@bounded-systems/host";
import { join } from "node:path";

import { parseClaudeJsonl } from "../parser.ts";
import type { TranscriptSession, TranscriptSourceConfig } from "../schemas.ts";
import type { DiscoverOptions } from "./registry.ts";

type ClaudeCodeJsonlConfig = Extract<TranscriptSourceConfig, { kind: "claude-code-jsonl" }>;

function resolveRoot(config: ClaudeCodeJsonlConfig): string {
  if (config.inputPath && config.inputPath.length > 0) return config.inputPath;
  return join(homeDir(), ".claude", "projects");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listProjects(root: string, projectFilter: string | undefined): string[] {
  // Archive shape: `inputPath` may itself be a directory of `.jsonl` files
  // (no `<encoded-project>/` wrapper). Detect by checking whether `root`
  // contains any `.jsonl` files directly.
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const hasDirectJsonl = entries.some((e) => e.endsWith(".jsonl"));
  if (hasDirectJsonl) return [root];

  return entries
    .filter((e) => !e.startsWith("."))
    .map((e) => join(root, e))
    .filter((p) => isDir(p))
    .filter((p) => {
      if (!projectFilter) return true;
      return p.endsWith(`/${projectFilter}`);
    });
}

function listSessions(projectDir: string, sessionFilter: string | undefined): string[] {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  const sessions = entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(projectDir, e));
  if (!sessionFilter) return sessions;
  return sessions.filter((p) => p.endsWith(`/${sessionFilter}.jsonl`));
}

function projectSlugFromPath(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? "unknown";
}

function sessionIdFromPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.jsonl$/, "");
}

export async function* discoverClaudeCodeJsonl(
  config: ClaudeCodeJsonlConfig,
  opts: DiscoverOptions,
): AsyncIterable<TranscriptSession> {
  const root = resolveRoot(config);
  const projects = listProjects(root, config.project);

  let yielded = 0;
  for (const projectDir of projects) {
    const sessionPaths = listSessions(projectDir, config.sessionId);
    const projectSlug = projectSlugFromPath(projectDir);

    for (const sessionPath of sessionPaths) {
      if (typeof opts.limit === "number" && yielded >= opts.limit) return;

      let body: string;
      try {
        body = readFileSync(sessionPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseClaudeJsonl(body);
      if (parsed.messages.length === 0) continue;

      const startTs = parsed.startTs ?? "1970-01-01T00:00:00.000Z";
      const endTs = parsed.endTs ?? startTs;

      if (opts.since && startTs < opts.since) continue;

      const session: TranscriptSession = {
        source: "claude-code-jsonl",
        sessionId: sessionIdFromPath(sessionPath),
        project: projectSlug,
        startTs,
        endTs,
        messageCount: parsed.messages.length,
        messages: parsed.messages,
        sourceRef: sessionPath,
      };
      yielded += 1;
      yield session;
    }
  }
}
