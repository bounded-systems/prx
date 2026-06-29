---
"@bounded-systems/prx": minor
---

Rename the GitHub-App credential door from `ghappd`/`ghapp` to `forge-d`/`forge` (prx-zee7 Phase 4). The runtime door already served the **prx-forge** bucket; this aligns the names with the bucket per the bucketed-apps ADR (`docs/prx/github-apps-architecture.md`). The daemon (dir `src/ghappd/` → `src/forge-d/`, room, OCI box, all `Ghappd*` symbols) becomes `forge-d`; the door identity / CLI verb / grant audience (`ghapp`) becomes `forge`. Identifiers use `ForgeD`/`forgeD` (never `forged`) to avoid the forgery misread.

**Breaking — deployment contracts change:**

- CLI verb: `prx ghapp serve` → `prx forge serve`.
- Env vars: `PRX_GH_APP_DOOR` → `PRX_FORGE_DOOR`; `GHAPPD_GRANT_AUDIENCE` → `FORGE_D_GRANT_AUDIENCE`; `GHAPPD_ISSUER_KEYS` → `FORGE_D_ISSUER_KEYS`; `GHAPPD_ROOM_IMAGE` → `FORGE_D_ROOM_IMAGE`; the `GHAPP_*` secret/target/socket consts → `FORGE_*`.
- OCI image: `ghcr.io/bounded-systems/prx/ghappd-box` → `.../forge-d-box`; room socket `/run/prx/doors/ghappd.sock` → `/run/prx/doors/forge-d.sock`.

The pinned `forge-d-box` digest still points at the digest published under the old `ghappd-box` name — the image must be **rebuilt + re-pushed as `forge-d-box` and repinned**, and deployed env/secret names migrated, before `prx pod up` will pull. That operational cutover is tracked separately and runs out-of-band from this code rename.
