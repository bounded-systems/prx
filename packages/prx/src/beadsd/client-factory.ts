/**
 * Unified beads client — the one door host code uses to reach beads (GH-296).
 *
 * The migration model is "require beadsd up": prx reaches beads through the
 * daemon, never local `execBd`. This factory resolves the beadsd endpoint (a
 * local unix socket — the host-native daemon or the pod's door socket) and hands back an
 * {@link IsolatedBeadsClient}, failing fast with an actionable error when the
 * daemon isn't reachable — so a missing daemon is a clear "start beadsd"
 * message, not an opaque socket error.
 *
 * Foundation only: this adds the door; it does NOT yet route the ~280 execBd
 * call sites through it (the waves) and does NOT auto-start a local daemon (a
 * follow-up). Existing code is untouched until call sites adopt `withBeadsClient`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getEnv, setEnv } from "@bounded-systems/env";
import { defaultRunner, type CommandRunner } from "@bounded-systems/proc";

import { IsolatedBeadsClient } from "./client.ts";
import { unixSocketTransport, type FramedTransport } from "../door/transport.ts";
import { getRepoRoot } from "../repo-root.ts";
import { podFor } from "../room/pod-identity.ts";

/** Where beadsd lives: a local unix socket (the host-native daemon or the pod's
 *  door fabric socket via `PRX_BEADS_SOCKET`). The in-VM Lima daemon was retired
 *  for the podman pod (prx-zj8). */
export type BeadsEndpoint = { readonly kind: "local"; readonly socket: string };

/** Thrown when beadsd isn't reachable — carries an actionable "start it" message. */
export class BeadsUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BeadsUnavailableError";
  }
}

/**
 * The cwd's per-repo POD beadsd socket, IF that pod is up (its door file exists),
 * else `null`. The host-beads read router (prx-82b Slice 2b): when a repo's pod
 * is running, host `prx beads` reads route to the pod's beadsd (`podFor()` →
 * `<doorDir>/beadsd.sock`) rather than the host-native daemon. Best-effort —
 * resolution failures (not in a repo, no inventory) just mean "no pod routing".
 */
function defaultPodBeadsSocket(): string | null {
  try {
    const socket = join(podFor(getRepoRoot()).doorDir, "beadsd.sock");
    return existsSync(socket) ? socket : null;
  } catch {
    return null;
  }
}

/** Deps for {@link primeHostBeadsDoor} (injectable for tests). */
export interface PrimeHostBeadsDoorDeps {
  env?: typeof getEnv;
  setEnvVar?: typeof setEnv;
  /** The cwd's pod beadsd socket if its pod is up, else null (default: probe `podFor`). */
  podSocket?: (() => string | null) | undefined;
}

/**
 * Host-shell read routing (prx-82b Slice 2e.1): when host `prx` runs in a repo
 * whose pod is up, point `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET` at that pod so the
 * door-gated bd READ sites route to the pod instead of spawning host bd. No-op
 * when already in a profile (the pod projects these into rooms) or when no pod is
 * up. prx-82b Slice 2e.4: there is no host-native fallback anymore — when no pod
 * is up, beads reads fail with a "run `prx pod up`" error (see
 * {@link resolveBeadsEndpoint}). Returns true iff it primed the door. Call once
 * at startup before the door dialer is consulted.
 */
export function primeHostBeadsDoor(deps: PrimeHostBeadsDoorDeps = {}): boolean {
  const env = deps.env ?? getEnv;
  const set = deps.setEnvVar ?? setEnv;
  if (env("PRX_BEADS_DOOR")) return false; // already in a pod/room profile
  const socket = (deps.podSocket ?? defaultPodBeadsSocket)();
  if (!socket) return false; // no live pod → reads fail at resolve (no fallback)
  set("PRX_BEADS_DOOR", "beadsd");
  set("PRX_BEADS_SOCKET", socket);
  return true;
}

