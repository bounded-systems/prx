---
"@bounded-systems/prx": patch
---

`prx beads list` now accepts `--all` and `--limit <n>` (GH-296), exposing the aggregate read the wire contract already supported (`list { all, limit }`). `prx beads list --all --limit 0` returns every record across statuses — the shape the bulk readers need. First step of routing the bulk readers through the daemon (epic prx-697 / prx-fda).
