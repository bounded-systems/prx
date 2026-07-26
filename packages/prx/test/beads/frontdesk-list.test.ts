import { describe, expect, test } from "bun:test";
import {
  frontDeskBeadsRaw,
  frontDeskBeadRaw,
  resolveListSource,
} from "../../src/beads/frontdesk-list.ts";
import { parseBeadsRecords } from "../../src/triage/triage.ts";
import type { CommandRunner } from "@bounded-systems/proc";

function runnerFor(opts: {
  originUrl?: string;
  fdsStdout?: string;
  fdsStatus?: number;
  spawns?: { cmd: string[]; env: Record<string, string> | undefined }[];
}): CommandRunner {
  return ((cmd, options) => {
    opts.spawns?.push({ cmd, env: options?.env as Record<string, string> | undefined });
    if (cmd[0] === "git") {
      return opts.originUrl !== undefined
        ? { status: 0, stdout: `${opts.originUrl}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "no origin" };
    }
    return { status: opts.fdsStatus ?? 0, stdout: opts.fdsStdout ?? "", stderr: "boom" };
  }) as CommandRunner;
}

const LIST = JSON.stringify({
  source: "server",
  syncedAt: "2026-07-26T00:00:00Z",
  items: [
    {
      number: 5,
      repository: "prx",
      kind: "task",
      title: "open one",
      status: "Todo",
      effort: 1,
      value: 2,
      dependsOn: [],
      ageDays: 0,
    },
    {
      number: 6,
      repository: "prx",
      kind: "epic",
      title: "done epic",
      status: "Done",
      effort: 0,
      value: 0,
      dependsOn: [],
      ageDays: 3,
    },
  ],
  edges: [
    {
      from: { number: 6, repository: "prx" },
      to: { number: 5, repository: "prx" },
      kind: "parent-child",
    },
  ],
});

const deps = (stdout = LIST) => ({
  run: runnerFor({ originUrl: "https://github.com/bounded-systems/prx.git", fdsStdout: stdout }),
  env: () => ({}) as Record<string, string>,
});

describe("resolveListSource", () => {
  test("defaults to frontdesk", () => {
    const prior = process.env.PRX_LIST_SOURCE;
    delete process.env.PRX_LIST_SOURCE;
    expect(resolveListSource()).toBe("frontdesk");
    if (prior !== undefined) process.env.PRX_LIST_SOURCE = prior;
  });
  test("PRX_LIST_SOURCE=bd → bd; explicit wins", () => {
    const prior = process.env.PRX_LIST_SOURCE;
    process.env.PRX_LIST_SOURCE = "bd";
    expect(resolveListSource()).toBe("bd");
    expect(resolveListSource("frontdesk")).toBe("frontdesk");
    if (prior === undefined) delete process.env.PRX_LIST_SOURCE;
    else process.env.PRX_LIST_SOURCE = prior;
  });
});

describe("frontDeskBeadsRaw", () => {
  test("spawns `fds list --repo <name>` with FDS_JSON=1", () => {
    const spawns: { cmd: string[]; env: Record<string, string> | undefined }[] = [];
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStdout: LIST,
      spawns,
    });
    frontDeskBeadsRaw("/repo", { run, env: () => ({}) });
    const fds = spawns.find((s) => s.cmd[0] === "fds")!;
    expect(fds.cmd).toEqual(["fds", "list", "--repo", "prx"]);
    expect(fds.env?.FDS_JSON).toBe("1");
  });

  test("includes Done items and shapes raw bd-json rows the parser accepts", () => {
    const rows = frontDeskBeadsRaw("/repo", deps());
    // parseBeadsRecords is the real host-side transform.
    const recs = parseBeadsRecords(rows);
    const byId = new Map(recs.map((r) => [r.id, r]));
    expect(byId.has("GH-5")).toBe(true);
    expect(byId.has("GH-6")).toBe(true); // Done item present
    expect(byId.get("GH-5")!.status).toBe("open");
    expect(byId.get("GH-6")!.status).toBe("closed");
    expect(byId.get("GH-5")!.externalIssueNumber).toBe(5);
    expect(byId.get("GH-5")!.externalRefs.gh).toContain("/prx/issues/5");
  });

  test("edges become outgoing dependencies on the source record", () => {
    const recs = parseBeadsRecords(frontDeskBeadsRaw("/repo", deps()));
    const epic = recs.find((r) => r.id === "GH-6")!;
    expect(epic.dependencies).toEqual([
      { issueId: "GH-6", dependsOnId: "GH-5", type: "parent-child" },
    ]);
  });

  test("an fds failure throws, naming PRX_LIST_SOURCE=bd", () => {
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStatus: 2,
    });
    expect(() => frontDeskBeadsRaw("/repo", { run, env: () => ({}) })).toThrow(
      /PRX_LIST_SOURCE=bd/,
    );
  });

  test("frontDeskBeadRaw returns one row by synthetic id, or null", () => {
    expect((frontDeskBeadRaw("/repo", "GH-5", deps()) as { id: string }).id).toBe("GH-5");
    expect(frontDeskBeadRaw("/repo", "GH-999", deps())).toBeNull();
  });
});
