/**
 * The keeperd room — the git-write daemon as a {@link RoomSpec} (GH-201). A
 * per-repo pod member: no executor (inherits the pod's house); its container
 * image is the keeperd-box image (prx-anj).
 *
 * It EXPOSES the keeperd door granting `git:write` on the shared door socket —
 * the door claude-room consumes for commits/pushes without itself holding git
 * authority (ocap: the capability lives behind the door).
 */

import type { RoomSpec } from "./spec.ts";

export const keeperdRoom: RoomSpec = {
  name: "keeperd-room",
  tier: "sandbox",
  doors: [
    {
      name: "keeperd",
      direction: "expose",
      capability: "git:write",
      socket: "/run/prx/doors/keeperd.sock",
    },
  ],
  grants: [],
};
