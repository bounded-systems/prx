---
"@bounded-systems/prx": minor
---

Move `dolt push` off host bd (prx-82b Slice 2c.5): `prx repo add-dolthub`'s push
now runs in an ephemeral beadsd-box container with the DoltHub creds mounted via
the room-secret rail (`prx-dolt-creds`), not host bd. A small in-container wrapper
installs the mounted jwk into dolt's creds dir + sets the active creds/author from
non-secret env (`readHostDoltIdentity` reads `~/.dolt/config_global.json`), then
runs the push. The runner gains `env` support (`-e KEY=VALUE`). Auth validated
live end-to-end (`dolt creds check` → Success through the exact wrapper). Provision
once: `podman secret create prx-dolt-creds ~/.dolt/creds/<active>.jwk` (the active
key = `dolt config --global --get user.creds`).
