// Ephemeral lifecycle runner (prx-82b Slice 2c) — run a one-shot bd/dolt SETUP
// op inside an ephemeral beadsd-box container instead of host `bd`/`dolt`.
//
// The setup ops (`bd init`, `bd migrate`, `dolt remote add`, `bd config set`)
// run during `repo bootstrap`/`repo add` — BEFORE the repo's persistent pod
// exists — so they can't route to a pod door (chicken-and-egg). And they're
// operator-triggered (the human running `prx repo …`), same trust as running
// host `bd` today, so they need no door/capability/authorization. A one-shot
// `podman run --rm` of the pinned beadsd-box (which already bundles bd + dolt +
// git) against the repo bind sidesteps both: no persistent pod, no host bd.

import { BEADSD_ROOM_IMAGE } from "./beadsd-room.ts";
import { spawnPodman, type PodmanRun, type PodmanRunResult } from "./podman-runtime.ts";
import type { RoomSecret } from "./spec.ts";

export interface BdLifecycleOpts {
  /** Absolute host repo dir, bind-mounted at `/work` (the op's cwd). */
  repo: string;
  /** Args passed to the entrypoint binary, e.g. `["init", "--prefix", "x"]`. */
  args: string[];
  /** Entrypoint binary inside the box (default `bd`; `dolt` for raw dolt ops). */
  bin?: string | undefined;
  /** Image to run (default the pinned {@link BEADSD_ROOM_IMAGE}). */
  image?: string | undefined;
  /**
   * Host podman secrets to mount, the SAME way the pod's rooms get theirs
   * (keeperd's `keeper-key`, forge-d's App key): `--secret <name>,target=<path>`
   * (tmpfs, never a layer). Provisioned by `prx pod secrets`. This is how a
   * cred-bearing op (e.g. `dolt push` with DoltHub creds) gets its secret in the
   * ephemeral container — no ad-hoc bind. Reuses the room {@link RoomSecret}.
   */
  secrets?: readonly RoomSecret[] | undefined;
}

/**
 * The `podman run` argv (after `podman`) for a one-shot lifecycle op. Pure +
 * unit-tested. `--userns keep-id` maps the container user to the host uid so
 * writes to `/work` (the host repo bind, e.g. `bd init`'s `.beads`) are
 * host-owned, not root; `--entrypoint <bin>` bypasses the daemon entrypoint so
 * the tool runs directly against `/work`. `HOME=/tmp` because under `keep-id`
 * the image's `/home/prx` isn't writable by the remapped (host) uid, and bd/dolt
 * mkdir a global config dir under `$HOME` — without a writable HOME `bd init`
 * panics (`mkdir /home/prx/.dolt: permission denied`). Verified live. `secrets`
 * render as `--secret name,target=path`, mirroring `renderPodmanRun`.
 */
export function renderBdLifecycleArgs(o: BdLifecycleOpts): string[] {
  const secretArgs = (o.secrets ?? []).flatMap((s) => [
    "--secret",
    `${s.name},target=${s.target}`,
  ]);
  return [
    "run",
    "--rm",
    "--userns",
    "keep-id",
    "-e",
    "HOME=/tmp",
    ...secretArgs,
    "-v",
    `${o.repo}:/work`,
    "-w",
    "/work",
    "--entrypoint",
    o.bin ?? "bd",
    o.image ?? BEADSD_ROOM_IMAGE,
    ...o.args,
  ];
}

/**
 * The DoltHub-credentials secret for cred-bearing lifecycle ops (`dolt push`,
 * private `dolt clone`), declared like the other room secrets so `prx pod
 * secrets --from prx-dolt-creds=@<host dolt creds>` provisions it. NOTE: the
 * push cutover that mounts this still needs a LIVE DoltHub validation (dolt's
 * active-creds discovery for a mounted jwk) before it becomes the default — until
 * then `dolt push` stays on host.
 */
export const DOLT_CREDS_SECRET: RoomSecret = {
  name: "prx-dolt-creds",
  target: "/run/secrets/dolt-creds",
};

/** Run a one-shot lifecycle op in an ephemeral beadsd-box container. */
export function runBdLifecycle(o: BdLifecycleOpts, run: PodmanRun = spawnPodman): PodmanRunResult {
  return run(renderBdLifecycleArgs(o));
}
