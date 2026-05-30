// GH-1384 PR-2 — bounded scout read verb. Tests use a tmpdir of fixture
// files so coverage is hermetic and stable across worktrees.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  formatScoutReadJson,
  runScoutRead,
  ScoutReadError,
} from "../read.ts";

describe("runScoutRead — bounded text-only single-file read", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prx-scout-read-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "flake.nix"), "{ description = \"x\"; }\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "binary.png"), Buffer.from([0x00, 0xff]));
    writeFileSync(
      join(root, "src", "embedded-nul.txt"),
      Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72]),
    );
    writeFileSync(join(root, "big.ts"), "x".repeat(2048));
  });

  test("reads a text file and returns sha + bytes + content", async () => {
    const result = await runScoutRead({ path: "flake.nix", in: root });
    expect(result.path).toBe(join(root, "flake.nix"));
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.content).toContain("description");
    expect(result.lines).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("missing path raises ScoutReadError(MISSING_PATH)", async () => {
    let caught: unknown = null;
    try {
      await runScoutRead({ path: "", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutReadError);
    expect((caught as ScoutReadError).code).toBe("MISSING_PATH");
  });

  test("nonexistent file raises ScoutReadError(FILE_NOT_FOUND)", async () => {
    let caught: unknown = null;
    try {
      await runScoutRead({ path: "no-such.ts", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutReadError);
    expect((caught as ScoutReadError).code).toBe("FILE_NOT_FOUND");
  });

  test("oversized file raises ScoutReadError(FILE_TOO_LARGE)", async () => {
    let caught: unknown = null;
    try {
      await runScoutRead({ path: "big.ts", in: root, maxBytes: 1024 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutReadError);
    expect((caught as ScoutReadError).code).toBe("FILE_TOO_LARGE");
  });

  test("non-text extension raises ScoutReadError(NOT_TEXT)", async () => {
    let caught: unknown = null;
    try {
      await runScoutRead({ path: "src/binary.png", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutReadError);
    expect((caught as ScoutReadError).code).toBe("NOT_TEXT");
  });

  test("text-extension file with NUL bytes raises BINARY_CONTENT", async () => {
    // .txt isn't in the allowlist (it's intentionally narrow) — but rename
    // to .md to exercise the NUL-byte fallback for an extension-passing file.
    writeFileSync(
      join(root, "src", "embedded-nul.md"),
      Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72]),
    );
    let caught: unknown = null;
    try {
      await runScoutRead({ path: "src/embedded-nul.md", in: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutReadError);
    expect((caught as ScoutReadError).code).toBe("BINARY_CONTENT");
  });

  test("GH-<n> in --in raises explicit not-implemented", async () => {
    let caught: unknown = null;
    try {
      await runScoutRead({ path: "flake.nix", in: "GH-1194" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScoutReadError);
    expect((caught as ScoutReadError).code).toBe(
      "WORKUNIT_RESOLUTION_NOT_IMPLEMENTED",
    );
  });

  test("formatScoutReadJson emits a single JSON line", async () => {
    const result = await runScoutRead({ path: "flake.nix", in: root });
    const text = formatScoutReadJson(result);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.sha256).toBe(result.sha256);
    expect(parsed.content).toBe(result.content);
  });
});
