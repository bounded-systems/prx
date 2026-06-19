// GH-1658 — `BdDomainAdapter` + `localWorkspacePrefixForCwd` integration:
// end-to-end roundtrip against a real tmpdir `.prx/repos/index.json` with
// two registered LocalRepo entries (one local, one foreign).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { BdDomainAdapter, ForeignWorkspacePrefixError } from "../../src/adapters/beads.ts";
import { localWorkspacePrefixForCwd, type RepoRunner } from "../../src/pr-state/repos.ts";

type IndexShape = {
  roots: string[];
  repos: Array<{
    name: string;
    commonDir: string;
    kind: "bare" | "standard";
    mainWorktree: string | null;
    worktrees: Array<{
      path: string;
      branch: string | null;
      current: boolean;
      kind: "standard" | "worktree";
    }>;
    localOnlyBranches: string[];
    findings: unknown[];
    remotes: unknown[];
    primaryRemote: unknown;
    upstreamRemote: unknown;
    bd_workspace_prefix?: string;
  }>;
};

function fixture(): {
  root: string;
  aiHomeWt: string;
  spdWt: string;
  unregisteredPath: string;
  runner: RepoRunner;
} {
  const root = mkdtempSync(join(tmpdir(), "gh-1658-bd-routing-"));
  const aiHomeBare = join(root, "bare", "ai-home.git");
  const spdBare = join(root, "bare", "demo-repo.git");
  const aiHomeWt = join(root, "wt", "ai-home", "main");
  const spdWt = join(root, "wt", "demo-repo", "main");
  const unregisteredPath = join(root, "elsewhere", "not-tracked");

  for (const path of [aiHomeBare, spdBare, aiHomeWt, spdWt, unregisteredPath]) {
    mkdirSync(path, { recursive: true });
  }

  const indexDir = join(root, ".prx", "repos");
  mkdirSync(indexDir, { recursive: true });
  const index: IndexShape = {
    roots: [root],
    repos: [
      {
        name: "ai-home",
        commonDir: aiHomeBare,
        kind: "bare",
        mainWorktree: null,
        worktrees: [{ path: aiHomeWt, branch: "main", current: false, kind: "worktree" }],
        localOnlyBranches: [],
        findings: [],
        remotes: [],
        primaryRemote: null,
        upstreamRemote: null,
        bd_workspace_prefix: "ai-home",
      },
      {
        name: "demo-repo",
        commonDir: spdBare,
        kind: "bare",
        mainWorktree: null,
        worktrees: [{ path: spdWt, branch: "main", current: false, kind: "worktree" }],
        localOnlyBranches: [],
        findings: [],
        remotes: [],
        primaryRemote: null,
        upstreamRemote: null,
        bd_workspace_prefix: "demo-repo",
      },
    ],
  };
  writeFileSync(join(indexDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  // Mock runner that responds to `git rev-parse --show-toplevel` by returning
  // `root` for every cwd under `root`, and "no" for everything else.
  // `localWorkspacePrefixForCwd` only invokes git via `loadRepoInventoryConfig`.
  const runner: RepoRunner = (cmd, options = {}) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "--show-toplevel") {
      const cwd = options.cwd ?? "";
      if (cwd === root || cwd.startsWith(`${root}/`)) {
        return { stdout: `${root}\n`, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "not a git repository", status: 128 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };

  return { root, aiHomeWt, spdWt, unregisteredPath, runner };
}

describe("localWorkspacePrefixForCwd — index-driven prefix lookup (GH-1658)", () => {
  test("worktree path under ai-home → 'ai-home'", () => {
    const { aiHomeWt, runner } = fixture();
    expect(localWorkspacePrefixForCwd(aiHomeWt, runner)).toBe("ai-home");
  });

  test("worktree path under demo-repo → 'demo-repo'", () => {
    const { spdWt, runner } = fixture();
    expect(localWorkspacePrefixForCwd(spdWt, runner)).toBe("demo-repo");
  });

  test("path inside the repo root but not covered by any LocalRepo → null", () => {
    const { unregisteredPath, runner } = fixture();
    expect(localWorkspacePrefixForCwd(unregisteredPath, runner)).toBeNull();
  });

  test("path outside any prx-managed root (no git toplevel) → null", () => {
    const { runner } = fixture();
    expect(localWorkspacePrefixForCwd("/tmp/definitely-not-prx-managed", runner)).toBeNull();
  });
});

describe("BdDomainAdapter end-to-end against the index (GH-1658)", () => {
  test("long-id from inside ai-home worktree resolves to the bare <prefix>-<tail>", () => {
    const { aiHomeWt, runner } = fixture();
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
    });
    expect(
      adapter.surfaceIdToExternalId("BD-ai-home-1778515181936-7-edba9d4a", {
        cwd: aiHomeWt,
      }),
    ).toBe("ai-home-1778515181936-7-edba9d4a");
  });

  test("foreign long-id (ai-home prefix from inside the spd worktree) throws ForeignWorkspacePrefixError", () => {
    const { spdWt, runner } = fixture();
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
    });
    let thrown: unknown = null;
    try {
      adapter.surfaceIdToExternalId("BD-ai-home-1778515181936-7-edba9d4a", {
        cwd: spdWt,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForeignWorkspacePrefixError);
    const err = thrown as ForeignWorkspacePrefixError;
    expect(err.embeddedPrefix).toBe("ai-home");
    expect(err.localPrefix).toBe("demo-repo");
  });

  test("long-id from outside any registered worktree throws with localPrefix null", () => {
    const { unregisteredPath, runner } = fixture();
    const adapter = new BdDomainAdapter({
      localWorkspacePrefix: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
    });
    let thrown: unknown = null;
    try {
      adapter.surfaceIdToExternalId("BD-ai-home-1778515181936-7-edba9d4a", {
        cwd: unregisteredPath,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForeignWorkspacePrefixError);
    expect((thrown as ForeignWorkspacePrefixError).localPrefix).toBeNull();
  });
});

// GH-2156 — bare workspace-long-id gate resolved from inside a managed
// worktree whose git-root has no cwd-local index. The index is discovered via
// the global config `indexPath`; the covering repo is matched via the cwd's
// git-common-dir (the bare repo path) rather than the empty `worktrees[]`
// array. This is the path `prx plan session <bare-id>` exercises, and the gap
// the GH-1766 stubs hide.
describe("BdDomainAdapter — bare workspace-long-id from a worktree (GH-2156)", () => {
  function fixture(): {
    spdWt: string;
    foreignWt: string;
    runner: RepoRunner;
    restoreHome: () => void;
  } {
    const root = mkdtempSync(join(tmpdir(), "gh-2156-bd-gate-"));
    const homeRoot = join(root, "home");
    // share/ (bare repos) vs state/ (worktrees) split — defeats the
    // commonDir-ancestor and worktree-path arms; only common-dir match works.
    const spdBare = join(root, "share", "bare", "demo-repo.git");
    const foreignBare = join(root, "share", "bare", "ai-home.git");
    const spdWt = join(root, "state", "wt", "demo-repo.git", "spd_aqg_3y3");
    const foreignWt = join(root, "state", "wt", "ai-home.git", "ai_home_xyz");
    for (const path of [spdBare, foreignBare, spdWt, foreignWt, join(homeRoot, ".config", "prx")]) {
      mkdirSync(path, { recursive: true });
    }

    const centralIndexPath = join(root, "central", ".prx", "repos", "index.json");
    mkdirSync(dirname(centralIndexPath), { recursive: true });
    const index: IndexShape = {
      roots: [join(root, "share", "bare")],
      repos: [
        {
          name: "demo-repo",
          commonDir: spdBare,
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
          bd_workspace_prefix: "demo-repo",
        },
        {
          name: "ai-home",
          commonDir: foreignBare,
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
          bd_workspace_prefix: "ai-home",
        },
      ],
    };
    writeFileSync(centralIndexPath, `${JSON.stringify(index, null, 2)}\n`);

    writeFileSync(
      join(homeRoot, ".config", "prx", "config.json"),
      JSON.stringify(
        { bareRoot: join(root, "share", "bare"), indexPath: centralIndexPath },
        null,
        2,
      ),
    );

    const commonByWt = new Map<string, string>([
      [spdWt, spdBare],
      [foreignWt, foreignBare],
    ]);
    const runner: RepoRunner = (cmd, options = {}) => {
      const cwd = options.cwd ?? "";
      if (cmd[1] === "rev-parse" && cmd[2] === "--show-toplevel") {
        if (commonByWt.has(cwd)) return { stdout: `${cwd}\n`, stderr: "", status: 0 };
        return { stdout: "", stderr: "not a git repository", status: 128 };
      }
      if (cmd[1] === "rev-parse" && cmd[2] === "--git-common-dir") {
        const bare = commonByWt.get(cwd);
        if (bare) return { stdout: `${bare}\n`, stderr: "", status: 0 };
        return { stdout: "", stderr: "not a git repository", status: 128 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };

    const previousHome = process.env.HOME;
    process.env.HOME = homeRoot;
    return {
      spdWt,
      foreignWt,
      runner,
      restoreHome: () => {
        process.env.HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  test("bare id whose prefix matches the cwd repo passes the canonical-id gate", () => {
    const { spdWt, runner, restoreHome } = fixture();
    try {
      const adapter = new BdDomainAdapter({
        cwd: () => spdWt,
        localWorkspacePrefix: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
      });
      // GH-1766 form `bd ready --json` emits — must be recognised as a surface id.
      expect(adapter.matchesSurfaceId("demo-repo-1778515181936-7-edba9d4a")).toBe(true);
      expect(adapter.matchesSurfaceId("demo-repo-pin.9.4.2")).toBe(true);
    } finally {
      restoreHome();
    }
  });

  test("bare id with a foreign prefix is refused from a covered cwd", () => {
    const { spdWt, runner, restoreHome } = fixture();
    try {
      const adapter = new BdDomainAdapter({
        cwd: () => spdWt,
        localWorkspacePrefix: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
      });
      // The cwd repo's prefix is demo-repo; an ai-home-prefixed bare
      // id is not local here, so the gate must not claim it.
      expect(adapter.matchesSurfaceId("ai-home-1778515181936-7-edba9d4a")).toBe(false);
    } finally {
      restoreHome();
    }
  });

  test("BD-<foreign-prefix> long id from a covered cwd throws ForeignWorkspacePrefixError", () => {
    const { spdWt, runner, restoreHome } = fixture();
    try {
      const adapter = new BdDomainAdapter({
        cwd: () => spdWt,
        localWorkspacePrefix: (cwd) => localWorkspacePrefixForCwd(cwd, runner),
      });
      let thrown: unknown = null;
      try {
        adapter.surfaceIdToExternalId("BD-ai-home-1778515181936-7-edba9d4a", { cwd: spdWt });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForeignWorkspacePrefixError);
      const err = thrown as ForeignWorkspacePrefixError;
      expect(err.embeddedPrefix).toBe("ai-home");
      expect(err.localPrefix).toBe("demo-repo");
    } finally {
      restoreHome();
    }
  });
});
