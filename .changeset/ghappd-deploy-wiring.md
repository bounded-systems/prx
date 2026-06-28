---
"@bounded-systems/prx": minor
---

ghappd deployment wiring (prx-cdln, finishing Phase 1): the `--ghapp` door catalog entry + the Lima lifecycle.

- **door/guest-room-catalog.ts** — adds the `ghapp` door to `prxDoorCatalog`
  (`env: PRX_GH_APP_DOOR`, the broker's door-backend reader) + `ghappDoorGrant`,
  so a claude-box room can declare/mount the door (and the rulebook honestly
  denies it when absent). New `ghappd/endpoint.ts` (`DEFAULT_LOCAL_GHAPP_SOCKET`).
- **ghappd/lima-ghappd.ts** — `startGhappd`/`stopGhappd`/`provisionGhappd`/
  `deployGhappdBinary`, a thin wrapper over the shared Lima `lifecycle` (like
  keeperd/beadsd). The App credential is injected as env — id/installation
  plain, the **PEM from its file via `$(cat …)`** so it stays out of argv.
- **ghappd/serve-verb.ts** — accepts an (ignored) `--cwd` so the generic daemon
  launcher's `--cwd` doesn't break `ghapp serve` (the door is not repo-bound).

With this, ghappd is mountable as a room door and deployable as a Lima daemon —
prx-cdln's door work is complete; what remains is operational cutover (stop
setting `PRX_GH_APP_PRIVATE_KEY` on agents once ghappd is deployed).
