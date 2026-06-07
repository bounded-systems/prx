---
---

internal: VerbSpec `parseArgs` now accumulates repeated array-typed flags
(`--k a --k b`) in addition to comma-splitting (`--k a,b`), and the two forms
compose — matching the legacy dispatcher's `multiple: true` options. Unblocks
migrating handlers with repeatable list flags (e.g. `protect-main`'s `--allow` /
`--require-status-check`). No package change.
