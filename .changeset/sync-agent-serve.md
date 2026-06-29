---
"@bounded-systems/prx": minor
---

Add the sync agent (`prx sync serve`, prx-697): a long-running daemon that every
`--interval` seconds runs the existing cross-repo reconcile orchestrators
(`runBeadsSyncAcrossRepos` beads↔GH + `runDoltReconcileAcrossRepos` dolt
push/pull) over the repo inventory — so beads durability no longer depends on a
hand-run sync. Best-effort per tick (per-repo failures self-isolate; a pass-level
throw is swallowed + logged, like beadsd's refresh). The blocking prerequisite
for prx-82b (remove host bd). No socket in v1 — it's a periodic orchestrator, not
a request daemon.
