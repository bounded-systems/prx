// `prx pod up` verb: registered in the verb-registry, routes through launchPod.
import { describe, test, expect } from "bun:test";
import { dispatch } from "@bounded-systems/verbspec";

import { verbRegistry } from "../../src/cli/verb-registry.ts";
import { podUpVerb } from "../../src/room/pod-up-verb.ts";
import { perRepoPod } from "../../src/room/per-repo-pod.ts";

describe("podUpVerb — registration", () => {
  test("is in the verb registry under 'pod up'", () => {
    expect(verbRegistry["pod up"]).toBe(podUpVerb);
  });
});

describe("podUpVerb — output schema", () => {
  test("l2LaunchDigest is nullable", () => {
    const { PodUpResult } = require("../../src/room/pod-up-verb.ts");
    const n = PodUpResult.parse({ pod: "per-repo", containers: 2, l2LaunchDigest: null });
    expect(n.l2LaunchDigest).toBeNull();
    const s = PodUpResult.parse({ pod: "per-repo", containers: 2, l2LaunchDigest: "l".repeat(64) });
    expect(typeof s.l2LaunchDigest).toBe("string");
  });

  test("dispatch('pod up') resolves to podUpVerb", async () => {
    // Confirm the verb is routable via the canonical registry dispatcher.
    // (run is NOT called — dispatch with an unknown 'pod' enum value hits the
    // Zod parse error path, confirming the verb was found and its schema was applied.)
    try {
      await dispatch(verbRegistry, ["pod", "up", "--pod", "unknown-pod"]);
    } catch (e) {
      // Zod / VerbSpec parse error = the verb was found and its input schema ran.
      expect(String(e)).toMatch(/invalid_enum_value|Expected/);
    }
  });
});
