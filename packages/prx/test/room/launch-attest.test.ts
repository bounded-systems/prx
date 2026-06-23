// The launch-attestation orchestration step: manifest = the pod's held doors,
// attested via the keeper door + stored; returns the l2LaunchDigest.
import { describe, test, expect } from "bun:test";

import { perRepoPod } from "../../src/room/per-repo-pod.ts";
import { attestLaunchForPod, podLaunchManifest } from "../../src/room/launch-attest.ts";

describe("podLaunchManifest", () => {
  test("is the pod's resolved door grants, deterministically ordered", () => {
    const m = podLaunchManifest(perRepoPod);
    expect(m.pod).toBe(perRepoPod.name);
    expect(Array.isArray(m.doors)).toBe(true);
    // each door names the authority the box holds
    for (const d of m.doors) {
      expect(typeof d.door).toBe("string");
      expect(typeof d.capability).toBe("string");
      expect(typeof d.consumer).toBe("string");
    }
    // deterministic (same input → same manifest)
    expect(podLaunchManifest(perRepoPod)).toEqual(m);
  });
});

describe("attestLaunchForPod", () => {
  test("attests the manifest via the keeper door, stores the L2, returns the digest", async () => {
    let sent: { subject: string; manifest: unknown } | undefined;
    let storedL2: unknown;
    const digest = await attestLaunchForPod(perRepoPod, {
      attestLaunch: async (opts) => {
        sent = opts;
        return {
          subject: opts.subject,
          manifestDigest: "m".repeat(64),
          l2LaunchDigest: "l".repeat(64),
          attestation: { statement: { x: 1 }, signature: "sig" },
        };
      },
      store: async (l2) => {
        storedL2 = l2;
        return "stored-digest";
      },
    });
    expect(sent?.subject).toBe(perRepoPod.name);
    expect(sent?.manifest).toEqual(podLaunchManifest(perRepoPod));
    expect(storedL2).toEqual({ statement: { x: 1 }, signature: "sig" });
    expect(digest).toBe("stored-digest");
  });
});
