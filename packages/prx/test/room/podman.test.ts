// The podman driver: PodSpec → `podman kube play` manifest + the `podman run
// --secret` argv for a secret-holding room (prx-b44y). Asserts the structure
// (containers per non-secret room, the shared hostPath door volume, the wired
// gate env, and the secret-room split) without running podman.

import { describe, expect, test } from "bun:test";

import { BEADSD_ROOM_IMAGE } from "../../src/room/beadsd-room.ts";
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
    const mountLine = `mountPath: "${dir}"`;
    const mounts = manifest.split(mountLine).length - 1;
    expect(mounts).toBe(kubeRooms.length);
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
    expect(manifest).toContain(`image: "${BEADSD_ROOM_IMAGE}"`);
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
    expect(manifest).toContain(`value: "${perRepoPod.doorDir}/keeperd.sock"`);
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
    expect(manifest).toContain(`value: "${perRepoPod.doorDir}/beadsd.sock"`);
  });

  test("overrides beadsd-room's --socket to the shared fabric path (prx-asr)", () => {
    // The beadsd-box image bakes `--socket /run/prx/doors/beadsd.sock`; the kube
    // container must override it to the mounted doorDir so the socket lands on
    // the fabric consumers read (else beadsd serves off-fabric, unreachable).
    expect(manifest).toContain("args:");
    expect(manifest).toContain(`- "--socket"`);
    expect(manifest).toContain(`- "${perRepoPod.doorDir}/beadsd.sock"`);
  });

  test("does NOT add a --socket override for claude-room's sealed control door", () => {
    // claude-room exposes only `control` (state: closed) and its occupant is
    // `claude`, which would choke on a stray --socket. Assert no control socket
    // arg is emitted.
    expect(manifest).not.toContain(`${perRepoPod.doorDir}/control.sock`);
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

describe("renderPodmanKube — backing services (prx-asr / dolt-box)", () => {
  const svcPod = {
    ...perRepoPod,
    services: [
      {
        name: "dolt",
        image: "ghcr.io/x/dolt-box@sha256:abc",
        dataVolume: { name: "prx-dolt-data", mountPath: "/var/lib/dolt" },
        env: { DOLT_PORT: "3307", TMPDIR: "/var/lib/dolt" },
        args: [],
      },
    ],
  };

  test("declares a persistentVolumeClaim named volume for the service data", () => {
    const m = renderPodmanKube(svcPod);
    expect(m).toContain("name: prx-dolt-data");
    expect(m).toContain("persistentVolumeClaim:");
    expect(m).toContain(`claimName: "prx-dolt-data"`);
  });

  test("renders the service as a plain container: image + data mount + env", () => {
    const m = renderPodmanKube(svcPod);
    expect(m).toContain(`- name: "dolt"`);
    expect(m).toContain(`image: "ghcr.io/x/dolt-box@sha256:abc"`);
    expect(m).toContain(`mountPath: "/var/lib/dolt"`);
    // env is sorted; both keys present
    expect(m).toContain("name: DOLT_PORT");
    expect(m).toContain(`value: "3307"`);
    expect(m).toContain("name: TMPDIR");
  });

  test("a backing service gets NO door fabric mount and NO --socket args", () => {
    // Isolate the service container's slice of the manifest.
    const lines = renderPodmanKube(svcPod).split("\n");
    const start = lines.findIndex((l) => l.includes(`- name: "dolt"`));
    const slice = lines.slice(start).join("\n");
    expect(slice).not.toContain("--socket");
    // The dolt container mounts ONLY its data volume, not the door fabric.
    expect(slice).not.toContain(`mountPath: "${svcPod.doorDir}"`);
  });

  test("emits no persistentVolumeClaim when the pod has no services", () => {
    const m = renderPodmanKube({ ...perRepoPod, services: [] });
    expect(m).not.toContain("persistentVolumeClaim:");
    expect(m).not.toContain(`- name: "dolt"`);
  });

  test("the canonical per-repo pod ships the dolt backing service", () => {
    expect(perRepoPod.services?.length).toBeGreaterThan(0);
    const m = renderPodmanKube(perRepoPod);
    expect(m).toContain(`- name: "dolt"`);
    expect(m).toContain(`claimName: "prx-dolt-data"`);
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

  test("image precedes CMD args; CMD args override entrypoint socket + key (prx-9yv3)", () => {
    const imageIdx = argv.indexOf(KEEPERD_ROOM_IMAGE);
    expect(imageIdx).toBeGreaterThanOrEqual(0);
    // CMD args after the image override the entrypoint's hardcoded defaults
    // (door-kit parseArgs last-wins): --socket for the fabric path, --key for
    // the host-backed secret mount, --port for TCP (macOS virtiofs workaround).
    const cmdArgs = argv.slice(imageIdx + 1);
    const socketIdx = cmdArgs.lastIndexOf("--socket");
    expect(socketIdx).toBeGreaterThanOrEqual(0);
    expect(cmdArgs[socketIdx + 1]).toBe(`${perRepoPod.doorDir}/keeperd.sock`);
    const keyIdx = cmdArgs.lastIndexOf("--key");
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    expect(cmdArgs[keyIdx + 1]).toBe("/run/secrets/keeper-key");
    const portIdx = cmdArgs.lastIndexOf("--port");
    expect(portIdx).toBeGreaterThanOrEqual(0);
    expect(cmdArgs[portIdx + 1]).toBe("9999");
  });

  test("publishes the TCP port for the macOS virtiofs workaround (prx-zj8)", () => {
    // virtiofs exposes the socket file but not socket semantics → Mac host
    // can't connect via Unix; port mapping lets it connect via KEEPERD_HOST.
    const i = argv.indexOf("--publish");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("9999:9999");
    // A room without tcpPort gets no --publish.
    const noPort = renderPodmanRun(
      {
        ...perRepoPod,
        rooms: perRepoPod.rooms.map((r) =>
          r.name === "keeperd-room" ? { ...r, tcpPort: undefined } : r,
        ),
      },
      "keeperd-room",
    );
    expect(noPort).not.toContain("--publish");
  });

  test("adds the repo /work mount (shared :z) + workdir only when pod.repo is set", () => {
    expect(argv).not.toContain("--workdir");
    const withRepo = renderPodmanRun({ ...perRepoPod, repo: "/host/repo" }, "keeperd-room");
    expect(withRepo).toContain("/host/repo:/work:z");
    const w = withRepo.indexOf("--workdir");
    expect(withRepo[w + 1]).toBe("/work");
  });

  test("the keeper room exposes (does not consume) → no consumer PRX_*_DOOR env, but does get KEEPERD_SOCK server socket env", () => {
    // keeperd-room consumes nothing → no PRX_*_DOOR consumer env.
    const envPairs = argv.reduce<string[]>(
      (acc, val, i) => (argv[i - 1] === "--env" ? [...acc, val] : acc),
      [],
    );
    expect(envPairs.every((e) => !e.startsWith("PRX_"))).toBe(true);
    // keeperd exposes a door → gets KEEPERD_SOCK so the daemon writes its socket
    // onto the shared fabric (not the in-box default /run/keeperd.sock).
    expect(envPairs.some((e) => e.startsWith("KEEPERD_SOCK="))).toBe(true);
    const keeperSockEnv = envPairs.find((e) => e.startsWith("KEEPERD_SOCK="));
    expect(keeperSockEnv).toBe(`KEEPERD_SOCK=${perRepoPod.doorDir}/keeperd.sock`);
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
