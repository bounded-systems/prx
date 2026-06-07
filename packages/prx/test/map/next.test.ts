// `prx map next` — PR-1 stub. The options schema validates; the actor throws
// MapStubError until the PR-3 ranking lands.

import { describe, expect, test } from "bun:test";

import { mapNextOptionsSchema, runMapNext } from "../../src/map/next.ts";
import { MapStubError } from "../../src/map/sync.ts";

describe("map next", () => {
  test("the options schema accepts repoRoot with an optional map", () => {
    expect(mapNextOptionsSchema.parse({ repoRoot: "/r" }).map).toBeUndefined();
    expect(mapNextOptionsSchema.parse({ repoRoot: "/r", map: "core" }).map).toBe("core");
  });

  test("the schema rejects an empty repoRoot", () => {
    expect(() => mapNextOptionsSchema.parse({ repoRoot: "" })).toThrow();
  });

  test("runMapNext is a stub that throws MapStubError", async () => {
    await expect(runMapNext({ repoRoot: "/r" })).rejects.toBeInstanceOf(MapStubError);
  });
});
