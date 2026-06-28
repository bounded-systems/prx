// The ghappd-room (prx-36xr) — runs ghappd-box in the per-repo pod, EXPOSING the
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

// Pinned ghappd-box image (prx-36xr). Digest is immutable; update by re-running
// the publish-oci-boxes workflow and replacing this constant.
export const GHAPPD_ROOM_IMAGE =
  "ghcr.io/bounded-systems/prx/ghappd-box@sha256:0b7d7be2115b635fda49c217eedbc87a2894390256de54c2b5b95ec751a0e19d";

// Host-backed runtime secrets the pod mounts onto tmpfs, all for the prx-forge
// bucket app. The private key is the real secret; the App id (4169313) and
// installation id (143190928) are non-secret but deployment-specific, carried the
// same way so the room needs no env field. The ghappd-box entrypoint points
// PRX_GH_APP_KEY_FILE at the key mount (read in-process — the PEM never enters
// env/argv) and reads the id/installation mounts into PRX_GH_APP_ID /
// PRX_GH_INSTALLATION_ID.
const GHAPP_KEY_SECRET = "prx-forge-key";
const GHAPP_KEY_TARGET = "/run/secrets/ghapp-key";
const GHAPP_ID_SECRET = "prx-forge-id";
const GHAPP_ID_TARGET = "/run/secrets/ghapp-id";
const GHAPP_INSTALLATION_SECRET = "prx-forge-installation";
const GHAPP_INSTALLATION_TARGET = "/run/secrets/ghapp-installation";

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
    { name: GHAPP_INSTALLATION_SECRET, target: GHAPP_INSTALLATION_TARGET },
  ],
  extraArgs: [],
  // macOS virtiofs: Unix-socket connections from the host fail (file, not socket
  // semantics); TCP tunnels around it. keeperd uses 9999; ghappd uses 9998. The
  // pod publishes the port and the door client dials it via PRX_GH_APP_DOOR.
  tcpPort: 9998,
};
