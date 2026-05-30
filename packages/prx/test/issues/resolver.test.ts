import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeToBdSurfaceShort,
  recognizeBareWorkspaceLongId,
  resolveIssueId,
} from "../../src/issues/resolver.ts";

describe("resolveIssueId", () => {
  test("GH-<n> resolves to a gh kind", () => {
    expect(resolveIssueId("GH-42")).toEqual({ kind: "gh", number: 42 });
  });

  test("BD-<8hex> falls through to the bd catch-all", () => {
    expect(resolveIssueId("BD-a1b2c3d4")).toEqual({ kind: "bd", id: "BD-a1b2c3d4" });
  });

  test("rejects shell metacharacters", () => {
    expect(() => resolveIssueId("BD-a1b2c3d4; ls")).toThrow();
  });

  // GH-874: Notion arm — UUID and Task-ID shapes route to `kind: "notion"`.
  test("Notion UUID (hyphenated) resolves to a notion kind with normalized value", () => {
    expect(
      resolveIssueId("550e8400-e29b-41d4-a716-446655440000"),
    ).toEqual({
      kind: "notion",
      id: { kind: "uuid", value: "550e8400-e29b-41d4-a716-446655440000" },
    });
  });

  test("Notion UUID (unhyphenated 32-hex) normalizes to hyphenated, lowercased", () => {
    expect(
      resolveIssueId("550E8400E29B41D4A716446655440000"),
    ).toEqual({
      kind: "notion",
      id: { kind: "uuid", value: "550e8400-e29b-41d4-a716-446655440000" },
    });
  });

  test("Task-ID shape (no canonical pattern) routes to notion task_id arm", () => {
    expect(resolveIssueId("PROJ-5779")).toEqual({
      kind: "notion",
      id: { kind: "task_id", value: "PROJ-5779" },
    });
  });

  test("Task-ID shape failing the canonical pattern is rejected (not routed to bd)", () => {
    expect(() =>
      resolveIssueId("PROJ-5779", "prx test", /^OPS-\d+$/),
    ).toThrow();
  });

  test("GH-<n> still routes to gh even though TASK_ID_SHAPE_RE matches it", () => {
    expect(resolveIssueId("GH-123")).toEqual({ kind: "gh", number: 123 });
  });

  test("bare integer still routes to gh", () => {
    expect(resolveIssueId("123")).toEqual({ kind: "gh", number: 123 });
  });

  test("semantic-id (pin.9.4.2) does not match Task-ID shape and falls through to bd", () => {
    expect(resolveIssueId("pin.9.4.2")).toEqual({ kind: "bd", id: "pin.9.4.2" });
  });
});

describe("normalizeToBdSurfaceShort", () => {
  test("BD-<8hex> short form passes through (lowercased)", () => {
    expect(normalizeToBdSurfaceShort("BD-A1B2C3D4")).toBe("BD-a1b2c3d4");
  });

  test("BD-<workspace>-<ts>-<seq>-<hex8> long form extracts the tail", () => {
    expect(
      normalizeToBdSurfaceShort("BD-ai-home-1777747201085-737-407f177f"),
    ).toBe("BD-407f177f");
  });

  test("bare workspace-long-id with hex8 tail extracts the tail", () => {
    expect(
      normalizeToBdSurfaceShort("ai-home-1777747201085-737-407F177F"),
    ).toBe("BD-407f177f");
  });

  test("returns null for semantic-id inputs with no hex8 tail", () => {
    expect(normalizeToBdSurfaceShort("demo-repo-pin.9.4.2")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(normalizeToBdSurfaceShort("")).toBeNull();
  });
});

describe("recognizeBareWorkspaceLongId", () => {
  let homeDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    origCwd = process.cwd();
    homeDir = mkdtempSync(join(tmpdir(), "gh1766-resolver-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.chdir(origCwd);
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("returns null when the input is BD-prefixed (those are surface ids)", () => {
    const repoDir = mkdtempSync(join(homeDir, "repo-"));
    expect(recognizeBareWorkspaceLongId("BD-a1b2c3d4", repoDir)).toBeNull();
  });

  test("returns null when no repo covers the cwd", () => {
    const repoDir = mkdtempSync(join(homeDir, "repo-"));
    expect(
      recognizeBareWorkspaceLongId("any-workspace-pin.9.4.2", repoDir),
    ).toBeNull();
  });
});
