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
import { DEFAULT_DOOR_DIR, type PodSpec } from "./pod.ts";

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

// ── secret-holding daemons — `podman run --secret`, not kube-play (prx-b44y) ──
//
// `podman kube play` CANNOT mount a host-created podman secret (only in-YAML
// secrets, which would leak the key into the manifest). So a secret-holding
// daemon — keeperd, holding the ed25519 signing key — runs as its OWN container
// via `podman run --secret`, sourcing the key from the HOST-backed podman secret
// store (encrypted at rest → tmpfs), never the manifest. It mounts the SAME door
// fabric the kube-play pod uses (a shared volume) so the boxed agent reaches its
// door, and the repo at /work. (`podman run` is the first form; a systemd
// quadlet is the production form — same secret model.)

/** keeperd-box's signing-key mount path (its `PRX_PROVENANCE_KEY_FILE` default). */
export const DEFAULT_KEEPER_SECRET_TARGET = "/run/secrets/keeper-key";
const WORK_DIR = "/work";

/** Launch spec for the keeperd secret-daemon container. */
export interface KeeperdRunSpec {
  /** keeperd-box image ref. */
  image: string;
  /** Container name (default `keeperd-room`). */
  name?: string;
  /** Join an existing podman pod (shares its network namespace) — optional. */
  pod?: string;
  /** The host-backed podman secret holding the ed25519 signing key. */
  secret: { name: string; target?: string };
  /** The shared door fabric — a podman volume name OR a host path — mounted at `doorDir`. */
  doorVolume: string;
  /** In-container door dir (default {@link DEFAULT_DOOR_DIR}); matches keeperd-box's socket dir. */
  doorDir?: string;
  /** Host repo path bind-mounted at `/work` (keeperd's cwd). */
  repo: string;
  /** Further host-backed secrets (e.g. a push credential) mounted at their targets. */
  extraSecrets?: ReadonlyArray<{ name: string; target: string }>;
}

/**
 * Render the `podman run` argv (after `podman`) that launches keeperd-box with
 * its host-backed signing-key secret, the shared door fabric, and the repo.
 * keeperd-box's entrypoint already runs `keeper serve --socket
 * <doorDir>/keeperd.sock`, so this only appends `--cwd /work`. Pure — the driver
 * runs it.
 */
export function renderKeeperdRun(spec: KeeperdRunSpec): string[] {
  const doorDir = spec.doorDir ?? DEFAULT_DOOR_DIR;
  const name = spec.name ?? "keeperd-room";
  const args = ["run", "-d", "--name", name];
  if (spec.pod !== undefined) args.push("--pod", spec.pod);
  args.push("--secret", `${spec.secret.name},target=${spec.secret.target ?? DEFAULT_KEEPER_SECRET_TARGET}`);
  for (const s of spec.extraSecrets ?? []) args.push("--secret", `${s.name},target=${s.target}`);
  args.push("-v", `${spec.doorVolume}:${doorDir}`);
  args.push("-v", `${spec.repo}:${WORK_DIR}`);
  args.push(spec.image, "--cwd", WORK_DIR);
  return args;
}

/** Launch keeperd. Throws {@link PodmanRuntimeError} on a non-zero exit. */
export function runKeeperd(spec: KeeperdRunSpec, run: PodmanRun = spawnPodman): PodmanRunResult {
  return requireOk(run(renderKeeperdRun(spec)), `podman run keeperd '${spec.name ?? "keeperd-room"}'`);
}

/** Stop + remove the keeperd container by name. */
export function stopKeeperd(name = "keeperd-room", run: PodmanRun = spawnPodman): PodmanRunResult {
  return requireOk(run(["rm", "-f", name]), `podman rm keeperd '${name}'`);
}
