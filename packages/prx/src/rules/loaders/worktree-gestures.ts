// GH-1423: stub loader for worktree-gestures.
//
// PR-1 returns `[]`. The real loader (follow-up) sources from
// `nix/home-manager/worktrunk.nix` + the `prx worktree` machine state set.

import { type WorktreeGestures, worktreeGesturesSchema } from "../schemas/inputs.ts";

export const WORKTREE_GESTURES_STUB_TICKET = "GH-1423/follow-up/worktree-gestures";

export function loadWorktreeGesturesStub(): WorktreeGestures {
  return worktreeGesturesSchema.parse([]);
}
