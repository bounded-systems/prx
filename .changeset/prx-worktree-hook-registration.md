---
"@bounded-systems/prx": patch
---

feat(workspace): prx registers its own `claude --worktree` hooks in settings.local.json (prx-5q3)

Follow-up to prx-6jb (the `prx workspace worktree-create|worktree-remove` verbs):
prx now owns the *registration* too, with no ai-home / `home-manager switch`
dependency. Hooks are written to `.claude/settings.local.json` — the per-user
surface prx already manages and the per-worktree stamper never clobbers — not
project `.claude/settings.json`, which stays permissions-only by design.

- `ensureClaudeWorktreeHooks(cwd)` (machine/claude_local_settings.ts): idempotent
  merge of the `WorktreeCreate`/`WorktreeRemove` hook block (pointing at the prx
  verbs) into `settings.local.json`; preserves other hooks/permissions; refuses
  to stomp malformed JSON.
- `prx workspace worktree-hooks`: register the hooks in the current worktree —
  the one-shot for a root/existing worktree the workspace actor won't touch
  (`mainx` is I-WS5 guarded).
- Self-propagation: `prx workspace worktree-create` now arms the newly
  materialized worktree's `settings.local.json` (best-effort — never aborts
  creation), so a `claude --worktree` launched from inside it also routes
  through prx.

Activation still requires a release that ships the verbs (the installed prx is a
release binary). Replaces the ai-home-registration framing of prx-5q3.
