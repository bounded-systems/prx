/**
 * The claude room — the agent's room (prx-d4o), modeled as a {@link RoomSpec}.
 * The room is purpose-named (`claude-room`); the OCI image/runtime that *fills*
 * it keeps the established name (the **claude-box** runtime, prx-d4o). Room and
 * box are two layers: the room is the isolation unit, the box is the artifact.
 *
 * It CONSUMES the daemon doors (its only privileged egress — the bd-door gate
 * keys on exactly these): beadsd for beads reads, keeperd for git writes. It
 * holds no `bd`/`git` authority itself; the capability lives behind the door.
 *
 * It also EXPOSES a `session:control` door — but **strictly closed** for now.
 * The seam is declared so the topology is stable, but the Pod does not wire it
 * and nothing can drive the boxed session through it yet. The remote-control
 * profile (prx-9s14), brokered by authd (prx-6194), is what *opens* it later —
 * a state flip from `closed` → `open`, no structural change.
 *
 * The executor (the claude-box runtime image, prx-d4o) is intentionally minimal
 * here — this instance is about the door topology, not the image. In a pod the
 * executor is inherited from the Pod's house; standalone it would carry its own.
 */

import type { RoomSpec } from "./spec.ts";

const DOORS = "/run/prx/doors";

export const claudeRoom: RoomSpec = {
  name: "claude-room",
  // A sandbox-tier room: the policy boundary is the container; the hardware
  // boundary (the VM house) belongs to the Pod, not this room.
  tier: "sandbox",
  // Minimal placeholder — runs the pinned claude-box runtime OCI image (prx-d4o).
  executor: { name: "prx-claude-room" },
  doors: [
    // Privileged egress: the only way out is through these daemon doors.
    { name: "beadsd", direction: "consume", capability: "beads:read", socket: `${DOORS}/beadsd.sock`, state: "open" },
    { name: "keeperd", direction: "consume", capability: "git:write", socket: `${DOORS}/keeperd.sock`, state: "open" },
    // Declared but SEALED: the remote-control / drive-the-session seam. Opened
    // by prx-9s14 (authd-brokered); closed today.
    { name: "control", direction: "expose", capability: "session:control", socket: `${DOORS}/control.sock`, state: "closed" },
  ],
  // The occupant's own boundary is whatever the open consumed doors carry
  // (beads:read, git:write) — no standalone tool authority baked in.
  grants: [],
};
