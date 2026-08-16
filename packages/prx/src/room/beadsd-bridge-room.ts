/**
 * The beadsd-bridge room — the phase-1 loopback door-bridge (prx-8uf2) as a
 * pod member, so a macOS host can reach beadsd's unix socket at all: unix
 * sockets don't cross the podman-machine virtiofs boundary (the socket file
 * is visible on the host filesystem, but a host process can't `connect()` to
 * it — see docs/prx/door-bridge.md), so a pure byte-forwarding TCP↔unix pump
 * running INSIDE the pod (same Linux kernel netns as beadsd-room) is the only
 * way across.
 *
 * It CONSUMES the beadsd door purely to get `PRX_BEADS_SOCKET` projected into
 * its env (the fabric path — it never speaks the beads wire protocol itself,
 * `prx door bridge` is frame-transparent). It runs the general `prx` image
 * (no `-box` build needed — `door bridge` is a plain CLI verb), with `tcpPort`
 * set so the pod's Quadlet `.kube` unit (`renderPodmanKubeQuadlet`) publishes
 * it to `127.0.0.1` on the host.
 *
 * UNAUTHENTICATED on this edge by design (phase 1 only) — loopback-bound is
 * the whole safety story (widens beadsd access from the fabric's owner to all
 * local users, acceptable on a single-user dev mac, not a shared host). Phase
 * 2 (a signed-grant gate, already shipped for keeperd/forge-d's TCP edges)
 * is the natural next step if this needs to run on a shared host.
 */

import type { RoomSpec } from "./spec.ts";

/** Pinned `prx` CLI image (v0.27.0) — bump alongside a release, same
 *  convention as beadsd-room's pinned `-box` digest. */
export const BEADSD_BRIDGE_ROOM_IMAGE =
  "ghcr.io/bounded-systems/prx@sha256:bab054f63decd68b3737d29b458cda52b3ce250fbb590400aafb29f7f730452c";

/** Loopback TCP port the bridge publishes — same range as keeperd (9999) /
 *  forge-d (9998). */
export const BEADSD_BRIDGE_PORT = 9997;

export const beadsdBridgeRoom: RoomSpec = {
  name: "beadsd-bridge",
  image: BEADSD_BRIDGE_ROOM_IMAGE,
  tier: "sandbox",
  doors: [
    {
      name: "beadsd",
      direction: "consume",
      capability: "beads:read",
      socket: "/run/prx/doors/beadsd.sock",
      state: "open",
    },
  ],
  grants: [],
  // No host secret — the bridge is a plain, unauthenticated (phase-1)
  // forwarder and runs as a kube-play pod member like beadsd-room itself.
  secrets: [],
  tcpPort: BEADSD_BRIDGE_PORT,
  // `$PRX_BEADS_SOCKET` is the fabric path podRoomEnv projects for consuming
  // this door — reading it here (rather than hardcoding the fabric path)
  // keeps this room portable across any pod's doorDir.
  extraArgs: [
    "sh",
    "-c",
    `prx door bridge --port ${BEADSD_BRIDGE_PORT} --socket "$PRX_BEADS_SOCKET"`,
  ],
};
