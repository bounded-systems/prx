---
"@bounded-systems/prx": patch
---

GH-411 slice 2: rename the internal overlay identifiers off `ai-home` now that
the resolver indirection (slice 1) is in place. `resolveAiHomeOverlayPath` →
`resolveOperatorOverlayPath` (`pr-state/github.ts`), and the `aiHomeRoot`
option field / locals → `overlayRoot` (`tools/run_hook.ts`,
`tools/ensure_claude_settings.ts`). Pure internal rename — no behavior, env, or
public-API change. Repo-identity literals (`bdelanghe/ai-home`) are slice 4.
