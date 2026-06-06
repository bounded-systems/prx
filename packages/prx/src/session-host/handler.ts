/**
 * session-host daemon handler (session-substrate slice 1) — the in-VM side.
 *
 * The pure request handler that holds processes alive and reports them, with all
 * process/clock/persistence access behind injected seams so it's exercised
 * end-to-end with fakes — no VM, no real processes. Modelled on
 * {@link ../keeperd/daemon.handleKeeperRequest}.
 *
 * Like keeperd: a handler NEVER throws to the socket — every failure becomes a
 * typed `error` response, so one bad request can't take the daemon down. Slice 2
 * wraps this in the keeperd frame/serve transport; the real (proc-backed,
 * file-backed) seams land with the in-VM daemon in slice 3.
 *
 * State is reconciled on read: a stored record's `state` is checked against
 * process liveness every time it's observed, so a session that died out-of-band
 * reports `exited` without the daemon having to watch it. This is what makes the
 * holder durable + restart-safe — the store is the source of truth for *what*
 * sessions exist; liveness is the source of truth for *whether* they run.
 */

import {
  type SessionRecord,
  type SessionRequest,
  type SessionResponse,
} from "./contract.ts";

/** What {@link SessionHostDeps.startProcess} is asked to spawn. */
export interface StartSpec {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  /** Where the held process's output is appended (the tailed stream). */
  logPath: string;
}

/**
 * The durable record store. The source of truth for *which* sessions exist
 * (file-backed in the VM — slice 3); the in-memory impl below is for tests + a
 * reference. Liveness (whether they run) is reconciled separately.
 */
export interface SessionStore {
  put(record: SessionRecord): void;
  get(id: string): SessionRecord | undefined;
  list(): SessionRecord[];
  delete(id: string): void;
}

/** Seams the session host runs process control through (all injectable). */
export interface SessionHostDeps {
  /** Durable record store (file-backed in the VM; in-memory in tests). */
  store: SessionStore;
  /** Spawn a detached, held process; returns its pid. (slice 3: `setsid` + proc.) */
  startProcess: (spec: StartSpec) => { pid: number };
  /** True iff `pid` is a live process (e.g. `kill -0`). */
  isAlive: (pid: number) => boolean;
  /** Deliver `signal` to `pid`. */
  signal: (pid: number, signal: string) => void;
  /** Current time as ISO 8601. */
  now: () => string;
  /** Directory holding per-session output logs. */
  logDir: string;
}

/** Reconcile a record's `state` against process liveness (read-time truth). */
function reconcile(rec: SessionRecord, deps: SessionHostDeps): SessionRecord {
  if (rec.state === "exited") return rec;
  return deps.isAlive(rec.pid) ? { ...rec, state: "running" } : { ...rec, state: "exited" };
}

/**
 * Run one session-control request to a typed verdict. Pure w.r.t. the socket:
 * returns data, never throws.
 */
export async function handleSessionRequest(
  request: SessionRequest,
  deps: SessionHostDeps,
): Promise<SessionResponse> {
  try {
    switch (request.kind) {
      case "start": {
        const existing = deps.store.get(request.id);
        if (existing !== undefined && deps.isAlive(existing.pid)) {
          return {
            status: "error",
            code: "already-running",
            message: `session ${request.id} is already running (pid ${existing.pid})`,
          };
        }
        const logPath = `${deps.logDir}/${request.id}.ndjson`;
        const { pid } = deps.startProcess({
          id: request.id,
          command: request.command,
          args: request.args ?? [],
          env: request.env,
          cwd: request.cwd,
          logPath,
        });
        const record: SessionRecord = {
          id: request.id,
          pid,
          state: "running",
          command: request.command,
          logPath,
          startedAt: deps.now(),
        };
        deps.store.put(record);
        return { status: "ok", sessions: [record] };
      }
      case "status": {
        const rec = deps.store.get(request.id);
        if (rec === undefined) {
          return { status: "error", code: "no-such-session", message: `no session ${request.id}` };
        }
        const reconciled = reconcile(rec, deps);
        deps.store.put(reconciled);
        return { status: "ok", sessions: [reconciled] };
      }
      case "stop": {
        const rec = deps.store.get(request.id);
        if (rec === undefined) {
          return { status: "error", code: "no-such-session", message: `no session ${request.id}` };
        }
        if (deps.isAlive(rec.pid)) {
          deps.signal(rec.pid, request.signal ?? "SIGTERM");
        }
        const reconciled = reconcile(rec, deps);
        deps.store.put(reconciled);
        return { status: "ok", sessions: [reconciled] };
      }
      case "list": {
        const all = deps.store.list().map((rec) => {
          const reconciled = reconcile(rec, deps);
          deps.store.put(reconciled);
          return reconciled;
        });
        return { status: "ok", sessions: all };
      }
    }
  } catch (err) {
    return {
      status: "error",
      code: "session-host",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** An in-memory {@link SessionStore} — the test fake and a reference impl. */
export function createMemorySessionStore(): SessionStore {
  const byId = new Map<string, SessionRecord>();
  return {
    put: (record) => void byId.set(record.id, record),
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    delete: (id) => void byId.delete(id),
  };
}
