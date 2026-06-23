// launchPod = playPod (bring the pod up, keeper door last) + attestLaunchForPod
// (attest + store the L2; the daemon remembers it so the box's writes auto-link).
// Best-effort attest: a failure surfaces as null but never tears the pod down.
import { describe, test, expect, afterEach } from "bun:test";
import { getEnv, deleteEnv, setEnv } from "@bounded-systems/env";

import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import { PodSpecSchema } from "../../src/room/pod.ts";
import { launchPod, type PodmanRunResult } from "../../src/room/podman-runtime.ts";

const ok: PodmanRunResult = { status: 0, stdout: "", stderr: "" };

const readyNow = async () => true; // inject: socket already ready

describe("launchPod", () => {
  test("brings the pod up, then attests + returns the l2LaunchDigest", async () => {
    let attestedFor: string | undefined;
    const { results, l2LaunchDigest } = await launchPod(perRepoPod, {
      run: () => ok,
      provision: () => ok,
      waitForSocket: readyNow,
      attestLaunch: async (pod) => {
        attestedFor = pod.name;
        return "l".repeat(64);
      },
    });
    expect(results.length).toBeGreaterThan(0); // playPod ran (provision + runs)
    expect(attestedFor).toBe(perRepoPod.name); // attested AFTER the pod came up
    expect(l2LaunchDigest).toBe("l".repeat(64));
  });

  test("a launch-attest failure is best-effort: pod stays up, digest is null", async () => {
    const { results, l2LaunchDigest } = await launchPod(perRepoPod, {
      run: () => ok,
      provision: () => ok,
      waitForSocket: readyNow,
      attestLaunch: async () => {
        throw new Error("no keeper door");
      },
    });
    expect(results.length).toBeGreaterThan(0); // the pod is up regardless
    expect(l2LaunchDigest).toBeNull();
  });

  test("sets KEEPERD_HOST (TCP) when the keeperd-room has a tcpPort (macOS virtiofs workaround)", async () => {
    // perRepoPod's keeperd-room declares tcpPort: 9999 — launchPod must use
    // KEEPERD_HOST=127.0.0.1:9999 (not KEEPERD_SOCK) so the Mac host client
    // reaches the daemon via TCP, bypassing the virtiofs Unix-socket limitation.
    let observedHost: string | undefined;
    let observedSock: string | undefined;
    await launchPod(perRepoPod, {
      run: () => ok,
      provision: () => ok,
      waitForSocket: readyNow,
      attestLaunch: async () => {
        observedHost = getEnv("KEEPERD_HOST");
        observedSock = getEnv("KEEPERD_SOCK");
        return "t".repeat(64);
      },
    });
    expect(observedHost).toBe("127.0.0.1:9999");
    // KEEPERD_SOCK is left alone (not set) when KEEPERD_HOST is used.
    expect(observedSock).toBeUndefined();
  });

  test("restores KEEPERD_HOST to its prior value (or deletes it) after attestation", async () => {
    const prevHost = getEnv("KEEPERD_HOST");
    try {
      // No prior KEEPERD_HOST: must be deleted after.
      deleteEnv("KEEPERD_HOST");
      await launchPod(perRepoPod, {
        run: () => ok,
        provision: () => ok,
        waitForSocket: readyNow,
        attestLaunch: async () => "x".repeat(64),
      });
      expect(getEnv("KEEPERD_HOST")).toBeUndefined();

      // Prior value: must be restored after.
      setEnv("KEEPERD_HOST", "old-host:8080");
      await launchPod(perRepoPod, {
        run: () => ok,
        provision: () => ok,
        waitForSocket: readyNow,
        attestLaunch: async () => "x".repeat(64),
      });
      expect(getEnv("KEEPERD_HOST")).toBe("old-host:8080");
    } finally {
      if (prevHost !== undefined) setEnv("KEEPERD_HOST", prevHost);
      else deleteEnv("KEEPERD_HOST");
    }
  });

  test("falls back to KEEPERD_SOCK (Unix) when the keeperd-room has no tcpPort", async () => {
    // Strip tcpPort from keeperd-room so we test the Linux / Unix-socket path.
    const noTcpPod = PodSpecSchema.parse({
      ...perRepoPod,
      rooms: perRepoPod.rooms.map((r) =>
        r.name === "keeperd-room" ? { ...r, tcpPort: undefined } : r,
      ),
    });
    let observedHost: string | undefined;
    let observedSock: string | undefined;
    const prevSock = getEnv("KEEPERD_SOCK");
    try {
      deleteEnv("KEEPERD_SOCK");
      await launchPod(noTcpPod, {
        run: () => ok,
        provision: () => ok,
        waitForSocket: readyNow,
        attestLaunch: async () => {
          observedHost = getEnv("KEEPERD_HOST");
          observedSock = getEnv("KEEPERD_SOCK");
          return "u".repeat(64);
        },
      });
    } finally {
      if (prevSock !== undefined) setEnv("KEEPERD_SOCK", prevSock);
      else deleteEnv("KEEPERD_SOCK");
    }
    expect(observedHost).toBeUndefined(); // KEEPERD_HOST not touched
    expect(observedSock).toBeDefined();   // KEEPERD_SOCK was set
  });
});
