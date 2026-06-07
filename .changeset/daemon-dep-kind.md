---
"@bounded-systems/prx": patch
---

feat(beadsd): add a `dep` write kind to the daemon (GH-296)

The daemon write contract gains a structured `dep` kind —
`bd dep add --type <t> <from> <to>` / `bd dep remove <from> <to>` — threaded
through the wire contract, the daemon dispatch (with a special-case: `bd dep` is
not a `--json` surface, so a zero exit replies ok/null), a `depViaDaemon` helper,
and a `prx beads dep add|remove` CLI. This is the last missing daemon write
capability; it unblocks the dependency-edge reconcilers still on host bd
(promote-children parent-child wiring, dedupe edge rewire) — toward prx-82b.
