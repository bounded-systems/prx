// Shape-stability test for the GH-1687 leaf split: the four intake constants
// that previously lived in `src/intake/intake.ts` now live in
// `src/intake/types.ts`. This test pins their runtime values so a future
// refactor cannot silently change what bd, GH labels, or the title regex see.

import { describe, expect, test } from "bun:test";

import {
  INTAKE_TYPES,
  INTAKE_INTENTS,
  INTENT_TO_SPEC,
  PREFIX_RE,
  PREFIX_TO_INTAKE_INTENT,
} from "../../src/intake/types.ts";

describe("src/intake/types.ts (GH-1687)", () => {
  test("INTAKE_TYPES is the bd-axis vocab", () => {
    expect(INTAKE_TYPES).toEqual(["bug", "task", "feature", "chore"]);
  });

  test("INTAKE_INTENTS adds spike + decision on top of INTAKE_TYPES", () => {
    expect(INTAKE_INTENTS).toEqual(["bug", "task", "feature", "chore", "spike", "decision"]);
  });

  test("INTENT_TO_SPEC maps spike/decision → bd-type task + GH-only marker", () => {
    expect(INTENT_TO_SPEC).toEqual({
      bug: { type: "bug", extraLabels: [], titlePrefix: "bug" },
      task: { type: "task", extraLabels: [], titlePrefix: "task" },
      feature: { type: "feature", extraLabels: [], titlePrefix: "feature" },
      chore: { type: "chore", extraLabels: [], titlePrefix: "chore" },
      spike: {
        type: "task",
        extraLabels: ["type::spike"],
        titlePrefix: "spike",
      },
      decision: {
        type: "task",
        extraLabels: ["type::decision"],
        titlePrefix: "decision",
      },
    });
  });

  test("PREFIX_RE matches the conv-commit vocab from GH-1122", () => {
    expect(PREFIX_RE.source).toBe(
      "^(feat|fix|bug|chore|docs|refactor|test|feature|task|spike|decision)(?:\\(([^)]+)\\))?:\\s+",
    );
    expect("feat(intake): add knob".match(PREFIX_RE)?.[1]).toBe("feat");
    expect("spike: probe schema".match(PREFIX_RE)?.[1]).toBe("spike");
    expect("decision: capture trade-off".match(PREFIX_RE)?.[1]).toBe("decision");
  });

  test("PREFIX_TO_INTAKE_INTENT collapses feat→feature, fix→bug, null for docs/refactor/test", () => {
    expect(PREFIX_TO_INTAKE_INTENT).toEqual({
      feat: "feature",
      fix: "bug",
      bug: "bug",
      task: "task",
      feature: "feature",
      chore: "chore",
      spike: "spike",
      decision: "decision",
      docs: null,
      refactor: null,
      test: null,
    });
  });
});
