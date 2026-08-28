import { describe, expect, test } from "bun:test";

import { CONCIERGED_ROOM_IMAGE, conciergedRoom } from "../../src/room/concierged-room.ts";
import { PodSpecSchema, type PodSpec } from "../../src/room/pod.ts";
import { renderPodmanKube, renderPodmanRun } from "../../src/room/podman.ts";
import { roomNeedsSecretRuntime } from "../../src/room/spec.ts";

function podWith(): PodSpec {
  return PodSpecSchema.parse({
    name: "prx-pod",
    executor: { name: "house" },
    rooms: [conciergedRoom],
  });
}

describe("conciergedRoom spec", () => {
  test("exposes the grant:broker door on the shared fabric, in-pod unix only", () => {
    expect(conciergedRoom.doors).toEqual([
      {
        name: "concierged",
        direction: "expose",
        capability: "grant:broker",
        socket: "/run/prx/doors/concierged.sock",
      },
    ]);
    // In-pod unix only — the broker is never TCP-published (no macOS workaround
    // port; consumers reach it over the door fabric, held-ref authority).
    expect(conciergedRoom.tcpPort).toBeUndefined();
  });

  test("is a secret-holding room carrying the provenance master", () => {
    expect(roomNeedsSecretRuntime(conciergedRoom)).toBe(true);
    expect(conciergedRoom.secrets).toEqual([
      { name: "prx-provenance-master", target: "/run/secrets/provenance-master" },
    ]);
  });
});

describe("conciergedRoom renders as a secret room (podman run --secret)", () => {
  const pod = podWith();
  const argv = renderPodmanRun(pod, "concierged-room");

  test("mounts the provenance master secret onto tmpfs", () => {
    const i = argv.indexOf("--secret");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("prx-provenance-master,target=/run/secrets/provenance-master");
  });

  test("overrides the daemon socket onto the shared door fabric", () => {
    const i = argv.indexOf("--socket");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]!.endsWith("/concierged.sock")).toBe(true);
    expect(argv[i + 1]!.startsWith(pod.guestDoorDir)).toBe(true);
  });

  test("runs the concierged-box image", () => {
    expect(argv).toContain(CONCIERGED_ROOM_IMAGE);
  });

  test("never publishes a TCP port (no --publish)", () => {
    expect(argv).not.toContain("--publish");
  });

  test("is omitted from the kube manifest (secret rooms run standalone)", () => {
    expect(renderPodmanKube(pod)).not.toContain("concierged-room");
  });
});
