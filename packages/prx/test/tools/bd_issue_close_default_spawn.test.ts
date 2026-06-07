// Covers the production defaultBdIssueCloseSpawn wrapper (the real bd spawn).
// Run against an empty temp cwd so bd resolves no workspace and errors out
// immediately — no write, no dolt, no side effects; we only assert the wrapper
// returns a well-formed result without throwing.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execBdIssueClose } from "../../src/tools/bd_issue_close.ts";

const dir = mkdtempSync(join(tmpdir(), "prx-bdclose-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("execBdIssueClose default spawn wrapper", () => {
  test("runs the real bd boundary against an empty cwd without throwing", () => {
    // No injected spawn → exercises defaultBdIssueCloseSpawn. The empty cwd has
    // no .beads workspace, so bd exits non-zero (or the binary is absent and the
    // spawn errors) — either way the wrapper returns a structured result.
    const r = execBdIssueClose({ id: "BD-definitely-not-real-xyz", cwd: dir });
    expect(typeof r.exitCode).toBe("number");
    expect(typeof r.stdout).toBe("string");
    expect(typeof r.stderr).toBe("string");
    // It did not silently "succeed" closing a bogus id.
    expect(r.exitCode).not.toBe(0);
  });
});
