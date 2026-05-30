/**
 * Project-scope Claude Code settings.json baseline (GH-1378 / GH-357).
 *
 * Single source of truth for the checked-in `.claude/settings.json`. The
 * builder returns the canonical object; the in-repo file is asserted to
 * match (test/init/claude_settings.test.ts) so drift between the two
 * fails the suite.
 *
 * Boundary with GH-593: this scaffolds at repo init (one-time, per-repo).
 * GH-593 stamps the file per-worktree on `wt switch`. The two surfaces do
 * not conflict — `prx init` ensures fresh repos carry the baseline from
 * the first commit; `wt switch` ensures every worktree has it at runtime.
 */

export type ClaudeSettings = {
  permissions: {
    allow: string[];
    deny: string[];
  };
};

export function buildClaudeSettings(): ClaudeSettings {
  return {
    permissions: {
      allow: [
        "Read(**)",
        "Grep(**)",
        "Glob(**)",
        "Bash(prx model:*)",
        "Bash(prx scout:*)",
        "Bash(prx routine:*)",
        "Bash(prx actions:*)",
        "Bash(prx contract:*)",
        "Bash(prx chain:*)",
        "Bash(prx repo:*)",
        "Bash(prx worktree:*)",
        "Bash(prx plan show:*)",
        "Bash(prx triage status:*)",
        "Bash(prx help:*)",
        "Bash(bun test:*)",
        "Bash(bun typecheck:*)",
        "Bash(gh issue view:*)",
        "Bash(gh pr view:*)",
        "Bash(gh pr checks:*)",
        "Bash(bd ready:*)",
        "Bash(bd list:*)",
        "Bash(bd show:*)",
        "Bash(bd blocked:*)",
        "Bash(bd memories:*)",
      ],
      deny: [
        "Bash(rm -rf:*)",
        "Bash(rm -fr:*)",
        "Bash(git push --force:*)",
        "Bash(git push --force-with-lease:*)",
        "Bash(git reset --hard:*)",
      ],
    },
  };
}

export function claudeSettingsJson(): string {
  return `${JSON.stringify(buildClaudeSettings(), null, 2)}\n`;
}
