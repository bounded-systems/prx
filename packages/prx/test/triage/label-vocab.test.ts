import { describe, expect, test } from "bun:test";

import {
  AREA_LABELS,
  EFFORT_LABELS,
  PRIORITY_LABELS,
  TYPE_LABELS,
  areaLabelSchema,
  effortLabelSchema,
  labelPlanSchema,
  priorityLabelSchema,
  proposedLabelsFor,
  typeLabelSchema,
  typeLabelString,
  validateLabelPlan,
  type LabelPlanRow,
} from "../../src/triage/label-vocab.ts";

describe("axis enums", () => {
  test("type enum holds the canonical labels — bd round-trippable + GH-only `spike` (GH-1489), `decision` (GH-1955)", () => {
    expect(TYPE_LABELS).toEqual([
      "bug",
      "feature",
      "task",
      "chore",
      "epic",
      "spike",
      "decision",
    ]);
  });

  test("priority enum holds critical/high/medium/low/none (GH-918 + GH-970)", () => {
    expect(PRIORITY_LABELS).toEqual(["critical", "high", "medium", "low", "none"]);
  });

  test("area enum holds the 9 canonical areas (matches GH-918 schema)", () => {
    expect(AREA_LABELS).toEqual([
      "prx",
      "beads",
      "notion",
      "tmux",
      "ci",
      "home-manager",
      "tui",
      "warp",
      "claude-code",
    ]);
  });

  test("effort enum holds xs/s/m/l/xl (matches GH-918 schema)", () => {
    expect(EFFORT_LABELS).toEqual(["xs", "s", "m", "l", "xl"]);
  });

  test("typeLabelString prefixes type::", () => {
    expect(typeLabelString("feature")).toBe("type::feature");
  });

  test("invalid type rejected by schema", () => {
    expect(() => typeLabelSchema.parse("nope")).toThrow();
  });

  test("invalid priority rejected by schema", () => {
    expect(() => priorityLabelSchema.parse("urgent")).toThrow();
  });

  test("GH-970: priority::none accepted by schema (explicit unscored marker)", () => {
    expect(() => priorityLabelSchema.parse("none")).not.toThrow();
  });

  test("invalid area rejected by schema", () => {
    expect(() => areaLabelSchema.parse("nope")).toThrow();
  });

  test("invalid effort rejected by schema", () => {
    expect(() => effortLabelSchema.parse("xxl")).toThrow();
  });
});

function row(overrides: Partial<LabelPlanRow> = {}): LabelPlanRow {
  return {
    number: 1,
    title: "t",
    url: "https://github.com/o/r/issues/1",
    currentLabels: [],
    type: "task",
    priority: "medium",
    ...overrides,
  };
}

