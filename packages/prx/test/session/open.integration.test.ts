/**
 * GH-2271 / ai-home-rkg1w.4 — session-open on-disk regression gate.
 *
 * The GH-2258 unit suite is green against a broken on-disk shape because
 * `runReserve` / `runMaterialize` / `runPrepare` are stubbed there. This
 * test drives `openSession({ actor: "intake" })` against a *real git*
 * fixture with the production reserve → materialize → prepare path (only
 * the Claude dispatch + audit sink are stubbed) and asserts the shape the
 * stubs could never catch:
 *
 *   1. the worktree directory actually exists on disk at the expected
 *      sibling path (`dirname(mainx)/intake/<yyyymmdd>-<short>`);
 *   2. it is checked out on the session branch (not detached, not mainx);
 *   3. the returned `worktree_path` is that path and the ledger reached
 *      `state: "prepared"` with the real path;
 *   4. **no branch was pushed to the origin remote** (§3.5 — ephemeral
 *      sessions stay local-only).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openSession } from "../../src/session/open.ts";
import type { RuntimeProfileProjection } from "../../src/machine/runtime_profiles.ts";

function git(cwd: string, args: string[]): string {
  // `-c commit.gpgsign=false` keeps these temp-repo commits hermetic: without
  // it, a developer with `commit.gpgsign=true` (e.g. SSH signing) hangs the
  // seed commit on a signing prompt, timing out the beforeAll hook. Harmless
  // for non-commit git subcommands.
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

describe("openSession — real-git on-disk shape (intake)", () => {
  let root: string;
  let originBare: string;
  let mainx: string;
  const branch = "intake/20260526-abc123";

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "prx-opensession-int-")));

    // Upstream bare "origin" with one commit on main.
    const seed = join(root, "seed");
    spawnSync("git", ["init", "--initial-branch=main", seed], { encoding: "utf8" });
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);

    originBare = join(root, "origin.git");
    git(seed, ["clone", "--bare", seed, originBare]);
    // GitHub-shaped origin URL so resolveWorkspaceContext recognizes the repo.
    git(originBare, ["remote", "add", "github", "git@github.com:test-owner/test-repo.git"]);

    // The "mainx" working clone openSession is invoked from. Cloning sets
    // up origin/main, so reserve's local-only branch create resolves.
    mainx = join(root, "mainx");
    git(root, ["clone", originBare, mainx]);
    git(mainx, ["config", "user.email", "test@example.com"]);
    git(mainx, ["config", "user.name", "Test"]);
    git(mainx, ["remote", "set-url", "origin", "git@github.com:test-owner/test-repo.git"]);
    // Re-point the fetch remote at the on-disk bare so any fetch stays local;
    // keep a GitHub URL identity for slug parsing via a second remote name.
    git(mainx, ["remote", "add", "ondisk", originBare]);
    git(mainx, ["fetch", "ondisk"]);
    // Ensure origin/main resolves to the on-disk tip without network.
    git(mainx, ["update-ref", "refs/remotes/origin/main", "ondisk/main"]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("materializes a sibling worktree, checks out the branch, and never pushes", async () => {
    const events: string[] = [];
    let currentCwd = mainx;

    const result = await openSession(
      { actor: "intake", shortId: "abc123", now: "2026-05-26T00:00:00Z" },
      {
        // Real reserve/materialize/prepare; only dispatch + audit sink stubbed.
        dispatchSessionEntry: () => ({ profile: "intake" }) as unknown as RuntimeProfileProjection,
        recordEvent: ((event: string) => {
          events.push(event);
        }) as never,
        // chdir/cwd seam: no real process.chdir; prepare resolves against
        // the materialized worktree because it is a real git worktree.
        chdir: (p: string) => {
          currentCwd = p;
        },
        cwd: () => currentCwd,
      },
    );

    const expectedPath = join(dirname(mainx), branch);

    // 1. opened end-to-end.
    expect(result.status).toBe("opened");
    expect(result.branch_ref).toBe(branch);
    expect(result.lifecycle).toBe("materialized");

    // 2. worktree exists on disk at the expected sibling path.
    expect(result.worktree_path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // 3. checked out on the session branch (not detached, not mainx).
    expect(git(expectedPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
    expect(expectedPath).not.toBe(mainx);

    // 4. ledger reached prepared with the authoritative path.
    const wsDir = join(mainx, ".git", "info", "workspace");
    const ledgerFiles = readdirSync(wsDir).filter((f) => f.endsWith(".json"));
    expect(ledgerFiles.length).toBe(1);
    const ledger = JSON.parse(readFileSync(join(wsDir, ledgerFiles[0]!), "utf8")) as {
      state: string;
      worktree_path: string;
      branch: string;
    };
    expect(ledger.state).toBe("prepared");
    expect(ledger.worktree_path).toBe(expectedPath);
    expect(ledger.branch).toBe(branch);

    // 5. the materialize transition was emitted.
    expect(events).toContain("SESSION_OPEN_MATERIALIZED");

    // 6. NO branch was pushed to the origin remote (§3.5).
    const originRefs = git(originBare, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
    expect(originRefs).not.toContain("intake/");
  });
});
