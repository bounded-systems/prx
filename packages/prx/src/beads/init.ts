// GH-1704 — `bd init` arg-builder + invocation primitive (per-project mode).
//
// The fleet target is per-project + Dolthub remote: `bd init` produces a
// per-repo `.beads/dolt/` and `prx repo add-dolthub` (GH-1703) wires the
// Dolthub URL. Shared-server is reserved for the `prx beads migrate` flow
// (GH-1706) and isn't the bootstrap default.
//
// Pure shape over `BdInitRunner`: build the arg list, invoke the runner,
// return a structured result. Matches the arg-builder style at
// `src/beads/migrate.ts:252-263`.
//
// GH-1750 — `homeOverride` field carries a fresh HOME for the bd init
// subprocess so bd's discovery probe at `${HOME}/.local/share/beads-home/`
// can't see a legacy embedded dolt store on the operator's real HOME.
// The flag retires by setting `homeOverride: null` once bd-upstream lands
// the discovery fix.

import { processEnv } from "@bounded-systems/env";
import {
  defaultBdInitRunner,
  type BdInitRunner,
} from "./init_runner.ts";
import {
  isCaptureFailure,
  type SpawnCaptureResult,
} from "@bounded-systems/proc";

export type BdInitOptions = {
  /** Workspace prefix; must already be validated against WORKSPACE_PREFIX_PATTERN. */
  prefix: string;
  /**
   * Stealth mode — skip writing the boilerplate `.beads/CLAUDE.md` and friends.
   * On (`true`) is the default for prx-managed repos that don't want bd's
   * scaffolding in the worktree; off emits the full bd-managed scaffolding so
   * an upstream PR can commit it.
   */
  stealth: boolean;
  /** Workspace cwd — must be inside the worktree of the target repo. */
  cwd: string;
  /**
   * GH-1750 — when set, override the bd subprocess's `HOME` env var. bd's
   * legacy-workspace discovery walks `${HOME}/.local/share/beads-home/`;
   * pointing HOME at an empty tempdir disarms that probe without touching
   * the operator's real `$HOME`. `null` (default) leaves the inherited
   * `HOME` intact.
   */
  homeOverride?: string | null;
};

export type BdInitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; status: number; stdout: string; stderr: string };

export function runBdInit(
  opts: BdInitOptions,
  runner: BdInitRunner = defaultBdInitRunner,
): BdInitResult {
  const args = [
    "bd",
    "init",
    "--non-interactive",
    `--prefix=${opts.prefix}`,
  ];
  if (opts.stealth) {
    args.push("--stealth");
  }
  const runOpts: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: opts.cwd };
  if (opts.homeOverride) {
    runOpts.env = { ...processEnv(), HOME: opts.homeOverride };
  }
  const result: SpawnCaptureResult = runner(args, runOpts);
  if (isCaptureFailure(result)) {
    return {
      ok: false,
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error?.message ?? ""),
    };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}
