// GH-1704 — the `.beads/metadata.json` dolt_mode patcher. Read→parse→overwrite
// →write against a real temp dir; the discriminated result folds both the
// success and the read/parse failure into a value (no throw).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { patchBeadsMetadataDoltMode } from "../../src/beads/metadata_patch.ts";

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "prx-beads-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("patchBeadsMetadataDoltMode", () => {
  test("flips dolt_mode to server and preserves other keys", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({ dolt_mode: "per-project", prefix: "io_x" }),
    );
    const r = patchBeadsMetadataDoltMode(dir);
    expect(r.ok).toBe(true);
    expect(r.metadataPath).toBe(join(dir, "metadata.json"));
    const written = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    expect(written.dolt_mode).toBe("server");
    expect(written.prefix).toBe("io_x"); // unrelated keys preserved
  });

  test("fails (ok:false) when metadata.json is absent", () => {
    const r = patchBeadsMetadataDoltMode(freshDir());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test("fails (ok:false) on malformed JSON", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "metadata.json"), "{ not json");
    const r = patchBeadsMetadataDoltMode(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.metadataPath).toBe(join(dir, "metadata.json"));
  });
});
