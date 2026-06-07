---
"@bounded-systems/prx": patch
---

refactor: remove the `prx tmux reconcile` verb and its config-drift wiring (slice 1 of removing tmux entirely). Drops the tmux `gc` component/driver and the tmux reconcile embedding in `prx home update`. The reconcile path only existed to converge a live tmux server against rendered home-manager config; with tmux on its way out (headless-first + session-host substrate) it has no replacement. Interactive sessions, the parity surface, and the `prx-mux` package are removed in later slices.
