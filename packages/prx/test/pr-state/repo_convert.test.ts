import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { RepositoryStore, openRegistry } from "../../src/pr-state/registry_store.ts";
import { convertWorktreeToBare, RepoConvertError } from "../../src/pr-state/repo_convert.ts";
import type { RepoRunner } from "../../src/pr-state/repos.ts";

type RunnerResponse = { stdout: string; stderr: string; status: number };
type RunnerCall = { cmd: string[]; cwd: string };

function ok(stdout: string): RunnerResponse {
  return { stdout, stderr: "", status: 0 };
}
function fail(stderr: string, status = 1): RunnerResponse {
  return { stdout: "", stderr, status };
}

function makeRunner(
  map: Map<string, RunnerResponse | RunnerResponse[]>,
  calls: RunnerCall[] = [],
): RepoRunner {
  const cursors = new Map<string, number>();
  return (cmd, options = {}) => {
    const cwd = options.cwd ?? "";
    calls.push({ cmd, cwd });
    const key = `${cmd.join(" ")}|${cwd}`;
    const entry = map.get(key);
    if (!entry) {
      return { stdout: "", stderr: `unmocked: ${key}`, status: 1 };
    }
    if (Array.isArray(entry)) {
      const idx = cursors.get(key) ?? 0;
      const resp = entry[Math.min(idx, entry.length - 1)]!;
      cursors.set(key, idx + 1);
      return resp;
    }
    return entry;
  };
}

const ORIGIN = "https://github.com/bdelanghe/ai-home.git";
const HEAD_SHA = "1111111111111111111111111111111111111111";

type Fixture = { root: string; worktree: string; bareRoot: string; targetBare: string };

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-convert-"));
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  writeFileSync(join(worktree, "README.md"), "hello\n");
  const bareRoot = join(root, "bare-root");
  const targetBare = join(bareRoot, "com.github", "bdelanghe", "ai-home.git");
  return { root, worktree, bareRoot, targetBare };
}

