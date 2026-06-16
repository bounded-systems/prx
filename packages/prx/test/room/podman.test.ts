// The podman driver: PodSpec → `podman kube play` manifest + the `podman run
// --secret` argv for a secret-holding room (prx-b44y). Asserts the structure
// (containers per non-secret room, the shared hostPath door volume, the wired
// gate env, and the secret-room split) without running podman.

import { describe, expect, test } from "bun:test";

import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import {
  podmanDriver,
  renderPodmanKube,
  renderPodmanRun,
  secretRoomContainer,
} from "../../src/room/podman.ts";
import { roomNeedsSecretRuntime } from "../../src/room/spec.ts";

const kubeRooms = perRepoPod.rooms.filter((r) => !roomNeedsSecretRuntime(r));
const secretRooms = perRepoPod.rooms.filter(roomNeedsSecretRuntime);

describe("renderPodmanKube", () => {
  const manifest = renderPodmanKube(perRepoPod);

  test("is a kube Pod named after the pod", () => {
    expect(manifest).toContain("kind: Pod");
    expect(manifest).toContain(`name: "prx-pod"`);
  });

  test("declares the shared hostPath door fabric both runtimes mount", () => {
    expect(manifest).toContain("name: prx-doors");
    // hostPath (not a pod-private emptyDir) so a standalone secret-room container
    // mounts the SAME door dir; DirectoryOrCreate so podman provisions it.
    expect(manifest).toContain("hostPath:");
    expect(manifest).toContain(`path: "/run/prx/doors"`);
    expect(manifest).toContain("type: DirectoryOrCreate");
    expect(manifest).not.toContain("emptyDir:");
    // Every NON-SECRET room mounts it at the pod's doorDir.
    const mounts = manifest.match(/mountPath: "\/run\/prx\/doors"/g) ?? [];
    expect(mounts.length).toBe(kubeRooms.length);
  });

  test("renders one container per NON-SECRET room (secret rooms run elsewhere)", () => {
    for (const room of kubeRooms) {
      expect(manifest).toContain(`- name: ${JSON.stringify(room.name)}`);
    }
    // keeperd-room holds a secret → not a kube container.
    expect(secretRooms.length).toBeGreaterThan(0);
    for (const room of secretRooms) {
      expect(manifest).not.toContain(`- name: ${JSON.stringify(room.name)}`);
    }
  });

  test("renders each non-secret room's -box image; not the secret room's", () => {
    expect(manifest).toContain(`image: "claude-box"`);
    expect(manifest).toContain(`image: "beadsd-box"`);
    // keeperd-box is delivered by `podman run`, not the kube manifest.
    expect(manifest).not.toContain(`image: "keeperd-box"`);
    // every rendered room declares an image → no placeholder fallback fires.
    expect(manifest).not.toContain("TODO(prx-zj8): no image declared");
  });

  test("keeps the secret room in door resolution: claude-room still gets the keeper env", () => {
    // The keeperd-room is NOT a kube container, but it stays in the pod's door
    // resolution, so claude-room's consumed keeper door still wires its env and
    // it reaches the keeper on the shared fabric (the whole point of the split).
    expect(manifest).toContain("PRX_KEEPER_DOOR");
    expect(manifest).toContain(`value: "keeperd"`);
    expect(manifest).toContain(`value: "/run/prx/doors/keeperd.sock"`);
  });

  test("falls back to a placeholder for a room with no image", () => {
    const noImage = renderPodmanKube({
      name: "p",
      executor: { name: "h" },
      rooms: [{ name: "bare-room" }],
    } as never);
    expect(noImage).toContain(`image: "prx/bare-room:latest"`);
    expect(noImage).toContain("TODO(prx-zj8): no image declared");
  });

  test("projects the wired gate env onto the claude-room container", () => {
    // The beadsd consume↔expose pair resolves → claude-room gets the gate env.
    expect(manifest).toContain("PRX_BEADS_DOOR");
    expect(manifest).toContain(`value: "beadsd"`);
    expect(manifest).toContain(`value: "/run/prx/doors/beadsd.sock"`);
  });

  test("does not emit env for a room with no wired door (beadsd-room)", () => {
    // beadsd-room only exposes; it consumes nothing → no env block for it.
    // Isolate its container slice and assert no `env:` before the next room.
    const lines = manifest.split("\n");
    const start = lines.findIndex((l) => l.includes(`- name: "beadsd-room"`));
    expect(start).toBeGreaterThanOrEqual(0);
    const after = lines.slice(start + 1);
    const nextContainer = after.findIndex((l) => /^ {4}- name: /.test(l));
    const slice = (nextContainer === -1 ? after : after.slice(0, nextContainer)).join("\n");
    expect(slice).not.toContain("env:");
  });

  test("throws on a malformed pod (validation at the seam)", () => {
    expect(() => renderPodmanKube({ name: "", executor: { name: "h" }, rooms: [] } as never)).toThrow();
  });

  test("the driver wraps the renderer", () => {
    expect(podmanDriver.id).toBe("podman");
    expect(podmanDriver.render(perRepoPod)).toBe(manifest);
  });
});

