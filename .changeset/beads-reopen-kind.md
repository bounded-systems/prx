---
"@bounded-systems/prx": patch
---

Add the `reopen` kind to the beadsd write surface (GH-296 wave 2) — contract + daemon (`bd reopen <id>`, an allowed subcommand so it dispatches directly, unlike the policy-blocked `close`) + `reopenBeadViaDaemon` helper + `prx beads reopen <id>` CLI. This completes the **atomic** write contract (create / update / close / reopen); bulk reconcilers (promote / drift-fix) are left to a future sync agent.
