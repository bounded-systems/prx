---
"@bounded-systems/prx": patch
---

Add the deterministic beads dolt-data build artifact (prx-asr data layer, Phase
2). `nix/oci/dolt-data.nix` is a fixed-output derivation that clones the DoltHub
remote, pins the default branch to a specific commit (`dolt reset --hard` + `dolt
gc`), and emits a content-addressed dolt data dir — the network-fetch stage,
separated from the no-network copy stage (`tar | podman volume import` +
`chmod a+rwX`). Records `DOLT_BOX_ENV` (incl. `TMPDIR`, required so dolt's noms
temp writes succeed in the minimal image) + the copy recipe in dolt-service.ts.
Verified end-to-end: build → import → serve (3307) → query the issues table.