describe("renderPodmanKube — repo /work mount (prx-u5lx)", () => {
  test("declares a hostPath repo volume when pod.repo is set", () => {
    const m = renderPodmanKube({ ...perRepoPod, repo: "/host/repo" });
    expect(m).toContain("name: prx-repo");
    expect(m).toContain("hostPath:");
    expect(m).toContain(`path: "/host/repo"`);
    expect(m).toContain("type: Directory");
  });

  test("mounts the repo at /work in every NON-SECRET room (the daemon WorkingDir)", () => {
    const m = renderPodmanKube({ ...perRepoPod, repo: "/host/repo" });
    const mounts = m.match(/mountPath: "\/work"/g) ?? [];
    expect(mounts.length).toBe(kubeRooms.length);
  });

  test("emits no repo volume or /work mount when pod.repo is unset (back-compat)", () => {
    const m = renderPodmanKube(perRepoPod);
    expect(m).not.toContain("prx-repo");
    expect(m).not.toContain(`mountPath: "/work"`);
    // The door fabric is itself a hostPath now, so assert no *repo* hostPath.
    expect(m).not.toContain(`path: "/host/repo"`);
  });
});

describe("renderPodmanRun (prx-b44y — secret-holding rooms)", () => {
  const argv = renderPodmanRun(perRepoPod, "keeperd-room");

  test("is a detached, replaceable, stably-named `podman run`", () => {
    expect(argv.slice(0, 2)).toEqual(["run", "--detach"]);
    expect(argv).toContain("--replace");
    const i = argv.indexOf("--name");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("prx-pod-keeperd-room");
    expect(argv[i + 1]).toBe(secretRoomContainer(perRepoPod, "keeperd-room"));
  });

  test("injects the host-backed secret to its target (never a layer)", () => {
    const i = argv.indexOf("--secret");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("prx-keeper-key,target=/run/secrets/keeper-key");
  });

  test("mounts the SAME host door fabric the kube pod mounts", () => {
    const i = argv.indexOf("--volume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("/run/prx/doors:/run/prx/doors");
  });

  test("ends with the room's -box image", () => {
    expect(argv[argv.length - 1]).toBe("keeperd-box");
  });

  test("adds the repo /work mount + workdir only when pod.repo is set", () => {
    expect(argv).not.toContain("--workdir");
    const withRepo = renderPodmanRun({ ...perRepoPod, repo: "/host/repo" }, "keeperd-room");
    expect(withRepo).toContain("/host/repo:/work");
    const w = withRepo.indexOf("--workdir");
    expect(withRepo[w + 1]).toBe("/work");
  });

  test("the keeper room exposes (does not consume) → no door env on itself", () => {
    // keeperd-room consumes nothing, so no PRX_*_DOOR env is projected onto it.
    expect(argv).not.toContain("--env");
  });

  test("throws for a non-member room", () => {
    expect(() => renderPodmanRun(perRepoPod, "ghost-room")).toThrow(/not a member/);
  });

  test("throws for a non-secret room (it belongs in the kube pod)", () => {
    expect(() => renderPodmanRun(perRepoPod, "claude-room")).toThrow(/holds no secret/);
  });
});
