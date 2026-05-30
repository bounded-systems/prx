import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  BranchRowSchema,
  BranchStore,
  RepoRowSchema,
  RepositoryStore,
  WorkspaceStore,
  openRegistry,
  type BranchRow,
  type RepoRow,
  type WorkspaceRow,
} from "../../src/pr-state/registry_store.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "prx-registry-"));
}

const sampleRepo = (overrides: Partial<RepoRow> = {}): RepoRow => ({
  repo_id: "github.com/bdelanghe/ai-home",
  bare_path: "/var/git/bare/io.github/bdelanghe/ai-home.git",
  remote_url: "https://github.com/bdelanghe/ai-home.git",
  default_branch: "main",
  managed_by: "prx",
  adopted_at: "2026-05-15T12:00:00.000Z",
  ...overrides,
});

const sampleBranch = (overrides: Partial<BranchRow> = {}): BranchRow => ({
  branch_id: "github.com/bdelanghe/ai-home:GH-1760",
  repo_id: "github.com/bdelanghe/ai-home",
  name: "GH-1760",
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  purpose: "scratch",
  state: "active",
  adopted_at: "2026-05-15T12:00:00.000Z",
  ...overrides,
});

const sampleWorkspace = (overrides: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  workspace_id: "github.com/bdelanghe/ai-home:GH-1760",
  repo_id: "github.com/bdelanghe/ai-home",
  branch_id: "github.com/bdelanghe/ai-home:GH-1760",
  path: "/wt/main/GH-1760",
  backend: "git-worktree",
  state: "ready",
  mode: "write",
  dirty: false,
  adopted_at: "2026-05-15T12:00:00.000Z",
  ...overrides,
});

describe("openRegistry", () => {
  test("creates the sqlite file on first open and enables WAL + foreign keys", () => {
    const dir = tmp();
    try {
      const path = join(dir, "nested", "registry.sqlite");
      expect(existsSync(path)).toBe(false);

      const db = openRegistry(path);
      try {
        expect(existsSync(path)).toBe(true);

        const journal = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
        expect(journal.journal_mode).toBe("wal");

        const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
        expect(fk.foreign_keys).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applies the schema (repos + branches + workspaces tables) via CREATE IF NOT EXISTS", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const tables = db
          .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        expect(tables.map((t) => t.name)).toEqual(["branches", "repos", "workspaces"]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Zod row schemas", () => {
  test("RepoRowSchema rejects non-URL remote_url + non-ISO adopted_at", () => {
    expect(() =>
      RepoRowSchema.parse(sampleRepo({ remote_url: "not-a-url" })),
    ).toThrow();
    expect(() =>
      RepoRowSchema.parse(sampleRepo({ adopted_at: "yesterday" })),
    ).toThrow();
  });

  test("BranchRowSchema rejects malformed head_sha", () => {
    expect(() =>
      BranchRowSchema.parse(sampleBranch({ head_sha: "deadbeef" })),
    ).toThrow();
    expect(() =>
      BranchRowSchema.parse(sampleBranch({ head_sha: "0123456789ABCDEF0123456789ABCDEF01234567" })),
    ).toThrow();
  });
});

describe("RepositoryStore.upsertRepo", () => {
  test("inserts a new row and round-trips through getById / getByBarePath", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const store = new RepositoryStore(db);
        const row = sampleRepo();
        const { row: stored, previous } = store.upsertRepo(row);
        expect(previous).toBeNull();
        expect(stored).toEqual(row);
        expect(store.getById(row.repo_id)).toEqual(row);
        expect(store.getByBarePath(row.bare_path)).toEqual(row);
        expect(store.count()).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent: re-inserting the same row preserves the prior row", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const store = new RepositoryStore(db);
        const row = sampleRepo();
        store.upsertRepo(row);
        const second = store.upsertRepo(row);
        expect(second.previous).toEqual(row);
        expect(second.row).toEqual(row);
        expect(store.count()).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects writes that fail Zod validation before touching the DB", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const store = new RepositoryStore(db);
        expect(() =>
          store.upsertRepo(sampleRepo({ remote_url: "not-a-url" })),
        ).toThrow();
        expect(store.count()).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BranchStore.upsertBranch", () => {
  test("requires the parent repo row (foreign key enforced)", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const branchStore = new BranchStore(db);
        expect(() => branchStore.upsertBranch(sampleBranch())).toThrow();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inserts + idempotent re-upsert on a valid repo+branch pair", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const repoStore = new RepositoryStore(db);
        const branchStore = new BranchStore(db);
        repoStore.upsertRepo(sampleRepo());

        const row = sampleBranch();
        const first = branchStore.upsertBranch(row);
        expect(first.previous).toBeNull();
        expect(first.row).toEqual(row);

        const second = branchStore.upsertBranch(row);
        expect(second.previous).toEqual(row);
        expect(second.row).toEqual(row);
        expect(branchStore.count()).toBe(1);
        expect(branchStore.getByRepoAndName(row.repo_id, row.name)).toEqual(row);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceStore.upsertWorkspace", () => {
  test("requires the parent repo + branch rows (FKs enforced)", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const workspaceStore = new WorkspaceStore(db);
        expect(() => workspaceStore.upsertWorkspace(sampleWorkspace())).toThrow();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inserts + idempotent re-upsert on a valid chain; round-trips dirty boolean", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const repoStore = new RepositoryStore(db);
        const branchStore = new BranchStore(db);
        const workspaceStore = new WorkspaceStore(db);
        repoStore.upsertRepo(sampleRepo());
        branchStore.upsertBranch(sampleBranch());

        const row = sampleWorkspace({ dirty: true });
        const first = workspaceStore.upsertWorkspace(row);
        expect(first.previous).toBeNull();
        expect(first.row).toEqual(row);
        expect(first.row.dirty).toBe(true);

        const second = workspaceStore.upsertWorkspace(row);
        expect(second.previous).toEqual(row);
        expect(second.row).toEqual(row);
        expect(workspaceStore.count()).toBe(1);
        expect(workspaceStore.getByPath(row.path)).toEqual(row);
        expect(workspaceStore.listByBranch(row.branch_id)).toEqual([row]);
        expect(workspaceStore.listByRepo(row.repo_id)).toEqual([row]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FK cascade: deleting the parent repo row cascades the workspace row out", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const repoStore = new RepositoryStore(db);
        const branchStore = new BranchStore(db);
        const workspaceStore = new WorkspaceStore(db);
        repoStore.upsertRepo(sampleRepo());
        branchStore.upsertBranch(sampleBranch());
        workspaceStore.upsertWorkspace(sampleWorkspace());
        expect(workspaceStore.count()).toBe(1);

        db.prepare("DELETE FROM repos WHERE repo_id = $id")
          .run({ $id: sampleRepo().repo_id });
        expect(workspaceStore.count()).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FK cascade: deleting the parent branch row cascades the workspace row out", () => {
    const dir = tmp();
    try {
      const db = openRegistry(join(dir, "registry.sqlite"));
      try {
        const repoStore = new RepositoryStore(db);
        const branchStore = new BranchStore(db);
        const workspaceStore = new WorkspaceStore(db);
        repoStore.upsertRepo(sampleRepo());
        branchStore.upsertBranch(sampleBranch());
        workspaceStore.upsertWorkspace(sampleWorkspace());
        expect(workspaceStore.count()).toBe(1);

        db.prepare("DELETE FROM branches WHERE branch_id = $id")
          .run({ $id: sampleBranch().branch_id });
        expect(workspaceStore.count()).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
