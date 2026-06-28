---
"@bounded-systems/prx": patch
---

Add the GitHub Apps architecture spec (docs/prx/github-apps-architecture.md): permission-bucketed apps (prx-forge / prx-projects / prx-signing) + per-use token attenuation, consumed by both CI (create-github-app-token) and runtime (ghappd-style bucket doors). Records that Front Desk == bounded-systems-prx (legacy secret name), and the migration off the union app + FRONT_DESK_*/CHANGESETS_* names. Design doc only.
