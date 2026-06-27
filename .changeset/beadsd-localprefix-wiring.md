---
---

`prx beads serve` now resolves its served clone's bd `issue_prefix` once at
startup (via `diagnoseBeads`) and exports it as `PRX_BEADS_PREFIX` for the
daemon process. Every `execBd` in `handleBeadsRequest` then reads it through its
default env, so a bd-safe build that honors `PRX_BEADS_PREFIX` admits NATIVE
short ids (e.g. `prx beads show prx-716`, `dep add` on all-digit children) past
the I-BF1 guard while foreign refs stay refused (prx-3vow). Forward-compatible:
a bd that predates the env var simply ignores it, and an unhealthy/prefixless
clone leaves it unset so the guard keeps its safe refuse-all default. Activates
end to end once `@bounded-systems/bd` is bumped to the build carrying the guard
fix. No release.
