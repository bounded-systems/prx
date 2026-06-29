---
"@bounded-systems/prx": minor
---

concierged room spec (prx-8uf2 / prx-9s14) — `conciergedRoom` declares concierged (the grant broker, #853) as a per-repo pod member. It EXPOSES the `grant:broker` door on the shared fabric (`/run/prx/doors/concierged.sock`) and HOLDS the provenance master secret (`prx-provenance-master` → `/run/secrets/provenance-master`) from which the door-authority signing key is derived — so `resolve` signs grants and `keys` publishes the public half the serving doors verify against. IN-POD UNIX ONLY: no `tcpPort` (the broker is reached over the door fabric, held-ref authority; the cross-host TCP edge belongs to the serving doors, fronted by the consumer's interposer — "TCP always routes to sockets"). Mirrors keeperd-room's secret-runtime pattern. NOT YET joined to `perRepoPod`: that + building/pinning the `concierged-box` image (publish-oci-boxes) is the deployment step (prx-9s14), so this placeholder image ref can't break a live `prx pod up`.
