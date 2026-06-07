---
"@bounded-systems/prx": patch
---

feat(beads): route the aggregate bead read through the daemon by default (GH-296)

The per-invocation `BeadsCache` — threaded by runCli into every read verb (sync,
intake, triage, scout, adapters) — now reads through the daemon (the GH-296 one
true source) instead of spawning host `bd list` against the broken per-clone
`.beads`. This flips the production aggregate-read path off host bd in a single
move (prx-fda).

- New `triage/beads-daemon-loader.ts` `loadAllBeadsViaCli`: a SYNC
  `prx beads list --all --limit 0` spawn (same daemon query as
  `loadAllBeadsViaDaemon`: `{kind:"list", all:true, limit:0}`), parsed with the
  existing `parseBeadsRecords`. Sync on purpose — `loadAllBeads`/`BeadsCache.load`
  are called deep inside sync verb code, so a subprocess avoids an async ripple
  across ~24 call sites. Recursion-safe (`prx beads list` reads via the socket
  door, not this cache). Fail-loud on an unreachable daemon — never silently
  reports zero beads. Honors a `prxBinary` override for non-PATH invocation.
- `createBeadsCache` defaults to this daemon loader; an injected `loadAllBeads`
  (tests, or an explicit local-bd loader) still wins and receives `exec`.

A step toward removing host bd (prx-82b): the bulk WRITE reconcilers and any
no-cache `?? defaultLoadAllBeads` fallbacks remain on bd and are the next steps.
