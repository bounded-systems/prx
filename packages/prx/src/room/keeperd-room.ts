/**
 * The keeperd room — the git-write daemon as a {@link RoomSpec} (GH-201). A
 * per-repo pod member: no executor (inherits the pod's house); its container
 * image is the keeperd-box image (prx-anj).
 *
 * It EXPOSES the keeperd door granting `git:write` on the shared door socket —
 * the door claude-room consumes for commits/pushes without itself holding git
 * authority (ocap: the capability lives behind the door).
 *
 * It HOLDS a secret — the provenance signing key (prx-b44y) — so it runs via
 * `podman run --secret` (its own isolated container), NOT as a `podman kube
 * play` pod member: kube-play cannot mount a host-created podman secret, and
 * base64-ing the key into the manifest violates the door ADR. The host secret
 * `prx-keeper-key` (`podman secret create prx-keeper-key <from-1password>`)
 * lands at `/run/secrets/keeper-key`, where the keeperd-box entrypoint reads it
 * into `PRX_PROVENANCE_KEY` (#620/#632). Its door still lives on the shared
 * door fabric both runtimes mount, so claude-room reaches it unchanged.
 */

import type { RoomSpec } from "./spec.ts";

/** The host podman-secret name carrying the keeper's provenance signing key. */
const KEEPER_KEY_SECRET = "prx-keeper-key";
/** Where the secret lands inside the room (the keeperd-box entrypoint default). */
const KEEPER_KEY_TARGET = "/run/secrets/keeper-key";

/**
 * The canonical door-keeper image (the model-A keeperd: import-and-push + L3),
 * pinned by digest — published from `bounded-systems/door-keeper`. prx verifies
 * its L3 at the submit-publish gate (Phase B). Bump the digest when door-keeper
 * releases; trusting the digest is the operator's pin, NOT the daemon's claim.
 */
export const KEEPERD_ROOM_IMAGE =
  "ghcr.io/bounded-systems/door-keeper/keeperd@sha256:2a2a64b6616e14b569c16648ace042d043bac56706c67529fcfabed507165f8e";

export const keeperdRoom: RoomSpec = {
  name: "keeperd-room",
  image: KEEPERD_ROOM_IMAGE,
  tier: "sandbox",
  doors: [
    {
      name: "keeperd",
      direction: "expose",
      capability: "git:write",
      socket: "/run/prx/doors/keeperd.sock",
    },
  ],
  grants: [],
  // The provenance signing key, host-backed (prx-b44y) → secret runtime.
  secrets: [{ name: KEEPER_KEY_SECRET, target: KEEPER_KEY_TARGET }],
};
