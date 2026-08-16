import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedTempRoot = join(repoRoot, ".tmp", "bun-tests");

test("bun test preload routes temp files to a repo-local writable directory", () => {
  expect(resolve(tmpdir())).toBe(expectedTempRoot);

  const created = mkdtempSync(join(tmpdir(), "bun-test-bootstrap-"));
  try {
    accessSync(created, constants.W_OK);
  } finally {
    rmSync(created, { recursive: true, force: true });
  }
});
