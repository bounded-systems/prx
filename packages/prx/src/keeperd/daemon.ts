/**
 * keeperd daemon (GH-201, slice 2).
 *
 * The in-VM side of the keeper isolation: a request handler that runs a
 * {@link KeeperRemoteRequest} through the existing `role=keeper` git-write
 * primitives ({@link ../pr-state/keeper.runKeeperCommitTree} +
 * {@link ../pr-state/keeper.runKeeperPush}), plus a tiny length-prefixed-JSON
 * framing + unix-socket server so the host's
 * {@link ./client.IsolatedKeeperClient} can reach it.
 *
 * Skeleton scope (this slice): the daemon owns the dispatch + wire framing and
 * is dependency-injected with the git/attest seams, so it is exercised end-to-end
 * over a real unix socket with a fake git — no VM, no keys, no network. Two seams
 * are deliberately deferred:
 *   - `materializeBundle` (unpack the request's git bundle into the object store)
 *     lands in slice 3; absent ⇒ the objects are assumed already present (the
 *     offline test path).
 *   - the in-VM signing key behind `attest` lands in slice 4 (gated).
 *
 * A handler NEVER throws to the socket: every failure becomes a typed `error`
 * response, so one bad request can't take the daemon down.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, rmSync } from "node:fs";

import { execGit } from "@bounded-systems/git";

import {
  KeeperGitError,
  runKeeperCommitTree,
  runKeeperPush,
  type KeeperPushDeps,
} from "../pr-state/keeper.ts";
import { type AttestDeps } from "../provenance/attest.ts";
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
   * When present AND the request carries `ledgerRef`, the push is wrapped by
   * `attestingGit` so a clean push emits a signed `push/v1` derivation. The
   * in-VM signing key behind this is provisioned in slice 4 (gated).
   */
  attest?: AttestDeps | undefined;
  /** The keeper worktree the git-writes run in (defaults to the daemon's cwd). */
  cwd?: string | undefined;
  /**
   * Slice 3: unpack the request's `bundleBase64` into the repo object store so
   * `treeSha`/`parentSha` resolve. Absent ⇒ skipped (objects assumed present).
   */
  materializeBundle?: ((bundleBase64: string, cwd: string | undefined) => Promise<void>) | undefined;
}

/**
 * Run one keeper request to a typed verdict. Materialize the request's objects
 * (slice 3 seam), commit the tree under `role=keeper`, push the branch, and
 * report the pushed identity — or a typed `error` for any git-write failure.
 * Pure w.r.t. the socket: returns data, never throws.
 */
export async function handleKeeperRequest(
  request: KeeperRemoteRequest,
  deps: KeeperDaemonDeps = {},
): Promise<KeeperRemoteResponse> {
  const git = deps.git ?? execGit;
  try {
    if (deps.materializeBundle) {
      await deps.materializeBundle(request.bundleBase64, deps.cwd);
    }
    const commitSha = await runKeeperCommitTree(
      {
        treeSha: request.treeSha,
        parentSha: request.parentSha,
        message: request.message,
        date: request.date,
        branch: request.branch,
      },
      deps.cwd,
      { git },
    );
    const pushArgs = [request.remote, request.branch, ...(request.pushArgs ?? [])];
    const pushDeps: KeeperPushDeps =
      request.ledgerRef !== undefined && deps.attest !== undefined
        ? { git, attest: deps.attest }
        : { git };
    const pushResult = await runKeeperPush(pushArgs, deps.cwd, pushDeps);
    if (pushResult.exitCode !== 0) {
      return {
        status: "error",
        code: "git-write",
        message: `keeper push failed (${pushResult.exitCode}): ${pushResult.stderr.trim()}`,
        exitCode: pushResult.exitCode,
      };
    }
    return { status: "ok", commitSha, pushedRef: `refs/heads/${request.branch}` };
  } catch (err) {
    if (err instanceof KeeperGitError) {
      return { status: "error", code: "git-write", message: err.message, exitCode: err.exitCode };
    }
    return {
      status: "error",
      code: "keeper",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── wire framing: 4-byte big-endian length prefix + UTF-8 JSON ───────────────

const LENGTH_BYTES = 4;

/** Frame a value as `<uint32 length><json>`. */
export function encodeFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(LENGTH_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder: bytes arrive in arbitrary chunks; `push` returns every
 * complete frame now available (decoded JSON), buffering any partial tail.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (this.buffer.length >= LENGTH_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < LENGTH_BYTES + length) break;
      const json = this.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length).toString("utf8");
      this.buffer = this.buffer.subarray(LENGTH_BYTES + length);
      frames.push(JSON.parse(json));
    }
    return frames;
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

export interface KeeperServeOptions {
  /** Unix socket path the daemon listens on. A stale socket file is removed first. */
  socketPath: string;
  deps?: KeeperDaemonDeps | undefined;
}

/**
 * Bind the keeperd unix-socket server. Resolves with the listening `Server`
 * (close it to stop). Each connection is served by {@link serveConnection}
 * against {@link handleKeeperRequest} bound to `deps`.
 */
export function runKeeperServe(options: KeeperServeOptions): Promise<Server> {
  const { socketPath, deps } = options;
  // A leftover socket file from a prior run makes `listen` throw EADDRINUSE.
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  const handler = (request: KeeperRemoteRequest): Promise<KeeperRemoteResponse> =>
    handleKeeperRequest(request, deps);
  const server = createServer((socket) => serveConnection(socket, handler));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
