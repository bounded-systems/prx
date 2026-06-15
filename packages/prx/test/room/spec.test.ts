// The Room spec: the typed isolation unit (house→room→person). Covers schema
// validation, the consumed-vs-exposed grant semantics, and the linux-builder
// instance.

import { describe, expect, test } from "bun:test";

import { linuxBuilderRoom } from "../../src/room/linux-builder.ts";
import {
  RoomSpecSchema,
  roomExposes,
  roomGrants,
  type RoomSpec,
} from "../../src/room/spec.ts";

const baseExecutor = { name: "x" };

function room(over: Partial<RoomSpec> = {}): RoomSpec {
  return RoomSpecSchema.parse({ name: "r", executor: baseExecutor, ...over });
}

describe("RoomSpecSchema", () => {
  test("defaults: sandbox tier, no doors, no grants", () => {
    const r = room();
    expect(r.tier).toBe("sandbox");
    expect(r.doors).toEqual([]);
    expect(r.grants).toEqual([]);
  });

  test("rejects an empty name and a malformed door", () => {
    expect(() => RoomSpecSchema.parse({ name: "", executor: baseExecutor })).toThrow();
    expect(() =>
      RoomSpecSchema.parse({
        name: "r",
        executor: baseExecutor,
        doors: [{ name: "d", direction: "sideways", capability: "x", socket: "/s" }],
      }),
    ).toThrow();
  });

  test("composes a full ExecutorSpec (the house)", () => {
    const r = room({ executor: { name: "h", arch: "aarch64", cpus: 2 }, tier: "vm" });
    expect(r.executor.arch).toBe("aarch64");
    expect(r.tier).toBe("vm");
  });
});

describe("roomGrants", () => {
  test("unions explicit grants with CONSUMED door capabilities, sorted + deduped", () => {
    const r = room({
      grants: ["repo:read"],
      doors: [
        { name: "beadsd", direction: "consume", capability: "beads:read", socket: "/run/prx/doors/beadsd.sock" },
        { name: "keeperd", direction: "consume", capability: "git:write", socket: "/run/prx/doors/keeperd.sock" },
        { name: "beadsd", direction: "consume", capability: "beads:read", socket: "/run/prx/doors/beadsd.sock" },
      ],
    });
    expect(roomGrants(r)).toEqual(["beads:read", "git:write", "repo:read"]);
  });

  test("EXPOSED doors are services, not occupant grants", () => {
    const r = room({
      doors: [{ name: "builder", direction: "expose", capability: "nix:build", socket: "/s" }],
    });
    // The room offers nix:build to others, but its own occupant isn't granted it
    // by the mere fact of exposing the door.
    expect(roomGrants(r)).toEqual([]);
    expect(roomExposes(r, "nix:build")).toBe(true);
    expect(roomExposes(r, "git:write")).toBe(false);
  });
});

describe("linuxBuilderRoom", () => {
  test("is a valid RoomSpec", () => {
    expect(() => RoomSpecSchema.parse(linuxBuilderRoom)).not.toThrow();
  });

  test("is VM-tier (the 'house in a room' case on darwin)", () => {
    expect(linuxBuilderRoom.tier).toBe("vm");
  });

  test("exposes the build capabilities and consumes no doors", () => {
    expect(roomExposes(linuxBuilderRoom, "nix:build")).toBe(true);
    expect(roomExposes(linuxBuilderRoom, "oci:image")).toBe(true);
    expect(linuxBuilderRoom.doors.every((d) => d.direction === "expose")).toBe(true);
  });

  test("grants its own occupant the build capabilities", () => {
    expect(roomGrants(linuxBuilderRoom)).toEqual(["nix:build", "oci:image"]);
  });
});
