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
 * ⚠️ REVIEWER FLAGS — env-specific defaults to confirm before running live:
 *   F1 (argv):     `buildServerArgv` is a best reading of the codebase; confirm
 *                  the data-dir / --host / --port / config flags bd expects.
 *   F2 (discovery): the health probe goes through `bd dolt show`, so a
 *                  prx-started server only registers if bd is pointed at the
 *                  same port. Confirm the bd↔prx port coordination, or replace
 *                  `defaultProbe` with a direct TCP/dolt check on the chosen port.
 *   F3 (db name):  `defaultDeriveDatabase` maps the origin slug to the
 *                  reverse-DNS database name (`io_github_<owner>_<repo>`);
 *                  confirm it matches bd's canonical naming.
 * None of F1–F3 affect the tested orchestration — they are isolated in the
 * default deps and swappable.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { processEnv } from "@bounded-systems/env";
import { spawnCapture, spawnDetached } from "@bounded-systems/proc";

import { StartInput, type StartOutput } from "./schema.ts";
import { computeDoltServerId, type DoltStatusContext, type DoltLedger } from "./status.ts";

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
    if (p.reachable) {
      const dsn = buildDsn(deps.host, deps.port, database);
      deps.writeLedger(ledgerPath, { dolt_server_id: serverId, pid, port: deps.port, dsn });
      return { dolt_server_id: serverId, pid, port: deps.port, dsn, owner: "prx", status: "started" };
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

/** Production deps wiring the flagged seams; `resolveContext` is supplied by the caller (status.ts). */
export function defaultDoltStartDeps(
  resolveContext: (repoPath: string) => DoltStatusContext | null,
): DoltStartDeps {
  return {
    resolveContext,
    deriveDatabase: defaultDeriveDatabase,
    probe: defaultProbe,
    spawnServer: (argv, cwd) => spawnDetached(argv, { cwd }),
    readLedger: defaultReadLedger,
    writeLedger: defaultWriteLedger,
    sleep,
    host: DEFAULT_DOLT_HOST,
    port: DEFAULT_DOLT_PORT,
    probeMs: 500,
    maxProbes: 40,
  };
}
