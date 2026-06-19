// GH-1704 — bd-init chokepoint for `prx repo bootstrap`.
//
// The shared `src/tools/bd.ts:execBd` allowlist intentionally refuses `init`
// because every other prx caller only needs the read-only / structured-write
// subset. The bootstrap verb is the one place that needs `bd init
// --shared-server` against a beads-less repo, so it routes through this
// dedicated runner rather than broadening the global policy.
//
// Mirrors `BdMigrateRunner` (GH-1706); funnels through `spawnCapture` so the
// temp-file streaming + no-1 MiB cap behavior from GH-1609 applies. Tests
// inject a fake runner to drive every step without spawning real bd.

import { spawnCapture, type SpawnCaptureResult } from "@bounded-systems/proc";

export type BdInitRunner = (
  cmd: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnCaptureResult;

export const defaultBdInitRunner: BdInitRunner = (cmd, options = {}) =>
  spawnCapture(cmd, { cwd: options.cwd, env: options.env });
