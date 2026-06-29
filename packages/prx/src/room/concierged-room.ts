/**
 * The concierged room — concierged (the grant broker, prx-8uf2/prx-9s14) as a
 * {@link RoomSpec}. A per-repo pod member that EXPOSES the `grant:broker` door so
 * in-pod boxes can `register` what they serve and `resolve` a capability to a
 * SIGNED grant they then present to a serving room's tcp/vsock gate. Sibling of
 * keeperd-room/forge-d-room.
 *
 * IN-POD UNIX ONLY — no `tcpPort`. concierged is reached over the shared door
 * fabric, where the kernel-authenticated peer is the authority (held-ref;
 * CONCIERGE.md §7), so the daemon does not gate its own edge. (TCP/vsock is the
 * SERVING doors' cross-host edge, fronted by the consumer's interposer — "TCP
 * always routes to sockets"; the broker itself stays unix.)
 *
 * It HOLDS A SECRET — the provenance MASTER from which the door-authority
 * per-actor signing key is derived (`resolveProvenanceMaster` →
 * `deriveActorKeypair`). So it runs via `podman run --secret` (its own isolated
 * container, like keeperd-room), NOT as a kube-play member. The host secret
 * `prx-provenance-master` lands at `/run/secrets/provenance-master`; the
 * concierged-box entrypoint points `PRX_PROVENANCE_MASTER_FILE` at it so
 * `resolve` signs grants with the door authority and `keys` publishes its public
 * half — the SAME key the serving doors verify against (their
 * `KEEPERD_/GHAPPD_ISSUER_KEYS` = `prx concierge` `keys()`). Its door lives on
 * the shared fabric both runtimes mount, so consumers reach it unchanged.
 */

import type { RoomSpec } from "./spec.ts";

/** The host podman-secret carrying the door-authority provenance master. */
const PROVENANCE_MASTER_SECRET = "prx-provenance-master";
/** Where the secret lands inside the room (the concierged-box entrypoint points
 *  `PRX_PROVENANCE_MASTER_FILE` here). */
const PROVENANCE_MASTER_TARGET = "/run/secrets/provenance-master";

/**
 * The concierged-box image (runs `prx concierge serve`). TODO(prx-9s14): built +
 * pinned by the publish-oci-boxes workflow — add a `concierged-box` job + nix
 * derivation, then replace this with the published `…/concierged-box@sha256:…`
 * digest (and the auto-repin keeps it current). `:latest` is the bootstrap ref
 * until the first build; the room is NOT yet joined to `perRepoPod` (see below),
 * so this placeholder cannot break a live `prx pod up`.
 */
export const CONCIERGED_ROOM_IMAGE = "ghcr.io/bounded-systems/prx/concierged-box:latest";

export const conciergedRoom: RoomSpec = {
  name: "concierged-room",
  image: CONCIERGED_ROOM_IMAGE,
  tier: "sandbox",
  doors: [
    {
      name: "concierged",
      direction: "expose",
      capability: "grant:broker",
      socket: "/run/prx/doors/concierged.sock",
    },
  ],
  grants: [],
  // The provenance master, host-backed → secret runtime (mirrors keeperd-room).
  secrets: [{ name: PROVENANCE_MASTER_SECRET, target: PROVENANCE_MASTER_TARGET }],
  extraArgs: [],
  // No tcpPort: in-pod unix only (the broker is reached over the door fabric).
};
