import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureClaudeSettings } from "../../src/tools/ensure_claude_settings.ts";

type Fixture = {
  root: string;
  repoRoot: string;
  overlayRoot: string;
  sourcePath: string;
  targetPath: string;
  localPath: string;
};

const CANONICAL = JSON.stringify(
  {
    permissions: {
      allow: ["Read(**)", "Bash(prx doctor:*)"],
      deny: ["Bash(rm -rf:*)"],
    },
  },
  null,
  2,
) + "\n";

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-ensure-claude-settings-"));
  const repoRoot = join(root, "work");
  const overlayRoot = join(root, "ai-home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(join(overlayRoot, "claude"), { recursive: true });
  const sourcePath = join(overlayRoot, "claude", "worktree-settings.json");
  return {
    root,
    repoRoot,
    overlayRoot,
    sourcePath,
    targetPath: join(repoRoot, ".claude", "settings.json"),
    localPath: join(repoRoot, ".claude", "settings.local.json"),
  };
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

describe("ensureClaudeSettings", () => {
  test("writes target when missing", () => {
    writeFileSync(fx.sourcePath, CANONICAL);

    const result = ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: fx.overlayRoot,
    });

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe("wrote");
    expect(result.targetPath).toBe(fx.targetPath);
    expect(result.sourcePath).toBe(fx.sourcePath);
    expect(existsSync(fx.targetPath)).toBe(true);
    expect(readFileSync(fx.targetPath, "utf8")).toBe(CANONICAL);
  });

  test("no-op when target equals canonical byte-for-byte", () => {
    writeFileSync(fx.sourcePath, CANONICAL);
    mkdirSync(join(fx.repoRoot, ".claude"), { recursive: true });
    writeFileSync(fx.targetPath, CANONICAL);

    const result = ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: fx.overlayRoot,
    });

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe("unchanged");
  });

  test("re-stamps when target has drifted", () => {
    writeFileSync(fx.sourcePath, CANONICAL);
    mkdirSync(join(fx.repoRoot, ".claude"), { recursive: true });
    const drifted = `{"permissions":{"allow":["Read(**)"],"deny":[]}}\n`;
    writeFileSync(fx.targetPath, drifted);

    const result = ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: fx.overlayRoot,
    });

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe("wrote");
    expect(readFileSync(fx.targetPath, "utf8")).toBe(CANONICAL);
  });

  test("overlayRoot null → no-source, exits clean", () => {
    const result = ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: null,
    });

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe("no-source");
    expect(result.sourcePath).toBeNull();
    expect(existsSync(fx.targetPath)).toBe(false);
  });

  test("source missing under overlayRoot → no-source, target untouched", () => {
    // No file written at fx.sourcePath.
    const result = ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: fx.overlayRoot,
    });

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe("no-source");
    expect(result.sourcePath).toBe(fx.sourcePath);
    expect(existsSync(fx.targetPath)).toBe(false);
  });

  test("never touches .claude/settings.local.json", () => {
    writeFileSync(fx.sourcePath, CANONICAL);
    mkdirSync(join(fx.repoRoot, ".claude"), { recursive: true });
    const localBefore = `{"foo":"bar"}\n`;
    writeFileSync(fx.localPath, localBefore);

    ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: fx.overlayRoot,
    });

    expect(existsSync(fx.localPath)).toBe(true);
    expect(readFileSync(fx.localPath, "utf8")).toBe(localBefore);
  });

  test("creates .claude/ when absent", () => {
    writeFileSync(fx.sourcePath, CANONICAL);
    expect(existsSync(join(fx.repoRoot, ".claude"))).toBe(false);

    const result = ensureClaudeSettings({
      repoRoot: fx.repoRoot,
      overlayRoot: fx.overlayRoot,
    });

    expect(result.wrote).toBe(true);
    expect(existsSync(fx.targetPath)).toBe(true);
  });
});
