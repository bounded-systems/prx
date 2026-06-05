import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";

export type DoltReconcileSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type DoltReconcileSpawn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
) => DoltReconcileSpawnResult;

export type DoltReconcileDeps = {
  spawn?: DoltReconcileSpawn;
  env?: NodeJS.ProcessEnv;
};

export type DoltReconcileResolveMode = "schema-prefer-remote";

// GH-1702: pipeline-mode selector. `full` runs commit → pull → push (today's
// default); `push-only` runs commit + push (skip pull); `pull-only` runs only
// pull. The cross-repo fan-out (`prx beads sync-all`) maps its `--push-only`
// / `--pull-only` flags onto this so the per-repo primitive remains the
// single source of truth for the reconcile pipeline.
export type DoltReconcileMode = "full" | "push-only" | "pull-only";

export type DoltReconcileOptions = {
  repoPath: string;
  dryRun: boolean;
  format: "plain" | "json";
  resolve?: DoltReconcileResolveMode | undefined;
  mode?: DoltReconcileMode | undefined;
};

export type DoltReconcileStepName =
  | "commit"
  | "pull"
  | "push"
  | "resolve-schema";

export type DoltReconcileStepStatus = "ok" | "skipped" | "failed" | "preview";

export type DoltReconcileStep = {
  step: DoltReconcileStepName;
  status: DoltReconcileStepStatus;
  exitCode: number;
  stderrTail?: string | undefined;
  command: string;
};

export type DoltReconcileState =
  | "reconciled"
  | "stuck"
  | "preview"
  | "schemaConflictPending";

export type DoltReconcileConflict = {
  kind: "schema";
  table?: string;
};

