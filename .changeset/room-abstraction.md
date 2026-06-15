---
"@bounded-systems/prx": minor
---

Add a first-class `RoomSpec` — the typed isolation unit in the house→room→person model (prx-62h). A room composes an `ExecutorSpec` (the house), the unix-socket `doors` it consumes/exposes (the daemon capability seams the bd-door gate already keys on), and its capability `grants`. `roomGrants` derives the occupant's boundary (explicit grants ∪ consumed-door capabilities; exposed doors are services, not occupant grants). The Linux build substrate ships as the first instance (`linuxBuilderRoom`): a VM-tier room (the "house in a room" case on darwin) that exposes a `builder` door granting `nix:build`/`oci:image`. Slice 1 = the schema + instance + grant derivation; driver rendering (room → podman pod) and the door→env projection are later slices.
