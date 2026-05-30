/**
 * gc driver registry (GH-2331 `tywg6`). Guards the "one-line registration"
 * contract + current scope: `worktree` (PR-1) + `cas` (PR-2) + the reshape
 * drivers `hooks` (PR-A) and `chain` (PR-B) are wired; the remaining reshape
 * drivers (sync/derive/triage/…) land in follow-ons.
 */
import { describe, expect, test } from "bun:test";

import { buildGcRegistry, type GcDriverDeps } from "../../../src/machine/gc/drivers/registry.ts";

// buildGcRegistry only constructs drivers (no buildParityChain call), so a
// no-op stub dep suffices.
const deps = {
  repoPath: "/tmp/gc-registry-test",
  buildParityChain: () => ({ actions: [] }),
} as unknown as GcDriverDeps;

describe("buildGcRegistry", () => {
  test("registers the worktree driver", () => {
    const reg = buildGcRegistry(deps);
    expect(reg.worktree?.component).toBe("worktree");
  });

  test("registers the cas driver (PR-2)", () => {
    expect(buildGcRegistry(deps).cas?.component).toBe("cas");
  });

  test("registers the reshape drivers wired so far (hooks, chain, tmux, repo)", () => {
    const reg = buildGcRegistry(deps);
    expect(reg.hooks?.component).toBe("hooks");
    expect(reg.chain?.component).toBe("chain");
    expect(reg.tmux?.component).toBe("tmux");
    expect(reg.repo?.component).toBe("repo");
  });

  test("scope: the not-yet-built reshape drivers are absent", () => {
    const reg = buildGcRegistry(deps);
    expect(reg.sync).toBeUndefined();
    expect(reg.derive).toBeUndefined();
    expect(reg.triage).toBeUndefined();
  });
});
