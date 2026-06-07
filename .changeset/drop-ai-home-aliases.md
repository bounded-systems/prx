---
"@bounded-systems/prx": minor
---

GH-411 slice 5 (finale): **remove the deprecated `ai-home` env-name aliases** and
flip the nix home-manager module to the neutral name. Breaking, by design.

- `operator-config.ts` / `build-info.ts` / `prx-compile.ts`: drop the
  `PRX_AI_HOME_ROOT`, `BAKED_AI_HOME_ROOT`, `__PRX_BUILD_AI_HOME_ROOT__`, and
  `PRX_COMPILE_AI_HOME_ROOT` read-aliases. Only the neutral names
  (`PRX_OPERATOR_CONFIG_ROOT` / `BAKED_OPERATOR_CONFIG_ROOT` /
  `__PRX_BUILD_OPERATOR_CONFIG_ROOT__` / `PRX_COMPILE_OPERATOR_CONFIG_ROOT`) are
  read now.
- `nix/hm-module.nix`: the `programs.prx.aiHomeRoot` option →
  `programs.prx.operatorConfigRoot` (exports `PRX_OPERATOR_CONFIG_ROOT`).

**Breaking — consumer action required.** Any home-manager config that sets
`programs.prx.aiHomeRoot` must rename it to `programs.prx.operatorConfigRoot`,
and any shell/env that exported `PRX_AI_HOME_ROOT` must export
`PRX_OPERATOR_CONFIG_ROOT`. Without the rename, `home-manager switch` fails with
an unknown-option error.
