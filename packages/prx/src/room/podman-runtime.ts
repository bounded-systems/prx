/**
 * Podman runtime (prx-asr, prx-b44y) — bring a {@link PodSpec} UP and DOWN on
 * podman across the runtime SPLIT that secret-holding rooms force:
 *
 *   - non-secret rooms → `podman kube play -` of the rendered manifest
 *     ({@link ./podman.renderPodmanKube}). The manifest declares the shared
 *     `hostPath` door fabric, so kube-play provisions/mounts it — no separate
 *     volume-create step;
 *   - secret-holding rooms (keeperd, prx-b44y) → `podman run --secret …`
 *     ({@link ./podman.renderPodmanRun}), each its own detached container that
 *     mounts the SAME host door fabric, because `podman kube play` cannot mount
 *     a host-created podman secret. Their doors are still reachable from the
 *     kube rooms over the shared fabric.
 *
 *   playPod → kube-play the non-secret rooms (if any), then `podman run` each
 *             secret room; returns the result of every podman invocation.
 *   downPod → `podman kube down -` the non-secret rooms, then `podman rm
 *             --force` each secret-room container.
 *
 * Commands run through an injected {@link PodmanRun} — {@link spawnPodman} by
 * default (routed through `@bounded-systems/proc`, no raw spawn), a fake in tests
 * — so the orchestration is fully offline-testable.
 */

import { defaultRunner } from "@bounded-systems/proc";

import { renderPodmanKube, renderPodmanRun, secretRoomContainer } from "./podman.ts";
import { PodSpecSchema, type PodSpec } from "./pod.ts";
import { roomNeedsSecretRuntime, type RoomSpec } from "./spec.ts";

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

/** The pod's secret-holding rooms (the `podman run --secret` runtime). */
function secretRooms(pod: PodSpec): RoomSpec[] {
  return PodSpecSchema.parse(pod).rooms.filter(roomNeedsSecretRuntime);
}

/** True iff the pod has at least one non-secret room (a kube pod to play). */
function hasKubeRooms(pod: PodSpec): boolean {
  return PodSpecSchema.parse(pod).rooms.some((r) => !roomNeedsSecretRuntime(r));
}

/**
 * Bring the pod UP across the runtime split: `podman kube play -` the non-secret
 * rooms (skipped when the pod has none — a zero-container manifest is invalid),
 * then `podman run --secret` each secret-holding room. Returns the result of
 * every podman invocation, in run order; throws {@link PodmanRuntimeError} on
 * the first non-zero exit (fail-fast).
 */
export function playPod(pod: PodSpec, run: PodmanRun = spawnPodman): PodmanRunResult[] {
  const results: PodmanRunResult[] = [];
  if (hasKubeRooms(pod)) {
    const manifest = renderPodmanKube(pod);
    results.push(requireOk(run(["kube", "play", "-"], manifest), `podman kube play '${pod.name}'`));
  }
  for (const room of secretRooms(pod)) {
    results.push(
      requireOk(run(renderPodmanRun(pod, room.name)), `podman run '${pod.name}-${room.name}'`),
    );
  }
  return results;
}

/**
 * Bring the pod DOWN: `podman kube down -` the non-secret rooms (matched by the
 * manifest's names), then `podman rm --force` each secret-room container.
 * Returns the result of every podman invocation, in run order.
 */
export function downPod(pod: PodSpec, run: PodmanRun = spawnPodman): PodmanRunResult[] {
  const results: PodmanRunResult[] = [];
  if (hasKubeRooms(pod)) {
    const manifest = renderPodmanKube(pod);
    results.push(requireOk(run(["kube", "down", "-"], manifest), `podman kube down '${pod.name}'`));
  }
  for (const room of secretRooms(pod)) {
    const container = secretRoomContainer(pod, room.name);
    results.push(requireOk(run(["rm", "--force", container]), `podman rm '${container}'`));
  }
  return results;
}
