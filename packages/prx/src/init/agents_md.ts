/**
 * AGENTS.md template — portable cross-agent convention layer (GH-357).
 *
 * Read by Codex CLI (walks up to find AGENTS.md), GitHub Copilot, and any
 * agent that respects the AGENTS.md convention. It layers alongside
 * agent-native files (`CLAUDE.md`, `.codex/config.toml`, `GEMINI.md`,
 * `.cursor/rules/`) — those override AGENTS.md for the agents that read
 * them, but AGENTS.md is the baseline every conformant agent sees.
 *
 * Template renders deterministically (no timestamps, no env-derived
 * strings) so snapshot tests and `--force` idempotence checks are stable.
 */

const TEMPLATE = `# AGENTS.md

Portable cross-agent convention layer. Read by Codex CLI, GitHub Copilot,
and any agent that respects the AGENTS.md baseline. Layered alongside
agent-native files — those override what's here for the agent that reads
them; this file is the floor every conformant agent sees.

## PRX workflow

This repo uses **prx** as the operator surface. The promoted entry points:

- \`prx tui\` — interactive surface across worktrees + work units
- \`prx plan session GH-<n>\` — open a planning session for a work unit
- \`prx next\` — recommend the next action on the current work unit
- \`prx do\` — drive the recommended action
- \`prx review\` — surface review-readiness signals
- \`prx plan handoff\` — post-merge teardown / handoff to next work

Run \`prx help-all\` for the full subcommand catalog.

## Per-agent discovery knobs

| Agent          | Repo instructions                                 | Skills              | Override knobs                                                                    |
| -------------- | ------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| Claude Code    | \`CLAUDE.md\` / \`.claude/\`                          | \`.claude/skills/\`   | \`CLAUDE_CODE_DISABLE_AUTO_MEMORY\`, \`autoMemoryDirectory\`, \`--agents\`              |
| Codex CLI      | \`AGENTS.md\` (walks up)                            | \`.codex/skills/\`    | \`project_root_markers\`, \`-c k=v\`, \`model_instructions_file\`, \`perCwdExtraUserRoots\` |
| GitHub Copilot | \`.github/copilot-instructions.md\`, \`AGENTS.md\`    | —                   | \`COPILOT_CUSTOM_INSTRUCTIONS_DIRS\`                                                |
| Gemini CLI     | \`GEMINI.md\` (hierarchical)                        | —                   | \`GEMINI_CLI_HOME\`, \`GEMINI_SYSTEM_MD\`                                             |
| Cursor         | \`.cursor/rules/\`                                  | —                   | \`CURSOR_CONFIG_DIR\`, \`CURSOR_PROJECT_DIR\`                                         |

## Review expectations

Reviewers prioritize correctness, root-cause traces, and minimal scope.
Avoid speculative scope, bundled refactors, or unrelated cleanup. CI must
be green before a PR is marked ready for review.

## PR norms

Each PR is independent: no bundled or speculative changes, every changed
codepath is verified, every failure traced to root cause, no duplication,
no unrelated changes. The full checklist lives in the operator's
\`CLAUDE.md\` and is enforced at review time.
`;

export function buildAgentsMd(): string {
  return TEMPLATE;
}
