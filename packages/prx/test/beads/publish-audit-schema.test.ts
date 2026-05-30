// GH-1598 — `beadsPublishAuditRowSchema` round-trips through `appendAuditRow`
// (the runtime sink boundary). Mirrors test/sync/audit-schema.test.ts.

import { describe, expect, test } from "bun:test";

import { appendAuditRow, type AuditSinkDeps } from "../../src/audit/sink.ts";
import { beadsPublishAuditRowSchema } from "../../src/triage/schemas/audit.ts";

const CREATED_ROW = {
  ts: "2026-05-13T00:00:00.000Z",
  bdId: "ai-home-publish-1",
  outcome: "created" as const,
  ghNumber: 42,
  ghUrl: "https://github.com/owner/repo/issues/42",
  actor: "claude-code" as const,
  dryRun: false,
  exitCode: 0,
};

const ERROR_ROW = {
  ts: "2026-05-13T00:00:00.000Z",
  bdId: "ai-home-publish-2",
  outcome: "error" as const,
  actor: "claude-code" as const,
  dryRun: false,
  exitCode: 1,
  stderr: "prx beads publish: no beads record",
};

function makeCapture() {
  const writes: Array<{ path: string; line: string }> = [];
  const deps: AuditSinkDeps = {
    appendFn: (path, line) => writes.push({ path, line }),
    ensureDir: () => {},
    stdoutFn: () => {},
    env: {} as NodeJS.ProcessEnv,
    stateDirOverride: "/tmp/state",
    now: () => new Date("2026-05-13T00:00:00.000Z"),
  };
  return { writes, deps };
}

describe("beadsPublishAuditRowSchema", () => {
  test("parses a well-formed created row directly", () => {
    expect(beadsPublishAuditRowSchema.parse(CREATED_ROW)).toEqual(CREATED_ROW);
  });

  test("parses an error row without ghNumber/ghUrl", () => {
    expect(beadsPublishAuditRowSchema.parse(ERROR_ROW)).toEqual(ERROR_ROW);
  });

  test("appendAuditRow accepts a created row and writes one NDJSON line", () => {
    const cap = makeCapture();
    appendAuditRow(CREATED_ROW, cap.deps);
    expect(cap.writes).toHaveLength(1);
    expect(cap.writes[0]!.path).toBe("/tmp/state/prx/audit/2026-05-13.ndjson");
    const parsed = JSON.parse(cap.writes[0]!.line.trimEnd());
    expect(parsed.outcome).toBe("created");
    expect(parsed.ghNumber).toBe(42);
    expect(parsed.bdId).toBe("ai-home-publish-1");
  });

  test("rejects rows with an unknown outcome enum value", () => {
    expect(() =>
      beadsPublishAuditRowSchema.parse({ ...CREATED_ROW, outcome: "garbage" }),
    ).toThrow();
  });

  test("rejects rows with a non-positive ghNumber", () => {
    expect(() =>
      beadsPublishAuditRowSchema.parse({ ...CREATED_ROW, ghNumber: 0 }),
    ).toThrow();
    expect(() =>
      beadsPublishAuditRowSchema.parse({ ...CREATED_ROW, ghNumber: -3 }),
    ).toThrow();
  });

  test("rejects rows missing bdId", () => {
    const { bdId: _bdId, ...rest } = CREATED_ROW;
    expect(() => beadsPublishAuditRowSchema.parse(rest)).toThrow();
  });
});
