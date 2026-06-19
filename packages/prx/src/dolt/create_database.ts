/**
 * E0 of GH-1685 — idempotent `CREATE DATABASE` primitive for the shared
 * dolt sql-server.
 *
 * Given a running server's connection (host/port/user) and a canonical
 * `dolt_database` name (reverse-DNS `io_github_<owner>_<repo>`; see
 * `canonicalDoltDatabase` in src/pr-state/github.ts), this creates the
 * empty database if absent and reports `created`, or `exists` when it is
 * already present. **No schema seeding** happens here — that is E1's
 * `bd init --database`. The verb (`prx repo provision`, E4) resolves the
 * shared-server connection and composes this primitive.
 *
 * Reuses the `dolt sql --result-format json` access pattern shared with
 * `src/dolt/status.ts` and `src/pr-state/dolt-reconcile.ts`. The spawn is a
 * DI seam so tests drive every arm without a real server. The database name
 * is re-validated against `DOLT_DATABASE_NAME_PATTERN` before it is ever
 * interpolated into SQL — the pattern admits only `io_github` + `_<alnum>`
 * segments, so the backtick-quoted name carries no injection surface.
 */

import { isSafeDoltIdentifier } from "./namespace.ts";

export type DoltSqlSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type DoltSqlSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => DoltSqlSpawnResult;

/** Connection to a running dolt sql-server (the shared-server). */
export type CreateDatabaseConn = {
  /** Defaults to 127.0.0.1. */
  host?: string;
  port: number;
  /** Defaults to root. */
  user?: string;
  /** Working directory for the spawned `dolt` process. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CreateDatabaseResult =
  | { status: "created"; database: string }
  | { status: "exists"; database: string }
  | { status: "error"; database: string; error: string };

function readBuffer(value: string | Buffer | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function failureText(r: DoltSqlSpawnResult, fallback: string): string {
  if (r.error) return r.error.message;
  const stderr = readBuffer(r.stderr).trim();
  return stderr.length > 0 ? stderr : fallback;
}

/**
 * `dolt sql --result-format json` for `SHOW DATABASES LIKE '<name>'` emits
 * `{"rows":[{"Database":"<name>"}]}` (empty `rows` when absent). Returns
 * `true`/`false` on a clean parse, or `null` when the payload is unparseable.
 */
function showDatabasesHasRow(stdout: string): boolean | null {
  try {
    const payload = JSON.parse(stdout) as { rows?: unknown[] };
    if (!payload || !Array.isArray(payload.rows)) return null;
    return payload.rows.length > 0;
  } catch {
    return null;
  }
}

/** Build spawn options, omitting `env` entirely when unset (exactOptionalPropertyTypes). */
function spawnOptions(conn: CreateDatabaseConn): { cwd: string; env?: NodeJS.ProcessEnv } {
  return conn.env !== undefined ? { cwd: conn.cwd, env: conn.env } : { cwd: conn.cwd };
}

function sqlArgs(conn: CreateDatabaseConn, query: string): string[] {
  return [
    "sql",
    "--host",
    conn.host ?? "127.0.0.1",
    "--port",
    String(conn.port),
    "--user",
    conn.user ?? "root",
    "--result-format",
    "json",
    "-q",
    query,
  ];
}

export function createDoltDatabase(
  database: string,
  conn: CreateDatabaseConn,
  spawn: DoltSqlSpawn,
): CreateDatabaseResult {
  // Defense-in-depth: only a SQL-safe identifier is ever interpolated into SQL.
  // The guard is the SAFETY constraint (scheme-agnostic), not the naming policy
  // — the reverse-DNS scheme lives in the namespace resolver (GH-303). A bad
  // name must fail closed here rather than reach the server.
  if (!isSafeDoltIdentifier(database)) {
    return {
      status: "error",
      database,
      error: `unsafe dolt_database name (expected a safe identifier [a-z0-9_]): ${database}`,
    };
  }

  const probe = spawn(
    "dolt",
    sqlArgs(conn, `SHOW DATABASES LIKE '${database}'`),
    spawnOptions(conn),
  );
  if (probe.error || (probe.status ?? 1) !== 0) {
    return {
      status: "error",
      database,
      error: failureText(probe, "SHOW DATABASES failed"),
    };
  }
  const present = showDatabasesHasRow(readBuffer(probe.stdout));
  if (present === null) {
    return {
      status: "error",
      database,
      error: "could not parse SHOW DATABASES output",
    };
  }
  if (present) {
    return { status: "exists", database };
  }

  const create = spawn(
    "dolt",
    sqlArgs(conn, `CREATE DATABASE \`${database}\``),
    spawnOptions(conn),
  );
  if (create.error || (create.status ?? 1) !== 0) {
    return {
      status: "error",
      database,
      error: failureText(create, "CREATE DATABASE failed"),
    };
  }
  return { status: "created", database };
}
