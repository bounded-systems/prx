import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writeBeadsRedirect } from "../../src/beads/redirect.ts";

describe("writeBeadsRedirect (prx-jkb)", () => {
  let root: string;
  let src: string;
  let dest: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "beads-redirect-"));
    src = join(root, "mainx");
    dest = join(root, "materialized");
    mkdirSync(join(src, ".beads"), { recursive: true });
    writeFileSync(join(src, ".beads", "metadata.json"), "{}");
    mkdirSync(dest, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("writes .beads/redirect pointing (absolute) at the source .beads", () => {
    const written = writeBeadsRedirect(src, dest);
    const redirectPath = join(dest, ".beads", "redirect");
    expect(written).toEqual([redirectPath]);
    expect(readFileSync(redirectPath, "utf8").trim()).toBe(resolve(src, ".beads"));
  });

  test("deref: points at the ultimate target when the source is itself redirected", () => {
    const canonical = join(root, "canonical");
    mkdirSync(join(canonical, ".beads"), { recursive: true });
    // src is a feature worktree whose .beads redirects to canonical (absolute).
    writeFileSync(join(src, ".beads", "redirect"), `${resolve(canonical, ".beads")}\n`);

    writeBeadsRedirect(src, dest);
    expect(readFileSync(join(dest, ".beads", "redirect"), "utf8").trim()).toBe(
      resolve(canonical, ".beads"),
    );
  });

  test("no-op when the source has no .beads", () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    expect(writeBeadsRedirect(bare, dest)).toEqual([]);
    expect(existsSync(join(dest, ".beads", "redirect"))).toBe(false);
  });

  test("no-op when source and destination are the same worktree", () => {
    expect(writeBeadsRedirect(src, src)).toEqual([]);
  });
});
