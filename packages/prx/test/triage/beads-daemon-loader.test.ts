import { describe, expect, test } from "bun:test";

import { loadAllBeadsViaCli } from "../../src/triage/beads-daemon-loader.ts";

type Run = (cmd: string[], opts?: { check?: boolean }) => { status: number; stdout: string; stderr: string };

const ok = (stdout: string): Run => (() => ({ status: 0, stdout, stderr: "" })) as Run;

// Raw `bd --json` (snake_case) — what `prx beads list --all` prints.
const rawArray = JSON.stringify([
  { id: "prx-1", title: "one", status: "open", priority: 2, issue_type: "task" },
  { id: "prx-2", title: "two", status: "closed", priority: 1, issue_type: "bug" },
]);

describe("loadAllBeadsViaCli (GH-296 / prx-fda)", () => {
  test("spawns `prx beads list --all --limit 0` and parses the raw snake_case array", () => {
    const calls: string[][] = [];
    const recs = loadAllBeadsViaCli({
      run: ((cmd: string[]) => {
        calls.push(cmd);
        return { status: 0, stdout: rawArray, stderr: "" };
      }) as never,
    });
    expect(calls[0]).toEqual(["prx", "beads", "list", "--all", "--limit", "0"]);
    expect(recs.map((r) => r.id)).toEqual(["prx-1", "prx-2"]);
    // snake_case → camelCase transform applied (not cast blindly).
    expect(recs[0]!.issueType).toBe("task");
    expect(recs[1]!.status).toBe("closed");
  });

  test("honors a prxBinary override (compiled-binary / non-PATH invocation)", () => {
    const calls: string[][] = [];
    loadAllBeadsViaCli({
      prxBinary: "/opt/prx/bin/prx",
      run: ((cmd: string[]) => (calls.push(cmd), { status: 0, stdout: "[]", stderr: "" })) as never,
    });
    expect(calls[0]![0]).toBe("/opt/prx/bin/prx");
  });

  test("empty array result is honored (zero beads, not an error)", () => {
    expect(loadAllBeadsViaCli({ run: ok("[]") })).toEqual([]);
  });

  test("non-zero exit WITH a valid non-empty array ⇒ used (tolerated) + warns", () => {
    const warnings: string[] = [];
    const recs = loadAllBeadsViaCli({
      run: (() => ({ status: 1, stdout: rawArray, stderr: "dolt auto-sync diverged" })) as never,
      warn: (l) => warnings.push(l),
    });
    expect(recs).toHaveLength(2);
    expect(warnings.some((w) => w.includes("exited non-zero"))).toBe(true);
  });

  test("non-zero exit with empty stdout ⇒ throws (never silently reports zero beads)", () => {
    expect(() =>
      loadAllBeadsViaCli({
        run: (() => ({ status: 1, stdout: "", stderr: "daemon unreachable" })) as never,
      }),
    ).toThrow(/beads daemon read: daemon unreachable/);
  });

  test("exit 0 but invalid JSON ⇒ throws", () => {
    expect(() => loadAllBeadsViaCli({ run: ok("{not json") })).toThrow(/invalid JSON/);
  });

  test("exit 0 but a non-array body ⇒ throws", () => {
    expect(() => loadAllBeadsViaCli({ run: ok('{"id":"prx-1"}') })).toThrow(/return an array/);
  });
});
