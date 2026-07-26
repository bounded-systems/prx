---
"@bounded-systems/prx": minor
---

Beads-removal follow-up cleanup (GH-1022/1023/1024):
- Remove the dead `prx beads update` subprocess back-write from fetch/gh-issues-writer
  and drop `"bd"` from `SYNC_MIRROR_DOMAINS` (GH-1022).
- Excise the triage XState machine's promote/drift-fix no-op stubs (`promoteActor`,
  `driftFixActor`) and their states; re-point the machine to a `scopeDecision`
  pseudo-state (GH-1023).
- Remove the last `"beads"` from the type system (GH-1024): the `Surface` enum,
  the `--from`/source-pin `WorkUnitSource` enum, `spec/schema.cue` `#Surface`, and
  the `kind = "github" | "notion"` help/error strings; drop the now-dead
  `--from=beads` create arm.

(Deferred to #1024: the residual inert `beads` *actor* / `beads_issue` / hydrateBeads
no-op surface, and the broader Notion-integration removal decision.)
