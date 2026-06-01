/**
 * E0 of GH-1685 — `createDoltDatabase` idempotent primitive.
 *
 * Drives every arm through a fake `DoltSqlSpawn` seam (no real dolt server):
 * created / exists / invalid-name / probe-failure / create-failure /
 * unparseable-probe. Asserts the emitted SQL so the backtick-quoting and
 * the existence-probe-then-create ordering are pinned.
 */
import { describe, expect, test } from "bun:test";

import {
  createDoltDatabase,
  type DoltSqlSpawn,
  type DoltSqlSpawnResult,
} from "../../src/dolt/create_database.ts";

const DB = "io_github_bounded_systems_prx";
const CONN = { port: 3308, cwd: "/tmp" } as const;

/** Build a spawn that returns canned results in order and records queries. */
function fakeSpawn(results: DoltSqlSpawnResult[]): {
  spawn: DoltSqlSpawn;
  queries: string[];
} {
  const queries: string[] = [];
  let i = 0;
  const spawn: DoltSqlSpawn = (_file, args) => {
    // The query is the token after `-q`.
    const qi = args.indexOf("-q");
    queries.push(qi >= 0 ? (args[qi + 1] ?? "") : "");
    return results[i++] ?? { status: 1, stderr: "unexpected extra spawn" };
  };
  return { spawn, queries };
}

const okShowEmpty: DoltSqlSpawnResult = { status: 0, stdout: '{"rows":[]}' };
const okShowPresent: DoltSqlSpawnResult = {
  status: 0,
  stdout: `{"rows":[{"Database":"${DB}"}]}`,
};
const okCreate: DoltSqlSpawnResult = { status: 0, stdout: "{}" };

describe("createDoltDatabase", () => {
  test("creates the database when absent (probe empty → CREATE)", () => {
    const { spawn, queries } = fakeSpawn([okShowEmpty, okCreate]);
    const result = createDoltDatabase(DB, CONN, spawn);
    expect(result).toEqual({ status: "created", database: DB });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(`SHOW DATABASES LIKE '${DB}'`);
    expect(queries[1]).toBe(`CREATE DATABASE \`${DB}\``);
  });

  test("is idempotent: reports exists and does NOT issue CREATE", () => {
    const { spawn, queries } = fakeSpawn([okShowPresent]);
    const result = createDoltDatabase(DB, CONN, spawn);
    expect(result).toEqual({ status: "exists", database: DB });
    expect(queries).toEqual([`SHOW DATABASES LIKE '${DB}'`]);
  });

  test("rejects a non-canonical name before touching the server", () => {
    const { spawn, queries } = fakeSpawn([okShowEmpty, okCreate]);
    const result = createDoltDatabase("github.com__bounded-systems__prx", CONN, spawn);
    expect(result.status).toBe("error");
    expect(queries).toHaveLength(0);
  });

  test("surfaces probe failure as error", () => {
    const { spawn } = fakeSpawn([{ status: 1, stderr: "connection refused" }]);
    const result = createDoltDatabase(DB, CONN, spawn);
    expect(result).toEqual({
      status: "error",
      database: DB,
      error: "connection refused",
    });
  });

  test("surfaces CREATE failure as error (probe ok, create fails)", () => {
    const { spawn } = fakeSpawn([
      okShowEmpty,
      { status: 1, stderr: "permission denied" },
    ]);
    const result = createDoltDatabase(DB, CONN, spawn);
    expect(result).toEqual({
      status: "error",
      database: DB,
      error: "permission denied",
    });
  });

  test("errors on an unparseable probe payload", () => {
    const { spawn } = fakeSpawn([{ status: 0, stdout: "not json" }]);
    const result = createDoltDatabase(DB, CONN, spawn);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("parse");
    }
  });

  test("treats a spawn error object as failure", () => {
    const { spawn } = fakeSpawn([{ status: null, error: new Error("ENOENT dolt") }]);
    const result = createDoltDatabase(DB, CONN, spawn);
    expect(result).toEqual({
      status: "error",
      database: DB,
      error: "ENOENT dolt",
    });
  });
});
