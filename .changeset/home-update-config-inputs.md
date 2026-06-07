---
"@bounded-systems/prx": patch
---

GH-411 slice 3: make the `prx home update` / `prx upgrade` coupled flake-input
set config-driven instead of hardcoding `ai-home`. The default now reads
`homeUpdate.inputs` from `~/.config/prx/config.json` (e.g. `["prx", "ai-home"]`),
falling back to `["prx"]` when unconfigured — prx always updates its own input.
`prx upgrade` is now a thin pass-through (no baked `--input prx,ai-home`); an
explicit `--input` / `PRX_HOME_FLAKE_INPUT` still overrides. Also resolves #21
(home update now includes `prx`, not just the consumer).

Operator note: to keep `prx upgrade` bumping the consumer flake, add
`{"homeUpdate": {"inputs": ["prx", "ai-home"]}}` to `~/.config/prx/config.json`.
