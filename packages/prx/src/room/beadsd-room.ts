/**
 * The beadsd room — the beads daemon as a {@link RoomSpec} (GH-296). A per-repo
 * pod member: no executor (inherits the pod's house); its container image is the
 * beadsd-box image (prx-634).
 *
 * It EXPOSES the beadsd door granting `beads:read` on the shared door socket —
 * the door claude-room consumes. When the pod wires this consume↔expose pair it
 * projects `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET` into claude-room, which is what
 * fires the merged bd-door gate (#603/#604).
 */

import type { RoomSpec } from "./spec.ts";

// Pinned beadsd-box image (prx-634). Digest is immutable; update by re-running
// the publish-oci-boxes workflow and replacing this constant.
export const BEADSD_ROOM_IMAGE =
  "ghcr.io/bounded-systems/prx/beadsd-box@sha256:38f44cf0040d6f74f09d46bbc79ab9e64b28e4919146e4aed93fd917f964ea9d";

export const beadsdRoom: RoomSpec = {
  name: "beadsd-room",
  image: BEADSD_ROOM_IMAGE,
  tier: "sandbox",
  doors: [
    {
      name: "beadsd",
      direction: "expose",
      capability: "beads:read",
      socket: "/run/prx/doors/beadsd.sock",
    },
  ],
  // The daemon's own occupant authority is internal to bd; nothing extra here.
  grants: [],
  // No host secret — beadsd runs as a kube-play pod member.
  secrets: [],
  extraArgs: [],
};
