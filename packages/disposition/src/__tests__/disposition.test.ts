import { describe, expect, test } from "bun:test";

import { classify } from "../index.ts";
import type { ClassifyInput } from "../index.ts";

function makeInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  const base: ClassifyInput = {
    status: {
      remote: { problem: "no", pr: "dirty", branch: "dirty" },
      local: { problem: "no", branch: "dirty", dir: "present" },
    },
    local: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    artifacts: { worktree: true, branch: true, pr: true },
    issueFeatureEnabled: true,
    issueStatus: "dirty",
  };
  return {
    ...base,
    ...overrides,
    status: { ...base.status, ...(overrides.status ?? {}) },
    local: { ...base.local, ...(overrides.local ?? {}) },
    artifacts: { ...base.artifacts, ...(overrides.artifacts ?? {}) },
  };
}

describe("classify", () => {
  test("all four surfaces clean → ok", () => {
    expect(classify(makeInput())).toBe("ok");
  });

  test("merged PR + completed issue + clean local → prune", () => {
    const input = makeInput({
      status: {
        remote: { problem: "no", pr: "completed", branch: "clean" },
        local: { problem: "no", branch: "clean", dir: "no worktree" },
      },
      artifacts: { worktree: false, branch: false, pr: false },
      issueStatus: "completed",
    });
    expect(classify(input)).toBe("prune");
  });

  // GH-1126: pin the classifier shape for the textbook post-merge case —
  // local.problem="no" + dir=present + completed gates → "prune".
  // (The action emitter does NOT depend on this; it gates on raw state so
  // it still fires when the classifier downgrades to "review" because
  // `local.problem` flagged branch divergence from main, which is expected
  // after a merge.)
  test("merged PR + completed issue + clean local + worktree present → prune (GH-1126)", () => {
    const input = makeInput({
      status: {
        remote: { problem: "no", pr: "completed", branch: "clean" },
        local: { problem: "no", branch: "clean", dir: "present" },
      },
      artifacts: { worktree: true, branch: true, pr: false },
      local: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
      issueStatus: "completed",
    });
    expect(classify(input)).toBe("prune");
  });

  test("authority active, missing remote branch, dirty local → review (operator state at risk)", () => {
    const input = makeInput({
      status: {
        remote: { problem: "no", pr: "clean", branch: "missing" },
        local: { problem: "no", branch: "clean", dir: "present" },
      },
      artifacts: { worktree: true, branch: true, pr: false },
      local: { staged: 0, unstaged: 1, untracked: 0, conflicts: 0 },
    });
    expect(classify(input)).toBe("review");
  });

  test("authority active, missing remote branch, clean local → repair", () => {
    const input = makeInput({
      status: {
        remote: { problem: "no", pr: "clean", branch: "missing" },
        local: { problem: "no", branch: "clean", dir: "present" },
      },
      artifacts: { worktree: true, branch: true, pr: false },
      local: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    });
    expect(classify(input)).toBe("repair");
  });

  test("structural problem flagged → review", () => {
    const input = makeInput({
      status: {
        remote: { problem: "no", pr: "clean", branch: "clean" },
        local: { problem: "yes", branch: "clean", dir: "present" },
      },
    });
    expect(classify(input)).toBe("review");
  });

  test("closed issue with untracked files → review (not prune)", () => {
    const input = makeInput({
      status: {
        remote: { problem: "no", pr: "completed", branch: "clean" },
        local: { problem: "no", branch: "clean", dir: "present" },
      },
      local: { staged: 0, unstaged: 0, untracked: 2, conflicts: 0 },
      issueStatus: "completed",
    });
    expect(classify(input)).toBe("review");
  });
});
