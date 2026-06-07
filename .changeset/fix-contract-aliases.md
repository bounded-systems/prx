---
---

fix: restore the `contract status` / `contract transition` / `contract skills` /
`contract open-mode` alias paths. When those verbs became spec-driven, the
`contract <sub>` namespace aliases stopped resolving — the early VerbSpec
dispatch keys off the raw `argv[0]` (`contract`), not the normalized rewrite, so
the aliases fell through to the deleted legacy handlers. Route them through the
early dispatch. No package change.
