import { describe, expect, test } from "bun:test";

import type { ImportAndPushOptions } from "@bounded-systems/door-kit/keeper";
import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";

import { IsolatedKeeperClient, type KeeperTransport } from "../../src/keeperd/client.ts";
import type { KeeperRemoteRequest } from "../../src/keeperd/contract.ts";
import {
  runKeeperDoorAttestLaunch,
  runKeeperDoorPush,
  runKeeperRemote,
  type KeeperRemoteInput,
} from "../../src/keeperd/host.ts";

const TREE = "a".repeat(40);
const COMMIT = "b".repeat(40);
const BUNDLE = "QlVORExF"; // base64, opaque to this layer

const okResult = (stdout = ""): GitExecResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  policy: null,
});

/** A fake `execGit` answering the host-side stage → commit-tree flow offline. */
function fakeGit(overrides: Partial<Record<string, GitExecResult>> = {}): {
  git: typeof execGit;
  calls: GitExecOptions[];
} {
  const calls: GitExecOptions[] = [];
  const git = ((opts: GitExecOptions): GitExecResult => {
    calls.push(opts);
    if (opts.subcommand in overrides) return overrides[opts.subcommand]!;
    if (opts.subcommand === "write-tree") return okResult(TREE);
    if (opts.subcommand === "commit-tree") return okResult(COMMIT);
    return okResult();
  }) as typeof execGit;
  return { git, calls };
}

const INPUT: KeeperRemoteInput = {
  cwd: "/work/repo",
  parentSha: "c".repeat(40),
  message: "GH-456: materialize submit artifact",
  date: "2026-06-05T00:00:00Z",
  branch: "GH-456",
  remote: "origin",
};

describe("runKeeperRemote (host orchestrator, model A)", () => {
  test("commits locally, bundles the range, and asks the VM to import + push", async () => {
    let sent: KeeperRemoteRequest | undefined;
    const transport: KeeperTransport = async (req) => {
      sent = req;
      return { status: "ok", commitSha: COMMIT, pushedRef: "refs/heads/GH-456" };
    };
    const client = new IsolatedKeeperClient(transport);

    let bundledFor: { cwd: string; parentSha: string; branch: string } | undefined;
    const { git, calls } = fakeGit();
    const res = await runKeeperRemote(INPUT, client, {
      git,
      bundle: (i) => {
        bundledFor = i;
        return BUNDLE;
      },
    });

    // The host did the keyless commit itself, as role=keeper.
    expect(calls.map((c) => c.subcommand)).toEqual(["add", "write-tree", "commit-tree", "switch"]);
    expect(calls.every((c) => c.role === "keeper")).toBe(true);
    // The bundle was cut for the (parent, branch] range from the host worktree.
    expect(bundledFor).toEqual({ cwd: "/work/repo", parentSha: "c".repeat(40), branch: "GH-456" });
    // The VM was handed the host-built commit + bundle, not a tree/message to rebuild.
    expect(sent).toEqual({
      kind: "import-and-push",
      bundleBase64: BUNDLE,
      commitSha: COMMIT,
      branch: "GH-456",
      remote: "origin",
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.pushedRef).toBe("refs/heads/GH-456");
  });

  test("threads pushArgs + ledgerRef into the request", async () => {
    let sent: KeeperRemoteRequest | undefined;
    const client = new IsolatedKeeperClient(async (req) => {
      sent = req;
      return { status: "ok", commitSha: COMMIT, pushedRef: "refs/heads/GH-456" };
    });
    await runKeeperRemote(
      { ...INPUT, pushArgs: ["--force-with-lease"], ledgerRef: "refs/prx/ledger" },
      client,
      { git: fakeGit().git, bundle: () => BUNDLE },
    );
    expect(sent?.pushArgs).toEqual(["--force-with-lease"]);
    expect(sent?.ledgerRef).toBe("refs/prx/ledger");
  });

  test("returns a daemon error verdict as data (no throw)", async () => {
    const client = new IsolatedKeeperClient(async () => ({
      status: "error",
      code: "git-write",
      message: "push rejected",
      exitCode: 128,
    }));
    const res = await runKeeperRemote(INPUT, client, { git: fakeGit().git, bundle: () => BUNDLE });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.exitCode).toBe(128);
  });
});

