---
"@bounded-systems/prx": minor
---

Foreign-workspace signal for daemon-routed beads (prx-qmg). One daemon serves
one repo (GH-296), so a ref whose prefix is well-formed but not this daemon's
served prefix (e.g. `3qn-123`, `COMMERCE-456` against a `prx-*` daemon) can't
resolve here. `handleBeadsRequest` now short-circuits such refs with a clear
`foreign-workspace` error ("`3qn-123` isn't in this workspace — this daemon
serves `prx-*`") before spawning bd, for reads and writes alike — instead of a
generic not-found (read) or the bd-safe "resolve to canonical long id" refusal
(write). Uses the served prefix the daemon already knows (`deps.localPrefix`);
inert when no served prefix is wired. Cross-workspace routing remains out of
scope (signal only).
