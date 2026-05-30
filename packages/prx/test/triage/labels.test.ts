import { describe, expect, test } from "bun:test";

import {
  AREA,
  BD_TYPE_ENUM,
  EFFORT,
  hasEpicLabel,
  labelSchema,
  LABEL_AXES,
  PRIORITY,
  TYPE,
  defaultLabelDefinitions,
  labelName,
  parseLabelName,
  resolveBdTypeFromLabels,
  schemaLabelNames,
} from "../../src/triage/labels.ts";

describe("parseLabelName", () => {
  test("parses a known type label", () => {
    const parsed = parseLabelName("type::feature");
    expect(parsed).toEqual({ known: true, axis: "type", value: "feature", raw: "type::feature" });
  });

  test("parses every known priority value", () => {
    for (const value of PRIORITY.options) {
      const parsed = parseLabelName(`priority::${value}`);
      expect(parsed).toEqual({ known: true, axis: "priority", value, raw: `priority::${value}` });
    }
  });

  test("GH-970: priority::none parses as a known unscored marker", () => {
    const parsed = parseLabelName("priority::none");
    expect(parsed).toEqual({
      known: true,
      axis: "priority",
      value: "none",
      raw: "priority::none",
    });
  });

  test("flags an unknown value within a known axis", () => {
    const parsed = parseLabelName("type::saga");
    expect(parsed).toEqual({ known: false, raw: "type::saga" });
  });

  test("flags a label with an unknown axis", () => {
    const parsed = parseLabelName("agent::architect");
    expect(parsed).toEqual({ known: false, raw: "agent::architect" });
  });

  test("flags labels without the :: separator", () => {
    expect(parseLabelName("bug")).toEqual({ known: false, raw: "bug" });
    expect(parseLabelName("documentation")).toEqual({ known: false, raw: "documentation" });
  });

  test("flags empty / malformed labels", () => {
    expect(parseLabelName("")).toEqual({ known: false, raw: "" });
    expect(parseLabelName("::feature")).toEqual({ known: false, raw: "::feature" });
  });

  test("round-trips with labelName for every axis", () => {
    for (const axis of LABEL_AXES) {
      const enumOpts =
        axis === "type" ? TYPE.options
        : axis === "priority" ? PRIORITY.options
        : axis === "area" ? AREA.options
        : EFFORT.options;
      for (const value of enumOpts) {
        const name = labelName(axis, value);
        const parsed = parseLabelName(name);
        expect(parsed).toEqual({ known: true, axis, value, raw: name });
      }
    }
  });
});

describe("Label schema", () => {
  test("requires type and priority; area and effort are optional", () => {
    expect(() => labelSchema.parse({ type: "feature", priority: "high" })).not.toThrow();
    expect(() => labelSchema.parse({ type: "feature", priority: "high", area: "prx" })).not.toThrow();
    expect(() => labelSchema.parse({ type: "feature" })).toThrow();
    expect(() => labelSchema.parse({ priority: "high" })).toThrow();
  });

  test("rejects unknown enum values on each axis", () => {
    expect(() => labelSchema.parse({ type: "saga", priority: "high" })).toThrow();
    expect(() => labelSchema.parse({ type: "feature", priority: "high", area: "missing" })).toThrow();
    expect(() => labelSchema.parse({ type: "feature", priority: "high", effort: "xxl" })).toThrow();
  });

  test("GH-970: accepts priority::none as the explicit unscored marker", () => {
    expect(() => labelSchema.parse({ type: "feature", priority: "none" })).not.toThrow();
  });
});

describe("BD_TYPE_ENUM alignment", () => {
  test("BD_TYPE_ENUM ⊂ TYPE.options — every bd-round-trippable type is in the projected GH vocab", () => {
    const typeSet = new Set<string>(TYPE.options);
    for (const bdType of BD_TYPE_ENUM) {
      expect(typeSet.has(bdType)).toBe(true);
    }
  });

  test("GH-only divergence: TYPE \\ BD_TYPE_ENUM = {spike, decision} (GH-1489, GH-1955)", () => {
    const bdSet = new Set<string>(BD_TYPE_ENUM);
    const ghOnly = TYPE.options.filter((t) => !bdSet.has(t));
    expect(ghOnly).toEqual(["spike", "decision"]);
  });
});