describe("runKeeperDoorPush (door push of an already-materialized commit)", () => {
  test("bundles the (parent, branch] range and asks keeperd to import + push the commit", async () => {
    let sent: ImportAndPushOptions | undefined;
    let bundledFor: { cwd: string; parentSha: string; branch: string } | undefined;
    const res = await runKeeperDoorPush(
      {
        cwd: "/work/repo",
        parentSha: "c".repeat(40),
        commitSha: COMMIT,
        branch: "GH-456",
        remote: "origin",
      },
      {
        bundle: (i) => {
          bundledFor = i;
          return BUNDLE;
        },
        importAndPush: async (opts) => {
          sent = opts;
          return { status: "ok", commitSha: COMMIT, pushedRef: "refs/heads/GH-456" };
        },
      },
    );
    // It does NOT re-commit (no write-tree/commit-tree) — only the bundle is cut.
    expect(bundledFor).toEqual({ cwd: "/work/repo", parentSha: "c".repeat(40), branch: "GH-456" });
    expect(sent).toEqual({
      repo: "/work/repo",
      bundleBase64: BUNDLE,
      commitSha: COMMIT,
      branch: "GH-456",
      remote: "origin",
      notesRef: "provenance",
    });
    expect(res).toEqual({ status: "ok", commitSha: COMMIT, pushedRef: "refs/heads/GH-456" });
  });

  test("threads pushArgs + ledgerRef into the request", async () => {
    let sent: ImportAndPushOptions | undefined;
    await runKeeperDoorPush(
      {
        cwd: "/w",
        parentSha: "c".repeat(40),
        commitSha: COMMIT,
        branch: "b",
        remote: "origin",
        pushArgs: ["--force-with-lease"],
        ledgerRef: "GH-456:keeper",
      },
      {
        bundle: () => BUNDLE,
        importAndPush: async (opts) => {
          sent = opts;
          return { status: "ok", commitSha: COMMIT, pushedRef: "refs/heads/b" };
        },
      },
    );
    expect(sent?.pushArgs).toEqual(["--force-with-lease"]);
    expect(sent?.ledgerRef).toBe("GH-456:keeper");
  });

  test("threads l2LaunchDigest into the request (capability chain link)", async () => {
    let sent: ImportAndPushOptions | undefined;
    await runKeeperDoorPush(
      {
        cwd: "/w",
        parentSha: "c".repeat(40),
        commitSha: COMMIT,
        branch: "b",
        remote: "origin",
        l2LaunchDigest: "deadbeef".repeat(8),
      },
      {
        bundle: () => BUNDLE,
        importAndPush: async (opts) => {
          sent = opts;
          return { status: "ok", commitSha: COMMIT, pushedRef: "refs/heads/b" };
        },
      },
    );
    expect(sent?.l2LaunchDigest).toBe("deadbeef".repeat(8));
  });
});

describe("runKeeperDoorAttestLaunch (L2 launch via the keeper door)", () => {
  test("calls attest-launch and returns the signed L2 + content-address", async () => {
    let sent: { subject: string; manifest: unknown } | undefined;
    const res = await runKeeperDoorAttestLaunch(
      { subject: "box-1", manifest: { doors: ["keeper"] } },
      {
        attestLaunch: async (opts) => {
          sent = opts;
          return {
            status: "ok",
            subject: opts.subject,
            manifestDigest: "m".repeat(64),
            l2LaunchDigest: "l".repeat(64),
            attestation: { statement: {}, signature: "sig" },
          };
        },
      },
    );
    expect(sent).toEqual({ subject: "box-1", manifest: { doors: ["keeper"] } });
    expect(res.l2LaunchDigest).toBe("l".repeat(64));
    expect(res.manifestDigest).toBe("m".repeat(64));
  });

  test("throws when the daemon returns an error verdict", async () => {
    await expect(
      runKeeperDoorAttestLaunch(
        { subject: "x", manifest: {} },
        { attestLaunch: async () => ({ status: "error", code: "NO_KEY", message: "no key" }) },
      ),
    ).rejects.toThrow(/attest-launch failed.*NO_KEY/);
  });
});
