// The podman driver: PodSpec → `podman kube play` manifest + the `podman run
// --secret` argv for a secret-holding room (prx-b44y). Asserts the structure
// (containers per non-secret room, the shared hostPath door volume, the wired
// gate env, and the secret-room split) without running podman.

import { describe, expect, test } from "bun:test";

import { KEEPERD_ROOM_IMAGE } from "../../src/room/keeperd-room.ts";
import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import {
  podmanDriver,
  quadletUnitName,
  renderDoorFabricProvision,
  renderPodmanKube,
  renderPodmanQuadlet,
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
    const dir = perRepoPod.doorDir;
    expect(manifest).toContain(`path: "${dir}"`);
    expect(manifest).toContain("type: DirectoryOrCreate");
    expect(manifest).not.toContain("emptyDir:");
    // Every NON-SECRET room mounts it at the pod's doorDir.
    const escapedDir = dir.replace(/\//g, "\\/");
    const mounts = manifest.match(new RegExp(`mountPath: "${escapedDir}"`, "g")) ?? [];
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
    // The keeperd image is delivered by `podman run`, not the kube manifest.
    expect(manifest).not.toContain(`image: "${KEEPERD_ROOM_IMAGE}"`);
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
    expect(() =>
      renderPodmanKube({ name: "", executor: { name: "h" }, rooms: [] } as never),
    ).toThrow();
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

  test("mounts the SAME host door fabric the kube pod mounts, with a shared :z relabel", () => {
    const i = argv.indexOf("--volume");
    expect(i).toBeGreaterThanOrEqual(0);
    // `:z` (shared) so an SELinux-enforcing host lets the keeper write its socket
    // on the dir shared with the kube pod (prx-3urm); shared, not private `:Z`.
    const dir = perRepoPod.doorDir;
    expect(argv[i + 1]).toBe(`${dir}:${dir}:z`);
  });

  test("ends with the room's image", () => {
    expect(argv[argv.length - 1]).toBe(KEEPERD_ROOM_IMAGE);
  });

  test("adds the repo /work mount (shared :z) + workdir only when pod.repo is set", () => {
    expect(argv).not.toContain("--workdir");
    const withRepo = renderPodmanRun({ ...perRepoPod, repo: "/host/repo" }, "keeperd-room");
    expect(withRepo).toContain("/host/repo:/work:z");
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

describe("renderPodmanQuadlet (prx-b44y — production systemd form)", () => {
  const unit = renderPodmanQuadlet(perRepoPod, "keeperd-room");
  const lines = unit.split("\n");

  test("is a well-formed quadlet with the required sections", () => {
    expect(unit.startsWith("# Generated by prx")).toBe(true);
    for (const section of ["[Unit]", "[Container]", "[Service]", "[Install]"]) {
      expect(lines).toContain(section);
    }
    expect(unit.endsWith("\n")).toBe(true);
  });

  test("names the unit and container stably", () => {
    expect(quadletUnitName(perRepoPod, "keeperd-room")).toBe("prx-pod-keeperd-room.container");
    expect(lines).toContain(`ContainerName=${secretRoomContainer(perRepoPod, "keeperd-room")}`);
    expect(lines).toContain(`Image=${KEEPERD_ROOM_IMAGE}`);
  });

  test("delivers the signing key via a host-backed Secret= (never a layer)", () => {
    expect(lines).toContain("Secret=prx-keeper-key,target=/run/secrets/keeper-key");
    // The key must never appear as a baked Environment= or a manifest literal.
    expect(unit).not.toContain("Environment=PRX_PROVENANCE_KEY");
  });

  test("mounts the shared door fabric with a shared :z relabel (prx-3urm)", () => {
    // `:z` so an SELinux-enforcing host (the common production case) lets the
    // keeper write its socket on the shared door dir; shared, not private `:Z`.
    const dir = perRepoPod.doorDir;
    expect(lines).toContain(`Volume=${dir}:${dir}:z`);
  });

  test("borrows claude-box's hardening floor; keeps egress for the push", () => {
    expect(lines).toContain("NoNewPrivileges=true");
    expect(lines).toContain("DropCapability=all");
    expect(lines).toContain("Restart=always");
    // prx's keeperd holds the push credential → egress NOT disabled (unlike claude-box).
    expect(lines).not.toContain("Network=none");
  });

  test("adds the repo /work mount + WorkingDir only when pod.repo is set", () => {
    expect(lines).not.toContain("WorkingDir=/work");
    const withRepo = renderPodmanQuadlet(
      { ...perRepoPod, repo: "/host/repo" },
      "keeperd-room",
    ).split("\n");
    expect(withRepo).toContain("Volume=/host/repo:/work:z");
    expect(withRepo).toContain("WorkingDir=/work");
  });

  test("throws on the same wiring errors as renderPodmanRun", () => {
    expect(() => renderPodmanQuadlet(perRepoPod, "ghost-room")).toThrow(/not a member/);
    expect(() => renderPodmanQuadlet(perRepoPod, "claude-room")).toThrow(/holds no secret/);
  });
});

describe("renderDoorFabricProvision (prx-3urm — door-dir provisioning + relabel)", () => {
  const argv = renderDoorFabricProvision("/run/prx/doors");

  test("is an `sh -c` host command (the one sanctioned spawn via proc)", () => {
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
  });

  test("mkdir -p's the door dir, then best-effort relabels it to the shared `:z` context", () => {
    const cmd = argv[2]!;
    // mkdir -p so a missing dir (the all-secret-rooms gap) is created — and
    // `set -e` so a real mkdir failure aborts the bring-up.
    expect(cmd).toContain("set -e");
    expect(cmd).toContain("mkdir -p '/run/prx/doors'");
    // chcon to container_file_t == the `:z` shared label, BEFORE kube-play.
    expect(cmd).toContain("chcon -R -t container_file_t '/run/prx/doors'");
  });

  test("guards the relabel so it is a no-op off SELinux / unprivileged", () => {
    const cmd = argv[2]!;
    // Skipped when chcon is absent (non-SELinux host)…
    expect(cmd).toContain("command -v chcon >/dev/null 2>&1");
    // …and never aborts the step when it fails (unprivileged).
    expect(cmd.trimEnd()).toMatch(/\|\| true$/);
  });

  test("POSIX single-quotes the dir so a hostile path can't break out of the command", () => {
    const cmd = renderDoorFabricProvision("/run/prx/doors'; rm -rf /")[2]!;
    // The embedded quote is escaped (`'\''`), keeping the payload inside the literal.
    expect(cmd).toContain(`'/run/prx/doors'\\''; rm -rf /'`);
    expect(cmd).not.toContain("; rm -rf / ");
  });
});
