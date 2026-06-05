import { describe, expect, test } from "bun:test";

import {
  detectSchemaConflict,
  runDoltReconcile,
  type DoltReconcileDeps,
  type DoltReconcileResult,
  type DoltReconcileSpawnResult,
} from "../../src/pr-state/dolt-reconcile.ts";
import { runCli } from "../../src/pr-state/cli.ts";

type SpawnCall = {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
};

function makeFixture(responses: Record<string, DoltReconcileSpawnResult>) {
  const logs: string[] = [];
  const errs: string[] = [];
  const spawnCalls: SpawnCall[] = [];

  const deps: DoltReconcileDeps = {
    spawn: (file, args, opts) => {
      spawnCalls.push({ file, args, cwd: opts.cwd, env: opts.env });
      const key = args.join(" ");
      const match = responses[key];
      if (!match) {
        return { status: 1, stdout: "", stderr: `unexpected spawn: ${key}` };
      }
      return match;
    },
    env: { BEADS_DIR: "/should/be/stripped", PATH: "/usr/bin" },
  };

  const output = {
    log: (line: string) => logs.push(line),
    error: (line: string) => errs.push(line),
  };

  return { logs, errs, spawnCalls, deps, output };
}

describe("runDoltReconcile", () => {
  test("happy path runs commit → pull → push and reports reconciled", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 0 },
      "dolt push": { status: 0 },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.spawnCalls.map((c) => c.args.join(" "))).toEqual([
      "dolt commit",
      "dolt pull",
      "dolt push",
    ]);
    expect(fx.spawnCalls.every((c) => c.file === "bd")).toBe(true);
    expect(fx.spawnCalls.every((c) => c.cwd === "/repo")).toBe(true);
    expect(fx.spawnCalls.every((c) => c.env?.BEADS_DIR === undefined)).toBe(true);

    const plain = fx.logs.join("\n");
    expect(plain).toContain("commit: ok");
    expect(plain).toContain("pull:   ok");
    expect(plain).toContain("push:   ok");
    expect(plain).toContain("state: reconciled");
    expect(fx.errs).toEqual([]);
  });

  test("`nothing to commit` on commit step is skipped and pipeline continues", () => {
    const fx = makeFixture({
      "dolt commit": { status: 1, stderr: "error: nothing to commit\n" },
      "dolt pull": { status: 0 },
      "dolt push": { status: 0 },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.spawnCalls).toHaveLength(3);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("commit: skipped");
    expect(plain).toContain("state: reconciled");
  });

  test("commit failure (other than nothing-to-commit) short-circuits before pull", () => {
    const fx = makeFixture({
      "dolt commit": { status: 1, stderr: "fatal: permission denied\n" },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    expect(fx.spawnCalls).toHaveLength(1);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("commit: failed (exit 1)");
    expect(plain).toContain("state: stuck");
    expect(plain).toContain("permission denied");
  });

  test("pull failure with stderr shows stderr tail in hint", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 1, stderr: "merge conflict in comments\n" },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    expect(fx.spawnCalls.map((c) => c.args.join(" "))).toEqual([
      "dolt commit",
      "dolt pull",
    ]);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("pull:   failed (exit 1)");
    expect(plain).toContain("state: stuck");
    expect(plain).toContain("bd dolt pull failed: merge conflict in comments");
  });

  test("pull failure with no stderr emits generic conflict hint", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 1 },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("state: stuck");
    expect(plain).toContain("if this is a conflict, resolve it in the `.beads/` database");
  });

  test("multi-line hint indents continuation lines in plain output", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": {
        status: 1,
        stderr: "line one\nline two\nline three\n",
      },
    });

    runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    const plain = fx.logs.join("\n");
    expect(plain).toContain("hint:  bd dolt pull failed: line one");
    expect(plain).toContain("       line two");
    expect(plain).toContain("       line three");
  });

  test("push failure yields stuck state with push-specific hint", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 0 },
      "dolt push": { status: 1, stderr: "non-fast-forward\n" },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    expect(fx.spawnCalls).toHaveLength(3);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("push:   failed (exit 1)");
    expect(plain).toContain("state: stuck");
    expect(plain).toContain("dolt push rejected");
  });

  test("push failure with dangling-ref error names the hash and points at local state", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 0 },
      "dolt push": {
        status: 1,
        stderr: "error: dangling references\nHashSet {srj3edj34khcs29gv6absmhhcjm55a1r}\n",
      },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("push:   failed (exit 1)");
    expect(plain).toContain("state: stuck");
    expect(plain).toContain("unreachable chunks referenced by srj3edj34khcs29gv6absmhhcjm55a1r");
    expect(plain).toContain("not DoltHub");
    expect(plain).toContain("`prx beads hydrate`");
    expect(plain).not.toContain("dolt push rejected");
  });

  test("dry-run emits preview without spawning any bd process", () => {
    const fx = makeFixture({});

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: true, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.spawnCalls).toEqual([]);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("prx dolt reconcile (dry-run):");
    expect(plain).toContain("would run `bd dolt commit`");
    expect(plain).toContain("would run `bd dolt pull`");
    expect(plain).toContain("would run `bd dolt push`");
    expect(plain).toContain("state: preview");
  });

  test("JSON format returns a parseable DoltReconcileResult", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 0 },
      "dolt push": { status: 0 },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.logs).toHaveLength(1);
    const payload = JSON.parse(fx.logs[0]!) as DoltReconcileResult & { dryRun: boolean };
    expect(payload.state).toBe("reconciled");
    expect(payload.dryRun).toBe(false);
    expect(payload.steps.map((s) => s.step)).toEqual(["commit", "pull", "push"]);
    expect(payload.steps.every((s) => s.status === "ok")).toBe(true);
  });

  test("JSON dry-run payload lists preview steps and dryRun=true", () => {
    const fx = makeFixture({});

    runDoltReconcile(
      { repoPath: "/repo", dryRun: true, format: "json" },
      fx.output,
      fx.deps,
    );

    const payload = JSON.parse(fx.logs[0]!) as DoltReconcileResult & { dryRun: boolean };
    expect(payload.dryRun).toBe(true);
    expect(payload.state).toBe("preview");
    expect(payload.steps.map((s) => s.status)).toEqual(["preview", "preview", "preview"]);
    expect(payload.steps.map((s) => s.command)).toEqual([
      "bd dolt commit",
      "bd dolt pull",
      "bd dolt push",
    ]);
  });
});

