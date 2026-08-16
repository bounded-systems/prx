// GH-1760 / GH-1761: prx-wide registry store at
// `~/.local/state/prx/registry.sqlite`. First concrete `*Store` from the
// GH-1754 design — the upstream layer for `prx workspace adopt` (GH-1762),
// `prx lease acquire` (GH-1763), `prx reconcile` (GH-1764), and the
// `prx status` projection (GH-1765).
//
// Zod row schemas are the single source of truth: they drive the DDL below
// and the command-output contract on `prx repo adopt` / `prx branch adopt`.
// The store itself is a thin wrapper over `bun:sqlite`; transactions wrap
// every write so a Zod-validation failure rolls the row back. WAL + foreign
// keys are enabled on open.

import { getEnv } from "@bounded-systems/env";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// SSH-style git URLs (`git@host:owner/name[.git]`) are not WHATWG URLs, so
// `z.string().url()` would reject them. Accept either a WHATWG URL or the
// ssh shape — the same forms `parseRepoUrl` already canonicalizes.
const GIT_SSH_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+\/[^\s]+$/;
const remoteUrl = z
  .string()
  .min(1)
  .refine((value) => GIT_SSH_URL.test(value) || /^(https?|git):\/\//.test(value), {
    message: "remote_url must be a git ssh URL (git@host:owner/name) or an http(s)/git URL",
  });

export const RepoRowSchema = z.object({
  // `<host>/<owner>/<name>`, e.g. `github.com/example-owner/example-repo`.
  repo_id: z.string().min(1),
  bare_path: z.string().min(1),
  remote_url: remoteUrl,
  default_branch: z.string().min(1),
  managed_by: z.literal("prx"),
  adopted_at: z.string().datetime(),
});
export type RepoRow = z.infer<typeof RepoRowSchema>;

export const BranchRowSchema = z.object({
  // `<repo_id>:<name>`, e.g. `github.com/example-owner/example-repo:GH-1760`.
  branch_id: z.string().min(1),
  repo_id: z.string().min(1),
  name: z.string().min(1),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  purpose: z.enum(["scratch", "feature", "trunk"]).default("scratch"),
  state: z.enum(["active", "archived"]).default("active"),
  adopted_at: z.string().datetime(),
});
export type BranchRow = z.infer<typeof BranchRowSchema>;

// GH-1762: registry-side workspace row. The `workspace_id` matches the
// owning branch's `<repo_id>:<name>` so the PK encodes "one workspace per
// branch" — future PRX-owned workspaces (Medium-phase per GH-1759) can
// widen this with a suffix without breaking the existing rows.
export const WorkspaceRowSchema = z.object({
  workspace_id: z.string().min(1),
  repo_id: z.string().min(1),
  branch_id: z.string().min(1),
  path: z.string().min(1),
  backend: z.literal("git-worktree"),
  // V1 ships only `ready`. `leased` / `quarantined` etc. land with
  // GH-1763 (lease acquire) and GH-1764 (reconcile).
  state: z.enum(["ready"]).default("ready"),
  mode: z.enum(["read", "write"]).default("write"),
  dirty: z.boolean(),
  adopted_at: z.string().datetime(),
});
export type WorkspaceRow = z.infer<typeof WorkspaceRowSchema>;

export type RegistryDatabase = Database;

const DDL = `
CREATE TABLE IF NOT EXISTS repos (
  repo_id        TEXT PRIMARY KEY NOT NULL,
  bare_path      TEXT NOT NULL,
  remote_url     TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  managed_by     TEXT NOT NULL DEFAULT 'prx',
  adopted_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  branch_id  TEXT PRIMARY KEY NOT NULL,
  repo_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  head_sha   TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'scratch',
  state      TEXT NOT NULL DEFAULT 'active',
  adopted_at TEXT NOT NULL,
  FOREIGN KEY(repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  repo_id      TEXT NOT NULL,
  branch_id    TEXT NOT NULL,
  path         TEXT NOT NULL,
  backend      TEXT NOT NULL DEFAULT 'git-worktree',
  state        TEXT NOT NULL DEFAULT 'ready',
  mode         TEXT NOT NULL DEFAULT 'write',
  dirty        INTEGER NOT NULL,
  adopted_at   TEXT NOT NULL,
  FOREIGN KEY(repo_id)   REFERENCES repos(repo_id)     ON DELETE CASCADE,
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_path_uniq ON workspaces(path);
`;

