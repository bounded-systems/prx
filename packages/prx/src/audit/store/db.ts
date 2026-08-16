// GH-1823 — `bun:sqlite` adapter for the audit metrics store.
//
// Lazy-creates the SQLite file at `~/.local/state/prx/audit/metrics.sqlite`
// (or a caller-supplied override; tests use `:memory:` or a tmp file).
// Schema lives in `schema.sql` and is applied idempotently on first open.
//
// The DDL is imported as a `type: "text"` asset rather than read from disk at
// runtime: `bun build --compile` embeds statically-imported assets into the
// bundle, so the compiled binary carries the schema. A runtime `readFileSync`
// instead ENOENTs on `/$bunfs/root/schema.sql` in the release (prx-eky).

import { processEnv } from "@bounded-systems/env";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homeDir } from "@bounded-systems/host";
import { dirname, join } from "node:path";
import schemaSql from "./schema.sql" with { type: "text" };

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
    opts.stateDirOverride ?? env.XDG_STATE_HOME ?? join(homeDir(), ".local", "state");
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
  db.exec(schemaSql);
  return db;
}

/** Tiny helper — `existsSync` re-export so callers don't need the node import. */
export function auditDbExists(opts: OpenAuditDbOptions = {}): boolean {
  return existsSync(resolveAuditDbPath(opts));
}
