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

import { statPath } from "@bounded-systems/fs";
import { deleteEnv, getEnv, setEnv } from "@bounded-systems/env";
import { defaultRunner } from "@bounded-systems/proc";

import {
  renderDoorFabricProvision,
  renderPodmanKube,
  renderPodmanRun,
  secretRoomContainer,
} from "./podman.ts";
import { attestLaunchForPod } from "./launch-attest.ts";
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
 * Provision + relabel the host door fabric (the `mkdir -p` + SELinux relabel
 * pre-step, prx-3urm). Injected like {@link PodmanRun} so the orchestration is
 * fully offline-testable; the default runs {@link renderDoorFabricProvision}
 * through `@bounded-systems/proc`.
 */
export type ProvisionDoorFabric = (doorDir: string) => PodmanRunResult;

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

/**
 * Default {@link ProvisionDoorFabric}: run the host `mkdir -p` + relabel argv
 * ({@link renderDoorFabricProvision}) through `@bounded-systems/proc`'s
 * `defaultRunner`. `check: false` — a non-zero exit surfaces as a typed
 * {@link PodmanRuntimeError} via {@link requireOk} in {@link playPod}, not the
 * runner's bare throw.
 */
export const provisionDoorFabric: ProvisionDoorFabric = (doorDir) => {
  const res = defaultRunner(renderDoorFabricProvision(doorDir), { check: false });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

/** Thrown when a podman runtime command exits non-zero. */
export class PodmanRuntimeError extends Error {
  constructor(
    message: string,
    readonly result: PodmanRunResult,
  ) {
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

/**
 * True iff the pod has at least one kube container to play — a non-secret room
 * OR a backing service (prx-asr). Drives whether `kube play`/`kube down` run.
 */
function hasKubeRooms(pod: PodSpec): boolean {
  const p = PodSpecSchema.parse(pod);
  return p.rooms.some((r) => !roomNeedsSecretRuntime(r)) || p.services.length > 0;
}

/** The named data volumes the pod's backing services WRITE (e.g. dolt-box's
 *  `prx-dolt-data`). These are the volumes the single-writer guard protects. */
function podDataVolumes(pod: PodSpec): string[] {
  return PodSpecSchema.parse(pod)
    .services.map((s) => s.dataVolume?.name)
    .filter((n): n is string => Boolean(n));
}

/** Container names currently holding `volume` (`podman ps --filter volume=`).
 *  Empty on a non-zero probe (treated as "can't tell → don't block"). */
function volumeHolders(volume: string, run: PodmanRun): string[] {
  const res = run(["ps", "--format", "{{.Names}}", "--filter", `volume=${volume}`]);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Single-writer preflight (capability contract I5, claude-box). Refuse to bring
 * up a pod whose backing service would open a SECOND writer on a data volume
 * already held by an external container — notably the claude-box Quadlet `dolt`
 * door backend that now owns `prx-dolt-data`. dolt's own working-set lock would
 * fail the second server anyway ("database is locked by another dolt process"),
 * but late and opaquely; this refuses EARLY and NAMES the holder. Only reached
 * when the pod isn't already up (the idempotency probe returned first), so any
 * holder is external or a stale leftover. Reach beads through the beadsd door
 * rather than opening a competing server.
 */
function assertNoExternalVolumeHolder(pod: PodSpec, run: PodmanRun): void {
  for (const volume of podDataVolumes(pod)) {
    const holders = volumeHolders(volume, run);
    if (holders.length > 0) {
      throw new PodmanRuntimeError(
        `refusing 'pod up': data volume '${volume}' is already held by ${holders.join(", ")} ` +
          `— the single-writer invariant (I5) forbids a second writer on it. The claude-box door ` +
          `fleet now owns this store; reach beads through the beadsd door, or stop the holder ` +
          `first to recreate the pod.`,
        { status: 1, stdout: holders.join("\n"), stderr: "" },
      );
    }
  }
}

/**
 * Bring the pod UP across the runtime split. First **provision the shared door
 * fabric** ({@link ProvisionDoorFabric}, prx-3urm) — `mkdir -p` + SELinux
 * relabel, BEFORE anything mounts it, since `kube play` would otherwise create
 * it `var_run_t` and a secret room's bind mount can't create a missing host dir
 * at all. Then `podman kube play -` the non-secret rooms (skipped when the pod
 * has none — a zero-container manifest is invalid), then `podman run --secret`
 * each secret-holding room. Returns the result of every command, in run order;
 * throws {@link PodmanRuntimeError} on the first non-zero exit (fail-fast).
 */
export function playPod(
  pod: PodSpec,
  run: PodmanRun = spawnPodman,
  provision: ProvisionDoorFabric = provisionDoorFabric,
): PodmanRunResult[] {
  const { name, doorDir } = PodSpecSchema.parse(pod);
  // Idempotency (prx-asr): `pod up` on an already-running pod is a NO-OP, not an
  // error. `podman kube play` / `podman run` would otherwise fail with "pod
  // already exists" (exit 125). `podman pod exists <name>` exits 0 iff the pod
  // exists — when it does, return without touching the running pod; `prx pod
  // down` first to recreate. (Non-destructive on purpose: don't restart healthy
  // daemons on a re-run.)
  if (run(["pod", "exists", name]).status === 0) {
    return [
      {
        status: 0,
        stdout: `pod '${name}' already running — no-op (run \`prx pod down\` first to recreate)`,
        stderr: "",
      },
    ];
  }
  // Single-writer preflight (I5): don't open a second writer on a data volume an
  // external owner already holds (e.g. the claude-box Quadlet dolt door backend).
  assertNoExternalVolumeHolder(pod, run);
  const results: PodmanRunResult[] = [];
  results.push(requireOk(provision(doorDir), `provision door fabric '${doorDir}'`));
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

/** Poll interval (ms) and total timeout (ms) waiting for the keeper socket. */
const SOCKET_POLL_MS = 500;
const SOCKET_TIMEOUT_MS = 30_000;

/**
 * Poll until a unix socket file appears at `socketPath` or the timeout elapses.
 * Injectable via `deps.waitForSocket` for unit tests (avoids real fs polling).
 */
export async function waitForSocket(
  socketPath: string,
  pollMs = SOCKET_POLL_MS,
  timeoutMs = SOCKET_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (statPath(socketPath) !== null) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return statPath(socketPath) !== null;
}

/**
 * Derive the keeper socket path from the pod's door fabric, if the pod has a
 * keeperd-room. Returns null if no keeperd door is present.
 */
function keeperSocketPath(pod: PodSpec): string | null {
  const p = PodSpecSchema.parse(pod);
  for (const room of p.rooms) {
    for (const door of room.doors) {
      if (door.direction === "expose" && door.name === "keeperd") {
        const socketFile = door.socket.split("/").at(-1) ?? door.socket;
        return `${p.doorDir}/${socketFile}`;
      }
    }
  }
  return null;
}

/**
 * Derive the keeper TCP port from the keeperd-room, if set. Returns null if
 * the pod has no keeperd-room or the room declares no `tcpPort`. When non-null,
 * `launchPod` uses `KEEPERD_HOST` (TCP) instead of `KEEPERD_SOCK` (Unix) —
 * the macOS virtiofs workaround: the socket file appears on the host
 * filesystem but connections from the Mac host fail (virtiofs forwards file
 * semantics, not socket semantics).
 */
function keeperTcpPort(pod: PodSpec): number | null {
  const p = PodSpecSchema.parse(pod);
  for (const room of p.rooms) {
    if (room.tcpPort !== undefined) {
      for (const door of room.doors) {
        if (door.direction === "expose" && door.name === "keeperd") {
          return room.tcpPort;
        }
      }
    }
  }
  return null;
}

/**
 * Launch a pod AND attest its launch (capability chain). {@link playPod} brings
 * the pod up — the keeper door (a secret room) comes up last — then we wait for
 * the keeper socket to appear on the shared door fabric before attesting, so the
 * L2 digest is non-null on a clean run. **Best-effort attest:** a failure or
 * timeout surfaces as `l2LaunchDigest: null` but never tears the pod down.
 */
export async function launchPod(
  pod: PodSpec,
  deps: {
    run?: PodmanRun;
    provision?: ProvisionDoorFabric;
    attestLaunch?: typeof attestLaunchForPod;
    waitForSocket?: typeof waitForSocket;
  } = {},
): Promise<{ results: PodmanRunResult[]; l2LaunchDigest: string | null }> {
  const results = playPod(pod, deps.run ?? spawnPodman, deps.provision ?? provisionDoorFabric);
  const attest = deps.attestLaunch ?? attestLaunchForPod;
  const poll = deps.waitForSocket ?? waitForSocket;
  let l2LaunchDigest: string | null = null;
  try {
    const socketPath = keeperSocketPath(pod);
    const tcpPort = keeperTcpPort(pod);
    if (socketPath) await poll(socketPath);
    // Prefer KEEPERD_HOST (TCP) when the keeperd-room declares a tcpPort — on
    // macOS the socket file appears on the host filesystem via virtiofs but
    // connections from the Mac host fail (virtiofs forwards file semantics, not
    // socket semantics); TCP tunnels around this. On Linux tcpPort is unset and
    // we fall back to KEEPERD_SOCK (Unix). Restore whichever var we touch.
    let prevSock: string | undefined;
    let prevHost: string | undefined;
    if (tcpPort !== null) {
      prevHost = getEnv("KEEPERD_HOST");
      setEnv("KEEPERD_HOST", `127.0.0.1:${tcpPort}`);
    } else if (socketPath) {
      prevSock = getEnv("KEEPERD_SOCK");
      setEnv("KEEPERD_SOCK", socketPath);
    }
    try {
      l2LaunchDigest = await attest(pod);
    } finally {
      if (tcpPort !== null) {
        if (prevHost !== undefined) setEnv("KEEPERD_HOST", prevHost);
        else deleteEnv("KEEPERD_HOST");
      } else if (socketPath) {
        if (prevSock !== undefined) setEnv("KEEPERD_SOCK", prevSock);
        else deleteEnv("KEEPERD_SOCK");
      }
    }
  } catch {
    l2LaunchDigest = null;
  }
  return { results, l2LaunchDigest };
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
