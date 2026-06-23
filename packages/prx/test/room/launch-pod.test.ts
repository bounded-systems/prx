// launchPod = playPod (bring the pod up, keeper door last) + attestLaunchForPod
// (attest + store the L2; the daemon remembers it so the box's writes auto-link).
// Best-effort attest: a failure surfaces as null but never tears the pod down.
import { describe, test, expect } from "bun:test";

import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import { launchPod, type PodmanRunResult } from "../../src/room/podman-runtime.ts";

const ok: PodmanRunResult = { status: 0, stdout: "", stderr: "" };

describe("launchPod", () => {
  test("brings the pod up, then attests + returns the l2LaunchDigest", async () => {
    let attestedFor: string | undefined;
    const { results, l2LaunchDigest } = await launchPod(perRepoPod, {
      run: () => ok,
      provision: () => ok,
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
      attestLaunch: async () => {
        throw new Error("no keeper door");
      },
    });
    expect(results.length).toBeGreaterThan(0); // the pod is up regardless
    expect(l2LaunchDigest).toBeNull();
  });
});
