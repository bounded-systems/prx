---
---

internal: add a per-verb deps seam to VerbSpec and migrate `prx stately`
(a.k.a. `model stately`) off the cli.ts monolith to use it. `VerbSpec` gains an
optional `deps()` slice (real implementations) threaded into `run`, replacing
the cli.ts 188-field `CliDeps` bag one verb at a time — a test passes its own
slice straight to `run`. `stately` is the first deps-bearing verb: its
clipboard/open side effects move to a `StatelyDeps` slice; `copyToClipboard` /
`openAfterEnter` move to the cli-spawn leaf and leave `CliDeps` (along with the
dead `openUrl`). Behavior and output are unchanged. No package change.
