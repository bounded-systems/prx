import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMapCreate } from "../../src/map/create.ts";
import { runMapShow } from "../../src/map/show.ts";
import { MapRecordNotFoundError } from "../../src/map/record-io.ts";

function mkRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "prx-map-show-"));
}

async function seed(repoRoot: string) {
  await runMapCreate({
    kind: "inline",
    name: "delegate-unblock",
    tickets: ["GH-2011", "GH-2012"],
    rationale: "GH-2011 gates verification of GH-2012.",
    created: "2026-05-18",
    parents: ["GH-1500"],
    repoRoot,
  });
}

describe("runMapShow", () => {
  test("renders plain by default with name, created, parents, rationale, sequence", async () => {
    const repoRoot = mkRepoRoot();
    await seed(repoRoot);

    const res = await runMapShow({
      name: "delegate-unblock",
      repoRoot,
      format: "plain",
    });

    expect(res.rendered).toContain("map: delegate-unblock");
    expect(res.rendered).toContain("created: 2026-05-18");
    expect(res.rendered).toContain("parents: GH-1500");
    expect(res.rendered).toContain("GH-2011 [implementation]");
    expect(res.rendered).toContain("GH-2012 [implementation]");
  });

  test("emits parseable JSON when format=json", async () => {
    const repoRoot = mkRepoRoot();
    await seed(repoRoot);

    const res = await runMapShow({
      name: "delegate-unblock",
      repoRoot,
      format: "json",
    });

    const parsed = JSON.parse(res.rendered);
    expect(parsed.name).toBe("delegate-unblock");
    expect(parsed.sequence).toHaveLength(2);
  });

  test("propagates MapRecordNotFoundError when the map is missing", async () => {
    const repoRoot = mkRepoRoot();
    await expect(runMapShow({ name: "missing", repoRoot, format: "plain" })).rejects.toThrow(
      MapRecordNotFoundError,
    );
  });
});
