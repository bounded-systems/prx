/**
 * Workspace contract schemas (GH-1978).
 *
 * Round-trip each `*Input` / `*Output` schema with representative
 * payloads, plus a few "this driver passed bad shape" rejection cases.
 * Contracts are the boundary every driver depends on — break them
 * and existing call sites break, so test the rejection paths too.
 */
import { describe, expect, test } from "bun:test";

import {
  Lifecycle,
  MaterializeInput,
  MaterializeOutput,
  PrepareInput,
  PrepareOutput,
  ReserveInput,
  ReserveOutput,
  ServiceInput,
  ServiceOutput,
  SyncInput,
  SyncOutput,
  TeardownInput,
  TeardownOutput,
  WORKSPACE_INPUT_SCHEMAS,
  WORKSPACE_OUTPUT_SCHEMAS,
  WORKSPACE_VERBS,
  WorkspaceId,
} from "../../src/workspace/schema.ts";

const SAMPLE_ID = "abcdef012345";

describe("workspace contract", () => {
  test("WORKSPACE_VERBS lists every verb exactly once", () => {
    expect([...WORKSPACE_VERBS].sort()).toEqual(
      ["materialize", "prepare", "reserve", "service", "sync", "teardown"],
    );
  });

  test("WORKSPACE_*_SCHEMAS has a schema for every verb", () => {
    for (const verb of WORKSPACE_VERBS) {
      expect(WORKSPACE_INPUT_SCHEMAS[verb]).toBeDefined();
      expect(WORKSPACE_OUTPUT_SCHEMAS[verb]).toBeDefined();
    }
  });

  test("WorkspaceId enforces 12-hex shape", () => {
    expect(WorkspaceId.safeParse(SAMPLE_ID).success).toBe(true);
    expect(WorkspaceId.safeParse("ABCDEF012345").success).toBe(false);
    expect(WorkspaceId.safeParse("zzzzzzzzzzzz").success).toBe(false);
    expect(WorkspaceId.safeParse("abc").success).toBe(false);
  });

  test("Lifecycle is the closed set { materialized, attached, running }", () => {
    expect(Lifecycle.safeParse("materialized").success).toBe(true);
    expect(Lifecycle.safeParse("attached").success).toBe(true);
    expect(Lifecycle.safeParse("running").success).toBe(true);
    expect(Lifecycle.safeParse("torn-down").success).toBe(false);
    expect(Lifecycle.safeParse("").success).toBe(false);
  });
});

describe("workspace.reserve", () => {
  test("ReserveInput accepts a branch, defaults base to origin/main", () => {
    const parsed = ReserveInput.parse({ branch: "GH-1978" });
    expect(parsed.base).toBe("origin/main");
  });

  test("ReserveInput honors an explicit base", () => {
    const parsed = ReserveInput.parse({ branch: "GH-1978", base: "origin/release" });
    expect(parsed.base).toBe("origin/release");
  });

  test("ReserveInput rejects empty branch", () => {
    expect(ReserveInput.safeParse({ branch: "" }).success).toBe(false);
  });

  test("ReserveInput defaults local_only=false (GH-2271)", () => {
    expect(ReserveInput.parse({ branch: "GH-1978" }).local_only).toBe(false);
    expect(
      ReserveInput.parse({ branch: "intake/x", local_only: true }).local_only,
    ).toBe(true);
  });

  test("ReserveOutput accepts every documented status", () => {
    for (const status of [
      "created",
      "exists-local",
      "exists-remote",
      "skipped",
      "base-unresolved",
      "error",
    ] as const) {
      const out = ReserveOutput.parse({
        workspace_id: SAMPLE_ID,
        branch_ref: "GH-1978",
        status,
      });
      expect(out.status).toBe(status);
    }
  });

  test("ReserveOutput rejects an unknown status", () => {
    expect(
      ReserveOutput.safeParse({
        workspace_id: SAMPLE_ID,
        branch_ref: "GH-1978",
        status: "torn-down",
      }).success,
    ).toBe(false);
  });
});

