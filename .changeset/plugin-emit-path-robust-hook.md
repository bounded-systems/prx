---
"@bounded-systems/prx": patch
---

`plugin emit`: route the capability `PreToolUse` hook through a bundled resolver
script (`bin/prx-policy-guard.sh`) instead of a bare `prx hook policy-guard`.

The bare command is PATH-dependent: when Claude Code is launched from a GUI /
Spotlight / launchd context (not a shell), the hook subprocess can inherit a
minimal PATH without `~/.local/bin`, so `prx` resolves to "command not found"
and the policy guard silently stops enforcing. The resolver finds `prx` by PATH
first, then common install locations (`$XDG_BIN_HOME`/`~/.local/bin`, homebrew,
`/usr/local/bin`, the nix system profile), mirroring the monitor's existing
`${CLAUDE_PLUGIN_ROOT}` script pattern. Surfaced by dogfooding the emitted
plugin against the v0.3.1 binary.
