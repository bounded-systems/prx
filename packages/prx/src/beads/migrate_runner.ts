// GH-1706 — destructive bd-verb chokepoint for `prx beads migrate`.
//
// The shared `src/tools/bd.ts:execBd` allowlist intentionally refuses
// `init`, `export`, `dolt show`, and `list` because every other prx caller
// only needs the read-only / structured-write subset. The migrate verb is
// the one place that genuinely needs the destructive arm
// (`bd init --reinit-local --discard-remote`), so it routes through this
// dedicated runner rather than broadening the global policy.
//
// Shape mirrors `runBeadsInit`'s `SpawnLike` convention (string command +
// argv) but funnels through `spawnCapture` so the temp-file streaming +
// no-1 MiB cap behavior from GH-1609 applies. Tests inject a fake runner
// to drive every step without spawning real bd processes.

import {
  spawnCapture,
  type SpawnCaptureResult,
} from "@bounded-systems/proc";

export type BdMigrateRunner = (
  cmd: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnCaptureResult;

export const defaultBdMigrateRunner: BdMigrateRunner = (cmd, options = {}) =>
  spawnCapture(cmd, { cwd: options.cwd, env: options.env });
