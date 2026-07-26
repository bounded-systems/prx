import { describe, expect, test } from "bun:test";

import { loadAllBeadsViaCli } from "../../src/triage/beads-daemon-loader.ts";
import type { CommandRunner } from "@bounded-systems/proc";

// GH-1012: loadAllBeadsViaCli reads Front Desk directly (`fds list`), not the
// beadsd daemon. The runner answers `git remote get-url origin` + `fds list`.
const FD = JSON.stringify({
  source: "server",
  syncedAt: "2026-07-26T00:00:00Z",
  items: [
    {
      number: 1,
      repository: "prx",
      kind: "task",
      title: "one",
      status: "Todo",
      effort: 1,
      value: 1,
      dependsOn: [],
      ageDays: 0,
    },
    {
      number: 2,
      repository: "prx",
      kind: "bug",
      title: "two",
      status: "Done",
      effort: 1,
      value: 1,
      dependsOn: [],
      ageDays: 0,
    },
  ],
  edges: [],
});

function fdsRunner(opts: { listJson?: string; fdsStatus?: number } = {}): CommandRunner {
  return ((cmd) => {
    if (cmd[0] === "git") {
      return { status: 0, stdout: "https://github.com/bounded-systems/prx.git\n", stderr: "" };
    }
    return { status: opts.fdsStatus ?? 0, stdout: opts.listJson ?? FD, stderr: "boom" };
  }) as CommandRunner;
}

describe("loadAllBeadsViaCli — Front Desk (GH-1012)", () => {
  test("reads Front Desk (fds list) into GH-canonical BeadsRecords", () => {
    const recs = loadAllBeadsViaCli({ run: fdsRunner() });
    expect(recs.map((r) => r.id)).toEqual(["GH-1", "GH-2"]);
    expect(recs[0]!.issueType).toBe("task");
    expect(recs[1]!.status).toBe("closed"); // Front Desk "Done" → bd "closed"
    expect(recs[0]!.externalIssueNumber).toBe(1);
    expect(recs[0]!.externalRefs.gh).toContain("/prx/issues/1");
  });

  test("empty item set → zero records (not an error)", () => {
    const empty = JSON.stringify({ source: "server", syncedAt: null, items: [], edges: [] });
    expect(loadAllBeadsViaCli({ run: fdsRunner({ listJson: empty }) })).toEqual([]);
  });

  test("an fds failure throws", () => {
    expect(() => loadAllBeadsViaCli({ run: fdsRunner({ fdsStatus: 2 }) })).toThrow(
      /fds list failed/,
    );
  });
});
