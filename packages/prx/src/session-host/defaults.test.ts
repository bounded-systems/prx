import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpDir } from "@bounded-systems/host";
import { join } from "node:path";

import {
  defaultSessionHostDeps,
  isAliveProcess,
  procStartProcess,
  signalProcess,
} from "./defaults.ts";
import { handleSessionRequest } from "./handler.ts";

const pids: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpDir(), "prx-sess-def-"));
  dirs.push(d);
  return d;
}
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = pred();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("procStartProcess (real detached spawn, no shell)", () => {
  test("spawns a real process and captures its output to the session log", async () => {
    const logPath = join(tmp(), "s.ndjson");
    const { pid } = procStartProcess({
      id: "s",
      command: "sh",
      args: ["-c", "echo held-output"],
      env: undefined,
      cwd: undefined,
      logPath,
    });
    pids.push(pid);
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => readFileSync(logPath, "utf8").includes("held-output"));
    expect(readFileSync(logPath, "utf8")).toContain("held-output");
  });
});

describe("isAliveProcess / signalProcess (real process.kill)", () => {
  test("track and terminate a real process", async () => {
    const { pid } = procStartProcess({
      id: "k",
      command: "sh",
      args: ["-c", "exec sleep 30"],
      env: undefined,
      cwd: undefined,
      logPath: join(tmp(), "k.log"),
    });
    pids.push(pid);
    expect(isAliveProcess(pid)).toBe(true);
    signalProcess(pid, "SIGKILL");
    await waitFor(() => !isAliveProcess(pid));
    expect(isAliveProcess(pid)).toBe(false);
  });

  test("a bogus pid is not alive", () => {
    expect(isAliveProcess(2_000_000_000)).toBe(false);
  });
});

describe("defaultSessionHostDeps (handler over REAL process seams)", () => {
  test("holds a real session end-to-end: start → running → stop → exited", async () => {
    const deps = defaultSessionHostDeps({ stateDir: tmp() });

    const started = await handleSessionRequest(
      { kind: "start", id: "GH-1", command: "sh", args: ["-c", "exec sleep 30"] },
      deps,
    );
    if (started.status !== "ok") throw new Error("start should be ok");
    const pid = started.sessions[0]!.pid;
    pids.push(pid);
    expect(started.sessions[0]!.state).toBe("running");

    // real liveness: status reflects the live process
    const status = await handleSessionRequest({ kind: "status", id: "GH-1" }, deps);
    if (status.status !== "ok") throw new Error("status should be ok");
    expect(status.sessions[0]!.state).toBe("running");

    // stop signals it (default SIGTERM kills `exec sleep`); status then reconciles exited
    const stopped = await handleSessionRequest({ kind: "stop", id: "GH-1" }, deps);
    if (stopped.status !== "ok") throw new Error("stop should be ok");
    await waitFor(() => !isAliveProcess(pid));
    const after = await handleSessionRequest({ kind: "status", id: "GH-1" }, deps);
    if (after.status !== "ok") throw new Error("status should be ok");
    expect(after.sessions[0]!.state).toBe("exited");
  });
});
