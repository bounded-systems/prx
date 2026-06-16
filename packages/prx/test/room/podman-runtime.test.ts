// The podman runtime — play/down a PodSpec across the secret-room split
// (prx-b44y): `podman kube play|down -` for non-secret rooms, `podman run
// --secret` / `podman rm` for secret-holding rooms. The runner is injected, so
// this drives the orchestration fully offline.

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { PodSpecSchema, type PodSpec } from "../../src/room/pod.ts";
import { renderPodmanKube, renderPodmanRun } from "../../src/room/podman.ts";
import {
  downPod,
  playPod,
  PodmanRuntimeError,
  type PodmanRun,
  type PodmanRunResult,
} from "../../src/room/podman-runtime.ts";

type RoomInput = z.input<typeof import("../../src/room/spec.ts").RoomSpecSchema>;

function pod(rooms: RoomInput[]): PodSpec {
  return PodSpecSchema.parse({ name: "prx-pod", executor: { name: "house" }, rooms });
}

const beadsdRoom: RoomInput = {
  name: "beadsd-room",
  image: "beadsd-box",
  doors: [{ name: "beadsd", direction: "expose", capability: "beads:read", socket: "/run/prx/doors/beadsd.sock" }],
};

const keeperdRoom: RoomInput = {
  name: "keeperd-room",
  image: "keeperd-box",
  doors: [{ name: "keeperd", direction: "expose", capability: "git:write", socket: "/run/prx/doors/keeperd.sock" }],
  secrets: [{ name: "prx-keeper-key", target: "/run/secrets/keeper-key" }],
};

/** A fake runner that records its calls and returns a scripted result. */
function recorder(result: PodmanRunResult) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const run: PodmanRun = (args, input) => {
    calls.push(input !== undefined ? { args, input } : { args });
    return result;
  };
  return { run, calls };
}

const ok: PodmanRunResult = { status: 0, stdout: "Pod: abc\n", stderr: "" };

describe("playPod", () => {
  test("pipes the rendered manifest into `podman kube play -` (non-secret rooms)", () => {
    const p = pod([beadsdRoom]);
    const { run, calls } = recorder(ok);
    const res = playPod(p, run);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["kube", "play", "-"]);
    expect(calls[0]!.input).toBe(renderPodmanKube(p)); // exact manifest on stdin
    expect(res).toEqual([ok]);
  });

  test("kube-plays the non-secret rooms, then `podman run`s each secret room", () => {
    const p = pod([beadsdRoom, keeperdRoom]);
    const { run, calls } = recorder(ok);
    const res = playPod(p, run);
    expect(calls).toHaveLength(2);
    // kube play first…
    expect(calls[0]!.args).toEqual(["kube", "play", "-"]);
    expect(calls[0]!.input).toBe(renderPodmanKube(p));
    // …then the secret room via `podman run --secret` (no stdin).
    expect(calls[1]!.args).toEqual(renderPodmanRun(p, "keeperd-room"));
    expect(calls[1]!.input).toBeUndefined();
    expect(res).toEqual([ok, ok]);
  });

  test("skips kube play when every room is a secret room (no empty manifest)", () => {
    const p = pod([keeperdRoom]);
    const { run, calls } = recorder(ok);
    const res = playPod(p, run);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(renderPodmanRun(p, "keeperd-room"));
    expect(res).toEqual([ok]);
  });

  test("throws PodmanRuntimeError on a non-zero exit (stderr surfaced)", () => {
    const { run } = recorder({ status: 125, stdout: "", stderr: "image not known" });
    expect(() => playPod(pod([beadsdRoom]), run)).toThrow(PodmanRuntimeError);
    try {
      playPod(pod([beadsdRoom]), run);
    } catch (err) {
      expect((err as PodmanRuntimeError).message).toContain("image not known");
      expect((err as PodmanRuntimeError).result.status).toBe(125);
    }
  });
});

describe("downPod", () => {
  test("pipes the rendered manifest into `podman kube down -` (non-secret rooms)", () => {
    const p = pod([beadsdRoom]);
    const { run, calls } = recorder(ok);
    const res = downPod(p, run);
    expect(calls[0]!.args).toEqual(["kube", "down", "-"]);
    expect(calls[0]!.input).toBe(renderPodmanKube(p));
    expect(res).toEqual([ok]);
  });

  test("kube-downs the non-secret rooms, then `podman rm --force`s each secret room", () => {
    const p = pod([beadsdRoom, keeperdRoom]);
    const { run, calls } = recorder(ok);
    downPod(p, run);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["kube", "down", "-"]);
    expect(calls[1]!.args).toEqual(["rm", "--force", "prx-pod-keeperd-room"]);
  });
});
