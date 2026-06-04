// GH-2353 (GH-2348.3): `prx keeper` CLI verb validation. The push/branch
// dispatch (→ execGit role=keeper) is exercised end-to-end by the
// help-all dispatcher-parity suite; here we lock the verb guard, which fails
// before any git invocation (so no real push runs in the test).
// GH-2346: `keeper commit` headless finalize (add -A + commit under role=keeper).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  digestManifest,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
  type Digest,
} from "@bounded-systems/anchored-chain";
// Type-only: keep this unit test off the @bounded-systems/git runtime chain;
// runKeeperPush is exercised with a stubbed `git`.
import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";

import { runCli } from "../../src/pr-state/cli.ts";
import {
  KeeperGitError,
  runKeeperCommitTree,
  runKeeperEnsureWorktree,
  runKeeperPush,
  runKeeperWriteTree,
} from "../../src/pr-state/keeper.ts";
import { GIT_PUSH_BUILD_TYPE, type AttestDeps } from "../../src/provenance/attest.ts";
import { slsaProvenanceStatement, verifySlsaEnvelope } from "../../src/provenance/slsa.ts";

describe("runKeeperEnsureWorktree — worktree placement + self-heal (prx-0yf / prx-5h0)", () => {
  // Stub keeper's git (execGit-shaped) + fs probes so the worktree lifecycle
  // runs offline. `worktreeHealthy` toggles the `.git`-present health check.
  function stub(opts: {
    registered?: boolean;
    branchExists?: boolean;
    worktreeHealthy?: boolean;
    targetExistsOnDisk?: boolean;
    addExit?: number;
  }) {
    const calls: string[][] = [];
    const removed: string[] = [];
    const git = (({ subcommand, args }: GitExecOptions): GitExecResult => {
      calls.push([subcommand, ...args]);
      if (subcommand === "worktree" && args[0] === "list") {
        return { exitCode: 0, stdout: opts.registered ? "worktree /wt/GH-7\n" : "", stderr: "" } as GitExecResult;
      }
      if (subcommand === "rev-parse") {
        return { exitCode: opts.branchExists === false ? 1 : 0, stdout: "", stderr: "" } as GitExecResult;
      }
      if (subcommand === "worktree" && args[0] === "add") {
        return { exitCode: opts.addExit ?? 0, stdout: "", stderr: opts.addExit ? "boom" : "" } as GitExecResult;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as GitExecResult;
    }) as typeof execGit;
    const exists = (p: string) =>
      p.endsWith(".git") ? opts.worktreeHealthy === true : opts.targetExistsOnDisk === true;
    const remove = (p: string) => { removed.push(p); };
    return { git, exists, remove, calls, removed };
  }

  test("healthy registered worktree → exists (idempotent, no add)", () => {
    const s = stub({ registered: true, worktreeHealthy: true });
    const out = runKeeperEnsureWorktree({ branch: "GH-7", targetPath: "/wt/GH-7" }, "/repo", s);
    expect(out.status).toBe("exists");
    expect(s.calls.some((c) => c.join(" ").includes("worktree add"))).toBe(false);
  });

  test("fresh worktree → created (branch reused when it exists)", () => {
    const s = stub({ registered: false, branchExists: true });
    const out = runKeeperEnsureWorktree({ branch: "GH-7", targetPath: "/wt/GH-7" }, "/repo", s);
    expect(out.status).toBe("created");
    const add = s.calls.find((c) => c[0] === "worktree" && c[1] === "add")!;
    expect(add).toEqual(["worktree", "add", "/wt/GH-7", "GH-7"]);
  });

  test("self-heal: a registered-but-broken worktree (.git gone) is pruned + recreated (prx-5h0)", () => {
    // The #47 regression: registered but unhealthy was treated as a healthy
    // "exists", leaving a worktree with no `.git`. Keeper now removes + recreates.
    const s = stub({ registered: true, worktreeHealthy: false, targetExistsOnDisk: true, branchExists: true });
    const out = runKeeperEnsureWorktree({ branch: "GH-7", targetPath: "/wt/GH-7" }, "/repo", s);
    expect(out.status).toBe("recreated");
    expect(s.calls.some((c) => c.join(" ").includes("worktree prune"))).toBe(true);
    expect(s.calls.some((c) => c.join(" ").includes("worktree remove --force"))).toBe(true);
    expect(s.removed).toContain("/wt/GH-7"); // the leftover dir was cleared
    expect(s.calls.some((c) => c[0] === "worktree" && c[1] === "add")).toBe(true);
  });

  test("a failing `git worktree add` throws KeeperGitError", () => {
    const s = stub({ registered: false, branchExists: true, addExit: 1 });
    expect(() => runKeeperEnsureWorktree({ branch: "GH-7", targetPath: "/wt/GH-7" }, "/repo", s)).toThrow(
      KeeperGitError,
    );
  });
});

describe("prx keeper CLI verb validation (GH-2353)", () => {
  test("no verb → non-zero exit with the verb hint", async () => {
    const errors: string[] = [];
    const exit = await runCli(
      ["keeper"],
      { log: () => {}, error: (l: string) => errors.push(l) },
      {},
    );
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("push | branch | commit"))).toBe(true);
  });

  test("unknown verb → non-zero exit", async () => {
    const errors: string[] = [];
    const exit = await runCli(
      ["keeper", "bogus"],
      { log: () => {}, error: (l: string) => errors.push(l) },
      {},
    );
    expect(exit).not.toBe(0);
  });

  test("commit without -m/--message → non-zero with a message hint", async () => {
    const errors: string[] = [];
    const exit = await runCli(
      ["keeper", "commit"],
      { log: () => {}, error: (l: string) => errors.push(l) },
      {},
    );
    expect(exit).not.toBe(0);
    expect(errors.some((l) => l.includes("requires a message"))).toBe(true);
  });
});

