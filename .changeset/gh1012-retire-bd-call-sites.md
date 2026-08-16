---
"@bounded-systems/prx": minor
---

Retire the last live `bd` call sites in the `prx init` / `prx sync-issues` flow
(GH-1012, beads removal — phase 4 follow-through). `ensureBeadsInitSetup` no
longer probes/initializes a bd workspace (10 `bd` spawns); it now answers with
the retired-plane skip (`beads-removed (GH-1012): …`), which `prx init` and
`prx sync-issues --apply` render as before. `syncGitHubIssuesToBeads` drops the
`bd config get/set github.repository` pre-step (2 spawns) — the canonical
reconcile (`runBeadsSync`, GH-2011) resolves the repo from the git remote
itself. `resolveEpicChildBdIds` loses its door-backed `bd list` / `bd children`
fallback (2 spawns) and reads Front Desk only. Also deleted as dead code: the
unreachable `runBeadsInit` driver (no verb dispatched it) and the
`canonicalBeadsRepoIdFromRemote` / `canonicalBeadsDatabaseName` helpers that
only served the removed init path.
