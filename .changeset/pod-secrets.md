---
"@bounded-systems/prx": minor
---

Add `prx pod secrets` (prx-0g8h): prx now owns provisioning the host podman secrets its pod rooms DECLARE (RoomSpec.secrets), instead of manual `podman secret create`. With no `--from` it's a doctor view (declared vs present vs missing-source); `--from name=<@file|literal>` provisions idempotently (`--replace` rotates). ocap-faithful: a file source hands podman the PATH (the secret never enters prx's memory/argv); a non-secret literal (app/installation id) is piped via stdin. Closes the deploy last-mile for ghappd-room/keeperd/etc.
