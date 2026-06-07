// audit/store/db — path resolution + lazy file creation (the existing
// store.test.ts only exercises the :memory: path).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditDbExists, openAuditDb, resolveAuditDbPath } from "../../src/audit/store/db.ts";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "prx-audit-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveAuditDbPath", () => {
  test("an explicit dbPath wins", () => {
    expect(resolveAuditDbPath({ dbPath: "/x/db.sqlite" })).toBe("/x/db.sqlite");
  });
  test("stateDirOverride is used when present", () => {
    expect(resolveAuditDbPath({ stateDirOverride: "/state" })).toBe("/state/prx/audit/metrics.sqlite");
  });
  test("falls back to XDG_STATE_HOME", () => {
    expect(resolveAuditDbPath({ env: { XDG_STATE_HOME: "/xdg" } as NodeJS.ProcessEnv })).toBe(
      "/xdg/prx/audit/metrics.sqlite",
    );
  });
  test("falls back to ~/.local/state when nothing is set", () => {
    expect(resolveAuditDbPath({ env: {} as NodeJS.ProcessEnv }).endsWith("/.local/state/prx/audit/metrics.sqlite")).toBe(true);
  });
});

describe("openAuditDb + auditDbExists (real file)", () => {
  test("lazily mkdir -p's the parent and creates a working db", () => {
    const stateDir = fresh();
    const path = resolveAuditDbPath({ stateDirOverride: stateDir });
    expect(auditDbExists({ stateDirOverride: stateDir })).toBe(false);

    const db = openAuditDb({ dbPath: path });
    expect(existsSync(path)).toBe(true);
    // The schema applied — a known view/table is queryable without throwing.
    expect(() => db.exec("SELECT 1")).not.toThrow();
    db.close();

    expect(auditDbExists({ stateDirOverride: stateDir })).toBe(true);
  });
});
