// Per-repo pod identity (prx-82b, Slice 2a) — the multiplexing foundation.
//
// The pod was a singleton (`name: "prx-pod"`, the shared `DEFAULT_DOOR_DIR`), so
// running `prx pod up` in a second repo found "prx-pod" already up and no-op'd,
// and two pods' `beadsd.sock` would collide on the one door dir. `podFor(cwd)`
// derives a per-repo identity from the repo inventory so N repos get N isolated
// pods + door fabrics — the precondition for the host-beads router (Slice 2b)
// that resolves the cwd's repo → its pod's beadsd socket.
//
// Back-compat: a cwd that isn't a registered repo (no `bd_workspace_prefix`)
// falls back to the legacy singleton identity, so existing single-pod setups keep
// working unchanged.

import { join } from "node:path";

import { localWorkspacePrefixForCwd } from "../pr-state/repos.ts";
import { DEFAULT_DOOR_DIR } from "./pod.ts";

/** Resolve a cwd to its repo slug (`bd_workspace_prefix`), or null if unregistered. */
export type SlugResolver = (cwd: string) => string | null;

const defaultSlugResolver: SlugResolver = (cwd) => localWorkspacePrefixForCwd(cwd);

/** The legacy singleton pod name (the fallback for unregistered repos). */
export const LEGACY_POD_NAME = "prx-pod";

export interface PodIdentity {
  /** The repo's `bd_workspace_prefix`, or `null` when the cwd isn't a registered repo. */
  slug: string | null;
  /** Pod name — `prx-<slug>` per repo, else the legacy singleton {@link LEGACY_POD_NAME}. */
  name: string;
  /** Door fabric dir — `<DEFAULT_DOOR_DIR>/<slug>` per repo, else the shared default. */
  doorDir: string;
}

/**
 * Resolve the pod identity for a working directory. Registered repos get a
 * per-repo `name`/`doorDir` keyed by their inventory `bd_workspace_prefix` (an
 * already fs/name-safe slug, e.g. `io_github_bounded_systems_prx`); an
 * unregistered cwd falls back to the legacy singleton.
 */
export function podFor(cwd: string, resolveSlug: SlugResolver = defaultSlugResolver): PodIdentity {
  const slug = resolveSlug(cwd);
  if (!slug) {
    return { slug: null, name: LEGACY_POD_NAME, doorDir: DEFAULT_DOOR_DIR };
  }
  return { slug, name: `prx-${slug}`, doorDir: join(DEFAULT_DOOR_DIR, slug) };
}
