---
"@bounded-systems/prx": patch
---

Gate the `resolveEpicChildBdIds` epic-children reads through the beadsd door (prx-zbsi, consumer of the `children` verb added in #613). The `--epic` delegate filter resolved an epic's children with two ungated `bd` spawns — `bd query "external_ref contains <epic>"` then `bd children <id>`. Now:

- The epic lookup uses the door-backed `bd list --all` with an in-process `external_ref` substring match (`bd query` is not on the beadsd read surface; the substring match preserves the old behavior for both the issue URL and the legacy `GH-N` token).
- The children read routes through the door-backed `bd children <id>` verb.

Both reads go through a shared `bdReadOrNull` door-gate helper (also adopted by `readBdLabels`, de-duplicating the inline gate): in the box profile they reach the beadsd door; off-profile they fall back to `tryCommand` (null-on-failure preserved). The child-id extraction tolerates both the real `bd children` row shape and the door verb's `bd dep list --type parent-child` rows (both carry the child id in `id`).

`findEpicChildren` (epic_children.ts, `bd dep list`) is the remaining epic-children consumer and is a separate follow-up.
