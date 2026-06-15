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

import { type Server, type Socket } from "node:net";

import { execGit } from "@bounded-systems/git";

import { encodeFrame, FrameDecoder, runFramedServe } from "../door/framing.ts";
import {
  KeeperGitError,
  runKeeperPush,
  type KeeperPushDeps,
} from "../pr-state/keeper.ts";
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
  const importBundle =
    deps.importBundle ?? ((input) => importBundleIntoRepo(input, { git }));
  // Per-request ledger: opened here from request.ledgerRef, closed in `finally`.
  let ledger: { store: AttestDeps["store"]; close: () => void } | undefined;
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
    if (request.ledgerRef !== undefined && deps.signer !== undefined && deps.openLedger !== undefined) {
      ledger = deps.openLedger(request.ledgerRef);
      pushDeps = { git, attest: { signer: deps.signer, store: ledger.store } };
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
    return { status: "ok", commitSha: request.commitSha, pushedRef: `refs/heads/${request.branch}` };
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

/**
 * Wire a connected socket to the handler: decode framed requests, validate each
 * against the contract, run the handler, and frame the response back — in
 * arrival order. A frame that fails the contract gets a `bad-request` error
 * response (the daemon stays up). Exported so it is testable over any duplex.
 */
export function serveConnection(
  socket: Socket,
  handler: (request: KeeperRemoteRequest) => Promise<KeeperRemoteResponse>,
): void {
  const decoder = new FrameDecoder();
  // Serialize responses so multiplexed frames reply in arrival order.
  let chain: Promise<void> = Promise.resolve();
  socket.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch {
      // Undecodable bytes (bad length / non-JSON) — reply once and move on.
      socket.write(encodeFrame(badRequest("unframable bytes on the keeper channel")));
      return;
    }
    for (const raw of frames) {
      chain = chain.then(async () => {
        const parsed = KeeperRemoteRequestSchema.safeParse(raw);
        const response: KeeperRemoteResponse = parsed.success
          ? await handler(parsed.data)
          : badRequest("request failed the keeperd wire contract");
        socket.write(encodeFrame(response));
      });
    }
  });
}

function badRequest(message: string): KeeperRemoteResponse {
  return { status: "error", code: "bad-request", message };
}

// ── serve: bind keeperd's contract handler over the shared door framing ───────

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

/**
 * Bind the keeperd unix-socket server. Resolves with the listening `Server`
 * (close it to stop). Each connection is served by {@link serveConnection}
 * against {@link handleKeeperRequest} bound to `deps`. When `pidfile` is set the
 * daemon records its pid there (removed on close) so the host can stop it by pid.
 */
export function runKeeperServe(options: KeeperServeOptions): Promise<Server> {
  const { socketPath, pidfile, deps } = options;
  const handler = (request: KeeperRemoteRequest): Promise<KeeperRemoteResponse> =>
    handleKeeperRequest(request, deps);
  return runFramedServe(socketPath, pidfile, (socket) => serveConnection(socket, handler));
}
