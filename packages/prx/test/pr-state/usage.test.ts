import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEmptyUsageState,
  defaultUsageStatePath,
  loadUsageState,
  usageStateExists,
  writeUsageState,
} from "../../src/pr-state/usage.ts";

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "prx-usage-"));
}

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("UsageStateV1 persistence", () => {
  test("writeUsageState + loadUsageState round-trip an empty state", () => {
    const dir = freshTmpDir();
    tmpDirs.push(dir);
    const file = join(dir, ".pr", "local", "usage.json");
    const state = createEmptyUsageState();

    writeUsageState(file, state);
    const loaded = loadUsageState(file);
    expect(loaded).toEqual(state);
  });

  test("usageStateExists reflects filesystem presence", () => {
    const dir = freshTmpDir();
    tmpDirs.push(dir);
    const file = join(dir, ".pr", "local", "usage.json");
    const sibling = join(dir, ".pr", "local", "other.json");

    expect(usageStateExists(file)).toBeFalse();
    writeUsageState(file, createEmptyUsageState());
    expect(usageStateExists(file)).toBeTrue();
    expect(usageStateExists(sibling)).toBeFalse();
  });

  test("loadUsageState throws when the file is missing", () => {
    const dir = freshTmpDir();
    tmpDirs.push(dir);
    expect(() => loadUsageState(join(dir, "nope.json"))).toThrow();
  });

  test("writeUsageState rejects invalid state before touching disk", () => {
    const dir = freshTmpDir();
    tmpDirs.push(dir);
    const file = join(dir, ".pr", "local", "usage.json");
    const invalid = {
      ...createEmptyUsageState(),
      derived: {
        phase: "nope",
        mostConstrainedDimension: null,
        nearestResetAt: null,
      },
    } as unknown as ReturnType<typeof createEmptyUsageState>;

    expect(() => writeUsageState(file, invalid)).toThrow();
    expect(existsSync(file)).toBeFalse();
  });

  test("defaultUsageStatePath resolves under .pr/local/", () => {
    expect(defaultUsageStatePath("/tmp/repo")).toBe("/tmp/repo/.pr/local/usage.json");
  });
});
