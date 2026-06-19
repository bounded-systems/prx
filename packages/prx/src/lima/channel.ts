/**
 * Generic Lima-SSH unix-socket channel (GH-228, slice 3).
 *
 * The daemon-agnostic forward, extracted from the keeperd transport driver
 * (GH-201): bridge a LOCAL unix socket to an in-VM daemon socket over Lima's SSH
 * (`ssh -L`), then run an ordinary framed transport over the local end. keeperd
 * ({@link ../keeperd/lima-transport}) and beadsd ({@link ../beadsd/lima}) both
 * layer their typed client on top of this one forward — the only daemon-specific
 * bits are the transport's request type (a type parameter) and a temp-dir name
 * prefix.
 *
 * A forward is a managed resource (open → use → close): {@link openLimaChannel}
 * stands one up and returns the transport plus a `close()`; {@link withLimaChannel}
 * wraps the open/use/close lifecycle around a callback. The forward runs through
 * an OWN SSH ControlMaster (explicit `ControlPath`), so it backgrounds
 * deterministically (`-f`) and `close()` tears it down via `-O exit` regardless
 * of the user's Lima ssh-config — no leaked masters.
 *
 * All process/filesystem effects are injected seams, so the orchestration is
 * unit-testable offline; the live path is exercised against a real VM separately.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpDir } from "@bounded-systems/host";
import { join } from "node:path";

import { spawnRun, type Run } from "../door/lima-exec.ts";
import { unixSocketTransport, type FramedTransport } from "../door/transport.ts";

export type { RunResult } from "../door/lima-exec.ts";

/**
 * Injected effects (default to real process/filesystem); tests stub them offline.
 * `T` is the transport's request type — `FramedTransport` (request-agnostic) by
 * default; keeper/beadsd instantiate it with their own client transport type.
 */
export interface LimaChannelDeps<T = FramedTransport> {
  /** Run a command to completion. */
  run?: Run;
  /** Does a path exist? (polled for the forwarded socket appearing). */
  exists?: (path: string) => boolean;
  /** Sleep between readiness polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Build the transport over the local socket (default {@link unixSocketTransport}). */
  makeTransport?: (socketPath: string) => T;
}

export interface LimaChannelOptions {
  /** Lima instance name, e.g. `bdelanghe-lima-devshell-main`. */
  vm: string;
  /** Absolute path of the daemon's unix socket INSIDE the VM. */
  vmSocket: string;
  /** Local socket path the forward binds (default: a fresh temp path). */
  hostSocket?: string;
  /** Max ms to wait for the forwarded socket to appear (default 5000). */
  readyTimeoutMs?: number;
  /** Temp-dir name prefix, e.g. `keeperd-lima-` / `beadsd-lima-` (default `lima-channel-`). */
  namePrefix?: string;
}

/** An established host↔VM daemon forward. */
export interface LimaChannel<T = FramedTransport> {
  /** The local end of the forward (what the transport dials). */
  readonly hostSocket: string;
  /** Transport the typed client runs over. */
  readonly transport: T;
  /** Tear the forward down and clean up temp files. Idempotent. */
  close(): Promise<void>;
}

const POLL_MS = 50;

/**
 * Establish a Lima-SSH-forwarded unix socket to an in-VM daemon and return a
 * transport over it plus a `close()`. The forward uses a private ControlMaster
 * so it backgrounds deterministically and tears down cleanly.
 */
export async function openLimaChannel<T = FramedTransport>(
  opts: LimaChannelOptions,
  deps: LimaChannelDeps<T> = {},
): Promise<LimaChannel<T>> {
  const run = deps.run ?? spawnRun;
  const exists = deps.exists ?? existsSync;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  // A FramedTransport is request-agnostic, so it is assignable to any concrete
  // client transport (KeeperTransport / BeadsTransport) — the cast is the one
  // place that widens the default builder to the caller's `T`.
  const makeTransport = deps.makeTransport ?? (unixSocketTransport as (socketPath: string) => T);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5000;

  const workDir = mkdtempSync(join(tmpDir(), opts.namePrefix ?? "lima-channel-"));
  const sshConfig = join(workDir, "ssh.config");
  const controlPath = join(workDir, "cm.sock");
  const hostSocket = opts.hostSocket ?? join(workDir, "daemon.sock");
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
      "-F",
      sshConfig,
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-f",
      "-N",
      "-L",
      `${hostSocket}:${opts.vmSocket}`,
      sshHost,
    ]);
    if (fwd.status !== 0) {
      throw new Error(`lima daemon forward failed (${fwd.status}): ${fwd.stderr.trim()}`);
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
        `daemon forward socket did not appear at ${hostSocket} within ${readyTimeoutMs}ms`,
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
 * Open a Lima channel, run `fn` with the transport over it, and always close the
 * forward afterward (even on throw). Callers wrap `fn` to build their typed
 * client from the transport.
 */
export async function withLimaChannel<T = FramedTransport, R = unknown>(
  opts: LimaChannelOptions,
  fn: (transport: T) => Promise<R>,
  deps: LimaChannelDeps<T> = {},
): Promise<R> {
  const channel = await openLimaChannel<T>(opts, deps);
  try {
    return await fn(channel.transport);
  } finally {
    await channel.close();
  }
}
