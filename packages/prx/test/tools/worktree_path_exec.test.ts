// worktree_path: the format helpers, the worktrunk-binary resolver, and the
// execWorktrunk directive-file lifecycle. The spawn is injected (the new `run`
// seam) and the directive spool is a real temp file, so no wt/cargo launches.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  execWorktrunk,
  formatExecResult,
  formatWorktreeEnv,
  formatWorktreePath,
  resolveWorktreePath,
  resolveWorktrunkBin,
  worktreeEnv,
} from "../../src/tools/worktree_path.ts";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "prx-wt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A defaultRunner-shaped fake.
const runner = (status: number) => (() => ({ stdout: "", stderr: "", status })) as never;
const throwingRunner = (() => {
  throw new Error("spawn failed");
}) as never;

// ── format helpers ────────────────────────────────────────────────────────────

describe("format helpers", () => {
  const path = resolveWorktreePath({ XDG_STATE_HOME: "/state", HOME: "/h" });
  test("formatWorktreePath json + plain", () => {
    expect(JSON.parse(formatWorktreePath(path, "json")).source).toBe(path.source);
    expect(formatWorktreePath(path, "plain")).toMatch(/template:/);
  });
  test("formatWorktreeEnv json + plain", () => {
    const e = worktreeEnv({ XDG_STATE_HOME: "/state" });
    expect(JSON.parse(formatWorktreeEnv(e, "json")).vars.WT_STATE_ROOT).toBe("/state");
    expect(formatWorktreeEnv(e, "plain")).toContain("export WT_WORKTREE_PATH=");
  });
  test("formatExecResult json + plain (with and without a directive file)", () => {
    expect(JSON.parse(formatExecResult({ exitCode: 0, directiveFile: "/d" }, "json")).directiveFile).toBe("/d");
    expect(formatExecResult({ exitCode: 0, directiveFile: "/d" }, "plain")).toBe("/d");
    expect(formatExecResult({ exitCode: 1, directiveFile: null }, "plain")).toBe("");
  });
});

// ── resolveWorktrunkBin ───────────────────────────────────────────────────────

describe("resolveWorktrunkBin", () => {
  test("honors WORKTRUNK_BIN", () => {
    expect(resolveWorktrunkBin({ WORKTRUNK_BIN: "/opt/wt" })).toBe("/opt/wt");
  });
  test("finds wt on PATH (skipping ~/.local/bin)", () => {
    const dir = fresh();
    writeFileSync(join(dir, "wt"), "#!/bin/sh\n");
    expect(resolveWorktrunkBin({ HOME: "/h", PATH: `${dir}` })).toBe(`${dir}/wt`);
  });
  test("returns null when wt is nowhere on PATH", () => {
    expect(resolveWorktrunkBin({ HOME: "/h", PATH: "" })).toBeNull();
  });
});

// ── execWorktrunk ─────────────────────────────────────────────────────────────

describe("execWorktrunk", () => {
  const spool = () => join(fresh(), "directive.zsh");

  test("returns 127 when the binary cannot be resolved (no spawn)", () => {
    let ran = false;
    const r = execWorktrunk(
      { args: ["list"], directiveSpoolFile: spool() },
      { PATH: "" },
      (() => { ran = true; return { stdout: "", stderr: "", status: 0 }; }) as never,
    );
    expect(r.exitCode).toBe(127);
    expect(r.directiveFile).toBeNull();
    expect(ran).toBe(false);
  });

  test("a successful switch appends directives and keeps the file", () => {
    const file = spool();
    const r = execWorktrunk(
      { args: ["switch", "GH-1"], worktrunkBin: "/opt/wt", directiveSpoolFile: file },
      {},
      runner(0),
    );
    expect(r.exitCode).toBe(0);
    expect(r.directiveFile).toBe(file);
    expect(readFileSync(file, "utf8")).toMatch(/_wt_apply_switch_env/);
  });

  test("a non-switch command leaves an empty directive file, which is removed", () => {
    const file = spool();
    const r = execWorktrunk(
      { args: ["list"], worktrunkBin: "/opt/wt", directiveSpoolFile: file },
      {},
      runner(0),
    );
    expect(r.directiveFile).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("a non-zero wt exit is passed through", () => {
    const r = execWorktrunk(
      { args: ["switch", "GH-1"], worktrunkBin: "/opt/wt", directiveSpoolFile: spool() },
      {},
      runner(3),
    );
    expect(r.exitCode).toBe(3);
    // exit != 0 → no switch directives appended → empty → removed.
    expect(r.directiveFile).toBeNull();
  });

  test("a thrown spawn maps to exit 1", () => {
    const r = execWorktrunk(
      { args: ["switch", "GH-1"], worktrunkBin: "/opt/wt", directiveSpoolFile: spool() },
      {},
      throwingRunner,
    );
    expect(r.exitCode).toBe(1);
  });

  test("source mode runs via cargo", () => {
    let cmd: string[] = [];
    execWorktrunk(
      { args: ["switch", "GH-1"], source: true, directiveSpoolFile: spool() },
      {},
      ((c: string[]) => { cmd = c; return { stdout: "", stderr: "", status: 0 }; }) as never,
    );
    expect(cmd.slice(0, 4)).toEqual(["cargo", "run", "--bin", "wt"]);
  });
});
