---
---

Bump `@bounded-systems/bd` to `^0.3.0` (the bd-safe guard fix) and wire its
`localPrefix` through beadsd. `prx beads serve` resolves the served clone's bd
`issue_prefix` once at startup (via `diagnoseBeads`) and passes it as the
daemon's `localPrefix`; `handleBeadsRequest` forwards it to `execBd`, so the
bd-safe I-BF1 guard admits NATIVE short ids (e.g. `prx beads show prx-716`,
`dep add` on all-digit children like prx-435/prx-523) while foreign surface refs
(`GH-1463`, other-workspace prefixes) stay refused (prx-3vow). An
unhealthy/prefixless clone leaves it unset so the guard keeps its refuse-all
default. No release.
