/**
 * prx pod spec — the per-repo composition that HOLDS a set of co-resident rooms
 * and the door fabric between them (the keystone of the house→room→person model).
 *
 *     ExecutorSpec  (the house — one VM/host the pod runs on)
 *        └─ Pod      (per-repo: holds the rooms + owns the door fabric)
 *             ├─ Room claude-room    consumes beadsd / keeperd doors
 *             ├─ Room beadsd-room     exposes  beadsd door
 *             └─ Room keeperd-room    exposes  keeperd door
 *
 * A Pod does four things (kata spike + the door ADR, docs/prx/beadsd-door-wiring.md):
 *   1. holds the member rooms (one pod = one repo — the no-multitenant rule);
 *   2. owns the house (one shared {@link ExecutorSpec}; members inherit it) and
 *      the door fabric (the shared `doorDir` tmpfs the sockets live on);
 *   3. resolves doors — matches each room's `consume` door to the room that
 *      `expose`s the same capability OPEN; closed doors are skipped, an
 *      unmatched consume is a diagnostic ({@link resolvePodDoors});
 *   4. projects the connection env into each consumer ({@link podRoomEnv}) —
 *      for the beadsd door that is `PRX_BEADS_DOOR` + `PRX_BEADS_SOCKET`, which
 *      is literally what turns on the merged bd-door gate (#603/#604).
 *
 * This slice is the typed spec + the pure resolution/projection logic. Rendering
 * a Pod to a concrete podman pod (the driver) is a later slice.
 */

import { z } from "zod";

import { getEnv } from "@bounded-systems/env";
import { ExecutorSpecSchema, type ExecutorSpec } from "../executor/spec.ts";
import { RoomSpecSchema, type RoomSpec, PodServiceSchema } from "./spec.ts";

/** The default shared door-socket directory (the pod's tmpfs door fabric).
 *  Prefers XDG_RUNTIME_DIR when set (rootless Linux), falls back to a
 *  home-local path so rootless podman can provision it without sudo. */
export const DEFAULT_DOOR_DIR = getEnv("XDG_RUNTIME_DIR")
  ? `${getEnv("XDG_RUNTIME_DIR")}/prx/doors`
  : `${getEnv("HOME") ?? "/tmp"}/.local/run/prx/doors`;

export const PodSpecSchema = z.object({
  name: z.string().min(1),
  /** The shared house — the executor every member room runs in (per-repo). */
  executor: ExecutorSpecSchema,
  /** The co-resident rooms. */
  rooms: z.array(RoomSpecSchema).min(1),
  /**
   * Non-door backing services co-resident in the pod (prx-asr) — e.g. dolt-box,
   * the dolt SQL server beadsd connects to. Rendered as plain kube containers
   * with their named data volumes; they expose no doors. Empty by default.
   */
  services: z.array(PodServiceSchema).default([]),
  /** The shared tmpfs dir the door sockets live on. */
  doorDir: z.string().min(1).default(DEFAULT_DOOR_DIR),
  /**
   * Absolute host path of the repo this pod operates on, bind-mounted at `/work`
   * (the daemon images' `WorkingDir`) in every room (prx-u5lx). One pod = one
   * repo. Resolved at deploy (the worktree), so it is optional on the static
   * spec; without it the daemon rooms can't start (`/work` won't exist).
   */
  repo: z.string().min(1).optional(),
});
export type PodSpec = z.infer<typeof PodSpecSchema>;

/** A wired consume↔expose connection inside a pod. */
export type ResolvedDoor = {
  /** The consumer's door name (drives the env projection, e.g. `beadsd`). */
  door: string;
  capability: string;
  /** The provider's exposed socket — the authoritative endpoint. */
  socket: string;
  /** Consuming room name. */
  consumer: string;
  /** Providing (exposing) room name. */
  provider: string;
};

/** A door that could not be wired. */
export type DoorDiagnostic = {
  code: "unresolved" | "closed";
  room: string;
  capability: string;
  message: string;
};

