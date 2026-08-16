/**
 * Tests for bootstrapWorktree (GH-495).
 *
 * Uses real tmpdir fixtures rather than mocks so the tests exercise node:fs,
 * git (where relevant), and the real file-layout assertions that the hook
 * will rely on in production.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  bootstrapWorktree,
  formatBootstrapResult,
  type BootstrapDeps,
} from "../../src/tools/bootstrap_worktree.ts";

function mkTmp(prefix: string): string {
  // Resolve symlinks so `/tmp` → `/private/tmp` matches what git/bd see.
  return require("node:fs").realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

type Fixture = {
  root: string;
  mainWorktree: string;
  workWorktree: string;
  cleanup: () => void;
};

function makeTwoWorktreeFixture(opts: { withMainBeads: boolean; withPrxToml: boolean }): Fixture {
  const root = mkTmp("bootstrap-worktree-");
  const mainWorktree = join(root, "main");
  const workWorktree = join(root, "work");
  mkdirSync(mainWorktree, { recursive: true });
  mkdirSync(workWorktree, { recursive: true });

  if (opts.withMainBeads) {
    mkdirSync(join(mainWorktree, ".beads"), { recursive: true });
    writeFileSync(
      join(mainWorktree, ".beads", "metadata.json"),
      JSON.stringify({ dolt_database: "test_db" }),
    );
  }
  if (opts.withPrxToml) {
    writeFileSync(join(mainWorktree, "prx.toml"), '[project]\nowner = "test"\n');
  }

  return {
    root,
    mainWorktree,
    workWorktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function depsFor(fixture: Fixture, init?: (path: string) => Promise<unknown>): BootstrapDeps {
  return {
    resolveMainWorktree: () => fixture.mainWorktree,
    resolveRepoRoot: () => fixture.mainWorktree,
    initContract:
      init ??
      (async (contractPath) => {
        mkdirSync(join(fixture.mainWorktree, ".pr", "local"), { recursive: true });
        writeFileSync(contractPath, JSON.stringify({ title: "test" }));
      }),
    // GH-1152: tests stay hermetic by default — no real `bd` shell-out.
    // Cases that exercise the auto-trigger override this with a stub.
    repairBdSchema: null,
  };
}

describe("bootstrapWorktree — beads redirect step", () => {
  let fixture: Fixture;

  afterEach(() => fixture?.cleanup());

  test("writes a relative redirect when worktree has .beads but no dolt data", () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    mkdirSync(join(fixture.workWorktree, ".beads"), { recursive: true });
    writeFileSync(
      join(fixture.workWorktree, ".beads", "metadata.json"),
      JSON.stringify({ dolt_database: "test_db" }),
    );

    return bootstrapWorktree(fixture.workWorktree, depsFor(fixture)).then((result) => {
      expect(result.beads.status).toBe("wrote-redirect");
      const redirectPath = join(fixture.workWorktree, ".beads", "redirect");
      expect(existsSync(redirectPath)).toBe(true);
      const content = readFileSync(redirectPath, "utf8");
      // Trailing newline (matches upstream `bd worktree create` format).
      expect(content.endsWith("\n")).toBe(true);
      // Relative path from <work>/.beads/ to <main>/.beads.
      const target = content.trim();
      const resolvedTarget = resolve(join(fixture.workWorktree, ".beads"), target);
      expect(resolvedTarget).toBe(resolve(fixture.mainWorktree, ".beads"));
    });
  });

  test("skips when .beads does not exist", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("skipped-no-beads");
  });

  test("skips when redirect already points at the correct target (GH-653)", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(workBeads, { recursive: true });
    const expected = `${relative(workBeads, join(fixture.mainWorktree, ".beads"))}\n`;
    writeFileSync(join(workBeads, "redirect"), expected);

    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("skipped-redirect-exists");
  });

  test("GH-653: feature worktree with stale dolt data still gets a redirect", async () => {
    // Regression: pre-GH-653 this returned `skipped-already-hydrated` and
    // never wrote a redirect, leaving the feature worktree pointed at its
    // own (wrong) Dolt server. The fix: classification is structural, so
    // the populated dolt dir does not short-circuit the redirect write.
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(join(workBeads, "dolt", "test_db"), { recursive: true });
    writeFileSync(join(workBeads, "metadata.json"), JSON.stringify({ dolt_database: "test_db" }));

    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("wrote-redirect");
    expect(existsSync(join(workBeads, "redirect"))).toBe(true);
    expect(result.beads.staleState?.dolt).toBe(true);
  });

  test("GH-653: rewrites a redirect that points at the wrong target", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(workBeads, { recursive: true });
    writeFileSync(join(workBeads, "redirect"), "../../wrong/.beads\n");

    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("rewrote-redirect-target");
    const content = readFileSync(join(workBeads, "redirect"), "utf8").trim();
    const resolvedTarget = resolve(workBeads, content);
    expect(resolvedTarget).toBe(resolve(fixture.mainWorktree, ".beads"));
    expect(result.beads.message).toContain("rewrote redirect");
  });

  test("GH-653: idempotent on a correctly-pointed redirect", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(workBeads, { recursive: true });
    // Write the canonical redirect ourselves; bootstrap must recognize it.
    const expectedContent = `${relative(workBeads, join(fixture.mainWorktree, ".beads"))}\n`;
    writeFileSync(join(workBeads, "redirect"), expectedContent);

    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("skipped-redirect-exists");
    // File contents must remain byte-identical.
    expect(readFileSync(join(workBeads, "redirect"), "utf8")).toBe(expectedContent);
  });

  test("GH-653: surfaces stale dolt-server.{pid,port,lock} on a feature worktree", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(workBeads, { recursive: true });
    writeFileSync(join(workBeads, "dolt-server.pid"), "12345\n");
    writeFileSync(join(workBeads, "dolt-server.port"), "60313\n");
    writeFileSync(join(workBeads, "dolt-server.lock"), "");

    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("wrote-redirect");
    expect(result.beads.staleState).toEqual({
      dolt: false,
      serverPid: true,
      serverPort: true,
      serverLock: true,
    });
  });

  test("GH-653: clean feature worktree omits staleState entirely", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    mkdirSync(join(fixture.workWorktree, ".beads"), { recursive: true });
    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("wrote-redirect");
    expect(result.beads.staleState).toBeUndefined();
  });

  test("skips when git common dir is unresolvable", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    mkdirSync(join(fixture.workWorktree, ".beads"), { recursive: true });
    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      resolveMainWorktree: () => null,
    };
    const result = await bootstrapWorktree(fixture.workWorktree, deps);
    expect(result.beads.status).toBe("skipped-no-git-common-dir");
  });

  test("skips when the main worktree has no .beads directory", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: false, withPrxToml: false });
    mkdirSync(join(fixture.workWorktree, ".beads"), { recursive: true });
    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("skipped-no-main-beads");
  });

  test("skips when cwd IS the main worktree (standalone repo)", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    // Use the main path as the cwd to simulate running the hook in the
    // primary worktree rather than a linked one.
    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      resolveMainWorktree: () => fixture.mainWorktree,
    };
    // .beads already exists on main from the fixture.
    const result = await bootstrapWorktree(fixture.mainWorktree, deps);
    expect(result.beads.status).toBe("skipped-main-is-cwd");
  });
});

describe("bootstrapWorktree — beads dir permissions (GH-442)", () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  test("hardens .beads to 0700 when it starts at 0755", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const beadsDir = join(fixture.workWorktree, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    chmodSync(beadsDir, 0o755);

    const result = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(result.beads.status).toBe("wrote-redirect");
    expect(statSync(beadsDir).mode & 0o777).toBe(0o700);
  });

  test("re-running bootstrap leaves .beads at 0700 (idempotent)", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const beadsDir = join(fixture.workWorktree, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    chmodSync(beadsDir, 0o755);

    await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(statSync(beadsDir).mode & 0o777).toBe(0o700);

    // Second run: redirect already exists, but chmod must still hold mode at 0700.
    const second = await bootstrapWorktree(fixture.workWorktree, depsFor(fixture));
    expect(second.beads.status).toBe("skipped-redirect-exists");
    expect(statSync(beadsDir).mode & 0o777).toBe(0o700);
    expect(second.exitCode).toBe(0);
  });
});

describe("bootstrapWorktree — prx contract step", () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  test("calls initContract when prx.toml exists and contract is missing", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: false, withPrxToml: true });
    const calls: string[] = [];
    const deps: BootstrapDeps = {
      ...depsFor(fixture, async (path) => {
        calls.push(path);
        mkdirSync(join(fixture.mainWorktree, ".pr", "local"), { recursive: true });
        writeFileSync(path, "{}");
      }),
      resolveRepoRoot: () => fixture.mainWorktree,
    };
    const result = await bootstrapWorktree(fixture.mainWorktree, deps);
    expect(result.contract.status).toBe("wrote-contract");
    expect(calls).toEqual([join(fixture.mainWorktree, ".pr", "local", "pr.json")]);
  });

  test("skips when prx.toml does not exist", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: false, withPrxToml: false });
    const result = await bootstrapWorktree(fixture.mainWorktree, depsFor(fixture));
    expect(result.contract.status).toBe("skipped-no-prx-toml");
  });

  test("skips when .pr/local/pr.json already exists", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: false, withPrxToml: true });
    mkdirSync(join(fixture.mainWorktree, ".pr", "local"), { recursive: true });
    writeFileSync(join(fixture.mainWorktree, ".pr", "local", "pr.json"), "{}");
    const result = await bootstrapWorktree(fixture.mainWorktree, depsFor(fixture));
    expect(result.contract.status).toBe("skipped-contract-exists");
  });

  test("records error when initContract throws", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: false, withPrxToml: true });
    const deps: BootstrapDeps = {
      ...depsFor(fixture, async () => {
        throw new Error("init failed");
      }),
    };
    const result = await bootstrapWorktree(fixture.mainWorktree, deps);
    expect(result.contract.status).toBe("error");
    expect(result.contract.message).toBe("init failed");
    expect(result.exitCode).toBe(1);
  });
});

describe("bootstrapWorktree — bd schema auto-trigger (GH-1152)", () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  test("invokes repair after writing a fresh redirect", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    mkdirSync(join(fixture.workWorktree, ".beads"), { recursive: true });
    writeFileSync(
      join(fixture.workWorktree, ".beads", "metadata.json"),
      JSON.stringify({ dolt_database: "test_db" }),
    );

    const calls: string[] = [];
    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      repairBdSchema: (cwd) => {
        calls.push(cwd);
        return { status: "repaired", durationMs: 12, command: "bd stats --json" };
      },
    };

    const result = await bootstrapWorktree(fixture.workWorktree, deps);
    expect(result.beads.status).toBe("wrote-redirect");
    expect(calls).toEqual([fixture.workWorktree]);
    expect(result.beads.schemaRepair?.status).toBe("repaired");
  });

  test("invokes repair after writing a redirect over stale dolt data (GH-653)", async () => {
    // Pre-GH-653: status was `skipped-already-hydrated` and repair was
    // invoked against the buggy local dolt dir. Post-GH-653: a feature
    // worktree with stale dolt data writes a fresh redirect, and repair
    // still runs (against the redirect target — primary's .beads).
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(join(workBeads, "dolt", "test_db"), { recursive: true });
    writeFileSync(join(workBeads, "metadata.json"), JSON.stringify({ dolt_database: "test_db" }));

    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      repairBdSchema: () => ({
        status: "already_healthy",
        durationMs: 4,
        command: "bd stats --json",
      }),
    };

    const result = await bootstrapWorktree(fixture.workWorktree, deps);
    expect(result.beads.status).toBe("wrote-redirect");
    expect(result.beads.schemaRepair?.status).toBe("already_healthy");
  });

  test("invokes repair on the skipped-redirect-exists branch", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    const workBeads = join(fixture.workWorktree, ".beads");
    mkdirSync(workBeads, { recursive: true });
    const expected = `${relative(workBeads, join(fixture.mainWorktree, ".beads"))}\n`;
    writeFileSync(join(workBeads, "redirect"), expected);

    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      repairBdSchema: () => ({
        status: "already_healthy",
        durationMs: 1,
        command: "bd stats --json",
      }),
    };

    const result = await bootstrapWorktree(fixture.workWorktree, deps);
    expect(result.beads.status).toBe("skipped-redirect-exists");
    expect(result.beads.schemaRepair?.status).toBe("already_healthy");
  });

  test("does NOT invoke repair when there is no .beads directory", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    let called = 0;
    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      repairBdSchema: () => {
        called += 1;
        return { status: "already_healthy", durationMs: 0, command: "bd stats --json" };
      },
    };
    const result = await bootstrapWorktree(fixture.workWorktree, deps);
    expect(result.beads.status).toBe("skipped-no-beads");
    expect(called).toBe(0);
    expect(result.beads.schemaRepair).toBeUndefined();
  });

  test("repair throwing does not fail bootstrap", async () => {
    fixture = makeTwoWorktreeFixture({ withMainBeads: true, withPrxToml: false });
    mkdirSync(join(fixture.workWorktree, ".beads"), { recursive: true });
    writeFileSync(
      join(fixture.workWorktree, ".beads", "metadata.json"),
      JSON.stringify({ dolt_database: "test_db" }),
    );

    const deps: BootstrapDeps = {
      ...depsFor(fixture),
      repairBdSchema: () => {
        throw new Error("bd binary missing");
      },
    };

    const result = await bootstrapWorktree(fixture.workWorktree, deps);
    expect(result.beads.status).toBe("wrote-redirect");
    expect(result.beads.schemaRepair?.status).toBe("repair_failed");
    expect(result.beads.schemaRepair?.message).toContain("bd binary missing");
    expect(result.exitCode).toBe(0);
  });
});

describe("formatBootstrapResult", () => {
  test("json format round-trips the full structure", () => {
    const out = formatBootstrapResult(
      {
        beads: {
          status: "wrote-redirect",
          redirectPath: "/a/.beads/redirect",
          redirectTarget: "/b/.beads",
        },
        contract: { status: "wrote-contract", contractPath: "/a/.pr/local/pr.json" },
        exitCode: 0,
      },
      "json",
    );
    expect(JSON.parse(out).beads.status).toBe("wrote-redirect");
  });

  test("plain format includes both step statuses", () => {
    const out = formatBootstrapResult(
      {
        beads: { status: "skipped-no-beads", redirectPath: null, redirectTarget: null },
        contract: { status: "skipped-no-prx-toml", contractPath: null },
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toContain("beads: skipped-no-beads");
    expect(out).toContain("contract: skipped-no-prx-toml");
  });
});
