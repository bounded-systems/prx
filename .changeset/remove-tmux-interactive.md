---
"@bounded-systems/prx": patch
---

refactor: remove the interactive tmux/PTY session path (slice 3 of removing tmux entirely). prx sessions are now headless-only — `prx plan session`, `prx session open`, and `prx implement agent` no longer spawn or attach a durable tmux session; the live session runs directly in the foreground terminal (stdio-inherit) and the implement path runs the headless SDK job in-process. The `prx review` / `prx ultrareview` send-keys verbs (which only existed to inject `/review` into the live tmux pane) and the internal `prx tools mux clear-resurrect` verb are removed, along with the `pr-state/surfaces/tmux.ts` surface reader and the `--interactive`/`--headless` flags on `prx implement agent` (headless is the only mode). The `@bounded-systems/prx-mux` package itself is removed in a later slice.
