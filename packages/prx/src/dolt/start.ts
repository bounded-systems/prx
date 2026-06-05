/**
 * GH-555 — `prx dolt start`: the dolt actor's `start` driver (engine).
 *
 * Brings a per-repo dolt sql-server `stopped → running`: resolve the repo's
 * dolt data dir, refuse to double-start if one is already reachable, else spawn
 * `dolt sql-server` DETACHED (via @bounded-systems/proc's spawnDetached), poll
 * until healthy, write the lifecycle ledger, and return a `StartOutput`
 * (the actor's DOLT_SERVER_STARTED).
 *
 * The orchestration is pure + fully injected (`DoltStartDeps`), so it is
 * unit-tested with fakes and NEVER spawns a live server in CI.
 *
 * DESIGN: the actor MEDIATES bd. bd owns the per-repo dolt server lifecycle (a
 * competing prx-spawned server hits "database is locked by another dolt
 * process"), so the default `spawnServer` delegates to `bd dolt start` and the
 * probe reads `bd dolt show` (bd is authoritative). Verified live: against a
 * repo whose bd server is already up, `prx dolt start` correctly detects it and
 * routes to `prx dolt adopt` rather than double-starting.
 *
 * Remaining seam to confirm:
 *   F3 (db name): `defaultDeriveDatabase` maps the origin slug to the
 *                 reverse-DNS database name (`io_github_<owner>_<repo>`) for the
 *                 dsn/ledger; confirm it matches bd's canonical naming. (The
 *                 session's errors named exactly `io_github_bounded_systems_prx`,
 *                 which this produces.)
 * (F1/F2 from the original draft are resolved by delegating to bd; the
 * standalone-server path — `spawnDetached(buildServerArgv(...))` — remains
 * available for a future prx-owned server.)
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";

import { StartInput, type StartOutput } from "./schema.ts";
import {
  computeDoltServerId,
  defaultResolveContext,
  type DoltStatusContext,
  type DoltLedger,
  type DoltStatusSpawn,
  type DoltStatusSpawnResult,
} from "./status.ts";

export const DEFAULT_DOLT_HOST = "127.0.0.1";
export const DEFAULT_DOLT_PORT = 3307; // F1/F2: the port bd bootstrap probes.

export type StartProbe = { reachable: boolean; port: number | null; database: string | null };

export type DoltStartDeps = {
  resolveContext: (repoPath: string) => DoltStatusContext | null;
  deriveDatabase: (hostRepoSlug: string) => string;
  probe: (cwd: string) => StartProbe;
  spawnServer: (argv: string[], cwd: string) => { pid: number };
  readLedger: (ledgerPath: string) => DoltLedger | null;
  writeLedger: (ledgerPath: string, ledger: DoltLedger & { pid: number; port: number; dsn: string }) => void;
  sleep: (ms: number) => Promise<void>;
  host: string;
  port: number;
  probeMs: number;
  maxProbes: number;
};

/** F1: best-effort `dolt sql-server` argv. Confirm against bd's expectations. */
export function buildServerArgv(doltDataDir: string, host: string, port: number): string[] {
  return ["dolt", "sql-server", "--data-dir", doltDataDir, "--host", host, "--port", String(port)];
}

const buildDsn = (host: string, port: number, database: string): string =>
  `mysql://root@${host}:${port}/${database}`;

/**
 * Start the server. Returns `started` (we spawned it) or `exists` (a
 * prx-owned server is already up). Throws on: unresolvable repo context, a
 * reachable-but-unowned server (→ `prx dolt adopt`), or a spawned server that
 * never becomes healthy.
 */
export async function runDoltStart(inputRaw: StartInput, deps: DoltStartDeps): Promise<StartOutput> {
  const input = StartInput.parse(inputRaw);
  const ctx = deps.resolveContext(input.repo_path);
  if (!ctx) {
    throw new Error("dolt start: cannot resolve repo context (not a git repo, or no `origin` remote)");
  }

  const database = deps.deriveDatabase(ctx.hostRepoSlug);
  const doltDataDir = join(ctx.repoRoot, ".beads", "dolt", database);
  const serverId = computeDoltServerId(ctx.hostRepoSlug, doltDataDir);
  const ledgerPath = join(ctx.commonDir, "info", "dolt", `${serverId}.json`);

  // Already up? Only claim `exists` for a prx-owned (ledgered) server; a
  // reachable-but-unowned server is the explicit `adopt` escape valve.
  const pre = deps.probe(ctx.repoRoot);
  if (pre.reachable && pre.port) {
    const led = deps.readLedger(ledgerPath);
    if (led?.pid) {
      return {
        dolt_server_id: serverId,
        pid: led.pid,
        port: pre.port,
        dsn: buildDsn(deps.host, pre.port, database),
        owner: "prx",
        status: "exists",
      };
    }
    throw new Error(
      `dolt start: a dolt server is already reachable on :${pre.port} but is not prx-owned — ` +
        "import it with `prx dolt adopt`, or stop it first.",
    );
  }

  const { pid } = deps.spawnServer(buildServerArgv(doltDataDir, deps.host, deps.port), ctx.repoRoot);

  for (let i = 0; i < deps.maxProbes; i++) {
    await deps.sleep(deps.probeMs);
    const p = deps.probe(ctx.repoRoot);
    if (p.reachable && p.port) {
      // Use the port the server actually came up on (bd auto-detects it), not
      // the requested default — bd owns the lifecycle, so it picks the port.
      const port = p.port;
      const dsn = buildDsn(deps.host, port, database);
      deps.writeLedger(ledgerPath, { dolt_server_id: serverId, pid, port, dsn });
      return { dolt_server_id: serverId, pid, port, dsn, owner: "prx", status: "started" };
    }
  }
  throw new Error(
    `dolt start: spawned dolt sql-server (pid ${pid}) but it never became reachable on :${deps.port} ` +
      `within ${deps.maxProbes} probes — see reviewer flags F1/F2 in start.ts.`,
  );
}

