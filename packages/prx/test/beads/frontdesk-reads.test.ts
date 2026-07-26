import { describe, expect, test } from "bun:test";

import { loadAllBeadsViaDaemon, showBeadViaDaemon } from "../../src/beads/frontdesk-reads.ts";
import type { CommandRunner } from "@bounded-systems/proc";

// GH-1012: these readers now read Front Desk directly (`fds list`), not the
// beadsd daemon. The runner answers `git remote get-url origin` + `fds list`;
// records are GH-canonical (`id = GH-<n>`), parsed via parseBeadsRecords.
const FD = JSON.stringify({
  source: "server",
  syncedAt: "2026-07-26T00:00:00Z",
  items: [
    {
      number: 123,
      repository: "prx",
      kind: "task",
      title: "do a thing",
      status: "Todo",
      effort: 1,
      value: 1,
      dependsOn: [],
      ageDays: 0,
    },
  ],
  edges: [],
});

function fdsRunner(listJson = FD): CommandRunner {
  return ((cmd) => {
    if (cmd[0] === "git") {
      return { status: 0, stdout: "https://github.com/bounded-systems/prx.git\n", stderr: "" };
    }
    return { status: 0, stdout: listJson, stderr: "" };
  }) as CommandRunner;
}

describe("Front Desk readers → BeadsRecord (GH-1012)", () => {
  test("loadAllBeadsViaDaemon reads Front Desk and derives refs", async () => {
    const recs = await loadAllBeadsViaDaemon({ run: fdsRunner(), cwd: "/repo" });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.id).toBe("GH-123");
    expect(recs[0]!.issueType).toBe("task");
    expect(recs[0]!.externalIssueNumber).toBe(123);
    expect(recs[0]!.externalRefs.gh).toContain("/prx/issues/123");
  });

  test("showBeadViaDaemon returns the one record by GH id", async () => {
    const rec = await showBeadViaDaemon("GH-123", { run: fdsRunner(), cwd: "/repo" });
    expect(rec?.id).toBe("GH-123");
    expect(rec?.externalIssueNumber).toBe(123);
  });

  test("showBeadViaDaemon returns null when the id is absent (not an exception)", async () => {
    const rec = await showBeadViaDaemon("GH-999", { run: fdsRunner(), cwd: "/repo" });
    expect(rec).toBeNull();
  });
});
