---
"@bounded-systems/prx": patch
---

CI cutover to the bucketed apps (prx-zee7 Phase 5): version.yml mints from prx-forge (PRX_FORGE_APP_ID/PRX_FORGE_APP_PRIVATE_KEY) to push the release branch + open the PR; front-desk-add mints from prx-projects (PRX_PROJECTS_APP_ID/PRX_PROJECTS_APP_PRIVATE_KEY) for the add-to-project. Retires the CHANGESETS_*/FRONT_DESK_* credential names. Both steps stay fail-open (gated on the *_APP_ID var).
