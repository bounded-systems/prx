import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnDetached } from "../spawn-detached.ts";

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = pred();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("spawnDetached", () => {
  test("starts a process and returns a pid without blocking", () => {
    const { pid } = spawnDetached(["sleep", "0.2"]);
    expect(pid).toBeGreaterThan(0);
    try {
      process.kill(pid); // reap the detached child
    } catch {
      /* already gone */
    }
  });

  test("an empty command throws", () => {
    expect(() => spawnDetached([])).toThrow("empty command");
  });

  test("with logPath, the child's stdout+stderr are appended to the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-detached-"));
    const logPath = join(dir, "out.log");
    try {
      const { pid } = spawnDetached(["sh", "-c", "echo to-stdout; echo to-stderr 1>&2"], {
        logPath,
      });
      expect(pid).toBeGreaterThan(0);
      await waitFor(() => readFileSync(logPath, "utf8").includes("to-stderr"));
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("to-stdout");
      expect(log).toContain("to-stderr"); // stderr is redirected to the same log
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
