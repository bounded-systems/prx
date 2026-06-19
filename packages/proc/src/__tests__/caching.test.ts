import { describe, expect, test } from "bun:test";

import {
  cachingProcExecutor,
  policyCacheable,
  type ProcExecutor,
  type ProcRequest,
  type ProcResult,
} from "@bounded-systems/proc";

function countingInner(): { exec: ProcExecutor["exec"]; calls: () => number } {
  let n = 0;
  return {
    exec: async (req: ProcRequest): Promise<ProcResult> => {
      n += 1;
      return { status: 0, stdout: `out:${req.command}:${n}`, stderr: "", signal: null };
    },
    calls: () => n,
  };
}

describe("policyCacheable", () => {
  test("pure-read policy-tool subcommands are cacheable", () => {
    expect(
      policyCacheable({ command: "git", args: ["--no-pager", "-C", "/x", "rev-parse", "HEAD"] }),
    ).toBe(true);
    expect(policyCacheable({ command: "gh", args: ["pr", "view", "1"] })).toBe(true);
    expect(policyCacheable({ command: "bd", args: ["list", "--json"] })).toBe(true);
  });

  test("mutations and non-policy tools are not cacheable", () => {
    expect(policyCacheable({ command: "git", args: ["commit", "-m", "x"] })).toBe(false);
    expect(policyCacheable({ command: "git", args: ["fetch", "origin"] })).toBe(false);
    expect(policyCacheable({ command: "find", args: ["."] })).toBe(false);
    expect(policyCacheable({ command: "docker", args: ["compose", "up"] })).toBe(false);
  });

  test("a mutating token anywhere disqualifies the request", () => {
    // 'show' is a read, but 'commit' present → not cacheable (conservative).
    expect(policyCacheable({ command: "git", args: ["show", "commit"] })).toBe(false);
  });
});

describe("cachingProcExecutor", () => {
  test("repeated pure reads hit the cache (inner runs once)", async () => {
    const inner = countingInner();
    const exec = cachingProcExecutor({ exec: inner.exec });
    const req: ProcRequest = { command: "git", args: ["rev-parse", "HEAD"] };
    const a = await exec.exec(req);
    const b = await exec.exec(req);
    expect(inner.calls()).toBe(1);
    expect(b.stdout).toBe(a.stdout);
  });

  test("mutations always pass through (never cached)", async () => {
    const inner = countingInner();
    const exec = cachingProcExecutor({ exec: inner.exec });
    const req: ProcRequest = { command: "git", args: ["commit", "-m", "x"] };
    await exec.exec(req);
    await exec.exec(req);
    expect(inner.calls()).toBe(2);
  });

  test("invalidate() drops the layer — next read re-derives", async () => {
    const inner = countingInner();
    const exec = cachingProcExecutor({ exec: inner.exec });
    const req: ProcRequest = { command: "git", args: ["rev-parse", "HEAD"] };
    await exec.exec(req);
    exec.invalidate();
    await exec.exec(req);
    expect(inner.calls()).toBe(2);
  });

  test("distinct requests (cwd) are cached independently", async () => {
    const inner = countingInner();
    const exec = cachingProcExecutor({ exec: inner.exec });
    await exec.exec({ command: "git", args: ["rev-parse", "HEAD"], cwd: "/a" });
    await exec.exec({ command: "git", args: ["rev-parse", "HEAD"], cwd: "/b" });
    expect(inner.calls()).toBe(2);
  });
});
