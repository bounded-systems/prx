---
---

internal: raise the per-file coverage ratchet floor from 80% to 85%. Every
in-scope `src/**` file now must hit 85% unless it's in the (shrink-only)
PER_FILE_BASELINE, which holds the eight legitimately-deferred files
(deprecated TUI, the mid-decomposition `cli.ts`/`cli-spawn.ts`, the
#502-pending headless-actor triage files, the large `session/open.ts`, and the
spawn-bound `agent_doctor.ts`). Global floor stays at 85% (currently 88.3%).
