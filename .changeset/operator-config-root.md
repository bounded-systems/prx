---
"@bounded-systems/prx": patch
---

GH-411 slice 1: introduce a deployment-neutral operator-config root resolver
(`operatorConfigRoot()` in `operator-config.ts`) and route the overlay-path
resolution (`pr-state/github.ts`) and the wt-hook override resolution
(`tools/run_hook.ts`) through it. New env names — `PRX_OPERATOR_CONFIG_ROOT`
(runtime) and `BAKED_OPERATOR_CONFIG_ROOT` / `__PRX_BUILD_OPERATOR_CONFIG_ROOT__`
(baked) — take precedence, with the old `PRX_AI_HOME_ROOT` / `BAKED_AI_HOME_ROOT`
/ `PRX_COMPILE_AI_HOME_ROOT` kept as deprecated aliases for one release so the
nix wrapper and existing binaries keep working unchanged. First step toward
running prx standalone without the hardcoded `ai-home` deployment repo.
