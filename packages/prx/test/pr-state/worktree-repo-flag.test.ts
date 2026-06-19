import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRepoFlag, resolveWorktreeRepoAnchor } from "../../src/pr-state/cli.ts";
import type { LocalRepo } from "../../src/pr-state/repos.ts";

// prx-hot: `prx workspace worktree-create|worktree-remove --repo <dir|slug>` —
// the dir-agnostic anchor for the Claude `--worktree` hooks.

describe("parseRepoFlag", () => {
  test("reads --repo <value> and --repo=<value>", () => {
    expect(parseRepoFlag(["--repo", "/wt/x"])).toBe("/wt/x");
    expect(parseRepoFlag(["--repo=/wt/y"])).toBe("/wt/y");
    expect(parseRepoFlag(["worktree-create", "--repo", "bounded-systems/prx"])).toBe(
      "bounded-systems/prx",
    );
  });

  test("absent → undefined", () => {
    expect(parseRepoFlag([])).toBeUndefined();
    expect(parseRepoFlag(["worktree-create"])).toBeUndefined();
  });
});

describe("resolveWorktreeRepoAnchor", () => {
  test("an existing directory is used as-is (no registry lookup)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-anchor-"));
    let looked = false;
    const out = resolveWorktreeRepoAnchor(dir, {
      findRepoBySlug: () => {
        looked = true;
        return { ok: false, error: { kind: "not_registered", slug: dir } };
      },
    });
    expect(out).toBe(dir);
    expect(looked).toBe(false);
  });

  test("a registry slug resolves to mainWorktree (then commonDir)", () => {
    const repo = { mainWorktree: "/wt/prx.git/mainx", commonDir: "/bare/prx.git" } as LocalRepo;
    const out = resolveWorktreeRepoAnchor("bounded-systems/prx", {
      loadRepoInventoryConfig: () => ({ indexPath: "/idx.json" }) as never,
      loadRepoInventoryIndex: () => ({ repos: [] }) as never,
      findRepoBySlug: () => ({ ok: true, repo }),
    });
    expect(out).toBe("/wt/prx.git/mainx");
  });

  test("slug with no mainWorktree falls back to commonDir", () => {
    const repo = { mainWorktree: null, commonDir: "/bare/prx.git" } as LocalRepo;
    const out = resolveWorktreeRepoAnchor("prx", {
      loadRepoInventoryConfig: () => ({ indexPath: "/idx.json" }) as never,
      loadRepoInventoryIndex: () => ({ repos: [] }) as never,
      findRepoBySlug: () => ({ ok: true, repo }),
    });
    expect(out).toBe("/bare/prx.git");
  });

  test("unresolvable value is returned verbatim (downstream + bare-fallback cope)", () => {
    const out = resolveWorktreeRepoAnchor("nope/nope", {
      loadRepoInventoryConfig: () => ({ indexPath: "/idx.json" }) as never,
      loadRepoInventoryIndex: () => ({ repos: [] }) as never,
      findRepoBySlug: () => ({ ok: false, error: { kind: "not_registered", slug: "nope/nope" } }),
    });
    expect(out).toBe("nope/nope");
  });
});
