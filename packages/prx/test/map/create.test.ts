import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMapCreate } from "../../src/map/create.ts";
import { readMapRecord } from "../../src/map/record-io.ts";

function mkRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "prx-map-create-"));
}

describe("runMapCreate (inline)", () => {
  test("builds a sequence with implementation roles + writes to disk", async () => {
    const repoRoot = mkRepoRoot();
    const res = await runMapCreate({
      kind: "inline",
      name: "delegate-unblock",
      tickets: ["GH-2011", "GH-2012", "GH-1979", "GH-2010"],
      rationale: "GH-2011 gates verification of 2012/1979.",
      created: "2026-05-18",
      parents: [],
      repoRoot,
    });

    expect(res.name).toBe("delegate-unblock");
    expect(res.record.created).toBe("2026-05-18");
    expect(res.record.sequence.map((s) => s.id)).toEqual([
      "GH-2011",
      "GH-2012",
      "GH-1979",
      "GH-2010",
    ]);
    expect(res.record.sequence.every((s) => s.role === "implementation")).toBe(true);

    // Re-read from disk to confirm persistence + parse-faithfulness.
    const onDisk = readMapRecord(repoRoot, "delegate-unblock");
    expect(onDisk).toEqual(res.record);
  });

  test("rejects an empty ticket list at the boundary", async () => {
    const repoRoot = mkRepoRoot();
    await expect(
      runMapCreate({
        kind: "inline",
        name: "empty",
        tickets: [],
        rationale: "no work",
        repoRoot,
      } as never),
    ).rejects.toThrow();
  });
});

describe("runMapCreate (from-file)", () => {
  test("round-trips a structured record (roles + depends + relates)", async () => {
    const repoRoot = mkRepoRoot();
    const filePath = join(mkdtempSync(join(tmpdir(), "prx-map-input-")), "map.json");

    writeFileSync(
      filePath,
      JSON.stringify({
        name: "delegate-unblock",
        created: "2026-05-18",
        rationale: "GH-2011 gates verification of 2012/1979.",
        parents: ["GH-1500", "GH-1870"],
        sequence: [
          { id: "GH-2011", role: "gate", priority: "P0" },
          { id: "GH-2012", role: "implementation", depends: ["GH-2011"] },
          { id: "GH-2010", role: "fold-in", relates: ["GH-2011"] },
        ],
      }),
      "utf8",
    );

    const res = await runMapCreate({ kind: "from-file", path: filePath, repoRoot });
    expect(res.record.sequence[0]!.role).toBe("gate");
    expect(res.record.sequence[1]!.depends).toEqual(["GH-2011"]);
    expect(res.record.sequence[2]!.relates).toEqual(["GH-2011"]);
  });
});
