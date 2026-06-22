---
---

Add a Front Desk instant-add coverage auditor (`front-desk:coverage` /
`:check`) that reports which org repos carry the `front-desk-add.yml` template,
so the instant half of the Front Desk hybrid can't silently drift to sweep-only
as repos are added. No-release change: a new tooling script under
`packages/prx/scripts/` plus package.json script entries — no published package
`src/` was touched.
