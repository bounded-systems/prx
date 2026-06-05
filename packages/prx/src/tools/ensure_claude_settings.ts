/**
 * ensure-claude-settings — idempotently stamp the per-worktree
 * `<repoRoot>/.claude/settings.json` from the canonical template at
 * `<aiHomeRoot>/claude/worktree-settings.json` (GH-593).
 *
 * The user-scope `claude/settings.json` (deployed to ~/.config/claude/) covers
 * global concerns (hooks, statusLine, enabledPlugins). The project-scope
 * `<repoRoot>/.claude/settings.json` is strictly the permissions allow/deny
 * block. This module owns that file: when content drifts from the canonical
 * template, the hook re-stamps it. Hand edits get clobbered by design.
 *
 * The handler never touches `<repoRoot>/.claude/settings.local.json`, which is
 * a per-user Claude scratch surface.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { rewriteFileAtomic } from "./atomic_file.ts";

export type EnsureClaudeSettingsOptions = {
  /** Resolved repo root (`git rev-parse --show-toplevel`). */
  repoRoot: string;
  /**
   * ai-home flake root. The canonical template is read from
   * `<aiHomeRoot>/claude/worktree-settings.json`. When null, the hook is a
   * no-op (best-effort contract — non-flake shells must not fail).
   */
  aiHomeRoot: string | null;
};

export type EnsureClaudeSettingsResult = {
  /** Resolved per-worktree settings path. */
  targetPath: string;
  /** Resolved canonical source path, even when missing. */
  sourcePath: string | null;
  /** True iff this invocation wrote the target. */
  wrote: boolean;
  /** Why the handler did or didn't write. */
  reason: "wrote" | "unchanged" | "no-source";
};

export function ensureClaudeSettings(
  opts: EnsureClaudeSettingsOptions,
): EnsureClaudeSettingsResult {
  const { repoRoot, aiHomeRoot } = opts;
  const targetPath = join(repoRoot, ".claude", "settings.json");

  if (!aiHomeRoot || aiHomeRoot.length === 0) {
    return { targetPath, sourcePath: null, wrote: false, reason: "no-source" };
  }
  const sourcePath = join(aiHomeRoot, "claude", "worktree-settings.json");
  if (!existsSync(sourcePath)) {
    return { targetPath, sourcePath, wrote: false, reason: "no-source" };
  }

  const canonical = readFileSync(sourcePath, "utf8");
  // Read + rewrite the target through one descriptor (rewriteFileAtomic)
  // rather than existsSync-then-read-then-write (CodeQL js/file-system-race).
  const result = rewriteFileAtomic(targetPath, (current) =>
    current === canonical ? null : canonical,
  );
  return {
    targetPath,
    sourcePath,
    wrote: result.wrote,
    reason: result.wrote ? "wrote" : "unchanged",
  };
}