describe("schema-conflict detection (GH-993)", () => {
  // Verbatim signature from the GH-993 reproduction (and the closed #742 issue
  // that has the same root cause). Kept as a string constant so tests reproduce
  // the exact stderr operators see in the wild.
  const SCHEMA_CONFLICT_STDERR = [
    "Error: failed to open database:",
    "failed to initialize schema: wisps table: failed to stage dolt_ignore:",
    "Error 1105 (HY000): Merge conflict detected, @autocommit transaction",
    "rolled back. @autocommit must be disabled so that merge conflicts can",
    "be resolved using the dolt_conflicts and dolt_schema_conflicts tables",
    "before manually committing the transaction. Alternatively, to commit",
    "transactions with merge conflicts, set @@dolt_allow_commit_conflicts = 1.",
  ].join("\n");

  test("detectSchemaConflict matches the GH-993 stderr signature and extracts the table name", () => {
    const conflict = detectSchemaConflict(SCHEMA_CONFLICT_STDERR);
    expect(conflict).toEqual({ kind: "schema", table: "wisps" });
  });

  test("detectSchemaConflict returns null for unrelated stderr", () => {
    expect(detectSchemaConflict("fatal: permission denied")).toBeNull();
    expect(detectSchemaConflict("nothing to commit")).toBeNull();
    expect(detectSchemaConflict("")).toBeNull();
    expect(detectSchemaConflict(undefined)).toBeNull();
  });

  test("detectSchemaConflict returns null for generic merge conflict that only mentions @@dolt_allow_commit_conflicts", () => {
    // @@dolt_allow_commit_conflicts appears in generic row-level merge guidance too —
    // not sufficient on its own to classify as a schema conflict.
    const genericMergeStderr = [
      "Error 1105 (HY000): Merge conflict detected, @autocommit transaction",
      "rolled back. Alternatively, to commit transactions with merge conflicts,",
      "set @@dolt_allow_commit_conflicts = 1.",
    ].join("\n");
    expect(detectSchemaConflict(genericMergeStderr)).toBeNull();
  });

  test("detectSchemaConflict matches the signature without a table name", () => {
    const stderr = [
      "Error 1105 (HY000): Merge conflict detected, @autocommit transaction",
      "rolled back. resolve via dolt_schema_conflicts table.",
    ].join("\n");
    expect(detectSchemaConflict(stderr)).toEqual({ kind: "schema" });
  });

  test("detectSchemaConflict extracts table name from 'failed to stage <table>:' format", () => {
    // Copilot thread 2: the stage branch was previously unreachable; verify it now works.
    const stderr = "failed to stage dolt_ignore: some error";
    expect(detectSchemaConflict(`dolt_schema_conflicts\n${stderr}`)).toEqual({
      kind: "schema",
      table: "dolt_ignore",
    });
  });

  test("schema conflict on commit step yields schemaConflictPending and skips pull/push", () => {
    const fx = makeFixture({
      "dolt commit": { status: 1, stderr: SCHEMA_CONFLICT_STDERR },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    expect(fx.spawnCalls.map((c) => c.args.join(" "))).toEqual(["dolt commit"]);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("commit: failed (exit 1)");
    expect(plain).toContain("state: schemaConflictPending");
    expect(plain).toContain("dolt schema-level merge conflict on `wisps`");
    expect(plain).toContain("Same root cause as #742");
    expect(plain).toContain("dolt_schema_conflicts");
    expect(plain).toContain("@@dolt_allow_commit_conflicts = 1");
    expect(plain).toContain("`bd dolt show`");
  });

  test("schema conflict on pull step yields schemaConflictPending and skips push", () => {
    const fx = makeFixture({
      "dolt commit": { status: 0 },
      "dolt pull": { status: 1, stderr: SCHEMA_CONFLICT_STDERR },
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    expect(fx.spawnCalls.map((c) => c.args.join(" "))).toEqual([
      "dolt commit",
      "dolt pull",
    ]);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("commit: ok");
    expect(plain).toContain("pull:   failed (exit 1)");
    expect(plain).toContain("state: schemaConflictPending");
  });

  test("two consecutive runs against the same conflict produce byte-identical output (monotonic status)", () => {
    const responses = { "dolt commit": { status: 1, stderr: SCHEMA_CONFLICT_STDERR } };

    const fx1 = makeFixture(responses);
    runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "json" },
      fx1.output,
      fx1.deps,
    );

    const fx2 = makeFixture(responses);
    runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "json" },
      fx2.output,
      fx2.deps,
    );

    expect(fx1.logs).toEqual(fx2.logs);
    const payload = JSON.parse(fx1.logs[0]!) as DoltReconcileResult;
    expect(payload.state).toBe("schemaConflictPending");
  });

  test("non-schema commit failure still produces state: stuck (regression guard)", () => {
    const fx = makeFixture({
      "dolt commit": { status: 1, stderr: "fatal: permission denied\n" },
    });

    runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    const plain = fx.logs.join("\n");
    expect(plain).toContain("state: stuck");
    expect(plain).not.toContain("schemaConflictPending");
  });

  test("JSON envelope includes conflict projection on schemaConflictPending", () => {
    const fx = makeFixture({
      "dolt commit": { status: 1, stderr: SCHEMA_CONFLICT_STDERR },
    });

    runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    const payload = JSON.parse(fx.logs[0]!) as DoltReconcileResult & { dryRun: boolean };
    expect(payload.state).toBe("schemaConflictPending");
    expect(payload.conflict).toEqual({ kind: "schema", table: "wisps" });
    expect(payload.dryRun).toBe(false);
    expect(payload.hint).toContain("dolt_schema_conflicts");
  });
});

