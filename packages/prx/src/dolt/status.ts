/**
 * Dolt actor `status` driver (GH-2154 / GH-555).
 *
 * Implements the canonical `prx dolt status` read verb. The dolt lifecycle is
 * provisioned → running ⇄ healthy → stopped → orphaned; `status` is a read
 * that observes a server and promotes it to `healthy` (reachable + tracked)
 * or `orphaned` (tracked record but unreachable). It performs no writes.
 *
 * Source-of-truth rule (the GH-2154 fix): up/down is decided by probing
 * actual connectivity to the configured port via `bd dolt show`, NOT by a
 * PID-file / per-worktree-path heuristic. The external `bd dolt status`
 * false-negatives because it inspects a per-worktree dolt path that does not
 * exist for a shared server; a session that trusts it concludes "not running"
 * and spawns a duplicate. Here, ledger / pid / path are layered only as
 * owner/orphaned refinements on top of the connectivity verdict — they never
 * flip a reachable server to "down".
 *
 * This PR ships only the read model. The dolt ledger writer (start/adopt) is
 * a GH-555 follow-on and is still stubbed, so today the shared server reports
 * `running` / `external` (pid null) — exactly the correct, no-false-negative
 * behavior for the incident. The `prx`-owned `healthy` and `orphaned` paths
 * become exercised once start/adopt write the ledger this code reads.
 */

import { processEnv } from "@bounded-systems/env";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCapture } from "@bounded-systems/proc";

import {
  defaultPidAliveProbe,
  reverseDnsRepoSegments,
  type PidAliveProbe,
} from "../pr-state/github.ts";
import { DoltServerId, type StatusOutput } from "./schema.ts";

export type DoltStatusSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type DoltStatusSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => DoltStatusSpawnResult;

/** Repo context resolved from `repo_path` (git toplevel, slug, common dir). */
export type DoltStatusContext = {
  repoRoot: string;
  hostRepoSlug: string;
  commonDir: string;
};

/**
 * Read model of the dolt ledger written by start/adopt (GH-555 follow-on,
 * still stubbed). Presence of a ledger means the server is prx-owned.
 */
export type DoltLedger = {
  dolt_server_id?: string;
  pid?: number | null;
  port?: number | null;
  dsn?: string | null;
};

export type DoltStatusDeps = {
  spawn?: DoltStatusSpawn;
  env?: NodeJS.ProcessEnv;
  pidAlive?: PidAliveProbe;
  /** Override repo-context resolution (tests bypass git). */
  resolveContext?: (repoPath: string) => DoltStatusContext | null;
  /** Override dolt-ledger read (tests inject a ledger or absence). */
  readDoltLedger?: (ledgerPath: string) => DoltLedger | null;
};