/** Deps for {@link resolveBeadsEndpoint} (injectable for tests). */
export interface ResolveBeadsEndpointDeps {
  /** Sync command runner for git-common-dir derivation (default {@link defaultRunner}). */
  run?: CommandRunner;
  /** Path-existence probe (default `fs.existsSync`). */
  exists?: (path: string) => boolean;
}

/**
 * Resolve the beads endpoint for the current repo (prx-z7of):
 *
 * The socket is DERIVED from the repo: `git rev-parse --path-format=absolute
 * --git-common-dir` → `<git-common-dir>/.beads/dolt-server.sock` (prx-d8hc:
 * the flag matters — a normal non-bare checkout run from its own root prints
 * the bare relative ".git" without it, silently missing the real .beads/, a
 * sibling of .git rather than nested under it). `PRX_BEADS_SOCKET` overrides
 * the derived path (pods prime this via {@link primeHostBeadsDoor}).
 *
 * Errors explicitly — no silent fallbacks:
 *   - Not in a git repo → BeadsUnavailableError
 *   - Repo has no `.beads/` → BeadsUnavailableError ("not beads-configured")
 *   - Socket missing → BeadsUnavailableError ("run `prx beads serve`")
 *
 * Note: will move to a dedicated git guest eventually.
 */
export function resolveBeadsEndpoint(
  env: typeof getEnv = getEnv,
  deps: ResolveBeadsEndpointDeps = {},
): BeadsEndpoint {
  // Explicit override: trust the caller completely (pods prime this via primeHostBeadsDoor)
  const override = env("PRX_BEADS_SOCKET");
  if (typeof override === "string" && override.length > 0) {
    return { kind: "local", socket: override };
  }

  // Derive socket from git-common-dir (will move to git guest eventually)
  const run = deps.run ?? defaultRunner;
  const exists = deps.exists ?? existsSync;

  let gitCommonDir: string;
  try {
    // prx-d8hc: `--git-common-dir` alone prints the bare relative string ".git"
    // for a normal (non-bare) checkout run from its own root — join(".git",
    // ".beads") then misses the real .beads/, a SIBLING of .git, not nested
    // under it. --path-format=absolute (already used the same way in
    // pr-state/github.ts) makes this unambiguous for every checkout shape.
    gitCommonDir = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
      .stdout.trim();
  } catch {
    throw new BeadsUnavailableError("not in a git repo — cannot derive beads endpoint");
  }
  if (!gitCommonDir) {
    throw new BeadsUnavailableError("not in a git repo — cannot derive beads endpoint");
  }

  const beadsDir = join(gitCommonDir, ".beads");
  if (!exists(beadsDir)) {
    throw new BeadsUnavailableError(
      `repo at ${gitCommonDir} is not beads-configured (no .beads/) — ` +
        "run `prx pod up` or `prx beads serve --cwd <repo>`",
    );
  }

  const socket = join(beadsDir, "dolt-server.sock");
  if (!exists(socket)) {
    throw new BeadsUnavailableError(
      `per-repo beadsd not running for ${gitCommonDir} — start it with:\n` +
        `  prx beads serve --cwd ${gitCommonDir}`,
    );
  }

  return { kind: "local", socket };
}

// ── which beads the LOCAL daemon serves ───────────────────────────────────────

/** Deps for {@link resolveLocalBeadsCwd} (all injectable for tests). */
export interface ResolveLocalBeadsCwdDeps {
  /** Env lookup (default {@link getEnv}). */
  env?: typeof getEnv;
  /** Path-existence probe (default `fs.existsSync`). */
  exists?: ((path: string) => boolean) | undefined;
  /** Repo-root fallback (default {@link getRepoRoot} — cwd, not source-file). */
  repoRoot?: (() => string) | undefined;
}

/**
 * The well-known host-canonical beads clone, matching the `~/.local/state/prx/*`
 * convention (cf. the registry store). A single clone the local daemon serves so
 * every worktree reads the same beads — not each clone's own `.beads`.
 */
