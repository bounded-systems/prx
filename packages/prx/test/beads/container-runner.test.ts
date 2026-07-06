import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  containerBdRunner,
  containerRepoRunner,
  containerBdDoltPush,
  containerDoltClone,
  readHostDoltIdentity,
  resolveGitCommonDir,
} from "../../src/beads/container-runner.ts";
import { renderBdLifecycleArgs } from "../../src/room/lifecycle-runner.ts";
import type { PodmanRunResult } from "../../src/room/podman-runtime.ts";

function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function gitInit(cwd: string): void {
  const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  spawnSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", cwd, "config", "user.name", "test"]);
  spawnSync("git", ["-C", cwd, "config", "commit.gpgsign", "false"]);
}

/** A bare repo + a linked worktree off it — this ecosystem's usual shape
 *  (`prx repo materialize`/`repo add`), NOT the plain primary+linked shape
 *  `resolveMainWorktree` targets (see primary_worktree.test.ts's GH-1680
 *  regression case, which this mirrors). */
function makeBareWithWorktree(): { bare: string; worktree: string; cleanup: () => void } {
  const root = mkTmp("container-runner-");
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  gitInit(seed);
  spawnSync("git", ["-C", seed, "commit", "-q", "--allow-empty", "-m", "seed"]);

  const bare = join(root, "scratch.git");
  const cloneResult = spawnSync("git", ["clone", "--bare", "-q", seed, bare], { encoding: "utf8" });
  if (cloneResult.status !== 0) throw new Error(`git clone --bare failed: ${cloneResult.stderr}`);

  const worktree = join(root, "mainx");
  const wtResult = spawnSync("git", ["-C", bare, "worktree", "add", "-q", "--detach", worktree, "main"], {
    encoding: "utf8",
  });
  if (wtResult.status !== 0) throw new Error(`git worktree add failed: ${wtResult.stderr}`);

  return { bare, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("resolveGitCommonDir", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("returns the bare repo's path for a linked worktree off it", () => {
    const fixture = makeBareWithWorktree();
    cleanup = fixture.cleanup;
    expect(resolveGitCommonDir(fixture.worktree)).toBe(fixture.bare);
  });

  test("returns undefined for a self-contained checkout (common-dir is already under repo)", () => {
    const root = mkTmp("container-runner-self-");
    cleanup = () => rmSync(root, { recursive: true, force: true });
    gitInit(root);
    expect(resolveGitCommonDir(root)).toBeUndefined();
  });

  test("returns undefined when git fails (not a repo)", () => {
    expect(resolveGitCommonDir("/nonexistent/definitely/not/a/path-XYZ")).toBeUndefined();
  });
});

describe("containerBdRunner — threads commonDir through for a linked worktree (regression)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("mounts the bare repo identity-mapped alongside /work", () => {
    const fixture = makeBareWithWorktree();
    cleanup = fixture.cleanup;
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "ok", stderr: "" };
    };
    containerBdRunner(run)(["bd", "init", "--prefix=x"], { cwd: fixture.worktree });
    expect(seen).toContain(`${fixture.bare}:${fixture.bare}`);
    expect(seen).toContain(`${fixture.worktree}:/work`);
  });
});

describe("containerBdRunner — bd lifecycle ops in an ephemeral container (prx-82b 2c.2)", () => {
  test("maps cmd[0]→entrypoint, cwd→/work, and the podman result→SpawnCaptureResult", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const runner = containerBdRunner(run);
    const res = runner(["bd", "init", "--non-interactive", "--prefix=x"], { cwd: "/abs/repo" });

    // The bd op ran in the container against the repo bind.
    expect(seen).toEqual(
      renderBdLifecycleArgs({ repo: "/abs/repo", bin: "bd", args: ["init", "--non-interactive", "--prefix=x"] }),
    );
    // Adapted to the BdInitRunner/BdMigrateRunner result shape.
    expect(res).toEqual({ status: 0, signal: null, stdout: "ok", stderr: "" });
  });

  test("a non-zero container exit maps to a capture failure (status preserved)", () => {
    const run = (): PodmanRunResult => ({ status: 1, stdout: "", stderr: "boom" });
    const res = containerBdRunner(run)(["bd", "migrate"], { cwd: "/r" });
    expect(res.status).toBe(1);
    expect(res.stderr).toBe("boom");
    expect(res.signal).toBeNull();
  });

  test("the host-bd env/homeOverride arg is ignored (clean container fs makes it moot)", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "", stderr: "" };
    };
    containerBdRunner(run)(["bd", "config", "set", "k", "v"], {
      cwd: "/r",
      env: { HOME: "/some/host/tmp" },
    });
    // No host HOME leaks into the podman argv — the runner sets HOME=/tmp itself.
    expect(seen).not.toContain("/some/host/tmp");
    expect(seen?.[seen.indexOf("-e") + 1]).toBe("HOME=/tmp");
  });
});

