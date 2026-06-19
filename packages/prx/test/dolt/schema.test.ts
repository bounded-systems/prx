/**
 * Dolt contract schemas (GH-2009).
 *
 * Round-trip each `*Input` / `*Output` schema with representative
 * payloads, plus rejection cases. The contract is the boundary every
 * driver depends on — break it and existing call sites break, so test
 * the rejection paths too. Parity with test/workspace/schema.test.ts.
 */
import { describe, expect, test } from "bun:test";

import {
  AdoptInput,
  AdoptOutput,
  DOLT_INPUT_SCHEMAS,
  DOLT_OUTPUT_SCHEMAS,
  DOLT_VERBS,
  DoltServerId,
  Lifecycle,
  PolicyInput,
  PolicyOutput,
  ProvisionInput,
  ProvisionOutput,
  ReconcileInput,
  ReconcileOutput,
  RepoSlug,
  StartInput,
  StartOutput,
  StatusInput,
  StatusOutput,
  StopInput,
  StopOutput,
  SuperviseInput,
  SuperviseOutput,
  SyncAllInput,
  SyncAllOutput,
} from "../../src/dolt/schema.ts";

const SAMPLE_ID = "abcdef012345";
const SAMPLE_SLUG = "io_github_bdelanghe_ai_home";
const SAMPLE_PATH = "/tmp/repo";
const SAMPLE_DSN = "mysql://prx@127.0.0.1:3306/db";

describe("dolt contract", () => {
  test("DOLT_VERBS lists every verb exactly once", () => {
    expect([...DOLT_VERBS].sort()).toEqual([
      "adopt",
      "policy",
      "provision",
      "reconcile",
      "start",
      "status",
      "stop",
      "supervise",
      "sync-all",
    ]);
  });

  test("DOLT_*_SCHEMAS has a schema for every verb", () => {
    for (const verb of DOLT_VERBS) {
      expect(DOLT_INPUT_SCHEMAS[verb]).toBeDefined();
      expect(DOLT_OUTPUT_SCHEMAS[verb]).toBeDefined();
    }
  });

  test("DoltServerId enforces 12-hex shape", () => {
    expect(DoltServerId.safeParse(SAMPLE_ID).success).toBe(true);
    expect(DoltServerId.safeParse("ABCDEF012345").success).toBe(false);
    expect(DoltServerId.safeParse("zzzzzzzzzzzz").success).toBe(false);
    expect(DoltServerId.safeParse("abc").success).toBe(false);
  });

  test("RepoSlug enforces reverse-DNS io_github_<owner>_<repo> shape (D0, GH-1685)", () => {
    expect(RepoSlug.safeParse(SAMPLE_SLUG).success).toBe(true);
    expect(RepoSlug.safeParse("io_github_pushd_supply_plan_design").success).toBe(true);
    // legacy {host}__{owner}__{repo} form is no longer valid
    expect(RepoSlug.safeParse("github.com__bdelanghe__ai-home").success).toBe(false);
    expect(RepoSlug.safeParse("io_github").success).toBe(false);
    expect(RepoSlug.safeParse("io_github_").success).toBe(false);
    expect(RepoSlug.safeParse("io_gitlab_owner_repo").success).toBe(false);
    expect(RepoSlug.safeParse("IO_GITHUB_OWNER_REPO").success).toBe(false);
  });

  test("Lifecycle is provisioned|running|healthy|stopped|orphaned", () => {
    for (const s of ["provisioned", "running", "healthy", "stopped", "orphaned"] as const) {
      expect(Lifecycle.safeParse(s).success).toBe(true);
    }
    expect(Lifecycle.safeParse("torn-down").success).toBe(false);
    expect(Lifecycle.safeParse("").success).toBe(false);
  });
});

