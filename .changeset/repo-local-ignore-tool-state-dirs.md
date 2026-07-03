---
"@bounded-systems/prx": patch
---

`prx repo local`/`--everywhere` no longer surfaces third-party tool-state
trees as noise: `cursor-home`, `codex-home`, `gitkraken-home`, `rbenv-home`,
`asdf`, generic `cache` dirs (act/trunk/sorbet-typed style CI/lint tool
caches), and Claude's plugin `marketplaces` directory are now skipped by
`ignoredDirs`, each with an inline comment explaining why. These are
home-manager-deployed app-support/plugin-cache trees the owning tool
manages with its own git internals, not user repos.
