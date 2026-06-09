/**
 * Per-worktree .claude/settings.local.json helper.
 *
 * Used by `prx session open` / `prx plan session` (interactive work-unit
 * sessions) and by `prx intake|triage session` (mainx operator sessions).
 * Those runtime profiles spawn claude with `--setting-sources project,local`,
 * so this file — if present in the launch cwd — feeds the session's
 * permission allowlist. We pre-approve the session's own scoped verbs so they
 * skip the per-command permission prompt — and the auto-mode classifier —
 * once the operator ratchets out of plan mode:
 *
 *  - work-unit sessions get `Bash(prx:*)` (the operator's single surface);
 *  - intake/triage operator sessions get exactly the `Bash(…)` subset of
 *    their session profile's `--allowedTools` (GH-1545), so the verbs the
 *    profile already grants at the flag layer are also static-allowed and the
 *    classifier is never the gatekeeper for the session's core verbs.
 *
 * Scope is strictly the session's own verbs: nothing broader than what the
 * profile already permits. Raw git/gh/bd/wt stay on the permission-prompt path
 * unless the profile explicitly lists them (triage lists `bd`/`gh issue`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SESSION_PROFILES, type SessionProfileName } from "./runtime_profiles.ts";
import { buildWorktreeHookSettings } from "../workspace/worktree-hook.ts";

export const PRX_BASH_ALLOW_PATTERN = "Bash(prx:*)";
export const CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH = ".claude/settings.local.json";

/** The prx verbs Claude Code's `--worktree` hooks invoke (prx-6jb). */
export const WORKTREE_CREATE_HOOK_COMMAND = "prx workspace worktree-create";
export const WORKTREE_REMOVE_HOOK_COMMAND = "prx workspace worktree-remove";

export type EnsureClaudeAllowlistStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped-malformed";

export type EnsureClaudeAllowlistResult = {
  status: EnsureClaudeAllowlistStatus;
  path: string;
};

type SettingsShape = Record<string, unknown> & {
  permissions?: Record<string, unknown> & {
    allow?: unknown;
  };
  hooks?: Record<string, unknown>;
};

/**
 * Ensure the worktree's `.claude/settings.local.json` contains every entry in
 * `patterns` under `permissions.allow`. Creates the file (and parent
 * `.claude/` dir) if missing. Merges any missing patterns into an existing
 * allow list without discarding unrelated keys or entries; existing
 * non-string entries are preserved verbatim.
 *
 * Returns `skipped-malformed` without writing if the existing file is present
 * but not a JSON object — we refuse to stomp on user edits.
 */
export function ensureClaudeAllowlistPatterns(
  cwd: string,
  patterns: readonly string[],
): EnsureClaudeAllowlistResult {
  const absPath = join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH);

  // Read once instead of existsSync-then-read: a missing file surfaces as a
  // read error here, avoiding the check→use TOCTOU window (CodeQL
  // js/file-system-race).
  let raw: string | null = null;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    raw = null;
  }

  if (raw === null) {
    mkdirSync(dirname(absPath), { recursive: true });
    const fresh: SettingsShape = {
      permissions: { allow: [...patterns] },
    };
    writeFileSync(absPath, `${JSON.stringify(fresh, null, 2)}\n`);
    return { status: "created", path: absPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "skipped-malformed", path: absPath };
  }
  if (!isPlainObject(parsed)) {
    return { status: "skipped-malformed", path: absPath };
  }

  const settings = parsed as SettingsShape;
  const existingPermissions = isPlainObject(settings.permissions) ? settings.permissions : {};
  const existingAllow: unknown[] = Array.isArray(existingPermissions.allow)
    ? (existingPermissions.allow as unknown[])
    : [];

  const present = new Set(
    existingAllow.filter((entry): entry is string => typeof entry === "string"),
  );
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (missing.length === 0) {
    return { status: "unchanged", path: absPath };
  }

  const nextSettings: SettingsShape = {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow: [...existingAllow, ...missing],
    },
  };
  writeFileSync(absPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return { status: "updated", path: absPath };
}

