import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";

import { IsolatedKeeperClient } from "../../src/keeperd/client.ts";
import type { KeeperRemoteRequest } from "../../src/keeperd/contract.ts";
import { runKeeperServe, type KeeperDaemonDeps } from "../../src/keeperd/daemon.ts";
import { unixSocketTransport } from "../../src/keeperd/transport.ts";

const COMMIT = "c".repeat(40);

const REQUEST: KeeperRemoteRequest = {
  kind: "import-and-push",
  bundleBase64: "ZGVhZGJlZWY=",
  commitSha: COMMIT,
  branch: "GH-456",
  remote: "origin",
};

const okResult = (stdout = ""): GitExecResult => ({ exitCode: 0, stdout, stderr: "", policy: null });

function fakeGit(overrides: Partial<Record<string, GitExecResult>> = {}): typeof execGit {
  return ((opts: GitExecOptions): GitExecResult => {
    if (opts.subcommand in overrides) return overrides[opts.subcommand]!;
    if (opts.subcommand === "rev-parse") return okResult(COMMIT); // imported tip
    return okResult();
  }) as typeof execGit;
}

describe("keeperd transport — full stack (client → transport → daemon over a unix socket)", () => {
  let server: Server | undefined;
  let counter = 0;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function serve(deps: KeeperDaemonDeps): Promise<string> {
    const socketPath = join(tmpdir(), `keeperd-tx-${process.pid}-${counter++}.sock`);
    server = await runKeeperServe({ socketPath, deps });
    return socketPath;
  }

  test("round-trips an import-and-push to an ok verdict end-to-end", async () => {
    const socketPath = await serve({ git: fakeGit() });
    const client = new IsolatedKeeperClient(unixSocketTransport(socketPath));

    const res = await client.importAndPush(REQUEST);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.commitSha).toBe(COMMIT);
      expect(res.pushedRef).toBe("refs/heads/GH-456");
    }
  });

  test("propagates a daemon error verdict (non-zero push) as data through the transport", async () => {
    const socketPath = await serve({
      git: fakeGit({ push: { exitCode: 128, stdout: "", stderr: "rejected", policy: null } }),
    });
    const res = await new IsolatedKeeperClient(unixSocketTransport(socketPath)).importAndPush(REQUEST);
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe("git-write");
      expect(res.exitCode).toBe(128);
    }
  });

  test("two sequential requests over fresh connections both succeed", async () => {
    const socketPath = await serve({ git: fakeGit() });
    const client = new IsolatedKeeperClient(unixSocketTransport(socketPath));
    const a = await client.importAndPush(REQUEST);
    const b = await client.importAndPush({ ...REQUEST, branch: "GH-457" });
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    if (b.status === "ok") expect(b.pushedRef).toBe("refs/heads/GH-457");
  });

  test("rejects when the daemon hangs up without a response", async () => {
    const socketPath = join(tmpdir(), `keeperd-tx-${process.pid}-${counter++}.sock`);
    // A server that accepts the request then ends the connection with no reply —
    // deterministic (the client sees a clean FIN after sending), unlike an
    // immediate reset-on-connect race.
    server = await new Promise<Server>((resolve) => {
      const s = createServer((socket) => {
        socket.on("data", () => socket.end());
      });
      s.listen(socketPath, () => resolve(s));
    });
    await expect(
      new IsolatedKeeperClient(unixSocketTransport(socketPath)).importAndPush(REQUEST),
    ).rejects.toThrow(/closed the connection before sending a response/);
  });
});
