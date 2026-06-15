// The Room spec: the typed isolation unit (house→room→person). Covers schema
// validation, the consumed-vs-exposed grant semantics, door state (open/closed),
// and the builder-room / claude-room instances.

import { describe, expect, test } from "bun:test";

import { builderRoom } from "../../src/room/builder-room.ts";
import { claudeRoom } from "../../src/room/claude-room.ts";
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

  test("a CLOSED consumed door grants nothing (the seam is sealed)", () => {
    const r = room({
      doors: [
        { name: "beadsd", direction: "consume", capability: "beads:read", socket: "/s", state: "open" },
        { name: "keeperd", direction: "consume", capability: "git:write", socket: "/k", state: "closed" },
      ],
    });
    // Only the open door carries its capability.
    expect(roomGrants(r)).toEqual(["beads:read"]);
  });

  test("a CLOSED exposed door is still declared-exposed, but not actively offered", () => {
    const r = room({
      doors: [{ name: "control", direction: "expose", capability: "session:control", socket: "/c", state: "closed" }],
    });
    // The seam exists in the topology...
    expect(roomExposes(r, "session:control")).toBe(true);
    // ...but it is not an actively-offered (open) service.
    expect(roomExposes(r, "session:control", { openOnly: true })).toBe(false);
  });
});

describe("builderRoom", () => {
  test("is a valid RoomSpec", () => {
    expect(() => RoomSpecSchema.parse(builderRoom)).not.toThrow();
  });

  test("is VM-tier (the 'house in a room' case on darwin)", () => {
    expect(builderRoom.tier).toBe("vm");
  });

  test("exposes the build capabilities and consumes no doors", () => {
    expect(roomExposes(builderRoom, "nix:build")).toBe(true);
    expect(roomExposes(builderRoom, "oci:image")).toBe(true);
    expect(builderRoom.doors.every((d) => d.direction === "expose")).toBe(true);
  });

  test("grants its own occupant the build capabilities", () => {
    expect(roomGrants(builderRoom)).toEqual(["nix:build", "oci:image"]);
  });
});

describe("claudeRoom", () => {
  test("is a valid RoomSpec", () => {
    expect(() => RoomSpecSchema.parse(claudeRoom)).not.toThrow();
  });

  test("consumes the daemon doors → its grants are beads:read + git:write", () => {
    expect(roomGrants(claudeRoom)).toEqual(["beads:read", "git:write"]);
  });

  test("exposes a session:control door, strictly closed (reserved for prx-9s14)", () => {
    // Declared-exposed (topology stable)...
    expect(roomExposes(claudeRoom, "session:control")).toBe(true);
    // ...but sealed today — not an active service until remote-control opens it.
    expect(roomExposes(claudeRoom, "session:control", { openOnly: true })).toBe(false);
    const control = claudeRoom.doors.find((d) => d.capability === "session:control");
    expect(control?.state).toBe("closed");
  });
});
