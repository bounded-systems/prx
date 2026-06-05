import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewriteFileAtomic } from "../../src/tools/atomic_file.ts";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "prx-atomic-"));
}

describe("rewriteFileAtomic", () => {
  test("is a no-op on a missing file (never creates)", () => {
    const path = join(sandbox(), "absent.txt");
    let called = false;
    const result = rewriteFileAtomic(path, () => {
      called = true;
      return "should not be written\n";
    });
    expect(result).toEqual({ existed: false, wrote: false });
    expect(called).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("rewrites an existing file and truncates the stale tail", () => {
    const path = join(sandbox(), "f.txt");
    writeFileSync(path, "a much longer original body\n");
    const result = rewriteFileAtomic(path, (current) => {
      expect(current).toBe("a much longer original body\n");
      return "short\n";
    });
    expect(result).toEqual({ existed: true, wrote: true });
    expect(readFileSync(path, "utf8")).toBe("short\n");
  });

  test("leaves an existing file untouched when transform returns null", () => {
    const path = join(sandbox(), "f.txt");
    writeFileSync(path, "keep\n");
    const result = rewriteFileAtomic(path, () => null);
    expect(result).toEqual({ existed: true, wrote: false });
    expect(readFileSync(path, "utf8")).toBe("keep\n");
  });

  test("does not write when transform returns identical content", () => {
    const path = join(sandbox(), "f.txt");
    writeFileSync(path, "same\n");
    const result = rewriteFileAtomic(path, () => "same\n");
    expect(result).toEqual({ existed: true, wrote: false });
  });
});