describe("resolveBdTypeFromLabels (GH-1532)", () => {
  test("returns null when no type:: label is present", () => {
    expect(resolveBdTypeFromLabels([])).toBeNull();
    expect(resolveBdTypeFromLabels(["priority::high", "area::prx"])).toBeNull();
  });

  test("returns the bd-axis value verbatim for a single in-vocab type", () => {
    expect(resolveBdTypeFromLabels(["type::bug"])).toBe("bug");
    expect(resolveBdTypeFromLabels(["type::task"])).toBe("task");
    expect(resolveBdTypeFromLabels(["type::feature", "priority::low"])).toBe("feature");
  });

  test("GH-1489: a lone type::spike marker resolves to task (how bd round-trips it)", () => {
    expect(resolveBdTypeFromLabels(["type::spike"])).toBe("task");
    expect(resolveBdTypeFromLabels(["priority::medium", "type::spike"])).toBe("task");
  });

  test("GH-1489: a co-occurring BD_TYPE_ENUM type:: label wins regardless of label order", () => {
    expect(resolveBdTypeFromLabels(["type::spike", "type::feature"])).toBe("feature");
    expect(resolveBdTypeFromLabels(["type::feature", "type::spike"])).toBe("feature");
    expect(resolveBdTypeFromLabels(["type::spike", "type::task"])).toBe("task");
    expect(resolveBdTypeFromLabels(["type::task", "type::spike"])).toBe("task");
  });

  test("GH-1955: a lone type::decision marker resolves to task (how bd round-trips it)", () => {
    expect(resolveBdTypeFromLabels(["type::decision"])).toBe("task");
    expect(resolveBdTypeFromLabels(["priority::medium", "type::decision"])).toBe("task");
  });

  test("GH-1955: a co-occurring BD_TYPE_ENUM type:: label wins regardless of label order", () => {
    expect(resolveBdTypeFromLabels(["type::decision", "type::feature"])).toBe("feature");
    expect(resolveBdTypeFromLabels(["type::feature", "type::decision"])).toBe("feature");
    expect(resolveBdTypeFromLabels(["type::decision", "type::task"])).toBe("task");
    expect(resolveBdTypeFromLabels(["type::task", "type::decision"])).toBe("task");
  });

  test("passes a truly out-of-vocab type through verbatim (legacy passthrough)", () => {
    // `type::story` is in beads's `IssueType` enum but not in prx's `TYPE`,
    // so it's neither a BD_TYPE_ENUM member nor a recognized GH-only marker.
    expect(resolveBdTypeFromLabels(["type::story"])).toBe("story");
    // first type:: label wins for the legacy fallback, matching firstLabelValue
    expect(resolveBdTypeFromLabels(["type::story", "type::milestone"])).toBe("story");
  });

  test("ignores empty / malformed type:: labels", () => {
    expect(resolveBdTypeFromLabels(["type::"])).toBeNull();
  });
});

describe("hasEpicLabel (GH-935)", () => {
  test("matches a labels list containing type::epic", () => {
    expect(hasEpicLabel([{ name: "type::epic" }])).toBe(true);
  });

  test("matches when type::epic is present alongside other axes", () => {
    expect(
      hasEpicLabel([{ name: "priority::high" }, { name: "type::epic" }, { name: "area::prx" }]),
    ).toBe(true);
  });

  test("does not match other type axes", () => {
    expect(hasEpicLabel([{ name: "type::feature" }])).toBe(false);
    expect(hasEpicLabel([{ name: "type::task" }])).toBe(false);
  });

  test("does not match a stripped (unprefixed) `epic` label", () => {
    expect(hasEpicLabel([{ name: "epic" }])).toBe(false);
  });

  test("returns false on an empty / missing labels array", () => {
    expect(hasEpicLabel([])).toBe(false);
    expect(hasEpicLabel(null)).toBe(false);
    expect(hasEpicLabel(undefined)).toBe(false);
  });
});

describe("defaultLabelDefinitions", () => {
  test("emits one definition per axis value with non-empty color and description", () => {
    const defs = defaultLabelDefinitions();
    const expected = TYPE.options.length + PRIORITY.options.length + AREA.options.length + EFFORT.options.length;
    expect(defs).toHaveLength(expected);
    for (const def of defs) {
      expect(def.name).toMatch(/^(type|priority|area|effort)::/);
      expect(def.color).toMatch(/^[0-9a-f]{6}$/i);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  test("every axis value is reachable from labelName(axis, value)", () => {
    const names = schemaLabelNames();
    for (const axis of LABEL_AXES) {
      const enumOpts =
        axis === "type" ? TYPE.options
        : axis === "priority" ? PRIORITY.options
        : axis === "area" ? AREA.options
        : EFFORT.options;
      for (const value of enumOpts) {
        expect(names.has(labelName(axis, value))).toBe(true);
      }
    }
  });

  test("GH-970: priority::none IS in the schema projection (in-vocab unscored marker)", () => {
    expect(schemaLabelNames().has("priority::none")).toBe(true);
  });
});
