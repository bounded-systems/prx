import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpDir } from "@bounded-systems/host";
import { join } from "node:path";

import { unixSocketTransport } from "../door/transport.ts";
import { SessionHostClient } from "./client.ts";
import { runSessionHostServe } from "./daemon.ts";
import { type SessionHostDeps } from "./handler.ts";
import { createFileSessionStore } from "./store-file.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Real file store + fake (in-process) liveness — exercises the daemon wiring, no Lima. */
function realishDeps(dir: string): SessionHostDeps {
  const alive = new Set<number>();
  let nextPid = 7000;
  return {
    store: createFileSessionStore(dir),
    logDir: join(dir, "logs"),
    now: () => "2026-06-06T00:00:00.000Z",
    startProcess: () => {
      const pid = (nextPid += 1);
      alive.add(pid);
      return { pid };
    },
    isAlive: (pid) => alive.has(pid),
    signal: (pid) => void alive.delete(pid),
  };
}

describe("runSessionHostServe (real unix-socket daemon)", () => {
  test("serves the client round-trip with a durable store, writing a pidfile", async () => {
    const dir = mkdtempSync(join(tmpDir(), "prx-sess-daemon-"));
    const socketPath = join(dir, "sess.sock");
    const pidfile = join(dir, "sess.pid");
    const server = await runSessionHostServe({ socketPath, pidfile, deps: realishDeps(dir) });
    cleanups.push(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });

    expect(existsSync(pidfile)).toBe(true); // daemon recorded its pid (GH-223 lifecycle)

    const client = new SessionHostClient(unixSocketTransport(socketPath));
    const started = await client.start({ id: "GH-1", command: "claude" });
    if (started.status !== "ok") throw new Error("start should be ok");
    expect(started.sessions[0]!.state).toBe("running");

    // a fresh connection sees it persisted (durable store behind the socket)
    const listed = await new SessionHostClient(unixSocketTransport(socketPath)).list();
    if (listed.status !== "ok") throw new Error("list should be ok");
    expect(listed.sessions.map((s) => s.id)).toEqual(["GH-1"]);
  });

  test("removes its pidfile on close", async () => {
    const dir = mkdtempSync(join(tmpDir(), "prx-sess-daemon-"));
    const socketPath = join(dir, "s.sock");
    const pidfile = join(dir, "s.pid");
    const server = await runSessionHostServe({ socketPath, pidfile, deps: realishDeps(dir) });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    expect(existsSync(pidfile)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(existsSync(pidfile)).toBe(false);
  });
});
