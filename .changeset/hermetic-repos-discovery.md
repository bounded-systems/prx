---
---

tests only: isolate `HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME` in the
repos-discovery tests (`pr-state/repos.test.ts`, `pr-state/materialize.test.ts`)
so `loadRepoInventoryConfig` can't fall back to the operator's real
`~/.config/prx` + `~/.local/state/prx` index. Fixes two local-only failures
(green in CI's clean HOME, red on a dev box). No package change.
