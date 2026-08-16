// GH-1768 — CLI handler smoke test. Exercises every verb against an
// in-memory fixture file written to a tmpdir.
//
// GH-1809 / ai-home-jyvxo — added live-mode coverage that injects
// test-double producers via the `DeriveCliDeps` slot (no disk, no
// network).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDeriveCli, type DeriveEmitEvent } from "../../src/derive/cli.ts";
import type { DomainStateV1 } from "../../src/pr-state/domain_state.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function writeFixture(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "derive-cli-"));
  const path = join(dir, "fixture.json");
  writeFileSync(path, JSON.stringify(content), "utf8");
  return path;
}

function buildFixture() {
  return {
    rawStates: [
      {
        unitId: "GH-1",
        artifacts: {
          ticket: { exists: true, id: "GH-1", system: "bd", url: null },
          worktree: { exists: false, path: null, checkedOutBranch: null, headSha: null },
          branch: {
            name: null,
            existsLocal: false,
            existsRemote: false,
            ahead: 0,
            behind: 0,
            headShaLocal: null,
            headShaRemote: null,
          },
          pr: {
            exists: false,
            number: null,
            state: "none",
            isDraft: null,
            headRef: null,
            baseRef: null,
            url: null,
            autoMergeRequest: null,
          },
        },
        signals: {
          review: { decision: "none", reviewersRequested: false, unresolvedThreads: 0 },
          ci: { state: "none", requiredTotal: 0, requiredPassed: 0, failing: [] },
          mergeability: { state: "unknown", blockedReasons: [] },
        },
        sync: { remoteFresh: false, ticketLinkedToPR: null },
        meta: {
          observedAt: "2026-05-15T00:00:00Z",
          sources: {
            git: "2026-05-15T00:00:00Z",
            gh: "2026-05-15T00:00:00Z",
            ticketSystem: "2026-05-15T00:00:00Z",
          },
        },
      },
    ],
    beads: [{ id: "GH-1", open: true, closed: false, blockedBy: [] }],
  };
}

describe("derive CLI", () => {
  test("ready prints the ready issue and emits observability events", () => {
    const fixturePath = writeFixture(buildFixture());
    const logs: string[] = [];
    const errs: string[] = [];
    const events: DeriveEmitEvent[] = [];
    const rc = runDeriveCli(
      { verb: "ready", fixturePath, args: [], format: "table" },
      {
        log: (l) => logs.push(l),
        error: (l) => errs.push(l),
        emit: (e) => events.push(e),
      },
    );
    expect(rc).toBe(0);
    expect(logs).toEqual(["GH-1"]);
    expect(errs).toEqual([]);
    expect(events.some((e) => e.type === "DERIVE_FACTS_PROJECTED")).toBe(true);
    expect(events.some((e) => e.type === "DERIVE_QUERY_RUN")).toBe(true);
  });

  test("why prints a derivation tree and emits DERIVE_TRACE_EMITTED", () => {
    const fixturePath = writeFixture(buildFixture());
    const logs: string[] = [];
    const events: DeriveEmitEvent[] = [];
    const rc = runDeriveCli(
      { verb: "why", fixturePath, args: ["ready", "GH-1"], format: "table" },
      {
        log: (l) => logs.push(l),
        error: () => {},
        emit: (e) => events.push(e),
      },
    );
    expect(rc).toBe(0);
    expect(logs.join("\n")).toContain("[ready]");
    expect(events.some((e) => e.type === "DERIVE_TRACE_EMITTED")).toBe(true);
  });

  test("live mode (no --fixture) projects from injected DomainStateV1 + beads + transitions", () => {
    // Build a fake DomainStateV1 — only `.rawState` is read by loadLive,
    // so we cast a partial shape rather than constructing the full schema.
    const fakeRawState = buildFixture().rawStates[0];
    const fakeDomain = { rawState: fakeRawState } as unknown as DomainStateV1;
    const fakeBeads: BeadsRecord[] = [
      {
        id: "GH-1",
        title: "fake",
        description: "",
        status: "open",
        priority: 2,
        issueType: "task",
        externalRef: null,
        externalRefs: {},
        metadata: null,
        externalIssueNumber: null,
        sourceSystem: null,
        dependencies: [],
      },
    ];

    const logs: string[] = [];
    const events: DeriveEmitEvent[] = [];
    const rc = runDeriveCli(
      { verb: "why", args: ["ready", "GH-1"], format: "table" },
      {
        log: (l) => logs.push(l),
        error: () => {},
        emit: (e) => events.push(e),
      },
      {
        buildDomainState: () => fakeDomain,
        loadAllBeads: () => fakeBeads,
        readTransitionLog: () => [],
      },
    );
    expect(rc).toBe(0);
    expect(logs.join("\n")).toContain("[ready]");
    expect(events.some((e) => e.type === "DERIVE_FACTS_PROJECTED")).toBe(true);
    expect(events.some((e) => e.type === "DERIVE_TRACE_EMITTED")).toBe(true);
  });

  test("dump-facts prints every projected fact key", () => {
    const fixturePath = writeFixture(buildFixture());
    const logs: string[] = [];
    const rc = runDeriveCli(
      { verb: "dump-facts", fixturePath, args: [], format: "table" },
      { log: (l) => logs.push(l), error: () => {} },
    );
    expect(rc).toBe(0);
    expect(logs.some((l) => l.startsWith("issue("))).toBe(true);
    expect(logs.some((l) => l.startsWith("ready("))).toBe(true);
  });
});
