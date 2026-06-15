---
"@bounded-systems/prx": minor
---

Give `RoomSpec` an optional `image` — the `-box` OCI image that fills the room (the room is the isolation unit, the box is the artifact). The pod-member rooms declare theirs (`claude-box`, `beadsd-box`, `keeperd-box`), and the podman driver renders `room.image` as the container image, falling back to a placeholder ref only when a room declares none. The full registry ref stays a deploy concern (prx-zj8).
