// forge-d daemon: holds the GitHub App private key and answers `lease` with a
// short-lived installation token, served over the guest-room door protocol
// (prx→guest-room convergence — same wire as keeperd/beadsd). The request
// handler is pure over deps (the App config + an injected mint), so the lease
// logic is unit-testable without a socket. The PEM lives only in `deps.config`
// (in-process), never on the wire or in a reply.
import { closeSync, constants as FS, existsSync, openSync, rmSync, writeSync } from "node:fs";

import { createDoorHandlers } from "@bounded-systems/guest-room/protocol";

import { listenTarget } from "../door/listen-target.ts";
import { mintInstallationToken } from "../github-app/installation-token.ts";
import { withForgeCaveats } from "./caveats.ts";
import {
  buildForgeAuthorizer,
  resolveForgeGrantGate,
  FORGE_DOOR,
  type ForgeGrantGate,
} from "./grant-gate.ts";
import { ForgeDRequestSchema, type ForgeDRequest, type ForgeDResponse } from "./contract.ts";

/** The App credential forge-d holds (sourced host-side; never sent to a caller). */
export interface ForgeDConfig {
  /** App ID or Client ID — GitHub honors either as the JWT issuer. */
  readonly issuer: string;
  /** The App private-key PEM. Held in-process; never logged or returned. */
  readonly privateKeyPem: string;
  readonly installationId: string;
}

export interface ForgeDDaemonDeps {
  /** The held App credential. Absent ⇒ every lease replies `not-configured`. */
  readonly config?: ForgeDConfig;
  /** The minting primitive; injected for tests. */
  readonly mint?: typeof mintInstallationToken;
}

/**
 * Handle one lease: mint an installation token (with the request's attenuation,
 * if any) from the held App key. Pure over `deps`; never throws to the socket —
 * a failure becomes a `status: "error"` reply. The PEM is used, never returned.
 */
export async function handleForgeDRequest(
  request: ForgeDRequest,
  deps: ForgeDDaemonDeps = {},
): Promise<ForgeDResponse> {
  if (!deps.config) {
    return { status: "error", code: "not-configured", message: "forge-d holds no GitHub App key" };
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

function badRequest(message: string): ForgeDResponse {
  return { status: "error", code: "bad-request", message };
}

// ── serve: bind forge-d's contract handler over the guest-room door protocol ──

export interface ForgeDServeOptions {
  /** Endpoint the daemon listens on — a unix socket path, or a `host:port` TCP
   *  target. A stale unix socket file is removed first. */
  socketPath: string;
  /** When set, the daemon records its pid here once listening (removed on close). */
  pidfile?: string | undefined;
  deps?: ForgeDDaemonDeps | undefined;
  /**
   * The signed-grant gate enforced on the TCP edge (prx-8uf2). When listening on
   * TCP, requests must carry a grant minted for the `forge` door (audience + exp
   * + issuer key); a unix listener ignores it (the held reference is the
   * authority). Omitted ⇒ resolved from the environment ({@link
   * resolveForgeGrantGate}); a `null` resolution means NO TCP enforcement (kept
   * loopback-bound by the publish-side safety fix).
   */
  grantGate?: ForgeGrantGate | null | undefined;
  /** Structured log sink (level, message). Defaults to `console.error`. */
  log?: ((level: string, msg: string) => void) | undefined;
}

/** A handle on the running forge-d daemon: stop it, or await its close. */
export interface ForgeDServer {
  /** Stop listening (and remove the socket/pidfile); resolves once closed. */
  close(): Promise<void>;
  /** Resolves when the daemon stops — a CLI blocks on this to run until killed. */
  readonly closed: Promise<void>;
}

/**
 * Bind the forge-d server over the guest-room door protocol: register the `lease`
 * method — its params validated against the wire contract, an invalid request
 * becoming a `bad-request` verdict while the daemon stays up — and listen on the
 * resolved endpoint (a unix socket, or a `host:port` for host/cross-host reach).
 * On a TCP edge the signed-grant gate is enforced before dispatch (see
 * {@link ForgeDServeOptions.grantGate}); on unix the kernel-authenticated peer
 * is the authority. When `pidfile` is set the daemon records its pid there.
 */
export function runForgeDServe(options: ForgeDServeOptions): Promise<ForgeDServer> {
  const { socketPath, pidfile, deps } = options;
  const target = listenTarget(socketPath);
  const onTcp = !("unix" in target);
  const log =
    options.log ?? ((level: string, msg: string) => console.error(`forge-d ${level}: ${msg}`));

  // The signed-grant gate is enforced ONLY on the TCP edge — a unix peer is
  // kernel-authenticated (held-ref = authority). A credential door on TCP with no
  // gate stays unauthenticated (kept off-host by the loopback publish bind) — WARN
  // loudly so that footgun is never silent.
  const gate = onTcp ? (options.grantGate ?? resolveForgeGrantGate()) : null;
  if (onTcp && !gate) {
    log(
      "WARN",
      "serving the forge CREDENTIAL door over TCP with NO grant gate — unauthenticated " +
        "(loopback-only; set FORGE_D_GRANT_AUDIENCE + FORGE_D_ISSUER_KEYS to enforce signed grants)",
    );
  }
  const authorize = gate ? withForgeCaveats(buildForgeAuthorizer(gate)) : undefined;

  const handlers = createDoorHandlers(
    FORGE_DOOR,
    {
      // The method conveys the op; the lease body (repositories/permissions)
      // rides in params. Reconstruct the contract shape and validate it.
      lease: async (params) => {
        const parsed = ForgeDRequestSchema.safeParse({ kind: "lease", ...params });
        return parsed.success
          ? await handleForgeDRequest(parsed.data, deps ?? {})
          : badRequest("request failed the forge-d wire contract");
      },
    },
    (level, msg) => log(level, msg),
    authorize,
  );

  // A leftover unix socket file makes listen throw EADDRINUSE.
  if ("unix" in target && existsSync(target.unix)) rmSync(target.unix, { force: true });
  const listener =
    "unix" in target
      ? Bun.listen({ unix: target.unix, socket: handlers })
      : Bun.listen({ hostname: target.hostname, port: target.port, socket: handlers });
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
  const server: ForgeDServer = {
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
