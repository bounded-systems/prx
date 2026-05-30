import { describe, expect, test } from "bun:test";

import { findEpicChildren } from "../../src/beads/epic_children.ts";
import type { CommandRunner } from "../../src/pr-state/github.ts";

type Cmd = { cmd: string[]; cwd?: string | undefined };

function makeRunner(handlers: Array<(cmd: string[]) => { stdout: string; status?: number }>): {
  runner: CommandRunner;
  calls: Cmd[];
} {
  const calls: Cmd[] = [];
  const runner: CommandRunner = (cmd, options) => {
    calls.push({ cmd, cwd: options?.cwd });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    const result = handler(cmd);
    return { stdout: result.stdout, stderr: "", status: result.status ?? 0 };
  };
  return { runner, calls };
}

describe("findEpicChildren (GH-935)", () => {
  test("returns empty array when the GH number is not a beads issue", () => {
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify([]) }),
    ]);
    expect(findEpicChildren("/repo", 999, runner)).toEqual([]);
  });

  test("returns empty array when the matching issue has no parent-child edges", () => {
    const snapshot = [
      {
        id: "ai-home-epicX",
        title: "An epic",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/100",
      },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: "[]" }),
    ]);
    expect(findEpicChildren("/repo", 100, runner)).toEqual([]);
  });

  test("maps parent-child edges to GH numbers and respects child status", () => {
    const snapshot = [
      {
        id: "ai-home-epicX",
        title: "An epic",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/100",
      },
      {
        id: "ai-home-childA",
        title: "Child A — open",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/201",
      },
      {
        id: "ai-home-childB",
        title: "Child B — closed",
        status: "closed",
        external_ref: "https://github.com/owner/repo/issues/202",
      },
    ];
    const edges = [
      { from: "ai-home-childA", to: "ai-home-epicX", type: "parent-child" },
      { from: "ai-home-childB", to: "ai-home-epicX", type: "parent-child" },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edges) }),
    ]);

    expect(findEpicChildren("/repo", 100, runner)).toEqual([
      { ghNumber: 201, title: "Child A — open", state: "open" },
      { ghNumber: 202, title: "Child B — closed", state: "closed" },
    ]);
  });

  test("sorts children by ascending GH number", () => {
    const snapshot = [
      { id: "epic", title: "epic", status: "open", external_ref: "https://x/issues/10" },
      { id: "c1", title: "later", status: "open", external_ref: "https://x/issues/55" },
      { id: "c2", title: "earlier", status: "open", external_ref: "https://x/issues/12" },
    ];
    const edges = [
      { from: "c1", to: "epic", type: "parent-child" },
      { from: "c2", to: "epic", type: "parent-child" },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edges) }),
    ]);
    const children = findEpicChildren("/repo", 10, runner);
    expect(children.map((c) => c.ghNumber)).toEqual([12, 55]);
  });

  test("tolerates the alternative dep JSON shape (map keyed by issue id)", () => {
    const snapshot = [
      { id: "epic", title: "epic", status: "open", external_ref: "https://x/issues/10" },
      { id: "c1", title: "child", status: "open", external_ref: "https://x/issues/11" },
    ];
    const edgesAsMap = {
      epic: [{ source_id: "c1", target_id: "epic", dep_type: "parent-child" }],
    };
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edgesAsMap) }),
    ]);
    expect(findEpicChildren("/repo", 10, runner)).toEqual([
      { ghNumber: 11, title: "child", state: "open" },
    ]);
  });

  test("tolerates bd v1.x id-only edge shape (child object with dependency_type)", () => {
    const snapshot = [
      {
        id: "ai-home-epicX",
        title: "An epic",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/1375",
      },
      {
        id: "ai-home-child1",
        title: "Child 1377",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/1377",
      },
      {
        id: "ai-home-child2",
        title: "Child 1378",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/1378",
      },
      {
        id: "ai-home-child3",
        title: "Child 1379",
        status: "closed",
        external_ref: "https://github.com/owner/repo/issues/1379",
      },
      {
        id: "ai-home-child4",
        title: "Child 1380",
        status: "open",
        external_ref: "https://github.com/owner/repo/issues/1380",
      },
    ];
    // bd v1.x: each row is the child issue object with dependency_type added.
    // No `from`/`to`/`source_id` — only `id` identifies the child.
    const edges = [
      {
        id: "ai-home-child1",
        title: "Child 1377",
        external_ref: "https://github.com/owner/repo/issues/1377",
        dependency_type: "parent-child",
      },
      {
        id: "ai-home-child2",
        title: "Child 1378",
        external_ref: "https://github.com/owner/repo/issues/1378",
        dependency_type: "parent-child",
      },
      {
        id: "ai-home-child3",
        title: "Child 1379",
        external_ref: "https://github.com/owner/repo/issues/1379",
        dependency_type: "parent-child",
      },
      {
        id: "ai-home-child4",
        title: "Child 1380",
        external_ref: "https://github.com/owner/repo/issues/1380",
        dependency_type: "parent-child",
      },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edges) }),
    ]);
    expect(findEpicChildren("/repo", 1375, runner)).toEqual([
      { ghNumber: 1377, title: "Child 1377", state: "open" },
      { ghNumber: 1378, title: "Child 1378", state: "open" },
      { ghNumber: 1379, title: "Child 1379", state: "closed" },
      { ghNumber: 1380, title: "Child 1380", state: "open" },
    ]);
  });

  test("dedupes children that appear under multiple edge variants", () => {
    const snapshot = [
      { id: "epic", title: "epic", status: "open", external_ref: "https://x/issues/10" },
      { id: "c1", title: "child", status: "open", external_ref: "https://x/issues/11" },
    ];
    const edges = [
      { from: "c1", to: "epic", type: "parent-child" },
      // Hypothetical duplicate edge with different field naming.
      { source_id: "c1", target_id: "epic", dep_type: "parent-child" },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edges) }),
    ]);
    expect(findEpicChildren("/repo", 10, runner)).toEqual([
      { ghNumber: 11, title: "child", state: "open" },
    ]);
  });

  test("skips children whose external_ref is not a GH issue URL", () => {
    const snapshot = [
      { id: "epic", title: "epic", status: "open", external_ref: "https://x/issues/10" },
      { id: "c-with-gh", title: "with-gh", status: "open", external_ref: "https://x/issues/11" },
      { id: "c-no-ref", title: "no-ref", status: "open", external_ref: null },
    ];
    const edges = [
      { from: "c-with-gh", to: "epic", type: "parent-child" },
      { from: "c-no-ref", to: "epic", type: "parent-child" },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edges) }),
    ]);
    expect(findEpicChildren("/repo", 10, runner)).toEqual([
      { ghNumber: 11, title: "with-gh", state: "open" },
    ]);
  });

  test("normalizes child status case (Closed/CLOSED → closed)", () => {
    const snapshot = [
      { id: "epic", title: "epic", status: "open", external_ref: "https://x/issues/10" },
      { id: "c1", title: "mixed-case closed", status: "Closed", external_ref: "https://x/issues/11" },
      { id: "c2", title: "upper-case closed", status: "CLOSED", external_ref: "https://x/issues/12" },
      { id: "c3", title: "open with caps", status: "OPEN", external_ref: "https://x/issues/13" },
    ];
    const edges = [
      { from: "c1", to: "epic", type: "parent-child" },
      { from: "c2", to: "epic", type: "parent-child" },
      { from: "c3", to: "epic", type: "parent-child" },
    ];
    const { runner } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: JSON.stringify(edges) }),
    ]);
    expect(findEpicChildren("/repo", 10, runner)).toEqual([
      { ghNumber: 11, title: "mixed-case closed", state: "closed" },
      { ghNumber: 12, title: "upper-case closed", state: "closed" },
      { ghNumber: 13, title: "open with caps", state: "open" },
    ]);
  });

  test("invokes bd commands with the supplied repoPath as cwd", () => {
    const snapshot = [
      { id: "epic", title: "epic", status: "open", external_ref: "https://x/issues/10" },
    ];
    const { runner, calls } = makeRunner([
      () => ({ stdout: JSON.stringify(snapshot) }),
      () => ({ stdout: "[]" }),
    ]);
    findEpicChildren("/some/repo/path", 10, runner);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.cwd).toBe("/some/repo/path");
    expect(calls[0]!.cmd[0]).toBe("bd");
    expect(calls[0]!.cmd).toContain("--all");
    expect(calls[0]!.cmd).toContain("--json");
  });
});