describe("--resolve schema-prefer-remote", () => {
  // Reuse the canonical GH-993 stderr signature.
  const SCHEMA_CONFLICT_STDERR = [
    "Error: failed to open database:",
    "failed to initialize schema: wisps table: failed to stage dolt_ignore:",
    "Error 1105 (HY000): Merge conflict detected, @autocommit transaction",
    "rolled back. @autocommit must be disabled so that merge conflicts can",
    "be resolved using the dolt_conflicts and dolt_schema_conflicts tables",
    "before manually committing the transaction. Alternatively, to commit",
    "transactions with merge conflicts, set @@dolt_allow_commit_conflicts = 1.",
  ].join("\n");

  function makeMatchedFixture(
    matcher: (file: string, args: string[]) => DoltReconcileSpawnResult | undefined,
  ) {
    const logs: string[] = [];
    const errs: string[] = [];
    const calls: Array<{ file: string; args: string[] }> = [];

    const deps: DoltReconcileDeps = {
      spawn: (file, args) => {
        calls.push({ file, args });
        const result = matcher(file, args);
        if (!result) {
          return {
            status: 1,
            stdout: "",
            stderr: `unexpected spawn: ${file} ${args.join(" ")}`,
          };
        }
        return result;
      },
      env: { PATH: "/usr/bin" },
    };

    const output = {
      log: (l: string) => logs.push(l),
      error: (e: string) => errs.push(e),
    };

    return { logs, errs, calls, deps, output };
  }

  test("happy path: detect conflict on commit, resolve, retry commit, finish reconciled", () => {
    let bdCommitCalls = 0;
    const fx = makeMatchedFixture((file, args) => {
      if (file === "bd") {
        if (args[0] === "dolt" && args[1] === "commit") {
          bdCommitCalls++;
          if (bdCommitCalls === 1) {
            return { status: 1, stderr: SCHEMA_CONFLICT_STDERR };
          }
          return { status: 0 };
        }
        if (args[0] === "dolt" && args[1] === "pull") return { status: 0 };
        if (args[0] === "dolt" && args[1] === "push") return { status: 0 };
        if (args.join(" ") === "dolt show --format=json") {
          return {
            status: 0,
            stdout: JSON.stringify({
              connection_ok: true,
              port: 3306,
              database: "io_github_bdelanghe_ai_home",
            }),
          };
        }
      }
      if (file === "dolt" && args[0] === "sql") {
        const queryArg = args[args.indexOf("-q") + 1] ?? "";
        if (queryArg.startsWith("SELECT table_name")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              rows: [
                { table_name: "wisps", their_schema: "CREATE TABLE wisps (id INT)" },
              ],
            }),
          };
        }
        if (queryArg.includes("DROP TABLE")) {
          return { status: 0 };
        }
      }
      return undefined;
    });

    const exit = runDoltReconcile(
      {
        repoPath: "/repo",
        dryRun: false,
        format: "plain",
        resolve: "schema-prefer-remote",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(bdCommitCalls).toBe(2);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("commit: failed (exit 1)");
    expect(plain).toContain("resolve-schema: ok");
    expect(plain).toContain("commit: ok");
    expect(plain).toContain("pull:   ok");
    expect(plain).toContain("push:   ok");
    expect(plain).toContain("state: reconciled");
  });

  test("fails fast with bd-dolt-start hint when dolt SQL server is not reachable", () => {
    const fx = makeMatchedFixture((file, args) => {
      if (file === "bd" && args[0] === "dolt" && args[1] === "commit") {
        return { status: 1, stderr: SCHEMA_CONFLICT_STDERR };
      }
      if (file === "bd" && args.join(" ") === "dolt show --format=json") {
        return {
          status: 0,
          stdout: JSON.stringify({
            connection_ok: false,
            port: 0,
            database: "io_github_bdelanghe_ai_home",
          }),
        };
      }
      return undefined;
    });

    const exit = runDoltReconcile(
      {
        repoPath: "/repo",
        dryRun: false,
        format: "plain",
        resolve: "schema-prefer-remote",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("state: schemaConflictPending");
    expect(plain).toContain("resolve-schema:");
    expect(plain).toContain("`bd dolt start`");
    // No `dolt sql` invocation should have happened — the resolver bailed
    // before issuing any SQL.
    expect(fx.calls.find((c) => c.file === "dolt")).toBeUndefined();
  });

  test("schema conflict without --resolve still terminates at schemaConflictPending (no regression)", () => {
    const fx = makeMatchedFixture((file, args) => {
      if (file === "bd" && args[0] === "dolt" && args[1] === "commit") {
        return { status: 1, stderr: SCHEMA_CONFLICT_STDERR };
      }
      return undefined;
    });

    const exit = runDoltReconcile(
      { repoPath: "/repo", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("state: schemaConflictPending");
    expect(plain).not.toContain("resolve-schema:");
  });

  test("clean commit/pull/push with --resolve flag does not invoke the resolver", () => {
    const fx = makeMatchedFixture((file, args) => {
      if (file === "bd" && args[0] === "dolt") {
        if (args[1] === "commit" || args[1] === "pull" || args[1] === "push") {
          return { status: 0 };
        }
      }
      return undefined;
    });

    const exit = runDoltReconcile(
      {
        repoPath: "/repo",
        dryRun: false,
        format: "plain",
        resolve: "schema-prefer-remote",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("state: reconciled");
    expect(plain).not.toContain("resolve-schema:");
    expect(fx.calls.find((c) => c.file === "dolt")).toBeUndefined();
    expect(
      fx.calls.find((c) => c.file === "bd" && c.args.includes("show")),
    ).toBeUndefined();
  });

  test("JSON envelope includes resolve-schema step on successful resolution", () => {
    let bdCommitCalls = 0;
    const fx = makeMatchedFixture((file, args) => {
      if (file === "bd" && args[0] === "dolt") {
        if (args[1] === "commit") {
          bdCommitCalls++;
          return bdCommitCalls === 1
            ? { status: 1, stderr: SCHEMA_CONFLICT_STDERR }
            : { status: 0 };
        }
        if (args[1] === "pull" || args[1] === "push") return { status: 0 };
        if (args.join(" ") === "dolt show --format=json") {
          return {
            status: 0,
            stdout: JSON.stringify({
              connection_ok: true,
              port: 3306,
              database: "io_github_bdelanghe_ai_home",
            }),
          };
        }
      }
      if (file === "dolt" && args[0] === "sql") {
        const queryArg = args[args.indexOf("-q") + 1] ?? "";
        if (queryArg.startsWith("SELECT")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              rows: [
                { table_name: "wisps", their_schema: "CREATE TABLE wisps (id INT)" },
              ],
            }),
          };
        }
        return { status: 0 };
      }
      return undefined;
    });

    const exit = runDoltReconcile(
      {
        repoPath: "/repo",
        dryRun: false,
        format: "json",
        resolve: "schema-prefer-remote",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const payload = JSON.parse(fx.logs[0]!) as DoltReconcileResult & { dryRun: boolean };
    expect(payload.state).toBe("reconciled");
    expect(payload.steps.map((s) => s.step)).toEqual([
      "commit",
      "resolve-schema",
      "commit",
      "pull",
      "push",
    ]);
    const resolveStep = payload.steps.find((s) => s.step === "resolve-schema");
    expect(resolveStep?.status).toBe("ok");
  });

  test("resolver bail when dolt_schema_conflicts query returns no rows", () => {
    const fx = makeMatchedFixture((file, args) => {
      if (file === "bd" && args[0] === "dolt") {
        if (args[1] === "commit") {
          return { status: 1, stderr: SCHEMA_CONFLICT_STDERR };
        }
        if (args.join(" ") === "dolt show --format=json") {
          return {
            status: 0,
            stdout: JSON.stringify({
              connection_ok: true,
              port: 3306,
              database: "io_github_bdelanghe_ai_home",
            }),
          };
        }
      }
      if (file === "dolt" && args[0] === "sql") {
        return { status: 0, stdout: JSON.stringify({ rows: [] }) };
      }
      return undefined;
    });

    const exit = runDoltReconcile(
      {
        repoPath: "/repo",
        dryRun: false,
        format: "plain",
        resolve: "schema-prefer-remote",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    const plain = fx.logs.join("\n");
    expect(plain).toContain("state: schemaConflictPending");
    expect(plain).toContain("resolve-schema:");
    expect(plain).toContain("Resolution sketch");
  });
});

describe("runCli — dolt reconcile dispatch", () => {
  test("`prx dolt reconcile` routes to the injected runDoltReconcile handler with parsed flags", () => {
    const calls: Array<{
      repoPath: string;
      dryRun: boolean;
      format: "plain" | "json";
      resolve?: "schema-prefer-remote" | undefined;
    }> = [];

    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runCli(
      [
        "dolt",
        "reconcile",
        "--repo-path",
        "/alt/repo",
        "--dry-run",
        "--format",
        "json",
      ],
      { log: (l) => logs.push(l), error: (e) => errs.push(e) },
      {
        runDoltReconcile: (options) => {
          calls.push(options);
          return 0;
        },
      },
    );

    expect(exit).toBe(0);
    expect(errs).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toEqual({
      repoPath: "/alt/repo",
      dryRun: true,
      format: "json",
      resolve: undefined,
    });
  });

  test("`prx dolt reconcile --resolve schema-prefer-remote` routes the resolve mode to the handler", () => {
    const calls: Array<{
      repoPath: string;
      dryRun: boolean;
      format: "plain" | "json";
      resolve?: "schema-prefer-remote" | undefined;
    }> = [];
    const exit = runCli(
      ["dolt", "reconcile", "--resolve", "schema-prefer-remote"],
      { log: () => {}, error: () => {} },
      {
        runDoltReconcile: (options) => {
          calls.push(options);
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resolve).toBe("schema-prefer-remote");
  });

  test("runCli rejects an unknown --resolve value", () => {
    const errs: string[] = [];
    const exit = runCli(
      ["dolt", "reconcile", "--resolve", "schema-prefer-local"],
      { log: () => {}, error: (e) => errs.push(e) },
      { runDoltReconcile: () => 0 },
    );
    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toContain("--resolve");
    expect(errs.join("\n")).toContain("schema-prefer-remote");
  });

  test("runCli returns the handler's exit code on stuck reconcile", () => {
    const exit = runCli(
      ["dolt", "reconcile"],
      { log: () => {}, error: () => {} },
      { runDoltReconcile: () => 1 },
    );
    expect(exit).toBe(1);
  });

  test("runCli rejects unknown `dolt` subcommand", () => {
    const errs: string[] = [];
    const exit = runCli(
      ["dolt", "bogus"],
      { log: () => {}, error: (e) => errs.push(e) },
    );
    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toContain("Unknown dolt subcommand: bogus");
  });

  test("runCli rejects `dolt` with no subcommand", () => {
    const errs: string[] = [];
    const exit = runCli(
      ["dolt"],
      { log: () => {}, error: (e) => errs.push(e) },
    );
    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toContain("dolt requires a subcommand");
  });
});