describe("dolt.provision", () => {
  test("ProvisionInput accepts repo_path, dolt_database optional", () => {
    expect(ProvisionInput.parse({ repo_path: SAMPLE_PATH })).toEqual({
      repo_path: SAMPLE_PATH,
    });
    expect(ProvisionInput.parse({ repo_path: SAMPLE_PATH, dolt_database: SAMPLE_SLUG })).toEqual({
      repo_path: SAMPLE_PATH,
      dolt_database: SAMPLE_SLUG,
    });
  });

  test("ProvisionInput rejects empty repo_path", () => {
    expect(ProvisionInput.safeParse({ repo_path: "" }).success).toBe(false);
  });

  test("ProvisionOutput accepts every documented status", () => {
    for (const status of ["provisioned", "exists", "error"] as const) {
      const out = ProvisionOutput.parse({
        dolt_server_id: SAMPLE_ID,
        dolt_database: SAMPLE_SLUG,
        status,
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("dolt.start", () => {
  test("StartInput defaults detach=false", () => {
    expect(StartInput.parse({ repo_path: SAMPLE_PATH })).toEqual({
      repo_path: SAMPLE_PATH,
      detach: false,
    });
  });

  test("StartOutput carries dsn + owner + port", () => {
    const out = StartOutput.parse({
      dolt_server_id: SAMPLE_ID,
      pid: 1234,
      port: 3306,
      dsn: SAMPLE_DSN,
      owner: "prx",
      status: "started",
    });
    expect(out.dsn).toBe(SAMPLE_DSN);
    expect(out.owner).toBe("prx");
  });

  test("StartOutput rejects port out of range", () => {
    expect(
      StartOutput.safeParse({
        dolt_server_id: SAMPLE_ID,
        pid: 1234,
        port: 70000,
        dsn: SAMPLE_DSN,
        owner: "prx",
        status: "started",
      }).success,
    ).toBe(false);
  });
});

describe("dolt.stop", () => {
  test("StopInput requires dolt_server_id", () => {
    expect(StopInput.parse({ dolt_server_id: SAMPLE_ID })).toEqual({
      dolt_server_id: SAMPLE_ID,
    });
    expect(StopInput.safeParse({}).success).toBe(false);
  });

  test("StopOutput status surface", () => {
    for (const status of ["stopped", "not-running", "error"] as const) {
      const out = StopOutput.parse({ dolt_server_id: SAMPLE_ID, status });
      expect(out.status).toBe(status);
    }
  });
});

describe("dolt.status", () => {
  test("StatusInput just needs repo_path", () => {
    expect(StatusInput.parse({ repo_path: SAMPLE_PATH })).toEqual({
      repo_path: SAMPLE_PATH,
    });
  });

  test("StatusOutput accepts every Lifecycle state", () => {
    for (const lifecycle of ["provisioned", "running", "healthy", "stopped", "orphaned"] as const) {
      const out = StatusOutput.parse({
        dolt_server_id: SAMPLE_ID,
        lifecycle,
        pid: null,
        port: null,
        dsn: null,
        owner: null,
        healthy: false,
        unpushed_commits: null,
      });
      expect(out.lifecycle).toBe(lifecycle);
    }
  });

  test("StatusOutput surfaces the unpushed-to-origin commit count (GH-2154)", () => {
    const out = StatusOutput.parse({
      dolt_server_id: SAMPLE_ID,
      lifecycle: "running",
      pid: null,
      port: 3308,
      dsn: null,
      owner: "external",
      healthy: true,
      unpushed_commits: 160,
    });
    expect(out.unpushed_commits).toBe(160);
    // Required field — null means undeterminable, not omitted.
    expect(
      StatusOutput.safeParse({
        dolt_server_id: SAMPLE_ID,
        lifecycle: "running",
        pid: null,
        port: 3308,
        dsn: null,
        owner: "external",
        healthy: true,
      }).success,
    ).toBe(false);
  });
});

describe("dolt.adopt", () => {
  test("AdoptInput requires repo_path + pid", () => {
    expect(AdoptInput.parse({ repo_path: SAMPLE_PATH, pid: 1234 })).toEqual({
      repo_path: SAMPLE_PATH,
      pid: 1234,
    });
    expect(AdoptInput.safeParse({ repo_path: SAMPLE_PATH }).success).toBe(false);
  });

  test("AdoptOutput status surface", () => {
    for (const status of ["adopted", "already-owned", "error"] as const) {
      const out = AdoptOutput.parse({
        dolt_server_id: SAMPLE_ID,
        pid: 1234,
        port: 3306,
        status,
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("dolt.reconcile", () => {
  test("ReconcileInput defaults dryRun=false", () => {
    expect(ReconcileInput.parse({ repo_path: SAMPLE_PATH })).toEqual({
      repo_path: SAMPLE_PATH,
      dryRun: false,
    });
  });

  test("ReconcileInput accepts resolve=schema-prefer-remote", () => {
    const parsed = ReconcileInput.parse({
      repo_path: SAMPLE_PATH,
      resolve: "schema-prefer-remote",
    });
    expect(parsed.resolve).toBe("schema-prefer-remote");
  });

  test("ReconcileOutput status surface", () => {
    for (const status of ["reconciled", "noop", "schema-conflict", "error"] as const) {
      const out = ReconcileOutput.parse({
        dolt_server_id: SAMPLE_ID,
        status,
        commits_pushed: 0,
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("dolt.sync-all", () => {
  test("SyncAllInput defaults pushOnly=false, pullOnly=false", () => {
    expect(SyncAllInput.parse({})).toEqual({
      pushOnly: false,
      pullOnly: false,
    });
  });

  test("SyncAllOutput counts non-negative", () => {
    const out = SyncAllOutput.parse({
      repos_reconciled: 3,
      repos_failed: 0,
      status: "ok",
    });
    expect(out.repos_reconciled).toBe(3);
    expect(
      SyncAllOutput.safeParse({
        repos_reconciled: -1,
        repos_failed: 0,
        status: "ok",
      }).success,
    ).toBe(false);
  });
});

describe("dolt.policy", () => {
  test("PolicyInput keys limited to dolt.auto-push|dolt.auto-commit", () => {
    expect(
      PolicyInput.parse({
        key: "dolt.auto-push",
        value: false,
        scope: "all-managed-workspaces",
      }),
    ).toEqual({
      key: "dolt.auto-push",
      value: false,
      scope: "all-managed-workspaces",
    });
    expect(
      PolicyInput.safeParse({
        key: "dolt.something-else",
        value: false,
        scope: "repo",
      }).success,
    ).toBe(false);
  });

  test("PolicyOutput status surface", () => {
    for (const status of ["applied", "noop", "error"] as const) {
      const out = PolicyOutput.parse({
        key: "dolt.auto-push",
        value: false,
        scope: "repo",
        workspaces_updated: 0,
        status,
      });
      expect(out.status).toBe(status);
    }
  });
});

describe("dolt.supervise", () => {
  test("SuperviseInput accepts enable|disable|status", () => {
    for (const action of ["enable", "disable", "status"] as const) {
      expect(SuperviseInput.parse({ action })).toEqual({ action });
    }
    expect(SuperviseInput.safeParse({ action: "restart" }).success).toBe(false);
  });

  test("SuperviseOutput reflects platform_supported", () => {
    const out = SuperviseOutput.parse({
      action: "status",
      platform_supported: false,
      status: "not-supported",
    });
    expect(out.platform_supported).toBe(false);
  });
});

describe("contracts MUST NOT mention driver vocabulary", () => {
  // GH-2009: the contract is shared across drivers. Any
  // `worktrunk` / `homebrew` / `launchd` / `bd init` / `dolthub-api` /
  // `hydrate` / `mainx` field in a Zod schema or its JSON-Schema
  // export would tie this contract to one driver. The smoke check
  // here makes a tactical guard: serialize each schema and assert
  // none of the substrings appears.
  const BANNED = [
    "worktrunk",
    "homebrew",
    "launchd",
    "bd init",
    "bd-init",
    "dolthub-api",
    "dolthub_api",
    "hydrate",
    "mainx",
  ] as const;

  for (const verb of DOLT_VERBS) {
    test(`dolt.${verb}: no driver-vocabulary leakage`, () => {
      const input = JSON.stringify(DOLT_INPUT_SCHEMAS[verb]._def);
      const output = JSON.stringify(DOLT_OUTPUT_SCHEMAS[verb]._def);
      for (const term of BANNED) {
        expect(input.toLowerCase()).not.toContain(term);
        expect(output.toLowerCase()).not.toContain(term);
      }
    });
  }
});
