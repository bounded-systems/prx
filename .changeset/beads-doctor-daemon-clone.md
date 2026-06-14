---
"@bounded-systems/prx": patch
---

`prx beads doctor` now diagnoses the canonical daemon clone (`defaultCanonicalBeadsCwd()`, `~/.local/state/prx/beads`) instead of the process cwd. A daemon-served repo (the GH-296 one-true-source model) has no local `.beads/`, so the old cwd probe misread "no beads database found" as a false UNHEALTHY "issue_prefix not set", and `--fix` no-op'd with "did not restore a prefix". The doctor now matches every other `prx beads` verb (mirrors `beads-provision`); an explicit `--cwd` still overrides for the GH-228 worktree-clone case.