/**
 * Resolve the pod's door fabric: for every room's `consume` door, find the room
 * that `expose`s the same capability with an OPEN door. A `closed` consume is
 * skipped (sealed seam); a consume with no open provider is `unresolved`. Pure.
 */
export function resolvePodDoors(pod: PodSpec): {
  resolved: ResolvedDoor[];
  diagnostics: DoorDiagnostic[];
} {
  const parsed = PodSpecSchema.parse(pod);
  // capability → the room + socket that exposes it OPEN (first wins).
  const providers = new Map<string, { room: string; socket: string }>();
  for (const room of parsed.rooms) {
    for (const door of room.doors) {
      if (
        door.direction === "expose" &&
        door.state !== "closed" &&
        !providers.has(door.capability)
      ) {
        providers.set(door.capability, { room: room.name, socket: door.socket });
      }
    }
  }

  const resolved: ResolvedDoor[] = [];
  const diagnostics: DoorDiagnostic[] = [];
  for (const room of parsed.rooms) {
    for (const door of room.doors) {
      if (door.direction !== "consume") continue;
      if (door.state === "closed") {
        diagnostics.push({
          code: "closed",
          room: room.name,
          capability: door.capability,
          message: `${room.name} consumes a sealed '${door.name}' door (${door.capability}) — not wired`,
        });
        continue;
      }
      const provider = providers.get(door.capability);
      if (!provider) {
        diagnostics.push({
          code: "unresolved",
          room: room.name,
          capability: door.capability,
          message: `${room.name} consumes '${door.capability}' but no room exposes it (open) in pod '${parsed.name}'`,
        });
        continue;
      }
      resolved.push({
        door: door.name,
        capability: door.capability,
        socket: provider.socket,
        consumer: room.name,
        provider: provider.room,
      });
    }
  }
  return { resolved, diagnostics };
}

/**
 * Project a single resolved door to the env vars that wire it for the consumer.
 * `doorDir` rebases the socket to the pod's fabric (the door spec socket path
 * may differ from the actual fabric path when doorDir is rootless).
 */
function doorEnv(door: ResolvedDoor, doorDir: string): Record<string, string> {
  // Each daemon door projects a {DOOR, SOCKET} env pair. The socket is rebased
  // to `doorDir` so the path is correct regardless of the pod's fabric location.
  //   - beadsd → PRX_BEADS_DOOR / PRX_BEADS_SOCKET (fires the bd-door gate).
  //   - keeperd → PRX_KEEPER_DOOR + KEEPERD_SOCK (door-kit convention).
  const socketFile = door.socket.split("/").at(-1) ?? door.socket;
  const socket = `${doorDir}/${socketFile}`;
  if (door.door === "beadsd") {
    return { PRX_BEADS_DOOR: door.door, PRX_BEADS_SOCKET: socket };
  }
  if (door.door === "keeperd") {
    return { PRX_KEEPER_DOOR: door.door, KEEPERD_SOCK: socket };
  }
  //   - forge-d → PRX_FORGE_DOOR (the endpoint the broker's door backend dials;
  //     apply.ts leases from it instead of minting from a local PEM).
  if (door.door === "forge-d") {
    return { PRX_FORGE_DOOR: socket };
  }
  return {};
}

/**
 * The env a given member room receives from the pod's wired doors — the
 * projection that turns the room's *declared* consumed doors into the runtime
 * signals its occupant reads. For claude-room this yields
 * `{ PRX_BEADS_DOOR, PRX_BEADS_SOCKET }`, firing the merged gate.
 */
export function podRoomEnv(pod: PodSpec, roomName: string): Record<string, string> {
  const p = PodSpecSchema.parse(pod);
  const { resolved } = resolvePodDoors(p);
  return resolved
    .filter((d) => d.consumer === roomName)
    .reduce<Record<string, string>>((env, d) => ({ ...env, ...doorEnv(d, p.doorDir) }), {});
}

/**
 * The house a member room actually runs in: its own executor if it declares one
 * (a standalone room), else the pod's shared house.
 */
export function effectiveExecutor(pod: PodSpec, room: RoomSpec): ExecutorSpec {
  return room.executor ?? PodSpecSchema.parse(pod).executor;
}
