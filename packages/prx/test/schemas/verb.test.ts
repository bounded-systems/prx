// `prx schemas` verb: registration, help, and the key guard — `schemas --check`
// reports ZERO drift on the committed tree, proving the registry renders every
// artifact byte-identically to what the export-* scripts committed.

import { describe, expect, test } from "bun:test";

import { dispatch } from "@bounded-systems/verbspec";
import { verbRegistry } from "../../src/cli/verb-registry.ts";
import { SchemasReport, schemasVerb } from "../../src/schemas/verb.ts";

describe("prx schemas verb", () => {
  test("is a registered VerbSpec (id/actor/output)", () => {
    expect(schemasVerb.id).toBe("schemas");
    expect(schemasVerb.actor).toBe("work");
    expect(schemasVerb.output).toBe(SchemasReport);
    expect(verbRegistry.schemas).toBe(schemasVerb);
  });

  test("dispatch resolves `schemas --help` to its usage", async () => {
    const res = await dispatch(verbRegistry, ["schemas", "--help"]);
    expect(res.kind).toBe("help");
    if (res.kind === "help") expect(res.text).toContain("prx schemas");
  });

  test("`schemas --check` reports zero drift on the committed tree", async () => {
    const res = await dispatch(verbRegistry, ["schemas", "--check"]);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const report = SchemasReport.parse(res.output);
      expect(report.check).toBe(true);
      expect(report.count).toBeGreaterThan(0);
      expect(report.driftCount).toBe(0);
    }
  });
});
