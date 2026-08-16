---
"@bounded-systems/prx": major
---

Remove beads (`@bounded-systems/bd`) entirely (GH-1012 — completes GH-1008). prx
no longer depends on beads for anything: reads come from Front Desk, writes create
GitHub issues. Deleted the beadsd daemon, the `beads/` bd-subcommand machinery, the
`prx beads` command tree, the triage bd-reconcilers, Notion, `sync run-cross-repo`,
intake-bd/mirror, and the `.beads/` + nix substrate; severed residual bd from the
surviving GitHub/Front-Desk core (github adapters, triage, ready/epic_children,
repo_gc, sync/run). `grep @bounded-systems/bd` in code is now zero.
