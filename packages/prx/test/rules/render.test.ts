// GH-1423 PR-1: renderer skeleton emits markdown with substrate-driven
// sections.

import { describe, expect, test } from "bun:test";

import { loadVerbSupply } from "../../src/rules/loaders/verb-supply.ts";
import { renderCoreMd } from "../../src/rules/render/core-md.ts";

function inputsForTest() {
  return {
    verbSupply: loadVerbSupply(),
    aliasSupply: [],
    worktreeGestures: [],
    memoryIndex: [],
  };
}

describe("renderCoreMd", () => {
  test("emits a generated-from-substrate header", () => {
    const md = renderCoreMd(inputsForTest());
    expect(md).toContain("Core Project Rules (generated)");
    expect(md).toContain("`prx rules render`");
  });

  test("projects every actor's verbs from the supply", () => {
    const md = renderCoreMd(inputsForTest());
    // Spot-check a handful of canonical actors.
    expect(md).toContain("actor: `plan`");
    expect(md).toContain("actor: `rules`");
    expect(md).toContain("`prx rules render`");
  });

  test("includes the alias-exists drift canary fence", () => {
    const md = renderCoreMd(inputsForTest());
    expect(md).toContain("<!-- assert:alias -->");
    expect(md).toContain("<!-- /assert:alias -->");
    expect(md).toContain("`za`");
    expect(md).toContain("`zb`");
    expect(md).toContain("`zc`");
  });

  test("includes a stub banner when alias/worktree/memory supplies are empty", () => {
    const md = renderCoreMd(inputsForTest());
    expect(md).toContain("Stubbed inputs");
    expect(md).toContain("alias-supply");
    expect(md).toContain("worktree-gestures");
    expect(md).toContain("memory-index");
  });

  test("wraps illustrative agent-pattern prose in an assert:none fence", () => {
    const md = renderCoreMd(inputsForTest());
    expect(md).toContain("<!-- assert:none -->");
    expect(md).toContain("<!-- /assert:none -->");
  });
});
