/**
 * gc driver registry (GH-2026/GH-2331 `tywg6`).
 *
 * Maps each `GcComponent` to its `GcDriver`. A factory (not a static map) so
 * drivers close over injected deps — the gc actor stays free of a static
 * `pr-state/cli.ts` import (ESM-cycle avoidance), and tests drive the drivers
 * offline. Adding a driver is one line; PR-1 registers only `worktree`, PR-2
 * adds `cas`, and the 10 reshape drivers follow.
 */

import type { applyParityChainActions } from "../../../pr-state/cli.ts";
import type { deleteBlob, listBlobs, listRefs, readBlob } from "../../../plan-store/cas.ts";
import type { buildParityChain } from "../../../pr-state/github.ts";
import type { applyHooks, hookStatus } from "../../../pr-state/hooks.ts";
import type { RepoGcReport } from "../../../pr-state/repo_gc.ts";
import type { RepoInventory } from "../../../pr-state/repos.ts";
import type { GcDriver } from "../capability.ts";
import type { GcComponent } from "../schema.ts";
import { createCasDriver } from "./cas.ts";
import { createChainDriver } from "./chain.ts";
import { createHooksDriver } from "./hooks.ts";
import { createRepoDriver } from "./repo.ts";
import { createWorktreeDriver } from "./worktree.ts";

/**
 * The plan-store CAS ops the `cas` driver needs, injected (GH-2312). The CLI
 * wires the real `cas.ts` fns; tests inject a stub/temp store. Injection keeps
 * the actor `run --all` test hermetic — without this bundle the cas driver
 * no-ops rather than touching the operator's real CAS.
 */
export type CasGcOps = {
  listRefs: typeof listRefs;
  readBlob: typeof readBlob;
  listBlobs: typeof listBlobs;
  deleteBlob: typeof deleteBlob;
  /**
   * In-flight-write grace window (ms): blobs newer than `now - graceMs` are
   * never marked orphan, so a concurrent `prx plan save` (which writes the
   * body+envelope blobs before the ref lands) is never reaped. Default 1h.
   */
  graceMs?: number;
};

/**
 * The hooks-reconcile ops the `hooks` driver needs, injected (GH-2331). The CLI
 * (the `gc` dispatch in `pr-state/cli.ts`, where `defaultHooksPath` + the repo
 * discovery already live) wires the real `hookStatus`/`applyHooks` and a lazy
 * inventory/path resolver; tests inject stubs. `resolve` is a thunk so a
 * non-hooks gc run never walks the repo filesystem. Without this bundle the
 * hooks driver no-ops (keeps the actor `run --all` tests hermetic).
 */
export type HooksGcOps = {
  status: typeof hookStatus;
  apply: typeof applyHooks;
  resolve: () => { inventory: RepoInventory; expectedPath: string };
};

/**
 * The repo-gc op the `repo` driver needs, injected (GH-2331). `gc/cli.ts`
 * defaults it to `runRepoGc` over the resolved inventory config + wt root (safe
 * leaf imports, like `cas`); tests inject a stub. `run(apply)` returns
 * the report (would-sweep entries when dry, swept/refused when applying).
 * Without it the driver no-ops.
 */
export type RepoGcOps = {
  run: (apply: boolean) => RepoGcReport;
};

/**
 * Deps every gc driver factory may need. Mirrors `GcTeardownDeps`
 * (`actor.ts`): runtime helpers are injected, never statically imported, so the
 * gc modules avoid the `pr-state/cli.ts` ESM cycle. `cas`/`hooks`/`repo`
 * are optional — those drivers no-op without their bundle.
 */
export type GcDriverDeps = {
  repoPath: string;
  buildParityChain: typeof buildParityChain;
  applyParityChainActions?: typeof applyParityChainActions | undefined;
  cas?: CasGcOps | undefined;
  hooks?: HooksGcOps | undefined;
  repo?: RepoGcOps | undefined;
};

/** Build the `component → driver` registry. Unregistered components are absent
 * (the fan-out skips them). */
export function buildGcRegistry(deps: GcDriverDeps): Partial<Record<GcComponent, GcDriver>> {
  return {
    worktree: createWorktreeDriver(deps),
    cas: createCasDriver(deps),
    hooks: createHooksDriver(deps),
    chain: createChainDriver(deps),
    repo: createRepoDriver(deps),
  };
}
