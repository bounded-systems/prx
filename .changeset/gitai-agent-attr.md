---
"@bounded-systems/prx": patch
---

Add `programs.prx.gitAiAgent` to the home-manager module: tag prx-routed Claude sessions for git-ai (prx-q9yj).

When `gitAiAgent.enable = true`, the prx launcher (and `slack-scout`) exports
`GIT_AI_CUSTOM_ATTRIBUTES`. git-ai reads this and persists it into the authorship
note, so commits authored through the prx wrapper carry `agent=prx` while raw
`claude` invocations stay untagged — making prx adoption (and write-door bypass)
measurable from git history.

- **nix/hm-module.nix** — new `gitAiAgent.{enable, agent, extraAttributes}` option;
  appends `export GIT_AI_CUSTOM_ATTRIBUTES=<json>` to the launcher's injected env.
  The object is `{ agent; version; } // extraAttributes` with the pinned release
  `version` baked from `bins.version` (a runtime export could not know it). Opt-in
  (default off), consistent with the module's other knobs. `door` is omitted —
  it is runtime state, not known at eval time.