describe("proposedLabelsFor", () => {
  test("adds type and priority on a clean issue", () => {
    expect(proposedLabelsFor(row())).toEqual(["type::task", "priority::medium"]);
  });

  test("GH-957: preserves operator-set type/priority/area when classifier disagrees", () => {
    const r = row({
      currentLabels: ["needs-triage", "type::bug", "priority::low", "area::tui"],
      type: "feature",
      priority: "high",
    });
    // All three axes are operator-set → classifier emissions suppressed; row passes through unchanged.
    expect(proposedLabelsFor(r)).toEqual([
      "needs-triage",
      "type::bug",
      "priority::low",
      "area::tui",
    ]);
  });

  test("emits area::* and effort::* when classifier supplies them", () => {
    const r = row({
      type: "feature",
      priority: "medium",
      area: "prx",
      effort: "m",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "type::feature",
      "priority::medium",
      "area::prx",
      "effort::m",
    ]);
  });

  test("GH-957: preserves operator-set area::* even when classifier emits at that axis", () => {
    const r = row({
      currentLabels: ["needs-triage", "area::tui"],
      type: "feature",
      priority: "medium",
      area: "prx",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "needs-triage",
      "area::tui",
      "type::feature",
      "priority::medium",
    ]);
  });

  test("preserves operator-curated area::* when classifier is silent", () => {
    const r = row({
      currentLabels: ["needs-triage", "area::tui"],
      type: "feature",
      priority: "medium",
      // area undefined — heuristic didn't fire
    });
    expect(proposedLabelsFor(r)).toEqual([
      "needs-triage",
      "area::tui",
      "type::feature",
      "priority::medium",
    ]);
  });

  test("GH-957: preserves operator-set effort::* even when classifier emits at that axis", () => {
    const r = row({
      currentLabels: ["effort::xl"],
      type: "feature",
      priority: "medium",
      effort: "m",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "effort::xl",
      "type::feature",
      "priority::medium",
    ]);
  });

  test("preserves operator-curated effort::* when classifier is silent", () => {
    const r = row({
      currentLabels: ["effort::xl"],
      type: "feature",
      priority: "medium",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "effort::xl",
      "type::feature",
      "priority::medium",
    ]);
  });

  test("idempotent: re-applying same labels yields same set", () => {
    const r = row({
      currentLabels: ["type::feature", "priority::medium", "area::prx", "effort::m"],
      type: "feature",
      priority: "medium",
      area: "prx",
      effort: "m",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "type::feature",
      "priority::medium",
      "area::prx",
      "effort::m",
    ]);
  });

  test("GH-970: classifier emits priority::none on a clean issue → adds the unscored marker", () => {
    const r = row({
      currentLabels: [],
      type: "feature",
      priority: "none",
      priorityConfidence: "unscored",
    });
    expect(proposedLabelsFor(r)).toEqual(["type::feature", "priority::none"]);
  });

  test("GH-970: defaulted priority::none does NOT strip operator-set priority::high", () => {
    const r = row({
      currentLabels: ["priority::high"],
      type: "feature",
      priority: "none",
      priorityConfidence: "unscored",
    });
    // Operator-set priority is authoritative; classifier none is suppressed.
    expect(proposedLabelsFor(r)).toEqual(["priority::high", "type::feature"]);
  });

  test("GH-970: idempotent re-application of priority::none on already-marked issue", () => {
    const r = row({
      currentLabels: ["priority::none"],
      type: "feature",
      priority: "none",
      priorityConfidence: "unscored",
    });
    // GH-1487 — `priority::none` is the unscored sentinel and does not count
    // as operator-set, so the classifier's `priority::none` emission strips
    // and re-adds it (set is unchanged, ordering becomes
    // stripped-then-re-added). Net effect for `diffRow` is still skip
    // because the resulting set matches `currentLabels`.
    expect(proposedLabelsFor(r)).toEqual(["type::feature", "priority::none"]);
  });

  test("GH-1487: priority::none does not count as operator-set — classifier upgrade replaces it", () => {
    const r = row({
      currentLabels: ["priority::none"],
      type: "feature",
      priority: "high",
    });
    expect(proposedLabelsFor(r)).toEqual(["type::feature", "priority::high"]);
  });

  // ── GH-988: type::task sentinel + spike dual-emission ────────────────────

  test("GH-988: type::task is the unscored sentinel — scored upgrade replaces it", () => {
    const r = row({
      currentLabels: ["type::task"],
      type: "feature",
      typeConfidence: "scored",
      priority: "medium",
    });
    expect(proposedLabelsFor(r)).toEqual(["type::feature", "priority::medium"]);
  });

  test("GH-988: re-applying type::task on already-marked issue is idempotent", () => {
    const r = row({
      currentLabels: ["type::task"],
      type: "task",
      typeConfidence: "unscored",
      priority: "medium",
    });
    expect(proposedLabelsFor(r)).toEqual(["type::task", "priority::medium"]);
  });

  test("GH-988 + GH-1489: spike dual-emission projects type::task and type::spike", () => {
    const r = row({
      currentLabels: [],
      type: "task",
      typeConfidence: "scored",
      spike: true,
      priority: "medium",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "type::task",
      "type::spike",
      "priority::medium",
    ]);
  });

  test("GH-988: type::spike is preserved across strip when classifier emits a different scored type", () => {
    // Legacy state: GH-only spike marker is present but no BD_TYPE_ENUM
    // type. A scored emission of type::feature should strip the absent
    // sentinel and preserve the GH-only marker.
    const r = row({
      currentLabels: ["type::spike"],
      type: "feature",
      typeConfidence: "scored",
      priority: "medium",
    });
    expect(proposedLabelsFor(r)).toEqual([
      "type::spike",
      "type::feature",
      "priority::medium",
    ]);
  });

  test("GH-988 + GH-1489: idempotent re-application on dual-labeled issue (set membership stable)", () => {
    const r = row({
      currentLabels: ["type::task", "type::spike"],
      type: "task",
      typeConfidence: "scored",
      spike: true,
      priority: "medium",
    });
    // The unscored sentinel `type::task` is stripped (then re-added by the
    // classifier emission); the GH-only `type::spike` marker is preserved
    // through the strip. Set membership matches currentLabels + priority::medium;
    // ordering is insertion-order: surviving marker first, then re-added task,
    // then priority.
    expect(new Set(proposedLabelsFor(r))).toEqual(new Set([
      "type::task",
      "type::spike",
      "priority::medium",
    ]));
  });
});