export type DoltReconcileResult = {
  state: DoltReconcileState;
  steps: DoltReconcileStep[];
  hint?: string;
  conflict?: DoltReconcileConflict;
  // GH-1702: surface the executed pipeline mode so cross-repo callers (and
  // the JSON output) can reflect what subset of commit/pull/push actually
  // ran. Optional for backwards compatibility on `runDoltReconcile`
  // consumers that don't read it.
  mode?: DoltReconcileMode;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

type PipelineStepName = "commit" | "pull" | "push";

const PIPELINE_ORDER: readonly PipelineStepName[] = ["commit", "pull", "push"] as const;

// GH-1702: `push-only` still commits first so push has something to send;
// `pull-only` only pulls. Render-only paths (formatDoltReconcile's "(not run)"
// rows) consult this to decide which steps to elide. Iteration order matches
// PIPELINE_ORDER so the on-screen ladder stays stable.
function pipelineForMode(mode: DoltReconcileMode): readonly PipelineStepName[] {
  switch (mode) {
    case "full":
      return PIPELINE_ORDER;
    case "push-only":
      return ["commit", "push"] as const;
    case "pull-only":
      return ["pull"] as const;
  }
}

const NOTHING_TO_COMMIT = /nothing to commit/i;
const DANGLING_REF = /HashSet\s*\{\s*([a-z0-9]{32})\s*\}/i;

// Schema-merge-conflict detection for wisps/dolt_ignore divergence (GH-993, #742).
// Requires an explicit schema indicator — either dolt_schema_conflicts (always
// present in schema conflicts) or "failed to initialize schema" (the dolt error
// prefix). @@dolt_allow_commit_conflicts alone is NOT sufficient because it also
// appears in generic row-level merge-conflict guidance.
const SCHEMA_CONFLICT_TABLE =
  /failed to (?:(?:initialize schema[^:]*:\s*)|(?:stage\s+))(\w+)(?::|\s+table)/i;

function bdArgs(step: PipelineStepName): string[] {
  return ["dolt", step];
}

function commandString(step: PipelineStepName): string {
  return `bd ${bdArgs(step).join(" ")}`;
}

function tail(text: string | Buffer | null | undefined, maxLines = 4): string {
  if (!text) return "";
  const s = typeof text === "string" ? text : text.toString("utf8");
  const trimmed = s.replace(/\s+$/, "");
  if (trimmed.length === 0) return "";
  const lines = trimmed.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

function stepPreview(step: PipelineStepName): DoltReconcileStep {
  return { step, status: "preview", exitCode: 0, command: commandString(step) };
}

export function detectSchemaConflict(
  stderr: string | Buffer | null | undefined,
): DoltReconcileConflict | null {
  if (!stderr) return null;
  const text = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  const hasExplicitSchemaIndicator =
    /\bdolt_schema_conflicts\b/i.test(text) || /failed to initialize schema/i.test(text);
  if (!hasExplicitSchemaIndicator) return null;
  const tableMatch = text.match(SCHEMA_CONFLICT_TABLE);
  return tableMatch ? { kind: "schema", table: tableMatch[1]! } : { kind: "schema" };
}

function hintForSchemaConflict(table: string | undefined): string {
  const subject = table ? `\`${table}\` (typically \`wisps\` / \`dolt_ignore\`)` : "`wisps` / `dolt_ignore`";
  return [
    `dolt schema-level merge conflict on ${subject}.`,
    "Same root cause as #742; `prx dolt reconcile` cannot auto-resolve schema conflicts.",
    "Resolution sketch (GitHub/upstream is authoritative for beads):",
    "  1. `bd dolt show` to find the dolt SQL server port.",
    "  2. Connect and inspect `dolt_schema_conflicts` to see diverging schemas.",
    "  3. Pick remote schema (the side under DoltHub).",
    "  4. `SET @@dolt_allow_commit_conflicts = 1;` then commit the resolution.",
    "  5. Rerun `prx dolt reconcile` to push the merge.",
  ].join("\n");
}

function hintFor(step: PipelineStepName, stderrTail: string | undefined): string {
  switch (step) {
    case "commit":
      return stderrTail
        ? `bd dolt commit failed: ${stderrTail}`
        : "bd dolt commit failed; inspect the dolt working set and rerun `prx dolt reconcile`.";
    case "pull":
      return stderrTail
        ? `bd dolt pull failed: ${stderrTail}`
        : "bd dolt pull failed; if this is a conflict, resolve it in the `.beads/` database and rerun `prx dolt reconcile`.";
    case "push": {
      const hash = stderrTail?.match(DANGLING_REF)?.[1];
      if (hash) {
        return [
          `bd dolt push reports unreachable chunks referenced by ${hash}.`,
          "This points at local dolt state (worktree or per-host mirror), not DoltHub.",
          "Repair: stop bd (`bd dolt stop`), remove the affected `.beads/dolt/<db>` and re-run `prx beads hydrate`,",
          "or remove `~/.local/state/dolt/buffer/<owner>/<repo>/<db>` if mirror integrity is in doubt.",
        ].join("\n");
      }
      return "dolt push rejected; rerun `prx dolt reconcile` after the remote settles.";
    }
  }
}

type SchemaConflictRow = {
  table_name: string;
  their_schema: string;
};

type DoltShowJson = {
  port?: number;
  database?: string;
  connection_ok?: boolean;
};

type ResolveOutcome = {
  ok: boolean;
  step: DoltReconcileStep;
  hint: string;
};

function readBuffer(value: string | Buffer | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function parseDoltShow(stdout: string): DoltShowJson | null {
  try {
    return JSON.parse(stdout) as DoltShowJson;
  } catch {
    return null;
  }
}

function parseSchemaConflictRows(stdout: string): SchemaConflictRow[] | null {
  // dolt sql --result-format json emits {"rows":[...]} for SELECTs.
  try {
    const payload = JSON.parse(stdout) as { rows?: SchemaConflictRow[] };
    if (!payload || !Array.isArray(payload.rows)) return null;
    return payload.rows.filter(
      (r): r is SchemaConflictRow =>
        typeof r?.table_name === "string" && typeof r?.their_schema === "string",
    );
  } catch {
    return null;
  }
}

function buildResolutionScript(rows: SchemaConflictRow[]): string {
  // Multi-statement script applied via `dolt sql -q`. Each table is
  // dropped and re-created from `their_schema`, then the conflict row is
  // cleared. The final DOLT_COMMIT closes the merge with the resolved
  // schema. SET @@dolt_allow_commit_conflicts is required because the
  // session is mid-merge.
  const stmts: string[] = ["SET @@dolt_allow_commit_conflicts = 1;"];
  for (const row of rows) {
    const t = row.table_name.replace(/`/g, "");
    stmts.push(`DROP TABLE IF EXISTS \`${t}\`;`);
    stmts.push(`${row.their_schema.replace(/;\s*$/, "")};`);
    stmts.push(`DELETE FROM dolt_schema_conflicts WHERE table_name = '${t}';`);
  }
  const tableList = rows.map((r) => r.table_name).join(", ");
  stmts.push(
    `CALL DOLT_COMMIT('-am', 'merge: prefer remote schema for ${tableList}');`,
  );
  return stmts.join("\n");
}

function resolveStep(
  status: "ok" | "failed",
  command: string,
  exitCode: number,
  stderrTail?: string,
): DoltReconcileStep {
  return {
    step: "resolve-schema",
    status,
    exitCode,
    stderrTail: stderrTail || undefined,
    command,
  };
}

function serverDownHint(): string {
  return [
    "dolt SQL server is not running; cannot resolve schema conflict.",
    "Start it with `bd dolt start`, then rerun `prx dolt reconcile --resolve schema-prefer-remote`.",
  ].join("\n");
}

function resolveSchemaPreferRemote(
  spawn: DoltReconcileSpawn,
  env: NodeJS.ProcessEnv,
  options: DoltReconcileOptions,
  conflict: DoltReconcileConflict,
): ResolveOutcome {
  const cwd = options.repoPath;

  // 1. Locate the running dolt SQL server.
  const showCmd = "bd dolt show --format=json";
  const show = spawn("bd", ["dolt", "show", "--format=json"], { cwd, env });
  if (show.error || (show.status ?? 1) !== 0) {
    return {
      ok: false,
      step: resolveStep(
        "failed",
        showCmd,
        show.status ?? 1,
        tail(readBuffer(show.stderr) || show.error?.message),
      ),
      hint: serverDownHint(),
    };
  }
  const showJson = parseDoltShow(readBuffer(show.stdout));
  if (
    !showJson ||
    showJson.connection_ok !== true ||
    typeof showJson.port !== "number" ||
    showJson.port <= 0 ||
    typeof showJson.database !== "string" ||
    showJson.database.length === 0
  ) {
    const showFailureReason = !showJson
      ? "invalid dolt show json"
      : showJson.connection_ok !== true
        ? `connection_ok=${String(showJson.connection_ok)}`
        : typeof showJson.port !== "number" || showJson.port <= 0
          ? `invalid port=${String(showJson.port)}`
          : `missing database=${String(showJson.database)}`;
    return {
      ok: false,
      step: resolveStep("failed", showCmd, 1, showFailureReason),
      hint: serverDownHint(),
    };
  }

  const sqlBaseArgs = [
    "sql",
    "--host",
    "127.0.0.1",
    "--port",
    String(showJson.port),
    "--user",
    "root",
    "--use-db",
    showJson.database,
    "--result-format",
    "json",
  ];

  // 2. Enumerate live schema conflicts. The detected `conflict.table` is a
  //    fallback hint only — `dolt_schema_conflicts` is the authoritative source.
  const queryCmd =
    "dolt sql ... -q \"SELECT table_name, their_schema FROM dolt_schema_conflicts\"";
  const query = spawn(
    "dolt",
    [...sqlBaseArgs, "-q", "SELECT table_name, their_schema FROM dolt_schema_conflicts"],
    { cwd, env },
  );
  if (query.error || (query.status ?? 1) !== 0) {
    return {
      ok: false,
      step: resolveStep(
        "failed",
        queryCmd,
        query.status ?? 1,
        tail(readBuffer(query.stderr) || query.error?.message),
      ),
      hint: hintForSchemaConflict(conflict.table),
    };
  }
  const rows = parseSchemaConflictRows(readBuffer(query.stdout));
  if (!rows || rows.length === 0) {
    return {
      ok: false,
      step: resolveStep(
        "failed",
        queryCmd,
        1,
        "dolt_schema_conflicts returned no rows",
      ),
      hint: hintForSchemaConflict(conflict.table),
    };
  }

  // 3. Apply remote schema and commit the resolution.
  const script = buildResolutionScript(rows);
  const applyCmd = `dolt sql ... -q (schema-prefer-remote: ${rows.map((r) => r.table_name).join(", ")})`;
  const apply = spawn("dolt", [...sqlBaseArgs, "-q", script], { cwd, env });
  if (apply.error || (apply.status ?? 1) !== 0) {
    return {
      ok: false,
      step: resolveStep(
        "failed",
        applyCmd,
        apply.status ?? 1,
        tail(readBuffer(apply.stderr) || apply.error?.message),
      ),
      hint: hintForSchemaConflict(conflict.table),
    };
  }

  return {
    ok: true,
    step: resolveStep("ok", applyCmd, 0),
    hint: "",
  };
}

// GH-1702: core that returns the structured `DoltReconcileResult` plus the
// process exit code. `runDoltReconcile` delegates to this; the cross-repo
// fan-out (`runDoltReconcileAcrossRepos`) calls it directly so it can
// classify per-repo state without re-parsing plain-text output.
export function runDoltReconcileWithResult(
  options: DoltReconcileOptions,
  output: Output,
  deps: DoltReconcileDeps = {},
): { exitCode: number; result: DoltReconcileResult } {
  const spawn: DoltReconcileSpawn =
    deps.spawn ?? ((file, args, opts): DoltReconcileSpawnResult => {
      const r = spawnCapture([file, ...args], opts);
      return {
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.error ? { error: r.error } : {}),
      };
    });
  const baseEnv = deps.env ?? processEnv();
  const env = { ...baseEnv };
  delete env.BEADS_DIR;

  const mode: DoltReconcileMode = options.mode ?? "full";
  const pipeline = pipelineForMode(mode);

  if (options.dryRun) {
    const previewSteps = pipeline.map(stepPreview);
    const result: DoltReconcileResult = { state: "preview", steps: previewSteps, mode };
    output.log(formatDoltReconcile(result, options.format, true));
    return { exitCode: 0, result };
  }

  const steps: DoltReconcileStep[] = [];

  for (const step of pipeline) {
    let resolveAttempted = false;

    // Each step retries in place (via `continue`) after a schema resolution and
    // otherwise exits the loop with break/return — so the loop is unconditional.
    while (true) {
      const args = bdArgs(step);
      const spawnResult = spawn("bd", args, { cwd: options.repoPath, env });

      if (spawnResult.error) {
        const stderrTail = tail(spawnResult.error.message);
        steps.push({
          step,
          status: "failed",
          exitCode: spawnResult.status ?? 1,
          stderrTail,
          command: commandString(step),
        });
        const stuck: DoltReconcileResult = {
          state: "stuck",
          steps,
          hint: hintFor(step, stderrTail),
          mode,
        };
        output.log(formatDoltReconcile(stuck, options.format, false));
        return { exitCode: 1, result: stuck };
      }

      const exitCode = spawnResult.status ?? 1;
      const stderrTail = tail(spawnResult.stderr);

      if (exitCode === 0) {
        steps.push({
          step,
          status: "ok",
          exitCode: 0,
          stderrTail: stderrTail || undefined,
          command: commandString(step),
        });
        break;
      }

      if (step === "commit" && NOTHING_TO_COMMIT.test(stderrTail)) {
        steps.push({
          step,
          status: "skipped",
          exitCode,
          stderrTail: stderrTail || undefined,
          command: commandString(step),
        });
        break;
      }

      steps.push({
        step,
        status: "failed",
        exitCode,
        stderrTail: stderrTail || undefined,
        command: commandString(step),
      });

      const conflict =
        step === "commit" || step === "pull" ? detectSchemaConflict(spawnResult.stderr) : null;

      if (
        conflict &&
        options.resolve === "schema-prefer-remote" &&
        !resolveAttempted
      ) {
        resolveAttempted = true;
        const resolution = resolveSchemaPreferRemote(spawn, env, options, conflict);
        steps.push(resolution.step);
        if (resolution.ok) {
          // Loop and retry the same pipeline step.
          continue;
        }
        const pending: DoltReconcileResult = {
          state: "schemaConflictPending",
          steps,
          hint: resolution.hint,
          conflict,
          mode,
        };
        output.log(formatDoltReconcile(pending, options.format, false));
        return { exitCode: 1, result: pending };
      }

      if (conflict) {
        const pending: DoltReconcileResult = {
          state: "schemaConflictPending",
          steps,
          hint: hintForSchemaConflict(conflict.table),
          conflict,
          mode,
        };
        output.log(formatDoltReconcile(pending, options.format, false));
        return { exitCode: 1, result: pending };
      }

      const stuck: DoltReconcileResult = {
        state: "stuck",
        steps,
        hint: hintFor(step, stderrTail),
        mode,
      };
      output.log(formatDoltReconcile(stuck, options.format, false));
      return { exitCode: 1, result: stuck };
    }
  }

  const done: DoltReconcileResult = { state: "reconciled", steps, mode };
  output.log(formatDoltReconcile(done, options.format, false));
  return { exitCode: 0, result: done };
}

export function runDoltReconcile(
  options: DoltReconcileOptions,
  output: Output,
  deps: DoltReconcileDeps = {},
): number {
  return runDoltReconcileWithResult(options, output, deps).exitCode;
}

export function formatDoltReconcile(
  result: DoltReconcileResult,
  format: "plain" | "json",
  dryRun: boolean,
): string {
  if (format === "json") {
    return JSON.stringify({ dryRun, ...result }, null, 2);
  }

  const lines: string[] = [];
  lines.push(dryRun ? "prx dolt reconcile (dry-run):" : "prx dolt reconcile:");

  const width = 7; // "commit:" aligns with "pull:  " / "push:  "
  // Iterate steps in insertion order so a retry (commit-failed →
  // resolve-schema → commit-ok) is rendered as it happened.
  for (const entry of result.steps) {
    const label = `${entry.step}:`.padEnd(width, " ");
    if (entry.status === "preview") {
      lines.push(`  ${label} would run \`${entry.command}\``);
      continue;
    }
    if (entry.status === "failed") {
      lines.push(`  ${label} failed (exit ${entry.exitCode})`);
      continue;
    }
    lines.push(`  ${label} ${entry.status}`);
  }
  const attempted = new Set(result.steps.map((s) => s.step));
  // GH-1702: only enumerate steps the executed pipeline mode actually
  // includes. `push-only` skips the pull row entirely; `pull-only` skips
  // commit and push. `mode` is optional on the result for backwards
  // compatibility — absent → full pipeline (pre-GH-1702 shape).
  const expectedPipeline = pipelineForMode(result.mode ?? "full");
  for (const step of expectedPipeline) {
    if (!attempted.has(step)) {
      const label = `${step}:`.padEnd(width, " ");
      lines.push(`  ${label} (not run)`);
    }
  }

  lines.push(`state: ${result.state}`);
  if (result.hint) {
    const hintPrefix = "hint:  ";
    const hintLines = result.hint.split(/\r?\n/);
    lines.push(`${hintPrefix}${hintLines[0]}`);
    for (const hintLine of hintLines.slice(1)) {
      lines.push(`${" ".repeat(hintPrefix.length)}${hintLine}`);
    }
  }
  return lines.join("\n");
}
