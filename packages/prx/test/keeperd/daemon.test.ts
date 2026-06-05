import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";

import {
  FrameDecoder,
  encodeFrame,
  handleKeeperRequest,
  runKeeperServe,
  type KeeperDaemonDeps,
} from "../../src/keeperd/daemon.ts";
import type { KeeperRemoteRequest } from "../../src/keeperd/contract.ts";

const REQUEST: KeeperRemoteRequest = {
  kind: "commit-and-push",
  bundleBase64: "ZGVhZGJlZWY=",
  treeSha: "a".repeat(40),
  parentSha: "b".repeat(40),
  message: "GH-456: materialize submit artifact",
  date: "2026-06-05T00:00:00Z",
  branch: "GH-456",
  remote: "origin",
};

const COMMIT = "c".repeat(40);
const okResult = (stdout = ""): GitExecResult => ({ exitCode: 0, stdout, stderr: "", policy: null });

/** A fake `execGit` that records calls and answers the keeper commit/push flow. */
function fakeGit(overrides: Partial<Record<string, GitExecResult>> = {}): {
  git: typeof execGit;
  calls: GitExecOptions[];
} {
  const calls: GitExecOptions[] = [];
  const git = ((opts: GitExecOptions): GitExecResult => {
    calls.push(opts);
    if (opts.subcommand in overrides) return overrides[opts.subcommand]!;
    if (opts.subcommand === "commit-tree") return okResult(COMMIT);
    return okResult();
  }) as typeof execGit;
  return { git, calls };
}

describe("handleKeeperRequest", () => {
  test("commits the tree and pushes the branch under role=keeper", async () => {
    const { git, calls } = fakeGit();
    const res = await handleKeeperRequest(REQUEST, { git });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.commitSha).toBe(COMMIT);
      expect(res.pushedRef).toBe("refs/heads/GH-456");
    }
    // every git-write ran as role=keeper, in order: commit-tree → switch → push.
    expect(calls.every((c) => c.role === "keeper")).toBe(true);
    expect(calls.map((c) => c.subcommand)).toEqual(["commit-tree", "switch", "push"]);
    const push = calls.find((c) => c.subcommand === "push")!;
    expect(push.args).toEqual(["origin", "GH-456"]);
  });

  test("appends pushArgs after <remote> <branch>", async () => {
    const { git, calls } = fakeGit();
    await handleKeeperRequest({ ...REQUEST, pushArgs: ["--force-with-lease"] }, { git });
    expect(calls.find((c) => c.subcommand === "push")!.args).toEqual([
      "origin",
      "GH-456",
      "--force-with-lease",
    ]);
  });

  test("maps a non-zero push to a typed git-write error with the exit code", async () => {
    const { git } = fakeGit({ push: { exitCode: 128, stdout: "", stderr: "rejected", policy: null } });
    const res = await handleKeeperRequest(REQUEST, { git });
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe("git-write");
      expect(res.exitCode).toBe(128);
      expect(res.message).toContain("128");
    }
  });

  test("maps a KeeperGitError (bad commit sha) to a git-write error", async () => {
    const { git } = fakeGit({ "commit-tree": okResult("not-a-sha") });
    const res = await handleKeeperRequest(REQUEST, { git });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("git-write");
  });

  test("materializes the bundle BEFORE the commit (slice-3 seam, order preserved)", async () => {
    const order: string[] = [];
    const { git } = fakeGit();
    const trackingGit = ((opts: GitExecOptions) => {
      order.push(opts.subcommand);
      return git(opts);
    }) as typeof execGit;
    const deps: KeeperDaemonDeps = {
      git: trackingGit,
      materializeBundle: async () => {
        order.push("materialize");
      },
    };
    const res = await handleKeeperRequest(REQUEST, deps);
    expect(res.status).toBe("ok");
    expect(order[0]).toBe("materialize");
    expect(order.indexOf("materialize")).toBeLessThan(order.indexOf("commit-tree"));
  });
});

describe("frame codec", () => {
  test("round-trips a value through encode → decode", () => {
    const frames = new FrameDecoder().push(encodeFrame({ status: "ok", n: 1 }));
    expect(frames).toEqual([{ status: "ok", n: 1 }]);
  });

  test("reassembles a frame split across chunks", () => {
    const buf = encodeFrame(REQUEST);
    const dec = new FrameDecoder();
    expect(dec.push(buf.subarray(0, 3))).toEqual([]); // header not even complete
    expect(dec.push(buf.subarray(3, 10))).toEqual([]); // body partial
    expect(dec.push(buf.subarray(10))).toEqual([REQUEST]);
  });

  test("yields multiple frames delivered in one chunk", () => {
    const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
    expect(new FrameDecoder().push(chunk)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("runKeeperServe (unix socket, end-to-end)", () => {
  let server: Server | undefined;
  let socketPath: string | undefined;
  let counter = 0;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(deps: KeeperDaemonDeps): Promise<string> {
    socketPath = join(tmpdir(), `keeperd-${process.pid}-${counter++}.sock`);
    server = await runKeeperServe({ socketPath, deps });
    return socketPath;
  }

  function sendFrame(path: string, value: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const dec = new FrameDecoder();
      const sock = connect(path, () => sock.write(encodeFrame(value)));
      sock.on("data", (chunk: Buffer) => {
        const frames = dec.push(chunk);
        if (frames.length > 0) {
          resolve(frames[0]);
          sock.end();
        }
      });
      sock.on("error", reject);
    });
  }

  test("serves a valid request to an ok verdict over the socket", async () => {
    const { git } = fakeGit();
    const path = await start({ git });
    const res = (await sendFrame(path, REQUEST)) as { status: string; commitSha?: string };
    expect(res.status).toBe("ok");
    expect(res.commitSha).toBe(COMMIT);
  });

  test("replies bad-request for a frame that violates the contract (daemon stays up)", async () => {
    const { git } = fakeGit();
    const path = await start({ git });
    const res = (await sendFrame(path, { kind: "commit-and-push", treeSha: "nope" })) as {
      status: string;
      code?: string;
    };
    expect(res.status).toBe("error");
    expect(res.code).toBe("bad-request");
  });
});
