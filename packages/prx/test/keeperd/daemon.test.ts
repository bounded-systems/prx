import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";
import { ed25519Signer, generateEd25519Keypair, type DerivationStore } from "@bounded-systems/anchored-chain";

import {
  FrameDecoder,
  encodeFrame,
  handleKeeperRequest,
  runKeeperServe,
  type KeeperDaemonDeps,
} from "../../src/keeperd/daemon.ts";
import type { KeeperRemoteRequest } from "../../src/keeperd/contract.ts";

const COMMIT = "c".repeat(40);

const REQUEST: KeeperRemoteRequest = {
  kind: "import-and-push",
  bundleBase64: "ZGVhZGJlZWY=",
  commitSha: COMMIT,
  branch: "GH-456",
  remote: "origin",
};

const okResult = (stdout = ""): GitExecResult => ({ exitCode: 0, stdout, stderr: "", policy: null });

/**
 * A fake `execGit` that records calls and answers the model-A import+push flow:
 * the daemon's default `importBundleIntoRepo` runs `fetch` → `switch` →
 * `rev-parse HEAD` (which must echo the imported tip) before `runKeeperPush`.
 */
function fakeGit(overrides: Partial<Record<string, GitExecResult>> = {}): {
  git: typeof execGit;
  calls: GitExecOptions[];
} {
  const calls: GitExecOptions[] = [];
  const git = ((opts: GitExecOptions): GitExecResult => {
    calls.push(opts);
    if (opts.subcommand in overrides) return overrides[opts.subcommand]!;
    if (opts.subcommand === "rev-parse") return okResult(COMMIT); // imported tip
    return okResult();
  }) as typeof execGit;
  return { git, calls };
}

describe("handleKeeperRequest", () => {
  test("imports the bundle and pushes the branch under role=keeper", async () => {
    const { git, calls } = fakeGit();
    const res = await handleKeeperRequest(REQUEST, { git });

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.commitSha).toBe(COMMIT);
      expect(res.pushedRef).toBe("refs/heads/GH-456");
    }
    // every git-write ran as role=keeper, in order: import (fetch → switch →
    // rev-parse) then push. The daemon never commit-trees — the host already did.
    expect(calls.every((c) => c.role === "keeper")).toBe(true);
    expect(calls.map((c) => c.subcommand)).toEqual(["fetch", "switch", "rev-parse", "push"]);
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

  test("maps a bad import (tip mismatch) to a git-write error before pushing", async () => {
    // rev-parse echoes a different tip than the requested commitSha, so
    // importBundleIntoRepo throws KeeperGitError and the push never runs.
    const { git, calls } = fakeGit({ "rev-parse": okResult("d".repeat(40)) });
    const res = await handleKeeperRequest(REQUEST, { git });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("git-write");
    expect(calls.some((c) => c.subcommand === "push")).toBe(false);
  });

  test("imports the bundle BEFORE the push (order preserved)", async () => {
    const order: string[] = [];
    const { git } = fakeGit();
    const trackingGit = ((opts: GitExecOptions) => {
      order.push(opts.subcommand);
      return git(opts);
    }) as typeof execGit;
    const deps: KeeperDaemonDeps = {
      git: trackingGit,
      importBundle: () => {
        order.push("import");
      },
    };
    const res = await handleKeeperRequest(REQUEST, deps);
    expect(res.status).toBe("ok");
    expect(order[0]).toBe("import");
    expect(order.indexOf("import")).toBeLessThan(order.indexOf("push"));
  });

  test("emits a signed push/v1 into the per-request ledger when signer + ledgerRef present (GH-236)", async () => {
    const { git } = fakeGit();
    const kp = generateEd25519Keypair();
    const signer = ed25519Signer(kp.privateKey, kp.keyid);
    const appended: unknown[] = [];
    let openedRef: string | undefined;
    let closed = false;
    const store: Pick<DerivationStore, "append" | "get"> = {
      append: async (d) => {
        appended.push(d);
      },
      get: async () => null,
    };
    const deps: KeeperDaemonDeps = {
      git,
      signer,
      openLedger: (ledgerRef) => {
        openedRef = ledgerRef;
        return { store, close: () => { closed = true; } };
      },
    };
    const res = await handleKeeperRequest({ ...REQUEST, ledgerRef: "refs/prx/ledger" }, deps);
    expect(res.status).toBe("ok");
    expect(openedRef).toBe("refs/prx/ledger"); // ledger opened from the REQUEST's ref
    expect(appended.length).toBe(1); // a push/v1 derivation was signed + appended
    expect(closed).toBe(true); // per-request ledger closed
  });

  test("does NOT open a ledger when the request omits ledgerRef (bare push)", async () => {
    const { git } = fakeGit();
    const kp = generateEd25519Keypair();
    let opened = false;
    const res = await handleKeeperRequest(REQUEST, {
      git,
      signer: ed25519Signer(kp.privateKey, kp.keyid),
      openLedger: () => {
        opened = true;
        return { store: { append: async () => {}, get: async () => null }, close: () => {} };
      },
    });
    expect(res.status).toBe("ok");
    expect(opened).toBe(false);
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
    const res = (await sendFrame(path, { kind: "import-and-push", commitSha: "nope" })) as {
      status: string;
      code?: string;
    };
    expect(res.status).toBe("error");
    expect(res.code).toBe("bad-request");
  });

  test("writes its own pid to --pidfile while listening, removes it on close (GH-223)", async () => {
    const { git } = fakeGit();
    const socketPath = join(tmpdir(), `keeperd-pid-${process.pid}-${counter++}.sock`);
    const pidfile = join(tmpdir(), `keeperd-pid-${process.pid}-${counter++}.pid`);
    try {
      server = await runKeeperServe({ socketPath, pidfile, deps: { git } });
      expect(existsSync(pidfile)).toBe(true);
      expect(readFileSync(pidfile, "utf8").trim()).toBe(String(process.pid));
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(pidfile, { force: true });
      rmSync(socketPath, { force: true });
    }
  });
});
