import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { rmSync } from "node:fs";
import { tmpDir } from "@bounded-systems/host";
import { join } from "node:path";

import { unixSocketTransport } from "../door/transport.ts";
import { SessionHostClient, SessionProtocolError } from "./client.ts";
import { createMemorySessionStore, type SessionHostDeps } from "./handler.ts";
import { serveSessionConnection, sessionHandler } from "./serve.ts";

function makeDeps(): SessionHostDeps {
  const alive = new Set<number>();
  let nextPid = 2000;
  return {
    store: createMemorySessionStore(),
    logDir: "/run/prx/sessions",
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

const opened: Array<{ server: Server; socketPath: string }> = [];
let counter = 0;

async function startServer(deps: SessionHostDeps): Promise<{ socketPath: string }> {
  const socketPath = join(tmpDir(), `prx-sesshost-${process.pid}-${(counter += 1)}.sock`);
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => serveSessionConnection(socket, sessionHandler(deps)));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  opened.push({ server, socketPath });
  return { socketPath };
}

afterEach(() => {
  for (const { server, socketPath } of opened.splice(0)) {
    server.close();
    rmSync(socketPath, { force: true });
  }
});

describe("session-host wire (serve ↔ client over a real unix socket)", () => {
  test("round-trips start → status → list → stop", async () => {
    const { socketPath } = await startServer(makeDeps());
    const client = new SessionHostClient(unixSocketTransport(socketPath));

    const started = await client.start({ id: "GH-9", command: "claude", args: ["-p", "go"] });
    if (started.status !== "ok") throw new Error("start should be ok");
    expect(started.sessions[0]!.state).toBe("running");
    const pid = started.sessions[0]!.pid;

    const status = await client.status("GH-9");
    if (status.status !== "ok") throw new Error("status should be ok");
    expect(status.sessions[0]!.pid).toBe(pid);
    expect(status.sessions[0]!.state).toBe("running");

    const listed = await client.list();
    if (listed.status !== "ok") throw new Error("list should be ok");
    expect(listed.sessions.map((s) => s.id)).toEqual(["GH-9"]);

    const stopped = await client.stop("GH-9");
    if (stopped.status !== "ok") throw new Error("stop should be ok");
    expect(stopped.sessions[0]!.state).toBe("exited");
  });

  test("status on an unknown session round-trips a typed error", async () => {
    const { socketPath } = await startServer(makeDeps());
    const client = new SessionHostClient(unixSocketTransport(socketPath));
    const res = await client.status("ghost");
    if (res.status !== "error") throw new Error("should be error");
    expect(res.code).toBe("no-such-session");
  });

  test("a contract-violating frame gets a bad-request response and the daemon stays up", async () => {
    const { socketPath } = await startServer(makeDeps());
    // Bypass the client's pre-send validation: frame an fs-unsafe id directly.
    const raw = unixSocketTransport(socketPath);
    const reply = await raw({ kind: "start", id: "../bad", command: "claude" });
    expect(reply).toMatchObject({ status: "error", code: "bad-request" });
    // ...and the daemon still serves a valid request afterwards
    const client = new SessionHostClient(unixSocketTransport(socketPath));
    const ok = await client.list();
    expect(ok.status).toBe("ok");
  });
});

describe("SessionHostClient (protocol validation at the seam)", () => {
  test("throws SessionProtocolError when the reply violates the contract", async () => {
    const client = new SessionHostClient(async () => ({ status: "weird" }));
    await expect(client.status("x")).rejects.toBeInstanceOf(SessionProtocolError);
  });
});
