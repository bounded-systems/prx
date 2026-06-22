/**
 * keeperd daemon (GH-201, slices 2 + 3b-ii).
 *
 * The in-VM side of the keeper isolation: a request handler that imports the
 * host-built commit-range bundle ({@link ./bundle.importBundleIntoRepo}) and
 * pushes it under `role=keeper` ({@link ../pr-state/keeper.runKeeperPush}), plus
 * a tiny length-prefixed-JSON framing + unix-socket server so the host's
 * {@link ./client.IsolatedKeeperClient} can reach it.
 *
 * Object-transfer model A (slice 3b-ii): the host already did the local, keyless
 * commit, so the daemon does NOT `commit-tree` — it imports the shipped commits
 * and performs only the security-sensitive push. The dispatch is
 * dependency-injected with the git/import/attest seams, so it is exercised
 * end-to-end over a real unix socket with a fake git — no VM, no keys, no
 * network. Slice 4 (GH-236) wires the provenance signer: a serve-time `signer`
 * (from the in-VM `PRX_PROVENANCE_KEY`) + a per-request `openLedger`, so a push
 * with `ledgerRef` emits a signed `push/v1` derivation.
 *
 * A handler NEVER throws to the socket: every failure becomes a typed `error`
 * response, so one bad request can't take the daemon down.
 */

import { closeSync, constants as FS, existsSync, openSync, rmSync, writeSync } from "node:fs";

import { type Derivation } from "@bounded-systems/anchored-chain";
import { execGit } from "@bounded-systems/git";
import { createDoorHandlers } from "@bounded-systems/guest-room/protocol";
import { KeeperGitError, runKeeperPush, type KeeperPushDeps } from "../pr-state/keeper.ts";
import { type AttestDeps } from "../provenance/attest.ts";
import { importBundleIntoRepo } from "./bundle.ts";
import {
  KeeperRemoteRequestSchema,
  type KeeperRemoteRequest,
  type KeeperRemoteResponse,
} from "./contract.ts";

/** Seams the daemon runs the git-write through (all injectable; tests stub them). */
export interface KeeperDaemonDeps {
  /** Git seam (defaults to `execGit`). Tests pass a fake to stay offline. */
  git?: typeof execGit | undefined;
  /**
   * GH-236 slice 4: the in-VM provenance signer, resolved once at serve time from
   * `PRX_PROVENANCE_KEY` (the key born in the VM). When present AND a request
   * carries `ledgerRef`, the push is wrapped by `attestingGit` so a clean push
   * emits a signed `push/v1` derivation into that request's ledger.
   */
  signer?: AttestDeps["signer"] | undefined;
  /**
   * Open the per-request ledger named by `request.ledgerRef` to append the
   * derivation to (closed after the push). The store is opened per request — the
   * signer is serve-wide, the ledger is request-scoped. Tests stub it.
   */
  openLedger?:
    | ((ledgerRef: string) => { store: AttestDeps["store"]; close: () => void })
    | undefined;
  /** The keeper worktree the git-writes run in (defaults to the daemon's cwd). */
  cwd?: string | undefined;
  /**
   * Import the request's commit-range bundle and make `commitSha` the tip of
   * `branch` (defaults to {@link ./bundle.importBundleIntoRepo} bound to `git`).
   * Tests stub it to stay offline / assert dispatch order.
   */
  importBundle?:
    | ((input: {
        cwd: string | undefined;
        bundleBase64: string;
        branch: string;
        commitSha: string;
      }) => void)
    | undefined;
}

/**
 * Run one keeper request to a typed verdict (model A): import the host-built
 * commit-range bundle under `role=keeper`, push the branch, and report the
 * pushed identity — or a typed `error` for any git-write failure. The commit was
 * already made on the host, so the daemon never `commit-tree`s; it only imports
 * and pushes. Pure w.r.t. the socket: returns data, never throws.
 */
