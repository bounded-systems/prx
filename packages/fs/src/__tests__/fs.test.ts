import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { statPath, removeFile, defaultFileSystem, type FileSystem } from "@bounded-systems/fs";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "bs-fs-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("statPath", () => {
  test("returns size + flags for an existing file", () => {
    withTempDir((dir) => {
      const f = join(dir, "a.txt");
      writeFileSync(f, "hello");
      const st = statPath(f);
      expect(st).not.toBeNull();
      expect(st!.sizeBytes).toBe(5);
      expect(st!.isFile).toBe(true);
      expect(st!.isDirectory).toBe(false);
      expect(typeof st!.mtimeMs).toBe("number");
    });
  });

  test("flags a directory", () => {
    withTempDir((dir) => {
      const st = statPath(dir);
      expect(st!.isDirectory).toBe(true);
      expect(st!.isFile).toBe(false);
    });
  });

  test("returns null for a missing path", () => {
    expect(statPath(join(tmpdir(), "definitely-not-here-bs-fs"))).toBeNull();
  });
});

describe("removeFile", () => {
  test("removes an existing file", () => {
    withTempDir((dir) => {
      const f = join(dir, "gone.txt");
      writeFileSync(f, "x");
      expect(existsSync(f)).toBe(true);
      removeFile(f);
      expect(existsSync(f)).toBe(false);
    });
  });

  test("is a no-op (no throw) when the file is already absent", () => {
    expect(() => removeFile(join(tmpdir(), "never-existed-bs-fs"))).not.toThrow();
  });
});

describe("FileSystem seam", () => {
  test("defaultFileSystem implements the interface and is decoratable", () => {
    const reads: string[] = [];
    const decorated: FileSystem = {
      statPath(p) {
        reads.push(p);
        return defaultFileSystem.statPath(p);
      },
      removeFile: defaultFileSystem.removeFile,
    };
    decorated.statPath("/nope");
    expect(reads).toEqual(["/nope"]);
  });
});
