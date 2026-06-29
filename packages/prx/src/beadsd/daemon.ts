/**
 * beadsd daemon (GH-228, slices 2 + 5).
 *
 * The in-VM side of the beads isolation: a request handler that dispatches the
 * wire envelope — reads (`ready`/`list`/`show`) and writes (`create`/`update`/
 * `close`, slice 5) — to the policy-enforced `bd` runner ({@link execBd} from
 * `@bounded-systems/bd`) and frames the typed reply back to the host's
 * {@link ./client.IsolatedBeadsClient}. Its rationale is **context-shape, not
 * secret-custody**: the agent queries the daemon for the exact tasks it needs
 * instead of loading the whole beads DB into context.
 *
 * Single-writer, by construction: writes go through this one daemon to the one
 * in-VM canonical beads, so there is no per-clone divergence (the failure mode
 * that breaks beads otherwise). The daemon mints no authority — it dispatches
 * writes under the SAME `bd` allowlist + planner-role policy that gates any bd
 * write, so the gate is `bd`'s, not beadsd's. Every op runs with `--json` and
 * its stdout is parsed, so the wire carries structured data (the contract's
 * opaque `result`), not a CLI string.
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

import { FrameDecoder, encodeFrame, runFramedServe } from "../door/framing.ts";
import {
  BeadsRequestSchema,
  isBeadsWriteKind,
  type BeadsRequest,
  type BeadsResponse,
} from "./contract.ts";

/** Seams the daemon runs the bd read through (all injectable; tests stub them). */
export interface BeadsDaemonDeps {
  /** The bd runner (defaults to `execBd`). Tests pass a fake to stay offline. */
  execBd?: typeof defaultExecBd | undefined;
  /** The repo clone whose beads DB the reads run against (defaults to the daemon's cwd). */
  cwd?: string | undefined;
  /**
   * The served clone's bd workspace prefix (e.g. `"prx"`). Forwarded to
   * {@link execBd} as `localPrefix` so the bd-safe I-BF1 guard admits NATIVE
   * short ids (prefix === this) — `prx beads show prx-716`, `dep add` on
   * all-digit children — instead of refusing them as foreign surface refs
   * (prx-3vow). Resolved ONCE at serve startup from the served cwd (the CLI
   * passes it); absent it, the guard keeps its safe refuse-all default.
   */
  localPrefix?: string | undefined;
  /**
   * GH-296: the dataset generation source — returns the served clone's current
   * dolt HEAD hash (a content-addressed etag for the whole bead store), or
   * undefined when unknown. Included on every `ok` reply so callers can validate
   * caches and sync can short-circuit when nothing moved. The daemon caches this
   * (refreshed on the reconcile cycle), so reads don't spawn dolt per request.
   */
  etag?: (() => string | undefined) | undefined;
}

/** A write `update` with no field to change — surfaced as a bad-request, not sent to bd. */
class EmptyUpdateError extends Error {}

/**
 * The bd subcommand for a request kind. Identity for every kind EXCEPT:
 *  - `close` → `update` (`bd close` is blocked by the bd policy wrapper, so a
 *    close is dispatched as `bd update <id> --status closed`).
 *  - `children` → `dep` (`bd children` is not on the bd allowlist; the children
 *    read is served as `bd dep list <id> ...` over the already-allowed `dep`).
 */
function beadsSubcommand(request: BeadsRequest): string {
  if (request.kind === "close") return "update";
  if (request.kind === "children") return "dep";
  if (request.kind === "config-get" || request.kind === "config-set") return "config";
  return request.kind;
}

/**
 * The `bd` argv for one request — always `--json` so the reply is structured.
 * `subcommand` is the bd verb (== `request.kind`); `args` carries the flags.
 * Exhaustive over the discriminated union, so a new request kind is a compile
 * error here until it is given args.
 */
