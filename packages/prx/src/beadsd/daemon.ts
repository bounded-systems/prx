/**
 * beadsd daemon (GH-228, slice 2).
 *
 * The in-VM side of the beads isolation: a request handler that dispatches the
 * read envelope (`ready`/`list`/`show`) to the policy-enforced `bd` runner
 * ({@link execBd} from `@bounded-systems/bd`) and frames the typed reply back to
 * the host's {@link ./client.IsolatedBeadsClient}. Its rationale is
 * **context-shape, not secret-custody**: the agent queries the daemon for the
 * exact tasks it needs instead of loading the whole beads DB into context.
 *
 * Read-only, by construction: the only subcommands this daemon ever names are
 * the three read kinds in the wire contract — `bd`'s own allowlist/policy layer
 * is the second line of defence. Each read is run with `--json` and its stdout
 * parsed, so the wire carries structured data (the contract's opaque `result`),
 * not a CLI string.
 *
 * The `bd` runner is dependency-injected (mirrors keeperd's `git` seam), so the
 * handler and the socket server are exercised end-to-end with a fake `bd` — no
 * VM, no DB, no `bd` binary. A handler NEVER throws to the socket: every failure
 * becomes a typed `error` response, so one bad request can't take the daemon
 * down. The framing + bind + pidfile lifecycle is keeperd's contract-agnostic
 * {@link runFramedServe} / {@link encodeFrame} / {@link FrameDecoder}, reused.
 */

import { type Server, type Socket } from "node:net";

import { execBd as defaultExecBd, type BdExecResult } from "@bounded-systems/bd";

import { FrameDecoder, encodeFrame, runFramedServe } from "../keeperd/daemon.ts";
import {
  BeadsRequestSchema,
  type BeadsRequest,
  type BeadsResponse,
} from "./contract.ts";

/** Seams the daemon runs the bd read through (all injectable; tests stub them). */
export interface BeadsDaemonDeps {
  /** The bd runner (defaults to `execBd`). Tests pass a fake to stay offline. */
  execBd?: typeof defaultExecBd | undefined;
  /** The repo clone whose beads DB the reads run against (defaults to the daemon's cwd). */
  cwd?: string | undefined;
}

/**
 * The `bd` argv for one read request — always `--json` so the reply is
 * structured. Exhaustive over the discriminated union, so a new request kind is
 * a compile error here until it is given args.
 */
function beadsReadArgs(request: BeadsRequest): string[] {
  switch (request.kind) {
    case "ready":
      return ["--json"];
    case "list":
      return request.status !== undefined ? ["--json", "--status", request.status] : ["--json"];
    case "show":
      // `bd show <id> --json` — id first, mirroring runBdShow.
      return [request.id, "--json"];
    default: {
      // Exhaustiveness: a new request kind is a compile error here until given args.
      const unreachable: never = request;
      throw new Error(`unreachable beads request kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Run one beads read request to a typed verdict: dispatch `request.kind` to
 * `bd <kind> --json` under the bd policy layer, parse the JSON payload, and
 * return it as the contract's opaque `result` — or a typed `error` for a
 * non-zero exit (`bd-read`) or unparseable output (`bad-output`). Pure w.r.t.
 * the socket: returns data, never throws.
 */
export async function handleBeadsRequest(
  request: BeadsRequest,
  deps: BeadsDaemonDeps = {},
): Promise<BeadsResponse> {
  const execBd = deps.execBd ?? defaultExecBd;
  let result: BdExecResult;
  try {
    result = execBd({ subcommand: request.kind, args: beadsReadArgs(request), cwd: deps.cwd });
  } catch (err) {
    return { status: "error", code: "beadsd", message: err instanceof Error ? err.message : String(err) };
  }
  if (result.exitCode !== 0) {
    return {
      status: "error",
      code: "bd-read",
      message: (result.stderr || result.stdout).trim() || `bd ${request.kind} failed`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      status: "error",
      code: "bad-output",
      message: `bd ${request.kind} --json returned unparseable output`,
    };
  }
  return { status: "ok", result: parsed };
}

/**
 * Wire a connected socket to the handler: decode framed requests, validate each
 * against the contract, run the handler, and frame the response back — in
 * arrival order. A frame that fails the contract gets a `bad-request` error
 * response (the daemon stays up). Exported so it is testable over any duplex.
 */
export function serveBeadsConnection(
  socket: Socket,
  handler: (request: BeadsRequest) => Promise<BeadsResponse>,
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
      socket.write(encodeFrame(badRequest("unframable bytes on the beadsd channel")));
      return;
    }
    for (const raw of frames) {
      chain = chain.then(async () => {
        const parsed = BeadsRequestSchema.safeParse(raw);
        const response: BeadsResponse = parsed.success
          ? await handler(parsed.data)
          : badRequest("request failed the beadsd wire contract");
        socket.write(encodeFrame(response));
      });
    }
  });
}

function badRequest(message: string): BeadsResponse {
  return { status: "error", code: "bad-request", message };
}

export interface BeadsServeOptions {
  /** Unix socket path the daemon listens on. A stale socket file is removed first. */
  socketPath: string;
  /**
   * When set, the daemon writes its own pid here once listening and removes it
   * on close, so the host lifecycle can stop it by pid (GH-223). Owned by
   * {@link runFramedServe}.
   */
  pidfile?: string | undefined;
  deps?: BeadsDaemonDeps | undefined;
}

/**
 * Bind the beadsd unix-socket server. Resolves with the listening `Server`
 * (close it to stop). Each connection is served by {@link serveBeadsConnection}
 * against {@link handleBeadsRequest} bound to `deps`. When `pidfile` is set the
 * daemon records its pid there (removed on close) so the host can stop it by pid.
 */
export function runBeadsServe(options: BeadsServeOptions): Promise<Server> {
  const { socketPath, pidfile, deps } = options;
  const handler = (request: BeadsRequest): Promise<BeadsResponse> => handleBeadsRequest(request, deps);
  return runFramedServe(socketPath, pidfile, (socket) => serveBeadsConnection(socket, handler));
}
