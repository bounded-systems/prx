// The bd init/migrate chokepoint runners. Both verbs inject a fake runner in
// their own tests; this covers the production `default*Runner` spawn defaults
// (the only runtime code) against a harmless real command.

import { describe, expect, test } from "bun:test";

import { defaultBdInitRunner } from "../../src/beads/init_runner.ts";
import { defaultBdMigrateRunner } from "../../src/beads/migrate_runner.ts";

describe("bd runner defaults", () => {
  test("defaultBdInitRunner spawns and captures a clean command", () => {
    const r = defaultBdInitRunner(["echo", "init"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("init");
  });

  test("defaultBdMigrateRunner spawns and captures a clean command", () => {
    const r = defaultBdMigrateRunner(["echo", "migrate"], { cwd: "/tmp" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("migrate");
  });
});