export function defaultRegistryPath(): string {
  const home = getEnv("HOME");
  if (!home) {
    throw new Error("HOME is not set; cannot resolve default registry path");
  }
  return `${home}/.local/state/prx/registry.sqlite`;
}

export function openRegistry(path: string = defaultRegistryPath()): RegistryDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(DDL);
  return db;
}

export class RepositoryStore {
  constructor(private readonly db: RegistryDatabase) {}

  upsertRepo(input: RepoRow): { row: RepoRow; previous: RepoRow | null } {
    const validated = RepoRowSchema.parse(input);
    const previous = this.getById(validated.repo_id);
    const tx = this.db.transaction((row: RepoRow) => {
      this.db
        .prepare(
          `INSERT INTO repos (repo_id, bare_path, remote_url, default_branch, managed_by, adopted_at)
           VALUES ($repo_id, $bare_path, $remote_url, $default_branch, $managed_by, $adopted_at)
           ON CONFLICT(repo_id) DO UPDATE SET
             bare_path      = excluded.bare_path,
             remote_url     = excluded.remote_url,
             default_branch = excluded.default_branch,
             managed_by     = excluded.managed_by,
             adopted_at     = excluded.adopted_at`,
        )
        .run({
          $repo_id: row.repo_id,
          $bare_path: row.bare_path,
          $remote_url: row.remote_url,
          $default_branch: row.default_branch,
          $managed_by: row.managed_by,
          $adopted_at: row.adopted_at,
        });
    });
    tx(validated);
    return { row: validated, previous };
  }

  getById(repo_id: string): RepoRow | null {
    const raw = this.db
      .prepare("SELECT * FROM repos WHERE repo_id = $repo_id")
      .get({ $repo_id: repo_id });
    return raw ? RepoRowSchema.parse(raw) : null;
  }

  getByBarePath(bare_path: string): RepoRow | null {
    const raw = this.db
      .prepare("SELECT * FROM repos WHERE bare_path = $bare_path")
      .get({ $bare_path: bare_path });
    return raw ? RepoRowSchema.parse(raw) : null;
  }

  list(): RepoRow[] {
    const rows = this.db.prepare("SELECT * FROM repos ORDER BY repo_id").all() as unknown[];
    return rows.map((row) => RepoRowSchema.parse(row));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number } | null;
    return row?.n ?? 0;
  }
}

export class BranchStore {
  constructor(private readonly db: RegistryDatabase) {}

  upsertBranch(input: BranchRow): { row: BranchRow; previous: BranchRow | null } {
    const validated = BranchRowSchema.parse(input);
    const previous = this.getById(validated.branch_id);
    const tx = this.db.transaction((row: BranchRow) => {
      this.db
        .prepare(
          `INSERT INTO branches (branch_id, repo_id, name, head_sha, purpose, state, adopted_at)
           VALUES ($branch_id, $repo_id, $name, $head_sha, $purpose, $state, $adopted_at)
           ON CONFLICT(branch_id) DO UPDATE SET
             repo_id    = excluded.repo_id,
             name       = excluded.name,
             head_sha   = excluded.head_sha,
             purpose    = excluded.purpose,
             state      = excluded.state,
             adopted_at = excluded.adopted_at`,
        )
        .run({
          $branch_id: row.branch_id,
          $repo_id: row.repo_id,
          $name: row.name,
          $head_sha: row.head_sha,
          $purpose: row.purpose,
          $state: row.state,
          $adopted_at: row.adopted_at,
        });
    });
    tx(validated);
    return { row: validated, previous };
  }

  getById(branch_id: string): BranchRow | null {
    const raw = this.db
      .prepare("SELECT * FROM branches WHERE branch_id = $branch_id")
      .get({ $branch_id: branch_id });
    return raw ? BranchRowSchema.parse(raw) : null;
  }

