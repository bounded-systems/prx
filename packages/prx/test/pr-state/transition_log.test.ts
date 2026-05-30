import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  appendTransitionLog,
  readTransitionLog,
  validateActorOwnership,
  KNOWN_ACTORS,
  type TransitionEntry,
} from "../../src/pr-state/transition_log.ts";

function makeTmpLogPath() {
  const dir = mkdtempSync(join(tmpdir(), "transition-log-"));
  return join(dir, "transitions.jsonl");
}

function makeEntry(overrides: Partial<TransitionEntry> = {}): TransitionEntry {
  return {
    id: "test-id-001",
    issue: "GH-256",
    state_from: "drafting",
    state_to: "validating",
    actor: "codex",
    artifact: "branch:GH-256",
    timestamp: "2026-03-21T12:00:00.000Z",
    proof: { commit: "abc123def456" },
    ...overrides,
  };
}

describe("transition_log", () => {
  test("appendTransitionLog creates file and writes valid JSONL", () => {
    const logPath = makeTmpLogPath();
    const entry = makeEntry();

    appendTransitionLog(logPath, entry);

    const entries = readTransitionLog(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  test("readTransitionLog returns empty array when file does not exist", () => {
    const entries = readTransitionLog("/tmp/does-not-exist-transitions.jsonl");
    expect(entries).toHaveLength(0);
  });

  test("readTransitionLog parses multiple entries correctly", () => {
    const logPath = makeTmpLogPath();

    appendTransitionLog(logPath, makeEntry({ id: "id-1", state_to: "validating" }));
    appendTransitionLog(logPath, makeEntry({ id: "id-2", state_from: "validating", state_to: "ready_for_review" }));

    const entries = readTransitionLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe("id-1");
    expect(entries[1]!.id).toBe("id-2");
  });

  test("appendTransitionLog is idempotent: same id results in one entry", () => {
    const logPath = makeTmpLogPath();
    const entry = makeEntry({ id: "dupe-id" });

    appendTransitionLog(logPath, entry);
    appendTransitionLog(logPath, entry);
    appendTransitionLog(logPath, entry);

    const entries = readTransitionLog(logPath);
    expect(entries).toHaveLength(1);
  });

  test("appendTransitionLog allows distinct ids", () => {
    const logPath = makeTmpLogPath();

    appendTransitionLog(logPath, makeEntry({ id: "alpha" }));
    appendTransitionLog(logPath, makeEntry({ id: "beta" }));

    const entries = readTransitionLog(logPath);
    expect(entries).toHaveLength(2);
  });

  test("validateActorOwnership passes for 'codex'", () => {
    expect(() => validateActorOwnership("codex")).not.toThrow();
  });

  test("validateActorOwnership passes for a skill name", () => {
    expect(() => validateActorOwnership("pr-ready")).not.toThrow();
  });

  test("validateActorOwnership passes for a tool actor", () => {
    expect(() => validateActorOwnership("gh")).not.toThrow();
  });

  test("validateActorOwnership passes for agent.executor", () => {
    expect(() => validateActorOwnership("agent.executor")).not.toThrow();
  });

  test("validateActorOwnership throws for unknown actor", () => {
    expect(() => validateActorOwnership("unknown_actor_xyz")).toThrow(
      "unknown actor `unknown_actor_xyz`",
    );
  });

  test("KNOWN_ACTORS contains expected members", () => {
    expect(KNOWN_ACTORS.has("codex")).toBeTrue();
    expect(KNOWN_ACTORS.has("prx")).toBeTrue();
    expect(KNOWN_ACTORS.has("pr-validate")).toBeTrue();
    expect(KNOWN_ACTORS.has("claude-code")).toBeTrue();
  });
});
