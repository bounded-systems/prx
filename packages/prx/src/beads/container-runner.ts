// Container-backed bd lifecycle runner (prx-82b Slice 2c.2) — the adapter that
// lets `runBdInit` / `runMigrate` / the bootstrap `config set` run their bd op in
// an EPHEMERAL beadsd-box container instead of host `bd`. It satisfies the
// `BdInitRunner`/`BdMigrateRunner` seam shape `(cmd, {cwd}) => SpawnCaptureResult`,
// so it drops in as the production default at those call sites with no flow
// rewrite. `cmd[0]` ("bd") becomes the container `--entrypoint`; `options.cwd` is
// the repo bound at `/work`. The `env`/`homeOverride` arg is intentionally
// ignored — it existed to disarm host bd's legacy-store discovery, which a clean
// container fs makes moot (and the runner sets a writable `HOME=/tmp`).

import type { SpawnCaptureResult } from "@bounded-systems/proc";

import { runBdLifecycle } from "../room/lifecycle-runner.ts";
import { spawnPodman, type PodmanRun } from "../room/podman-runtime.ts";

/** The shared `BdInitRunner` / `BdMigrateRunner` seam shape. */
export type BdLifecycleRunner = (
  cmd: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnCaptureResult;

/**
 * A {@link BdLifecycleRunner} that runs the bd op in an ephemeral beadsd-box
 * container (via {@link runBdLifecycle}) against `options.cwd`. The default
 * production runner for the setup lifecycle ops — host bd is no longer invoked.
 */
export function containerBdRunner(run: PodmanRun = spawnPodman): BdLifecycleRunner {
  return (cmd, options = {}) => {
    const repo = options.cwd ?? process.cwd();
    const [bin, ...args] = cmd as readonly string[];
    const res = runBdLifecycle({ repo, bin, args }, run);
    return { status: res.status, signal: null, stdout: res.stdout, stderr: res.stderr };
  };
}

/**
 * A `RepoRunner`-shaped variant (returns `{stdout, stderr, status: number}` —
 * non-null status) for the `bd dolt remote add` site in repo_add_dolthub. The
 * inline return type avoids a beads↔pr-state import cycle; it's structurally a
 * `RepoRunner` at the call site. Only cred-FREE dolt ops belong here — `dolt
 * push` needs DoltHub creds the container lacks (left on host; the sync agent
 * owns recurring push).
 */
export function containerRepoRunner(
  run: PodmanRun = spawnPodman,
): (
  cmd: string[],
  options?: { cwd?: string; check?: boolean },
) => { stdout: string; stderr: string; status: number } {
  return (cmd, options = {}) => {
    const repo = options.cwd ?? process.cwd();
    const [bin, ...args] = cmd;
    const res = runBdLifecycle({ repo, bin, args }, run);
    return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
  };
}
