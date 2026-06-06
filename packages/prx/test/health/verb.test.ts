// `prx health` verb + the extracted report. The compute path is exercised with
// stubbed IO (no shelling out to knip/dependency-cruiser); the verb wiring is
// checked through the canonical VerbSpec dispatch.

import { describe, expect, test } from "bun:test";

import { CodeHealthReport } from "../../src/health/model.ts";
import { computeHealthReport, renderHealthMarkdown, type HealthIo } from "../../src/health/report.ts";
import { healthVerb } from "../../src/health/verb.ts";
import { dispatch } from "../../src/cli/verbspec.ts";
import { verbRegistry } from "../../src/cli/verb-registry.ts";

const stubIo: HealthIo = {
  tracked: () => ["packages/prx/src/a.ts", "packages/prx/src/b.ts"],
  readFile: () => "const x = z.any();\nJSON.parse(s);\n",
  run: (cmd, args) => {
    if (args.includes("depcruise")) return JSON.stringify({ summary: { violations: [] } });
    if (args.includes("knip-bun")) return JSON.stringify({ issues: [] });
    return "";
  },
};

describe("computeHealthReport", () => {
  test("assembles a schema-valid report from injected IO", () => {
    const report = computeHealthReport(stubIo);
    expect(() => CodeHealthReport.parse(report)).not.toThrow();
    // boundary regex counts the stub file content (2 files × 1 match each).
    expect(report.boundary.zAnyHoles).toBe(2);
    expect(report.boundary.rawJsonParse).toBe(2);
    expect(report.sprawl.fileCount).toBe(2);
    // verbspec lens reflects the real registry (≥0, ≤ total).
    expect(report.verbspec.withInput).toBeLessThanOrEqual(report.verbspec.verbs);
  });
});

describe("renderHealthMarkdown", () => {
  test("projects every lens section from the structured report", () => {
    const md = renderHealthMarkdown(computeHealthReport(stubIo));
    for (const h of ["# prx code health", "## 1. Sprawl", "## 2. Coupling", "## 3. Dead code", "## 4. Product map", "## 5. Zod boundary", "## 6. VerbSpec"]) {
      expect(md).toContain(h);
    }
  });
});

describe("prx health verb", () => {
  test("is a registered VerbSpec whose output contract is the CodeHealthReport", () => {
    expect(healthVerb.id).toBe("health");
    expect(healthVerb.actor).toBe("work");
    expect(healthVerb.output).toBe(CodeHealthReport);
    expect(verbRegistry.health).toBe(healthVerb);
  });

  test("dispatch resolves `health --help` to its usage", async () => {
    const res = await dispatch(verbRegistry, ["health", "--help"]);
    expect(res.kind).toBe("help");
    if (res.kind === "help") expect(res.text).toContain("prx health");
  });
});
