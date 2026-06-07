---
"@bounded-systems/prx": patch
---

Add `prx beads create|update|close` — the single-writer surface routed through beadsd (GH-296 wave 2). Like the read door, no `--vm` ⇒ local daemon (auto-started), `--vm` ⇒ the in-VM daemon. beadsd dispatches writes under the planner role/state so bd's policy allows them (it's the trusted single writer; per-caller authority is gated at the `prx beads` invocation layer). This gives humans and agents a working write path that targets the one canonical beads instead of a worktree's broken local `.beads`.