function teardownFixture(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

function baseResponses(worktree: string): Map<string, RunnerResponse | RunnerResponse[]> {
  return new Map<string, RunnerResponse | RunnerResponse[]>([
    [`git rev-parse --git-common-dir|${worktree}`, ok(`${worktree}/.git\n`)],
    [`git remote get-url origin|${worktree}`, ok(`${ORIGIN}\n`)],
    [`git symbolic-ref --short refs/remotes/origin/HEAD|${worktree}`, ok("origin/main\n")],
    [
      `git worktree list --porcelain|${worktree}`,
      ok(`worktree ${worktree}\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n\n`),
    ],
    [`git rev-parse HEAD|${worktree}`, ok(`${HEAD_SHA}\n`)],
    [`git symbolic-ref --short HEAD|${worktree}`, ok("main\n")],
    [`git status --porcelain|${worktree}`, ok("")],
  ]);
}

function withConvertResponses(
  f: Fixture,
  responses: Map<string, RunnerResponse | RunnerResponse[]>,
  branch = "main",
): Map<string, RunnerResponse | RunnerResponse[]> {
  responses.set(`git config core.bare true|${f.targetBare}`, ok(""));
  responses.set(`git config extensions.worktreeConfig true|${f.targetBare}`, ok(""));
  responses.set(`git -C ${f.targetBare} worktree add ${f.worktree} ${branch}|`, ok(""));
  responses.set(`git config --worktree core.bare false|${f.worktree}`, ok(""));
  return responses;
}

function makeStore(dir: string): { store: RepositoryStore; close: () => void } {
  const db = openRegistry(join(dir, "registry.sqlite"));
  return { store: new RepositoryStore(db), close: () => db.close() };
}

describe("convertWorktreeToBare", () => {
  test("happy path: clean workdir, no siblings", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          const calls: RunnerCall[] = [];
          const runner = makeRunner(responses, calls);
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
          if (result.kind !== "converted") throw new Error("unreachable");
          expect(result.plan.targetBarePath).toBe(f.targetBare);
          expect(result.stashed).toBe(false);
          expect(result.repairedSiblings).toEqual([]);
          expect(result.adopt.kind).toBe("adopted");
          expect(existsSync(f.targetBare)).toBe(true);
          expect(existsSync(join(f.worktree, "README.md"))).toBe(true);
          expect(existsSync(`${f.worktree}.prx-backup`)).toBe(false);
          // Regression: a linked worktree must never inherit core.bare=true
          // from the bare's shared config (breaks `git status`, etc. — see
          // markWorktreeNotBare doc comment).
          expect(calls).toContainEqual({
            cmd: ["git", "config", "extensions.worktreeConfig", "true"],
            cwd: f.targetBare,
          });
          expect(calls).toContainEqual({
            cmd: ["git", "config", "--worktree", "core.bare", "false"],
            cwd: f.worktree,
          });
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("happy path with tracked changes: stash push -> worktree add on captured branch -> stash pop clean", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(`git status --porcelain|${f.worktree}`, ok(" M README.md\n"));
          responses.set(
            `git stash push -u -m prx repo convert-to-bare: 2026-01-01T00:00:00.000Z|${f.worktree}`,
            ok(""),
          );
          responses.set(
            `git stash list|${f.worktree}`,
            ok("stash@{0}: On main: prx repo convert-to-bare: 2026-01-01T00:00:00.000Z\n"),
          );
          responses.set(`git stash pop|${f.worktree}`, ok(""));
          const calls: RunnerCall[] = [];
          const runner = makeRunner(responses, calls);
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
          if (result.kind !== "converted") throw new Error("unreachable");
          expect(result.stashed).toBe(true);
          const stashPushIdx = calls.findIndex((c) => c.cmd[1] === "stash" && c.cmd[2] === "push");
          const worktreeAddIdx = calls.findIndex(
            (c) => c.cmd.includes("worktree") && c.cmd.includes("add"),
          );
          const stashPopIdx = calls.findIndex((c) => c.cmd[1] === "stash" && c.cmd[2] === "pop");
          expect(stashPushIdx).toBeGreaterThanOrEqual(0);
          expect(worktreeAddIdx).toBeGreaterThan(stashPushIdx);
          expect(stashPopIdx).toBeGreaterThan(worktreeAddIdx);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("happy path with sibling worktrees: repair runs with explicit paths, second pass fixes stragglers", () => {
    const f = setupFixture();
    const sibling = join(f.root, "sibling-wt");
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(
            `git worktree list --porcelain|${f.worktree}`,
            ok(
              `worktree ${f.worktree}\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n\n` +
                `worktree ${sibling}\nHEAD ${HEAD_SHA}\nbranch refs/heads/feature\n\n`,
            ),
          );
          // First verification (post first repair pass) still broken; second
          // verification (post second pass) resolves to the new bare.
          responses.set(`git rev-parse --git-common-dir|${sibling}`, [
            fail("fatal: not a git repository"),
            ok(`${f.targetBare}\n`),
          ]);
          responses.set(`git config --worktree core.bare false|${sibling}`, ok(""));
          const calls: RunnerCall[] = [];
          const runner = makeRunner(responses, calls);
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
          if (result.kind !== "converted") throw new Error("unreachable");
          expect(result.repairedSiblings).toEqual([sibling]);
          const repairCalls = calls.filter(
            (c) => c.cmd.includes("worktree") && c.cmd.includes("repair"),
          );
          expect(repairCalls.length).toBe(2);
          expect(repairCalls[0]!.cmd).toContain(sibling);
          expect(repairCalls[1]!.cmd).toContain(sibling);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  // Regression: a real conversion (bounded-systems/site) hit a repo with a
  // pre-existing, unrelated stash sitting in stash@{0} ("WIP on
  // feat/sri-csp") from months earlier. `git status --porcelain` showed a
  // change (a bare submodule pointer bump), but `git stash push` didn't
  // consider it stash-worthy and created no new entry — yet the code still
  // believed it had stashed something and blindly popped stash@{0},
  // producing a real merge conflict against completely unrelated old WIP.
  test("does not pop a pre-existing unrelated stash when push created no new entry", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(`git status --porcelain|${f.worktree}`, ok(" M brand\n"));
          responses.set(
            `git stash push -u -m prx repo convert-to-bare: 2026-01-01T00:00:00.000Z|${f.worktree}`,
            ok("No local changes to save\n"),
          );
          // A pre-existing, unrelated stash sits at stash@{0} — our push
          // never created a new entry, so this is what stash list reports.
          responses.set(
            `git stash list|${f.worktree}`,
            ok("stash@{0}: WIP on feat/sri-csp: 7624fb5 own the security headers\n"),
          );
          const calls: RunnerCall[] = [];
          const runner = makeRunner(responses, calls);
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
          if (result.kind !== "converted") throw new Error("unreachable");
          expect(result.stashed).toBe(false);
          expect(calls.some((c) => c.cmd[1] === "stash" && c.cmd[2] === "pop")).toBe(false);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("initializes submodules in the fresh main worktree after checkout", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(`git submodule update --init --recursive|${f.worktree}`, ok(""));
          const inner = makeRunner(responses);
          // `git worktree add` is mocked and doesn't touch the real fs;
          // simulate its real effect (checking .gitmodules back out) so the
          // submodule-init step has something real to detect.
          const runner: RepoRunner = (cmd, options) => {
            if (cmd.includes("worktree") && cmd.includes("add")) {
              writeFileSync(
                join(f.worktree, ".gitmodules"),
                '[submodule "brand"]\n\tpath = brand\n',
              );
            }
            return inner(cmd, options);
          };
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("throws with backup preserved when submodule init fails", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(
            `git submodule update --init --recursive|${f.worktree}`,
            fail("fatal: could not fetch submodule"),
          );
          const inner = makeRunner(responses);
          const runner: RepoRunner = (cmd, options) => {
            if (cmd.includes("worktree") && cmd.includes("add")) {
              writeFileSync(
                join(f.worktree, ".gitmodules"),
                '[submodule "brand"]\n\tpath = brand\n',
              );
            }
            return inner(cmd, options);
          };
          let thrown: unknown;
          try {
            convertWorktreeToBare({
              worktreePath: f.worktree,
              bareRoot: f.bareRoot,
              store,
              runner,
              now: () => new Date("2026-01-01T00:00:00.000Z"),
            });
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(RepoConvertError);
          expect((thrown as RepoConvertError).code).toBe("submodule_init_failed");
          expect(existsSync(`${f.worktree}.prx-backup`)).toBe(true);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  // Regression: a real conversion hit a sibling worktree whose submodule's
  // own gitdir pointer (a separate, absolute-path reference baked in at
  // `git submodule update --init` time) went stale after the bare moved —
  // `git worktree repair` only fixes the sibling's own top-level pointer,
  // never a submodule's nested one.
  test("repairs a stale submodule gitdir pointer inside a sibling worktree", () => {
    const f = setupFixture();
    const sibling = join(f.root, "sibling-wt");
    try {
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, ".gitmodules"), '[submodule "brand"]\n\tpath = brand\n');
      // Simulates the state *after* `git worktree repair` has already fixed
      // the sibling's own top-level pointer (that part is exercised by the
      // "happy path with sibling worktrees" test above; this test is only
      // about the submodule's separate, nested pointer).
      // Deliberately NOT nested under f.targetBare — that path must not
      // exist yet when convertWorktreeToBare's precondition check runs;
      // this only needs to be *some* real path the sibling's own pointer
      // resolves to, standing in for "the bare, post-move."
      const siblingAdminDir = join(f.root, "post-repair-admin", "sibling-wt");
      writeFileSync(join(sibling, ".git"), `gitdir: ${siblingAdminDir}\n`);
      mkdirSync(join(siblingAdminDir, "modules", "brand"), { recursive: true });
      mkdirSync(join(sibling, "brand"), { recursive: true });
      writeFileSync(join(sibling, "brand", ".git"), "gitdir: /some/stale/old/path/modules/brand\n");

      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(
            `git worktree list --porcelain|${f.worktree}`,
            ok(
              `worktree ${f.worktree}\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n\n` +
                `worktree ${sibling}\nHEAD ${HEAD_SHA}\nbranch refs/heads/feature\n\n`,
            ),
          );
          responses.set(`git rev-parse --git-common-dir|${sibling}`, ok(`${f.targetBare}\n`));
          responses.set(`git config --worktree core.bare false|${sibling}`, ok(""));
          responses.set(
            `git config --file ${join(sibling, ".gitmodules")} --get-regexp submodule\\..*\\.path|${sibling}`,
            ok("submodule.brand.path brand\n"),
          );
          const newGitdir = join(siblingAdminDir, "modules", "brand");
          const submoduleWorktreePath = join(sibling, "brand");
          responses.set(
            `git config --file ${join(newGitdir, "config")} core.worktree ${submoduleWorktreePath}|${sibling}`,
            ok(""),
          );
          const calls: RunnerCall[] = [];
          const runner = makeRunner(responses, calls);
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
          expect(readFileSync(join(sibling, "brand", ".git"), "utf8")).toBe(
            `gitdir: ${newGitdir}\n`,
          );
          // Regression: a submodule's own `config` also carries a stale
          // *relative* core.worktree computed at its original init time
          // (before the bare moved) — `git worktree repair` never touches
          // this either. Fixed with an absolute path instead of trying to
          // recompute the relative depth by hand.
          expect(calls).toContainEqual({
            cmd: [
              "git",
              "config",
              "--file",
              join(newGitdir, "config"),
              "core.worktree",
              submoduleWorktreePath,
            ],
            cwd: sibling,
          });
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("throws when a sibling worktree stays broken after two repair passes", () => {
    const f = setupFixture();
    const sibling = join(f.root, "sibling-wt");
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(
            `git worktree list --porcelain|${f.worktree}`,
            ok(
              `worktree ${f.worktree}\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n\n` +
                `worktree ${sibling}\nHEAD ${HEAD_SHA}\nbranch refs/heads/feature\n\n`,
            ),
          );
          responses.set(
            `git rev-parse --git-common-dir|${sibling}`,
            fail("fatal: not a git repository"),
          );
          const runner = makeRunner(responses);
          let thrown: unknown;
          try {
            convertWorktreeToBare({
              worktreePath: f.worktree,
              bareRoot: f.bareRoot,
              store,
              runner,
              now: () => new Date("2026-01-01T00:00:00.000Z"),
            });
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(RepoConvertError);
          expect((thrown as RepoConvertError).code).toBe("sibling_repair_incomplete");
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("locked worktree that cannot be unlocked refuses with guidance", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(
            `git worktree list --porcelain|${f.worktree}`,
            ok(
              `worktree ${f.worktree}\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\nlocked stale PID 4242\n\n`,
            ),
          );
          responses.set(
            `git worktree unlock ${f.worktree}|${f.worktree}`,
            fail("fatal: cannot unlock"),
          );
          const runner = makeRunner(responses);
          let thrown: unknown;
          try {
            convertWorktreeToBare({
              worktreePath: f.worktree,
              bareRoot: f.bareRoot,
              store,
              runner,
              now: () => new Date("2026-01-01T00:00:00.000Z"),
            });
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(RepoConvertError);
          expect((thrown as RepoConvertError).code).toBe("worktree_locked");
          // No mutation attempted.
          expect(existsSync(join(f.worktree, ".git"))).toBe(true);
          expect(existsSync(f.targetBare)).toBe(false);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("refuses immediately when the target bare path already exists", () => {
    const f = setupFixture();
    mkdirSync(f.targetBare, { recursive: true });
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = baseResponses(f.worktree);
          const runner = makeRunner(responses);
          let thrown: unknown;
          try {
            convertWorktreeToBare({
              worktreePath: f.worktree,
              bareRoot: f.bareRoot,
              store,
              runner,
              now: () => new Date("2026-01-01T00:00:00.000Z"),
            });
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(RepoConvertError);
          expect((thrown as RepoConvertError).code).toBe("bare_path_exists");
          expect(existsSync(join(f.worktree, ".git"))).toBe(true);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("stash pop conflict throws and preserves the backup", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          responses.set(`git status --porcelain|${f.worktree}`, ok(" M README.md\n"));
          responses.set(
            `git stash push -u -m prx repo convert-to-bare: 2026-01-01T00:00:00.000Z|${f.worktree}`,
            ok(""),
          );
          responses.set(
            `git stash list|${f.worktree}`,
            ok("stash@{0}: On main: prx repo convert-to-bare: 2026-01-01T00:00:00.000Z\n"),
          );
          responses.set(
            `git stash pop|${f.worktree}`,
            fail("CONFLICT (content): Merge conflict in README.md"),
          );
          const runner = makeRunner(responses);
          let thrown: unknown;
          try {
            convertWorktreeToBare({
              worktreePath: f.worktree,
              bareRoot: f.bareRoot,
              store,
              runner,
              now: () => new Date("2026-01-01T00:00:00.000Z"),
            });
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(RepoConvertError);
          expect((thrown as RepoConvertError).code).toBe("stash_pop_conflict");
          expect(existsSync(`${f.worktree}.prx-backup`)).toBe(true);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  // Regression: a real (unmocked) `git worktree add` checks tracked files
  // back out for real, so "already exists at this path in the fresh
  // worktree" is the *normal* case for every tracked file, not a conflict —
  // and for a stashed file, the backup's copy is the clean pre-push
  // snapshot (stash push reverts the tree before the rename), so it will
  // legitimately differ from the popped copy. Content at a shared path is
  // git's own responsibility; reconcile must leave it alone rather than
  // flag or overwrite it.
  test("leaves a file alone (and still succeeds) when the fresh worktree already has one at that path", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = withConvertResponses(f, baseResponses(f.worktree));
          const inner = makeRunner(responses);
          // `git worktree add` is mocked and does not touch the real fs;
          // simulate its real effect (checking a tracked file back out) so
          // reconcile sees a genuine "already there" case to skip.
          const runner: RepoRunner = (cmd, options) => {
            if (cmd.includes("worktree") && cmd.includes("add")) {
              writeFileSync(join(f.worktree, "README.md"), "checked out by worktree add\n");
            }
            return inner(cmd, options);
          };
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("converted");
          expect(existsSync(`${f.worktree}.prx-backup`)).toBe(false);
          expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe(
            "checked out by worktree add\n",
          );
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });

  test("--dry-run reports the plan without issuing any mutating git calls", () => {
    const f = setupFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), "prx-convert-store-"));
      try {
        const { store, close } = makeStore(dir);
        try {
          const responses = baseResponses(f.worktree);
          const calls: RunnerCall[] = [];
          const runner = makeRunner(responses, calls);
          const result = convertWorktreeToBare({
            worktreePath: f.worktree,
            bareRoot: f.bareRoot,
            store,
            runner,
            dryRun: true,
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          });
          expect(result.kind).toBe("planned");
          if (result.kind !== "planned") throw new Error("unreachable");
          expect(result.plan.targetBarePath).toBe(f.targetBare);
          expect(result.plan.branch).toBe("main");
          expect(result.plan.willStash).toBe(false);
          const mutating = calls.filter(
            (c) =>
              ["stash", "add", "repair"].some((verb) => c.cmd.includes(verb)) ||
              (c.cmd[0] === "git" && c.cmd[1] === "config"),
          );
          expect(mutating).toEqual([]);
          expect(existsSync(f.targetBare)).toBe(false);
          expect(existsSync(join(f.worktree, ".git"))).toBe(true);
        } finally {
          close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardownFixture(f);
    }
  });
});
