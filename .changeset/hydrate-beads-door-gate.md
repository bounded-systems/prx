---
"@bounded-systems/prx": patch
---

Route the `hydrateBeads` `bd show` read through the beadsd door in the box profile (prx-zbsi, GH-296 AC #3 follow-up). The beads hydration actor now gates its `bd show` spawn on `bdDoorGate`: in the box profile (`PRX_BEADS_DOOR`) it dials the door (the same path `prx beads show` uses) instead of execing a local `bd`; off-profile the gate returns null and the injected runner spawns exactly as before — byte-identical. Gating here also keeps this bd read off `defaultRunner`'s GitHub rate-limit bucket, where it never belonged. First slice of prx-zbsi (the dialer-backed `show` read); the remaining ungated reads (`dep`/`query`/`children`/`config`) await door-dialer support before they can be gated without failing closed in-box.