/**
 * Ensure `Bash(prx:*)` is pre-approved for an interactive work-unit session.
 */
export function ensureClaudeInteractiveAllowlist(cwd: string): EnsureClaudeAllowlistResult {
  return ensureClaudeAllowlistPatterns(cwd, [PRX_BASH_ALLOW_PATTERN]);
}

/**
 * The `Bash(…)` subset of `SESSION_PROFILES[profile].allowedTools` — the
 * patterns that belong in `permissions.allow`. Bare tool names (`Read`,
 * `Grep`, `Glob`, `Edit`, `Write`) are already governed by the launch-time
 * `--allowedTools` flag and aren't permission-prompt patterns, so they're
 * filtered out.
 */
export function sessionProfileBashAllowPatterns(profile: SessionProfileName): string[] {
  return SESSION_PROFILES[profile].allowedTools.filter((tool) => tool.startsWith("Bash("));
}

/**
 * Ensure the `Bash(…)` subset of an operator session profile's allowlist
 * (`prx intake|triage session`) is pre-approved in
 * `.claude/settings.local.json`, so the session's core verbs skip the
 * per-command prompt — and the auto-mode classifier — once the operator
 * leaves plan mode (GH-1545).
 */
export function ensureClaudeSessionProfileAllowlist(
  cwd: string,
  profile: SessionProfileName,
): EnsureClaudeAllowlistResult {
  return ensureClaudeAllowlistPatterns(cwd, sessionProfileBashAllowPatterns(profile));
}

/**
 * Ensure the worktree's `.claude/settings.local.json` registers prx's
 * `WorktreeCreate`/`WorktreeRemove` hooks (prx-5q3), so `claude --worktree`
 * routes isolation through prx's worktree lifecycle (the verbs from prx-6jb)
 * instead of Claude's default `git worktree add` — which can't handle the
 * bare-repo + external-worktree layout.
 *
 * Registration lives in `settings.local.json` (not project `settings.json`,
 * which is permissions-only by design) because it is the per-user surface prx
 * already owns and the per-worktree stamper never clobbers. Idempotent: only
 * the two worktree hook events are set (other hooks/keys are preserved); a file
 * already carrying them returns `unchanged`. Refuses to stomp malformed JSON.
 */
export function ensureClaudeWorktreeHooks(cwd: string): EnsureClaudeAllowlistResult {
  const absPath = join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH);
  const desired = buildWorktreeHookSettings(
    WORKTREE_CREATE_HOOK_COMMAND,
    WORKTREE_REMOVE_HOOK_COMMAND,
  ).hooks;

  let raw: string | null = null;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    raw = null;
  }

  if (raw === null) {
    mkdirSync(dirname(absPath), { recursive: true });
    const fresh: SettingsShape = { hooks: { ...desired } };
    writeFileSync(absPath, `${JSON.stringify(fresh, null, 2)}\n`);
    return { status: "created", path: absPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "skipped-malformed", path: absPath };
  }
  if (!isPlainObject(parsed)) {
    return { status: "skipped-malformed", path: absPath };
  }

  const settings = parsed as SettingsShape;
  const existingHooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const alreadyPresent =
    JSON.stringify(existingHooks.WorktreeCreate) === JSON.stringify(desired.WorktreeCreate) &&
    JSON.stringify(existingHooks.WorktreeRemove) === JSON.stringify(desired.WorktreeRemove);
  if (alreadyPresent) {
    return { status: "unchanged", path: absPath };
  }

  const nextSettings: SettingsShape = {
    ...settings,
    hooks: {
      ...existingHooks,
      WorktreeCreate: desired.WorktreeCreate,
      WorktreeRemove: desired.WorktreeRemove,
    },
  };
  writeFileSync(absPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return { status: "updated", path: absPath };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
