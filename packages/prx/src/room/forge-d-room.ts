// The forge-d-room (prx-36xr) — runs forge-d-box in the per-repo pod, EXPOSING the
// `github-app:token` door so a claude-room can LEASE short-lived installation
// tokens without ever holding the App private key (ocap; see GHAPPD.md). Sibling
// of keeperd-room/beadsd-room.
//
// This door serves the **prx-forge bucket** (contents/issues/PRs/checks — the
// runtime git/PR surface; docs/prx/github-apps-architecture.md). The single
// ambient GH_TOKEN at runtime maps to one bucket → forge is the default. A
// projects-d door (org-projects) can be stood up the same way when a runtime
// project consumer exists — the box is bucket-generic (the mounts pick the app).
import type { RoomSpec } from "./spec.ts";

// Pinned forge-d-box image (prx-36xr). Digest is immutable; update by re-running
// the publish-oci-boxes workflow and replacing this constant.
export const FORGE_D_ROOM_IMAGE =
  "ghcr.io/bounded-systems/prx/forge-d-box@sha256:7e35301272a9c2d00ab6045c777e61231f31bd1ffccada065a35d880f945144c";

// Host-backed runtime secrets the pod mounts onto tmpfs, all for the prx-forge
// bucket app. The private key is the real secret; the App id (4169313) and
// installation id (143190928) are non-secret but deployment-specific, carried the
// same way so the room needs no env field. The forge-d-box entrypoint points
// PRX_GH_APP_KEY_FILE at the key mount (read in-process — the PEM never enters
// env/argv) and reads the id/installation mounts into PRX_GH_APP_ID /
// PRX_GH_INSTALLATION_ID.
const FORGE_KEY_SECRET = "prx-forge-key";
const FORGE_KEY_TARGET = "/run/secrets/forge-key";
const FORGE_ID_SECRET = "prx-forge-id";
const FORGE_ID_TARGET = "/run/secrets/forge-id";
const FORGE_INSTALLATION_SECRET = "prx-forge-installation";
const FORGE_INSTALLATION_TARGET = "/run/secrets/forge-installation";

export const forgeDRoom: RoomSpec = {
  name: "forge-d-room",
  image: FORGE_D_ROOM_IMAGE,
  tier: "sandbox",
  doors: [
    {
      name: "forge-d",
      direction: "expose",
      capability: "github-app:token",
      socket: "/run/prx/doors/forge-d.sock",
    },
  ],
  grants: [],
  secrets: [
    { name: FORGE_KEY_SECRET, target: FORGE_KEY_TARGET },
    { name: FORGE_ID_SECRET, target: FORGE_ID_TARGET },
    { name: FORGE_INSTALLATION_SECRET, target: FORGE_INSTALLATION_TARGET },
  ],
  extraArgs: [],
  // macOS virtiofs: Unix-socket connections from the host fail (file, not socket
  // semantics); TCP tunnels around it. keeperd uses 9999; forge-d uses 9998. The
  // pod publishes the port and the door client dials it via PRX_FORGE_DOOR.
  tcpPort: 9998,
};
