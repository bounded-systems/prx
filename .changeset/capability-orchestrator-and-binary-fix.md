---
"@bounded-systems/prx": patch
---

Capability-poor orchestrator, beads-native pipeline, and the compiled-binary audit-DB fix.

- **fix(audit):** embed `schema.sql` into the `bun --compile` binary — fixes the `ENOENT /$bunfs/root/schema.sql` that broke every audit-DB command (e.g. `prx services status --anthropic`) in the released binary (prx-eky).
- **feat(submit):** beads-native submit / publish / merge — a beads work unit can travel intake → merged PR (no longer GitHub-issue-only).
- **feat(agents):** capability-poor orchestrator — actor sub-agents generated from the policy table, a PreToolUse policy hook that denies any command a role doesn't own, orphan-effect provenance verification, and the intake⊗actor salt + ephemeral salted worktrees for per-actor isolation.
- **feat(commands):** `/prx <unit>` — drive a work unit through the pipeline (plan → implement → submit → merged PR), capability-scoped and delegating to prx's actors.
- **chore:** automatic GitHub-issue tracking (`intake --to gh` + `Closes #N`/postmerge); value-props + `STATUS.md`; capability ownership/approval `.feature` audit surfaces.
