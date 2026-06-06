import { describe, expect, test } from "bun:test";

import { SessionRequestSchema } from "./contract.ts";
import {
  createMemorySessionStore,
  handleSessionRequest,
  type SessionHostDeps,
  type StartSpec,
} from "./handler.ts";

/** Build deps with controllable liveness + spies, over a real in-memory store. */
function makeDeps(
  over: Partial<SessionHostDeps> & { alive?: Set<number> } = {},
): SessionHostDeps & { started: StartSpec[]; signalled: Array<{ pid: number; signal: string }> } {
  const alive = over.alive ?? new Set<number>();
  const started: StartSpec[] = [];
  const signalled: Array<{ pid: number; signal: string }> = [];
  let nextPid = 1000;
  return {
    store: over.store ?? createMemorySessionStore(),
    logDir: over.logDir ?? "/run/prx/sessions",
    now: over.now ?? (() => "2026-06-06T00:00:00.000Z"),
    startProcess:
      over.startProcess ??
      ((spec) => {
        started.push(spec);
        const pid = (nextPid += 1);
        alive.add(pid);
        return { pid };
      }),
    isAlive: over.isAlive ?? ((pid) => alive.has(pid)),
    signal:
      over.signal ??
      ((pid, signal) => {
        signalled.push({ pid, signal });
        alive.delete(pid); // fake: signal terminates the process
      }),
    started,
    signalled,
  };
}

describe("handleSessionRequest", () => {
  test("start spawns a detached process and records it running", async () => {
    const deps = makeDeps();
    const res = await handleSessionRequest(
      { kind: "start", id: "GH-456", command: "claude", args: ["-p", "go"] },
      deps,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.sessions).toHaveLength(1);
    const rec = res.sessions[0]!;
    expect(rec.id).toBe("GH-456");
    expect(rec.state).toBe("running");
    expect(rec.command).toBe("claude");
    expect(rec.logPath).toBe("/run/prx/sessions/GH-456.ndjson");
    expect(rec.startedAt).toBe("2026-06-06T00:00:00.000Z");
    // it actually asked startProcess to spawn, with the resolved log path + args
    expect(deps.started).toHaveLength(1);
    expect(deps.started[0]!.args).toEqual(["-p", "go"]);
    expect(deps.started[0]!.logPath).toBe("/run/prx/sessions/GH-456.ndjson");
    // and persisted it
    expect(deps.store.get("GH-456")?.pid).toBe(rec.pid);
  });

  test("start refuses a session that is already running", async () => {
    const deps = makeDeps();
    await handleSessionRequest({ kind: "start", id: "dup", command: "claude" }, deps);
    const res = await handleSessionRequest({ kind: "start", id: "dup", command: "claude" }, deps);
    expect(res.status).toBe("error");
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.code).toBe("already-running");
    expect(deps.started).toHaveLength(1); // did NOT spawn a second process
  });

  test("start re-holds a session whose previous process exited", async () => {
    const deps = makeDeps();
    const first = await handleSessionRequest({ kind: "start", id: "re", command: "claude" }, deps);
    if (first.status !== "ok") throw new Error("unreachable");
    deps.signal(first.sessions[0]!.pid, "SIGKILL"); // kill it out-of-band
    const res = await handleSessionRequest({ kind: "start", id: "re", command: "claude" }, deps);
    expect(res.status).toBe("ok");
    expect(deps.started).toHaveLength(2); // spawned a fresh process
  });

  test("status reconciles a dead pid to exited", async () => {
    const deps = makeDeps();
    const open = await handleSessionRequest({ kind: "start", id: "s", command: "claude" }, deps);
    if (open.status !== "ok") throw new Error("unreachable");
    expect(open.sessions[0]!.state).toBe("running");
    deps.signal(open.sessions[0]!.pid, "SIGKILL"); // process dies
    const res = await handleSessionRequest({ kind: "status", id: "s" }, deps);
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.sessions[0]!.state).toBe("exited");
    // reconciled state is persisted, so a later read stays exited
    expect(deps.store.get("s")?.state).toBe("exited");
  });

  test("status on an unknown session is a typed error", async () => {
    const res = await handleSessionRequest({ kind: "status", id: "ghost" }, makeDeps());
    expect(res.status).toBe("error");
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.code).toBe("no-such-session");
  });

  test("stop signals the held pid (default SIGTERM) and reconciles", async () => {
    const deps = makeDeps();
    const open = await handleSessionRequest({ kind: "start", id: "k", command: "claude" }, deps);
    if (open.status !== "ok") throw new Error("unreachable");
    const pid = open.sessions[0]!.pid;
    const res = await handleSessionRequest({ kind: "stop", id: "k" }, deps);
    expect(res.status).toBe("ok");
    expect(deps.signalled).toEqual([{ pid, signal: "SIGTERM" }]);
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.sessions[0]!.state).toBe("exited");
  });

  test("stop honors a custom signal and is a no-op signal-wise on a dead session", async () => {
    const deps = makeDeps();
    const open = await handleSessionRequest({ kind: "start", id: "k2", command: "claude" }, deps);
    if (open.status !== "ok") throw new Error("unreachable");
    await handleSessionRequest({ kind: "stop", id: "k2", signal: "SIGKILL" }, deps);
    expect(deps.signalled).toEqual([{ pid: open.sessions[0]!.pid, signal: "SIGKILL" }]);
    // second stop: already dead → no further signal, still ok
    const res = await handleSessionRequest({ kind: "stop", id: "k2" }, deps);
    expect(res.status).toBe("ok");
    expect(deps.signalled).toHaveLength(1);
  });

  test("stop on an unknown session is a typed error", async () => {
    const res = await handleSessionRequest({ kind: "stop", id: "ghost" }, makeDeps());
    expect(res.status).toBe("error");
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.code).toBe("no-such-session");
  });

  test("list enumerates all sessions with reconciled state", async () => {
    const deps = makeDeps();
    const a = await handleSessionRequest({ kind: "start", id: "a", command: "claude" }, deps);
    await handleSessionRequest({ kind: "start", id: "b", command: "claude" }, deps);
    if (a.status !== "ok") throw new Error("unreachable");
    deps.signal(a.sessions[0]!.pid, "SIGKILL"); // a dies
    const res = await handleSessionRequest({ kind: "list" }, deps);
    if (res.status !== "ok") throw new Error("unreachable");
    const byId = Object.fromEntries(res.sessions.map((s) => [s.id, s.state]));
    expect(byId).toEqual({ a: "exited", b: "running" });
  });

  test("list on an empty host is ok with no sessions", async () => {
    const res = await handleSessionRequest({ kind: "list" }, makeDeps());
    expect(res).toEqual({ status: "ok", sessions: [] });
  });
});

describe("SessionRequestSchema (parse-at-the-seam)", () => {
  test("accepts a well-formed start request", () => {
    const parsed = SessionRequestSchema.parse({ kind: "start", id: "GH-1", command: "claude" });
    expect(parsed.kind).toBe("start");
  });

  test("rejects a filesystem-unsafe session id", () => {
    expect(() => SessionRequestSchema.parse({ kind: "status", id: "../etc/passwd" })).toThrow();
  });

  test("rejects an unknown kind", () => {
    expect(() => SessionRequestSchema.parse({ kind: "frobnicate", id: "x" })).toThrow();
  });
});