describe("workspace.materialize (GH-2271)", () => {
  test("MaterializeInput just needs workspace_id", () => {
    expect(MaterializeInput.parse({ workspace_id: SAMPLE_ID })).toEqual({
      workspace_id: SAMPLE_ID,
    });
  });

  test("MaterializeInput rejects a bad workspace_id", () => {
    expect(MaterializeInput.safeParse({ workspace_id: "nope" }).success).toBe(
      false,
    );
  });

  test("MaterializeOutput status surface created|exists|error", () => {
    for (const status of ["created", "exists", "error"] as const) {
      const out = MaterializeOutput.parse({
        workspace_id: SAMPLE_ID,
        worktree_path: "/wt/intake/x",
        branch: "intake/x",
        status,
      });
      expect(out.status).toBe(status);
    }
  });

  test("MaterializeOutput rejects an unknown status", () => {
    expect(
      MaterializeOutput.safeParse({
        workspace_id: SAMPLE_ID,
        worktree_path: "/wt/intake/x",
        branch: "intake/x",
        status: "torn-down",
      }).success,
    ).toBe(false);
  });
});

describe("workspace.prepare", () => {
  test("PrepareInput requires workspace_id + lifecycle", () => {
    expect(
      PrepareInput.parse({ workspace_id: SAMPLE_ID, lifecycle: "attached" }),
    ).toEqual({ workspace_id: SAMPLE_ID, lifecycle: "attached" });
  });

  test("PrepareOutput round-trips with files_written empty", () => {
    const out = PrepareOutput.parse({
      workspace_id: SAMPLE_ID,
      files_written: [],
      beads_hydrated: true,
      status: "ok",
    });
    expect(out.files_written).toEqual([]);
  });
});

describe("workspace.sync", () => {
  test("SyncInput just needs workspace_id", () => {
    expect(SyncInput.parse({ workspace_id: SAMPLE_ID })).toEqual({
      workspace_id: SAMPLE_ID,
    });
  });

  test("SyncOutput status ok|noop|error", () => {
    for (const status of ["ok", "noop", "error"] as const) {
      const out = SyncOutput.parse({
        workspace_id: SAMPLE_ID,
        ignore_synced: false,
        tooling_drift_corrected: [],
        status,
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("workspace.service", () => {
  test("ServiceInput defaults auto=false", () => {
    const parsed = ServiceInput.parse({
      workspace_id: SAMPLE_ID,
      action: "start",
    });
    expect(parsed.auto).toBe(false);
  });

  test("ServiceInput action must be start|stop", () => {
    expect(
      ServiceInput.safeParse({ workspace_id: SAMPLE_ID, action: "restart" }).success,
    ).toBe(false);
  });

  test("ServiceOutput accepts the documented status surface", () => {
    for (const status of [
      "started",
      "stopped",
      "skipped",
      "no-profile",
      "error",
    ] as const) {
      const out = ServiceOutput.parse({
        workspace_id: SAMPLE_ID,
        status,
        compose_files: [],
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("workspace.teardown", () => {
  test("TeardownInput defaults force=false", () => {
    const parsed = TeardownInput.parse({ workspace_id: SAMPLE_ID });
    expect(parsed.force).toBe(false);
  });

  test("TeardownOutput status surface", () => {
    for (const status of ["torn-down", "skipped", "error"] as const) {
      const out = TeardownOutput.parse({
        workspace_id: SAMPLE_ID,
        status,
        cleaned: [],
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("contracts MUST NOT mention driver vocabulary", () => {
  // GH-1978: the contract is shared across all drivers. Any
  // `worktrunk` / `post-start` / `hook` field in a Zod schema or its
  // JSON-Schema export would tie this contract to one driver. The
  // smoke check here makes a tactical guard: serialize each schema and
  // assert none of the substrings appears.
  const BANNED = ["worktrunk", "post-start", "pre-start", "hook"] as const;

  for (const verb of WORKSPACE_VERBS) {
    test(`workspace.${verb}: no driver-vocabulary leakage`, () => {
      const input = JSON.stringify(WORKSPACE_INPUT_SCHEMAS[verb]._def);
      const output = JSON.stringify(WORKSPACE_OUTPUT_SCHEMAS[verb]._def);
      for (const term of BANNED) {
        expect(input.toLowerCase()).not.toContain(term);
        expect(output.toLowerCase()).not.toContain(term);
      }
    });
  }
});
