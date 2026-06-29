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
import { spawnDetached } from "@bounded-systems/proc";

import { IsolatedBeadsClient } from "./client.ts";
import { unixSocketTransport, type FramedTransport } from "../door/transport.ts";
import { getRepoRoot } from "../repo-root.ts";
import { podFor } from "../room/pod-identity.ts";

/** Where beadsd lives: a local unix socket (the host-native daemon or the pod's
 *  door fabric socket via `PRX_BEADS_SOCKET`). The in-VM Lima daemon was retired
 *  for the podman pod (prx-zj8). */
export type BeadsEndpoint = { readonly kind: "local"; readonly socket: string };

/** Default local beadsd socket (override with `PRX_BEADS_SOCKET`). */
export const DEFAULT_LOCAL_BEADS_SOCKET = "/tmp/prx-beadsd.sock";

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

/**
 * Whether `withBeadsClient` may AUTO-START a daemon on this socket. Only the
 * host-native default qualifies — a pod door socket or an explicit override is
 * owned by the pod/operator, so prx must never spawn `prx beads serve` onto it
 * (that would race the pod's own beadsd on its door path).
 */
export function isHostNativeSocket(socket: string): boolean {
  return socket === DEFAULT_LOCAL_BEADS_SOCKET;
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
 * door-gated bd READ sites (`bdDoorGate`/`bdCommandRunner`) route to the pod
 * instead of spawning host bd. No-op when already in a profile (the pod projects
 * these into rooms) or when no pod is up (the host-native daemon stays the
 * fallback until 2e.4). Returns true iff it primed the door. Call once at startup
 * before the door dialer is consulted.
 */
export function primeHostBeadsDoor(deps: PrimeHostBeadsDoorDeps = {}): boolean {
  const env = deps.env ?? getEnv;
  const set = deps.setEnvVar ?? setEnv;
  if (env("PRX_BEADS_DOOR")) return false; // already in a pod/room profile
  const socket = (deps.podSocket ?? defaultPodBeadsSocket)();
  if (!socket) return false; // no live pod → host-native fallback
  set("PRX_BEADS_DOOR", "beadsd");
  set("PRX_BEADS_SOCKET", socket);
  return true;
}

/** Deps for {@link resolveBeadsEndpoint} (injectable for tests). */
export interface ResolveBeadsEndpointDeps {
  /** The cwd's pod beadsd socket if its pod is up, else null (default: probe `podFor`). */
  podSocket?: (() => string | null) | undefined;
}

/**
 * Resolve the beads endpoint (prx-82b Slice 2b — the read router), in precedence:
 *   1. `PRX_BEADS_SOCKET` — explicit override (also how the pod projects its door
 *      socket into a room), else
 *   2. the cwd's per-repo POD socket when that pod is up (route reads to the pod),
 *      else
 *   3. {@link DEFAULT_LOCAL_BEADS_SOCKET} — the host-native daemon (auto-started
 *      by {@link withBeadsClient}). The host-native daemon stays the fallback
 *      until host bd is removed (Slice 2e); 2b just prefers the pod when present.
 */
export function resolveBeadsEndpoint(
  env: typeof getEnv = getEnv,
  deps: ResolveBeadsEndpointDeps = {},
): BeadsEndpoint {
  const override = env("PRX_BEADS_SOCKET");
  if (typeof override === "string" && override.length > 0) {
    return { kind: "local", socket: override };
  }
  const pod = (deps.podSocket ?? defaultPodBeadsSocket)();
  if (pod) return { kind: "local", socket: pod };
  return { kind: "local", socket: DEFAULT_LOCAL_BEADS_SOCKET };
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

// ── local beadsd auto-start (the "require beadsd up" prerequisite) ────────────

const READY_POLL_MS = 50;
const DEFAULT_READY_TIMEOUT_MS = 5000;

/** Default liveness probe: a `ready` query is up unless it fails to connect. */
async function defaultIsUp(socket: string): Promise<boolean> {
  const client = new IsolatedBeadsClient(unixSocketTransport(socket));
  try {
    await client.query({ kind: "ready" });
    return true; // the daemon answered
  } catch (err) {
    return !isUnreachable(err); // unreachable ⇒ down; any other error ⇒ it responded
  }
}

export interface EnsureLocalBeadsdDeps {
  /** Liveness probe (default: a `ready` query over the socket). */
  isUp?: ((socket: string) => Promise<boolean>) | undefined;
  /** Spawn the daemon detached (default {@link spawnDetached}). */
  spawn?:
    | ((cmd: string[], opts: { cwd?: string; logPath?: string }) => { pid: number })
    | undefined;
  /** Sleep between readiness polls. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface EnsureLocalBeadsdOptions {
  /** The unix socket beadsd should listen on. */
  socket: string;
  /** The repo clone beadsd serves (default: {@link getRepoRoot} — the cwd). */
  cwd?: string | undefined;
  /** The prx binary to spawn (default `prx`). */
  prxBin?: string | undefined;
  /** Pidfile the daemon writes (default `<socket>.pid`). */
  pidfile?: string | undefined;
  /** Daemon log path (default: inherit stdio). */
  logPath?: string | undefined;
  /** Max ms to wait for readiness after spawn (default 5000). */
  readyTimeoutMs?: number | undefined;
}

/**
 * Ensure a local beadsd is listening at `socket` — the seamless side of
 * "require beadsd up". No-op when already live; otherwise spawn `prx beads serve`
 * detached against the repo's beads and wait until it answers. Throws
 * {@link BeadsUnavailableError} if it can't be brought up.
 */
export async function ensureLocalBeadsd(
  opts: EnsureLocalBeadsdOptions,
  deps: EnsureLocalBeadsdDeps = {},
): Promise<void> {
  const isUp = deps.isUp ?? defaultIsUp;
  const spawn = deps.spawn ?? ((cmd, o) => spawnDetached(cmd, o));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  if (await isUp(opts.socket)) return;

  const cwd = opts.cwd ?? getRepoRoot();
  const prxBin = opts.prxBin ?? "prx";
  const pidfile = opts.pidfile ?? `${opts.socket}.pid`;
  const cmd = [
    prxBin,
    "beads",
    "serve",
    "--socket",
    opts.socket,
    "--cwd",
    cwd,
    "--pidfile",
    pidfile,
  ];
  spawn(cmd, { cwd, ...(opts.logPath !== undefined ? { logPath: opts.logPath } : {}) });

  const timeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const maxPolls = Math.max(1, Math.ceil(timeout / READY_POLL_MS));
  for (let i = 0; i < maxPolls; i++) {
    if (await isUp(opts.socket)) return;
    await sleep(READY_POLL_MS);
  }
  throw new BeadsUnavailableError(
    `spawned \`${prxBin} beads serve\` at ${opts.socket} but it did not become ready within ${timeout}ms`,
  );
}

export interface WithBeadsClientDeps {
  /** Override the resolved endpoint (default: {@link resolveBeadsEndpoint}). */
  endpoint?: BeadsEndpoint | undefined;
  /** Local transport factory (default {@link unixSocketTransport}); tests inject. */
  localTransport?: ((socket: string) => FramedTransport) | undefined;
  /**
   * Ensure a local beadsd is up before connecting (default:
   * {@link ensureLocalBeadsd}). Tests pass a no-op; a caller can disable
   * auto-start by passing `() => Promise.resolve()`.
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

  // Require beadsd up — but ONLY auto-start the HOST-NATIVE daemon. When the
  // endpoint is a POD socket (router preference, Slice 2b) or an explicit
  // override, the pod/operator owns the daemon; spawning `prx beads serve` onto
  // its door path would conflict. So pod/override sockets are connect-only — a
  // dead one surfaces as a BeadsUnavailableError below, not a host daemon.
  const ensureUp =
    deps.ensureUp ??
    (isHostNativeSocket(endpoint.socket)
      ? (socket: string) => ensureLocalBeadsd({ socket, cwd: resolveLocalBeadsCwd() })
      : () => Promise.resolve());
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