describe("prx keeper commit — headless commit (GH-2346)", () => {
  test("stages + commits the worktree under role=keeper (no manual git)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "prx-keeper-commit-"));
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    // Prior history (the realistic implement scenario: a branch with a HEAD)…
    writeFileSync(join(repo, "README.md"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    // …then an uncommitted change the implement agent left behind.
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");

    const out: string[] = [];
    const exit = await runCli(
      ["keeper", "commit", "--message", "feat: headless via keeper", "--cwd", repo],
      { log: (l: string) => out.push(l), error: (l: string) => out.push(l) },
      {},
    );

    expect(exit).toBe(0);
    // HEAD advanced to the keeper commit, and the change is in it.
    expect(git(["log", "-1", "--format=%s"]).trim()).toBe(
      "feat: headless via keeper",
    );
    expect(git(["show", "--name-only", "--format=", "HEAD"])).toContain(
      "feature.ts",
    );
  }, 30_000);
});

// GH-2348.2: keeper push is attestation-capable — with attest deps it emits the
// same signed SLSA push/v1 derivation submit-publish does (via attestingGit,
// subject = post-push rev-parse HEAD). Offline test with a stubbed git
// (mirrors src/provenance/__tests__/attest.test.ts).
describe("runKeeperPush attestation (GH-2348.2)", () => {
  const BUILDER_ID = "prx://claude-code/keeper";
  const NOW = 1000;
  const PUSH_OID = "0123456789abcdef0123456789abcdef01234567";

  type FakeStore = Pick<DerivationStore, "append" | "get"> & {
    readonly appended: Derivation[];
  };
  function fakeStore(): FakeStore {
    const map = new Map<string, Derivation>();
    const appended: Derivation[] = [];
    return {
      appended,
      async append(d) {
        map.set(d.derivationId as string, d);
        appended.push(d);
      },
      async get(id) {
        return map.get(id as string) ?? null;
      },
    };
  }
  function mkAttest(store: FakeStore) {
    const kp = generateEd25519Keypair();
    const deps: AttestDeps = {
      signer: ed25519Signer(kp.privateKey, kp.keyid),
      store,
      builderId: BUILDER_ID,
      now: () => NOW,
    };
    return { deps, publicKey: kp.publicKey };
  }
  // Stub matching `typeof execGit`: clean push, HEAD → fixed oid.
  function fakeGit(): typeof execGit & { calls: string[] } {
    const calls: string[] = [];
    const fn = ((opts: GitExecOptions): GitExecResult => {
      calls.push(opts.subcommand);
      if (opts.subcommand === "rev-parse") {
        return { exitCode: 0, stdout: `${PUSH_OID}\n`, stderr: "", policy: null };
      }
      return { exitCode: 0, stdout: "", stderr: "", policy: null };
    }) as typeof execGit & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  test("with attest deps, a clean push emits a signed push/v1 derivation", async () => {
    const store = fakeStore();
    const { deps, publicKey } = mkAttest(store);
    const git = fakeGit();
    const result = await runKeeperPush(["origin", "GH-2363"], "/repo", { attest: deps, git });

    expect(result.exitCode).toBe(0);
    expect(git.calls).toEqual(["push", "rev-parse"]); // subject resolved post-push
    expect(store.appended).toHaveLength(1);

    const d = store.appended[0]!;
    expect(d.manifest.outputs.commit).toBe(`gitCommit:${PUSH_OID}` as Digest);
    expect(d.derivationId).toBe(digestManifest(d.manifest));

    const stmt = slsaProvenanceStatement({
      buildType: GIT_PUSH_BUILD_TYPE,
      builderId: BUILDER_ID,
      subject: [{ name: "commit", digest: { gitCommit: PUSH_OID } }],
      externalParameters: { subcommand: "push", args: ["origin", "GH-2363"] },
      invocationId: d.derivationId as string,
      startedOn: new Date(NOW).toISOString(),
    });
    expect(
      await verifySlsaEnvelope(stmt, d.envelope!, ed25519Verifier(publicKey)),
    ).toBe(true);
  });

  test("without attest deps, the push emits nothing (bare execGit)", async () => {
    const store = fakeStore();
    const git = fakeGit();
    const result = await runKeeperPush(["origin", "GH-2363"], "/repo", { git });
    expect(result.exitCode).toBe(0);
    expect(git.calls).toEqual(["push"]); // no rev-parse, no attestation
    expect(store.appended).toHaveLength(0);
  });
});

// GH-2381: keeper materializes the submit artifact's object graph — a tree at
// stage, a commit at publish — as the sole git-writer (I-AUD4).
describe("runKeeperWriteTree (GH-2381)", () => {
  const TREE_OID = "1111111111111111111111111111111111111111";

  /** Stub `execGit`: records (subcommand,args); write-tree → TREE_OID. */
  function fakeGit(over: { writeTreeExit?: number; addExit?: number } = {}): typeof execGit & {
    calls: Array<{ sub: string; args: string[] }>;
  } {
    const calls: Array<{ sub: string; args: string[] }> = [];
    const fn = ((opts: GitExecOptions): GitExecResult => {
      calls.push({ sub: opts.subcommand, args: opts.args });
      if (opts.subcommand === "add") {
        return { exitCode: over.addExit ?? 0, stdout: "", stderr: "add boom", policy: null };
      }
      if (opts.subcommand === "write-tree") {
        return {
          exitCode: over.writeTreeExit ?? 0,
          stdout: over.writeTreeExit ? "" : `${TREE_OID}\n`,
          stderr: over.writeTreeExit ? "write-tree boom" : "",
          policy: null,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", policy: null };
    }) as typeof execGit & { calls: Array<{ sub: string; args: string[] }> };
    fn.calls = calls;
    return fn;
  }

  test("stages the index then write-trees, both under role=keeper", async () => {
    const git = fakeGit();
    const tree = await runKeeperWriteTree("/repo", { git });
    expect(tree).toBe(TREE_OID);
    expect(git.calls.map((c) => c.sub)).toEqual(["add", "write-tree"]);
    expect(git.calls[0]!.args).toEqual(["-A"]); // captures the full working tree
  });

  test("a failing add aborts before write-tree", async () => {
    const git = fakeGit({ addExit: 1 });
    await expect(runKeeperWriteTree("/repo", { git })).rejects.toBeInstanceOf(KeeperGitError);
    expect(git.calls.map((c) => c.sub)).toEqual(["add"]); // no write-tree
  });

  test("a failing write-tree raises KeeperGitError", async () => {
    const git = fakeGit({ writeTreeExit: 1 });
    await expect(runKeeperWriteTree("/repo", { git })).rejects.toBeInstanceOf(KeeperGitError);
  });
});

describe("runKeeperCommitTree (GH-2381)", () => {
  const COMMIT_OID = "2222222222222222222222222222222222222222";
  const TREE = "3".repeat(40);
  const BASE = "4".repeat(40);

  function fakeGit(over: { commitExit?: number; switchExit?: number; switchStderr?: string } = {}): typeof execGit & {
    calls: Array<{ sub: string; args: string[]; env?: Record<string, string | undefined> | undefined }>;
  } {
    const calls: Array<{ sub: string; args: string[]; env?: Record<string, string | undefined> | undefined }> = [];
    const fn = ((opts: GitExecOptions, env?: Record<string, string | undefined>): GitExecResult => {
      calls.push({ sub: opts.subcommand, args: opts.args, env });
      if (opts.subcommand === "commit-tree") {
        return {
          exitCode: over.commitExit ?? 0,
          stdout: over.commitExit ? "" : `${COMMIT_OID}\n`,
          stderr: over.commitExit ? "commit-tree boom" : "",
          policy: null,
        };
      }
      if (opts.subcommand === "switch") {
        return {
          exitCode: over.switchExit ?? 0,
          stdout: "",
          stderr: over.switchStderr ?? "switch boom",
          policy: null,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", policy: null };
    }) as typeof execGit & {
      calls: Array<{ sub: string; args: string[]; env?: Record<string, string | undefined> | undefined }>;
    };
    fn.calls = calls;
    return fn;
  }

  const input = {
    treeSha: TREE,
    parentSha: BASE,
    message: "feat: x\n\nGH-2381",
    date: "2026-05-26T00:00:00.000Z",
    branch: "GH-2381",
  };

  test("commit-trees with pinned dates, then switches the branch to HEAD", async () => {
    const git = fakeGit();
    const commit = await runKeeperCommitTree(input, "/repo", { git });
    expect(commit).toBe(COMMIT_OID);
    expect(git.calls.map((c) => c.sub)).toEqual(["commit-tree", "switch"]);
    // commit-tree args wrap the tree on the base parent with the message.
    expect(git.calls[0]!.args).toEqual([TREE, "-p", BASE, "-m", input.message]);
    // Author + committer dates are pinned for a reproducible commit SHA.
    expect(git.calls[0]!.env?.GIT_AUTHOR_DATE).toBe(input.date);
    expect(git.calls[0]!.env?.GIT_COMMITTER_DATE).toBe(input.date);
    // The derived branch is reset to the materialized commit and checked out.
    expect(git.calls[1]!.args).toEqual(["-C", "GH-2381", COMMIT_OID]);
  });

  test("a failing commit-tree aborts before the branch switch", async () => {
    const git = fakeGit({ commitExit: 1 });
    await expect(runKeeperCommitTree(input, "/repo", { git })).rejects.toBeInstanceOf(KeeperGitError);
    expect(git.calls.map((c) => c.sub)).toEqual(["commit-tree"]);
  });

  test("a failing switch raises KeeperGitError", async () => {
    const git = fakeGit({ switchExit: 1 });
    await expect(runKeeperCommitTree(input, "/repo", { git })).rejects.toBeInstanceOf(KeeperGitError);
  });

  // prx-5l3: when the branch is checked out in another worktree, git refuses the
  // switch. Surface a clean ownership error naming the holding worktree instead
  // of the raw `is already used by worktree` failure.
  test("a cross-worktree branch collision raises an actionable ownership error", async () => {
    const git = fakeGit({
      switchExit: 128,
      switchStderr: "fatal: 'GH-2381' is already used by worktree at '/wt/GH-2381'",
    });
    await expect(runKeeperCommitTree(input, "/repo", { git })).rejects.toThrow(
      /checked out in another worktree \(\/wt\/GH-2381\).*Run keeper \/ publish from that worktree/s,
    );
  });
});

// End-to-end determinism on a real repo: the same working state hashes to the
// same tree, and the same (tree, base, message, pinned date) yields the same
// commit SHA across runs.
describe("keeper materialization determinism (GH-2381, real repo)", () => {
  test("write-tree is content-addressed; commit-tree is reproducible with pinned dates", async () => {
    const repo = mkdtempSync(join(tmpdir(), "prx-keeper-tree-"));
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    // Hermetic against ambient git config (the user's global hooks/signing) so
    // the base `git commit` can never block on a hook or a GPG prompt.
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();

    // An uncommitted edit (the headless implement scenario).
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");

    const tree1 = await runKeeperWriteTree(repo);
    const tree2 = await runKeeperWriteTree(repo);
    expect(tree1).toMatch(/^[0-9a-f]{40}$/);
    expect(tree2).toBe(tree1); // same working state → same tree

    const input = {
      treeSha: tree1,
      parentSha: baseSha,
      message: "feat: headless\n\nGH-2381",
      date: "2026-05-26T00:00:00.000Z",
      branch: "GH-2381",
    };
    const commit1 = await runKeeperCommitTree(input, repo);
    const commit2 = await runKeeperCommitTree(input, repo);
    expect(commit1).toMatch(/^[0-9a-f]{40}$/);
    expect(commit2).toBe(commit1); // pinned dates → reproducible commit SHA
    // The derived branch was checked out at the materialized commit (= HEAD).
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(commit1);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("GH-2381");
  }, 30_000);
});
