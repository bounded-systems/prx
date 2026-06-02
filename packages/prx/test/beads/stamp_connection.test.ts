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

import { stampBeadsConnection } from "../../src/beads/stamp_connection.ts";

describe("stampBeadsConnection (prx-jkb)", () => {
  let root: string;
  let src: string;
  let dest: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stamp-conn-"));
    src = join(root, "launch");
    dest = join(root, "materialized");
    mkdirSync(join(src, ".beads", "dolt", "mydb"), { recursive: true });
    writeFileSync(join(src, ".beads", "dolt-server.port"), "3308\n");
    writeFileSync(
      join(src, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: "mydb" }),
    );
    writeFileSync(join(src, ".beads", "config.yaml"), "sync.remote: x\n");
    // runtime/data artifacts that must NOT be copied
    writeFileSync(join(src, ".beads", "dolt-server.pid"), "999\n");
    writeFileSync(join(src, ".beads", "dolt", "mydb", "data"), "rows");
    mkdirSync(dest, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("copies the connection files into dest/.beads", () => {
    const written = stampBeadsConnection(src, dest);

    expect(readFileSync(join(dest, ".beads", "dolt-server.port"), "utf8")).toBe("3308\n");
    expect(existsSync(join(dest, ".beads", "metadata.json"))).toBe(true);
    expect(existsSync(join(dest, ".beads", "config.yaml"))).toBe(true);
    expect(written).toContain(join(dest, ".beads", "dolt-server.port"));
    expect(written).toContain(join(dest, ".beads", "metadata.json"));
    expect(written).toContain(join(dest, ".beads", "config.yaml"));
  });

  test("never copies the dolt/ data dir or runtime artifacts", () => {
    stampBeadsConnection(src, dest);
    expect(existsSync(join(dest, ".beads", "dolt"))).toBe(false);
    expect(existsSync(join(dest, ".beads", "dolt-server.pid"))).toBe(false);
  });

  test("is idempotent — does not clobber a file already present in dest", () => {
    mkdirSync(join(dest, ".beads"), { recursive: true });
    writeFileSync(join(dest, ".beads", "dolt-server.port"), "9999\n");

    const written = stampBeadsConnection(src, dest);
    // existing port preserved, not overwritten…
    expect(readFileSync(join(dest, ".beads", "dolt-server.port"), "utf8")).toBe("9999\n");
    expect(written).not.toContain(join(dest, ".beads", "dolt-server.port"));
    // …but the missing ones are still stamped
    expect(existsSync(join(dest, ".beads", "metadata.json"))).toBe(true);
  });

  test("no-op when source has no .beads", () => {
    const emptySrc = join(root, "empty");
    mkdirSync(emptySrc, { recursive: true });
    expect(stampBeadsConnection(emptySrc, dest)).toEqual([]);
  });

  test("no-op when source and destination are the same worktree", () => {
    expect(stampBeadsConnection(src, src)).toEqual([]);
  });
});
