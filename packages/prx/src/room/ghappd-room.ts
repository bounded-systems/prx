// The ghappd-room (prx-36xr) — the room that runs ghappd-box in the per-repo
// pod: it EXPOSES the `github-app:token` door so a claude-room can LEASE
// short-lived GitHub App installation tokens without ever holding the App
// private key (ocap; see GHAPPD.md). Sibling of keeperd-room/beadsd-room.
import type { RoomSpec } from "./spec.ts";

// Pinned ghappd-box image (prx-36xr). Digest is immutable; update by re-running
// the publish-oci-boxes workflow and replacing this constant.
export const GHAPPD_ROOM_IMAGE =
  "ghcr.io/bounded-systems/prx/ghappd-box@sha256:3476e9aad3853b5d11ef93f010784f6471a71dc5a1be61d308604eaa8f4bc9bc";

// Host-backed runtime secrets the pod mounts onto tmpfs. The App private key is
// the real secret; the App id is non-secret but deployment-specific, carried the
// same way so the room needs no env field. The ghappd-box entrypoint points
// PRX_GH_APP_KEY_FILE at the key mount (the daemon reads it in-process — the PEM
// never enters env/argv) and reads the id mount into PRX_GH_APP_ID.
const GHAPP_KEY_SECRET = "prx-ghapp-key";
const GHAPP_KEY_TARGET = "/run/secrets/ghapp-key";
const GHAPP_ID_SECRET = "prx-ghapp-id";
const GHAPP_ID_TARGET = "/run/secrets/ghapp-id";

export const ghappdRoom: RoomSpec = {
  name: "ghappd-room",
  image: GHAPPD_ROOM_IMAGE,
  tier: "sandbox",
  doors: [
    {
      name: "ghappd",
      direction: "expose",
      capability: "github-app:token",
      socket: "/run/prx/doors/ghappd.sock",
    },
  ],
  grants: [],
  secrets: [
    { name: GHAPP_KEY_SECRET, target: GHAPP_KEY_TARGET },
    { name: GHAPP_ID_SECRET, target: GHAPP_ID_TARGET },
  ],
  extraArgs: [],
  // macOS virtiofs: Unix-socket connections from the host fail (file, not socket
  // semantics); TCP tunnels around it. keeperd uses 9999; ghappd uses 9998. The
  // pod publishes the port and the door client dials it via PRX_GH_APP_DOOR.
  tcpPort: 9998,
};
