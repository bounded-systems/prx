// prx-8mx — the forcing functions ARE the test. A value prop marked backed must
// have passing checks; the committed doc must match what the checks deliver now.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/repo-root.ts";
import {
  VALUE_PROPS,
  backingOf,
  codeToValueProps,
  exercisedBy,
  generateStatusDoc,
  generateValuePropsDoc,
  isValuePropBacked,
} from "../src/value_props.ts";

    for (const vp of VALUE_PROPS) {
      for (const f of vp.forcing) {
        if ("check" in f) {
          expect(f.check(), `forcing function "${f.name}" is marked live but evaluates false`).toBe(true);
        }
      }
    }
  });

  test("the committed docs/value-props.md matches the generator (no drift)", () => {
    const path = join(REPO_ROOT, "docs", "value-props.md");
    expect(existsSync(path)).toBe(true);
    const path = join(REPO_ROOT, "docs", "value-props.md");
      readFileSync(path, "utf8"),
      "docs/value-props.md is stale — run `bun packages/prx/scripts/gen-value-props.ts` and commit",
    ).toBe(generateValuePropsDoc());
  });

  test("the committed STATUS.md matches the generator (the bubble-up top, no drift)", () => {
    const path = join(REPO_ROOT, "STATUS.md");
    expect(existsSync(path)).toBe(true);
    const path = join(REPO_ROOT, "STATUS.md");
      readFileSync(path, "utf8"),
      "STATUS.md is stale — run `bun packages/prx/scripts/gen-value-props.ts` and commit",
    ).toBe(generateStatusDoc());
  });

  test("STATUS.md reports the live backed count and lists every learning goal", () => {
    const doc = generateStatusDoc();
    const backed = VALUE_PROPS.filter(isValuePropBacked).length;
    expect(doc).toContain(`**${backed} of ${VALUE_PROPS.length} value props backed**`);
    for (const vp of VALUE_PROPS) {
      if (!isValuePropBacked(vp)) expect(doc).toContain(`⚠️ ${vp.claim}`);
    }
  });

  test("a value prop is backed iff none of its forcing functions are learning goals", () => {
    for (const vp of VALUE_PROPS) {
      const hasLearningGoal = vp.forcing.some((f) => backingOf(f) === "learning-goal");
      expect(isValuePropBacked(vp)).toBe(!hasLearningGoal);
    }
  });

  test("backed / evidence forcing functions declare the code they exercise; learning goals don't", () => {
    for (const vp of VALUE_PROPS) {
      for (const f of vp.forcing) {
        if (backingOf(f) === "learning-goal") {
          expect(exercisedBy(f)).toHaveLength(0);
        } else {
          expect(exercisedBy(f).length, `"${f.name}" is backed but traces to no code`).toBeGreaterThan(0);
        }
      }
    }
  });

  test("the code → value-prop reverse index is populated (the pruning lens)", () => {
    const reverse = codeToValueProps();
    expect(reverse.size).toBeGreaterThan(0);
    // Each backed value prop contributes at least one exercised symbol.
    const claimsWithCode = new Set([...reverse.values()].flat());
    for (const vp of VALUE_PROPS) {
      if (isValuePropBacked(vp)) expect(claimsWithCode.has(vp.claim)).toBe(true);
    }
  });

  test("the capability-containment value prop is currently backed", () => {
    const vp = VALUE_PROPS.find((v) => v.claim.includes("cannot perform an action"));
    expect(vp).toBeDefined();
    expect(isValuePropBacked(vp!)).toBe(true);
    expect(vp).toBeDefined();
    expect(isValuePropBacked(vp!)).toBe(true);

  test("cost visibility is honestly a learning goal (not yet backed)", () => {
    const vp = VALUE_PROPS.find((v) => v.claim.includes("what each work unit cost"));
    expect(vp).toBeDefined();
    expect(vp).toBeDefined();
    expect(isValuePropBacked(vp!)).toBe(false);
  });
});
