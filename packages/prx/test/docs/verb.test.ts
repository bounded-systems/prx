// `prx docs` verb: registration, help, and — the key guard — that `docs --check`
// reports ZERO drift on the committed tree. That last test is the byte-correctness
// proof: the verb renders every gated target via the same functions the gen-*
// scripts use, so if its output matched the scripts' (and CI keeps those
// committed), driftCount must be 0.

import { describe, expect, test } from "bun:test";

import { dispatch } from "@bounded-systems/verbspec";
import { verbRegistry } from "../../src/cli/verb-registry.ts";
import { DocsReport, docsVerb } from "../../src/docs/verb.ts";

describe("prx docs verb", () => {
  test("is a registered VerbSpec (id/actor/output)", () => {
    expect(docsVerb.id).toBe("docs");
    expect(docsVerb.actor).toBe("work");
    expect(docsVerb.output).toBe(DocsReport);
    expect(verbRegistry.docs).toBe(docsVerb);
  });

  test("dispatch resolves `docs --help` to its usage", async () => {
    const res = await dispatch(verbRegistry, ["docs", "--help"]);
    expect(res.kind).toBe("help");
    if (res.kind === "help") expect(res.text).toContain("prx docs");
  });

  test("`docs --check` reports zero drift on the committed tree", async () => {
    const res = await dispatch(verbRegistry, ["docs", "--check"]);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const report = DocsReport.parse(res.output);
      expect(report.check).toBe(true);
      // cli is intentionally not gated → skipped in check mode.
      expect(report.targets.some((t) => t.name === "cli" && t.status === "skipped")).toBe(true);
      const drifted = report.targets.filter((t) => t.status === "drifted").map((t) => t.path);
      expect(drifted, `committed docs drifted: ${drifted.join(", ")}`).toEqual([]);
      expect(report.driftCount).toBe(0);
    }
  });
});
