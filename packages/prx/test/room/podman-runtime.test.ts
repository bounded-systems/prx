// The podman runtime — play/down a PodSpec via `podman kube play|down -`.
// The runner is injected, so this drives the orchestration fully offline.

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { PodSpecSchema, type PodSpec } from "../../src/room/pod.ts";
import { renderPodmanKube } from "../../src/room/podman.ts";
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
  test("pipes the rendered manifest into `podman kube play -`", () => {
    const p = pod([beadsdRoom]);
    const { run, calls } = recorder(ok);
    const res = playPod(p, run);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["kube", "play", "-"]);
    expect(calls[0]!.input).toBe(renderPodmanKube(p)); // exact manifest on stdin
    expect(res).toEqual(ok);
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
  test("pipes the rendered manifest into `podman kube down -`", () => {
    const p = pod([beadsdRoom]);
    const { run, calls } = recorder(ok);
    downPod(p, run);
    expect(calls[0]!.args).toEqual(["kube", "down", "-"]);
    expect(calls[0]!.input).toBe(renderPodmanKube(p));
  });
});
