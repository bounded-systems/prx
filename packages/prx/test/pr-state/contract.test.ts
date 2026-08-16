import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  applyTransition,
  deriveInfo,
  ensurePrState,
  loadContract,
  syncReady,
  writeContract,
  type Contract,
} from "../../src/pr-state/contract.ts";
import type { LifecycleState } from "../../src/pr-state/machine.ts";

function makeContractPath() {
  const dir = mkdtempSync(join(tmpdir(), "pr-state-contract-"));
  return join(dir, "pr.json");
}

function baseContract(state: LifecycleState = "drafting", ready = false): Contract {
  return {
    pr: {
      title: "Example PR",
      ready: {
        value: ready,
        reason: null as string | null,
        checked_by: null as string | null,
        notes: [] as string[],
      },
      lifecycle: {
        state,
        updated_by: null as string | null,
        reason: null as string | null,
        notes: [] as string[],
      },
    },
  };
}

describe("contract helpers", () => {
  test("loads and persists contract JSON", () => {
    const path = makeContractPath();
    writeContract(path, baseContract());

    const loaded = loadContract(path);
    expect(loaded.pr?.lifecycle?.state).toBe("drafting");

    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBeTrue();
  });

  test("syncs ready state and fills default reason when missing", () => {
    const contract = baseContract();
    const pr = ensurePrState(contract);

    pr.lifecycle.state = "ready_for_review";
    pr.ready.reason = null;

    syncReady(pr);

    expect(pr.ready.value).toBeTrue();
    expect(pr.ready.reason as string | null).toBe(
      "Lifecycle state `ready_for_review` implies the PR is ready for review.",
    );
  });

  test("does not overwrite an explicit ready reason", () => {
    const contract = baseContract();
    const pr = ensurePrState(contract);

    pr.lifecycle.state = "drafting";
    pr.ready.reason = "Keep this in draft until CI is green.";

    syncReady(pr);

    expect(pr.ready.value).toBeFalse();
    expect(pr.ready.reason).toBe("Keep this in draft until CI is green.");
  });

  test("applies lifecycle transitions and appends notes", () => {
    const contract = applyTransition(
      baseContract(),
      "validating",
      "pr-prime",
      "Checklist complete",
    );
    const pr = ensurePrState(contract);

    expect(pr.lifecycle.state).toBe("validating");
    expect(pr.lifecycle.updated_by).toBe("pr-prime");
    expect(pr.lifecycle.reason).toBe("Checklist complete");
    expect(pr.lifecycle.notes.at(-1)).toBe(
      "pr-prime moved lifecycle from `drafting` to `validating`",
    );
    expect(pr.ready.value).toBeFalse();
    expect(pr.ready.checked_by).toBe("pr-prime");
  });

  test("derives ready mode from lifecycle state", () => {
    const contract = baseContract("merge_ready", false);
    contract.pr!.ready!.value = false;

    expect(deriveInfo(contract)).toEqual({
      mode: "ready",
      state: "merge_ready",
      title: "Example PR",
      reason: null,
    });
  });

  test("round-trips a file through transition helpers", () => {
    const path = makeContractPath();
    writeFileSync(path, JSON.stringify(baseContract(), null, 2));

    const transitioned = applyTransition(loadContract(path), "ready_for_review", "codex", null);
    writeContract(path, transitioned);

    const reloaded = loadContract(path);
    expect(reloaded.pr?.ready?.value).toBeTrue();
    expect(reloaded.pr?.lifecycle?.state).toBe("ready_for_review");
  });
});