describe("containerRepoRunner — RepoRunner-shaped (bd dolt remote add)", () => {
  test("runs the dolt op in-container and returns {stdout,stderr,status:number}", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "added", stderr: "" };
    };
    const res = containerRepoRunner(run)(["bd", "dolt", "remote", "add", "origin", "u"], { cwd: "/r" });
    expect(seen).toEqual(
      renderBdLifecycleArgs({ repo: "/r", bin: "bd", args: ["dolt", "remote", "add", "origin", "u"] }),
    );
    expect(res).toEqual({ stdout: "added", stderr: "", status: 0 });
  });

  test("a null podman status maps to 1 (RepoRunner wants a number)", () => {
    const run = (): PodmanRunResult => ({ status: null, stdout: "", stderr: "x" });
    expect(containerRepoRunner(run)(["bd", "dolt", "remote", "add"], { cwd: "/r" }).status).toBe(1);
  });
});

describe("readHostDoltIdentity + containerBdDoltPush (prx-82b 2c.5)", () => {
  const CFG = JSON.stringify({
    "user.creds": "onr6skey",
    "user.email": "me@example.com",
    "user.name": "bdelanghe",
  });

  test("readHostDoltIdentity parses the dolt global config", () => {
    const id = readHostDoltIdentity(() => CFG);
    expect(id).toEqual({ credsKey: "onr6skey", email: "me@example.com", name: "bdelanghe" });
  });

  test("readHostDoltIdentity throws when no active creds are configured", () => {
    expect(() => readHostDoltIdentity(() => "{}")).toThrow(/user\.creds/);
  });

  test("containerBdDoltPush mounts the creds secret + identity env + installs the jwk", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "pushed", stderr: "" };
    };
    const push = containerBdDoltPush(run, {
      credsKey: "onr6skey",
      email: "me@example.com",
      name: "bdelanghe",
    });
    const res = push("/work/repo", "main");

    expect(res).toEqual({ stdout: "pushed", stderr: "", status: 0 });
    const joined = seen!.join(" ");
    // creds ride the room-secret rail; identity is non-secret env.
    expect(joined).toContain("--secret prx-dolt-creds,target=/run/secrets/dolt-creds");
    expect(joined).toContain("-e DOLT_CREDS_KEY=onr6skey");
    expect(joined).toContain("-e DOLT_USER_EMAIL=me@example.com");
    // runs the install-then-push wrapper under sh, against the repo bind.
    expect(seen!).toContain("/work/repo:/work");
    expect(joined).toContain("install -m600 /run/secrets/dolt-creds");
    expect(joined).toContain("bd dolt push origin");
    expect(seen!.slice(-2)).toEqual(["_", "main"]);
  });
});

describe("containerDoltClone — hydrate clone off host (prx-82b 2d)", () => {
  test("binds the dest parent at /work, clones into it, creds via the secret rail", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "", stderr: "" };
    };
    const clone = containerDoltClone(run, { credsKey: "k", email: "e", name: "n" });
    const res = clone("https://doltremoteapi.dolthub.com/o/db", "/buf/o/repo/db/tmp123");

    expect(res).toEqual({ exitCode: 0, stderr: "" });
    const joined = seen!.join(" ");
    expect(seen!).toContain("/buf/o/repo/db:/work"); // dest PARENT bound at /work
    expect(joined).toContain("--secret prx-dolt-creds,target=/run/secrets/dolt-creds");
    expect(joined).toContain("-e DOLT_CREDS_KEY=k");
    expect(joined).toContain("dolt clone");
    // url + basename(dest) passed as the sh positionals.
    expect(seen!.slice(-2)).toEqual(["https://doltremoteapi.dolthub.com/o/db", "tmp123"]);
  });

  test("a non-zero clone maps to exitCode (status null → 1)", () => {
    const run = (): PodmanRunResult => ({ status: null, stdout: "", stderr: "auth" });
    const res = containerDoltClone(run, { credsKey: "k", email: "", name: "" })("u", "/p/d");
    expect(res).toEqual({ exitCode: 1, stderr: "auth" });
  });
});
