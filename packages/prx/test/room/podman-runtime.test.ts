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
  renderKeeperdRun,
  runKeeperd,
  stopKeeperd,
  DEFAULT_KEEPER_SECRET_TARGET,
  type KeeperdRunSpec,
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

describe("renderKeeperdRun (secret-daemon launch, prx-b44y)", () => {
  const base: KeeperdRunSpec = {
    image: "keeperd-box",
    secret: { name: "prx-keeper-key" },
    doorVolume: "prx-doors",
    repo: "/host/repo",
  };

  test("renders `podman run --secret` with the door fabric + repo + --cwd", () => {
    expect(renderKeeperdRun(base)).toEqual([
      "run", "-d", "--name", "keeperd-room",
      "--secret", `prx-keeper-key,target=${DEFAULT_KEEPER_SECRET_TARGET}`,
      "-v", "prx-doors:/run/prx/doors",
      "-v", "/host/repo:/work",
      "keeperd-box", "--cwd", "/work",
    ]);
  });

  test("joins a pod, honors a custom secret target + extra secrets (e.g. push cred)", () => {
    const argv = renderKeeperdRun({
      ...base,
      name: "keeperd",
      pod: "prx-pod",
      secret: { name: "kkey", target: "/secrets/k" },
      extraSecrets: [{ name: "push-cred", target: "/secrets/push" }],
    });
    expect(argv.slice(0, 6)).toEqual(["run", "-d", "--name", "keeperd", "--pod", "prx-pod"]);
    expect(argv).toContain("kkey,target=/secrets/k");
    expect(argv).toContain("push-cred,target=/secrets/push");
    // the key never appears as a value — only the secret NAME crosses (host-backed).
    expect(argv.join(" ")).not.toContain("ed25519:");
  });

  test("the door fabric may be a host path (shared with the kube-play pod)", () => {
    const argv = renderKeeperdRun({ ...base, doorVolume: "/run/host/doors", doorDir: "/run/prx/doors" });
    expect(argv).toContain("/run/host/doors:/run/prx/doors");
  });
});

describe("runKeeperd / stopKeeperd", () => {
  const spec: KeeperdRunSpec = {
    image: "keeperd-box",
    secret: { name: "prx-keeper-key" },
    doorVolume: "prx-doors",
    repo: "/host/repo",
  };

  test("runKeeperd execs the rendered argv (no stdin)", () => {
    const { run, calls } = recorder(ok);
    runKeeperd(spec, run);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(renderKeeperdRun(spec));
    expect(calls[0]!.input).toBeUndefined();
  });

  test("runKeeperd throws PodmanRuntimeError on a non-zero exit", () => {
    const { run } = recorder({ status: 125, stdout: "", stderr: "no such secret" });
    expect(() => runKeeperd(spec, run)).toThrow(PodmanRuntimeError);
  });

  test("stopKeeperd removes the container by name", () => {
    const { run, calls } = recorder(ok);
    stopKeeperd("keeperd-room", run);
    expect(calls[0]!.args).toEqual(["rm", "-f", "keeperd-room"]);
  });
});
