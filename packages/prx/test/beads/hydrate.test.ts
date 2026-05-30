import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDoltRemoteUrl,
  formatHydrateResult,
  hydrate,
  isEmbeddedDoltMode,
  parseGitOrigin,
  readDoltDatabaseName,
  type HydrateDeps,
  type HydrateResult,
} from "../../src/beads/hydrate.ts";

describe("parseGitOrigin", () => {
  test("parses ssh short form (git@host:owner/repo.git)", () => {
    expect(parseGitOrigin("git@github.com:bdelanghe/ai-home.git")).toEqual({
      host: "github-com",
      owner: "bdelanghe",
      repo: "ai-home",
    });
  });

  test("parses ssh short form without .git suffix", () => {
    expect(parseGitOrigin("git@github.com:bdelanghe/ai-home")).toEqual({
      host: "github-com",
      owner: "bdelanghe",
      repo: "ai-home",
    });
  });

  test("parses ssh long form with explicit port", () => {
    expect(parseGitOrigin("ssh://git@github.com:22/bdelanghe/ai-home.git")).toEqual({
      host: "github-com",
      owner: "bdelanghe",
      repo: "ai-home",
    });
  });

  test("parses https form", () => {
    expect(parseGitOrigin("https://github.com/bdelanghe/ai-home.git")).toEqual({
      host: "github-com",
      owner: "bdelanghe",
      repo: "ai-home",
    });
  });

  test("parses http form", () => {
    expect(parseGitOrigin("http://gitlab.internal/team/project")).toEqual({
      host: "gitlab-internal",
      owner: "team",
      repo: "project",
    });
  });

  test("dots in host become dashes", () => {
    expect(parseGitOrigin("git@gitlab.example.com:group/repo.git")?.host).toBe(
      "gitlab-example-com",
    );
  });

  test("lowercases mixed-case owner and repo", () => {
    const result = parseGitOrigin("git@github.com:BDelanghe/AI-Home.git");
    expect(result?.owner).toBe("bdelanghe");
    expect(result?.repo).toBe("ai-home");
  });

  test("rejects unsupported schemes", () => {
    expect(parseGitOrigin("file:///local/path")).toBeNull();
    expect(parseGitOrigin("/absolute/path")).toBeNull();
    expect(parseGitOrigin("")).toBeNull();
  });

  test("rejects missing owner or repo", () => {
    expect(parseGitOrigin("git@github.com:onlyrepo")).toBeNull();
    expect(parseGitOrigin("https://github.com/onlyrepo")).toBeNull();
  });

  test("rejects multi-segment paths beyond owner/repo", () => {
    expect(parseGitOrigin("https://github.com/owner/suborg/repo")).toBeNull();
  });
});

describe("buildDoltRemoteUrl", () => {
  // GH-1703: convention pivoted from `<dh-user>/<host>__<owner>__<repo>` to
  // the operator-friendly `<dh-user>/<repo>` shape. {dolt_user} already
  // disambiguates ownership at the host, so the org prefix is redundant.
  test("defaults dolt_user to the gh_owner", () => {
    const url = buildDoltRemoteUrl({
      host: "github-com",
      owner: "bdelanghe",
      repo: "ai-home",
    });
    expect(url).toBe("https://doltremoteapi.dolthub.com/bdelanghe/ai-home");
  });

  test("overrides dolt_user via BEADS_DOLTHUB_OWNER", () => {
    const url = buildDoltRemoteUrl(
      { host: "github-com", owner: "anthropic", repo: "claude-code" },
      "bdelanghe",
    );
    expect(url).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/claude-code",
    );
  });

  test("ignores empty / whitespace override", () => {
    const url = buildDoltRemoteUrl(
      { host: "github-com", owner: "bdelanghe", repo: "ai-home" },
      "   ",
    );
    expect(url).toBe("https://doltremoteapi.dolthub.com/bdelanghe/ai-home");
  });

  test("does not include host or owner in the path", () => {
    const url = buildDoltRemoteUrl({
      host: "github-com",
      owner: "some_user",
      repo: "my-project",
    });
    expect(url).toBe("https://doltremoteapi.dolthub.com/some_user/my-project");
    expect(url).not.toContain("__");
  });

  test("repo-name segment stays inside Dolthub's 32-char cap for typical repos", () => {
    // GH-1703 sets the 3–32 char ceiling at the schema layer. Sanity-check
    // a few representative fleet names so a regression that re-introduces a
    // host/owner prefix would blow the cap.
    const cases = [
      { owner: "bdelanghe", repo: "ai-home" },
      { owner: "bdelanghe", repo: "demo-repo" },
      { owner: "anthropic", repo: "claude-code" },
    ];
    for (const c of cases) {
      const url = buildDoltRemoteUrl({ host: "github-com", ...c });
      const segment = url.split("/").pop()!;
      expect(segment.length).toBeLessThanOrEqual(32);
      expect(segment).toBe(c.repo);
    }
  });
});

