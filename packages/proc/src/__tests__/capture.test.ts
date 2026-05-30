import { describe, expect, test } from "bun:test";
import {
  captureFailureDetail,
  isCaptureFailure,
  spawnCapture,
  streamCapture,
  type SpawnCaptureResult,
} from "@bounded-systems/proc";

describe("spawnCapture: real subprocess", () => {
  test(">1 MiB stdout streams through with no in-memory cap (regression for GH-1554)", () => {
    const result = spawnCapture(
      ["bun", "-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
      { env: process.env as Record<string, string> },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(2 * 1024 * 1024);
  });

  test("non-zero exit surfaces status without throwing", () => {
    const result = spawnCapture(
      ["bun", "-e", "process.exit(3)"],
      { env: process.env as Record<string, string> },
    );

    expect(result.status).toBe(3);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(isCaptureFailure(result)).toBe(true);
  });

  test("stderr capture works alongside file-streamed stdout", () => {
    const result = spawnCapture(
      ["bun", "-e", 'process.stdout.write("out"); process.stderr.write("err")'],
      { env: process.env as Record<string, string> },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("missing binary surfaces error + empty stdout (no partial bytes)", () => {
    const result = spawnCapture(["this-binary-does-not-exist-prx-test"]);
    expect(result.error).toBeDefined();
    expect(result.stdout).toBe("");
    expect(isCaptureFailure(result)).toBe(true);
  });
});

describe("isCaptureFailure", () => {
  test("returns true for spawn error", () => {
    const r: SpawnCaptureResult = {
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: new Error("spawnSync foo ENOBUFS"),
    };
    expect(isCaptureFailure(r)).toBe(true);
  });

  test("returns true for killing signal", () => {
    const r: SpawnCaptureResult = {
      status: null,
      signal: "SIGTERM",
      stdout: "partial",
      stderr: "",
    };
    expect(isCaptureFailure(r)).toBe(true);
  });

  test("returns true for non-zero exit", () => {
    const r: SpawnCaptureResult = {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
    };
    expect(isCaptureFailure(r)).toBe(true);
  });

  test("returns false for exit 0", () => {
    const r: SpawnCaptureResult = {
      status: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
    };
    expect(isCaptureFailure(r)).toBe(false);
  });
});

describe("streamCapture: real subprocess (GH-2014)", () => {
  test("tees stdout chunks through onStdout while still capturing the full payload", async () => {
    const chunks: string[] = [];
    const result = await streamCapture(
      ["bun", "-e", 'process.stdout.write("hello"); process.stdout.write(" world")'],
      {
        env: process.env as Record<string, string>,
        onStdout: (chunk) => chunks.push(chunk),
      },
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("hello world");
    // The exact chunk boundaries are decided by the kernel buffer, but the
    // concatenated stream must equal what was emitted.
    expect(chunks.join("")).toBe("hello world");
  });

  test("tees stderr chunks through onStderr alongside captured stderr", async () => {
    const chunks: string[] = [];
    const result = await streamCapture(
      ["bun", "-e", 'process.stderr.write("warn"); process.stderr.write(" tail")'],
      {
        env: process.env as Record<string, string>,
        onStderr: (chunk) => chunks.push(chunk),
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("warn tail");
    expect(chunks.join("")).toBe("warn tail");
  });

  test("non-zero exit surfaces status without throwing", async () => {
    const result = await streamCapture(
      ["bun", "-e", "process.exit(7)"],
      { env: process.env as Record<string, string> },
    );
    expect(result.status).toBe(7);
    expect(isCaptureFailure(result)).toBe(true);
  });

  test("missing binary surfaces error + empty stdout (no partial bytes)", async () => {
    const result = await streamCapture(["this-binary-does-not-exist-prx-stream-test"]);
    expect(result.error).toBeDefined();
    expect(result.stdout).toBe("");
    expect(isCaptureFailure(result)).toBe(true);
  });
});

describe("captureFailureDetail", () => {
  test("prefers error.message when present", () => {
    const r: SpawnCaptureResult = {
      status: null,
      signal: null,
      stdout: "",
      stderr: "ignored",
      error: new Error("spawnSync bd ENOBUFS"),
    };
    expect(captureFailureDetail(r)).toContain("ENOBUFS");
  });

  test("falls back to signal description", () => {
    const r: SpawnCaptureResult = {
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    };
    expect(captureFailureDetail(r)).toBe("killed by SIGKILL");
  });

  test("falls back to trimmed stderr", () => {
    const r: SpawnCaptureResult = {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "  command failed: not found\n",
    };
    expect(captureFailureDetail(r)).toBe("command failed: not found");
  });
});
