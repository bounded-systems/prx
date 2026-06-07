// GH-1662 cross-repo reconcile cursor. The fs is reached directly, but the
// `opts.path` override makes every read/write/clear path testable against a
// real temp file — no seam required. Covers path resolution, round-trip,
// missing/malformed/wrong-shape reads, and the clear no-op.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCrossRepoCursor,
  crossRepoCursorPath,
  readCrossRepoCursor,
  writeCrossRepoCursor,
} from "../../src/sync/cross-repo-cursor.ts";

const dirs: string[] = [];
const freshPath = () => {
  const d = mkdtempSync(join(tmpdir(), "prx-cursor-"));
  dirs.push(d);
  return join(d, "nested", "cross-repo-cursor.json");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("crossRepoCursorPath", () => {
  test("returns the explicit path override verbatim", () => {
    expect(crossRepoCursorPath({ path: "/x/cursor.json" })).toBe("/x/cursor.json");
  });
  test("resolves under XDG_STATE_HOME when set", () => {
    expect(crossRepoCursorPath({ env: { XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv })).toBe(
      "/state/prx/sync/cross-repo-cursor.json",
    );
  });
  test("falls back to ~/.local/state when XDG_STATE_HOME is blank", () => {
    const p = crossRepoCursorPath({ env: { XDG_STATE_HOME: "  " } as NodeJS.ProcessEnv });
    expect(p.endsWith("/.local/state/prx/sync/cross-repo-cursor.json")).toBe(true);
  });
});

describe("read / write / clear", () => {
  test("write then read round-trips (and mkdir -p's the parent)", () => {
    const path = freshPath();
    writeCrossRepoCursor({ tickStartedAt: "2026-06-06T00:00:00Z", nextRepoSlug: "o/r" }, { path });
    expect(readCrossRepoCursor({ path })).toEqual({
      tickStartedAt: "2026-06-06T00:00:00Z",
      nextRepoSlug: "o/r",
    });
  });

  test("read returns null when the file is absent", () => {
    expect(readCrossRepoCursor({ path: freshPath() })).toBeNull();
  });

  test("read returns null on a well-formed-but-wrong-shape cursor", () => {
    const path = freshPath();
    writeCrossRepoCursor({ tickStartedAt: "t", nextRepoSlug: "s" }, { path });
    writeFileSync(path, JSON.stringify({ tickStartedAt: 1, nextRepoSlug: "s" }));
    expect(readCrossRepoCursor({ path })).toBeNull();
  });

  test("clear removes an existing cursor and is a no-op when absent", () => {
    const path = freshPath();
    writeCrossRepoCursor({ tickStartedAt: "t", nextRepoSlug: "s" }, { path });
    expect(existsSync(path)).toBe(true);
    clearCrossRepoCursor({ path });
    expect(existsSync(path)).toBe(false);
    // Second clear must not throw.
    expect(() => clearCrossRepoCursor({ path })).not.toThrow();
  });
});
