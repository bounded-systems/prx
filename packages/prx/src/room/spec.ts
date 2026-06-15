/**
 * prx room spec (prx-62h) — the typed isolation unit in the house→room→person
 * model (docs/spikes/kata-containers-isolation-boundary.md):
 *
 *     ExecutorSpec (house: VM/hardware boundary)
 *        └─ Room    (the policy boundary — sandbox/container)
 *             └─ occupant (the agent / the build, "the person in the room")
 *
 * Until now "room" was only a metaphor (the kata spike + the "Chinese-Room"
 * comments in tools/capabilities.ts). This makes it a first-class spec, the way
 * {@link ../executor/spec.ExecutorSpec} made the *house* first-class. A Room
 * composes three things that already exist piecemeal:
 *
 *   1. the **executor** it occupies — an {@link ExecutorSpec} (the house);
 *   2. the **doors** it reaches daemons through — the unix-socket capability
 *      seams (beadsd/keeperd/…; the same doors the bd-door gate keys on,
 *      `PRX_BEADS_DOOR`). A *consumed* door grants the occupant a capability; an
 *      *exposed* door is a service the room offers other rooms;
 *   3. its **capability boundary** — the grant set the occupant may exercise,
 *      the typed counterpart of the `CapabilityReport` self-report.
 *
 * Spec-as-schema (mirrors ExecutorSpec): a malformed room is a validation error
 * at the seam, not a half-wired pod. Slice 1 is the typed spec + the grant
 * derivation + the first instance (the linux builder, ./linux-builder). Driver
 * rendering (room → podman pod / compose) and the door→env projection
 * (consumed doors → `PRX_BEADS_DOOR` & friends) are later slices.
 */

import { z } from "zod";

import { ExecutorSpecSchema } from "../executor/spec.ts";

/**
 * A door — a unix-socket capability seam between a room and a daemon. `consume`
 * = the occupant dials it (and is granted `capability`); `expose` = the room
 * serves it for other rooms to consume. Mirrors the daemon-door transport the
 * bd-door gate already uses (beadsd/keeperd).
 */
export const RoomDoorSchema = z.object({
  /** Door name; matches the daemon it fronts (`beadsd`, `keeperd`, `builder`). */
  name: z.string().min(1),
  /** Which way the room faces this door. */
  direction: z.enum(["consume", "expose"]),
  /** The capability this door carries (`beads:read`, `git:write`, `nix:build`). */
  capability: z.string().min(1),
  /** The unix-socket path of the door endpoint inside the pod. */
  socket: z.string().min(1),
  /**
   * Whether the door is passable. Absent / `open` = the Pod wires it (resolves
   * the consume↔expose match and grants the capability). `closed` = the seam is
   * DECLARED but strictly sealed — the Pod does not wire it and no capability
   * flows — so it's a reserved door we can OPEN later (a state flip) without a
   * structural change. Only sealing is ever explicit: claude-box marks its
   * `session:control` door `closed` today; the remote-control profile (prx-9s14)
   * opens it.
   */
  state: z.enum(["open", "closed"]).optional(),
});
export type RoomDoor = z.infer<typeof RoomDoorSchema>;

/**
 * The isolation tier (kata spike §3): a `sandbox` is a *policy* boundary (the
 * kernel promises), a `vm` is a *hardware* boundary (its own kernel). A room is
 * conceptually a sandbox; `tier` records the boundary its executor actually
 * provides, so the "house in a room" inversion (a VM behind a sandbox) is
 * visible rather than implicit.
 */
export const RoomTierSchema = z.enum(["sandbox", "vm"]);
export type RoomTier = z.infer<typeof RoomTierSchema>;

/**
 * A capability-bounded occupancy of an executor. `name` identifies the room and
 * follows the `<purpose>-room` convention (`claude-room`, `builder-room`) — the
 * *room* is the isolation unit; the OCI image/runtime that fills it keeps its
 * own name (the `claude-box` runtime, the `beadsd-box` image). `executor` is the
 * house it runs in; `doors` are its only privileged egress/ingress; `grants` is
 * the extra capability boundary beyond what consumed doors carry.
 */
export const RoomSpecSchema = z.object({
  name: z.string().min(1),
  /**
   * The house — the isolated executor this room occupies. **Optional**: a
   * standalone room (e.g. builder-room, itself a whole VM) carries its own; a
   * room that is a member of a {@link ../room/pod.PodSpec} omits it and inherits
   * the pod's shared house (co-resident rooms share one house).
   */
  executor: ExecutorSpecSchema.optional(),
  /** The boundary the executor provides (default: a policy-only sandbox). */
  tier: RoomTierSchema.default("sandbox"),
  /** The capability seams to daemons (consumed) and the services offered (exposed). */
  doors: z.array(RoomDoorSchema).default([]),
  /**
   * Capabilities granted directly inside the room, beyond those carried by
   * consumed doors (e.g. a build room granting `nix:build` to its own occupant).
   */
  grants: z.array(z.string().min(1)).default([]),
});
export type RoomSpec = z.infer<typeof RoomSpecSchema>;

/**
 * The occupant's full capability boundary: the explicit {@link RoomSpec.grants}
 * unioned with the capabilities carried by every **open, consumed** door. Closed
 * doors carry nothing (the seam is sealed); exposed doors are services the room
 * offers, NOT occupant grants — a build room that *exposes* `nix:build` does not
 * thereby let an arbitrary occupant invoke it; the door is how *other* rooms
 * reach it. Sorted + deduped so the boundary is a stable set.
 */
export function roomGrants(room: RoomSpec): string[] {
  const parsed = RoomSpecSchema.parse(room);
  const consumed = parsed.doors
    .filter((d) => d.direction === "consume" && d.state !== "closed")
    .map((d) => d.capability);
  return [...new Set([...parsed.grants, ...consumed])].sort();
}

/**
 * True iff the room *declares* an expose door for `capability` — regardless of
 * `state`. A strictly-closed exposed door still counts as exposed (the seam is
 * part of the room's topology, reserved for later); whether it is actually
 * wired is the Pod's concern (it wires only `open` doors). Pass
 * `{ openOnly: true }` to require the service be actively offered.
 */
export function roomExposes(
  room: RoomSpec,
  capability: string,
  opts: { openOnly?: boolean } = {},
): boolean {
  return RoomSpecSchema.parse(room).doors.some(
    (d) =>
      d.direction === "expose" &&
      d.capability === capability &&
      (!opts.openOnly || d.state !== "closed"),
  );
}
