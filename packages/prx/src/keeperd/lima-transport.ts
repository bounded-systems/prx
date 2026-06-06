/**
 * keeperd Lima transport driver (GH-201, slice 3b).
 *
 * The concrete realization of the transport's `openConnection` seam for the
 * isolated-VM deployment: bridge a LOCAL unix socket to the in-VM keeperd socket
 * over Lima's SSH (`ssh -L`), then run the ordinary
 * {@link ./transport.unixSocketTransport} over the local end. The host's
 * {@link ./client.IsolatedKeeperClient} is unchanged — it just talks to a socket.
 *
 * A forward is a managed resource (open → use → close): `openLimaKeeperChannel`
 * stands one up and returns the transport plus a `close()`; `withLimaKeeperClient`
 * wraps the open/use/close lifecycle around a callback. The forward runs through
 * an OWN SSH ControlMaster (explicit `ControlPath`), so it backgrounds
 * deterministically (`-f`) and `close()` tears it down via `-O exit` regardless
 * of the user's Lima ssh-config — no leaked masters.
 *
 * All process/filesystem effects are injected seams, so the orchestration is
 * unit-testable offline; the live path is exercised against a real VM separately.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCapture } from "@bounded-systems/proc";

import { IsolatedKeeperClient, type KeeperTransport } from "./client.ts";
import { unixSocketTransport } from "./transport.ts";

/** Result of running a command to completion. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injected effects (default to real process/filesystem); tests stub them offline. */
export interface LimaChannelDeps {
  /** Run a command to completion. */
  run?: (cmd: string, args: string[]) => RunResult;
  /** Does a path exist? (polled for the forwarded socket appearing). */
  exists?: (path: string) => boolean;
  /** Sleep between readiness polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Build the transport over the local socket (default {@link unixSocketTransport}). */
  makeTransport?: (socketPath: string) => KeeperTransport;
}

export interface LimaKeeperChannelOptions {
  /** Lima instance name, e.g. `bdelanghe-lima-devshell-main`. */
  vm: string;
  /** Absolute path of keeperd's unix socket INSIDE the VM. */
  vmSocket: string;
  /** Local socket path the forward binds (default: a fresh temp path). */
  hostSocket?: string;
  /** Max ms to wait for the forwarded socket to appear (default 5000). */
  readyTimeoutMs?: number;
}

/** An established host↔VM keeperd forward. */
export interface LimaKeeperChannel {
  /** The local end of the forward (what the transport dials). */
  readonly hostSocket: string;
  /** Transport the {@link IsolatedKeeperClient} runs over. */
  readonly transport: KeeperTransport;
  /** Tear the forward down and clean up temp files. Idempotent. */
  close(): Promise<void>;
}

const POLL_MS = 50;

function defaultRun(cmd: string, args: string[]): RunResult {
  // Route through @bounded-systems/proc (ambient-authority guard: no raw spawn).
  const res = spawnCapture([cmd, ...args]);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Establish a Lima-SSH-forwarded unix socket to the in-VM keeperd and return a
 * transport over it plus a `close()`. The forward uses a private ControlMaster
 * so it backgrounds deterministically and tears down cleanly.
 */
export async function openLimaKeeperChannel(
  opts: LimaKeeperChannelOptions,
  deps: LimaChannelDeps = {},
): Promise<LimaKeeperChannel> {
  const run = deps.run ?? defaultRun;
  const exists = deps.exists ?? existsSync;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const makeTransport = deps.makeTransport ?? unixSocketTransport;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5000;

  const workDir = mkdtempSync(join(tmpdir(), "keeperd-lima-"));
  const sshConfig = join(workDir, "ssh.config");
  const controlPath = join(workDir, "cm.sock");
  const hostSocket = opts.hostSocket ?? join(workDir, "keeperd.sock");
  const sshHost = `lima-${opts.vm}`;

  const exitMaster = (): void => {
    run("ssh", ["-o", `ControlPath=${controlPath}`, "-O", "exit", sshHost]);
  };

  try {
    // 1. Capture Lima's generated ssh config (host alias, port, identity files).
    const cfg = run("limactl", ["show-ssh", "--format", "config", opts.vm]);
    if (cfg.status !== 0) {
      throw new Error(`limactl show-ssh ${opts.vm} failed (${cfg.status}): ${cfg.stderr.trim()}`);
    }
    writeFileSync(sshConfig, cfg.stdout);

    // 2. Establish the unix-socket forward through our own ControlMaster, so it
    //    backgrounds (-f) and close() can always reach it (-O exit).
    if (exists(hostSocket)) rmSync(hostSocket, { force: true });
    const fwd = run("ssh", [
      "-F", sshConfig,
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlPath}`,
      "-o", "ControlPersist=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-f", "-N",
      "-L", `${hostSocket}:${opts.vmSocket}`,
      sshHost,
    ]);
    if (fwd.status !== 0) {
      throw new Error(`lima keeperd forward failed (${fwd.status}): ${fwd.stderr.trim()}`);
    }

    // 3. Wait for the forwarded socket to appear before handing back a transport.
    const maxPolls = Math.max(1, Math.ceil(readyTimeoutMs / POLL_MS));
    let ready = exists(hostSocket);
    for (let i = 0; i < maxPolls && !ready; i++) {
      await sleep(POLL_MS);
      ready = exists(hostSocket);
    }
    if (!ready) {
      throw new Error(
        `keeperd forward socket did not appear at ${hostSocket} within ${readyTimeoutMs}ms`,
      );
    }

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      exitMaster();
      rmSync(workDir, { recursive: true, force: true });
    };
    return { hostSocket, transport: makeTransport(hostSocket), close };
  } catch (err) {
    // Best-effort teardown so a failed open never leaks a master or temp dir.
    try {
      exitMaster();
    } catch {
      /* ignore */
    }
    rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Open a Lima keeperd channel, run `fn` with an {@link IsolatedKeeperClient} over
 * it, and always close the forward afterward (even on throw).
 */
export async function withLimaKeeperClient<T>(
  opts: LimaKeeperChannelOptions,
  fn: (client: IsolatedKeeperClient) => Promise<T>,
  deps: LimaChannelDeps = {},
): Promise<T> {
  const channel = await openLimaKeeperChannel(opts, deps);
  try {
    return await fn(new IsolatedKeeperClient(channel.transport));
  } finally {
    await channel.close();
  }
}