export async function handleKeeperRequest(
  request: KeeperRemoteRequest,
  deps: KeeperDaemonDeps = {},
): Promise<KeeperRemoteResponse> {
  const git = deps.git ?? execGit;
  const importBundle = deps.importBundle ?? ((input) => importBundleIntoRepo(input, { git }));
  // Per-request ledger: opened here from request.ledgerRef, closed in `finally`.
  let ledger: { store: AttestDeps["store"]; close: () => void } | undefined;
  // The push/v1 derivations the attesting push appends — captured so the daemon
  // can RETURN the signed one (the host's GH-2249 requireSigned gate verifies the
  // daemon's `signedDerivation`; without returning it the door path is a no-op —
  // prx-a36l). Recorded by decorating the ledger's `append` (no `attest` change).
  const appended: Derivation[] = [];
  try {
    importBundle({
      cwd: deps.cwd,
      bundleBase64: request.bundleBase64,
      branch: request.branch,
      commitSha: request.commitSha,
    });
    const pushArgs = [request.remote, request.branch, ...(request.pushArgs ?? [])];
    let pushDeps: KeeperPushDeps = { git };
    // Attest only when the request opts in (ledgerRef) AND a signer + ledger
    // opener are configured (the in-VM PRX_PROVENANCE_KEY path). Otherwise a bare
    // push, unchanged.
    if (
      request.ledgerRef !== undefined &&
      deps.signer !== undefined &&
      deps.openLedger !== undefined
    ) {
      ledger = deps.openLedger(request.ledgerRef);
      const store = ledger.store;
      pushDeps = {
        git,
        attest: {
          signer: deps.signer,
          store: {
            get: (id) => store.get(id),
            async append(d) {
              await store.append(d);
              appended.push(d);
            },
          },
        },
      };
    }
    const pushResult = await runKeeperPush(pushArgs, deps.cwd, pushDeps);
    if (pushResult.exitCode !== 0) {
      return {
        status: "error",
        code: "git-write",
        message: `keeper push failed (${pushResult.exitCode}): ${pushResult.stderr.trim()}`,
        exitCode: pushResult.exitCode,
      };
    }
    // Return the signed push/v1 so the host can verify it (prx-a36l). The bare
    // push (no ledgerRef/signer) appends nothing, so the field stays absent.
    const signedDerivation = appended.at(-1);
    return {
      status: "ok",
      commitSha: request.commitSha,
      pushedRef: `refs/heads/${request.branch}`,
      ...(signedDerivation !== undefined ? { signedDerivation } : {}),
    };
  } catch (err) {
    if (err instanceof KeeperGitError) {
      return { status: "error", code: "git-write", message: err.message, exitCode: err.exitCode };
    }
    return {
      status: "error",
      code: "keeper",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    ledger?.close();
  }
}

function badRequest(message: string): KeeperRemoteResponse {
  return { status: "error", code: "bad-request", message };
}

// ── serve: bind keeperd's contract handler over the guest-room door protocol ──

export interface KeeperServeOptions {
  /** Unix socket path the daemon listens on. A stale socket file is removed first. */
  socketPath: string;
  /**
   * GH-223: when set, the daemon writes its OWN pid here once listening and
   * removes it on close. The host lifecycle stops the daemon with
   * `kill "$(cat <pidfile>)"` — no `pkill -f` (which self-matches the
   * controlling shell over `limactl shell`) and no `$!` capture (mangled across
   * the host→ssh→VM shell layers).
   */
  pidfile?: string | undefined;
  deps?: KeeperDaemonDeps | undefined;
}

/** A handle on the running keeper daemon: stop it, or await its close. */
export interface KeeperServer {
  /** Stop listening (and remove the socket/pidfile); resolves once closed. */
  close(): Promise<void>;
  /** Resolves when the daemon stops — a CLI blocks on this to run until killed. */
  readonly closed: Promise<void>;
}

/** A Bun.listen target: a unix socket path, or a `host:port` TCP target. A leading
 *  "/" (or `unix://`) is a unix path; otherwise `host:port` (optional `tcp://`). */
function listenTarget(endpoint: string): { unix: string } | { hostname: string; port: number } {
  const stripped = endpoint.replace(/^unix:\/\//, "");
  if (!stripped.startsWith("/")) {
    const m = stripped.replace(/^tcp:\/\//, "").match(/^([^/\s]+):(\d{1,5})$/);
    if (m) return { hostname: m[1]!, port: Number(m[2]) };
  }
  return { unix: stripped };
}

/**
 * Bind the keeperd server over the guest-room door protocol (prx→guest-room
 * convergence, A2): register the `import-and-push` method — validated against the
 * wire contract, an invalid frame becoming a `bad-request` verdict while the
 * daemon stays up — and listen on the resolved endpoint (a unix socket, or a
 * `host:port` for the macOS/pod TCP case). When `pidfile` is set the daemon
 * records its pid there (removed on close) so the host can stop it by pid.
 */
export function runKeeperServe(options: KeeperServeOptions): Promise<KeeperServer> {
  const { socketPath, pidfile, deps } = options;
  const handlers = createDoorHandlers(
    "keeper",
    {
      "import-and-push": async (params) => {
        const parsed = KeeperRemoteRequestSchema.safeParse(params);
        return parsed.success
          ? await handleKeeperRequest(parsed.data, deps)
          : badRequest("request failed the keeperd wire contract");
      },
    },
    () => {},
  );
  const target = listenTarget(socketPath);
  // A leftover unix socket file makes listen throw EADDRINUSE.
  if ("unix" in target && existsSync(target.unix)) rmSync(target.unix, { force: true });
  const listener = Bun.listen({ ...target, socket: handlers });
  if (pidfile !== undefined) {
    // O_NOFOLLOW refuses a pre-planted symlink at this predictable path; 0600
    // restricts the pidfile (closes the insecure-temp-file vector, CodeQL).
    const fd = openSync(pidfile, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
  }
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const server: KeeperServer = {
    async close() {
      listener.stop(true);
      if ("unix" in target) rmSync(target.unix, { force: true });
      if (pidfile !== undefined) rmSync(pidfile, { force: true });
      resolveClosed();
    },
    closed,
  };
  return Promise.resolve(server);
}
