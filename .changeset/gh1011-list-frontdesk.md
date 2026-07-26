---
"@bounded-systems/prx": minor
---

Repoint the aggregate work-item read (`bd list`) off beads onto Front Desk
(GH-1011). The BeadsCache-fed fleet (next-work enrichment, resolvers, plan/intake
search) and the `epic_children` surface now read the GH-canonical mirror via
`fds list` instead of shelling `bd list --all`. One choke point flips the fleet:
the beadsd daemon `{kind:"list"}` (and `{kind:"show"}`) case, which every loader
funnels through. Work items become GH-canonical (`id = GH-<n>`, `external_ref` =
the issue URL); `epic_children` + `resolveEpicChildBdIds` were rewritten to speak
GH numbers (closing GH-1010's deferred children half). Default source is
`frontdesk`; `PRX_LIST_SOURCE=bd` falls back to `bd list`. The bd sync/maintenance
readers (`loadAllBeads` in triage) stay on bd — they are retired wholesale in
GH-1012, not repointed.
