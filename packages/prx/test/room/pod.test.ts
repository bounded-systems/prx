// The Pod: holds rooms + the door fabric. Covers door resolution (consume↔expose,
// closed skip, unresolved), the env projection that fires the gate, executor
// inheritance, and the per-repo pod instance.

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import {
  PodSpecSchema,
  effectiveExecutor,
  podRoomEnv,
  resolvePodDoors,
  type PodSpec,
} from "../../src/room/pod.ts";
import { RoomSpecSchema } from "../../src/room/spec.ts";

// Author rooms as schema INPUT (tier/doors/grants default in, executor optional);
// PodSpecSchema.parse fills the output shape.
type RoomInput = z.input<typeof RoomSpecSchema>;

function pod(rooms: RoomInput[], over: Partial<z.input<typeof PodSpecSchema>> = {}): PodSpec {
  return PodSpecSchema.parse({ name: "p", executor: { name: "house" }, rooms, ...over });
}

const consumer = (doors: RoomInput["doors"]): RoomInput => ({ name: "consumer", doors });
const beadsdProvider: RoomInput = {
  name: "beadsd-room",
  doors: [{ name: "beadsd", direction: "expose", capability: "beads:read", socket: "/run/prx/doors/beadsd.sock" }],
};

describe("PodSpecSchema", () => {
  test("defaults doorDir and requires at least one room", () => {
    const p = pod([{ name: "r" }]);
    expect(p.doorDir).toBe("/run/prx/doors");
    expect(() => PodSpecSchema.parse({ name: "p", executor: { name: "h" }, rooms: [] })).toThrow();
  });
});

describe("resolvePodDoors", () => {
  test("wires a consume to the room that exposes the capability open", () => {
    const c = consumer([
      { name: "beadsd", direction: "consume", capability: "beads:read", socket: "/x" },
    ]);
    const { resolved, diagnostics } = resolvePodDoors(pod([c, beadsdProvider]));
    expect(diagnostics).toEqual([]);
    expect(resolved).toEqual([
      {
        door: "beadsd",
        capability: "beads:read",
        socket: "/run/prx/doors/beadsd.sock", // the PROVIDER's socket is authoritative
        consumer: "consumer",
        provider: "beadsd-room",
      },
    ]);
  });

  test("a sealed (closed) consume is skipped, not wired", () => {
    const c = consumer([
      { name: "beadsd", direction: "consume", capability: "beads:read", socket: "/x", state: "closed" },
    ]);
    const { resolved, diagnostics } = resolvePodDoors(pod([c, beadsdProvider]));
    expect(resolved).toEqual([]);
    expect(diagnostics).toEqual([
      { code: "closed", room: "consumer", capability: "beads:read", message: expect.stringContaining("sealed") },
    ]);
  });

  test("a consume with no open provider is unresolved", () => {
    const c = consumer([
      { name: "keeperd", direction: "consume", capability: "git:write", socket: "/x" },
    ]);
    const { resolved, diagnostics } = resolvePodDoors(pod([c, beadsdProvider]));
    expect(resolved).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ code: "unresolved", capability: "git:write" });
  });

  test("a CLOSED exposed door does not provide (the seam is sealed)", () => {
    const sealedProvider: RoomInput = {
      name: "p2",
      doors: [{ name: "beadsd", direction: "expose", capability: "beads:read", socket: "/s", state: "closed" }],
    };
    const c = consumer([{ name: "beadsd", direction: "consume", capability: "beads:read", socket: "/x" }]);
    const { resolved, diagnostics } = resolvePodDoors(pod([c, sealedProvider]));
    expect(resolved).toEqual([]);
    expect(diagnostics[0]?.code).toBe("unresolved");
  });
});

describe("podRoomEnv — the keystone", () => {
  test("projects PRX_BEADS_DOOR + PRX_BEADS_SOCKET into the beadsd consumer (fires the gate)", () => {
    const c = consumer([
      { name: "beadsd", direction: "consume", capability: "beads:read", socket: "/x" },
    ]);
    expect(podRoomEnv(pod([c, beadsdProvider]), "consumer")).toEqual({
      PRX_BEADS_DOOR: "beadsd",
      PRX_BEADS_SOCKET: "/run/prx/doors/beadsd.sock",
    });
  });

  test("projects PRX_KEEPER_DOOR + PRX_KEEPER_SOCKET into the keeperd consumer", () => {
    const c = consumer([
      { name: "keeperd", direction: "consume", capability: "git:write", socket: "/x" },
    ]);
    const keeperdProvider: RoomInput = {
      name: "keeperd-room",
      doors: [
        { name: "keeperd", direction: "expose", capability: "git:write", socket: "/run/prx/doors/keeperd.sock" },
      ],
    };
    expect(podRoomEnv(pod([c, keeperdProvider]), "consumer")).toEqual({
      PRX_KEEPER_DOOR: "keeperd",
      PRX_KEEPER_SOCKET: "/run/prx/doors/keeperd.sock",
    });
  });

  test("a room with no wired beadsd door gets no gate env", () => {
    expect(podRoomEnv(pod([beadsdProvider]), "beadsd-room")).toEqual({});
  });
});

describe("effectiveExecutor", () => {
  test("a member room inherits the pod's house; a standalone room keeps its own", () => {
    const p = pod([{ name: "member" }, { name: "standalone", executor: { name: "own-house" } }]);
    expect(effectiveExecutor(p, p.rooms[0]!).name).toBe("house");
    expect(effectiveExecutor(p, p.rooms[1]!).name).toBe("own-house");
  });
});

describe("perRepoPod", () => {
  test("is a valid PodSpec", () => {
    expect(() => PodSpecSchema.parse(perRepoPod)).not.toThrow();
  });

  test("wires claude-room's beadsd + keeperd consumes; control stays sealed", () => {
    const { resolved, diagnostics } = resolvePodDoors(perRepoPod);
    const caps = resolved.filter((r) => r.consumer === "claude-room").map((r) => r.capability).sort();
    expect(caps).toEqual(["beads:read", "git:write"]);
    // The session:control door is EXPOSED+closed on claude-room → not a consume,
    // so it never appears as resolved or as a diagnostic.
    expect(diagnostics).toEqual([]);
    expect(resolved.some((r) => r.capability === "session:control")).toBe(false);
  });

  test("fires the gate env into claude-room (beadsd + keeperd doors)", () => {
    expect(podRoomEnv(perRepoPod, "claude-room")).toEqual({
      PRX_BEADS_DOOR: "beadsd",
      PRX_BEADS_SOCKET: "/run/prx/doors/beadsd.sock",
      PRX_KEEPER_DOOR: "keeperd",
      PRX_KEEPER_SOCKET: "/run/prx/doors/keeperd.sock",
    });
  });
});
