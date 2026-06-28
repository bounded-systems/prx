---
"@bounded-systems/prx": patch
---

Route `prx ghapp serve` in the CLI (cli.ts) — the ghappd-box entrypoint runs `/bin/prx ghapp serve`, but the verb was registered without a dispatch case, so the door daemon crashed at deploy with "Unknown subcommand: ghapp". Adds the route + a regression guard (box-verbs-routed.test.ts) asserting box/daemon entrypoint verbs (ghapp serve, pod up, pod secrets) are CLI-reachable, not just registered — the bug bit three times.
