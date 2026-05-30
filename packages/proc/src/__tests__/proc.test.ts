import { describe, expect, test } from "bun:test";
import { defaultRunner } from "@bounded-systems/proc";

describe("@bounded-systems/proc defaultRunner", () => {
  test("captures stdout/status of a successful command", () => {
    const r = defaultRunner(["printf", "hi"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  test("throws on empty command", () => {
    expect(() => defaultRunner([])).toThrow(/empty command/);
  });

  test("non-zero exit throws by default; check:false returns the result", () => {
    expect(() => defaultRunner(["false"])).toThrow();
    const r = defaultRunner(["false"], { check: false });
    expect(r.status).not.toBe(0);
  });

  test("env override is passed through to the child", () => {
    const r = defaultRunner(["sh", "-c", "printf %s \"$PRX_PROC_X\""], {
      env: { PRX_PROC_X: "yes" },
    });
    expect(r.stdout).toBe("yes");
  });

  test("timeout kills a slow command and throws ETIMEDOUT (even with check:false)", () => {
    let caught: NodeJS.ErrnoException | undefined;
    try {
      defaultRunner(["sleep", "5"], { timeout: 80, check: false });
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe("ETIMEDOUT");
  });

  test("input is written to the child's stdin", () => {
    const r = defaultRunner(["cat"], { input: "hello stdin" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hello stdin");
  });

  test("array stdio is passed through; un-piped streams come back empty", () => {
    const r = defaultRunner(
      ["sh", "-c", "echo out; echo err >&2; exit 3"],
      { stdio: ["ignore", "pipe", "pipe"], check: false },
    );
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
  });
});