describe("validateLabelPlan", () => {
  test("accepts a well-formed plan", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "feat: x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "feature",
          priority: "medium",
        },
      ],
    };
    const validated = validateLabelPlan(plan);
    expect(validated.rows[0]!.type).toBe("feature");
  });

  test("rejects unknown type label", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "garbage",
          priority: "medium",
        },
      ],
    };
    expect(() => labelPlanSchema.parse(plan)).toThrow();
  });

  test("accepts schema-typed optional area/effort", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "task",
          priority: "low",
          area: "tui",
          effort: "s",
        },
      ],
    };
    const validated = validateLabelPlan(plan);
    expect(validated.rows[0]!.area).toBe("tui");
    expect(validated.rows[0]!.effort).toBe("s");
  });

  test("rejects out-of-vocab area value (schema is now strict)", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "task",
          priority: "low",
          area: "not-a-real-area",
        },
      ],
    };
    expect(() => labelPlanSchema.parse(plan)).toThrow();
  });

  test("rejects out-of-vocab effort value", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "task",
          priority: "low",
          effort: "huge",
        },
      ],
    };
    expect(() => labelPlanSchema.parse(plan)).toThrow();
  });

  test("accepts priority::critical (now in schema)", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "bug",
          priority: "critical",
        },
      ],
    };
    const validated = validateLabelPlan(plan);
    expect(validated.rows[0]!.priority).toBe("critical");
  });

  test("GH-970: accepts priorityConfidence values 'unscored' | 'scored' | 'operator'", () => {
    for (const confidence of ["unscored", "scored", "operator"] as const) {
      const plan = {
        repo: "bdelanghe/ai-home",
        generatedAt: "2026-04-28T20:00:00Z",
        rows: [
          {
            number: 1,
            title: "x",
            url: "https://github.com/bdelanghe/ai-home/issues/1",
            currentLabels: [],
            priority: "none",
            priorityConfidence: confidence,
          },
        ],
      };
      const validated = validateLabelPlan(plan);
      expect(validated.rows[0]!.priorityConfidence).toBe(confidence);
    }
  });

  test("GH-970: rejects unknown priorityConfidence values", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          priority: "none",
          priorityConfidence: "guessed",
        },
      ],
    };
    expect(() => labelPlanSchema.parse(plan)).toThrow();
  });

  test("GH-970: priorityConfidence is optional (back-compat for old plans)", () => {
    const plan = {
      repo: "bdelanghe/ai-home",
      generatedAt: "2026-04-28T20:00:00Z",
      rows: [
        {
          number: 1,
          title: "x",
          url: "https://github.com/bdelanghe/ai-home/issues/1",
          currentLabels: [],
          type: "feature",
          priority: "high",
        },
      ],
    };
    const validated = validateLabelPlan(plan);
    expect(validated.rows[0]!.priorityConfidence).toBeUndefined();
  });
});
