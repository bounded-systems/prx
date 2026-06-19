// `runPromoteActor` — the actor-shaped wrapper around `runTriagePromote`
// (GH-1342 parity with `runDriftFixActor`). Covers the scan phase (no `from` ⇒
// typed PromotePlan via stdout-parse), the apply phase (`from` ⇒ audit rows +
// promotedBeadIds projection), and the runtime refusal for a promote row that
// carries priority::none (the operator-undecided marker).

import { describe, expect, test } from "bun:test";

import {
  runPromoteActor,
  type PromotePlan,
  type PromotePlanRow,
} from "../../src/triage/promote.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import type { FallbackIssue } from "../../src/pr-state/github.ts";

const NOW = new Date("2026-04-29T00:00:00.000Z");
const STD_DEPS_BASE = {
  now: () => NOW,
  auditSink: { stateDirOverride: "/tmp/state", ensureDir: () => {} },
};

function issue(overrides: Partial<FallbackIssue> = {}): FallbackIssue {
  return {
    number: 100,
    title: "feat: x",
    url: "https://github.com/bdelanghe/ai-home/issues/100",
    labels: [],
    ...overrides,
  };
}

function promoteRow(overrides: Partial<PromotePlanRow> = {}): PromotePlanRow {
  return {
    number: 42,
    url: "https://github.com/bdelanghe/ai-home/issues/42",
    title: "feat: thing",
    type: "feature",
    priority: "medium",
    decision: "promote",
    reason: "execution-ready type with both axes set",
    ...overrides,
  };
}

function planFixture(rows: PromotePlanRow[]): PromotePlan {
  return { repo: "bdelanghe/ai-home", generatedAt: "2026-04-29T00:00:00.000Z", rows };
}

const noBeads = (): BeadsRecord[] => [];

describe("runPromoteActor", () => {
  test("scan phase returns a typed plan and no audit rows", () => {
    const result = runPromoteActor(
      { dryRun: false, limit: 0 },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          issue({
            number: 7,
            url: "https://github.com/bdelanghe/ai-home/issues/7",
            labels: [{ name: "type::feature" }, { name: "priority::medium" }],
          }),
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: noBeads,
        cwd: () => "/tmp/repo",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.plan).not.toBeNull();
    expect(result.plan!.repo).toBe("bdelanghe/ai-home");
    expect(result.plan!.rows[0]!.decision).toBe("promote");
    expect(result.audit).toHaveLength(0);
    expect(result.promotedBeadIds).toHaveLength(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("apply phase projects audit rows and the promoted bead id", () => {
    const fixture = JSON.stringify(planFixture([promoteRow()]));
    const result = runPromoteActor(
      { from: "/tmp/p.json", dryRun: false, limit: 0 },
      {
        ...STD_DEPS_BASE,
        // GH-296: create runs `prx beads create …` through the daemon (sync
        // runner) which echoes the record as JSON.
        run: (() => ({
          status: 0,
          stdout: JSON.stringify({ id: "bd-9000" }),
          stderr: "",
        })) as never,
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        loadAllBeads: noBeads,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.plan).toBeNull(); // apply phase emits audit, not a plan
    const create = result.audit.find((e) => e.action === "create");
    expect(create).toBeDefined();
    expect(result.promotedBeadIds).toEqual(["bd-9000"]);
  });

  test("apply phase: a dry-run create is not counted as a promoted bead id", () => {
    const fixture = JSON.stringify(planFixture([promoteRow()]));
    const result = runPromoteActor(
      { from: "/tmp/p.json", dryRun: true, limit: 0 },
      {
        ...STD_DEPS_BASE,
        execBd: () => ({ exitCode: 0, stdout: "bd-9000\n", stderr: "", policy: null }),
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        loadAllBeads: noBeads,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.promotedBeadIds).toHaveLength(0); // dryRun create excluded
  });

  test("apply phase refuses a promote row carrying priority::none", () => {
    let bdCalls = 0;
    const fixture = JSON.stringify(
      planFixture([promoteRow({ priority: "none", reason: "unscored" })]),
    );
    const result = runPromoteActor(
      { from: "/tmp/p.json", dryRun: false, limit: 0 },
      {
        ...STD_DEPS_BASE,
        execBd: () => {
          bdCalls += 1;
          return { exitCode: 0, stdout: "bd-1\n", stderr: "", policy: null };
        },
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        loadAllBeads: noBeads,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(bdCalls).toBe(0);
    const err = result.audit.find((e) => e.action === "error");
    expect(err).toBeDefined();
    expect(result.stderr.join("\n")).toContain("priority::none");
  });
});
