/**
 * The per-repo pod — the running fleet for one repo (one pod = one repo), made
 * concrete: claude-room + beadsd-room + keeperd-room sharing one house and the
 * door fabric. This is the diagram from the door ADR (docs/prx/beadsd-door-wiring.md)
 * as a typed {@link PodSpec}.
 *
 * Wired by the pod: claude-room's consumed beadsd/keeperd doors resolve to the
 * beadsd-room/keeperd-room that expose them, and the beadsd connection projects
 * `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET` into claude-room — firing the merged gate.
 * claude-room's `session:control` door stays sealed (the pod does not wire it).
 */

import { beadsdRoom } from "./beadsd-room.ts";
import { claudeRoom } from "./claude-room.ts";
import { keeperdRoom } from "./keeperd-room.ts";
import type { PodSpec } from "./pod.ts";

export const perRepoPod: PodSpec = {
  name: "prx-pod",
  // The shared house — one VM (darwin) or the host (linux) the pod runs on.
  // Minimal here; the OCI/VM substrate is epic prx-zj8.
  executor: { name: "prx-pod-house" },
  rooms: [claudeRoom, beadsdRoom, keeperdRoom],
  // DEFAULT_DOOR_DIR resolves rootless (XDG_RUNTIME_DIR or ~/.local/run/prx/doors)
};