// ── hydrate() with injected deps — no external processes, works in CI ─────────

type TestWorktree = {
  root: string;
  cleanup: () => void;
};

function makeTestWorktree(metadata?: object | null): TestWorktree {
  const root = mkdtempSync(join(tmpdir(), "hydrate-test-"));
  const beadsDir = join(root, ".beads");
  if (metadata !== null) {
    mkdirSync(beadsDir, { recursive: true });
    if (metadata !== undefined) {
      writeFileSync(join(beadsDir, "metadata.json"), JSON.stringify(metadata));
    }
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const defaultMetadata = { dolt_database: "io_github_bdelanghe_ai_home" };

/**
 * True when a usable `dolt` binary is on PATH. The real-dolt smoke suite
 * self-skips when this is false (or when PRX_DOLT_SMOKE is unset), so CI —
 * which has no dolt — never hard-fails on it.
 */
function doltOnPath(): boolean {
  try {
    return spawnSync("dolt", ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// Gate the real-dolt smoke suite: opt in with PRX_DOLT_SMOKE=1 *and* a dolt
// binary on PATH. (`doltOnPath()` is only probed when the env opt-in is set,
// so a plain `bun test` never shells out.)
const RUN_DOLT_SMOKE = Boolean(process.env.PRX_DOLT_SMOKE) && doltOnPath();

type DepsState = {
  cloneCalls: Array<{ url: string; dest: string }>;
  stopCalls: number;
  renameCalls: Array<{ from: string; to: string }>;
  rmTreeCalls: string[];
  copyCalls: Array<{ src: string; dest: string }>;
};

function makeDeps(
  overrides: Partial<HydrateDeps> & { state?: DepsState; homeDir?: string } = {},
): { deps: HydrateDeps; state: DepsState; homeDir: string } {
  const state: DepsState = overrides.state ?? {
    cloneCalls: [],
    stopCalls: 0,
    renameCalls: [],
    rmTreeCalls: [],
    copyCalls: [],
  };
  // Hermetic HOME so buildDoltMirrorPath never touches the real
  // ~/.local/state/dolt/buffer during tests. Callers can pass their own
  // via overrides.env (HOME key) or overrides.homeDir.
  const envOverride = overrides.env ?? {};
  const homeDir =
    overrides.homeDir ??
    envOverride.HOME ??
    mkdtempSync(join(tmpdir(), "hydrate-home-"));
  const envWithHome: NodeJS.ProcessEnv = { ...envOverride, HOME: homeDir };
  const deps: HydrateDeps = {
    getGitOrigin: overrides.getGitOrigin ?? (() => "git@github.com:bdelanghe/ai-home.git"),
    stopBdDoltServer: overrides.stopBdDoltServer ?? (() => {
      state.stopCalls++;
    }),
    doltClone: overrides.doltClone ?? ((url, dest) => {
      state.cloneCalls.push({ url, dest });
      // Create the destination dir so subsequent "already hydrated" checks work.
      mkdirSync(dest, { recursive: true });
      return { exitCode: 0, stderr: "" };
    }),
    env: envWithHome,
    fsRename: overrides.fsRename ?? ((from, to) => {
      state.renameCalls.push({ from, to });
      renameSync(from, to);
    }),
    rmTree: overrides.rmTree ?? ((path) => {
      state.rmTreeCalls.push(path);
      rmSync(path, { recursive: true, force: true });
    }),
    copyTree: overrides.copyTree ?? ((src, dest) => {
      state.copyCalls.push({ src, dest });
      mkdirSync(dest, { recursive: true });
    }),
    // GH-653: default to "primary" so existing tests don't trip the new
    // feature-worktree skip gate. Tests that exercise the gate inject their
    // own resolver. Identity (cwd === main) keeps hydrate on its previous
    // code paths byte-for-byte.
    resolveMainWorktree: overrides.resolveMainWorktree ?? ((cwd) => cwd),
  };
  return { deps, state, homeDir };
}

describe("hydrate", () => {
  const created: TestWorktree[] = [];
  const tmpDirs: string[] = [];
  function track(wt: TestWorktree): TestWorktree {
    created.push(wt);
    return wt;
  }
  function trackTmp(path: string): string {
    tmpDirs.push(path);
    return path;
  }
  afterEach(() => {
    while (created.length) created.pop()!.cleanup();
    while (tmpDirs.length) {
      const p = tmpDirs.pop()!;
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test("skips when .beads directory is absent", () => {
    const wt = track(makeTestWorktree(null));
    const { deps, state } = makeDeps();
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-no-beads");
    expect(state.cloneCalls).toHaveLength(0);
  });

  test("skips when metadata.json is missing", () => {
    const wt = track(makeTestWorktree(undefined));
    const { deps, state } = makeDeps();
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-no-metadata");
    expect(state.cloneCalls).toHaveLength(0);
  });

  test("skips when metadata.json lacks dolt_database", () => {
    const wt = track(makeTestWorktree({ unrelated: "x" }));
    const { deps } = makeDeps();
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-no-metadata");
  });

  test("short-circuits when the dolt db dir already exists", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    mkdirSync(join(wt.root, ".beads", "dolt", "io_github_bdelanghe_ai_home"), {
      recursive: true,
    });
    const { deps, state } = makeDeps();
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("already-hydrated");
    expect(state.cloneCalls).toHaveLength(0);
    expect(state.stopCalls).toBe(0);
  });

  test("skips when git origin is not set", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const { deps, state } = makeDeps({ getGitOrigin: () => null });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-no-origin");
    expect(state.cloneCalls).toHaveLength(0);
  });

  test("skips when git origin has an unparseable shape", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const { deps, state } = makeDeps({
      getGitOrigin: () => "file:///some/local/path",
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-unparseable-origin");
    expect(state.cloneCalls).toHaveLength(0);
  });

  test("dry-run returns the planned URL without cloning", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps, state } = makeDeps({ homeDir });
    const result = hydrate({ cwd: wt.root, dryRun: true }, deps);
    expect(result.status).toBe("dry-run");
    expect(result.doltRemote).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    );
    const expectedMirror = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    expect(result.message).toContain(
      "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    );
    // GH-879: second hop is now a recursive copy, not a `dolt clone file://`.
    expect(result.message).toContain(`would copy ${expectedMirror}`);
    expect(state.cloneCalls).toHaveLength(0);
    expect(state.copyCalls).toHaveLength(0);
    expect(state.stopCalls).toBe(0);
    expect(state.renameCalls).toHaveLength(0);
    expect(state.rmTreeCalls).toHaveLength(0);
  });

  test("happy path (cold host): clones mirror, copies into worktree, reports hydrated", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    // GH-442: simulate the world-readable .beads that upstream `bd init` leaves
    // behind so we can assert hydrate hardens it back to 0700.
    chmodSync(join(wt.root, ".beads"), 0o755);
    const { deps, state } = makeDeps({ homeDir });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    // GH-442: hydrate must chmod .beads to 0700 (owner-only).
    expect(statSync(join(wt.root, ".beads")).mode & 0o777).toBe(0o700);
    expect(state.stopCalls).toBe(1);
    // GH-879: only the first hop calls dolt clone. The second hop is a copy.
    expect(state.cloneCalls).toHaveLength(1);
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    expect(state.cloneCalls[0]!.url).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/ai-home",
    );
    expect(state.cloneCalls[0]!.dest.startsWith(`${mirrorPath}.tmp-`)).toBe(true);
    expect(state.renameCalls).toHaveLength(1);
    expect(state.renameCalls[0]!.to).toBe(mirrorPath);
    expect(existsSync(mirrorPath)).toBe(true);
    // Second hop: copy mirror → worktree dbDir.
    expect(state.copyCalls).toHaveLength(1);
    expect(state.copyCalls[0]!.src).toBe(mirrorPath);
    expect(state.copyCalls[0]!.dest).toBe(
      join(wt.root, ".beads", "dolt", "io_github_bdelanghe_ai_home"),
    );
    expect(result.message).toContain(mirrorPath);
  });

  test("warm host: mirror exists, only the worktree copy runs", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    mkdirSync(mirrorPath, { recursive: true });
    const { deps, state } = makeDeps({ homeDir });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    // GH-879: no dolt clone runs on a warm host — the mirror is just copied.
    expect(state.cloneCalls).toHaveLength(0);
    expect(state.copyCalls).toHaveLength(1);
    expect(state.copyCalls[0]!.src).toBe(mirrorPath);
    expect(state.renameCalls).toHaveLength(0);
  });

  test("BEADS_DOLTHUB_OWNER overrides the first URL segment", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps, state } = makeDeps({
      getGitOrigin: () => "git@github.com:anthropic/claude-code.git",
      env: { BEADS_DOLTHUB_OWNER: "bdelanghe" },
      homeDir,
    });
    // Metadata still points at ai-home db, but that's irrelevant for URL
    // derivation — the test only checks what gets passed to doltClone.
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    expect(state.cloneCalls[0]!.url).toBe(
      "https://doltremoteapi.dolthub.com/bdelanghe/claude-code",
    );
  });

  test("mirror clone failure: no worktree clone, no stale mirror dir", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps, state } = makeDeps({
      homeDir,
      doltClone: (url, dest) => {
        state.cloneCalls.push({ url, dest });
        if (url.startsWith("https://")) return { exitCode: 1, stderr: "" };
        mkdirSync(dest, { recursive: true });
        return { exitCode: 0, stderr: "" };
      },
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("clone-failed");
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("mirror clone failed");
    expect(state.cloneCalls).toHaveLength(1);
    expect(state.cloneCalls[0]!.url.startsWith("https://")).toBe(true);
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    expect(existsSync(mirrorPath)).toBe(false);
    // tmp dir cleaned up
    expect(state.rmTreeCalls).toHaveLength(1);
    expect(state.rmTreeCalls[0]!.startsWith(`${mirrorPath}.tmp-`)).toBe(true);
    expect(state.renameCalls).toHaveLength(0);
  });

  test("worktree copy failure: mirror preserved on disk for retry (GH-879)", () => {
    // GH-879: the second hop is now a copy, not a `dolt clone file://`.
    // When the copy throws (permission denied, ENOSPC, etc.) the failure
    // surfaces as `clone-failed` with the JS error message embedded, and
    // the per-host mirror is left intact so a retry can reuse it.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps } = makeDeps({
      homeDir,
      copyTree: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("clone-failed");
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("worktree copy failed");
    expect(result.message).toContain("EACCES");
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    expect(existsSync(mirrorPath)).toBe(true);
  });

  test("concurrency race: ENOTEMPTY on rename reuses existing mirror", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    // Pre-populate the mirror with a sentinel that must not be overwritten.
    // (The real-world race is: another hydrate populated the mirror after
    // our existsSync check returned false.)
    const sentinelPath = join(mirrorPath, "sentinel.txt");
    // Deliberately don't create the mirror yet — the race is simulated by
    // making fsRename throw ENOTEMPTY. But ensureMirror's first hop still
    // runs, so we must let the clone succeed, then throw on rename, then
    // verify the mirror wasn't clobbered. Pre-create it now so the post-
    // rename existsSync() in hydrate finds it.
    mkdirSync(mirrorPath, { recursive: true });
    writeFileSync(sentinelPath, "race-winner");
    // Remove it again so the existsSync check at the top of the mirror hop
    // returns false — forcing ensureMirror to run. Then the rename throws
    // ENOTEMPTY, we re-materialize the mirror+sentinel to simulate the
    // race winner, and the worktree hop proceeds.
    rmSync(mirrorPath, { recursive: true, force: true });
    let renameAttempts = 0;
    const { deps, state } = makeDeps({
      homeDir,
      fsRename: (_from, to) => {
        renameAttempts++;
        // Simulate race winner populating the mirror between our clone and
        // our rename.
        mkdirSync(to, { recursive: true });
        writeFileSync(join(to, "sentinel.txt"), "race-winner");
        const err: NodeJS.ErrnoException = Object.assign(
          new Error("ENOTEMPTY: directory not empty"),
          { code: "ENOTEMPTY" },
        );
        throw err;
      },
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    expect(renameAttempts).toBe(1);
    expect(existsSync(mirrorPath)).toBe(true);
    expect(readFileSync(sentinelPath, "utf8")).toBe("race-winner");
    // tmp cleaned up
    expect(state.rmTreeCalls.length).toBeGreaterThanOrEqual(1);
    expect(state.rmTreeCalls[0]!.startsWith(`${mirrorPath}.tmp-`)).toBe(true);
    // GH-879: second hop is a copy (not a file:// dolt clone) and still ran.
    expect(state.copyCalls).toHaveLength(1);
    expect(state.copyCalls[0]!.src).toBe(mirrorPath);
  });

  test("BEADS_DOLT_MIRROR_ROOT overrides the mirror root", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const customRoot = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-custom-root-")));
    const { deps, state } = makeDeps({
      env: { BEADS_DOLT_MIRROR_ROOT: customRoot },
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    const expectedMirror = join(
      customRoot,
      "bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    expect(state.renameCalls[0]!.to).toBe(expectedMirror);
    // GH-879: the override propagates to the copy source as well.
    expect(state.copyCalls[0]!.src).toBe(expectedMirror);
  });

  test("mirror clone failure surfaces dolt stderr instead of guessing auth (GH-821)", () => {
    // Regression: the wrapper used to append a canned "run 'dolt login'"
    // hint to every clone failure, which misled operators when the real
    // error was unrelated to auth. The stderr must appear in the message
    // and the canned login hint must be gone. GH-879 collapsed the second
    // hop into a copy, so this regression now applies only to the first
    // hop (`dolt clone <doltHubUrl>`).
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const realDoltStderr =
      "cloning https://doltremoteapi.dolthub.com/...\n" +
      "clone failed; remote at that url contains no Dolt data";
    const { deps } = makeDeps({
      homeDir,
      doltClone: (_url, _dest) => ({ exitCode: 1, stderr: realDoltStderr }),
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("clone-failed");
    expect(result.message).toContain("mirror clone failed");
    expect(result.message).toContain("dolt stderr:");
    expect(result.message).toContain("contains no Dolt data");
    expect(result.message).not.toContain("dolt login");
  });

  test("clone failure with empty stderr omits the stderr block", () => {
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps } = makeDeps({
      homeDir,
      doltClone: () => ({ exitCode: 1, stderr: "   \n  " }),
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("clone-failed");
    expect(result.message).not.toContain("dolt stderr:");
  });

  test("second hop never invokes dolt clone file:// (GH-879)", () => {
    // GH-879: dolt 1.86.x rejects file:// clones of working repos with
    // "no Dolt data" because their NBS store contains a chunk journal.
    // hydrate() must not invoke `dolt clone file://...` at all — the
    // second hop is a recursive copy. Failing the first hop's URL check
    // here is enough to verify: if hydrate ever tried a file:// clone,
    // doltClone would record it and we'd fail the assertion.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    mkdirSync(mirrorPath, { recursive: true });
    const { deps, state } = makeDeps({ homeDir });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    // No dolt invocation at all on a warm host with a populated mirror.
    expect(state.cloneCalls).toHaveLength(0);
    // Exactly one copy from the mirror into the worktree dolt dir.
    expect(state.copyCalls).toHaveLength(1);
    expect(state.copyCalls[0]!.src).toBe(mirrorPath);
    expect(state.copyCalls[0]!.dest).toBe(
      join(wt.root, ".beads", "dolt", "io_github_bdelanghe_ai_home"),
    );
  });

  test("worktree copy uses real fs.cpSync against a populated mirror (GH-879 integration)", () => {
    // End-to-end check that the default copyTree (fs.cpSync) reproduces
    // every file in the mirror to the worktree, including subdirs and
    // dolt-style hidden config. Pre-populate a mirror with a fixture
    // that mimics dolt's on-disk layout (`.dolt/config.json`,
    // `.dolt/repo_state.json`, a chunk-archive file under
    // `.dolt/noms/`) and verify the worktree dolt dir is byte-identical.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const mirrorPath = join(
      homeDir,
      ".local/state/dolt/buffer/bdelanghe/ai-home/io_github_bdelanghe_ai_home",
    );
    mkdirSync(join(mirrorPath, ".dolt", "noms"), { recursive: true });
    writeFileSync(join(mirrorPath, ".dolt", "config.json"), '{"user.name":"beads"}');
    writeFileSync(
      join(mirrorPath, ".dolt", "repo_state.json"),
      '{"head":"refs/heads/main"}',
    );
    writeFileSync(
      join(mirrorPath, ".dolt", "noms", "abc123.darc"),
      "binary-chunk-data",
    );
    // Use the real fs.cpSync as copyTree to verify the production code
    // path produces the expected on-disk shape.
    const { deps } = makeDeps({
      homeDir,
      copyTree: (src, dest) => cpSync(src, dest, { recursive: true }),
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    const dbDir = join(wt.root, ".beads", "dolt", "io_github_bdelanghe_ai_home");
    expect(existsSync(dbDir)).toBe(true);
    expect(readFileSync(join(dbDir, ".dolt", "config.json"), "utf8")).toBe(
      '{"user.name":"beads"}',
    );
    expect(readFileSync(join(dbDir, ".dolt", "repo_state.json"), "utf8")).toBe(
      '{"head":"refs/heads/main"}',
    );
    expect(readFileSync(join(dbDir, ".dolt", "noms", "abc123.darc"), "utf8")).toBe(
      "binary-chunk-data",
    );
  });

  test("GH-653: feature worktree short-circuits before any clone or server stop", () => {
    // Pre-GH-653 hydrate happily copied the mirror into a feature worktree,
    // producing a second Dolt server bound to the wrong data dir. The fix:
    // when `resolveMainWorktree(cwd)` reports a different path than `cwd`,
    // hydrate must return immediately with `skipped-non-primary-worktree`
    // and never invoke the clone, copy, or `bd dolt stop` deps.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const fakePrimary = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-primary-")));
    const { deps, state } = makeDeps({
      homeDir,
      resolveMainWorktree: () => fakePrimary,
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-non-primary-worktree");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("feature worktree");
    expect(result.message).toContain(fakePrimary);
    expect(result.doltDatabase).toBe("io_github_bdelanghe_ai_home");
    expect(state.cloneCalls).toHaveLength(0);
    expect(state.copyCalls).toHaveLength(0);
    expect(state.stopCalls).toBe(0);
  });

  test("GH-653: primary worktree (resolveMainWorktree === cwd) hydrates normally", () => {
    // Confirms the new gate doesn't false-positive on the primary itself.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps, state } = makeDeps({
      homeDir,
      resolveMainWorktree: (cwd) => cwd,
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("hydrated");
    expect(state.cloneCalls).toHaveLength(1);
    expect(state.copyCalls).toHaveLength(1);
    expect(state.stopCalls).toBe(1);
  });

  test("GH-653: non-git cwd (resolveMainWorktree → null) falls through to existing logic", () => {
    // Defensive: when classification is impossible, hydrate must not
    // short-circuit on GH-653 grounds — it should reach the existing
    // `skipped-no-origin` path so the existing semantics are preserved.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps } = makeDeps({
      homeDir,
      resolveMainWorktree: () => null,
      getGitOrigin: () => null,
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("skipped-no-origin");
  });

  test("clone failure reports clone-failed with a non-zero exit code (GH-657)", () => {
    // Callers need a non-zero exit to distinguish a failed clone from
    // the healthy skip statuses (already-hydrated, skipped-no-beads).
    // Previously this returned exitCode 0 to keep the worktrunk
    // post-switch chain from failing — but that silently swallowed
    // clone failures, leaving worktrees with an empty dolt server and
    // no breadcrumb back to the root cause.
    const wt = track(makeTestWorktree(defaultMetadata));
    const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
    const { deps } = makeDeps({
      doltClone: () => ({ exitCode: 1, stderr: "" }),
      homeDir,
    });
    const result = hydrate({ cwd: wt.root }, deps);
    expect(result.status).toBe("clone-failed");
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("clone failed");
  });

  // ── opt-in real-`dolt` smoke (GH-826) ──────────────────────────────────────
  // The mocked-deps tests above never exercise dolt itself. This suite drives
  // the *production* hydrate() end to end against a real local Dolt remote:
  // hop 1 is a genuine `dolt clone`, hop 2 a genuine `fs.cpSync` — no mocked
  // fs/clone deps in the path under test. That's the layer that missed the
  // original GH-826 regression (a working-repo mirror that `dolt clone file://`
  // then rejected); GH-879 fixed it by copying the directory instead. Gated on
  // PRX_DOLT_SMOKE + a dolt binary, so a plain `bun test` (and CI, which has no
  // dolt) skips it rather than failing.
  describe.skipIf(!RUN_DOLT_SMOKE)("real-dolt hydrate smoke (GH-826)", () => {
    test("hop 1 = real `dolt clone`, hop 2 = real fs.cpSync; worktree repo is queryable and keeps its origin", () => {
      // Hermetic dolt global config/creds so the fixture never touches ~/.dolt.
      const doltRoot = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-dolt-root-")));
      const doltEnv: NodeJS.ProcessEnv = { ...process.env, DOLT_ROOT_PATH: doltRoot };
      const runDolt = (
        args: string[],
        cwd?: string,
      ): { status: number; stdout: string; stderr: string } => {
        const r = spawnSync("dolt", args, {
          cwd,
          env: doltEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return {
          status: r.status ?? 1,
          stdout: (r.stdout ?? "").toString(),
          stderr: (r.stderr ?? "").toString(),
        };
      };

      // Build a real local "remote": `dolt init` → seed a row → push to a
      // file:// path (the remote-format store `dolt clone file://` accepts —
      // pushing is what turns a working repo into that layout).
      const workDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-dolt-work-")));
      const remoteDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-dolt-remote-")));
      const remoteUrl = `file://${remoteDir}`;
      expect(
        runDolt(
          ["init", "--name", "prx smoke", "--email", "prx-smoke@example.com", "-b", "main"],
          workDir,
        ).status,
      ).toBe(0);
      expect(
        runDolt(["sql", "-q", "CREATE TABLE smoke (id INT PRIMARY KEY, msg VARCHAR(64));"], workDir).status,
      ).toBe(0);
      expect(
        runDolt(["sql", "-q", "INSERT INTO smoke VALUES (1, 'hydrate-roundtrip');"], workDir).status,
      ).toBe(0);
      expect(runDolt(["add", "."], workDir).status).toBe(0);
      expect(runDolt(["commit", "-m", "seed smoke table"], workDir).status).toBe(0);
      expect(runDolt(["remote", "add", "origin", remoteUrl], workDir).status).toBe(0);
      expect(runDolt(["push", "origin", "main"], workDir).status).toBe(0);

      // hydrate() with production deps: real fs.cpSync for hop 2; a thin
      // doltClone that shells to the *real* `dolt clone <localRemote>` for hop
      // 1 (the derived DoltHub URL is irrelevant here — we substitute the
      // local fixture remote). Everything else stays on the makeDeps defaults.
      const wt = track(makeTestWorktree(defaultMetadata));
      const homeDir = trackTmp(mkdtempSync(join(tmpdir(), "hydrate-home-")));
      const { deps } = makeDeps({
        homeDir,
        copyTree: (src, dest) => cpSync(src, dest, { recursive: true }),
        doltClone: (_derivedDoltHubUrl, dest) => {
          const r = spawnSync("dolt", ["clone", remoteUrl, dest], {
            env: doltEnv,
            encoding: "utf8",
            stdio: ["ignore", "ignore", "pipe"],
          });
          return { exitCode: r.status ?? 1, stderr: (r.stderr ?? "").toString() };
        },
      });

      const result = hydrate({ cwd: wt.root }, deps);
      expect(result.status).toBe("hydrated");

      const dbDir = join(wt.root, ".beads", "dolt", "io_github_bdelanghe_ai_home");
      expect(existsSync(join(dbDir, ".dolt"))).toBe(true);

      // The worktree dir is a usable Dolt repo: clean status + the seeded row.
      expect(runDolt(["status"], dbDir).stdout).toContain("working tree clean");
      const sql = runDolt(["sql", "-q", "SELECT msg FROM smoke;", "-r", "csv"], dbDir);
      expect(sql.status).toBe(0);
      expect(sql.stdout).toContain("hydrate-roundtrip");

      // The copy preserved the mirror's `origin` remote — a bare clone would
      // have dropped it (the GH-826 reason for not making the mirror bare).
      const remotes = runDolt(["remote", "-v"], dbDir);
      expect(remotes.status).toBe(0);
      const remoteBasename = remoteDir.slice(remoteDir.lastIndexOf("/") + 1);
      expect(remotes.stdout).toContain("origin");
      expect(remotes.stdout).toContain(remoteBasename);
    });
  });
});

describe("readDoltDatabaseName", () => {
  const created: TestWorktree[] = [];
  afterEach(() => {
    while (created.length) created.pop()!.cleanup();
  });

  test("returns the field when present", () => {
    const wt = makeTestWorktree({ dolt_database: "some_db" });
    created.push(wt);
    expect(readDoltDatabaseName(join(wt.root, ".beads"))).toBe("some_db");
  });

  test("returns null when field is missing", () => {
    const wt = makeTestWorktree({ other: "x" });
    created.push(wt);
    expect(readDoltDatabaseName(join(wt.root, ".beads"))).toBeNull();
  });

  test("returns null when file is absent", () => {
    const wt = makeTestWorktree(undefined);
    created.push(wt);
    expect(readDoltDatabaseName(join(wt.root, ".beads"))).toBeNull();
  });
});

describe("isEmbeddedDoltMode (GH-1691)", () => {
  const created: TestWorktree[] = [];
  afterEach(() => {
    while (created.length) created.pop()!.cleanup();
  });

  test("returns true when dolt_mode is 'embedded'", () => {
    const wt = makeTestWorktree({ dolt_mode: "embedded", dolt_database: "x" });
    created.push(wt);
    expect(isEmbeddedDoltMode(join(wt.root, ".beads"))).toBe(true);
  });

  test("returns false when dolt_mode is 'per-project'", () => {
    const wt = makeTestWorktree({ dolt_mode: "per-project", dolt_database: "x" });
    created.push(wt);
    expect(isEmbeddedDoltMode(join(wt.root, ".beads"))).toBe(false);
  });

  test("returns false when dolt_mode field is missing", () => {
    const wt = makeTestWorktree({ dolt_database: "x" });
    created.push(wt);
    expect(isEmbeddedDoltMode(join(wt.root, ".beads"))).toBe(false);
  });

  test("returns false when metadata.json is absent", () => {
    const wt = makeTestWorktree(undefined);
    created.push(wt);
    expect(isEmbeddedDoltMode(join(wt.root, ".beads"))).toBe(false);
  });

  test("returns false when metadata.json is malformed JSON", () => {
    const wt = makeTestWorktree({});
    created.push(wt);
    writeFileSync(join(wt.root, ".beads", "metadata.json"), "{not-json");
    expect(isEmbeddedDoltMode(join(wt.root, ".beads"))).toBe(false);
  });
});

describe("formatHydrateResult", () => {
  const sample: HydrateResult = {
    status: "hydrated",
    doltRemote: "https://example.com/a/b",
    doltDatabase: "db",
    message: "ok",
    exitCode: 0,
  };

  test("plain returns the message verbatim", () => {
    expect(formatHydrateResult(sample, "plain")).toBe("ok");
  });

  test("json returns valid JSON with all fields", () => {
    const parsed = JSON.parse(formatHydrateResult(sample, "json"));
    expect(parsed.status).toBe("hydrated");
    expect(parsed.doltRemote).toBe("https://example.com/a/b");
  });
});
