import { getEnv } from "@bounded-systems/env";
import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { type RuntimeProfileProjection } from "../machine/runtime_profiles.ts";

// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules.

type CodexSessionMeta = {
  id: string;
  cwd: string;
  timestamp: string;
};

function codexHomePath(): string | null {
  const configured = getEnv("CODEX_HOME")?.trim();
  if (configured) {
    return configured;
  }
  const home = getEnv("HOME")?.trim();
  return home ? join(home, ".codex") : null;
}

function listCodexSessionFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCodexSessionFiles(path));
      continue;
    }
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function readCodexSessionMeta(path: string): CodexSessionMeta | null {
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0]?.trim();
    if (!firstLine) {
      return null;
    }
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown };
    };
    if (parsed.type !== "session_meta") {
      return null;
    }
    if (
      typeof parsed.payload?.id !== "string" ||
      typeof parsed.payload.cwd !== "string" ||
      typeof parsed.payload.timestamp !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.payload.id,
      cwd: parsed.payload.cwd,
      timestamp: parsed.payload.timestamp,
    };
  } catch {
    return null;
  }
}

function slugifyClaudeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function claudeProjectsRoot(homeDir = getEnv("HOME")?.trim()): string | null {
  return homeDir ? join(homeDir, ".claude", "projects") : null;
}

export function findSavedClaudeSession(
  launchCwd: string,
  homeDir = getEnv("HOME")?.trim(),
): boolean {
  const root = claudeProjectsRoot(homeDir);
  if (!root) {
    return false;
  }
  const projectDir = join(root, slugifyClaudeProjectPath(launchCwd));
  if (!existsSync(projectDir)) {
    return false;
  }
  let entries;
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    try {
      const stats = statSync(join(projectDir, entry.name));
      if (stats.size > 0) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function findSavedCodexSession(
  workUnitId: string,
  launchCwd: string,
  homePath = codexHomePath(),
): CodexSessionMeta | null {
  if (!homePath) {
    return null;
  }
  const sessionsRoot = join(homePath, "sessions");
  const matches = listCodexSessionFiles(sessionsRoot)
    .map((path) => readCodexSessionMeta(path))
    .filter((meta): meta is CodexSessionMeta => meta !== null)
    .filter((meta) => meta.cwd === launchCwd || basename(meta.cwd) === workUnitId)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  return matches[0] ?? null;
}

export function resolveCodexSessionProfile(
  profile: RuntimeProfileProjection,
  workUnitId: string,
  launchCwd: string,
): { profile: RuntimeProfileProjection; message: string | null } {
  if (profile.command !== "codex" || profile.args[0] !== "resume" || !profile.fallbackArgs) {
    return { profile, message: null };
  }

  const saved = findSavedCodexSession(workUnitId, launchCwd);
  if (!saved) {
    return {
      profile: {
        ...profile,
        args: [...profile.fallbackArgs],
      },
      message: `No saved Codex session for ${workUnitId}; starting a fresh session instead.`,
    };
  }

  const args = [...profile.args];
  args[5] = saved.id;
  return {
    profile: {
      ...profile,
      args,
    },
    message: null,
  };
}


