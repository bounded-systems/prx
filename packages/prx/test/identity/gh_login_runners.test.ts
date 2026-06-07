// The gh-spawn runners behind resolveGhLogin. `spawn` is injectable, so the
// auth-status + api-user-login output handling is covered without a live gh /
// GitHub API call (the existing gh_login.test.ts covers resolveGhLogin itself).

import { describe, expect, test } from "bun:test";

import { runGhApiUserLogin, runGhAuthStatus } from "../../src/identity/gh_login.ts";
import type { SpawnCaptureResult } from "@bounded-systems/proc";

const spawn = (r: Partial<SpawnCaptureResult>) =>
  (() => ({ status: 0, stdout: "", stderr: "", signal: null, ...r })) as never;

describe("runGhAuthStatus", () => {
  test("ok when gh auth status exits 0", () => {
    expect(runGhAuthStatus(spawn({ status: 0 }))).toEqual({ ok: true });
  });
  test("not ok on a non-zero exit", () => {
    expect(runGhAuthStatus(spawn({ status: 1 }))).toEqual({ ok: false });
  });
  test("not ok on a spawn error or kill signal", () => {
    expect(runGhAuthStatus(spawn({ error: new Error("x") }))).toEqual({ ok: false });
    expect(runGhAuthStatus(spawn({ status: null, signal: "SIGTERM" }))).toEqual({ ok: false });
  });
});

describe("runGhApiUserLogin", () => {
  test("returns the trimmed login on success", () => {
    expect(runGhApiUserLogin(spawn({ status: 0, stdout: "octocat\n" }))).toBe("octocat");
  });
  test("null on a spawn error / signal", () => {
    expect(runGhApiUserLogin(spawn({ error: new Error("x") }))).toBeNull();
    expect(runGhApiUserLogin(spawn({ status: null, signal: "SIGKILL" }))).toBeNull();
  });
  test("null on a non-zero exit", () => {
    expect(runGhApiUserLogin(spawn({ status: 1 }))).toBeNull();
  });
  test("null when stdout is empty", () => {
    expect(runGhApiUserLogin(spawn({ status: 0, stdout: "   " }))).toBeNull();
  });
});
