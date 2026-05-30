import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PlanStoreError,
  resolvePlanStagingDir,
  resolvePlanStagingDirForDisplay,
} from "../../src/plan-store/cas.ts";

const ENV_KEYS = ["XDG_CACHE_HOME", "HOME"] as const;
type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of ENV_KEYS) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe("resolvePlanStagingDir (GH-1175)", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  test("XDG_CACHE_HOME wins over HOME", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache";
    process.env.HOME = "/home/operator";
    expect(resolvePlanStagingDir()).toBe(
      join("/tmp/xdg-cache", "prx", "plans", "staging"),
    );
    const display = resolvePlanStagingDirForDisplay();
    expect(display.dir).toBe(
      join("/tmp/xdg-cache", "prx", "plans", "staging"),
    );
    expect(display.source).toBe("XDG_CACHE_HOME");
  });

  test("falls back to HOME/.cache when XDG_CACHE_HOME is unset", () => {
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/home/operator";
    expect(resolvePlanStagingDir()).toBe(
      join("/home/operator", ".cache", "prx", "plans", "staging"),
    );
    const display = resolvePlanStagingDirForDisplay();
    expect(display.source).toBe("XDG_CACHE_HOME (default)");
  });

  test("treats empty XDG_CACHE_HOME as unset and falls through to HOME", () => {
    process.env.XDG_CACHE_HOME = "";
    process.env.HOME = "/home/operator";
    const display = resolvePlanStagingDirForDisplay();
    expect(display.source).toBe("XDG_CACHE_HOME (default)");
    expect(display.dir).toBe(
      join("/home/operator", ".cache", "prx", "plans", "staging"),
    );
  });

  test("throws PlanStoreError(NO_STAGING_ROOT) when neither var is set", () => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.HOME;
    let thrown: unknown;
    try {
      resolvePlanStagingDir();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanStoreError);
    expect((thrown as PlanStoreError).code).toBe("NO_STAGING_ROOT");
  });

  // GH-1175 Copilot review: env-derived root is embedded into the plan
  // profile's --allowedTools as `Write(<dir>/**)`. Reject characters that
  // would break that parser or smuggle additional allowlist entries.
  test("rejects XDG_CACHE_HOME containing a comma (allowlist separator)", () => {
    process.env.XDG_CACHE_HOME = "/tmp/foo,bar";
    let thrown: unknown;
    try {
      resolvePlanStagingDir();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanStoreError);
    expect((thrown as PlanStoreError).code).toBe("INVALID_STAGING_ROOT");
    expect((thrown as PlanStoreError).message).toContain("XDG_CACHE_HOME");
  });

  test("rejects HOME containing a close-paren (would close the Write(...) glob)", () => {
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/tmp/with)paren";
    let thrown: unknown;
    try {
      resolvePlanStagingDir();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanStoreError);
    expect((thrown as PlanStoreError).code).toBe("INVALID_STAGING_ROOT");
  });

  test("rejects env value containing a control byte (newline)", () => {
    process.env.XDG_CACHE_HOME = "/tmp/with\nnewline";
    let thrown: unknown;
    try {
      resolvePlanStagingDir();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanStoreError);
    expect((thrown as PlanStoreError).code).toBe("INVALID_STAGING_ROOT");
  });

  test("accepts env values with spaces and dashes (valid mac/linux paths)", () => {
    process.env.XDG_CACHE_HOME = "/Users/Dana Foo/cache-dir";
    expect(resolvePlanStagingDir()).toBe(
      "/Users/Dana Foo/cache-dir/prx/plans/staging",
    );
  });
});
