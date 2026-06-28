/**
 * The per-repo pod — the running fleet for one repo (one pod = one repo), made
 * concrete: claude-room + beadsd-room + keeperd-room sharing one house and the
 * door fabric. This is the diagram from the door ADR (docs/prx/beadsd-door-wiring.md)
 * as a typed {@link PodSpec}.
 *
 * Wired by the pod: claude-room's consumed beadsd/keeperd/ghappd doors resolve to
 * the beadsd-room/keeperd-room/ghappd-room that expose them; the beadsd connection
 * projects `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET` and the ghappd connection projects
 * `PRX_GH_APP_DOOR` into claude-room. claude-room's `session:control` door stays
 * sealed (the pod does not wire it).
 *
 * NOTE: ghappd is not repo-specific (one GitHub App, same tokens for every repo),
 * so a per-repo ghappd-room duplicates a credential daemon across repos. It rides
 * here for a self-contained pod today; a shared/singleton ghappd is a later
 * optimization (relates the host-provisioning work, prx-9yv3).
 */

import { beadsdRoom } from "./beadsd-room.ts";
import { claudeRoom } from "./claude-room.ts";
import { DOLT_BOX_IMAGE, DOLT_BOX_ENV, DOLT_DATA_VOLUME, DOLT_DATA_DIR } from "./dolt-service.ts";
import { ghappdRoom } from "./ghappd-room.ts";
import { keeperdRoom } from "./keeperd-room.ts";
import { DEFAULT_DOOR_DIR } from "./pod.ts";
import type { PodSpec } from "./pod.ts";
import type { PodService } from "./spec.ts";

/**
 * dolt-box — the standalone dolt SQL server (a backing service, NOT a room): it
 * owns the beads database on the {@link DOLT_DATA_VOLUME} named volume and serves
 * the MySQL wire on the pod netns, which beadsd-box connects to. Seeded out-of-
 * band from the dolt-data FOD (see dolt-service.ts). No doors.
 */
const doltService: PodService = {
  name: "dolt",
  image: DOLT_BOX_IMAGE,
  dataVolume: { name: DOLT_DATA_VOLUME, mountPath: DOLT_DATA_DIR },
  env: { ...DOLT_BOX_ENV },
  args: [],
};

export const perRepoPod: PodSpec = {
  name: "prx-pod",
  // The shared house — one VM (darwin) or the host (linux) the pod runs on.
  // Minimal here; the OCI/VM substrate is epic prx-zj8.
  executor: { name: "prx-pod-house" },
  rooms: [claudeRoom, beadsdRoom, keeperdRoom, ghappdRoom],
  services: [doltService],
  doorDir: DEFAULT_DOOR_DIR,
};
