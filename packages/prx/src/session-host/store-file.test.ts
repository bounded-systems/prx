import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type SessionRecord } from "./contract.ts";
import { handleSessionRequest, type SessionHostDeps, type SessionStore } from "./handler.ts";
import { createFileSessionStore } from "./store-file.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prx-sess-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "GH-1",
  pid: 4242,
  state: "running",
  command: "claude",
  logPath: "/run/prx/sessions/GH-1.ndjson",
  startedAt: "2026-06-06T00:00:00.000Z",
  ...over,
});

describe("createFileSessionStore", () => {
  test("put/get round-trips a record", () => {
    const s = createFileSessionStore(tmp());
    s.put(rec());
    expect(s.get("GH-1")).toEqual(rec());
    expect(s.get("absent")).toBeUndefined();
  });

  test("records survive a fresh store over the same dir (durable holder)", () => {
    const dir = tmp();
    createFileSessionStore(dir).put(rec({ id: "GH-7", pid: 99 }));
    // a new store instance (e.g. after a daemon restart) re-reads from disk
    const reopened = createFileSessionStore(dir);
    expect(reopened.get("GH-7")?.pid).toBe(99);
  });

  test("list enumerates all records; delete removes one", () => {
    const s = createFileSessionStore(tmp());
    s.put(rec({ id: "a" }));
    s.put(rec({ id: "b" }));
    expect(s.list().map((r) => r.id).sort()).toEqual(["a", "b"]);
    s.delete("a");
    expect(s.list().map((r) => r.id)).toEqual(["b"]);
  });

  test("a corrupt or foreign file is treated as absent, not a malformed record", () => {
    const dir = tmp();
    const s = createFileSessionStore(dir);
    writeFileSync(join(dir, "bad.json"), "{not json", "utf8");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ id: "wrong" }), "utf8"); // missing fields
    s.put(rec({ id: "good" }));
    expect(s.get("bad")).toBeUndefined();
    expect(s.get("wrong")).toBeUndefined();
    expect(s.list().map((r) => r.id)).toEqual(["good"]); // only the valid one
  });
});

describe("handler over the durable store", () => {
  const deps = (store: SessionStore): SessionHostDeps => ({
    store,
    logDir: "/run/prx/sessions",
    now: () => "2026-06-06T00:00:00.000Z",
    startProcess: () => ({ pid: 5150 }),
    isAlive: (pid) => pid === 5150, // the held process is still running across the restart
    signal: () => {},
  });

  test("a held session survives a daemon 'restart' and reconciles running", async () => {
    const dir = tmp();
    // daemon #1 holds a session
    const open = await handleSessionRequest(
      { kind: "start", id: "GH-9", command: "claude" },
      deps(createFileSessionStore(dir)),
    );
    if (open.status !== "ok") throw new Error("start should be ok");

    // daemon #2 — a fresh store over the same dir — still sees it, reconciled
    const after = await handleSessionRequest(
      { kind: "status", id: "GH-9" },
      deps(createFileSessionStore(dir)),
    );
    if (after.status !== "ok") throw new Error("status should be ok");
    expect(after.sessions[0]!.pid).toBe(5150);
    expect(after.sessions[0]!.state).toBe("running");
  });
});
