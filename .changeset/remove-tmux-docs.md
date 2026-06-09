---
"@bounded-systems/prx": patch
---

docs: scrub remaining tmux references after the full tmux removal (slice 5). Updates the agent-session command descriptions (`--interactive for PTY`, no longer "tmux/PTY"), drops the deleted `prx-mux` package from the companion-repos extraction table and the roadmap wave list, refreshes the pipeline-orchestrator "No tmux" note to reflect that tmux is gone entirely (surface, actor, interactive attach, and the `prx-mux` package), and regenerates the derived docs (cli.md, README, jsonld, project.md). Historical design records (the GH-1836 substrate ADR) are left intact.
