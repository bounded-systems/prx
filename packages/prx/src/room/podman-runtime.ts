/**
 * Podman runtime (prx-asr) — bring a {@link PodSpec} UP and DOWN on podman.
 *
 * {@link ./podman.renderPodmanKube} turns a PodSpec into a `podman kube play`
 * manifest; this RUNS it. The rendered manifest already declares the shared
 * `emptyDir{ medium: Memory }` door volume, so `podman kube play` provisions the
 * door fabric itself — there is no separate volume-create step:
 *
 *   playPod → `podman kube play -`  (manifest on stdin → the per-repo pod's
 *             containers + the shared tmpfs door fabric; door sockets become
 *             reachable across rooms via the shared pod namespaces)
 *   downPod → `podman kube down -`  (tear it back down by the manifest's names)
 *
 * Commands run through an injected {@link PodmanRun} — {@link spawnPodman} by
 * default (routed through `@bounded-systems/proc`, no raw spawn), a fake in tests
 * — so the orchestration is fully offline-testable.
 */

import { defaultRunner } from "@bounded-systems/proc";

import { renderPodmanKube } from "./podman.ts";
import type { PodSpec } from "./pod.ts";

/** Result of running a podman command to completion. */
export interface PodmanRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a `podman …` command, optionally piping `input` to its stdin. */
export type PodmanRun = (args: string[], input?: string) => PodmanRunResult;

/**
 * Default {@link PodmanRun}: route through `@bounded-systems/proc`'s
 * `defaultRunner` (no raw spawn). `check: false` — we surface a typed
 * {@link PodmanRuntimeError} ourselves rather than the runner's bare throw.
 */
export const spawnPodman: PodmanRun = (args, input) => {
  const res = defaultRunner(["podman", ...args], {
    check: false,
    ...(input !== undefined ? { input } : {}),
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

/** Thrown when a podman runtime command exits non-zero. */
export class PodmanRuntimeError extends Error {
  constructor(message: string, readonly result: PodmanRunResult) {
    super(message);
    this.name = "PodmanRuntimeError";
  }
}

function requireOk(res: PodmanRunResult, what: string): PodmanRunResult {
  if (res.status !== 0) {
    throw new PodmanRuntimeError(
      `${what} failed (exit ${res.status ?? "null"}): ${res.stderr.trim() || res.stdout.trim()}`,
      res,
    );
  }
  return res;
}

/**
 * Bring the pod UP: render its manifest and `podman kube play -` it. Returns the
 * runner result on success; throws {@link PodmanRuntimeError} on a non-zero exit.
 */
export function playPod(pod: PodSpec, run: PodmanRun = spawnPodman): PodmanRunResult {
  const manifest = renderPodmanKube(pod);
  return requireOk(run(["kube", "play", "-"], manifest), `podman kube play '${pod.name}'`);
}

/**
 * Bring the pod DOWN: `podman kube down -` against the same rendered manifest
 * (down matches by the manifest's pod/container names).
 */
export function downPod(pod: PodSpec, run: PodmanRun = spawnPodman): PodmanRunResult {
  const manifest = renderPodmanKube(pod);
  return requireOk(run(["kube", "down", "-"], manifest), `podman kube down '${pod.name}'`);
}
