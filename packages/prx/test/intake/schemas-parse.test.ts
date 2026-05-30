import { describe, expect, test } from "bun:test";

import { composeStructuredBody } from "../../src/intake/intake.ts";
import {
  INTAKE_BODY_FIELDS_META,
  INTAKE_BODY_SCHEMA_TYPES,
  parseStructuredBody,
} from "../../src/intake/schemas/index.ts";

describe("parseStructuredBody — round-trip with composeStructuredBody", () => {
  test("description + acceptance round-trips for every type that declares both", () => {
    for (const type of INTAKE_BODY_SCHEMA_TYPES) {
      const meta = INTAKE_BODY_FIELDS_META[type];
      if (!meta.description || !meta.acceptance_criteria) continue;
      const body = composeStructuredBody({
        description: "describe the change",
        acceptance: "users can do the thing",
      });
      const parsed = parseStructuredBody(body, type);
      expect(parsed.fields.description).toBe("describe the change");
      expect(parsed.fields.acceptance_criteria).toBe("users can do the thing");
      expect(parsed.unparsed).toBe("");
    }
  });

  test("feature: description + design + acceptance + notes round-trips", () => {
    const body = composeStructuredBody({
      description: "d",
      design: "x",
      acceptance: "a",
      notes: "n",
    });
    const parsed = parseStructuredBody(body, "feature");
    expect(parsed.fields).toEqual({
      description: "d",
      design: "x",
      acceptance_criteria: "a",
      notes: "n",
    });
    expect(parsed.unparsed).toBe("");
  });
});

describe("parseStructuredBody — hand-written bodies", () => {
  test("bug body with Repro/Expected/Actual sections lands in fields, not unparsed", () => {
    const body = [
      "## Description",
      "",
      "Pinger no longer pings.",
      "",
      "## Repro Steps",
      "",
      "1. Run `gh pr merge` from a clean branch",
      "2. Observe the failure",
      "",
      "## Expected",
      "",
      "Merge succeeds.",
      "",
      "## Actual",
      "",
      "Merge fails.",
      "",
      "## Acceptance Criteria",
      "",
      "Merge works again.",
    ].join("\n");
    const parsed = parseStructuredBody(body, "bug");
    expect(parsed.fields.description).toBe("Pinger no longer pings.");
    expect(parsed.fields.repro_steps).toContain("gh pr merge");
    expect(parsed.fields.expected).toBe("Merge succeeds.");
    expect(parsed.fields.actual).toBe("Merge fails.");
    expect(parsed.fields.acceptance_criteria).toBe("Merge works again.");
    expect(parsed.unparsed).toBe("");
  });

  test("non-canonical H2 sections accumulate in unparsed (no silent drop)", () => {
    const body = [
      "## Description",
      "",
      "Real description.",
      "",
      "## Problem",
      "",
      "Random extra section that the schema does not declare.",
    ].join("\n");
    const parsed = parseStructuredBody(body, "bug");
    expect(parsed.fields.description).toBe("Real description.");
    expect(parsed.unparsed).toContain("## Problem");
    expect(parsed.unparsed).toContain("Random extra section");
  });

  test("pre-H2 prose goes to unparsed, not silently dropped", () => {
    const body = [
      "_Surfaced from GH-1234_",
      "",
      "## Description",
      "",
      "real description",
    ].join("\n");
    const parsed = parseStructuredBody(body, "task");
    expect(parsed.fields.description).toBe("real description");
    expect(parsed.unparsed).toContain("_Surfaced from GH-1234_");
  });

  test("heading match is case-insensitive and tolerant of trailing punctuation", () => {
    const body = [
      "## description",
      "",
      "lowercase heading",
      "",
      "## Acceptance Criteria:",
      "",
      "trailing colon heading",
    ].join("\n");
    const parsed = parseStructuredBody(body, "task");
    expect(parsed.fields.description).toBe("lowercase heading");
    expect(parsed.fields.acceptance_criteria).toBe("trailing colon heading");
  });

  test("empty body returns empty fields and unparsed", () => {
    const parsed = parseStructuredBody("", "bug");
    expect(parsed.fields).toEqual({});
    expect(parsed.unparsed).toBe("");
  });
});
