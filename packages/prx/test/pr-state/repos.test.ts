import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  addLocalRepo,
  discoverLocalRepos,
  findRepoBySlug,
  findRepoSubmodules,
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  localWorkspacePrefixForCwd,
  normalizeLocalRepos,
  parseRepoUrl,
  refreshLocalRepo,
  RepoAddError,
  repoCanonical,
  repoInventorySchema,
  repoStaleThresholdDays,
  rollbackRepoAdd,
  setRepoCanonical,
  setRepoStaleThresholdDays,
  writeRepoInventoryIndex,
  type LocalRepo,
  type RepoInventory,
} from "../../src/pr-state/repos.ts";

// A realistic-enough git dir fixture — walkForGitEntries's looksLikeGitDir
// pre-filter requires a HEAD file (deliberately the *only* thing it
// requires, to avoid false-negatives on unusual-but-real repos), so an
// empty mkdirSync(".git") fixture no longer reaches the mocked git
// rev-parse calls below.
function makeGitDir(gitDirPath: string): void {
  mkdirSync(gitDirPath, { recursive: true });
  writeFileSync(join(gitDirPath, "HEAD"), "ref: refs/heads/main\n");
}

describe("discoverLocalRepos", () => {
  test("groups standard and worktree repos by common dir", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-"));
    const standardRepo = join(root, "dev", "ai-home");
    const standardGitDir = join(standardRepo, ".git");
    makeGitDir(standardGitDir);

    const bareRepo = join(root, "bare", "demo-web.git");
    makeGitDir(bareRepo);

    const worktreeRepo = join(root, "worktrees", "demo-web", "GH-5431");
    mkdirSync(worktreeRepo, { recursive: true });
    writeFileSync(join(worktreeRepo, ".git"), "gitdir: /bare/demo-web.git/worktrees/GH-5431\n");

    const responses = new Map<string, { stdout: string; stderr: string; status: number }>([
      [
        `git rev-parse --show-toplevel|${standardRepo}`,
        { stdout: `${standardRepo}\n`, stderr: "", status: 0 },
      ],
      [
        `git rev-parse --git-common-dir|${standardRepo}`,
        { stdout: ".git\n", stderr: "", status: 0 },
      ],
      [`git branch --show-current|${standardRepo}`, { stdout: "main\n", stderr: "", status: 0 }],
      [
        `git for-each-ref --format=%(refname:short) refs/heads|${standardRepo}`,
        { stdout: "main\n", stderr: "", status: 0 },
      ],
      [`git remote|${standardRepo}`, { stdout: "origin\n", stderr: "", status: 0 }],
      [
        `git remote get-url origin|${standardRepo}`,
        { stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "", status: 0 },
      ],
      [
        `git rev-parse --show-toplevel|${worktreeRepo}`,
        { stdout: `${worktreeRepo}\n`, stderr: "", status: 0 },
      ],
      [
        `git rev-parse --git-common-dir|${worktreeRepo}`,
        { stdout: `${bareRepo}\n`, stderr: "", status: 0 },
      ],
      [`git branch --show-current|${worktreeRepo}`, { stdout: "GH-5431\n", stderr: "", status: 0 }],
      [
        `git for-each-ref --format=%(refname:short) refs/heads|${worktreeRepo}`,
        { stdout: "GH-5431\n", stderr: "", status: 0 },
      ],
      [`git remote|${worktreeRepo}`, { stdout: "origin\nupstream\n", stderr: "", status: 0 }],
      [
        `git remote get-url origin|${worktreeRepo}`,
        { stdout: "git@github.com:bdelanghe/demo-web.git\n", stderr: "", status: 0 },
      ],
      [
        `git remote get-url upstream|${worktreeRepo}`,
        { stdout: "git@github.com:demo/demo-web.git\n", stderr: "", status: 0 },
      ],
      [
        `git rev-parse --is-bare-repository|${bareRepo}`,
        { stdout: "true\n", stderr: "", status: 0 },
      ],
      [`git rev-parse --git-common-dir|${bareRepo}`, { stdout: ".\n", stderr: "", status: 0 }],
      [
        `git for-each-ref --format=%(refname:short) refs/heads|${bareRepo}`,
        { stdout: "GH-5431\n", stderr: "", status: 0 },
      ],
      [`git remote|${bareRepo}`, { stdout: "origin\nupstream\n", stderr: "", status: 0 }],
      [
        `git remote get-url origin|${bareRepo}`,
        { stdout: "git@github.com:bdelanghe/demo-web.git\n", stderr: "", status: 0 },
      ],
      [
        `git remote get-url upstream|${bareRepo}`,
        { stdout: "git@github.com:demo/demo-web.git\n", stderr: "", status: 0 },
      ],
    ]);

    const inventory = discoverLocalRepos(
      [join(root, "dev"), join(root, "bare"), join(root, "worktrees")],
      (cmd, options = {}) => {
        const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
        const response = responses.get(key);
        if (!response) {
          return { stdout: "", stderr: "missing", status: 1 };
        }
        return response;
      },
      worktreeRepo,
    );

    expect(inventory.repos).toMatchObject([
      {
        name: "ai-home",
        kind: "standard",
        commonDir: standardGitDir,
        mainWorktree: standardRepo,
        localOnlyBranches: [],
        findings: [
          {
            type: "standard_repo",
            message: "Standard repo exists outside the bare authority model.",
          },
        ],
        primaryRemote: {
          name: "origin",
          url: "git@github.com:bdelanghe/ai-home.git",
          githubRepo: "bdelanghe/ai-home",
        },
        worktrees: [{ path: standardRepo, branch: "main", current: false, kind: "standard" }],
      },
      {
        name: "demo-web",
        kind: "bare",
        localOnlyBranches: [],
        findings: [],
        primaryRemote: {
          name: "origin",
          url: "git@github.com:bdelanghe/demo-web.git",
          githubRepo: "bdelanghe/demo-web",
        },
        upstreamRemote: {
          name: "upstream",
          url: "git@github.com:demo/demo-web.git",
          githubRepo: "demo/demo-web",
        },
        worktrees: [{ path: worktreeRepo, branch: "GH-5431", current: true, kind: "worktree" }],
      },
    ]);
  });

  test("reports local branches that are not attached to a worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-local-"));
    const worktreeRepo = join(root, "dev", "ai-home");
    const worktreeGitDir = join(worktreeRepo, ".git");
    makeGitDir(worktreeGitDir);

    const responses = new Map<string, { stdout: string; stderr: string; status: number }>([
      [
        `git rev-parse --show-toplevel|${worktreeRepo}`,
        { stdout: `${worktreeRepo}\n`, stderr: "", status: 0 },
      ],
      [
        `git rev-parse --git-common-dir|${worktreeRepo}`,
        { stdout: ".git\n", stderr: "", status: 0 },
      ],
      [
        `git branch --show-current|${worktreeRepo}`,
        { stdout: "repox-local\n", stderr: "", status: 0 },
      ],
      [`git remote|${worktreeRepo}`, { stdout: "origin\n", stderr: "", status: 0 }],
      [
        `git remote get-url origin|${worktreeRepo}`,
        { stdout: "git@github.com:bdelanghe/ai-home.git\n", stderr: "", status: 0 },
      ],
      [
        `git for-each-ref --format=%(refname:lstrip=2) refs/heads|${worktreeRepo}`,
        { stdout: "main\nrepox-local\nstale-branch\n", stderr: "", status: 0 },
      ],
    ]);

    const inventory = discoverLocalRepos(
      [join(root, "dev")],
      (cmd, options = {}) => {
        const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
        const response = responses.get(key);
        if (!response) {
          return { stdout: "", stderr: "missing", status: 1 };
        }
        return response;
      },
      worktreeRepo,
    );

    expect(inventory.repos).toMatchObject([
      {
        name: "ai-home",
        localOnlyBranches: ["main", "stale-branch"],
        findings: [
          {
            type: "standard_repo",
            message: "Standard repo exists outside the bare authority model.",
          },
          {
            type: "orphan_branch",
            branch: "main",
            message: "Local-only branch main has no attached worktree.",
          },
          {
            type: "orphan_branch",
            branch: "stale-branch",
            message: "Local-only branch stale-branch has no attached worktree.",
          },
        ],
        primaryRemote: {
          name: "origin",
          url: "git@github.com:bdelanghe/ai-home.git",
          githubRepo: "bdelanghe/ai-home",
        },
        worktrees: [{ path: worktreeRepo, branch: "repox-local", current: true, kind: "standard" }],
      },
    ]);
  });

  test("uses lstrip branch names so attached main is not misclassified as heads/main", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-main-"));
    const bareRepo = join(root, "bare", "amz_sp_api.git");
    const worktreeRepo = join(root, "worktrees", "amz_sp_api", "main");
    makeGitDir(bareRepo);
    mkdirSync(worktreeRepo, { recursive: true });
    writeFileSync(join(worktreeRepo, ".git"), `gitdir: ${bareRepo}/worktrees/main\n`);

    const responses = new Map<string, { stdout: string; stderr: string; status: number }>([
      [
        `git rev-parse --show-toplevel|${worktreeRepo}`,
        { stdout: `${worktreeRepo}\n`, stderr: "", status: 0 },
      ],
      [
        `git rev-parse --git-common-dir|${worktreeRepo}`,
        { stdout: `${bareRepo}\n`, stderr: "", status: 0 },
      ],
      [`git branch --show-current|${worktreeRepo}`, { stdout: "main\n", stderr: "", status: 0 }],
      [
        `git for-each-ref --format=%(refname:lstrip=2) refs/heads|${worktreeRepo}`,
        { stdout: "main\nclean-up\n", stderr: "", status: 0 },
      ],
      [`git remote|${worktreeRepo}`, { stdout: "origin\n", stderr: "", status: 0 }],
      [
        `git remote get-url origin|${worktreeRepo}`,
        { stdout: "git@github.com:bdelanghe/amz_sp_api.git\n", stderr: "", status: 0 },
      ],
      [
        `git rev-parse --is-bare-repository|${bareRepo}`,
        { stdout: "true\n", stderr: "", status: 0 },
      ],
      [`git rev-parse --git-common-dir|${bareRepo}`, { stdout: ".\n", stderr: "", status: 0 }],
      [
        `git for-each-ref --format=%(refname:lstrip=2) refs/heads|${bareRepo}`,
        { stdout: "main\nclean-up\n", stderr: "", status: 0 },
      ],
      [`git remote|${bareRepo}`, { stdout: "origin\n", stderr: "", status: 0 }],
      [
        `git remote get-url origin|${bareRepo}`,
        { stdout: "git@github.com:bdelanghe/amz_sp_api.git\n", stderr: "", status: 0 },
      ],
    ]);

    const inventory = discoverLocalRepos(
      [join(root, "bare"), join(root, "worktrees")],
      (cmd, options = {}) =>
        responses.get(`${cmd.join(" ")}|${options.cwd ?? ""}`) ?? {
          stdout: "",
          stderr: "missing",
          status: 1,
        },
      worktreeRepo,
    );

    expect(inventory.repos[0]).toMatchObject({
      name: "amz_sp_api",
      localOnlyBranches: ["clean-up"],
      findings: [
        {
          type: "orphan_branch",
          branch: "clean-up",
          message: "Local-only branch clean-up has no attached worktree.",
        },
      ],
    });
  });

  test("skips .tmp directories so bun-test fixtures are not enumerated", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-tmp-skip-"));
    const realRepo = join(root, "dev", "ai-home");
    makeGitDir(join(realRepo, ".git"));
    const fixtureRepo = join(root, ".tmp", "bun-tests", "pr-state-foo");
    makeGitDir(join(fixtureRepo, ".git"));

    const calls: string[] = [];
    const inventory = discoverLocalRepos(
      [root],
      (cmd, options = {}) => {
        calls.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
        return { stdout: "", stderr: "missing", status: 1 };
      },
      realRepo,
    );

    expect(inventory.repos.every((r) => !r.commonDir.includes(fixtureRepo))).toBe(true);
    expect(calls.every((c) => !c.includes(fixtureRepo))).toBe(true);
  });

  test("scans a HOME root at depth 1 only — catches stray top-level clones, not grandchildren", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-home-depth-"));
    const homeDir = join(root, "home");
    const strayRepo = join(homeDir, "prx");
    makeGitDir(join(strayRepo, ".git"));
    const deepRepo = join(homeDir, "dev", "nested", "deep-repo");
    makeGitDir(join(deepRepo, ".git"));

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const responses = new Map<string, { stdout: string; stderr: string; status: number }>([
        [
          `git rev-parse --show-toplevel|${strayRepo}`,
          { stdout: `${strayRepo}\n`, stderr: "", status: 0 },
        ],
        [`git rev-parse --git-common-dir|${strayRepo}`, { stdout: ".git\n", stderr: "", status: 0 }],
      ]);
      const inventory = discoverLocalRepos(
        [homeDir],
        (cmd, options = {}) =>
          responses.get(`${cmd.join(" ")}|${options.cwd ?? ""}`) ?? {
            stdout: "",
            stderr: "missing",
            status: 1,
          },
        strayRepo,
      );
      const commonDirs = inventory.repos.map((r) => r.commonDir);
      expect(commonDirs.some((d) => d.startsWith(strayRepo))).toBe(true);
      expect(commonDirs.some((d) => d.startsWith(deepRepo))).toBe(false);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("skips a root that throws on readdir (e.g. EPERM on ~/.Trash) instead of crashing the whole scan", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-eperm-"));
    const realRepo = join(root, "dev", "ai-home");
    makeGitDir(join(realRepo, ".git"));
    const lockedDir = join(root, "locked");
    mkdirSync(lockedDir, { recursive: true });
    chmodSync(lockedDir, 0o000);

    try {
      const responses = new Map<string, { stdout: string; stderr: string; status: number }>([
        [
          `git rev-parse --show-toplevel|${realRepo}`,
          { stdout: `${realRepo}\n`, stderr: "", status: 0 },
        ],
        [`git rev-parse --git-common-dir|${realRepo}`, { stdout: ".git\n", stderr: "", status: 0 }],
      ]);
      const inventory = discoverLocalRepos(
        [root],
        (cmd, options = {}) =>
          responses.get(`${cmd.join(" ")}|${options.cwd ?? ""}`) ?? {
            stdout: "",
            stderr: "missing",
            status: 1,
          },
        realRepo,
      );
      expect(inventory.repos.some((r) => r.commonDir.startsWith(realRepo))).toBe(true);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  test("pre-filters an obvious non-repo .git-suffixed dir without spawning git rev-parse", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-fakegit-"));
    // Not a real git dir: no HEAD file, just a name that happens to match.
    mkdirSync(join(root, "not-a-repo.git"), { recursive: true });
    writeFileSync(join(root, "not-a-repo.git", "README.md"), "just a folder\n");
    // Not a real linked-worktree gitfile: a plain dotfile that happens to be
    // named ".git" but doesn't start with "gitdir:" (e.g. .envrc.git-style).
    mkdirSync(join(root, "stray-file-repo"), { recursive: true });
    writeFileSync(join(root, "stray-file-repo", ".git"), "not a real gitfile\n");

    const calls: string[] = [];
    const inventory = discoverLocalRepos(
      [root],
      (cmd, options = {}) => {
        calls.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
        return { stdout: "", stderr: "missing", status: 1 };
      },
      root,
    );

    expect(inventory.repos).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("does not false-negative on a real git dir with only HEAD (e.g. reftable ref storage, no refs/ tree)", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-minimal-git-"));
    const repoPath = join(root, "minimal-repo.git");
    // Deliberately minimal: only HEAD, no objects/ or refs/ — must still be
    // treated as a real candidate and handed to the downstream git rev-parse
    // check, not silently dropped by the pre-filter.
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "HEAD"), "ref: refs/heads/main\n");

    const responses = new Map<string, { stdout: string; stderr: string; status: number }>([
      [`git rev-parse --is-bare-repository|${repoPath}`, { stdout: "true\n", stderr: "", status: 0 }],
      [
        `git rev-parse --git-common-dir|${repoPath}`,
        { stdout: `${repoPath}\n`, stderr: "", status: 0 },
      ],
    ]);
    const inventory = discoverLocalRepos(
      [root],
      (cmd, options = {}) =>
        responses.get(`${cmd.join(" ")}|${options.cwd ?? ""}`) ?? {
          stdout: "",
          stderr: "missing",
          status: 1,
        },
      root,
    );

    expect(inventory.repos.some((r) => r.commonDir === repoPath)).toBe(true);
  });

  test("loads repo inventory config and writes an index", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-config-"));
    const repoRoot = join(root, "ai-home");
    makeGitDir(join(repoRoot, ".git"));
    mkdirSync(join(repoRoot, ".prx", "repos"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".prx", "repos", "config.json"),
      JSON.stringify(
        {
          bareRoot: "/tmp/bare-repos",
          roots: ["/tmp/bare-repos", "/tmp/worktrees"],
          everywhereRoots: ["/tmp/bare-repos", "/tmp/worktrees", "/tmp/dev"],
        },
        null,
        2,
      ),
    );

    // Isolate HOME (and XDG) to the empty fixture root so the operator's real
    // ~/.config/prx/config.json + ~/.local/state/prx index don't override the
    // repo-local config under test (the repo-local path must win here).
    const prevHome = process.env.HOME;
    const prevCfg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    process.env.HOME = root;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      const config = loadRepoInventoryConfig(repoRoot, (cmd, options = {}) => {
        const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
        if (key === `git rev-parse --show-toplevel|${repoRoot}`) {
          return { stdout: `${repoRoot}\n`, stderr: "", status: 0 };
        }
        return { stdout: "", stderr: "missing", status: 1 };
      });

      expect(config).toMatchObject({
        repoRoot,
        bareRoot: "/tmp/bare-repos",
        roots: ["/tmp/bare-repos", "/tmp/worktrees"],
        everywhereRoots: ["/tmp/bare-repos", "/tmp/worktrees", "/tmp/dev"],
        configPath: join(repoRoot, ".prx", "repos", "config.json"),
        indexPath: join(repoRoot, ".prx", "repos", "index.json"),
      });

      writeRepoInventoryIndex(config.indexPath!, {
        roots: config.roots,
        bareRoot: config.bareRoot,
        indexPath: config.indexPath,
        repos: [],
        generatedAt: "2026-03-20T00:00:00.000Z",
      });

      expect(existsSync(config.indexPath!)).toBe(true);
      expect(JSON.parse(readFileSync(config.indexPath!, "utf8"))).toMatchObject({
        bareRoot: "/tmp/bare-repos",
        roots: ["/tmp/bare-repos", "/tmp/worktrees"],
        repos: [],
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevCfg;
      if (prevState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevState;
    }
  });

  test("loads global config when repo-local config is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-global-config-"));
    const repoRoot = join(root, "ai-home");
    const homeRoot = join(root, "home");
    makeGitDir(join(repoRoot, ".git"));
    mkdirSync(join(homeRoot, ".config", "prx"), { recursive: true });
    writeFileSync(
      join(homeRoot, ".config", "prx", "config.json"),
      JSON.stringify(
        {
          bareRoot: "/tmp/global-bare",
          roots: ["/tmp/global-bare"],
          everywhereRoots: ["/tmp/global-bare", "/tmp/global-workspaces"],
        },
        null,
        2,
      ),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = homeRoot;
    try {
      const config = loadRepoInventoryConfig(repoRoot, (cmd, options = {}) => {
        const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
        if (key === `git rev-parse --show-toplevel|${repoRoot}`) {
          return { stdout: `${repoRoot}\n`, stderr: "", status: 0 };
        }
        return { stdout: "", stderr: "missing", status: 1 };
      });

      expect(config).toMatchObject({
        repoRoot,
        bareRoot: "/tmp/global-bare",
        roots: ["/tmp/global-bare"],
        everywhereRoots: ["/tmp/global-bare", "/tmp/global-workspaces"],
        globalConfigPath: join(homeRoot, ".config", "prx", "config.json"),
        configPath: join(repoRoot, ".prx", "repos", "config.json"),
        indexPath: join(repoRoot, ".prx", "repos", "index.json"),
      });
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("derives default repo roots from HOME when no config exists", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-home-defaults-"));
    const repoRoot = join(root, "ai-home");
    const homeRoot = join(root, "home");
    makeGitDir(join(repoRoot, ".git"));

    const previousHome = process.env.HOME;
    process.env.HOME = homeRoot;
    try {
      const config = loadRepoInventoryConfig(repoRoot, (cmd, options = {}) => {
        const key = `${cmd.join(" ")}|${options.cwd ?? ""}`;
        if (key === `git rev-parse --show-toplevel|${repoRoot}`) {
          return { stdout: `${repoRoot}\n`, stderr: "", status: 0 };
        }
        return { stdout: "", stderr: "missing", status: 1 };
      });

      expect(config).toMatchObject({
        bareRoot: join(homeRoot, ".local", "share", "git", "bare"),
        roots: [join(homeRoot, ".local", "share", "git", "bare")],
        everywhereRoots: [
          join(homeRoot, ".local", "share", "git", "bare"),
          join(homeRoot, ".local", "share"),
          join(homeRoot, ".local", "state", "wt", "worktrees"),
          join(homeRoot, ".local", "state", "git", "worktrees"),
          join(homeRoot, "dev"),
          join(homeRoot, "src"),
          homeRoot,
        ],
      });
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("normalizeLocalRepos plans canonical bare creation, orphan branch deletion, and standard repo detachment", () => {
    const inventory = {
      roots: ["/tmp/bare"],
      bareRoot: "/tmp/bare",
      repos: [
        {
          name: "example-percy-ruby-selenium",
          kind: "standard" as const,
          commonDir: "/tmp/workspaces/example/.git",
          mainWorktree: "/tmp/workspaces/example",
          worktrees: [
            {
              path: "/tmp/workspaces/example",
              branch: "percy-integration",
              current: false,
              kind: "standard" as const,
            },
          ],
          localOnlyBranches: ["master"],
          findings: [
            {
              type: "standard_repo" as const,
              message: "Standard repo exists outside the bare authority model.",
            },
            {
              type: "orphan_branch" as const,
              branch: "master",
              message: "Local-only branch master has no attached worktree.",
            },
          ],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:percy/example-percy-ruby-selenium.git",
            githubRepo: "percy/example-percy-ruby-selenium",
          },
          upstreamRemote: null,
        },
      ],
    };

    const result = normalizeLocalRepos(inventory);

    expect(result.apply).toBe(false);
    expect(result.repos).toMatchObject([
      {
        name: "example-percy-ruby-selenium",
        kind: "standard",
        canonicalBarePath: "/tmp/bare/io.github/percy/example-percy-ruby-selenium.git",
        actions: [
          { type: "delete_orphan_branch", branch: "master" },
          {
            type: "create_canonical_bare",
            path: "/tmp/bare/io.github/percy/example-percy-ruby-selenium.git",
          },
          { type: "detach_standard_git_dir", path: "/tmp/workspaces/example/.git" },
        ],
      },
    ]);
  });

  test("normalizeLocalRepos applies orphan deletions and detaches standard repo authority", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-normalize-"));
    const standardRepo = join(root, "workspaces", "lone");
    const gitDir = join(standardRepo, ".git");
    const canonicalBare = join(root, "bare", "io.github", "bdelanghe", "lone.git");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(canonicalBare, { recursive: true });

    const commands: string[] = [];
    const inventory = {
      roots: [join(root, "bare")],
      bareRoot: join(root, "bare"),
      repos: [
        {
          name: "lone",
          kind: "standard" as const,
          commonDir: gitDir,
          mainWorktree: standardRepo,
          worktrees: [
            { path: standardRepo, branch: "main", current: false, kind: "standard" as const },
          ],
          localOnlyBranches: ["beads-sync"],
          findings: [
            {
              type: "standard_repo" as const,
              message: "Standard repo exists outside the bare authority model.",
            },
            {
              type: "duplicate_repo_forms" as const,
              message: "Repo exists in multiple local forms (for example bare + standard).",
            },
            {
              type: "orphan_branch" as const,
              branch: "beads-sync",
              message: "Local-only branch beads-sync has no attached worktree.",
            },
          ],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:bdelanghe/lone.git",
            githubRepo: "bdelanghe/lone",
          },
          upstreamRemote: null,
        },
      ],
    };

    const result = normalizeLocalRepos(inventory, { apply: true }, (cmd, options = {}) => {
      commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(result.apply).toBe(true);
    expect(commands).toEqual([`git branch -D beads-sync|${standardRepo}`]);
    expect(existsSync(gitDir)).toBe(false);
    expect(existsSync(`${gitDir}.prx-backup`)).toBe(true);
  });

  test("normalizeLocalRepos falls back to update-ref deletion for ambiguous branch names", () => {
    const inventory = {
      roots: ["/tmp/bare"],
      bareRoot: "/tmp/bare",
      repos: [
        {
          name: "amz_sp_api",
          kind: "bare" as const,
          commonDir: "/tmp/bare/amz_sp_api.git",
          mainWorktree: null,
          worktrees: [
            {
              path: "/tmp/worktrees/amz/main",
              branch: "main",
              current: false,
              kind: "worktree" as const,
            },
          ],
          localOnlyBranches: ["heads/main"],
          findings: [
            {
              type: "orphan_branch" as const,
              branch: "heads/main",
              message: "Local-only branch heads/main has no attached worktree.",
            },
          ],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:bdelanghe/amz_sp_api.git",
            githubRepo: "bdelanghe/amz_sp_api",
          },
          upstreamRemote: null,
        },
      ],
    };
    const commands: string[] = [];

    normalizeLocalRepos(inventory, { apply: true }, (cmd, options = {}) => {
      commands.push(
        `${cmd.join(" ")}|${options.cwd ?? ""}|${options.check === false ? "nocheck" : "check"}`,
      );
      if (cmd[0] === "git" && cmd[1] === "branch") {
        return { stdout: "", stderr: "error: branch 'heads/main' not found\n", status: 1 };
      }
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(commands).toEqual([
      "git branch -D heads/main|/tmp/worktrees/amz/main|nocheck",
      "git update-ref -d refs/heads/heads/main|/tmp/worktrees/amz/main|nocheck",
    ]);
  });

  test("normalizeLocalRepos creates an attached worktree for a single-branch bare repo", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-materialize-"));
    const bareRepo = join(root, "bare", "io.github", "percy", "example-percy-ruby-selenium.git");
    mkdirSync(bareRepo, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    const commands: string[] = [];

    try {
      const result = normalizeLocalRepos(
        {
          roots: [join(root, "bare")],
          bareRoot: join(root, "bare"),
          repos: [
            {
              name: "example-percy-ruby-selenium",
              kind: "bare",
              commonDir: bareRepo,
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: ["percy-integration"],
              findings: [
                {
                  type: "no_attached_worktree",
                  message: "Bare repo has no attached worktrees in the current scan scope.",
                },
                {
                  type: "orphan_branch",
                  branch: "percy-integration",
                  message: "Local-only branch percy-integration has no attached worktree.",
                },
              ],
              remotes: [],
              primaryRemote: {
                name: "origin",
                url: "git@github.com:percy/example-percy-ruby-selenium.git",
                githubRepo: "percy/example-percy-ruby-selenium",
              },
              upstreamRemote: null,
            },
          ],
        },
        { apply: true },
        (cmd, options = {}) => {
          commands.push(`${cmd.join(" ")}|${options.cwd ?? ""}`);
          return { stdout: "", stderr: "", status: 0 };
        },
      );

      expect(result.repos).toMatchObject([
        {
          name: "example-percy-ruby-selenium",
          actions: [
            {
              type: "create_attached_worktree",
              branch: "percy-integration",
              path: join(
                root,
                ".local",
                "state",
                "git",
                "worktrees",
                "io.github",
                "percy",
                "example-percy-ruby-selenium",
                "percy-integration",
              ),
            },
            {
              type: "report_no_attached_worktree",
            },
          ],
        },
      ]);
      expect(commands).toEqual([
        `git worktree add ${join(root, ".local", "state", "git", "worktrees", "io.github", "percy", "example-percy-ruby-selenium", "percy-integration")} percy-integration|${bareRepo}`,
      ]);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("bare repo with no worktrees and no local branches does not report no_attached_worktree", () => {
    const inventory = {
      roots: ["/tmp/bare"],
      repos: [
        {
          name: "selling-partner-api-models",
          kind: "bare" as const,
          commonDir: "/tmp/bare/selling-partner-api-models.git",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:amzn/selling-partner-api-models.git",
            githubRepo: "amzn/selling-partner-api-models",
          },
          upstreamRemote: null,
        },
      ],
      generatedAt: "2026-03-20T00:00:00.000Z",
    };

    const result = normalizeLocalRepos(inventory);
    expect(result.repos).toHaveLength(0);
  });
});

describe("findRepoSubmodules", () => {
  test("reports .gitmodules entries per worktree, and nothing for a repo without one", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repos-submodules-"));
    const withSubmodule = join(root, "site");
    mkdirSync(withSubmodule, { recursive: true });
    writeFileSync(
      join(withSubmodule, ".gitmodules"),
      [
        '[submodule "brand"]',
        "\tpath = brand",
        "\turl = https://github.com/bounded-systems/brand.git",
        "\tbranch = main",
      ].join("\n"),
    );
    const withoutSubmodule = join(root, "cv");
    mkdirSync(withoutSubmodule, { recursive: true });

    const inventory: RepoInventory = {
      roots: [root],
      repos: [
        {
          name: "site",
          commonDir: join(withSubmodule, ".git"),
          kind: "standard",
          mainWorktree: withSubmodule,
          worktrees: [{ path: withSubmodule, branch: "main", current: false, kind: "standard" }],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
        },
        {
          name: "cv",
          commonDir: join(withoutSubmodule, ".git"),
          kind: "standard",
          mainWorktree: withoutSubmodule,
          worktrees: [
            { path: withoutSubmodule, branch: "main", current: false, kind: "standard" },
          ],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
        },
      ],
    };

    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
      if (
        cmd[0] === "git" &&
        cmd[1] === "config" &&
        cmd[2] === "--file" &&
        cmd[3] === join(withSubmodule, ".gitmodules")
      ) {
        return {
          stdout: [
            "submodule.brand.path=brand",
            "submodule.brand.url=https://github.com/bounded-systems/brand.git",
            "submodule.brand.branch=main",
          ].join("\n"),
          stderr: "",
          status: 0,
        };
      }
      return { stdout: "", stderr: `unmocked: ${cmd.join(" ")}|${options.cwd ?? ""}`, status: 1 };
    };

    const findings = findRepoSubmodules(inventory, runner);
    expect(findings).toEqual([
      {
        repoName: "site",
        commonDir: join(withSubmodule, ".git"),
        worktreePath: withSubmodule,
        submodules: [
          {
            name: "brand",
            path: "brand",
            url: "https://github.com/bounded-systems/brand.git",
          },
        ],
      },
    ]);
  });
});

describe("parseRepoUrl", () => {
  test.each([
    ["git@github.com:owner/repo.git", { host: "github.com", owner: "owner", name: "repo" }],
    ["git@github.com:owner/repo", { host: "github.com", owner: "owner", name: "repo" }],
    ["https://github.com/owner/repo.git", { host: "github.com", owner: "owner", name: "repo" }],
    ["https://github.com/owner/repo", { host: "github.com", owner: "owner", name: "repo" }],
    [
      "git@gitlab.example.com:team/svc.git",
      { host: "gitlab.example.com", owner: "team", name: "svc" },
    ],
    ["https://github.com/owner/repo/", { host: "github.com", owner: "owner", name: "repo" }],
  ])("parses %s", (url, expected) => {
    const parsed = parseRepoUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe(expected.host);
    expect(parsed!.owner).toBe(expected.owner);
    expect(parsed!.name).toBe(expected.name);
    expect(parsed!.fetchUrl).toBe(url);
  });

  test.each([
    "",
    "not-a-url",
    "https://github.com/owner",
    "ftp://github.com/owner/repo",
  ])("rejects %s", (url) => {
    expect(parseRepoUrl(url)).toBeNull();
  });
});

describe("addLocalRepo", () => {
  type RunnerCall = { cmd: string[]; cwd?: string | undefined };

  function makeRunner(
    overrides: Map<string, { stdout?: string; stderr?: string; status?: number }> = new Map(),
  ): { runner: import("../../src/pr-state/repos.ts").RepoRunner; calls: RunnerCall[] } {
    const calls: RunnerCall[] = [];
    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
      calls.push({ cmd, cwd: options.cwd });
      // Simulate filesystem side effects so subsequent existsSync checks
      // (in addLocalRepo and downstream callers) reflect the cloned tree.
      if (cmd[0] === "git" && cmd[1] === "clone" && cmd[2] === "--bare") {
        mkdirSync(cmd[4]!, { recursive: true });
      }
      if (cmd[0] === "git" && cmd[3] === "worktree" && cmd[4] === "add" && cmd[5] === "--detach") {
        mkdirSync(cmd[6]!, { recursive: true });
      }
      const key = cmd.join(" ");
      const override = overrides.get(key);
      if (override) {
        return {
          stdout: override.stdout ?? "",
          stderr: override.stderr ?? "",
          status: override.status ?? 0,
        };
      }
      // GH-1657: default response for the bd workspace-prefix probe so the
      // pre-existing addLocalRepo tests keep working without re-stating the
      // value in every override map. Tests that exercise the probe directly
      // override this key explicitly.
      if (key === "bd config get database.workspace_prefix") {
        return { stdout: "ai-home\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    return { runner, calls };
  }

  test("happy path: clones, sets fetch refspec, fetches, resolves default branch, bootstraps detached mainx", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });

    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const expectedMainx = join(wtRoot, "io.github", "owner", "scratch", "mainx");

    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot: null,
        overlay: false,
      },
      runner,
    );

    expect(result.barePath).toBe(expectedBare);
    expect(result.mainxPath).toBe(expectedMainx);
    expect(result.defaultBranch).toBe("main");
    expect(result.fetchRefspecAdded).toBe(true);
    expect(result.overlay).toBeNull();
    expect(result.parsed.host).toBe("github.com");
    expect(result.parsed.owner).toBe("owner");
    expect(result.parsed.name).toBe("scratch");
    expect(result.bdWorkspacePrefix).toBe("ai-home");

    const cmdSequence = calls.map((call) => call.cmd.join(" "));
    expect(cmdSequence).toEqual([
      `git clone --bare git@github.com:owner/scratch.git ${expectedBare}`,
      `git -C ${expectedBare} config --add remote.origin.fetch +refs/heads/*:refs/remotes/origin/*`,
      `git -C ${expectedBare} config --add remote.origin.fetch +refs/tags/*:refs/tags/*`,
      `git -C ${expectedBare} config --add remote.origin.fetch +refs/notes/*:refs/notes/*`,
      `git -C ${expectedBare} fetch origin`,
      // GH-1751: persist origin/HEAD locally so subsequent
      // `resolveDefaultBranch` calls take the local-symref path.
      `git -C ${expectedBare} remote set-head origin --auto`,
      `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
      // GH-1736: probe `origin/<default>` between resolution and worktree-add
      // so a bare-clone-with-symref-but-no-fetch surfaces
      // `default_branch_unresolved` curated, not as raw stderr.
      `git -C ${expectedBare} rev-parse --verify origin/main`,
      `git -C ${expectedBare} worktree add --detach ${expectedMainx} origin/main`,
      "bd config get database.workspace_prefix",
    ]);
    expect(result.originHeadSet).toBe(true);
  });

  test("cross-owner same-name repos get distinct, non-colliding mainx paths", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-cross-owner-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });

    const expectedBareA = join(bareRoot, "io.github", "owner1", "deploy.git");
    const expectedMainxA = join(wtRoot, "io.github", "owner1", "deploy", "mainx");
    const expectedBareB = join(bareRoot, "io.github", "owner2", "deploy.git");
    const expectedMainxB = join(wtRoot, "io.github", "owner2", "deploy", "mainx");

    const { runner: runnerA } = makeRunner(
      new Map([
        [
          `git -C ${expectedBareA} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );
    const resultA = addLocalRepo(
      { url: "git@github.com:owner1/deploy.git", bareRoot, wtRoot, operatorConfigRoot: null, overlay: false },
      runnerA,
    );

    const { runner: runnerB } = makeRunner(
      new Map([
        [
          `git -C ${expectedBareB} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );
    const resultB = addLocalRepo(
      { url: "git@github.com:owner2/deploy.git", bareRoot, wtRoot, operatorConfigRoot: null, overlay: false },
      runnerB,
    );

    expect(resultA.mainxPath).toBe(expectedMainxA);
    expect(resultB.mainxPath).toBe(expectedMainxB);
    expect(resultA.mainxPath).not.toBe(resultB.mainxPath);
  });

  test("falls back to ls-remote when origin/HEAD symref is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-fallback-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });

    const expectedBare = join(bareRoot, "io.github", "owner", "legacy.git");

    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { status: 1, stderr: "no symref" },
        ],
        [
          `git -C ${expectedBare} ls-remote --symref origin HEAD`,
          { stdout: "ref: refs/heads/master\tHEAD\nabc123\tHEAD\n" },
        ],
      ]),
    );

    const result = addLocalRepo(
      {
        url: "https://github.com/owner/legacy.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot: null,
        overlay: false,
      },
      runner,
    );

    expect(result.defaultBranch).toBe("master");
  });

  test("refuses to clobber existing bare path", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-clobber-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    const existing = join(bareRoot, "io.github", "owner", "scratch.git");
    mkdirSync(existing, { recursive: true });

    const { runner } = makeRunner();

    expect(() =>
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
      ),
    ).toThrow(RepoAddError);
  });

  test("refuses to clobber existing mainx path", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-clobber-mainx-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(join(wtRoot, "io.github", "owner", "scratch", "mainx"), { recursive: true });

    const { runner } = makeRunner();

    expect(() =>
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
      ),
    ).toThrow(/mainx/);
  });

  test("rejects malformed URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-bad-url-"));
    const { runner } = makeRunner();

    expect(() =>
      addLocalRepo(
        {
          url: "not-a-git-url",
          bareRoot: join(root, "bare"),
          wtRoot: join(root, "wt"),
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
      ),
    ).toThrow(/parse git URL/);
  });

  test("--overlay scaffolds prx.toml stub at <operatorConfigRoot>/.prx/repos/io.<host>/<owner>/<name>/", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-overlay-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    const operatorConfigRoot = join(root, "ai-home");
    mkdirSync(operatorConfigRoot, { recursive: true });

    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot,
        overlay: true,
      },
      runner,
    );

    const expectedOverlay = join(
      operatorConfigRoot,
      ".prx",
      "repos",
      "io.github",
      "owner",
      "scratch",
      "prx.toml",
    );
    expect(result.overlay).toEqual({ path: expectedOverlay, written: true });
    expect(existsSync(expectedOverlay)).toBe(true);
    const body = readFileSync(expectedOverlay, "utf8");
    expect(body).toContain("[sources.");
    expect(body).toContain("owner/scratch");
  });

  test("--overlay leaves an existing prx.toml alone", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-overlay-keep-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    const operatorConfigRoot = join(root, "ai-home");

    const overlayDir = join(operatorConfigRoot, ".prx", "repos", "io.github", "owner", "scratch");
    mkdirSync(overlayDir, { recursive: true });
    const existingOverlay = join(overlayDir, "prx.toml");
    writeFileSync(existingOverlay, "# operator-authored content\n");

    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot,
        overlay: true,
      },
      runner,
    );

    expect(result.overlay).toEqual({
      path: existingOverlay,
      written: false,
      reason: "already_exists",
    });
    expect(readFileSync(existingOverlay, "utf8")).toBe("# operator-authored content\n");
  });

  test("--overlay without operatorConfigRoot fails fast", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-overlay-noroot-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");

    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );

    expect(() =>
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: true,
        },
        runner,
      ),
    ).toThrow(/operator config root/);
  });
});

// GH-1643: slug → bare-repo resolution used by `prx plan session --repo <slug>`.
// Resolution order: LocalRepo.name → primaryRemote.githubRepo (owner/name).
// Standard repos are filtered out — the registry is bare-only.
function makeBareRepo(
  overrides: Partial<LocalRepo> & Pick<LocalRepo, "name" | "commonDir">,
): LocalRepo {
  return {
    name: overrides.name,
    commonDir: overrides.commonDir,
    kind: overrides.kind ?? "bare",
    mainWorktree: overrides.mainWorktree ?? null,
    worktrees: overrides.worktrees ?? [],
    localOnlyBranches: overrides.localOnlyBranches ?? [],
    findings: overrides.findings ?? [],
    remotes: overrides.remotes ?? [],
    primaryRemote: overrides.primaryRemote ?? null,
    upstreamRemote: overrides.upstreamRemote ?? null,
  };
}

function makeInventory(repos: LocalRepo[]): RepoInventory {
  return { roots: [], repos };
}

describe("findRepoBySlug", () => {
  test("matches by LocalRepo.name", () => {
    const repo = makeBareRepo({
      name: "amz_sp_api",
      commonDir: "/bare/amz_sp_api.git",
      primaryRemote: {
        name: "origin",
        url: "git@github.com:bdelanghe/amz_sp_api.git",
        githubRepo: "bdelanghe/amz_sp_api",
      },
    });
    const result = findRepoBySlug(makeInventory([repo]), "amz_sp_api");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo.name).toBe("amz_sp_api");
    }
  });

  test("matches by primaryRemote.githubRepo (owner/name) when name doesn't match", () => {
    const repo = makeBareRepo({
      name: "demo-web",
      commonDir: "/bare/demo-web.git",
      primaryRemote: {
        name: "origin",
        url: "git@github.com:demo/demo-web.git",
        githubRepo: "demo/demo-web",
      },
    });
    const result = findRepoBySlug(makeInventory([repo]), "demo/demo-web");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo.commonDir).toBe("/bare/demo-web.git");
    }
  });

  test("returns not_registered when no match", () => {
    const repo = makeBareRepo({ name: "amz_sp_api", commonDir: "/bare/amz_sp_api.git" });
    const result = findRepoBySlug(makeInventory([repo]), "demo-repo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_registered");
      if (result.error.kind === "not_registered") {
        expect(result.error.slug).toBe("demo-repo");
      }
    }
  });

  test("returns ambiguous when slug matches two distinct bare repos", () => {
    const a = makeBareRepo({
      name: "duplicate",
      commonDir: "/bare/a/duplicate.git",
      primaryRemote: {
        name: "origin",
        url: "git@github.com:org-a/duplicate.git",
        githubRepo: "org-a/duplicate",
      },
    });
    const b = makeBareRepo({
      name: "duplicate",
      commonDir: "/bare/b/duplicate.git",
      primaryRemote: {
        name: "origin",
        url: "git@github.com:org-b/duplicate.git",
        githubRepo: "org-b/duplicate",
      },
    });
    const result = findRepoBySlug(makeInventory([a, b]), "duplicate");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("ambiguous");
      if (result.error.kind === "ambiguous") {
        expect(result.error.candidates.sort()).toEqual(["org-a/duplicate", "org-b/duplicate"]);
      }
    }
  });

  test("ignores standard repos so the registry remains bare-only", () => {
    const standard = makeBareRepo({
      name: "ai-home",
      commonDir: "/dev/ai-home/.git",
      kind: "standard",
      primaryRemote: {
        name: "origin",
        url: "git@github.com:bdelanghe/ai-home.git",
        githubRepo: "bdelanghe/ai-home",
      },
    });
    const result = findRepoBySlug(makeInventory([standard]), "ai-home");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_registered");
    }
  });

  test("name match and owner/name match on the same repo collapse to a single match (not ambiguous)", () => {
    const repo = makeBareRepo({
      name: "amz_sp_api",
      commonDir: "/bare/amz_sp_api.git",
      primaryRemote: {
        name: "origin",
        url: "git@github.com:bdelanghe/amz_sp_api.git",
        githubRepo: "bdelanghe/amz_sp_api",
      },
    });
    // Pass the name slug — name match wins, but the owner/name lookup also
    // could re-match the same repo. The dedupe step keeps this a single hit.
    const result = findRepoBySlug(makeInventory([repo]), "amz_sp_api");
    expect(result.ok).toBe(true);
  });
});

// GH-1657: bd_workspace_prefix field — schema validation, addLocalRepo
// population, override path, bd failure modes, rollback helper, and round-trip
// preservation through writeRepoInventoryIndex.
describe("repoInventorySchema (GH-1657)", () => {
  function inventoryWithPrefix(prefix: unknown): unknown {
    return {
      roots: [],
      repos: [
        {
          name: "scratch",
          commonDir: "/bare/scratch.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
          bd_workspace_prefix: prefix,
        },
      ],
    };
  }

  test("accepts a conforming prefix", () => {
    const parsed = repoInventorySchema.parse(inventoryWithPrefix("ai-home"));
    expect((parsed.repos[0] as { bd_workspace_prefix?: string }).bd_workspace_prefix).toBe(
      "ai-home",
    );
  });

  test("passes entries through when bd_workspace_prefix is absent (lazy migration)", () => {
    const inv = {
      roots: [],
      repos: [
        {
          name: "legacy",
          commonDir: "/bare/legacy.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
        },
      ],
    };
    const parsed = repoInventorySchema.parse(inv);
    expect(
      (parsed.repos[0] as { bd_workspace_prefix?: string }).bd_workspace_prefix,
    ).toBeUndefined();
  });

  test.each([
    ["", "empty"],
    ["AI-home", "uppercase"],
    ["1foo", "leading digit"],
    ["-foo", "leading hyphen"],
    ["foo_bar", "underscore"],
    ["foo.bar", "dot"],
  ])("rejects %s (%s)", (value) => {
    expect(() => repoInventorySchema.parse(inventoryWithPrefix(value))).toThrow();
  });
});

// GH-1710: canonical axis + stale-threshold knob on the on-disk schema.
describe("repoInventorySchema canonical axis (GH-1710)", () => {
  function inventoryWithAxes(canonical: unknown, stale: unknown): unknown {
    return {
      roots: [],
      repos: [
        {
          name: "scratch",
          commonDir: "/bare/scratch.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
          ...(canonical !== undefined ? { canonical } : {}),
          ...(stale !== undefined ? { stale_threshold_days: stale } : {}),
        },
      ],
    };
  }

  test("accepts canonical=gh and canonical=bd", () => {
    const gh = repoInventorySchema.parse(inventoryWithAxes("gh", undefined));
    const bd = repoInventorySchema.parse(inventoryWithAxes("bd", undefined));
    expect((gh.repos[0] as { canonical?: string }).canonical).toBe("gh");
    expect((bd.repos[0] as { canonical?: string }).canonical).toBe("bd");
  });

  test("rejects canonical values outside the gh/bd enum", () => {
    expect(() => repoInventorySchema.parse(inventoryWithAxes("xyz", undefined))).toThrow();
  });

  test("absent axes parse cleanly (back-compat)", () => {
    const inv = repoInventorySchema.parse(inventoryWithAxes(undefined, undefined));
    const repo = inv.repos[0] as { canonical?: string; stale_threshold_days?: number };
    expect(repo.canonical).toBeUndefined();
    expect(repo.stale_threshold_days).toBeUndefined();
  });

  test("accepts a positive-integer stale_threshold_days", () => {
    const parsed = repoInventorySchema.parse(inventoryWithAxes(undefined, 7));
    expect((parsed.repos[0] as { stale_threshold_days?: number }).stale_threshold_days).toBe(7);
  });

  test.each([0, -3, 1.5])("rejects non-positive-integer stale_threshold_days (%s)", (value) => {
    expect(() => repoInventorySchema.parse(inventoryWithAxes(undefined, value))).toThrow();
  });

  // GH-1703 — `dolt_remote` field on the same entry. Optional on read so
  // pre-GH-1703 indexes parse cleanly. Refinement validates only the
  // repo-name path segment against Dolthub's 3–32 char rule.
  function inventoryWithDoltRemote(value: unknown): unknown {
    return {
      roots: [],
      repos: [
        {
          name: "scratch",
          commonDir: "/bare/scratch.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: null,
          upstreamRemote: null,
          ...(value !== undefined ? { dolt_remote: value } : {}),
        },
      ],
    };
  }

  test("accepts a conforming dolt_remote URL (GH-1703)", () => {
    const parsed = repoInventorySchema.parse(
      inventoryWithDoltRemote("https://doltremoteapi.dolthub.com/bdelanghe/ai-home"),
    );
    expect((parsed.repos[0] as { dolt_remote?: string }).dolt_remote).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    );
  });

  test("accepts entries with no dolt_remote (back-compat, GH-1703)", () => {
    const parsed = repoInventorySchema.parse(inventoryWithDoltRemote(undefined));
    expect((parsed.repos[0] as { dolt_remote?: string }).dolt_remote).toBeUndefined();
  });

  test.each([
    ["https://doltremoteapi.dolthub.com/bdelanghe/ab", "too short (2 chars)"],
    ["https://doltremoteapi.dolthub.com/bdelanghe/" + "a".repeat(33), "too long (33 chars)"],
    ["https://doltremoteapi.dolthub.com/bdelanghe/1leading-digit", "leading digit"],
    ["https://doltremoteapi.dolthub.com/bdelanghe/-leading-hyphen", "leading hyphen"],
    ["https://doltremoteapi.dolthub.com/bdelanghe/has.dot", "dot in repo-name"],
    ["https://doltremoteapi.dolthub.com/bdelanghe/", "empty repo-name"],
    ["https://doltremoteapi.dolthub.com/", "missing repo-name segment"],
    ["https://doltremoteapi.dolthub.com/a/b/c", "too many path segments"],
    ["https://example.com/bdelanghe/ai-home", "wrong host"],
    ["http://doltremoteapi.dolthub.com/bdelanghe/ai-home", "wrong scheme"],
    ["not a url", "not a URL at all"],
  ])("rejects malformed dolt_remote %p (%s)", (value) => {
    expect(() => repoInventorySchema.parse(inventoryWithDoltRemote(value))).toThrow();
  });

  test("repoCanonical defaults to 'gh' when canonical is absent", () => {
    expect(repoCanonical({} as LocalRepo)).toBe("gh");
    expect(repoCanonical({ canonical: "bd" } as LocalRepo)).toBe("bd");
  });

  test("repoStaleThresholdDays defaults to 30 when absent", () => {
    expect(repoStaleThresholdDays({} as LocalRepo)).toBe(30);
    expect(repoStaleThresholdDays({ stale_threshold_days: 14 } as LocalRepo)).toBe(14);
  });
});

// GH-1710: retroactive flip of canonical + stale-threshold via setRepoCanonical /
// setRepoStaleThresholdDays. Round-trips through writeRepoInventoryIndex so the
// Zod gate re-validates the shape on every write.
describe("setRepoCanonical / setRepoStaleThresholdDays (GH-1710)", () => {
  function seedIndex(extra: Partial<LocalRepo> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "prx-set-axis-"));
    const indexPath = join(root, "index.json");
    const inventory: RepoInventory = {
      roots: [],
      repos: [
        {
          name: "demo-repo",
          commonDir: "/bare/io.github/demo/demo-repo.git",
          kind: "bare",
          mainWorktree: null,
          worktrees: [],
          localOnlyBranches: [],
          findings: [],
          remotes: [],
          primaryRemote: {
            name: "origin",
            url: "git@github.com:demo/demo-repo.git",
            githubRepo: "demo/demo-repo",
          },
          upstreamRemote: null,
          ...extra,
        },
      ],
    };
    writeRepoInventoryIndex(indexPath, inventory);
    return indexPath;
  }

  test("setRepoCanonical flips an existing entry by name and returns the delta", () => {
    const indexPath = seedIndex();
    const delta = setRepoCanonical(indexPath, "demo-repo", "bd");
    expect(delta).toEqual({ previous: undefined, current: "bd" });

    const reloaded = loadRepoInventoryIndex(indexPath)!;
    expect(reloaded.repos[0]!.canonical).toBe("bd");
  });

  test("setRepoCanonical matches by primaryRemote.githubRepo", () => {
    const indexPath = seedIndex();
    const delta = setRepoCanonical(indexPath, "demo/demo-repo", "bd");
    expect(delta.current).toBe("bd");
  });

  test("setRepoCanonical throws RepoAddError when the slug does not resolve", () => {
    const indexPath = seedIndex();
    expect(() => setRepoCanonical(indexPath, "no-such-slug", "bd")).toThrow(RepoAddError);
  });

  test("setRepoCanonical throws RepoAddError when no index exists", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-set-axis-"));
    const indexPath = join(root, "missing.json");
    expect(() => setRepoCanonical(indexPath, "x", "bd")).toThrow(RepoAddError);
  });

  test("setRepoStaleThresholdDays persists a positive integer", () => {
    const indexPath = seedIndex();
    const delta = setRepoStaleThresholdDays(indexPath, "demo-repo", 7);
    expect(delta).toEqual({ previous: undefined, current: 7 });
    const reloaded = loadRepoInventoryIndex(indexPath)!;
    expect(reloaded.repos[0]!.stale_threshold_days).toBe(7);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])("setRepoStaleThresholdDays rejects non-positive-integer (%s)", (value) => {
    const indexPath = seedIndex();
    expect(() => setRepoStaleThresholdDays(indexPath, "demo-repo", value)).toThrow(RepoAddError);
  });
});

describe("addLocalRepo bd_workspace_prefix population (GH-1657)", () => {
  type RunnerCall = { cmd: string[]; cwd?: string | undefined };

  function makeRunner(
    overrides: Map<string, { stdout?: string; stderr?: string; status?: number }> = new Map(),
  ) {
    const calls: RunnerCall[] = [];
    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
      calls.push({ cmd, cwd: options.cwd });
      if (cmd[0] === "git" && cmd[1] === "clone" && cmd[2] === "--bare") {
        mkdirSync(cmd[4]!, { recursive: true });
      }
      if (cmd[0] === "git" && cmd[3] === "worktree" && cmd[4] === "add" && cmd[5] === "--detach") {
        mkdirSync(cmd[6]!, { recursive: true });
      }
      const key = cmd.join(" ");
      const override = overrides.get(key);
      if (override) {
        return {
          stdout: override.stdout ?? "",
          stderr: override.stderr ?? "",
          status: override.status ?? 0,
        };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    return { runner, calls };
  }

  function setupRoots() {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-bd-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });
    return { root, bareRoot, wtRoot };
  }

  test("auto-populates from `bd config get database.workspace_prefix` in the mainx", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const expectedMainx = join(wtRoot, "io.github", "owner", "scratch", "mainx");
    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        ["bd config get database.workspace_prefix", { stdout: "ai-home\n" }],
      ]),
    );

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot: null,
        overlay: false,
      },
      runner,
    );

    expect(result.bdWorkspacePrefix).toBe("ai-home");
    const bdCalls = calls.filter((c) => c.cmd[0] === "bd");
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.cmd).toEqual(["bd", "config", "get", "database.workspace_prefix"]);
    expect(bdCalls[0]!.cwd).toBe(expectedMainx);
  });

  test("override path bypasses the bd subprocess entirely", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot: null,
        overlay: false,
        bdWorkspacePrefixOverride: "supply-plan",
      },
      runner,
    );

    expect(result.bdWorkspacePrefix).toBe("supply-plan");
    expect(calls.filter((c) => c.cmd[0] === "bd")).toHaveLength(0);
  });

  test.each([
    ["Foo"],
    ["-bad"],
    ["1foo"],
    [""],
    ["foo_bar"],
  ])("rejects invalid override value %p", (value) => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );

    let thrown: unknown;
    try {
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
          bdWorkspacePrefixOverride: value,
        },
        runner,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAddError);
    expect((thrown as RepoAddError).code).toBe("bd_workspace_prefix_invalid_shape");
  });

  test("bd non-zero exit → bd_workspace_prefix_unresolved", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        ["bd config get database.workspace_prefix", { status: 1, stderr: "bd: not found" }],
      ]),
    );

    let thrown: unknown;
    try {
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAddError);
    expect((thrown as RepoAddError).code).toBe("bd_workspace_prefix_unresolved");
  });

  test("bd empty stdout → bd_workspace_prefix_empty", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        ["bd config get database.workspace_prefix", { stdout: "\n" }],
      ]),
    );

    let thrown: unknown;
    try {
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAddError);
    expect((thrown as RepoAddError).code).toBe("bd_workspace_prefix_empty");
  });

  test.each([
    ["AI Home"],
    ["1foo"],
    ["-bad"],
  ])("bd non-conforming stdout %p → bd_workspace_prefix_invalid_shape", (value) => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        ["bd config get database.workspace_prefix", { stdout: `${value}\n` }],
      ]),
    );

    let thrown: unknown;
    try {
      addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAddError);
    expect((thrown as RepoAddError).code).toBe("bd_workspace_prefix_invalid_shape");
  });
});

describe("rollbackRepoAdd (GH-1657)", () => {
  test("removes existing bare + mainx paths", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-rollback-"));
    const barePath = join(root, "bare", "scratch.git");
    const mainxPath = join(root, "git", "worktrees", "io.github", "owner", "scratch", "mainx");
    mkdirSync(barePath, { recursive: true });
    mkdirSync(mainxPath, { recursive: true });

    rollbackRepoAdd({ barePath, mainxPath });

    expect(existsSync(barePath)).toBe(false);
    expect(existsSync(mainxPath)).toBe(false);
  });

  test("no-ops cleanly when paths do not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-rollback-noop-"));
    const barePath = join(root, "missing", "bare.git");
    const mainxPath = join(root, "missing", "mainx");
    expect(() => rollbackRepoAdd({ barePath, mainxPath })).not.toThrow();
  });
});

describe("loadRepoInventoryIndex (GH-1657)", () => {
  test("returns null when the file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-load-index-missing-"));
    expect(loadRepoInventoryIndex(join(root, "index.json"))).toBeNull();
  });

  test("parses an index file lacking bd_workspace_prefix (lazy migration)", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-load-index-legacy-"));
    const indexPath = join(root, "index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        roots: [],
        repos: [
          {
            name: "legacy",
            commonDir: "/bare/legacy.git",
            kind: "bare",
            mainWorktree: null,
            worktrees: [],
            localOnlyBranches: [],
            findings: [],
            remotes: [],
            primaryRemote: null,
            upstreamRemote: null,
          },
        ],
      }),
    );

    const loaded = loadRepoInventoryIndex(indexPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.repos[0]!.bd_workspace_prefix).toBeUndefined();
  });

  test("rejects an index file with a malformed bd_workspace_prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-load-index-bad-"));
    const indexPath = join(root, "index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        roots: [],
        repos: [
          {
            name: "bad",
            commonDir: "/bare/bad.git",
            kind: "bare",
            mainWorktree: null,
            worktrees: [],
            localOnlyBranches: [],
            findings: [],
            remotes: [],
            primaryRemote: null,
            upstreamRemote: null,
            bd_workspace_prefix: "Bad-Shape",
          },
        ],
      }),
    );

    expect(() => loadRepoInventoryIndex(indexPath)).toThrow();
  });
});

// GH-1680: `addLocalRepo` hydrates `.beads/` into the freshly-bootstrapped
// mainx via the injectable `hydrateFn`. Failure modes (including
// `clone-failed`) are captured on `RepoAddResult.beadsHydrate` rather than
// thrown — operators recover via `prx repo refresh <slug>` (PR-C, GH-1681).
describe("addLocalRepo .beads hydrate (GH-1680)", () => {
  type RunnerCall = { cmd: string[]; cwd?: string | undefined };
  type HydrateFn = typeof import("../../src/beads/repo_hydrate.ts").hydrateAfterMaterialize;
  type HydrateResult = ReturnType<HydrateFn>;

  function makeRunner(
    overrides: Map<string, { stdout?: string; stderr?: string; status?: number }> = new Map(),
  ): { runner: import("../../src/pr-state/repos.ts").RepoRunner; calls: RunnerCall[] } {
    const calls: RunnerCall[] = [];
    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
      calls.push({ cmd, cwd: options.cwd });
      if (cmd[0] === "git" && cmd[1] === "clone" && cmd[2] === "--bare") {
        mkdirSync(cmd[4]!, { recursive: true });
      }
      if (cmd[0] === "git" && cmd[3] === "worktree" && cmd[4] === "add" && cmd[5] === "--detach") {
        mkdirSync(cmd[6]!, { recursive: true });
      }
      const key = cmd.join(" ");
      const override = overrides.get(key);
      if (override) {
        return {
          stdout: override.stdout ?? "",
          stderr: override.stderr ?? "",
          status: override.status ?? 0,
        };
      }
      if (key === "bd config get database.workspace_prefix") {
        return { stdout: "ai-home\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    return { runner, calls };
  }

  function setupRoots() {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-add-hydrate-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });
    return { root, bareRoot, wtRoot };
  }

  function makeHydrateStub(result: HydrateResult): { fn: HydrateFn; calls: string[] } {
    const calls: string[] = [];
    const fn: HydrateFn = (mainxPath) => {
      calls.push(mainxPath);
      return result;
    };
    return { fn, calls };
  }

  test("hydrated → captured on result.beadsHydrate, stub invoked with mainxPath", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const expectedMainx = join(wtRoot, "io.github", "owner", "scratch", "mainx");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );
    const { fn, calls } = makeHydrateStub({
      status: "hydrated",
      doltRemote: "https://doltremoteapi.dolthub.com/owner/scratch",
      doltDatabase: "scratch_db",
      message: "beads: hydrated scratch_db from https://...",
      exitCode: 0,
    });

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot: null,
        overlay: false,
      },
      runner,
      fn,
    );

    expect(result.beadsHydrate.status).toBe("hydrated");
    expect(result.beadsHydrate.doltDatabase).toBe("scratch_db");
    expect(calls).toEqual([expectedMainx]);
  });

  test("skipped-no-beads → captured on result.beadsHydrate, no throw", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const expectedMainx = join(wtRoot, "io.github", "owner", "scratch", "mainx");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );
    const { fn, calls } = makeHydrateStub({
      status: "skipped-no-beads",
      doltRemote: null,
      doltDatabase: null,
      message: "beads: no .beads directory, skipping",
      exitCode: 0,
    });

    const result = addLocalRepo(
      {
        url: "git@github.com:owner/scratch.git",
        bareRoot,
        wtRoot,
        operatorConfigRoot: null,
        overlay: false,
      },
      runner,
      fn,
    );

    expect(result.beadsHydrate.status).toBe("skipped-no-beads");
    expect(calls).toEqual([expectedMainx]);
  });

  test("clone-failed → captured, no throw, bare + mainx remain on disk (no rollback)", () => {
    const { bareRoot, wtRoot } = setupRoots();
    const expectedBare = join(bareRoot, "io.github", "owner", "scratch.git");
    const expectedMainx = join(wtRoot, "io.github", "owner", "scratch", "mainx");
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${expectedBare} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
      ]),
    );
    const { fn, calls } = makeHydrateStub({
      status: "clone-failed",
      doltRemote: "https://doltremoteapi.dolthub.com/does-not-exist/x__y__z",
      doltDatabase: "scratch_db",
      message: "beads: mirror clone failed for https://...",
      exitCode: 1,
    });

    let thrown: unknown;
    let result: ReturnType<typeof addLocalRepo> | undefined;
    try {
      result = addLocalRepo(
        {
          url: "git@github.com:owner/scratch.git",
          bareRoot,
          wtRoot,
          operatorConfigRoot: null,
          overlay: false,
        },
        runner,
        fn,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    expect(result!.beadsHydrate.status).toBe("clone-failed");
    expect(result!.beadsHydrate.exitCode).toBe(1);
    expect(calls).toEqual([expectedMainx]);
    // Warn-and-continue invariant: a hydrate failure must NOT roll back the
    // bare + mainx materialization.
    expect(existsSync(expectedBare)).toBe(true);
    expect(existsSync(expectedMainx)).toBe(true);
  });
});

// GH-1722: atomic-write ratchet on writeRepoInventoryIndex. The schema gate
// runs FIRST and is the only failure mode we can deterministically inject from
// here (the tmp+rename happens entirely inside node:fs). The contract: a
// validation-throw must leave the pre-existing index.json byte-identical, and
// a successful write must not leave a `.tmp.<pid>.<rand>` sibling behind.
describe("writeRepoInventoryIndex atomic-write ratchet (GH-1722)", () => {
  test("validation-throw leaves an existing index byte-identical and writes no tmp sibling", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-atomic-"));
    const indexDir = join(root, ".prx", "repos");
    mkdirSync(indexDir, { recursive: true });
    const indexPath = join(indexDir, "index.json");

    const goodInventory: RepoInventory = {
      roots: [],
      repos: [],
      bareRoot: null,
      configPath: null,
      indexPath,
      generatedAt: "2026-05-14T00:00:00.000Z",
    };
    writeRepoInventoryIndex(indexPath, goodInventory);
    const before = readFileSync(indexPath, "utf8");

    const badInventory = {
      roots: [],
      repos: [{ name: "x", bd_workspace_prefix: "INVALID UPPERCASE WITH SPACE" }],
    } as unknown as RepoInventory;

    expect(() => writeRepoInventoryIndex(indexPath, badInventory)).toThrow();
    expect(readFileSync(indexPath, "utf8")).toBe(before);
    const siblings = readdirSync(dirname(indexPath));
    expect(siblings.some((f) => f.startsWith("index.json.tmp."))).toBe(false);
  });

  test("successful write leaves no tmp sibling behind", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-atomic-ok-"));
    const indexDir = join(root, ".prx", "repos");
    mkdirSync(indexDir, { recursive: true });
    const indexPath = join(indexDir, "index.json");
    writeRepoInventoryIndex(indexPath, {
      roots: [],
      repos: [],
      bareRoot: null,
      configPath: null,
      indexPath,
      generatedAt: "2026-05-14T00:00:00.000Z",
    });
    const siblings = readdirSync(dirname(indexPath));
    expect(siblings.filter((f) => f.startsWith("index.json.tmp."))).toEqual([]);
    expect(siblings).toContain("index.json");
  });
});

// GH-1681: `prx repo refresh` library entry point. Exercises lazy refspec
// upgrade, --no-fetch / --dry-run gating, cold-mainx recovery via
// materializeMainxIfMissing, and clone-failed surfacing.
describe("refreshLocalRepo (GH-1681)", () => {
  type RunnerCall = { cmd: string[]; cwd?: string | undefined };
  type HydrateFn = typeof import("../../src/beads/repo_hydrate.ts").hydrateAfterMaterialize;
  type HydrateResult = ReturnType<HydrateFn>;

  const CANONICAL_REFSPECS = [
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tags/*:refs/tags/*",
    "+refs/notes/*:refs/notes/*",
  ];

  function makeRunner(
    overrides: Map<string, { stdout?: string; stderr?: string; status?: number }> = new Map(),
  ): { runner: import("../../src/pr-state/repos.ts").RepoRunner; calls: RunnerCall[] } {
    const calls: RunnerCall[] = [];
    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
      calls.push({ cmd, cwd: options.cwd });
      // Cold-mainx recovery side-effect: `materializeMainxIfMissing` will
      // exec a `worktree add --detach` that we have to materialize on disk
      // so the post-add existsSync probes (e.g. hydrate's beadsDir check)
      // can observe it.
      if (cmd[0] === "git" && cmd[3] === "worktree" && cmd[4] === "add" && cmd[5] === "--detach") {
        mkdirSync(cmd[6]!, { recursive: true });
      }
      const key = cmd.join(" ");
      const override = overrides.get(key);
      if (override) {
        return {
          stdout: override.stdout ?? "",
          stderr: override.stderr ?? "",
          status: override.status ?? 0,
        };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    return { runner, calls };
  }

  function setupBareAndMainx(opts: { coldMainx?: boolean; legacyBare?: boolean } = {}) {
    // GH-1751: `legacyBare` flags a pre-PR-A bare clone where the fetch
    // refspec is empty, `refs/remotes/origin/*` is empty, and
    // `refs/remotes/origin/HEAD` is unset. State is enforced by the test's
    // runner overrides (this fixture only owns the on-disk shape); flagging
    // here keeps the call site self-documenting.
    const root = mkdtempSync(join(tmpdir(), "prx-repo-refresh-"));
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    const barePath = join(bareRoot, "io.github", "owner", "scratch.git");
    const mainxPath = join(wtRoot, "io.github", "owner", "scratch", "mainx");
    mkdirSync(barePath, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });
    if (!opts.coldMainx) {
      mkdirSync(mainxPath, { recursive: true });
    }
    return { root, bareRoot, wtRoot, barePath, mainxPath };
  }

  function makeRepo(barePath: string, mainxPath: string | null): LocalRepo {
    const primaryRemote = {
      name: "origin",
      url: "git@github.com:owner/scratch.git",
      githubRepo: "owner/scratch",
    };
    return {
      name: "scratch",
      commonDir: barePath,
      kind: "bare",
      mainWorktree: mainxPath,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [primaryRemote],
      primaryRemote,
      upstreamRemote: null,
    };
  }

  function makeHydrateStub(result: HydrateResult): {
    fn: HydrateFn;
    calls: Array<{ mainxPath: string; opts: { dryRun?: boolean } | undefined }>;
  } {
    const calls: Array<{ mainxPath: string; opts: { dryRun?: boolean } | undefined }> = [];
    const fn: HydrateFn = (mainxPath, _deps, opts) => {
      calls.push({ mainxPath, opts });
      return result;
    };
    return { fn, calls };
  }

  function alreadyHydrated(): HydrateResult {
    return {
      status: "already-hydrated",
      doltRemote: null,
      doltDatabase: "scratch_db",
      message: "beads: scratch_db already hydrated, skipping",
      exitCode: 0,
    };
  }

  test("happy path: refspec already broadened → no upgrade, fetch runs, hydrate already-hydrated", () => {
    const { bareRoot: _bareRoot, wtRoot, barePath, mainxPath } = setupBareAndMainx();
    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        [
          `git -C ${barePath} config --get-all remote.origin.fetch`,
          { stdout: CANONICAL_REFSPECS.join("\n") + "\n" },
        ],
      ]),
    );
    const { fn, calls: hydrateCalls } = makeHydrateStub(alreadyHydrated());

    const result = refreshLocalRepo(
      { repo: makeRepo(barePath, mainxPath), wtRoot, dryRun: false, noFetch: false },
      runner,
      fn,
    );

    expect(result.slug).toBe("scratch");
    expect(result.barePath).toBe(barePath);
    expect(result.mainxPath).toBe(mainxPath);
    expect(result.mainxCreated).toBe(false);
    expect(result.refspecUpgraded).toBe(false);
    expect(result.refspecBefore).toEqual(CANONICAL_REFSPECS);
    expect(result.refspecAfter).toEqual(CANONICAL_REFSPECS);
    expect(result.fetched).toBe(true);
    expect(result.originHeadSet).toBe(true);
    expect(result.beadsHydrate.status).toBe("already-hydrated");
    expect(hydrateCalls).toEqual([{ mainxPath, opts: { dryRun: false } }]);

    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds).toContain(`git -C ${barePath} config --get-all remote.origin.fetch`);
    expect(cmds).toContain(`git -C ${barePath} fetch --prune origin`);
    expect(cmds).toContain(`git -C ${barePath} remote set-head origin --auto`);
    expect(cmds.some((c) => c.includes("config --unset-all remote.origin.fetch"))).toBe(false);
    expect(cmds.some((c) => c.includes("config --add remote.origin.fetch"))).toBe(false);
    // GH-1751: fetch must precede set-head and materialize (verifyDefaultBranchRef).
    const fetchIdx = cmds.indexOf(`git -C ${barePath} fetch --prune origin`);
    const setHeadIdx = cmds.indexOf(`git -C ${barePath} remote set-head origin --auto`);
    const revParseIdx = cmds.indexOf(`git -C ${barePath} rev-parse --verify origin/main`);
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(setHeadIdx).toBeGreaterThan(fetchIdx);
    expect(revParseIdx).toBeGreaterThan(setHeadIdx);
  });

  test("lazy upgrade: heads-only refspec → unset-all + three --add calls in canonical order", () => {
    const { wtRoot, barePath, mainxPath } = setupBareAndMainx();
    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        [
          `git -C ${barePath} config --get-all remote.origin.fetch`,
          { stdout: "+refs/heads/*:refs/remotes/origin/*\n" },
        ],
      ]),
    );
    const { fn } = makeHydrateStub(alreadyHydrated());

    const result = refreshLocalRepo(
      { repo: makeRepo(barePath, mainxPath), wtRoot, dryRun: false, noFetch: false },
      runner,
      fn,
    );

    expect(result.refspecUpgraded).toBe(true);
    expect(result.refspecBefore).toEqual(["+refs/heads/*:refs/remotes/origin/*"]);
    expect(result.refspecAfter).toEqual(CANONICAL_REFSPECS);

    const refspecCmds = calls
      .map((c) => c.cmd.join(" "))
      .filter((c) => c.includes("remote.origin.fetch") && !c.includes("--get-all"));
    expect(refspecCmds).toEqual([
      `git -C ${barePath} config --unset-all remote.origin.fetch`,
      `git -C ${barePath} config --add remote.origin.fetch +refs/heads/*:refs/remotes/origin/*`,
      `git -C ${barePath} config --add remote.origin.fetch +refs/tags/*:refs/tags/*`,
      `git -C ${barePath} config --add remote.origin.fetch +refs/notes/*:refs/notes/*`,
    ]);
  });

  test("--no-fetch: skip fetch, still runs upgrade + hydrate", () => {
    const { wtRoot, barePath, mainxPath } = setupBareAndMainx();
    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        [
          `git -C ${barePath} config --get-all remote.origin.fetch`,
          { stdout: "+refs/heads/*:refs/remotes/origin/*\n" },
        ],
      ]),
    );
    const { fn, calls: hydrateCalls } = makeHydrateStub(alreadyHydrated());

    const result = refreshLocalRepo(
      { repo: makeRepo(barePath, mainxPath), wtRoot, dryRun: false, noFetch: true },
      runner,
      fn,
    );

    expect(result.fetched).toBe(false);
    expect(result.originHeadSet).toBe(false);
    expect(result.refspecUpgraded).toBe(true);
    expect(hydrateCalls).toHaveLength(1);

    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds.some((c) => c.startsWith(`git -C ${barePath} fetch`))).toBe(false);
    expect(cmds.some((c) => c.includes("remote set-head"))).toBe(false);
  });

  test("--dry-run: no writes, no fetch, hydrate stub receives { dryRun: true }", () => {
    const { wtRoot, barePath, mainxPath } = setupBareAndMainx();
    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${barePath} config --get-all remote.origin.fetch`,
          { stdout: "+refs/heads/*:refs/remotes/origin/*\n" },
        ],
      ]),
    );
    const { fn, calls: hydrateCalls } = makeHydrateStub({
      status: "dry-run",
      doltRemote: "https://doltremoteapi.dolthub.com/owner/scratch",
      doltDatabase: "scratch_db",
      message: "beads: would clone …",
      exitCode: 0,
    });

    const result = refreshLocalRepo(
      { repo: makeRepo(barePath, mainxPath), wtRoot, dryRun: true, noFetch: false },
      runner,
      fn,
    );

    expect(result.dryRun).toBe(true);
    expect(result.refspecUpgraded).toBe(true);
    expect(result.refspecAfter).toEqual(CANONICAL_REFSPECS);
    expect(result.fetched).toBe(false);
    expect(result.originHeadSet).toBe(false);
    expect(result.mainxCreated).toBe(false);
    expect(hydrateCalls).toEqual([{ mainxPath, opts: { dryRun: true } }]);

    // Dry-run must not invoke any write commands. Materialize is skipped
    // entirely, so only --get-all is allowed.
    const writeCmds = calls
      .map((c) => c.cmd.join(" "))
      .filter(
        (c) =>
          c.includes("--unset-all") ||
          (c.includes("config --add") && c.includes("remote.origin.fetch")) ||
          c.includes("fetch --prune") ||
          c.includes("remote set-head") ||
          c.includes("worktree add"),
      );
    expect(writeCmds).toEqual([]);
  });

  test("cold-mainx recovery: missing mainx triggers materializeMainxIfMissing with created=true", () => {
    const { wtRoot, barePath, mainxPath } = setupBareAndMainx({ coldMainx: true });
    expect(existsSync(mainxPath)).toBe(false);

    const { runner, calls } = makeRunner(
      new Map([
        [
          `git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        [
          `git -C ${barePath} config --get-all remote.origin.fetch`,
          { stdout: CANONICAL_REFSPECS.join("\n") + "\n" },
        ],
      ]),
    );
    const { fn } = makeHydrateStub(alreadyHydrated());

    const result = refreshLocalRepo(
      { repo: makeRepo(barePath, null), wtRoot, dryRun: false, noFetch: false },
      runner,
      fn,
    );

    expect(result.mainxCreated).toBe(true);
    expect(existsSync(mainxPath)).toBe(true);
    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds).toContain(`git -C ${barePath} worktree add --detach ${mainxPath} origin/main`);
  });

  test("clone-failed: refreshLocalRepo returns the result without throwing (warn-and-continue at lib layer)", () => {
    const { wtRoot, barePath, mainxPath } = setupBareAndMainx();
    const { runner } = makeRunner(
      new Map([
        [
          `git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`,
          { stdout: "origin/main\n" },
        ],
        [
          `git -C ${barePath} config --get-all remote.origin.fetch`,
          { stdout: CANONICAL_REFSPECS.join("\n") + "\n" },
        ],
      ]),
    );
    const { fn } = makeHydrateStub({
      status: "clone-failed",
      doltRemote: "https://doltremoteapi.dolthub.com/missing/owner",
      doltDatabase: "scratch_db",
      message: "beads: mirror clone failed for https://...",
      exitCode: 1,
    });

    let thrown: unknown;
    let result: ReturnType<typeof refreshLocalRepo> | undefined;
    try {
      result = refreshLocalRepo(
        { repo: makeRepo(barePath, mainxPath), wtRoot, dryRun: false, noFetch: false },
        runner,
        fn,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(result?.beadsHydrate.status).toBe("clone-failed");
    expect(result?.beadsHydrate.exitCode).toBe(1);
  });

  test("missing bare path throws RepoAddError with bare_path_missing code", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-repo-refresh-missing-"));
    const wtRoot = join(root, "wt");
    mkdirSync(wtRoot, { recursive: true });
    const missingBare = join(root, "bare", "does-not-exist.git");
    const { runner } = makeRunner();
    const { fn } = makeHydrateStub(alreadyHydrated());

    expect(() =>
      refreshLocalRepo(
        { repo: makeRepo(missingBare, null), wtRoot, dryRun: false, noFetch: false },
        runner,
        fn,
      ),
    ).toThrow(RepoAddError);
  });

  // GH-1751: Map-mock coverage for the legacy-bare scenario from the bug
  // report — empty `remote.origin.fetch`, no `refs/remotes/origin/HEAD`,
  // never-fetched. Pre-fix, `refreshLocalRepo` invoked `materializeMainxIfMissing`
  // first, which tripped `verifyDefaultBranchRef`'s `rev-parse origin/main`
  // and surfaced `fatal: Needed a single revision` before the refspec
  // upgrade / fetch / set-head steps ever ran. Post-fix the order is
  // upgrade-refspec → fetch → set-head → materialize → hydrate.
  test("GH-1751: legacy bare (empty refspec, no origin/HEAD, never-fetched) → upgrade + fetch + set-head + materialize + hydrate, exits 0", () => {
    const { wtRoot, barePath, mainxPath } = setupBareAndMainx({
      coldMainx: true,
      legacyBare: true,
    });
    expect(existsSync(mainxPath)).toBe(false);

    // Stateful runner: the legacy bare's refs/remotes/origin/* refs and
    // `origin/HEAD` symref only become resolvable AFTER the fetch + set-head
    // steps run. Drives the assertion that materialize cannot succeed in the
    // old order.
    let fetchRan = false;
    let setHeadRan = false;
    const calls: RunnerCall[] = [];
    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
      calls.push({ cmd, cwd: options.cwd });
      if (cmd[0] === "git" && cmd[3] === "worktree" && cmd[4] === "add" && cmd[5] === "--detach") {
        mkdirSync(cmd[6]!, { recursive: true });
      }
      const key = cmd.join(" ");
      if (key === `git -C ${barePath} fetch --prune origin`) {
        fetchRan = true;
        return { stdout: "", stderr: "", status: 0 };
      }
      if (key === `git -C ${barePath} remote set-head origin --auto`) {
        setHeadRan = true;
        return { stdout: "origin/HEAD set to main\n", stderr: "", status: 0 };
      }
      if (key === `git -C ${barePath} config --get-all remote.origin.fetch`) {
        // Legacy bare: `config --get-all` exits non-zero with empty stdout
        // when the key has no entries.
        return { stdout: "", stderr: "", status: 1 };
      }
      if (key === `git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`) {
        return setHeadRan
          ? { stdout: "origin/main\n", stderr: "", status: 0 }
          : {
              stdout: "",
              stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
              status: 1,
            };
      }
      if (key === `git -C ${barePath} ls-remote --symref origin HEAD`) {
        // Available regardless — but the post-fix path should not need it
        // because set-head will have already populated the local symref.
        return { stdout: "ref: refs/heads/main\tHEAD\nabc123\tHEAD\n", stderr: "", status: 0 };
      }
      if (key === `git -C ${barePath} rev-parse --verify origin/main`) {
        return fetchRan
          ? { stdout: "abc123\n", stderr: "", status: 0 }
          : { stdout: "", stderr: "fatal: Needed a single revision", status: 1 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const { fn, calls: hydrateCalls } = makeHydrateStub(alreadyHydrated());

    const result = refreshLocalRepo(
      { repo: makeRepo(barePath, null), wtRoot, dryRun: false, noFetch: false },
      runner,
      fn,
    );

    expect(result.refspecBefore).toEqual([]);
    expect(result.refspecAfter).toEqual(CANONICAL_REFSPECS);
    expect(result.refspecUpgraded).toBe(true);
    expect(result.fetched).toBe(true);
    expect(result.originHeadSet).toBe(true);
    expect(result.mainxCreated).toBe(true);
    expect(existsSync(mainxPath)).toBe(true);
    expect(hydrateCalls).toHaveLength(1);

    // Assert the canonical step ordering: refspec write → fetch → set-head
    // → symbolic-ref (resolveDefaultBranch) → rev-parse (verifyDefaultBranchRef)
    // → worktree add (materialize).
    const cmds = calls.map((c) => c.cmd.join(" "));
    const idx = (cmd: string) => cmds.findIndex((c) => c === cmd);
    const refspecGet = idx(`git -C ${barePath} config --get-all remote.origin.fetch`);
    const refspecUnset = idx(`git -C ${barePath} config --unset-all remote.origin.fetch`);
    const refspecAddHeads = idx(
      `git -C ${barePath} config --add remote.origin.fetch +refs/heads/*:refs/remotes/origin/*`,
    );
    const fetchIdx = idx(`git -C ${barePath} fetch --prune origin`);
    const setHeadIdx = idx(`git -C ${barePath} remote set-head origin --auto`);
    const symrefIdx = idx(`git -C ${barePath} symbolic-ref --short refs/remotes/origin/HEAD`);
    const revParseIdx = idx(`git -C ${barePath} rev-parse --verify origin/main`);
    const worktreeIdx = idx(`git -C ${barePath} worktree add --detach ${mainxPath} origin/main`);

    expect(refspecGet).toBeGreaterThanOrEqual(0);
    expect(refspecUnset).toBeGreaterThan(refspecGet);
    expect(refspecAddHeads).toBeGreaterThan(refspecUnset);
    expect(fetchIdx).toBeGreaterThan(refspecAddHeads);
    expect(setHeadIdx).toBeGreaterThan(fetchIdx);
    expect(symrefIdx).toBeGreaterThan(setHeadIdx);
    expect(revParseIdx).toBeGreaterThan(symrefIdx);
    expect(worktreeIdx).toBeGreaterThan(revParseIdx);
  });
});

// GH-1751: real-git integration. Reconstructs the exact failure mode from
// the bug report (empty `remote.origin.fetch`, no `refs/remotes/origin/HEAD`
// symref, refs/remotes/origin/* empty) against a real bare clone of a real
// upstream and asserts that `refreshLocalRepo` repairs it end-to-end. Uses
// the default runner; hydrate is stubbed because the bare has no `.beads/`.
describe("refreshLocalRepo — legacy bare integration (GH-1751)", () => {
  type HydrateFn = typeof import("../../src/beads/repo_hydrate.ts").hydrateAfterMaterialize;

  function git(cwd: string, args: string[]): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${result.stderr}`);
    }
  }

  test("real legacy bare → refspec repaired, origin/HEAD set, refs fetched, mainx materialized", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prx-gh1751-int-")));

    // 1. Upstream remote with one commit on `main`.
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);
    const upstreamBare = join(root, "upstream.git");
    git(seed, ["clone", "--bare", seed, upstreamBare]);

    // 2. Operator's bare clone — start healthy, then scrub it down to the
    //    pre-PR-A legacy state.
    const bareRoot = join(root, "bare");
    const wtRoot = join(root, "wt");
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });
    const barePath = join(bareRoot, "io.github", "owner", "scratch.git");
    mkdirSync(dirname(barePath), { recursive: true });
    git(root, ["clone", "--bare", upstreamBare, barePath]);

    // Scrub: empty refspec, delete origin/HEAD symref, blow away
    // refs/remotes/origin/*. Some `git clone --bare` versions don't write
    // the refspec or remote-tracking refs to begin with; we tolerate either
    // shape via `check: false`-equivalent guards.
    spawnSync("git", ["-C", barePath, "config", "--unset-all", "remote.origin.fetch"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", barePath, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], {
      encoding: "utf8",
    });
    const remotesDir = join(barePath, "refs", "remotes", "origin");
    if (existsSync(remotesDir)) {
      rmSync(remotesDir, { recursive: true, force: true });
    }

    // Sanity: the bare is now in the legacy state — `rev-parse origin/main`
    // must fail. (This is what `materializeMainxIfMissing` tripped on pre-fix.)
    const probe = spawnSync("git", ["-C", barePath, "rev-parse", "--verify", "origin/main"], {
      encoding: "utf8",
    });
    expect(probe.status).not.toBe(0);

    // 3. Run refresh with the real default runner.
    const mainxPath = join(wtRoot, "io.github", "owner", "scratch", "mainx");
    const repo: LocalRepo = {
      name: "scratch",
      commonDir: barePath,
      kind: "bare",
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      // GH-1751: `primaryRemote.url` is used by `refreshLocalRepo` solely to
      // derive the canonical mainx path (parseRepoUrl → owner/name → wtRoot/io.<host>/<owner>/<name>/mainx).
      // The bare's actual `remote.origin.url` (set when we did `git clone --bare
      // <upstreamBare>`) is what `git fetch` and `git remote set-head` operate
      // against. Keep them decoupled here: the LocalRepo.primaryRemote.url is
      // a parseable git URL whose `name` matches the bare basename.
      remotes: [
        {
          name: "origin",
          url: "git@github.com:owner/scratch.git",
          githubRepo: "owner/scratch",
        },
      ],
      primaryRemote: {
        name: "origin",
        url: "git@github.com:owner/scratch.git",
        githubRepo: "owner/scratch",
      },
      upstreamRemote: null,
    };
    const hydrateStub: HydrateFn = (_mainx, _deps, _opts) => ({
      status: "skipped-no-beads",
      doltRemote: null,
      doltDatabase: null,
      message: "beads: no .beads/ directory; skipping hydrate",
      exitCode: 0,
    });

    const result = refreshLocalRepo(
      { repo, wtRoot, dryRun: false, noFetch: false },
      undefined,
      hydrateStub,
    );

    // 4. Assert the bare is back to pristine.
    expect(result.refspecUpgraded).toBe(true);
    expect(result.refspecAfter).toEqual([
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
      "+refs/notes/*:refs/notes/*",
    ]);
    expect(result.fetched).toBe(true);
    expect(result.originHeadSet).toBe(true);
    expect(result.mainxCreated).toBe(true);
    expect(existsSync(mainxPath)).toBe(true);

    // origin/HEAD symref written by set-head.
    const symref = spawnSync(
      "git",
      ["-C", barePath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { encoding: "utf8" },
    );
    expect(symref.status).toBe(0);
    expect(symref.stdout.trim()).toBe("origin/main");

    // refs/remotes/origin/main repopulated by fetch.
    const refProbe = spawnSync("git", ["-C", barePath, "rev-parse", "--verify", "origin/main"], {
      encoding: "utf8",
    });
    expect(refProbe.status).toBe(0);

    // Cleanup
    rmSync(root, { recursive: true, force: true });
  });
});

// GH-2156 — `localWorkspacePrefixForCwd` resolved from inside a managed
// worktree whose git-root has no cwd-local index. Drives the REAL
// `loadRepoInventoryConfig` → `loadRepoInventoryIndex` → match chain (the gap
// the GH-1766 adapter stubs hide): the index is discovered via the global
// config `indexPath`, and the covering repo is matched via the cwd's
// git-common-dir — NOT the (empty) `worktrees[]` array.
describe("localWorkspacePrefixForCwd — cross-repo worktree resolution (GH-2156)", () => {
  function fixture(opts: { writeIndex?: boolean; configIndexPath?: boolean } = {}): {
    root: string;
    spdWt: string;
    spdBare: string;
    foreignWt: string;
    runner: import("../../src/pr-state/repos.ts").RepoRunner;
    restoreHome: () => void;
  } {
    const writeIndex = opts.writeIndex ?? true;
    const configIndexPath = opts.configIndexPath ?? true;
    const root = mkdtempSync(join(tmpdir(), "prx-gh-2156-"));
    const homeRoot = join(root, "home");
    // Bare repos live under ~/.local/share/git/bare/...; worktrees under a
    // separate ~/.local/state/wt/... tree — the share/ vs state/ split that
    // defeats the commonDir-ancestor arm.
    const spdBare = join(root, "share", "bare", "demo-repo.git");
    const foreignBare = join(root, "share", "bare", "ai-home.git");
    const spdWt = join(root, "state", "wt", "demo-repo.git", "spd_aqg_3y3");
    const foreignWt = join(root, "state", "wt", "ai-home.git", "ai_home_xyz");
    for (const path of [spdBare, foreignBare, spdWt, foreignWt, join(homeRoot, ".config", "prx")]) {
      mkdirSync(path, { recursive: true });
    }

    // Central index — the only copy, mirroring the ai-home control repo's
    // single index that catalogues every bare repo. `worktrees: []` is left
    // empty on purpose to prove the common-dir arm does not depend on it.
    const centralIndexPath = join(root, "central", ".prx", "repos", "index.json");
    if (writeIndex) {
      mkdirSync(dirname(centralIndexPath), { recursive: true });
      const index = {
        roots: [join(root, "share", "bare")],
        repos: [
          {
            name: "demo-repo",
            commonDir: spdBare,
            kind: "bare" as const,
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
            kind: "bare" as const,
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
    }

    writeFileSync(
      join(homeRoot, ".config", "prx", "config.json"),
      JSON.stringify(
        configIndexPath
          ? { bareRoot: join(root, "share", "bare"), indexPath: centralIndexPath }
          : { bareRoot: join(root, "share", "bare") },
        null,
        2,
      ),
    );

    // Mock runner: `--show-toplevel` returns the worktree dir itself (so the
    // git-root has no cwd-local index → global fallback fires);
    // `--git-common-dir` returns the matching bare repo path.
    const commonByWt = new Map<string, string>([
      [spdWt, spdBare],
      [foreignWt, foreignBare],
    ]);
    const runner: import("../../src/pr-state/repos.ts").RepoRunner = (cmd, options = {}) => {
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
      root,
      spdWt,
      spdBare,
      foreignWt,
      runner,
      restoreHome: () => {
        process.env.HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  test("worktree common-dir matches a central-index entry → prefix (worktrees[] empty)", () => {
    const { spdWt, runner, restoreHome } = fixture();
    try {
      expect(localWorkspacePrefixForCwd(spdWt, runner)).toBe("demo-repo");
    } finally {
      restoreHome();
    }
  });

  test("a different covered worktree resolves to its own prefix (no cross-talk)", () => {
    const { foreignWt, runner, restoreHome } = fixture();
    try {
      expect(localWorkspacePrefixForCwd(foreignWt, runner)).toBe("ai-home");
    } finally {
      restoreHome();
    }
  });

  test("common-dir matching drives the lookup even when the entry has commonDir but no covering ancestor", () => {
    // Sanity: the legacy commonDir-ancestor arm cannot match here because the
    // worktree cwd (state/) is not under the bare commonDir (share/). Proven by
    // the prefix still resolving — only the new common-dir arm can produce it.
    const { spdWt, spdBare, runner, restoreHome } = fixture();
    try {
      expect(spdWt.startsWith(`${spdBare}/`)).toBe(false);
      expect(localWorkspacePrefixForCwd(spdWt, runner)).toBe("demo-repo");
    } finally {
      restoreHome();
    }
  });

  test("no central index reachable → null (no false positive)", () => {
    const { spdWt, runner, restoreHome } = fixture({ writeIndex: false });
    try {
      expect(localWorkspacePrefixForCwd(spdWt, runner)).toBeNull();
    } finally {
      restoreHome();
    }
  });

  test("global config has no indexPath pointer → null (index undiscoverable)", () => {
    const { spdWt, runner, restoreHome } = fixture({ configIndexPath: false });
    try {
      expect(localWorkspacePrefixForCwd(spdWt, runner)).toBeNull();
    } finally {
      restoreHome();
    }
  });

  test("cwd whose common-dir matches no entry → null", () => {
    const { root, runner, restoreHome } = fixture();
    try {
      const unrelated = join(root, "state", "wt", "elsewhere", "nope");
      mkdirSync(unrelated, { recursive: true });
      // runner returns 128 for unknown cwds on both rev-parse probes.
      expect(localWorkspacePrefixForCwd(unrelated, runner)).toBeNull();
    } finally {
      restoreHome();
    }
  });
});