export type DoltStatusOptions = {
  repoPath: string;
  format: "plain" | "json";
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

type DoltShowJson = {
  port?: number;
  database?: string;
  connection_ok?: boolean;
};

function readBuffer(value: string | Buffer | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * Pure: 12-hex stable id for a per-repo dolt sql-server. Mirrors
 * `computeWorkspaceId` (sha256 of a space-joined tuple, truncated). The path
 * component is the `.beads/dolt/<database>` location; when the database is
 * unknown (server down, no ledger) the dolt dir root keeps the id stable.
 */
export function computeDoltServerId(hostRepoSlug: string, doltPath: string): DoltServerId {
  const hash = createHash("sha256");
  hash.update(`${hostRepoSlug} ${doltPath}`);
  return hash.digest("hex").slice(0, 12);
}

function tryGit(
  spawn: DoltStatusSpawn,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const r = spawn("git", args, { cwd, env });
  if (r.error || (r.status ?? 1) !== 0) return null;
  const out = readBuffer(r.stdout).trim();
  return out.length > 0 ? out : null;
}

export function defaultResolveContext(
  spawn: DoltStatusSpawn,
  env: NodeJS.ProcessEnv,
  repoPath: string,
): DoltStatusContext | null {
  const repoRoot = tryGit(spawn, ["rev-parse", "--show-toplevel"], repoPath, env);
  if (!repoRoot) return null;
  const commonRaw = tryGit(spawn, ["rev-parse", "--git-common-dir"], repoRoot, env);
  if (!commonRaw) return null;
  const commonDir = commonRaw.startsWith("/") ? commonRaw : join(repoRoot, commonRaw);
  const originUrl = tryGit(spawn, ["remote", "get-url", "origin"], repoRoot, env);
  if (!originUrl) return null;
  const segments = reverseDnsRepoSegments(originUrl);
  if (!segments) return null;
  return { repoRoot, hostRepoSlug: segments.join("/"), commonDir };
}

function defaultReadDoltLedger(ledgerPath: string): DoltLedger | null {
  if (!existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as DoltLedger;
  } catch {
    return null;
  }
}

type Probe =
  | { reachable: true; port: number; database: string }
  | { reachable: false; port: null; database: null };

/** Probe actual connectivity. This verdict — not pid/path — decides up/down. */
function probeConnectivity(spawn: DoltStatusSpawn, env: NodeJS.ProcessEnv, cwd: string): Probe {
  const down: Probe = { reachable: false, port: null, database: null };
  const show = spawn("bd", ["dolt", "show", "--format=json"], { cwd, env });
  if (show.error || (show.status ?? 1) !== 0) return down;
  let json: DoltShowJson | null;
  try {
    json = JSON.parse(readBuffer(show.stdout)) as DoltShowJson;
  } catch {
    return down;
  }
  if (
    json &&
    json.connection_ok === true &&
    typeof json.port === "number" &&
    json.port > 0 &&
    typeof json.database === "string" &&
    json.database.length > 0
  ) {
    return { reachable: true, port: json.port, database: json.database };
  }
  return down;
}

/**
 * Count commits on the reachable server's `main` not yet pushed to origin.
 * Reuses the reconcile `dolt sql --result-format json` access pattern. Any
 * parse/query failure returns null and never affects the up/down verdict.
 */
function countUnpushed(
  spawn: DoltStatusSpawn,
  env: NodeJS.ProcessEnv,
  cwd: string,
  port: number,
  database: string,
): number | null {
  const args = [
    "sql",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--user",
    "root",
    "--use-db",
    database,
    "--result-format",
    "json",
    "-q",
    "SELECT COUNT(*) AS n FROM dolt_log('remotes/origin/main..main')",
  ];
  const r = spawn("dolt", args, { cwd, env });
  if (r.error || (r.status ?? 1) !== 0) return null;
  try {
    const payload = JSON.parse(readBuffer(r.stdout)) as { rows?: Array<{ n?: unknown }> };
    const raw = payload?.rows?.[0]?.n;
    const n =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function formatStatus(out: StatusOutput, format: "plain" | "json"): string {
  if (format === "json") return JSON.stringify(out, null, 2);
  const lines = [
    "prx dolt status:",
    `  server:    ${out.dolt_server_id}`,
    `  lifecycle: ${out.lifecycle}`,
    `  healthy:   ${out.healthy}`,
    `  owner:     ${out.owner ?? "—"}`,
    `  port:      ${out.port ?? "—"}`,
    `  pid:       ${out.pid ?? "—"}`,
    `  dsn:       ${out.dsn ?? "—"}`,
    `  unpushed:  ${out.unpushed_commits ?? "unknown"}`,
  ];
  if (out.error) lines.push(`  error:     ${out.error}`);
  return lines.join("\n");
}

/**
 * Run `prx dolt status`. Returns the process exit code; emits the
 * `StatusOutput` (plain text by default, JSON under `--format=json`).
 */
export function runDoltStatus(
  options: DoltStatusOptions,
  output: Output,
  deps: DoltStatusDeps = {},
): number {
  const spawn: DoltStatusSpawn =
    deps.spawn ??
    ((file, args, opts) => {
      const r = spawnCapture([file, ...args], { cwd: opts.cwd, env: opts.env });
      return {
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.error ? { error: r.error } : {}),
      };
    });
  const baseEnv = deps.env ?? processEnv();
  const env = { ...baseEnv };
  delete env.BEADS_DIR;
  const pidAlive = deps.pidAlive ?? defaultPidAliveProbe;
  const resolveContext = deps.resolveContext ?? ((p) => defaultResolveContext(spawn, env, p));
  const readDoltLedger = deps.readDoltLedger ?? defaultReadDoltLedger;

  const ctx = resolveContext(options.repoPath);
  if (!ctx) {
    const out: StatusOutput = {
      dolt_server_id: "000000000000",
      lifecycle: "stopped",
      pid: null,
      port: null,
      dsn: null,
      owner: null,
      healthy: false,
      unpushed_commits: null,
      error:
        "dolt.status: repo_path is not a recognized GitHub repo (no origin or non-GitHub host)",
    };
    output.log(formatStatus(out, options.format));
    return 1;
  }

  // 1. Connectivity is the source of truth for up/down.
  const probe = probeConnectivity(spawn, env, ctx.repoRoot);

  // 2. Derive the stable server id (path uses the live db when known).
  const doltPath = probe.database
    ? join(ctx.repoRoot, ".beads/dolt", probe.database)
    : join(ctx.repoRoot, ".beads/dolt");
  const derivedId = computeDoltServerId(ctx.hostRepoSlug, doltPath);

  // 3. Read the dolt ledger (prx-owned record); usually absent today.
  const ledger = readDoltLedger(join(ctx.commonDir, "info", "dolt", `${derivedId}.json`));
  const doltServerId =
    ledger?.dolt_server_id && DoltServerId.safeParse(ledger.dolt_server_id).success
      ? (ledger.dolt_server_id as DoltServerId)
      : derivedId;

  // 4. Lifecycle / owner / pid / healthy — ledger refines the verdict, never
  //    overrides it.
  let lifecycle: StatusOutput["lifecycle"];
  let owner: StatusOutput["owner"];
  let healthy: boolean;
  let pid: number | null;
  let port: number | null;
  let dsn: string | null;
  let unpushed: number | null = null;

  if (probe.reachable) {
    port = probe.port;
    if (ledger) {
      lifecycle = "healthy";
      owner = "prx";
      pid = typeof ledger.pid === "number" && ledger.pid > 0 ? ledger.pid : null;
      dsn = ledger.dsn ?? `mysql://root@127.0.0.1:${port}/${probe.database}`;
    } else {
      // Reachable but untracked — an external server (e.g. the shared :3308).
      // pid is unknown (`bd dolt show` exposes none) and that is fine.
      lifecycle = "running";
      owner = "external";
      pid = null;
      dsn = `mysql://root@127.0.0.1:${port}/${probe.database}`;
    }
    healthy = true;
    unpushed = countUnpushed(spawn, env, ctx.repoRoot, probe.port, probe.database);
  } else if (ledger) {
    // A tracked record but the server is unreachable. Per the lifecycle doc,
    // orphaned is specifically "a server we expected to own whose pid is
    // gone"; if the ledgered pid is still alive the server is expected-running
    // but not (yet) answering — `running`, unhealthy. Either way not healthy.
    pid = typeof ledger.pid === "number" && ledger.pid > 0 ? ledger.pid : null;
    const alive = pid !== null && pidAlive(pid);
    lifecycle = alive ? "running" : "orphaned";
    owner = "prx";
    healthy = false;
    port = typeof ledger.port === "number" && ledger.port > 0 ? ledger.port : null;
    dsn = ledger.dsn ?? null;
  } else {
    // Unreachable and untracked — stopped.
    lifecycle = "stopped";
    owner = null;
    healthy = false;
    pid = null;
    port = null;
    dsn = null;
  }

  const out: StatusOutput = {
    dolt_server_id: doltServerId,
    lifecycle,
    pid,
    port,
    dsn,
    owner,
    healthy,
    unpushed_commits: unpushed,
  };
  output.log(formatStatus(out, options.format));
  return 0;
}
