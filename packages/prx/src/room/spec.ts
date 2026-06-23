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
/**
 * A host-backed secret the room needs at runtime — the keeper's provenance
 * signing key is the first (prx-b44y). `name` is the **host** podman-secret name
 * (`podman secret create <name> …`, sourced from the operator's secret store —
 * 1Password/keychain, never a plaintext file or the pod manifest); `target` is
 * where it lands inside the room (the keeperd-box entrypoint reads
 * `/run/secrets/keeper-key` into `PRX_PROVENANCE_KEY`).
 *
 * A room that declares any secret is a **secret-holding room**: it CANNOT run
 * via `podman kube play` (which only accepts in-YAML k8s Secrets — base64-ing the
 * key INTO the manifest, the very thing the door ADR forbids). It runs via
 * `podman run --secret` instead ({@link ../room/podman.renderPodmanRun}); its
 * door still lives on the shared door fabric both runtimes mount.
 */
export const RoomSecretSchema = z.object({
  /** The host podman-secret name to inject (`podman run --secret <name>,…`). */
  name: z.string().min(1),
  /** The mount target inside the room (e.g. `/run/secrets/keeper-key`). */
  target: z.string().min(1),
});
export type RoomSecret = z.infer<typeof RoomSecretSchema>;

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
  /**
   * The OCI image that fills the room — its `-box` (the `claude-box` runtime,
   * the `beadsd-box`/`keeperd-box` images). The room is the isolation unit; the
   * image is the artifact that runs in it. The pod driver renders this as the
   * container image; absent ⇒ the driver falls back to a placeholder ref. The
   * full registry ref is resolved at deploy (prx-zj8).
   */
  image: z.string().min(1).optional(),
  /** The boundary the executor provides (default: a policy-only sandbox). */
  tier: RoomTierSchema.default("sandbox"),
  /** The capability seams to daemons (consumed) and the services offered (exposed). */
  doors: z.array(RoomDoorSchema).default([]),
  /**
   * Capabilities granted directly inside the room, beyond those carried by
   * consumed doors (e.g. a build room granting `nix:build` to its own occupant).
   */
  grants: z.array(z.string().min(1)).default([]),
  /**
   * Host-backed secrets the room needs at runtime (prx-b44y). A non-empty list
   * makes this a **secret-holding room** — it runs via `podman run --secret`,
   * NOT `podman kube play` (see {@link RoomSecretSchema}).
   */
  secrets: z.array(RoomSecretSchema).default([]),
  /**
   * Extra CMD args appended AFTER the image ref in `podman run`, passed to the
   * entrypoint as `"$@"`. Use to override entrypoint defaults that can't be set
   * via env (e.g. `["--key", "/run/secrets/keeper-key"]` for the keeperd image
   * whose entrypoint hardcodes `--key /keys/keeper.key` but supports last-wins
   * `--key` override via CMD args). Empty by default.
   */
  extraArgs: z.array(z.string()).default([]),
  /**
   * Host TCP port to publish from this room (`-p <tcpPort>:<tcpPort>` in `podman
   * run`). Also appended as `--port <tcpPort>` in CMD args so the daemon listens
   * on TCP. Use for hosts where Unix-socket semantics don't cross the
   * container-runtime boundary (e.g. macOS virtiofs: the socket file appears on
   * the host filesystem but connections from the Mac host fail — ENOENT — because
   * virtiofs forwards file semantics, not socket semantics). Absent by default.
   */
  tcpPort: z.number().int().positive().optional(),
});
export type RoomSpec = z.infer<typeof RoomSpecSchema>;

/**
 * The room's host-backed secrets (sorted by mount target for stable rendering).
 */
export function roomSecrets(room: RoomSpec): RoomSecret[] {
  return [...RoomSpecSchema.parse(room).secrets].sort((a, b) => a.target.localeCompare(b.target));
}

/**
 * True iff the room holds any secret — it must run via `podman run --secret`
 * (its own isolated container) rather than as a `podman kube play` pod member,
 * because kube-play cannot mount a host-created podman secret. The pod
 * orchestration routes such rooms to the secret runtime and keeps the rest in
 * the kube pod; both share the door fabric.
 */
export function roomNeedsSecretRuntime(room: RoomSpec): boolean {
  return RoomSpecSchema.parse(room).secrets.length > 0;
}

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
