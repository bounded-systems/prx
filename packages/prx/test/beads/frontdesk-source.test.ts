import { describe, expect, test } from "bun:test";
import { frontDeskReady, resolveRepoName } from "../../src/beads/frontdesk-source.ts";
import type { CommandRunner } from "@bounded-systems/proc";

// A CommandRunner that answers `git remote get-url origin` with a fixed URL and
// `fds graph` with a fixed JSON payload; records the fds argv + env.
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
    // fds
    return { status: opts.fdsStatus ?? 0, stdout: opts.fdsStdout ?? "", stderr: "boom" };
  }) as CommandRunner;
}

const GRAPH = JSON.stringify({
  source: "server",
  syncedAt: "2026-07-26T00:00:00Z",
  ready: [
    {
      number: 5,
      repository: "prx",
      kind: "task",
      title: "do a",
      status: "Todo",
      effort: 2,
      value: 8,
      score: 4,
      ageDays: 1,
    },
  ],
  blocked: [
    {
      number: 6,
      repository: "prx",
      kind: "task",
      title: "do b",
      status: "Todo",
      effort: 1,
      value: 3,
      score: 3,
      ageDays: 0,
      blockedBy: [{ number: 5, repository: "prx" }],
    },
  ],
  edges: [
    {
      from: { number: 6, repository: "prx" },
      to: { number: 5, repository: "prx" },
      kind: "blocks",
    },
  ],
});

describe("resolveRepoName", () => {
  test("parses the repo name from an https origin", () => {
    const run = runnerFor({ originUrl: "https://github.com/bounded-systems/prx.git" });
    expect(resolveRepoName("/repo", run)).toBe("prx");
  });
  test("parses the repo name from an ssh origin", () => {
    const run = runnerFor({ originUrl: "git@github.com:bounded-systems/prx.git" });
    expect(resolveRepoName("/repo", run)).toBe("prx");
  });
  test("undefined when there is no origin", () => {
    expect(resolveRepoName("/repo", runnerFor({}))).toBeUndefined();
  });
});

describe("frontDeskReady mapping", () => {
  test("spawns `fds graph --repo <name>` with FDS_JSON=1", () => {
    const spawns: { cmd: string[]; env: Record<string, string> | undefined }[] = [];
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStdout: GRAPH,
      spawns,
    });
    frontDeskReady({ cwd: "/repo", deps: { run, env: () => ({}) } });
    const fds = spawns.find((s) => s.cmd[0] === "fds")!;
    expect(fds.cmd).toEqual(["fds", "graph", "--repo", "prx"]);
    expect(fds.env?.FDS_JSON).toBe("1");
  });

  test("maps ready items to GH-canonical BdReadyCandidates", () => {
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStdout: GRAPH,
    });
    const out = frontDeskReady({ cwd: "/repo", deps: { run, env: () => ({}) } });
    expect(out.ready).toHaveLength(1);
    const c = out.ready[0]!;
    expect(c.id).toBe("GH-5");
    expect(c.status).toBe("open");
    expect(c.issue_type).toBe("task");
    expect(c.external_ref).toContain("/prx/issues/5");
    expect(c.blocked_by).toEqual([]);
  });

  test("blocked items carry their open blocker IDs", () => {
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStdout: GRAPH,
    });
    const out = frontDeskReady({ cwd: "/repo", deps: { run, env: () => ({}) } });
    expect(out.blocked).toHaveLength(1);
    expect(out.blocked[0]!.id).toBe("GH-6");
    expect(out.blocked[0]!.blocked_by).toEqual([{ id: "GH-5", status: "open" }]);
    expect(out.blocked[0]!.blocked_by_count).toBe(1);
  });

  test("PRX_FRONTDESK_BIN overrides the fds executable", () => {
    const spawns: { cmd: string[]; env: Record<string, string> | undefined }[] = [];
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStdout: GRAPH,
      spawns,
    });
    frontDeskReady({ cwd: "/repo", deps: { run, env: () => ({ PRX_FRONTDESK_BIN: "/opt/fds" }) } });
    expect(spawns.find((s) => s.cmd.includes("graph"))!.cmd[0]).toBe("/opt/fds");
  });

  test("an fds failure throws, naming the PRX_READY_SOURCE=bd escape hatch", () => {
    const run = runnerFor({
      originUrl: "https://github.com/bounded-systems/prx.git",
      fdsStatus: 3,
    });
    expect(() => frontDeskReady({ cwd: "/repo", deps: { run, env: () => ({}) } })).toThrow(
      /PRX_READY_SOURCE=bd/,
    );
  });
});
