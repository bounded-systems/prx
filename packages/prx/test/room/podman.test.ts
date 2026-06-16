// The podman driver: PodSpec → `podman kube play` manifest. Asserts the
// structure (containers per room, the shared tmpfs door volume, and the wired
// gate env on the right container) without running podman.

import { describe, expect, test } from "bun:test";

import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import { podmanDriver, renderPodmanKube } from "../../src/room/podman.ts";

describe("renderPodmanKube", () => {
  const manifest = renderPodmanKube(perRepoPod);

  test("is a kube Pod named after the pod", () => {
    expect(manifest).toContain("kind: Pod");
    expect(manifest).toContain(`name: "prx-pod"`);
  });

  test("declares a tmpfs door-fabric volume shared by the containers", () => {
    expect(manifest).toContain("name: prx-doors");
    expect(manifest).toContain("emptyDir:");
    expect(manifest).toContain("medium: Memory");
    // Every room mounts it at the pod's doorDir.
    const mounts = manifest.match(/mountPath: "\/run\/prx\/doors"/g) ?? [];
    expect(mounts.length).toBe(perRepoPod.rooms.length);
  });

  test("renders one container per room", () => {
    for (const room of perRepoPod.rooms) {
      expect(manifest).toContain(`- name: ${JSON.stringify(room.name)}`);
    }
  });

  test("renders each room's declared -box image (no placeholder TODO)", () => {
    expect(manifest).toContain(`image: "claude-box"`);
    expect(manifest).toContain(`image: "beadsd-box"`);
    expect(manifest).toContain(`image: "keeperd-box"`);
    // every pod-member room declares an image → no placeholder fallback fires.
    expect(manifest).not.toContain("TODO(prx-zj8): no image declared");
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

  test("mounts the repo at /work in every room (the daemon WorkingDir)", () => {
    const m = renderPodmanKube({ ...perRepoPod, repo: "/host/repo" });
    const mounts = m.match(/mountPath: "\/work"/g) ?? [];
    expect(mounts.length).toBe(perRepoPod.rooms.length);
  });

  test("emits no repo volume or /work mount when pod.repo is unset (back-compat)", () => {
    const m = renderPodmanKube(perRepoPod);
    expect(m).not.toContain("prx-repo");
    expect(m).not.toContain("hostPath:");
    expect(m).not.toContain(`mountPath: "/work"`);
  });
});