export function defaultCanonicalBeadsCwd(env: typeof getEnv = getEnv): string | null {
  const home = env("HOME");
  return home && home.length > 0 ? `${home}/.local/state/prx/beads` : null;
}

/**
 * Resolve the cwd the LOCAL beadsd serves — deliberately DECOUPLED from the
 * current worktree (GH-296) so every shell's `prx beads` hits one healthy beads,
 * not whichever clone's (possibly broken) `.beads` happens to be underfoot:
 *
 *   1. `PRX_BEADS_CWD` — explicit canonical clone (operator override), else
 *   2. the well-known host-canonical clone `~/.local/state/prx/beads` when it
 *      exists (zero-config once provisioned), else
 *   3. {@link getRepoRoot} — back-compat fallback: the cwd's repo root via
 *      `git rev-parse` (NOT `findRepoRoot`, whose source-file default resolves
 *      to `/$bunfs/root` in a compiled binary → prx-ag7).
 */
export function resolveLocalBeadsCwd(deps: ResolveLocalBeadsCwdDeps = {}): string {
  const env = deps.env ?? getEnv;
  const exists = deps.exists ?? existsSync;
  const repoRoot = deps.repoRoot ?? getRepoRoot;

  const override = env("PRX_BEADS_CWD");
  if (typeof override === "string" && override.length > 0) return override;

  const canonical = defaultCanonicalBeadsCwd(env);
  if (canonical && exists(canonical)) return canonical;

  return repoRoot();
}

/** Heuristic: did this error come from a connect-time failure (no daemon listening)? */
function isUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOENT|connect|did not appear|forward failed|closed the connection/i.test(
    msg,
  );
}

// prx-82b Slice 2e.4: the local beadsd AUTO-START is retired. prx never spawns
// `prx beads serve` itself — the pod owns beadsd (runs serve in-box). A missing
// daemon surfaces as a BeadsUnavailableError ("run `prx pod up`"), never a host
// spawn. (The `prx beads serve` verb itself stays — it's what the pod runs.)

export interface WithBeadsClientDeps {
  /** Override the resolved endpoint (default: {@link resolveBeadsEndpoint}). */
  endpoint?: BeadsEndpoint | undefined;
  /** Local transport factory (default {@link unixSocketTransport}); tests inject. */
  localTransport?: ((socket: string) => FramedTransport) | undefined;
  /**
   * Hook run before connecting (default: a no-op). prx-82b Slice 2e.4 retired
   * the host auto-start, so this defaults to doing nothing — the pod owns beadsd.
   * Tests/callers can still inject one (e.g. to assert it's not used).
   */
  ensureUp?: ((socket: string) => Promise<void>) | undefined;
}

/**
 * Run `fn` with a beads client over the resolved endpoint, then clean up. A
 * connect-time failure becomes a {@link BeadsUnavailableError} with a "start
 * beadsd" message — the "require beadsd up" contract.
 */
export async function withBeadsClient<T>(
  fn: (client: IsolatedBeadsClient) => Promise<T>,
  deps: WithBeadsClientDeps = {},
): Promise<T> {
  const endpoint = deps.endpoint ?? resolveBeadsEndpoint();

  // prx-82b Slice 2e.4: prx never auto-starts a daemon. The pod/operator owns
  // beadsd (the pod runs `prx beads serve` in-box); a dead/absent endpoint
  // surfaces as a BeadsUnavailableError below — connect-only, no host spawn.
  const ensureUp = deps.ensureUp ?? (() => Promise.resolve());
  await ensureUp(endpoint.socket);

  const makeTransport = deps.localTransport ?? unixSocketTransport;
  const client = new IsolatedBeadsClient(makeTransport(endpoint.socket));
  try {
    return await fn(client);
  } catch (err) {
    if (isUnreachable(err)) {
      throw new BeadsUnavailableError(
        `beadsd not reachable at ${endpoint.socket} — start it with ` +
          `\`prx beads serve --socket ${endpoint.socket} --cwd <repo>\``,
        err,
      );
    }
    throw err;
  }
}
