---
---

Adopt the org Claude harness baseline through the `buildClaudeSettings`
generator (drift sentinel) rather than a static `.claude/settings.json`, and
keep the org SessionStart context hook out of the public `prx init` scaffolder.
No-release change (CI/tooling + repo-local settings only).