// ── production default deps (the env-specific, flagged seams) ────────────────

import { existsSync, readFileSync } from "node:fs";

/** F3: origin slug (`owner/repo`) → reverse-DNS db name. Confirm vs bd. */
export function defaultDeriveDatabase(hostRepoSlug: string): string {
  // e.g. "bounded-systems/prx" → "io_github_bounded_systems_prx"
  return `io_github_${hostRepoSlug.replace(/[/-]/g, "_")}`;
}

function readBuffer(b: string | Buffer): string {
  return typeof b === "string" ? b : b.toString("utf8");
}

/** F2: discovery via `bd dolt show` (same source of truth as `prx dolt status`). */
export function defaultProbe(cwd: string): StartProbe {
  const r = spawnCapture(["bd", "dolt", "show", "--format=json"], { cwd, env: processEnv() });
  if (r.error || (r.status ?? 1) !== 0) return { reachable: false, port: null, database: null };
  try {
    const j = JSON.parse(readBuffer(r.stdout)) as { connection_ok?: boolean; port?: number; database?: string };
    if (j.connection_ok && typeof j.port === "number" && j.port > 0 && j.database) {
      return { reachable: true, port: j.port, database: j.database };
    }
  } catch {
    /* fallthrough */
  }
  return { reachable: false, port: null, database: null };
}

function defaultReadLedger(ledgerPath: string): DoltLedger | null {
  if (!existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as DoltLedger;
  } catch {
    return null;
  }
}

function defaultWriteLedger(
  ledgerPath: string,
  ledger: DoltLedger & { pid: number; port: number; dsn: string },
): void {
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Default `spawnServer`: **delegate to `bd dolt start`** — bd owns the per-repo
 * dolt server lifecycle (a competing prx-spawned server hits "database is locked
 * by another dolt process"). The prx dolt actor mediates bd: it asks bd to
 * start, then verifies + ledgers through its own probe. Parses bd's
 * "Dolt server started (PID N, port M)" for the pid; the port comes from the
 * probe. (For a standalone prx-owned server instead, swap this for
 * `spawnDetached(buildServerArgv(...))` — F1's direct path.)
 */
export function bdDelegatingSpawn(_argv: string[], cwd: string): { pid: number } {
  const r = spawnCapture(["bd", "dolt", "start"], { cwd, env: processEnv() });
  const text = `${readBuffer(r.stdout)}\n${readBuffer(r.stderr)}`;
  if ((r.status ?? 1) !== 0 && !/already running|PID/i.test(text)) {
    throw new Error(`dolt start: \`bd dolt start\` failed — ${text.trim() || `exit ${r.status}`}`);
  }
  const m = text.match(/PID[:\s]+(\d+)/i);
  return { pid: m ? Number(m[1]) : 0 };
}

/** Production deps. `resolveContext` is supplied by the caller (status.ts). */
export function defaultDoltStartDeps(
  resolveContext: (repoPath: string) => DoltStatusContext | null,
): DoltStartDeps {
  return {
    resolveContext,
    deriveDatabase: defaultDeriveDatabase,
    probe: defaultProbe,
    spawnServer: bdDelegatingSpawn,
    readLedger: defaultReadLedger,
    writeLedger: defaultWriteLedger,
    sleep,
    host: DEFAULT_DOLT_HOST,
    port: DEFAULT_DOLT_PORT,
    probeMs: 500,
    maxProbes: 40,
  };
}

/**
 * Resolve the dolt context for a repo path using the real (spawnCapture-backed)
 * git probe — the CLI entry's `resolveContext`.
 */
export function resolveDoltContext(repoPath: string): DoltStatusContext | null {
  const spawn: DoltStatusSpawn = (file, args, options) => {
    const r = spawnCapture([file, ...args], { cwd: options.cwd, env: options.env });
    const result: DoltStatusSpawnResult = { status: r.status, stdout: r.stdout, stderr: r.stderr };
    if (r.error) result.error = r.error;
    return result;
  };
  return defaultResolveContext(spawn, processEnv(), repoPath);
}

/** Thin CLI entry: `prx dolt start`. Resolves deps, runs the engine, formats. */
export async function runDoltStartCli(
  opts: { repoPath: string; format: "plain" | "json" },
  output: { log: (line: string) => void },
): Promise<number> {
  try {
    const out = await runDoltStart(
      { repo_path: opts.repoPath, detach: true },
      defaultDoltStartDeps(resolveDoltContext),
    );
    if (opts.format === "json") {
      output.log(JSON.stringify(out, null, 2));
    } else {
      output.log(`dolt ${out.status}: ${out.dolt_server_id} pid=${out.pid} port=${out.port} (${out.dsn})`);
    }
    return out.status === "error" ? 1 : 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (opts.format === "json") {
      output.log(JSON.stringify({ status: "error", error: message }, null, 2));
    } else {
      output.log(message);
    }
    return 1;
  }
}
