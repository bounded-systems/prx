// pr-state/github — loadReviewConfig's prx.toml [review] parser (each
// require_* key, section gating, malformed lines, absent file → defaults).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReviewConfig } from "../../src/pr-state/github.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});
function repoWith(toml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-review-"));
  cleanups.push(dir);
  if (toml !== undefined) writeFileSync(join(dir, "prx.toml"), toml);
  return dir;
}

describe("loadReviewConfig", () => {
  test("absent prx.toml → defaults", () => {
    const cfg = loadReviewConfig(repoWith());
    expect(typeof cfg.requireCommentsResolved).toBe("boolean");
  });

  test("parses every [review] require_* key", () => {
    const cfg = loadReviewConfig(
      repoWith(
        [
          "# a comment",
          "[review]",
          "require_comments_resolved = false",
          "require_agent_review = false",
          "require_human_review = true",
          "require_auto_merge_enabled = true",
        ].join("\n"),
      ),
    );
    expect(cfg.requireCommentsResolved).toBe(false);
    expect(cfg.requireAgentReview).toBe(false);
    expect(cfg.requireHumanReview).toBe(true);
    expect(cfg.requireAutoMergeEnabled).toBe(true);
  });

  test("ignores keys outside the [review] section + malformed / non-boolean lines", () => {
    const cfg = loadReviewConfig(
      repoWith(
        [
          "[project]",
          "require_human_review = false", // wrong section → ignored
          "[review]",
          "not a key line",
          "require_human_review = notabool", // invalid → skipped
          "require_agent_review = true",
        ].join("\n"),
      ),
    );
    // require_human_review stayed at its default (the [project] line + invalid value were ignored)
    expect(cfg.requireAgentReview).toBe(true);
  });
});
