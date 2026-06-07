---
"@bounded-systems/prx": patch
---

feat(beadsd): extend the daemon `update` write with `--external-ref` / `--notes` (GH-296)

The daemon write contract's `update` kind gained `externalRef` and `notes`
(both valid `bd update` flags) — threaded through the wire contract, the daemon's
`bd` dispatch, the `updateBeadViaDaemon` helper, and the `prx beads update` CLI
(which also now exposes the already-contracted `--type`). This is the Group-B
infra that unblocks the remaining bulk write reconcilers still on host bd: the
adapter mirror write-back and `prx beads publish` (`--external-ref`), and
intake-comment (`--notes`). No behavior change to existing callers — purely
additive optional fields. A step toward removing host bd (prx-82b).
