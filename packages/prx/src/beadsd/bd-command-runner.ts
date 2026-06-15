// Door-gated bd spawn wrappers for the direct-spawn sites.
//
// `execBd` and `defaultBdGithubRunner` are gated inside `@bounded-systems/bd`
// itself. The remaining bd reads in prx spawn `bd` directly through a proc
// `CommandRunner` (`defaultRunner`/`runCaptured`) or a `SpawnCaptureFn`. These
// wrappers apply the same `bdDoorGate` so those reads, too, route through the
// beadsd door in the box profile (PRX_BEADS_DOOR) instead of execing a local
// `bd` — without each call site re-implementing the gate.
//
// Off-profile (no door) or for non-`bd` commands the gate returns null and the
// wrapped runner runs exactly as before — a pure passthrough.

import { bdDoorGate } from "@bounded-systems/bd";
import { processEnv } from "@bounded-systems/env";
import {
  defaultRunner,
  spawnCapture,
  type CommandRunner,
  type SpawnCaptureFn,
} from "@bounded-systems/proc";

/** Wrap a {@link CommandRunner} so `bd` reads route through the door in-box. */
export function doorGatedCommandRunner(inner: CommandRunner): CommandRunner {
  return (cmd, options) => {
    const gated = bdDoorGate([...cmd], processEnv());
    if (gated) {
      return { stdout: gated.stdout, stderr: gated.stderr, status: gated.exitCode };
    }
    return inner(cmd, options);
  };
}

/** Wrap a {@link SpawnCaptureFn} so `bd` reads route through the door in-box. */
export function doorGatedSpawnCapture(inner: SpawnCaptureFn): SpawnCaptureFn {
  return (cmd, options) => {
    const gated = bdDoorGate([...cmd], processEnv());
    if (gated) {
      // Shape a SpawnCaptureResult: a fail-closed result (exitCode≠0) reads as
      // a capture failure (isCaptureFailure keys on status), surfacing the door
      // message via captureFailureDetail; a dialed read (exitCode 0) is clean.
      return { status: gated.exitCode, signal: null, stdout: gated.stdout, stderr: gated.stderr };
    }
    return inner(cmd, options);
  };
}

/** The default door-gated proc runners the bd-read sites use as their default. */
export const bdCommandRunner: CommandRunner = doorGatedCommandRunner(defaultRunner);
export const bdSpawnCapture: SpawnCaptureFn = doorGatedSpawnCapture(spawnCapture);