  getByRepoAndName(repo_id: string, name: string): BranchRow | null {
    const raw = this.db
      .prepare("SELECT * FROM branches WHERE repo_id = $repo_id AND name = $name")
      .get({ $repo_id: repo_id, $name: name });
    return raw ? BranchRowSchema.parse(raw) : null;
  }

  listByRepo(repo_id: string): BranchRow[] {
    const rows = this.db
      .prepare("SELECT * FROM branches WHERE repo_id = $repo_id ORDER BY name")
      .all({ $repo_id: repo_id }) as unknown[];
    return rows.map((row) => BranchRowSchema.parse(row));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM branches").get() as { n: number } | null;
    return row?.n ?? 0;
  }
}

type WorkspaceRowSql = {
  workspace_id: string;
  repo_id: string;
  branch_id: string;
  path: string;
  backend: string;
  state: string;
  mode: string;
  dirty: number;
  adopted_at: string;
};

function rowFromSql(raw: WorkspaceRowSql): WorkspaceRow {
  return WorkspaceRowSchema.parse({
    workspace_id: raw.workspace_id,
    repo_id: raw.repo_id,
    branch_id: raw.branch_id,
    path: raw.path,
    backend: raw.backend,
    state: raw.state,
    mode: raw.mode,
    dirty: raw.dirty !== 0,
    adopted_at: raw.adopted_at,
  });
}

export class WorkspaceStore {
  constructor(private readonly db: RegistryDatabase) {}

  upsertWorkspace(input: WorkspaceRow): { row: WorkspaceRow; previous: WorkspaceRow | null } {
    const validated = WorkspaceRowSchema.parse(input);
    const previous = this.getById(validated.workspace_id);
    const tx = this.db.transaction((row: WorkspaceRow) => {
      this.db
        .prepare(
          `INSERT INTO workspaces (workspace_id, repo_id, branch_id, path, backend, state, mode, dirty, adopted_at)
           VALUES ($workspace_id, $repo_id, $branch_id, $path, $backend, $state, $mode, $dirty, $adopted_at)
           ON CONFLICT(workspace_id) DO UPDATE SET
             repo_id    = excluded.repo_id,
             branch_id  = excluded.branch_id,
             path       = excluded.path,
             backend    = excluded.backend,
             state      = excluded.state,
             mode       = excluded.mode,
             dirty      = excluded.dirty,
             adopted_at = excluded.adopted_at`,
        )
        .run({
          $workspace_id: row.workspace_id,
          $repo_id: row.repo_id,
          $branch_id: row.branch_id,
          $path: row.path,
          $backend: row.backend,
          $state: row.state,
          $mode: row.mode,
          $dirty: row.dirty ? 1 : 0,
          $adopted_at: row.adopted_at,
        });
    });
    tx(validated);
    return { row: validated, previous };
  }

  getById(workspace_id: string): WorkspaceRow | null {
    const raw = this.db
      .prepare("SELECT * FROM workspaces WHERE workspace_id = $workspace_id")
      .get({ $workspace_id: workspace_id }) as WorkspaceRowSql | null;
    return raw ? rowFromSql(raw) : null;
  }

  getByPath(path: string): WorkspaceRow | null {
    const raw = this.db
      .prepare("SELECT * FROM workspaces WHERE path = $path")
      .get({ $path: path }) as WorkspaceRowSql | null;
    return raw ? rowFromSql(raw) : null;
  }

  listByBranch(branch_id: string): WorkspaceRow[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces WHERE branch_id = $branch_id ORDER BY path")
      .all({ $branch_id: branch_id }) as WorkspaceRowSql[];
    return rows.map((row) => rowFromSql(row));
  }

  listByRepo(repo_id: string): WorkspaceRow[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces WHERE repo_id = $repo_id ORDER BY path")
      .all({ $repo_id: repo_id }) as WorkspaceRowSql[];
    return rows.map((row) => rowFromSql(row));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as {
      n: number;
    } | null;
    return row?.n ?? 0;
  }
}
