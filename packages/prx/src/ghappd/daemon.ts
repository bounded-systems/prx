// ghappd daemon: holds the GitHub App private key and answers `lease` with a
// short-lived installation token. The framed-socket serve loop mirrors beadsd
// (../door/framing). The request handler is pure over deps (the App config + an
// injected mint), so the lease logic is unit-testable without a socket. The PEM
// lives only in `deps.config` (in-process), never on the wire or in a reply.
import { type Server, type Socket } from "node:net";

import { FrameDecoder, encodeFrame, runFramedServe } from "../door/framing.ts";
import { mintInstallationToken } from "../github-app/installation-token.ts";
import { GhappdRequestSchema, type GhappdRequest, type GhappdResponse } from "./contract.ts";

/** The App credential ghappd holds (sourced host-side; never sent to a caller). */
export interface GhappdConfig {
  /** App ID or Client ID — GitHub honors either as the JWT issuer. */
  readonly issuer: string;
  /** The App private-key PEM. Held in-process; never logged or returned. */
  readonly privateKeyPem: string;
  readonly installationId: string;
}

export interface GhappdDaemonDeps {
  /** The held App credential. Absent ⇒ every lease replies `not-configured`. */
  readonly config?: GhappdConfig;
  /** The minting primitive; injected for tests. */
  readonly mint?: typeof mintInstallationToken;
}

/**
 * Handle one lease: mint an installation token (with the request's attenuation,
 * if any) from the held App key. Pure over `deps`; never throws to the socket —
 * a failure becomes a `status: "error"` reply. The PEM is used, never returned.
 */
export async function handleGhappdRequest(
  request: GhappdRequest,
  deps: GhappdDaemonDeps = {},
): Promise<GhappdResponse> {
  if (!deps.config) {
    return { status: "error", code: "not-configured", message: "ghappd holds no GitHub App key" };
  }
  const mint = deps.mint ?? mintInstallationToken;
  try {
    const lease = await mint({
      issuer: deps.config.issuer,
      privateKeyPem: deps.config.privateKeyPem,
      installationId: deps.config.installationId,
      ...(request.repositories ? { repositories: request.repositories } : {}),
      ...(request.permissions ? { permissions: request.permissions } : {}),
    });
    return {
      status: "ok",
      token: lease.token,
      expiresAt: lease.expiresAt,
      permissions: lease.permissions,
    };
  } catch (e) {
    return { status: "error", code: "mint-failed", message: (e as Error).message };
  }
}

function badRequest(message: string): GhappdResponse {
  return { status: "error", code: "bad-request", message };
}

/** Decode frames, validate against the contract, dispatch, encode the reply. */
export function serveGhappdConnection(
  socket: Socket,
  handler: (request: GhappdRequest) => Promise<GhappdResponse>,
): void {
  const decoder = new FrameDecoder();
  // Serialize responses so multiplexed frames reply in arrival order.
  let chain: Promise<void> = Promise.resolve();
  socket.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.write(encodeFrame(badRequest("unframable bytes on the ghappd channel")));
      return;
    }
    for (const raw of frames) {
      chain = chain.then(async () => {
        const parsed = GhappdRequestSchema.safeParse(raw);
        const response: GhappdResponse = parsed.success
          ? await handler(parsed.data)
          : badRequest("request failed the ghappd wire contract");
        socket.write(encodeFrame(response));
      });
    }
  });
}

export interface GhappdServeOptions {
  /** Unix socket path the daemon listens on (a stale socket file is removed first). */
  socketPath: string;
  /** When set, the daemon records its pid here once listening (removed on close). */
  pidfile?: string | undefined;
  deps?: GhappdDaemonDeps | undefined;
}

/**
 * Bind the ghappd unix-socket server. Resolves with the listening `Server`
 * (close it to stop). Each connection is served by {@link serveGhappdConnection}
 * against {@link handleGhappdRequest} bound to `deps`.
 */
export async function runGhappdServe(options: GhappdServeOptions): Promise<Server> {
  const { socketPath, pidfile, deps } = options;
  const handler = (request: GhappdRequest): Promise<GhappdResponse> =>
    handleGhappdRequest(request, deps ?? {});
  return runFramedServe(socketPath, pidfile, (socket) => serveGhappdConnection(socket, handler));
}
