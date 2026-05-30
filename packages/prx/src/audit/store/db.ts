// GH-1823 — `bun:sqlite` adapter for the audit metrics store.
//
// Lazy-creates the SQLite file at `~/.local/state/prx/audit/metrics.sqlite`
// (or a caller-supplied override; tests use `:memory:` or a tmp file).
// Schema is read from `schema.sql` and applied idempotently on first open.

import { processEnv } from "@bounded-systems/env";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, "schema.sql");

export type OpenAuditDbOptions = {
  /** Absolute path to the SQLite file. Defaults to the state-dir resolved path. */
  dbPath?: string | undefined;
  /** Override XDG_STATE_HOME / homedir lookup for tests. */
  stateDirOverride?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
};

export function resolveAuditDbPath(opts: OpenAuditDbOptions = {}): string {
  if (opts.dbPath) return opts.dbPath;
  const env = opts.env ?? processEnv();
  const stateDir =
    opts.stateDirOverride
    ?? env.XDG_STATE_HOME
    ?? join(homedir(), ".local", "state");
  return join(stateDir, "prx", "audit", "metrics.sqlite");
}

/**
 * Open (and lazily create) the audit metrics database, applying the schema
 * idempotently. The schema uses `CREATE … IF NOT EXISTS`, so re-applying on
 * every open is safe and keeps the DDL the single source of truth.
 */
export function openAuditDb(opts: OpenAuditDbOptions = {}): Database {
  const path = resolveAuditDbPath(opts);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  const ddl = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(ddl);
  return db;
}

export const AUDIT_SCHEMA_PATH = SCHEMA_PATH;

/** Tiny helper — `existsSync` re-export so callers don't need the node import. */
export function auditDbExists(opts: OpenAuditDbOptions = {}): boolean {
  return existsSync(resolveAuditDbPath(opts));
}