function beadsArgs(request: BeadsRequest): string[] {
  switch (request.kind) {
    case "ready":
      return ["--json", ...(request.explain === true ? ["--explain"] : [])];
    case "list":
      return [
        "--json",
        ...(request.status !== undefined ? ["--status", request.status] : []),
        ...(request.all === true ? ["--all"] : []),
        ...(request.limit !== undefined ? ["--limit", String(request.limit)] : []),
      ];
    case "show":
      // `bd show <id> --json` — id first, mirroring runBdShow.
      return [request.id, "--json"];
    case "children":
      // Served over the allowed `dep` subcommand: the parent-child children of
      // an epic are the `direction=up`, `type=parent-child` dep edges. `--json`
      // so the reply is structured (parsed like any other read).
      return ["list", request.id, "--direction", "up", "--type", "parent-child", "--json"];
    case "recall":
      // `bd recall <key> --json` — one memory row by key.
      return [request.key, "--json"];
    case "memories":
      // `bd memories [<prefix>] --json` — memory rows by key prefix.
      return [...(request.prefix !== undefined ? [request.prefix] : []), "--json"];
    case "remember":
      // `bd remember <body> --key <key> --json` — upsert a memory row.
      return [request.body, "--key", request.key, "--json"];
    case "create":
      return [
        "--json",
        "--type",
        request.issueType,
        "--title",
        request.title,
        ...(request.priority !== undefined ? ["--priority", String(request.priority)] : []),
        ...(request.description !== undefined ? ["--description", request.description] : []),
        ...(request.externalRef !== undefined ? ["--external-ref", request.externalRef] : []),
        ...(request.silent === true ? ["--silent"] : []),
      ];
    case "update": {
      const fields = [
        ...(request.status !== undefined ? ["--status", request.status] : []),
        ...(request.priority !== undefined ? ["--priority", String(request.priority)] : []),
        ...(request.assignee !== undefined ? ["--assignee", request.assignee] : []),
        ...(request.issueType !== undefined ? ["--type", request.issueType] : []),
        ...(request.externalRef !== undefined ? ["--external-ref", request.externalRef] : []),
        ...(request.notes !== undefined ? ["--notes", request.notes] : []),
        ...(request.title !== undefined ? ["--title", request.title] : []),
        ...(request.description !== undefined ? ["--description", request.description] : []),
        ...(request.metadata !== undefined ? ["--metadata", request.metadata] : []),
      ];
      if (fields.length === 0) {
        throw new EmptyUpdateError(
          "update requires at least one of status / priority / assignee / type / external-ref / notes / title / description / metadata",
        );
      }
      return [request.id, "--json", ...fields];
    }
    case "close":
      // `bd close` is blocked by the bd policy wrapper; the prx-canonical close
      // is `bd update <id> --status closed [--notes <reason>]` (see beadsSubcommand).
      return [
        request.id,
        "--json",
        "--status",
        "closed",
        ...(request.reason !== undefined ? ["--notes", request.reason] : []),
      ];
    case "reopen":
      // `bd reopen` is an allowed subcommand (unlike `close`), so it dispatches
      // directly: `bd reopen <id> --json`.
      return [request.id, "--json"];
    case "dep":
      // `bd dep add --type <t> <from> <to>` / `bd dep remove <from> <to>`.
      return request.action === "add"
        ? [
            "add",
            ...(request.depType !== undefined ? ["--type", request.depType] : []),
            request.from,
            request.to,
          ]
        : ["remove", request.from, request.to];
    case "config-get":
      // `bd config get <key>` — plain value, NOT --json (special output handling
      // in handleBeadsRequest, like `dep`).
      return ["get", request.key];
    case "config-set":
      // `bd config set <key> <value>` — echoes no record (result: null).
      return ["set", request.key, request.value];
    default: {
      // Exhaustiveness: a new request kind is a compile error here until given args.
      const unreachable: never = request;
      throw new Error(`unreachable beads request kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Run one beads request to a typed verdict: dispatch `request.kind` to
 * `bd <kind> --json` under the bd policy layer (reads unconditional; writes —
 * create/update/close — gated by bd's own planner-role policy, no extra
 * authority here), parse the JSON payload, and return it as the contract's
 * opaque `result` — or a typed `error` for a non-zero exit (`bd-read`/
 * `bd-write`), unparseable output (`bad-output`), or a fieldless update
 * (`bad-request`). Pure w.r.t. the socket: returns data, never throws.
 */
/**
 * The workspace ids a request carries (for the prx-qmg foreign-workspace guard).
 * `recall`/`memories` keys, `create`/`list`/`ready` (no id), and `remember` are
 * not workspace refs, so they carry none.
 */
function requestWorkspaceIds(request: BeadsRequest): string[] {
  switch (request.kind) {
    case "show":
    case "children":
    case "update":
    case "close":
    case "reopen":
      return [request.id];
    case "dep":
      return [request.from, request.to];
    default:
      return [];
  }
}

/**
 * The first id that belongs to a FOREIGN workspace — a prefixed ref (`<p>-…`)
 * whose prefix is not `servedPrefix` — or null when all ids are native. A ref
 * with no `-` isn't a prefixed workspace id, so it's left for bd to resolve.
 * Case-insensitive: native ids are lowercase, foreign surface forms may not be.
 */
function foreignWorkspaceId(ids: string[], servedPrefix: string): string | null {
  const native = `${servedPrefix.toLowerCase()}-`;
  for (const id of ids) {
    if (id.includes("-") && !id.toLowerCase().startsWith(native)) return id;
  }
  return null;
}

export async function handleBeadsRequest(
  request: BeadsRequest,
  deps: BeadsDaemonDeps = {},
): Promise<BeadsResponse> {
  const execBd = deps.execBd ?? defaultExecBd;
  let args: string[];
  try {
    args = beadsArgs(request);
  } catch (err) {
    if (err instanceof EmptyUpdateError) {
      return { status: "error", code: "bad-request", message: err.message };
    }
    return {
      status: "error",
      code: "beadsd",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // prx-qmg: foreign-workspace SIGNAL. One daemon serves one repo (GH-296), so a
  // ref whose prefix is well-formed but not this daemon's served prefix can't
  // resolve here. Short-circuit with a clear "wrong workspace" message instead of
  // a generic not-found (read) or the bd-safe "resolve to canonical long id"
  // refusal (write) — an agent learns the real reason without burning a turn.
  // Only when the served prefix is known; cross-workspace routing is out of scope.
  if (deps.localPrefix !== undefined) {
    const foreign = foreignWorkspaceId(requestWorkspaceIds(request), deps.localPrefix);
    if (foreign !== null) {
      return {
        status: "error",
        code: "foreign-workspace",
        message:
          `${foreign} isn't in this workspace — this daemon serves "${deps.localPrefix}-*". ` +
          `One daemon = one repo (GH-296); cross-workspace lookup isn't routed here.`,
      };
    }
  }
  let result: BdExecResult;
  try {
    // beadsd is the trusted single writer: it dispatches under the planner
    // role/state so bd's policy allows the write surface (create/update/close).
    // Per-caller authority is gated at the `prx beads` invocation layer (the
    // capability guard), not here — reaching the socket already implies it.
    result = execBd({
      subcommand: beadsSubcommand(request),
      args,
      cwd: deps.cwd,
      state: "planning",
      role: "planner",
      // Admit native short ids (prefix === the served clone's workspace) past
      // the bd-safe I-BF1 guard; foreign refs stay refused (prx-3vow).
      ...(deps.localPrefix !== undefined ? { localPrefix: deps.localPrefix } : {}),
    });
  } catch (err) {
    return {
      status: "error",
      code: "beadsd",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.exitCode !== 0) {
    return {
      status: "error",
      code: isBeadsWriteKind(request.kind) ? "bd-write" : "bd-read",
      message: (result.stderr || result.stdout).trim() || `bd ${request.kind} failed`,
    };
  }
  // `bd dep add/remove` and `bd config set` are not `--json` surfaces — they
  // echo no record. On a zero exit they succeeded; reply ok with no result.
  if (request.kind === "dep" || request.kind === "config-set") {
    const etag = deps.etag?.();
    return {
      status: "ok",
      result: null,
      ...(etag !== undefined ? { etag } : {}),
      ...(deps.localPrefix !== undefined ? { servedPrefix: deps.localPrefix } : {}),
    };
  }
  // `bd config get` returns a PLAIN value (not `--json`) — reply the raw trimmed
  // stdout as the result, bypassing the JSON parse below (prx-82b 2e.2).
  if (request.kind === "config-get") {
    const etag = deps.etag?.();
    return {
      status: "ok",
      result: result.stdout.trim(),
      ...(etag !== undefined ? { etag } : {}),
      ...(deps.localPrefix !== undefined ? { servedPrefix: deps.localPrefix } : {}),
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
  const etag = deps.etag?.();
  return {
    status: "ok",
    result: parsed,
    ...(etag !== undefined ? { etag } : {}),
    ...(deps.localPrefix !== undefined ? { servedPrefix: deps.localPrefix } : {}),
  };
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

/** Default cadence for the served clone's freshness pull (5 min). */
export const DEFAULT_BEADS_REFRESH_INTERVAL_MS = 300_000;

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
  /**
   * GH-296: keep the served clone fresh. Invoked once on start and then every
   * {@link refreshIntervalMs}. Errors are swallowed — a stale-but-up daemon
   * beats a crashed one, and conflict resolution against local writes is the
   * sync agent's job (prx-cu1). Injected so the pull is testable; the CLI wires
   * a `bd dolt pull` in the served cwd.
   */
  refresh?: (() => void | Promise<void>) | undefined;
  /** Refresh cadence in ms (default {@link DEFAULT_BEADS_REFRESH_INTERVAL_MS}; ≤0 ⇒ once on start only). */
  refreshIntervalMs?: number | undefined;
  /**
   * GH-296: read the served clone's current dolt HEAD hash (the dataset etag).
   * Called once on start and after each refresh, and cached — so reads carry the
   * etag without spawning dolt per request. When set, the daemon includes `etag`
   * on every `ok` reply (overriding any `deps.etag`).
   */
  readHead?: (() => string | undefined) | undefined;
}

/**
 * Bind the beadsd unix-socket server. Resolves with the listening `Server`
 * (close it to stop). Each connection is served by {@link serveBeadsConnection}
 * against {@link handleBeadsRequest} bound to `deps`. When `pidfile` is set the
 * daemon records its pid there (removed on close) so the host can stop it by pid.
 * When `refresh` is set, the served clone is pulled on start and on an interval.
 */
export async function runBeadsServe(options: BeadsServeOptions): Promise<Server> {
  const { socketPath, pidfile, deps, refresh, refreshIntervalMs, readHead } = options;
  // GH-296: cache the dataset etag (dolt HEAD); reads read it without spawning
  // dolt. Refreshed on start + after each reconcile, when the HEAD may have moved.
  const safeReadHead = (): string | undefined => {
    if (!readHead) return undefined;
    try {
      return readHead();
    } catch {
      return undefined;
    }
  };
  let currentEtag: string | undefined = safeReadHead();
  const effectiveDeps: BeadsDaemonDeps = readHead
    ? { ...deps, etag: () => currentEtag }
    : (deps ?? {});
  const handler = (request: BeadsRequest): Promise<BeadsResponse> =>
    handleBeadsRequest(request, effectiveDeps);
  const server = await runFramedServe(socketPath, pidfile, (socket) =>
    serveBeadsConnection(socket, handler),
  );

  if (refresh) {
    const runRefresh = (): void => {
      try {
        const r = refresh();
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        /* stale-but-up beats a crash; sync agent reconciles conflicts */
      }
      // Re-read HEAD after the reconcile — it may have moved (local commits
      // pushed, remote commits pulled).
      currentEtag = safeReadHead();
    };
    runRefresh(); // initial pull so a cold-started daemon serves current data
    const interval = refreshIntervalMs ?? DEFAULT_BEADS_REFRESH_INTERVAL_MS;
    if (interval > 0) {
      const timer = setInterval(runRefresh, interval);
      // Don't let the refresh timer alone keep the process alive.
      (timer as unknown as { unref?: () => void }).unref?.();
      server.on("close", () => clearInterval(timer));
    }
  }

  return server;
}
