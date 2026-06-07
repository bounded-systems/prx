// `prx features` verb: registration, help, and the guard — `features --check`
// reports ZERO drift on the committed tree, proving the registry renders every
// .feature byte-identically to what the gen-*-feature scripts committed.

import { describe, expect, test } from "bun:test";

import { dispatch } from "../../src/cli/verbspec.ts";
import { verbRegistry } from "../../src/cli/verb-registry.ts";
import { FeaturesReport, featuresVerb } from "../../src/features/verb.ts";

describe("prx features verb", () => {
  test("is a registered VerbSpec (id/actor/output)", () => {
    expect(featuresVerb.id).toBe("features");
    expect(featuresVerb.actor).toBe("work");
    expect(featuresVerb.output).toBe(FeaturesReport);
    expect(verbRegistry.features).toBe(featuresVerb);
  });

  test("dispatch resolves `features --help` to its usage", async () => {
    const res = await dispatch(verbRegistry, ["features", "--help"]);
    expect(res.kind).toBe("help");
    if (res.kind === "help") expect(res.text).toContain("prx features");
  });

  test("`features --check` reports zero drift on the committed tree", async () => {
    const res = await dispatch(verbRegistry, ["features", "--check"]);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const report = FeaturesReport.parse(res.output);
      expect(report.check).toBe(true);
      expect(report.count).toBe(5);
      expect(report.driftCount).toBe(0);
    }
  });
});
